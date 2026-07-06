// src/auditReview/reviewStore.js
import crypto from 'crypto';

function nowIso() {
  return new Date().toISOString();
}

const SEVERITY_ORDER = { low: 1, medium: 2, high: 3, critical: 4 };

function severityRank(sev) {
  return SEVERITY_ORDER[sev] ?? 0;
}

export function computeFindingHash({ category, agentId, toolName, traceId, productId, normalizedErrorCode }) {
  const parts = [
    category ?? '',
    agentId ?? '',
    toolName ?? '',
    traceId ?? '',
    productId ?? '',
    normalizedErrorCode ?? '',
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Hydrate a raw DB row into a finding object, stripping any legacy
 * `confidence` column (removed in v1.5) and parsing JSON text columns
 * (`evidence_event_ids_json`, `evidence_json`) into structured values.
 */
function hydrateFinding(row) {
  if (!row) return null;
  const { confidence, evidence_event_ids_json, evidence_json, llm_analysis_json, ...rest } = row;
  void confidence;
  return {
    ...rest,
    evidence_event_ids: parseJson(evidence_event_ids_json, []),
    evidence: parseJson(evidence_json, []),
    llm_analysis: parseJson(llm_analysis_json, null),
  };
}

export function createReviewStore(db) {
  const insertRunStmt = db.prepare(`
    INSERT INTO audit_review_runs (
      review_id, window_from, window_to, status, trigger_type, interval_minutes,
      scanned_files, inserted_events, parse_error_count, candidate_event_count, finding_count,
      llm_model, risk_policy_version, prompt_version, reviewer_version,
      error_code, error_message, started_at, finished_at
    ) VALUES (
      @review_id, @window_from, @window_to, @status, @trigger_type, @interval_minutes,
      @scanned_files, @inserted_events, @parse_error_count, @candidate_event_count, @finding_count,
      @llm_model, @risk_policy_version, @prompt_version, @reviewer_version,
      @error_code, @error_message, @started_at, @finished_at
    )
  `);

  const finishRunStmt = db.prepare(`
    UPDATE audit_review_runs
    SET status = @status,
        scanned_files = @scanned_files,
        inserted_events = @inserted_events,
        parse_error_count = @parse_error_count,
        candidate_event_count = @candidate_event_count,
        finding_count = @finding_count,
        llm_model = @llm_model,
        error_code = @error_code,
        error_message = @error_message,
        finished_at = @finished_at
    WHERE review_id = @review_id
  `);

  const markRunStatusStmt = db.prepare(`
    UPDATE audit_review_runs SET status = @status WHERE review_id = @review_id
  `);

  const listRunsStmt = db.prepare(`
    SELECT * FROM audit_review_runs ORDER BY started_at DESC LIMIT @limit OFFSET @offset
  `);

  const getRunStmt = db.prepare(`SELECT * FROM audit_review_runs WHERE review_id = ?`);

  const listStaleRunningStmt = db.prepare(`
    SELECT * FROM audit_review_runs WHERE status = 'running' AND started_at < @stale_before_iso
  `);

  const findExistingStmt = db.prepare(`
    SELECT * FROM audit_review_findings WHERE finding_hash = ?
  `);

  const insertFindingStmt = db.prepare(`
    INSERT INTO audit_review_findings (
      finding_id, review_id, finding_hash, category, severity,
      agent_id, tool_name, trace_id, product_id,
      title, summary, recommendation, requires_action,
      evidence_event_ids_json, evidence_json,
      status, occurrence_count, created_at, last_seen_at,
      last_notified_at, resolved_at, snoozed_until,
      acknowledged_at, acknowledged_by,
      llm_analysis_json, analysis_generated_at,
      risk_policy_version, prompt_version, reviewer_version
    ) VALUES (
      @finding_id, @review_id, @finding_hash, @category, @severity,
      @agent_id, @tool_name, @trace_id, @product_id,
      @title, @summary, @recommendation, @requires_action,
      @evidence_event_ids_json, @evidence_json,
      @status, @occurrence_count, @created_at, @last_seen_at,
      @last_notified_at, @resolved_at, @snoozed_until,
      @acknowledged_at, @acknowledged_by,
      NULL, NULL,
      @risk_policy_version, @prompt_version, @reviewer_version
    )
  `);

  const updateFindingByHashStmt = db.prepare(`
    UPDATE audit_review_findings
    SET severity = @severity,
        occurrence_count = occurrence_count + 1,
        last_seen_at = @last_seen_at,
        last_notified_at = CASE WHEN @clear_notified = 1 THEN NULL ELSE last_notified_at END,
        llm_analysis_json = NULL,
        analysis_generated_at = NULL
    WHERE finding_hash = @finding_hash
  `);

  const getFindingStmt = db.prepare(`SELECT * FROM audit_review_findings WHERE finding_id = ?`);

  const saveFindingAnalysisStmt = db.prepare(`
    UPDATE audit_review_findings
    SET llm_analysis_json = @llm_analysis_json,
        analysis_generated_at = @analysis_generated_at
    WHERE finding_id = @finding_id
  `);

  const updateFindingStmt = db.prepare(`
    UPDATE audit_review_findings SET
      status = COALESCE(@status, status),
      acknowledged_at = COALESCE(@acknowledged_at, acknowledged_at),
      acknowledged_by = COALESCE(@acknowledged_by, acknowledged_by),
      snoozed_until = COALESCE(@snoozed_until, snoozed_until),
      resolved_at = COALESCE(@resolved_at, resolved_at),
      last_notified_at = COALESCE(@last_notified_at, last_notified_at)
    WHERE finding_id = @finding_id
  `);

  const getLlmUsageStmt = db.prepare(`SELECT day, calls, est_tokens FROM audit_llm_usage WHERE day = ?`);
  const recordLlmUsageStmt = db.prepare(`
    INSERT INTO audit_llm_usage (day, calls, est_tokens, updated_at)
    VALUES (@day, @calls, @est_tokens, @updated_at)
    ON CONFLICT(day) DO UPDATE SET
      calls = calls + excluded.calls,
      est_tokens = est_tokens + excluded.est_tokens,
      updated_at = excluded.updated_at
  `);

  let deadLetterCountStmt = null;
  let traceEventsStmt = null;
  function getDeadLetterCountStmt() {
    if (!deadLetterCountStmt) {
      // Lazy prepare: agent_outbox_events may not exist in isolated tests
      // that only run ensureReviewSchema without ensureRuntimeSchema.
      deadLetterCountStmt = db.prepare(`
        SELECT COUNT(*) AS count FROM agent_outbox_events WHERE delivery_status = 'dead_letter'
      `);
    }
    return deadLetterCountStmt;
  }

  function getTraceEventsStmt() {
    if (!traceEventsStmt) {
      traceEventsStmt = db.prepare(`
        SELECT * FROM audit_events
        WHERE trace_id = @trace_id
        ORDER BY ts ASC, id ASC
        LIMIT @limit
      `);
    }
    return traceEventsStmt;
  }

  return {
    createRun({
      reviewId, windowFrom, windowTo, triggerType, intervalMinutes,
      riskPolicyVersion, promptVersion, reviewerVersion,
    }) {
      insertRunStmt.run({
        review_id: reviewId,
        window_from: windowFrom,
        window_to: windowTo,
        status: 'running',
        trigger_type: triggerType,
        interval_minutes: intervalMinutes ?? null,
        scanned_files: 0,
        inserted_events: 0,
        parse_error_count: 0,
        candidate_event_count: 0,
        finding_count: 0,
        llm_model: null,
        risk_policy_version: riskPolicyVersion,
        prompt_version: promptVersion ?? null,
        reviewer_version: reviewerVersion,
        error_code: null,
        error_message: null,
        started_at: nowIso(),
        finished_at: null,
      });
      return getRunStmt.get(reviewId);
    },

    finishRun(reviewId, {
      status, scannedFiles = 0, insertedEvents = 0, parseErrorCount = 0,
      candidateEventCount = 0, findingCount = 0, llmModel = null,
      errorCode = null, errorMessage = null,
    }) {
      finishRunStmt.run({
        review_id: reviewId,
        status,
        scanned_files: scannedFiles,
        inserted_events: insertedEvents,
        parse_error_count: parseErrorCount,
        candidate_event_count: candidateEventCount,
        finding_count: findingCount,
        llm_model: llmModel,
        error_code: errorCode,
        error_message: errorMessage,
        finished_at: nowIso(),
      });
      return getRunStmt.get(reviewId);
    },

    markRunStatus(reviewId, status) {
      markRunStatusStmt.run({ review_id: reviewId, status });
    },

    listRuns({ limit = 50, offset = 0 } = {}) {
      return listRunsStmt.all({ limit, offset });
    },

    getRun(reviewId) {
      return getRunStmt.get(reviewId) ?? null;
    },

    listStaleRunning({ staleBeforeIso }) {
      return listStaleRunningStmt.all({ stale_before_iso: staleBeforeIso });
    },

    upsertFinding(finding) {
      const findingHash = finding.finding_hash ?? computeFindingHash({
        category: finding.category,
        agentId: finding.agent_id,
        toolName: finding.tool_name,
        traceId: finding.trace_id,
        productId: finding.product_id,
        normalizedErrorCode: finding.normalized_error_code ?? finding.error_code,
      });
      const existing = findExistingStmt.get(findingHash);
      const now = nowIso();
      if (existing) {
        const oldRank = severityRank(existing.severity);
        const newRank = severityRank(finding.severity);
        const severityEscalated = newRank > oldRank;
        // Re-notify when severity escalates: clear last_notified_at so the next
        // notification pass treats it as eligible again.
        updateFindingByHashStmt.run({
          finding_hash: findingHash,
          severity: finding.severity,
          last_seen_at: now,
          clear_notified: severityEscalated ? 1 : 0,
        });
        const updated = findExistingStmt.get(findingHash);
        return { finding: hydrateFinding(updated), isNew: false, severityEscalated };
      }
      const findingId = finding.finding_id ?? `fnd_${crypto.randomUUID()}`;
      insertFindingStmt.run({
        finding_id: findingId,
        review_id: finding.review_id,
        finding_hash: findingHash,
        category: finding.category,
        severity: finding.severity,
        agent_id: finding.agent_id ?? null,
        tool_name: finding.tool_name ?? null,
        trace_id: finding.trace_id ?? null,
        product_id: finding.product_id ?? null,
        title: finding.title,
        summary: finding.summary,
        recommendation: finding.recommendation ?? null,
        requires_action: finding.requires_action ? 1 : 0,
        evidence_event_ids_json: typeof finding.evidence_event_ids === 'string'
          ? finding.evidence_event_ids
          : JSON.stringify(finding.evidence_event_ids ?? []),
        evidence_json: finding.evidence_json ?? null,
        status: 'open',
        occurrence_count: 1,
        created_at: now,
        last_seen_at: now,
        last_notified_at: null,
        resolved_at: null,
        snoozed_until: null,
        acknowledged_at: null,
        acknowledged_by: null,
        risk_policy_version: finding.risk_policy_version,
        prompt_version: finding.prompt_version ?? null,
        reviewer_version: finding.reviewer_version,
      });
      const inserted = getFindingStmt.get(findingId);
      return { finding: hydrateFinding(inserted), isNew: true, severityEscalated: false };
    },

    insertFinding(finding) {
      return this.upsertFinding(finding);
    },

    getFinding(findingId) {
      return hydrateFinding(getFindingStmt.get(findingId) ?? null);
    },

    saveFindingAnalysis(findingId, { analysis, generatedAt = nowIso() } = {}) {
      saveFindingAnalysisStmt.run({
        finding_id: findingId,
        llm_analysis_json: JSON.stringify(analysis ?? null),
        analysis_generated_at: generatedAt,
      });
      return hydrateFinding(getFindingStmt.get(findingId) ?? null);
    },

    listFindings({ limit = 100, offset = 0, severity, category, agentId, toolName, status, reviewId } = {}) {
      const conditions = [];
      const params = { limit, offset };
      if (severity) { conditions.push('severity = @severity'); params.severity = severity; }
      if (category) { conditions.push('category = @category'); params.category = category; }
      if (agentId) { conditions.push('agent_id = @agentId'); params.agentId = agentId; }
      if (toolName) { conditions.push('tool_name = @toolName'); params.toolName = toolName; }
      if (status) { conditions.push('status = @status'); params.status = status; }
      if (reviewId) { conditions.push('review_id = @reviewId'); params.reviewId = reviewId; }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = db.prepare(
        `SELECT * FROM audit_review_findings ${where} ORDER BY last_seen_at DESC LIMIT @limit OFFSET @offset`
      ).all(params);
      return rows.map(hydrateFinding);
    },

    listTraceEvents({ traceId, limit = 200 } = {}) {
      if (!traceId) return [];
      const parsedLimit = Number(limit);
      const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 200;
      return getTraceEventsStmt().all({ trace_id: traceId, limit: safeLimit });
    },

    listRawEventsByIds({ eventIds, limit = 200 } = {}) {
      const ids = Array.isArray(eventIds)
        ? eventIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
        : [];
      if (ids.length === 0) return [];
      const parsedLimit = Number(limit);
      const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 200;
      const limitedIds = ids.slice(0, safeLimit);
      const placeholders = limitedIds.map(() => '?').join(', ');
      const rows = db.prepare(`
        SELECT id, raw_json FROM audit_events
        WHERE id IN (${placeholders})
      `).all(...limitedIds);
      const byId = new Map(rows.map((row) => [row.id, row]));
      return limitedIds.map((id) => byId.get(id)).filter(Boolean);
    },

    updateFinding(findingId, patch) {
      updateFindingStmt.run({
        finding_id: findingId,
        status: patch.status ?? null,
        acknowledged_at: patch.acknowledged_at ?? null,
        acknowledged_by: patch.acknowledged_by ?? null,
        snoozed_until: patch.snoozed_until ?? null,
        resolved_at: patch.resolved_at ?? null,
        last_notified_at: patch.last_notified_at ?? null,
      });
      return hydrateFinding(getFindingStmt.get(findingId) ?? null);
    },

    listDeadLetterCount() {
      const row = getDeadLetterCountStmt().get();
      return row ? row.count : 0;
    },

    getLlmUsage(day) {
      const key = String(day);
      return getLlmUsageStmt.get(key) ?? { day: key, calls: 0, est_tokens: 0 };
    },

    recordLlmUsage({ day, calls = 1, estTokens = 0 } = {}) {
      const key = String(day);
      const safeCalls = Number.isFinite(Number(calls)) ? Math.max(0, Math.floor(Number(calls))) : 0;
      const safeTokens = Number.isFinite(Number(estTokens)) ? Math.max(0, Math.floor(Number(estTokens))) : 0;
      recordLlmUsageStmt.run({
        day: key,
        calls: safeCalls,
        est_tokens: safeTokens,
        updated_at: nowIso(),
      });
      return this.getLlmUsage(key);
    },
  };
}
