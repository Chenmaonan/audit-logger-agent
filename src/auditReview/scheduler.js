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
import fs from 'fs';
import path from 'path';
import { agentDisplayName, buildEvidenceDetail, buildEvidenceIndex, evidenceForEventIds } from './evidence.js';
import { estimateTokensForPayload, llmBudgetFromConfig, usageWouldExceedBudget } from './llmBudget.js';
import { hashHtml, renderDownloadableDashboardHtml, snapshotFilename } from './dashboardSnapshot.js';

const LOCK_NAME = 'audit_review_scheduler';
const LEASE_MINUTES = 10;

function nowIso() {
  return new Date().toISOString();
}

function estimateTokensForReview({ reviewId, window, candidates }) {
  return estimateTokensForPayload({ review_id: reviewId, window, candidates: candidates ?? [] });
}

function reviewIdFor(now) {
  const ts = now.toISOString().replace(/[:.]/g, '-');
  return `review_${ts}_${crypto.randomUUID().slice(0, 8)}`;
}

function resolveSnapshotDir(config) {
  const configured = config?.paths?.dashboardSnapshotsDir
    ?? config?.auditReview?.visualization?.snapshotDir
    ?? path.join('data', 'dashboard-snapshots');
  if (path.isAbsolute(configured)) return configured;
  return path.resolve(config?.rootDir ?? config?.paths?.rootDir ?? process.cwd(), configured);
}

function snapshotTtlHours(config) {
  const value = Number(config?.auditReview?.visualization?.snapshotTtlHours ?? 24);
  return Number.isFinite(value) && value > 0 ? value : 24;
}

function severityCountsFor(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of Array.isArray(findings) ? findings : []) {
    if (Object.prototype.hasOwnProperty.call(counts, finding.severity)) {
      counts[finding.severity] += 1;
    }
  }
  return counts;
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function distinctAgentsInWindow(db, { windowFrom, windowTo }) {
  try {
    return db.prepare(`
      SELECT DISTINCT agent_id
      FROM audit_events
      WHERE ts >= @windowFrom AND ts <= @windowTo
      ORDER BY agent_id ASC
    `).all({ windowFrom, windowTo }).map((row) => row.agent_id).filter(Boolean);
  } catch {
    return [];
  }
}

const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };

function entityTypeOf(value) {
  return value?.entity?.type ?? value?.entity_type ?? null;
}

function entityIdOf(value) {
  return value?.entity?.id ?? value?.entity_id ?? null;
}

function maxSeverity(...severities) {
  return severities
    .filter(Boolean)
    .reduce((max, severity) =>
      (SEVERITY_RANK[severity] ?? 0) > (SEVERITY_RANK[max] ?? 0) ? severity : max,
    'low');
}

function filterEvidenceEventIds(eventIds, evidenceIndex) {
  const seen = new Set();
  const filtered = [];
  for (const id of Array.isArray(eventIds) ? eventIds : []) {
    if (!Number.isInteger(id) || !evidenceIndex.has(id) || seen.has(id)) continue;
    seen.add(id);
    filtered.push(id);
  }
  return filtered;
}

function buildCandidatesByEventId(candidates) {
  const byEventId = new Map();
  for (const candidate of candidates) {
    const bucket = byEventId.get(candidate.event_id) ?? [];
    bucket.push(candidate);
    byEventId.set(candidate.event_id, bucket);
  }
  return byEventId;
}

function ruleCandidateKey(candidate) {
  return [
    candidate.event_id,
    candidate.category ?? '',
    candidate.agent_id ?? '',
    candidate.tool_name ?? '',
    candidate.trace_id ?? '',
    entityTypeOf(candidate) ?? '',
    entityIdOf(candidate) ?? '',
  ].join('|');
}

function ruleCandidatesForEvidenceIds(evidenceIds, candidatesByEventId) {
  return evidenceIds
    .flatMap((id) => candidatesByEventId.get(id) ?? [])
    .filter((candidate) => candidate?.min_severity);
}

function ruleMinimumSeverityForCandidates(candidates) {
  let floor = null;
  for (const candidate of candidates) {
    floor = maxSeverity(floor, candidate.min_severity);
  }
  return floor;
}

function sameNullable(a, b) {
  return (a ?? null) === (b ?? null);
}

function findingMatchesCandidateIdentity(finding, candidate) {
  return candidate.category === finding.category &&
    sameNullable(candidate.agent_id, finding.agent_id) &&
    sameNullable(candidate.tool_name, finding.tool_name) &&
    sameNullable(candidate.trace_id, finding.trace_id) &&
    sameNullable(entityTypeOf(candidate), entityTypeOf(finding)) &&
    sameNullable(entityIdOf(candidate), entityIdOf(finding));
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
    severity: maxSeverity('medium', candidate.min_severity),
    agent_id: candidate.agent_id,
    tool_name: candidate.tool_name,
    trace_id: candidate.trace_id,
    entity: entityTypeOf(candidate) || entityIdOf(candidate)
      ? { type: entityTypeOf(candidate), id: entityIdOf(candidate) }
      : null,
    entity_type: entityTypeOf(candidate),
    entity_id: entityIdOf(candidate),
    title: candidate.reason ?? candidate.category,
    summary: candidate.reason ?? candidate.category,
    recommendation: '',
    requires_action: 0,
    evidence_event_ids: [candidate.event_id],
    evidence_event_ids_json: JSON.stringify([candidate.event_id]),
    evidence_json: JSON.stringify(evidence),
    normalized_error_code: null,
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
    const sev = maxSeverity('medium', c.min_severity);
    severityCounts[sev] = (severityCounts[sev] || 0) + 1;
  }
  return {
    type: 'audit_review',
    review_id: reviewId,
    window,
    summary: {
      title: 'LLM review unavailable; rule-based findings only',
      overview: `LLM review unavailable; generated rule-based findings from ${candidates.length} candidate event(s).`,
      severity_counts: severityCounts,
    },
    findings: candidates.map((c) => ({
      category: c.category,
      severity: maxSeverity('medium', c.min_severity),
      agent_id: c.agent_id,
      tool_name: c.tool_name,
      trace_id: c.trace_id,
      entity: entityTypeOf(c) || entityIdOf(c)
        ? { type: entityTypeOf(c), id: entityIdOf(c) }
        : null,
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
      entity: null,
      entity_type: null,
      entity_id: null,
      title: '日志解析失败',
      summary: `${errors.length} 条解析错误，涉及 ${uniqueFiles.size} 个文件。样例：${samples.join('; ')}`,
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
  toolSemanticMapper,
  notifier,
  visualization,
  dashboardSnapshotStore,
  logBatchStore,
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
  const llmBudget = llmBudgetFromConfig(config);

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

  async function cleanupExpiredDashboardSnapshots(cleanupNow) {
    if (!dashboardSnapshotStore?.deleteExpiredSnapshots) return null;

    try {
      const result = dashboardSnapshotStore.deleteExpiredSnapshots(cleanupNow);
      const failedCount = result.failedFiles?.length ?? 0;
      const deletedFileCount = result.deletedFiles?.length ?? 0;
      const missingFileCount = result.missingFiles?.length ?? 0;
      if (result.deleted > 0 || failedCount > 0) {
        await logAudit(
          'review.snapshot.expired_deleted',
          failedCount > 0 ? 'INTERNAL' : 'OK',
          `Expired snapshot cleanup: metadata=${result.deleted}, files=${deletedFileCount}, missing=${missingFileCount}, failed=${failedCount}.`,
          'audit.snapshot',
        );
      }
      return result;
    } catch (error) {
      await logAudit(
        'review.snapshot.expired_delete_failed',
        'INTERNAL',
        `Expired snapshot cleanup failed: ${error.message}`,
        'audit.snapshot',
      );
      return null;
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
        'OK',
        `Recovered ${recoveredCount} stale run(s), released ${expiredLocks.length} expired lock(s).`,
        'audit.review.recovery',
      );
    } catch (error) {
      logAudit(
        'review.recovered',
        'INTERNAL',
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
      // Another run holds the lease - record a skipped run and return.
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
        'OK',
        `Skipped review ${reviewId}: lock held by ${acquired.currentOwner ?? 'another owner'}.`,
      );
      return { reviewId, status: 'skipped' };
    }

    const reviewId = reviewIdFor(now());
    const windowTo = now().toISOString();
    await cleanupExpiredDashboardSnapshots(windowTo);

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
      'OK',
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
    const lockedBatches = [];

    function deletePreviousReviewedRawLogs(agentId, excludeBatchId) {
      if (!logBatchStore?.deleteReviewedRawLogsForAgent) return;
      try {
        const result = logBatchStore.deleteReviewedRawLogsForAgent({
          agentId,
          excludeBatchId,
          now: now().toISOString(),
        });
        if (result?.skipped) {
          logAudit(
            'review.batch.raw_delete_skipped',
            'OK',
            `Skipped raw deletion for agent ${agentId}: ${result.reason ?? 'unknown reason'}.`,
            'audit.review.batch',
          );
        } else if ((result?.batchIds?.length ?? 0) > 0) {
          logAudit(
            'review.batch.raw_deleted',
            'OK',
            `Deleted ${result.deletedRows ?? 0} raw event(s) from ${result.batchIds.length} reviewed batch(es) for agent ${agentId}.`,
            'audit.review.batch',
          );
        }
      } catch (error) {
        logAudit(
          'review.batch.raw_delete_failed',
          'INTERNAL',
          `Failed to delete reviewed raw logs for agent ${agentId}: ${error.message}`,
          'audit.review.batch',
        );
      }
    }

    function lockOpenBatchesForReview() {
      if (!logBatchStore) return;
      const agentIds = distinctAgentsInWindow(db, { windowFrom, windowTo });
      for (const agentId of agentIds) {
        try {
          const batchNow = now().toISOString();
          const currentOpenBatch = logBatchStore.getOrCreateOpenBatch?.(agentId, { now: batchNow });
          deletePreviousReviewedRawLogs(agentId, currentOpenBatch?.batch_id);
          const result = logBatchStore.lockOpenBatchForReview({ agentId, reviewId, now: batchNow });
          if (result?.lockedBatch) lockedBatches.push(result.lockedBatch);
        } catch (error) {
          logAudit(
            'review.batch.lock_failed',
            'INTERNAL',
            `Failed to lock batch for agent ${agentId}: ${error.message}`,
            'audit.review.batch',
          );
        }
      }
    }

    function agentIdsForSnapshots() {
      const ids = new Set();
      for (const candidate of candidates.candidates ?? []) {
        if (candidate?.agent_id) ids.add(candidate.agent_id);
      }
      for (const error of ingestResult.parseErrors ?? []) {
        if (error?.agent_id) ids.add(error.agent_id);
      }
      return [...ids].sort();
    }

    function createSnapshot({ run, agentId = null, page }) {
      const generatedAt = run.finished_at ?? new Date().toISOString();
      const expiresAt = new Date(Date.parse(generatedAt) + snapshotTtlHours(config) * 60 * 60 * 1000).toISOString();
      const html = renderDownloadableDashboardHtml(page);
      const { sha256, byteSize } = hashHtml(html);
      const snapshotId = `snapshot_${crypto.randomUUID()}`;
      const filename = snapshotFilename({ agentId, reviewId, createdAt: generatedAt });
      const filePath = path.join(resolveSnapshotDir(config), filename);
      writeFileAtomic(filePath, html);
      const findings = reviewStore.listFindings({ limit: 1000, reviewId });
      return dashboardSnapshotStore.createSnapshotMetadata({
        snapshotId,
        reviewId,
        agentId,
        generatedAt,
        expiresAt,
        filePath,
        sha256,
        byteSize,
        title: agentId ? `Agent ${agentId} 审查快照` : `Review ${reviewId} 审查快照`,
        status: run.status,
        findingCount: agentId
          ? findings.filter((finding) => finding.agent_id === agentId).length
          : run.finding_count,
        severityCounts: severityCountsFor(agentId
          ? findings.filter((finding) => finding.agent_id === agentId)
          : findings),
      });
    }

    function generateDashboardSnapshots() {
      if (!dashboardSnapshotStore) return { snapshots: [], agentSnapshotByAgentId: new Map() };
      const run = reviewStore.getRun(reviewId);
      const snapshots = [];
      const agentSnapshotByAgentId = new Map();
      const reviewSnapshot = createSnapshot({
        run,
        page: visualization.reviewDetailPage(reviewId),
      });
      snapshots.push(reviewSnapshot);

      for (const agentId of agentIdsForSnapshots()) {
        const snapshot = createSnapshot({
          run,
          agentId,
          page: visualization.agentLatestPage(agentId),
        });
        snapshots.push(snapshot);
        agentSnapshotByAgentId.set(agentId, snapshot);
      }

      return { snapshots, agentSnapshotByAgentId };
    }

    function markLockedBatchesReviewed(snapshotResult) {
      if (!logBatchStore || lockedBatches.length === 0 || snapshotResult.snapshots.length === 0) return;
      const reviewSnapshot = snapshotResult.snapshots.find((snapshot) => !snapshot.agentId);
      for (const batch of lockedBatches) {
        try {
          const agentSnapshot = snapshotResult.agentSnapshotByAgentId.get(batch.agent_id);
          logBatchStore.markReviewed({
            batchId: batch.batch_id,
            reviewId,
            snapshotId: agentSnapshot?.snapshotId ?? reviewSnapshot?.snapshotId ?? snapshotResult.snapshots[0].snapshotId,
          });
        } catch (error) {
          logAudit(
            'review.batch.mark_reviewed_failed',
            'INTERNAL',
            `Failed to mark batch ${batch.batch_id} reviewed: ${error.message}`,
            'audit.review.batch',
          );
        }
      }
    }

    try {
      // 5. Ingest.
      const sinceDate = windowFrom.slice(0, 10);
      try {
        ingestResult = ingestService.ingestSince({ sinceDate, reviewId });
        logAudit(
          'review.ingest.completed',
          'OK',
          `Ingest: scanned=${ingestResult.scannedFiles}, inserted=${ingestResult.inserted}, parseErrors=${ingestResult.parseErrors.length}`,
          'audit.ingest',
        );
        lockOpenBatchesForReview();
      } catch (err) {
        logAudit(
          'review.ingest.completed',
          'INTERNAL',
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
          'INTERNAL',
          `Review ${reviewId} failed during ingest: ${err.message}`,
        );
        clearRefreshTimer();
        try { lockStore.release({ lockName: LOCK_NAME, ownerId }); } catch {}
        return { reviewId, status: 'failed' };
      }

      // 6. Detect candidates.
      try {
        if (toolSemanticMapper) {
          await toolSemanticMapper.mapPendingEvents({
            from: windowFrom,
            to: windowTo,
            limit: maxEventsPerReview,
          });
        }
        candidates = detector.detect({ windowFrom, windowTo, maxEventsPerReview });
        logAudit(
          'review.detector.completed',
          'OK',
          `Detector: ${candidates.candidates.length} candidates from ${candidates.totalEvents} events.`,
          'audit.detector',
        );
      } catch (err) {
        logAudit(
          'review.detector.completed',
          'INTERNAL',
          `Detector failed: ${err.message}`,
          'audit.detector',
        );
        candidates = { candidates: [], totalEvents: 0, trimmed: false };
      }

      // 6a. Build a structured evidence index keyed by event_id for LLM findings.
      const evidenceIndex = buildEvidenceIndex(candidates.candidates, agentsConfig);
      const candidatesByEventId = buildCandidatesByEventId(candidates.candidates);

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
      const llmDay = windowTo.slice(0, 10);
      const estimatedTokens = estimateTokensForReview({
        reviewId,
        window: { from: windowFrom, to: windowTo },
        candidates: candidates.candidates,
      });
      const llmUsage = reviewStore.getLlmUsage?.(llmDay) ?? { day: llmDay, calls: 0, est_tokens: 0 };
      if (usageWouldExceedBudget(llmUsage, llmBudget, estimatedTokens)) {
        llmResult = { ok: false, degraded: true, error: 'llm_budget_exceeded' };
        logAudit(
          'review.llm.budget_exceeded',
          'INTERNAL',
          `Skipped LLM review: usage calls=${llmUsage.calls}/${llmBudget.maxCallsPerDay}, est_tokens=${llmUsage.est_tokens}/${llmBudget.maxTokensPerDay}, next_est_tokens=${estimatedTokens}.`,
          'audit.llm',
        );
      } else {
        try {
          llmResult = await llmReviewer.review({
            reviewId,
            window: { from: windowFrom, to: windowTo },
            candidates: candidates.candidates,
            reviewStore,
          });
          reviewStore.recordLlmUsage?.({ day: llmDay, calls: 1, estTokens: estimatedTokens });
          logAudit(
            'review.llm.completed',
            llmResult.ok ? 'OK' : 'INTERNAL',
            llmResult.ok
              ? `LLM review ok, model=${llmModel}, prompt=${promptVersion}`
              : `LLM review degraded: ${llmResult.error ?? 'unknown error'}`,
            'audit.llm',
          );
        } catch (err) {
          reviewStore.recordLlmUsage?.({ day: llmDay, calls: 1, estTokens: estimatedTokens });
          llmResult = { ok: false, degraded: true, error: err.message };
          logAudit(
            'review.llm.completed',
            'INTERNAL',
            `LLM review threw: ${err.message}`,
            'audit.llm',
          );
        }
      }

      if (!llmResult.ok) {
        status = 'completed_degraded';
        errorCode = llmResult.error === 'llm_budget_exceeded' ? 'llm_budget_exceeded' : 'llm_error';
      }

      // 8. Persist findings.
      let findingsToPersist = [];
      if (llmResult.ok && llmResult.review && Array.isArray(llmResult.review.findings)) {
        const coveredRuleCandidateKeys = new Set();
        findingsToPersist = llmResult.review.findings.flatMap((f) => {
          const evidenceIds = filterEvidenceEventIds(f.evidence_event_ids, evidenceIndex);
          const evidence = evidenceForEventIds(evidenceIds, evidenceIndex);
          const ruleCandidates = ruleCandidatesForEvidenceIds(evidenceIds, candidatesByEventId);
          const matchedRuleCandidates = ruleCandidates.filter((candidate) =>
            findingMatchesCandidateIdentity(f, candidate));
          const minSeverity = ruleMinimumSeverityForCandidates(matchedRuleCandidates);
          for (const candidate of matchedRuleCandidates) {
            coveredRuleCandidateKeys.add(ruleCandidateKey(candidate));
          }
          if (
            f.category === 'high_risk_permission' &&
            (evidenceIds.length === 0 || (ruleCandidates.length > 0 && matchedRuleCandidates.length === 0))
          ) {
            return [];
          }
          return [{
            finding_id: `finding_${crypto.randomUUID()}`,
            review_id: reviewId,
            category: f.category,
            severity: maxSeverity(f.severity, minSeverity),
            agent_id: f.agent_id,
            tool_name: f.tool_name,
            trace_id: f.trace_id,
            entity: f.entity ?? null,
            entity_type: f.entity?.type ?? null,
            entity_id: f.entity?.id ?? null,
            title: f.title,
            summary: f.summary,
            recommendation: f.recommendation,
            requires_action: f.requires_action ? 1 : 0,
            evidence_event_ids: evidenceIds,
            evidence_event_ids_json: JSON.stringify(evidenceIds),
            evidence_json: JSON.stringify(evidence),
            normalized_error_code: null,
            risk_policy_version: riskPolicyVersion,
            prompt_version: promptVersion,
            reviewer_version: reviewerVersion,
          }];
        });
        const uncoveredRuleFindings = candidates.candidates
          .filter((c) => c.min_severity && !coveredRuleCandidateKeys.has(ruleCandidateKey(c)))
          .map((c) => findingFromCandidate(c, reviewId, riskPolicyVersion, promptVersion, reviewerVersion, agentsConfig));
        findingsToPersist.push(...uncoveredRuleFindings);
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
        // Match by category+agent+tool+trace+entity (the hash inputs) to find the DB row.
        const matchRow = (f) => persistedRows.find((row) =>
          row.category === f.category &&
          (row.agent_id ?? null) === (f.agent_id ?? null) &&
          (row.tool_name ?? null) === (f.tool_name ?? null) &&
          (row.trace_id ?? null) === (f.trace_id ?? null) &&
          (row.entity_type ?? null) === entityTypeOf(f) &&
          (row.entity_id ?? null) === entityIdOf(f));
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
          'OK',
          `Notifications enqueued for review ${reviewId}.`,
          'audit.notify',
        );
      } catch (err) {
        logAudit(
          'review.notification.enqueued',
          'INTERNAL',
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
      let snapshotResult = { snapshots: [], agentSnapshotByAgentId: new Map() };
      try {
        snapshotResult = generateDashboardSnapshots();
        if (snapshotResult.snapshots.length > 0) {
          logAudit(
            'review.snapshot.generated',
            'OK',
            `Generated ${snapshotResult.snapshots.length} dashboard snapshot(s) for review ${reviewId}.`,
            'audit.snapshot',
          );
          markLockedBatchesReviewed(snapshotResult);
        }
      } catch (error) {
        logAudit(
          'review.snapshot.generated',
          'INTERNAL',
          `Snapshot generation failed for review ${reviewId}: ${error.message}`,
          'audit.snapshot',
        );
      }
      logAudit(
        'review.completed',
        status === 'completed' ? 'OK' : 'INTERNAL',
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
        'INTERNAL',
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
