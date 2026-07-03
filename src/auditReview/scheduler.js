// src/auditReview/scheduler.js
//
// Audit review orchestration scheduler for v1.4.
// See v1.4 PERIODIC_LLM_AUDIT_REVIEW_DESIGN.md sections 4, 9.5, 12.5, 14.
//
// Responsibilities:
//   - Periodically run a full audit review cycle (ingest -> detect -> LLM -> persist -> notify).
//   - Use a database lease (audit_review_locks) to prevent concurrent runs, even across processes.
//   - Recover stale "running" review runs on startup.
//   - Provide a manual runNow() entry point for the HTTP API.
//   - Emit runtime audit events for every lifecycle step (agent_id='audit-logger-agent').

import crypto from 'crypto';
import { agentDisplayName, buildEvidenceDetail, buildEvidenceIndex, evidenceForEventIds } from './evidence.js';

const LOCK_NAME = 'audit_review_scheduler';
const LEASE_MINUTES = 10;

function nowIso() {
  return new Date().toISOString();
}

function reviewIdFor(now) {
  const ts = now.toISOString().replace(/[:.]/g, '-');
  return `review_${ts}_${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Find the window_to of the most recent successful (completed|completed_degraded) run.
 * Returns null if none exists.
 */
function lastSuccessfulWindowTo(reviewStore) {
  const runs = reviewStore.listRuns({ limit: 50 });
  for (const run of runs) {
    if (run.status === 'completed' || run.status === 'completed_degraded') {
      return run.window_to;
    }
  }
  return null;
}

/**
 * Build a minimal finding from a candidate (used in degraded mode when LLM fails).
 */
function findingFromCandidate(candidate, reviewId, riskPolicyVersion, promptVersion, reviewerVersion, agentsConfig) {
  const evidence = [buildEvidenceDetail(candidate, agentsConfig)];
  return {
    finding_id: `finding_${crypto.randomUUID()}`,
    review_id: reviewId,
    category: candidate.category,
    severity: 'medium',
    agent_id: candidate.agent_id,
    tool_name: candidate.tool_name,
    trace_id: candidate.trace_id,
    product_id: candidate.product_id,
    title: candidate.reason ?? candidate.category,
    summary: candidate.reason ?? candidate.category,
    recommendation: '',
    requires_action: 0,
    evidence_event_ids: [candidate.event_id],
    evidence_event_ids_json: JSON.stringify([candidate.event_id]),
    evidence_json: JSON.stringify(evidence),
    normalized_error_code: candidate.error_code ?? null,
    risk_policy_version: riskPolicyVersion,
    prompt_version: promptVersion,
    reviewer_version: reviewerVersion,
  };
}

/**
 * Build a degraded-mode review object from candidates, mirroring the LLM output contract
 * (design 6.7) just enough for the notifier to build a summary payload.
 */
function degradedReview({ reviewId, window, candidates }) {
  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const c of candidates) {
    const sev = 'medium';
    severityCounts[sev] = (severityCounts[sev] || 0) + 1;
  }
  return {
    type: 'audit_review',
    review_id: reviewId,
    window,
    summary: {
      title: 'LLM 审查失败，本轮仅包含规则检测结果',
      overview: `LLM 审查不可用，已基于 ${candidates.length} 条候选事件生成规则层 findings。`,
      severity_counts: severityCounts,
    },
    findings: candidates.map((c) => ({
      category: c.category,
      severity: 'medium',
      agent_id: c.agent_id,
      tool_name: c.tool_name,
      trace_id: c.trace_id,
      product_id: c.product_id,
      title: c.reason ?? c.category,
      summary: c.reason ?? c.category,
      recommendation: '',
      evidence_event_ids: [c.event_id],
      requires_action: false,
    })),
  };
}

/**
 * Build findings from ingest parse errors (design 5.3).
 */
function parseErrorFindings(parseErrors, reviewId, riskPolicyVersion, reviewerVersion, agentsConfig) {
  if (!parseErrors || parseErrors.length === 0) return [];
  // Group by agent_id
  const byAgent = new Map();
  for (const e of parseErrors) {
    if (!byAgent.has(e.agent_id)) byAgent.set(e.agent_id, []);
    byAgent.get(e.agent_id).push(e);
  }
  const findings = [];
  for (const [agentId, errors] of byAgent) {
    const uniqueFiles = new Set(errors.map((e) => e.file));
    const severity = uniqueFiles.size >= 3 ? 'high' : 'medium';
    const samples = errors.slice(0, 3).map((e) => `${e.file}:${e.line} ${e.error}`);
    const errorEvidence = errors.slice(0, 3).map((errorRow) => ({
      event_id: null,
      agent_id: agentId,
      agent_name: agentDisplayName(agentId, agentsConfig),
      tool_name: 'audit.ingest',
      trace_id: null,
      span_id: null,
      log_detail: {
        file: errorRow.file,
        line: errorRow.line,
        error: errorRow.error,
      },
    }));
    findings.push({
      finding_id: `finding_${crypto.randomUUID()}`,
      review_id: reviewId,
      category: 'ingest_parse_error',
      severity,
      agent_id: agentId,
      tool_name: 'audit.ingest',
      trace_id: null,
      product_id: null,
      title: '日志解析失败',
      summary: `${errors.length} 条解析错误，涉及 ${uniqueFiles.size} 个文件。样例: ${samples.join('; ')}`,
      recommendation: '检查日志格式是否符合 agent-audit-log v1.0 规范',
      requires_action: 0,
      evidence_event_ids: [],
      evidence_event_ids_json: '[]',
      evidence_json: JSON.stringify(errorEvidence),
      risk_policy_version: riskPolicyVersion,
      prompt_version: null,
      reviewer_version: reviewerVersion,
    });
  }
  return findings;
}

export function createAuditReviewScheduler({
  db,
  config,
  reviewStore,
  lockStore,
  ingestService,
  cursorStore,
  detector,
  llmReviewer,
  notifier,
  visualization,
  auditLogger,
  llmModel: llmModelOpt,
  now = () => new Date(),
} = {}) {
  if (!db) throw new Error('createAuditReviewScheduler: db is required');
  if (!config) throw new Error('createAuditReviewScheduler: config is required');
  if (!reviewStore) throw new Error('createAuditReviewScheduler: reviewStore is required');
  if (!lockStore) throw new Error('createAuditReviewScheduler: lockStore is required');
  if (!ingestService) throw new Error('createAuditReviewScheduler: ingestService is required');
  if (!detector) throw new Error('createAuditReviewScheduler: detector is required');
  if (!llmReviewer) throw new Error('createAuditReviewScheduler: llmReviewer is required');
  if (!notifier) throw new Error('createAuditReviewScheduler: notifier is required');
  if (!visualization) throw new Error('createAuditReviewScheduler: visualization is required');
  if (!auditLogger) throw new Error('createAuditReviewScheduler: auditLogger is required');

  const auditConfig = config.auditReview ?? {};
  // Evidence helpers expect a config object with an `agents` map at its top
  // level. Resolve the correct slice so agentDisplayName works regardless of
  // whether agents are declared at the root or under auditReview.
  const agentsConfig = config.agents
    ? config
    : (config.auditReview?.agents ? { agents: config.auditReview.agents } : config);
  const intervalMinutes = auditConfig.intervalMinutes ?? 30;
  const initialDelaySeconds = auditConfig.initialDelaySeconds ?? 30;
  const lookbackOverlapMinutes = auditConfig.lookbackOverlapMinutes ?? 5;
  const maxEventsPerReview = auditConfig.maxEventsPerReview ?? 500;
  const riskPolicyVersion = auditConfig.riskPolicy?.version ?? 'risk-policy-v1';
  const promptVersion = auditConfig.llmReview?.promptVersion ?? 'audit-review-prompt-v1';
  const reviewerVersion = auditConfig.llmReview?.reviewerVersion ?? 'audit-reviewer-v1';
  const llmModel = llmModelOpt ?? config.planner?.model ?? config.auditReview?.llmReview?.model ?? null;

  let intervalTimer = null;
  let refreshTimer = null;

  function clearRefreshTimer() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  async function logAudit(event, status, summary, toolName) {
    try {
      await auditLogger.log({
        runId: null,
        event,
        status,
        summary,
        toolName: toolName ?? 'audit.review',
      });
    } catch {
      // Never let audit logging break the review cycle.
    }
  }

  /**
   * Recover stale "running" review runs and expired locks on startup (design 4.4).
   */
  function recoverStaleRuns() {
    const staleBeforeIso = now().toISOString();
    let recoveredCount = 0;
    try {
      const staleRuns = reviewStore.listStaleRunning({ staleBeforeIso });
      for (const run of staleRuns) {
        try {
          reviewStore.finishRun(run.review_id, {
            status: 'failed',
            errorCode: 'review_interrupted',
          });
          recoveredCount++;
        } catch {
          // ignore individual failures
        }
      }
      // Release expired locks.
      const expiredLocks = lockStore.listExpired({ beforeIso: staleBeforeIso });
      for (const lock of expiredLocks) {
        try {
          lockStore.forceRelease(lock.lock_name);
        } catch {
          // ignore
        }
      }
      logAudit(
        'review.recovered',
        'ok',
        `Recovered ${recoveredCount} stale run(s), released ${expiredLocks.length} expired lock(s).`,
        'audit.review.recovery',
      );
    } catch (error) {
      logAudit(
        'review.recovered',
        'error',
        `Recovery failed: ${error.message}`,
        'audit.review.recovery',
      );
    }
  }

  /**
   * The core audit review cycle (design section 4, algorithm in task spec).
   * Returns { reviewId, status }.
   */
  async function runOnce({ triggerType = 'scheduled' } = {}) {
    const ownerId = `owner_${crypto.randomUUID()}`;

    // 1. Acquire lease lock.
    const acquired = lockStore.acquire({ lockName: LOCK_NAME, ownerId, leaseMinutes: LEASE_MINUTES });
    if (!acquired.acquired) {
      // Another run holds the lease — record a skipped run and return.
      const reviewId = reviewIdFor(now());
      reviewStore.createRun({
        reviewId,
        windowFrom: nowIso(),
        windowTo: nowIso(),
        triggerType,
        intervalMinutes,
        riskPolicyVersion,
        promptVersion,
        reviewerVersion,
      });
      reviewStore.markRunStatus(reviewId, 'skipped');
      reviewStore.finishRun(reviewId, { status: 'skipped' });
      logAudit(
        'review.lock.skipped',
        'ok',
        `Skipped review ${reviewId}: lock held by ${acquired.currentOwner ?? 'another owner'}.`,
      );
      return { reviewId, status: 'skipped' };
    }

    const reviewId = reviewIdFor(now());
    const windowTo = now().toISOString();

    // 2. Compute window.
    const lastWindowTo = lastSuccessfulWindowTo(reviewStore);
    const windowFrom = lastWindowTo
      ? new Date(Date.parse(lastWindowTo) - lookbackOverlapMinutes * 60000).toISOString()
      : new Date(Date.parse(windowTo) - intervalMinutes * 60000).toISOString();

    // 3. Create the run row.
    reviewStore.createRun({
      reviewId,
      windowFrom,
      windowTo,
      triggerType,
      intervalMinutes,
      riskPolicyVersion,
      promptVersion,
      reviewerVersion,
    });
    logAudit(
      'review.start',
      'ok',
      `Started review ${reviewId} window=${windowFrom}..${windowTo} trigger=${triggerType}`,
    );

    // 4. Lease refresh timer.
    refreshTimer = setInterval(() => {
      try {
        lockStore.refresh({ lockName: LOCK_NAME, ownerId, leaseMinutes: LEASE_MINUTES });
      } catch {
        // ignore refresh failures
      }
    }, (LEASE_MINUTES * 60000) / 2);

    let status = 'completed';
    let errorCode = null;
    let findingCount = 0;
    let ingestResult = { inserted: 0, scannedFiles: 0, parseErrors: [], cursorUpdates: 0 };
    let candidates = { candidates: [], totalEvents: 0, trimmed: false };
    let llmResult = { ok: false, degraded: true, error: 'not_run' };

    try {
      // 5. Ingest.
      const sinceDate = windowFrom.slice(0, 10);
      try {
        ingestResult = ingestService.ingestSince({ sinceDate, reviewId });
        logAudit(
          'review.ingest.completed',
          'ok',
          `Ingest: scanned=${ingestResult.scannedFiles}, inserted=${ingestResult.inserted}, parseErrors=${ingestResult.parseErrors.length}`,
          'audit.ingest',
        );
      } catch (err) {
        logAudit(
          'review.ingest.completed',
          'error',
          `Ingest failed: ${err.message}`,
          'audit.ingest',
        );
        reviewStore.finishRun(reviewId, {
          status: 'failed',
          scannedFiles: 0,
          insertedEvents: 0,
          parseErrorCount: 0,
          candidateEventCount: 0,
          findingCount: 0,
          errorCode: 'ingest_error',
          errorMessage: err.message,
        });
        logAudit(
          'review.completed',
          'error',
          `Review ${reviewId} failed during ingest: ${err.message}`,
        );
        clearRefreshTimer();
        try { lockStore.release({ lockName: LOCK_NAME, ownerId }); } catch {}
        return { reviewId, status: 'failed' };
      }

      // 6. Detect candidates.
      try {
        candidates = detector.detect({ windowFrom, windowTo, maxEventsPerReview });
        logAudit(
          'review.detector.completed',
          'ok',
          `Detector: ${candidates.candidates.length} candidates from ${candidates.totalEvents} events.`,
          'audit.detector',
        );
      } catch (err) {
        logAudit(
          'review.detector.completed',
          'error',
          `Detector failed: ${err.message}`,
          'audit.detector',
        );
        candidates = { candidates: [], totalEvents: 0, trimmed: false };
      }

      // 6a. Build a structured evidence index keyed by event_id for LLM findings.
      const evidenceIndex = buildEvidenceIndex(candidates.candidates, agentsConfig);

      // 6b. Persist parse-error findings.
      const parseFindings = parseErrorFindings(
        ingestResult.parseErrors,
        reviewId,
        riskPolicyVersion,
        reviewerVersion,
        agentsConfig,
      );
      for (const f of parseFindings) {
        try {
          reviewStore.upsertFinding(f);
          findingCount++;
        } catch {
          // ignore individual finding failures
        }
      }

      // 7. LLM review.
      try {
        llmResult = await llmReviewer.review({
          reviewId,
          window: { from: windowFrom, to: windowTo },
          candidates: candidates.candidates,
          reviewStore,
        });
        logAudit(
          'review.llm.completed',
          llmResult.ok ? 'ok' : 'error',
          llmResult.ok
            ? `LLM review ok, model=${llmModel}, prompt=${promptVersion}`
            : `LLM review degraded: ${llmResult.error ?? 'unknown error'}`,
          'audit.llm',
        );
      } catch (err) {
        llmResult = { ok: false, degraded: true, error: err.message };
        logAudit(
          'review.llm.completed',
          'error',
          `LLM review threw: ${err.message}`,
          'audit.llm',
        );
      }

      if (!llmResult.ok) {
        status = 'completed_degraded';
        errorCode = 'llm_error';
      }

      // 8. Persist findings.
      let findingsToPersist = [];
      if (llmResult.ok && llmResult.review && Array.isArray(llmResult.review.findings)) {
        findingsToPersist = llmResult.review.findings.map((f) => {
          const evidenceIds = Array.isArray(f.evidence_event_ids) ? f.evidence_event_ids : [];
          const evidence = evidenceForEventIds(evidenceIds, evidenceIndex);
          return {
            finding_id: `finding_${crypto.randomUUID()}`,
            review_id: reviewId,
            category: f.category,
            severity: f.severity,
            agent_id: f.agent_id,
            tool_name: f.tool_name,
            trace_id: f.trace_id,
            product_id: f.product_id,
            title: f.title,
            summary: f.summary,
            recommendation: f.recommendation,
            requires_action: f.requires_action ? 1 : 0,
            evidence_event_ids: evidenceIds,
            evidence_event_ids_json: JSON.stringify(evidenceIds),
            evidence_json: JSON.stringify(evidence),
            normalized_error_code: f.error_code ?? null,
            risk_policy_version: riskPolicyVersion,
            prompt_version: promptVersion,
            reviewer_version: reviewerVersion,
          };
        });
      } else {
        // Degraded mode: convert each candidate to a basic finding.
        findingsToPersist = candidates.candidates.map((c) =>
          findingFromCandidate(c, reviewId, riskPolicyVersion, promptVersion, reviewerVersion, agentsConfig),
        );
      }

      for (const f of findingsToPersist) {
        try {
          reviewStore.upsertFinding(f);
          findingCount++;
        } catch {
          // ignore individual finding failures
        }
      }

      // 9. Notify.
      try {
        const dashboardUrl = visualization.dashboardUrlFor(reviewId);
        const run = reviewStore.getRun(reviewId);
        // Attach persisted finding_ids back onto the review findings so the
        // callback summary's top_findings carry a usable finding_id link.
        // Query ALL findings (not filtered by reviewId): finding_hash dedup keeps
        // the earliest review_id on a re-observed finding, so filtering by this
        // run's review_id would miss rows that were merged into an earlier run.
        const persistedRows = reviewStore.listFindings({ limit: 1000 });
        // Match by category+agent+tool+trace+product (the hash inputs) to find the DB row.
        const matchRow = (f) => persistedRows.find((row) =>
          row.category === f.category &&
          (row.agent_id ?? null) === (f.agent_id ?? null) &&
          (row.tool_name ?? null) === (f.tool_name ?? null) &&
          (row.trace_id ?? null) === (f.trace_id ?? null) &&
          (row.product_id ?? null) === (f.product_id ?? null));
        const baseReview = llmResult.ok
          ? llmResult.review
          : degradedReview({ reviewId, window: { from: windowFrom, to: windowTo }, candidates: candidates.candidates });
        const reviewForNotify = {
          ...baseReview,
          findings: (baseReview.findings || []).map((f) => {
            if (f.finding_id) return f;
            const row = matchRow(f);
            return row ? { ...f, finding_id: row.finding_id } : f;
          }),
        };
        notifier.enqueue({ reviewId, run, review: reviewForNotify, dashboardUrl });

        // Enqueue individual high/critical findings.
        const highFindings = reviewStore.listFindings({ limit: 1000, severity: 'high' });
        const criticalFindings = reviewStore.listFindings({ limit: 1000, severity: 'critical' });
        const persistedFindings = [...highFindings, ...criticalFindings];
        for (const pf of persistedFindings) {
          if (pf.review_id === reviewId) {
            notifier.enqueueFinding({ finding: pf, reviewId, run, dashboardUrl });
          }
        }
        logAudit(
          'review.notification.enqueued',
          'ok',
          `Notifications enqueued for review ${reviewId}.`,
          'audit.notify',
        );
      } catch (err) {
        logAudit(
          'review.notification.enqueued',
          'error',
          `Notification enqueue failed: ${err.message}`,
          'audit.notify',
        );
      }

      // 10. Finish run.
      reviewStore.finishRun(reviewId, {
        status,
        scannedFiles: ingestResult.scannedFiles,
        insertedEvents: ingestResult.inserted,
        parseErrorCount: ingestResult.parseErrors.length,
        candidateEventCount: candidates.candidates.length,
        findingCount,
        llmModel,
        errorCode,
      });
      logAudit(
        'review.completed',
        status === 'completed' ? 'ok' : 'error',
        `Review ${reviewId} finished with status=${status}, findings=${findingCount}.`,
      );
      return { reviewId, status };
    } catch (err) {
      // Any uncaught error: mark failed, release lock.
      status = 'failed';
      errorCode = err.code ?? 'internal_error';
      try {
        reviewStore.finishRun(reviewId, {
          status: 'failed',
          scannedFiles: ingestResult.scannedFiles,
          insertedEvents: ingestResult.inserted,
          parseErrorCount: ingestResult.parseErrors.length,
          candidateEventCount: candidates.candidates.length,
          findingCount,
          llmModel,
          errorCode,
          errorMessage: err.message,
        });
      } catch {
        // best effort
      }
      logAudit(
        'review.completed',
        'error',
        `Review ${reviewId} failed unexpectedly: ${err.message}`,
      );
      return { reviewId, status: 'failed' };
    } finally {
      clearRefreshTimer();
      try {
        lockStore.release({ lockName: LOCK_NAME, ownerId });
      } catch {
        // best effort
      }
    }
  }

  function start() {
    if (intervalTimer) return;
    const delayMs = initialDelaySeconds * 1000;
    intervalTimer = setInterval(() => {
      runOnce({ triggerType: 'scheduled' }).catch((err) => {
        // Prevent unhandled rejection; the cycle already logs internally.
        void err;
      });
    }, intervalMinutes * 60000);
    // Schedule an initial run after the delay.
    setTimeout(() => {
      runOnce({ triggerType: 'scheduled' }).catch(() => {});
    }, delayMs);
  }

  function stop() {
    clearRefreshTimer();
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  }

  return {
    start,
    stop,
    runOnce,
    recoverStaleRuns,
  };
}