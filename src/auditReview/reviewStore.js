// src/auditReview/reviewStore.js
import crypto from 'crypto';

function nowIso() {
  return new Date().toISOString();
}

const SEVERITY_ORDER = { low: 1, medium: 2, high: 3, critical: 4 };

function severityRank(sev) {
  return SEVERITY_ORDER[sev] ?? 0;
}

export function computeFindingHash({ category, agentId, toolName, traceId, entityType, entityId, normalizedErrorCode }) {
  const parts = [
    category ?? '',
    agentId ?? '',
    toolName ?? '',
    traceId ?? '',
    entityType ?? '',
    entityId ?? '',
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
    entity: rest.entity_type || rest.entity_id
      ? { type: rest.entity_type ?? null, id: rest.entity_id ?? null }
      : null,
    evidence_event_ids: parseJson(evidence_event_ids_json, []),
    evidence: parseJson(evidence_json, []),
    llm_analysis: parseJson(llm_analysis_json, null),
  };
}

function hydrateOccurrence(row) {
  if (!row) return null;
  const { evidence_event_ids_json, evidence_json, ...rest } = row;
  return {
    ...rest,
    evidence_event_ids: parseJson(evidence_event_ids_json, []),
    evidence: parseJson(evidence_json, []),
  };
}

function normalizeEvidenceEventIds(finding) {
  const value = finding.evidence_event_ids ?? parseJson(finding.evidence_event_ids_json, []);
  return Array.isArray(value)
    ? [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
    : [];
}

function normalizeEvidence(finding) {
  if (Array.isArray(finding.evidence)) return finding.evidence;
  return parseJson(finding.evidence_json, []);
}

function mergeEvidence(left, right) {
  const merged = [];
  const seen = new Set();
  for (const item of [...left, ...right]) {
    const key = item?.event_id != null ? `event:${item.event_id}` : `json:${JSON.stringify(item)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function observedAtFor(finding, fallback) {
  if (finding.observed_at) return finding.observed_at;
  let latest = null;
  for (const evidence of normalizeEvidence(finding)) {
    const ts = evidence?.log_detail?.ts ?? evidence?.ts ?? null;
    if (ts && (!latest || ts > latest)) latest = ts;
  }
  return latest ?? fallback;
}

function mergeReviewFindings(findings, observedAtFallback) {
  const byHash = new Map();
  for (const finding of findings ?? []) {
    const findingHash = finding.finding_hash ?? computeFindingHash({
      category: finding.category,
      agentId: finding.agent_id,
      toolName: finding.tool_name,
      traceId: finding.trace_id,
      entityType: finding.entity?.type ?? finding.entity_type,
      entityId: finding.entity?.id ?? finding.entity_id,
      normalizedErrorCode: finding.normalized_error_code,
    });
    const normalized = {
      ...finding,
      finding_hash: findingHash,
      evidence_event_ids: normalizeEvidenceEventIds(finding),
      evidence: normalizeEvidence(finding),
      observed_at: observedAtFor(finding, observedAtFallback),
    };
    const existing = byHash.get(findingHash);
    if (!existing) {
      byHash.set(findingHash, normalized);
      continue;
    }
    const useIncoming = severityRank(normalized.severity) > severityRank(existing.severity);
    const primary = useIncoming ? normalized : existing;
    byHash.set(findingHash, {
      ...existing,
      ...primary,
      finding_hash: findingHash,
      requires_action: existing.requires_action || normalized.requires_action ? 1 : 0,
      evidence_event_ids: [...new Set([...existing.evidence_event_ids, ...normalized.evidence_event_ids])],
      evidence: mergeEvidence(existing.evidence, normalized.evidence),
      observed_at: existing.observed_at > normalized.observed_at ? existing.observed_at : normalized.observed_at,
    });
  }
  return [...byHash.values()];
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
      agent_id, tool_name, trace_id, entity_type, entity_id,
      title, summary, recommendation, requires_action,
      evidence_event_ids_json, evidence_json,
      status, occurrence_count, created_at, last_seen_at,
      last_notified_at, resolved_at, snoozed_until,
      acknowledged_at, acknowledged_by,
      llm_analysis_json, analysis_generated_at,
      risk_policy_version, prompt_version, reviewer_version,
      first_review_id, last_review_id, max_severity, state_version
    ) VALUES (
      @finding_id, @review_id, @finding_hash, @category, @severity,
      @agent_id, @tool_name, @trace_id, @entity_type, @entity_id,
      @title, @summary, @recommendation, @requires_action,
      @evidence_event_ids_json, @evidence_json,
      @status, @occurrence_count, @created_at, @last_seen_at,
      @last_notified_at, @resolved_at, @snoozed_until,
      @acknowledged_at, @acknowledged_by,
      NULL, NULL,
      @risk_policy_version, @prompt_version, @reviewer_version,
      @first_review_id, @last_review_id, @max_severity, 1
    )
  `);

  const updateFindingByHashStmt = db.prepare(`
    UPDATE audit_review_findings
    SET severity = @severity,
        max_severity = @max_severity,
        last_review_id = @last_review_id,
        title = @title,
        summary = @summary,
        recommendation = @recommendation,
        requires_action = @requires_action,
        evidence_event_ids_json = @evidence_event_ids_json,
        evidence_json = @evidence_json,
        occurrence_count = occurrence_count + @occurrence_increment,
        last_seen_at = @last_seen_at,
        status = @status,
        state_version = state_version + @state_version_increment,
        snoozed_until = CASE WHEN @clear_snoozed = 1 THEN NULL ELSE snoozed_until END,
        resolved_at = CASE WHEN @clear_resolved = 1 THEN NULL ELSE resolved_at END,
        last_notified_at = CASE WHEN @clear_notified = 1 THEN NULL ELSE last_notified_at END,
        llm_analysis_json = NULL,
        analysis_generated_at = NULL
    WHERE finding_hash = @finding_hash
  `);

  const getOccurrenceStmt = db.prepare(`
    SELECT * FROM audit_review_finding_occurrences WHERE review_id = ? AND finding_id = ?
  `);
  const upsertOccurrenceStmt = db.prepare(`
    INSERT INTO audit_review_finding_occurrences (
      occurrence_id, finding_id, review_id, severity, title, summary, recommendation,
      evidence_event_ids_json, evidence_json, observed_at,
      is_new, severity_escalated, reopened, created_at
    ) VALUES (
      @occurrence_id, @finding_id, @review_id, @severity, @title, @summary, @recommendation,
      @evidence_event_ids_json, @evidence_json, @observed_at,
      @is_new, @severity_escalated, @reopened, @created_at
    )
    ON CONFLICT(review_id, finding_id) DO UPDATE SET
      severity = excluded.severity,
      title = excluded.title,
      summary = excluded.summary,
      recommendation = excluded.recommendation,
      evidence_event_ids_json = excluded.evidence_event_ids_json,
      evidence_json = excluded.evidence_json,
      observed_at = excluded.observed_at,
      is_new = MAX(audit_review_finding_occurrences.is_new, excluded.is_new),
      severity_escalated = MAX(audit_review_finding_occurrences.severity_escalated, excluded.severity_escalated),
      reopened = MAX(audit_review_finding_occurrences.reopened, excluded.reopened)
  `);
  const countReviewOccurrencesStmt = db.prepare(`
    SELECT COUNT(*) AS count FROM audit_review_finding_occurrences WHERE review_id = ?
  `);
  const insertActionStmt = db.prepare(`
    INSERT INTO audit_finding_actions (
      action_id, finding_id, action_type, from_status, to_status,
      actor, note, snoozed_until, created_at
    ) VALUES (
      @action_id, @finding_id, @action_type, @from_status, @to_status,
      @actor, @note, @snoozed_until, @created_at
    )
  `);
  const getActionStmt = db.prepare(`SELECT * FROM audit_finding_actions WHERE action_id = ?`);
  const applyFindingActionStmt = db.prepare(`
    UPDATE audit_review_findings SET
      status = @to_status,
      state_version = state_version + 1,
      acknowledged_at = CASE WHEN @set_acknowledged_at = 1 THEN @acknowledged_at ELSE acknowledged_at END,
      acknowledged_by = CASE WHEN @set_acknowledged_by = 1 THEN @acknowledged_by ELSE acknowledged_by END,
      snoozed_until = CASE WHEN @set_snoozed_until = 1 THEN @patch_snoozed_until ELSE snoozed_until END,
      resolved_at = CASE WHEN @set_resolved_at = 1 THEN @resolved_at ELSE resolved_at END,
      last_notified_at = CASE WHEN @set_last_notified_at = 1 THEN @last_notified_at ELSE last_notified_at END
    WHERE finding_id = @finding_id
      AND state_version = @expected_state_version
  `);
  const listExpiredSnoozedFindingsStmt = db.prepare(`
    SELECT * FROM audit_review_findings
    WHERE status = 'snoozed'
      AND snoozed_until IS NOT NULL
      AND snoozed_until <= ?
    ORDER BY snoozed_until ASC, finding_id ASC
  `);
  const expireSnoozedFindingStmt = db.prepare(`
    UPDATE audit_review_findings
    SET status = 'open',
        state_version = state_version + 1,
        snoozed_until = NULL,
        last_notified_at = NULL
    WHERE finding_id = ? AND status = 'snoozed'
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
  const reserveLlmUsageStmt = db.prepare(`
    INSERT INTO audit_llm_usage (day, calls, est_tokens, updated_at)
    SELECT @day, @calls, @est_tokens, @updated_at
    WHERE @calls <= @max_calls_per_day
      AND @est_tokens <= @max_tokens_per_day
    ON CONFLICT(day) DO UPDATE SET
      calls = calls + excluded.calls,
      est_tokens = est_tokens + excluded.est_tokens,
      updated_at = excluded.updated_at
    WHERE audit_llm_usage.calls + excluded.calls <= @max_calls_per_day
      AND audit_llm_usage.est_tokens + excluded.est_tokens <= @max_tokens_per_day
  `);

  let deadLetterCountStmt = null;
  let traceEventsStmt = null;
  let listAgentsStmt = null;
  let listAgentEventsStmt = null;
  let listAgentEventsFilteredStmt = null;
  let listAgentEventsFallbackStmt = null;
  let listAgentEventsFilteredFallbackStmt = null;
  let countAgentEventsStmt = null;
  let countAgentEventsFilteredStmt = null;
  let countAgentEventsFallbackStmt = null;
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

  function getListAgentsStmt() {
    if (!listAgentsStmt) {
      listAgentsStmt = db.prepare(`
        SELECT
          events.agent_id,
          events.event_count,
          events.last_event_at,
          COALESCE(findings.finding_count, 0) AS finding_count,
          COALESCE(findings.open_finding_count, 0) AS open_finding_count
        FROM (
          SELECT agent_id, COUNT(*) AS event_count, MAX(ts) AS last_event_at
          FROM audit_events
          WHERE agent_id IS NOT NULL AND agent_id <> ''
          GROUP BY agent_id
        ) events
        LEFT JOIN (
          SELECT
            agent_id,
            COUNT(*) AS finding_count,
            SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_finding_count
          FROM audit_review_findings
          WHERE agent_id IS NOT NULL AND agent_id <> ''
          GROUP BY agent_id
        ) findings ON findings.agent_id = events.agent_id
        ORDER BY events.last_event_at DESC, events.agent_id ASC
        LIMIT @limit OFFSET @offset
      `);
    }
    return listAgentsStmt;
  }

  function getListAgentEventsStmt(filtered = false) {
    const cached = filtered ? listAgentEventsFilteredStmt : listAgentEventsStmt;
    if (cached) return cached;
    const filterSql = filtered ? `
          AND (@log_event IS NULL OR events.event = @log_event)
          AND (@log_tool_name IS NULL OR events.tool_name = @log_tool_name)
          AND (@log_trace_id IS NULL OR events.trace_id = @log_trace_id)
          AND (@log_status IS NULL OR events.status = @log_status)
          AND (@severity IS NULL OR trace_severity.severity_rank = CASE @severity
            WHEN 'critical' THEN 4
            WHEN 'high' THEN 3
            WHEN 'medium' THEN 2
            WHEN 'low' THEN 1
            ELSE -1
          END)
          AND (@category IS NULL OR EXISTS (
            SELECT 1
            FROM audit_review_findings category_findings
            WHERE category_findings.agent_id = events.agent_id
              AND category_findings.trace_id = events.trace_id
              AND category_findings.category = @category
              AND NULLIF(TRIM(events.trace_id), '') IS NOT NULL
              AND events.trace_id <> 'trace_null'
          ))
          AND (@finding_status IS NULL OR EXISTS (
            SELECT 1
            FROM audit_review_findings status_findings
            WHERE status_findings.agent_id = events.agent_id
              AND status_findings.trace_id = events.trace_id
              AND status_findings.status = @finding_status
              AND NULLIF(TRIM(events.trace_id), '') IS NOT NULL
              AND events.trace_id <> 'trace_null'
          ))` : '';
    const statement = db.prepare(`
        WITH trace_severity AS (
          SELECT
            findings.agent_id,
            findings.trace_id,
            MAX(CASE occurrences.severity
              WHEN 'critical' THEN 4
              WHEN 'high' THEN 3
              WHEN 'medium' THEN 2
              WHEN 'low' THEN 1
              ELSE 0
            END) AS severity_rank
          FROM audit_review_finding_occurrences occurrences
          JOIN audit_review_findings findings ON findings.finding_id = occurrences.finding_id
          WHERE findings.agent_id = @agent_id
            AND NULLIF(TRIM(findings.trace_id), '') IS NOT NULL
            AND findings.trace_id <> 'trace_null'
          GROUP BY findings.agent_id, findings.trace_id
        )
        SELECT
          events.*,
          CASE trace_severity.severity_rank
            WHEN 4 THEN 'critical'
            WHEN 3 THEN 'high'
            WHEN 2 THEN 'medium'
            WHEN 1 THEN 'low'
            ELSE NULL
          END AS severity
        FROM audit_events events
        LEFT JOIN trace_severity
          ON trace_severity.agent_id = events.agent_id
          AND trace_severity.trace_id = events.trace_id
          AND NULLIF(TRIM(events.trace_id), '') IS NOT NULL
          AND events.trace_id <> 'trace_null'
        WHERE events.agent_id = @agent_id
          ${filterSql}
        ORDER BY
          CASE WHEN @sort = 'severity_desc' THEN COALESCE(trace_severity.severity_rank, 0) ELSE 0 END DESC,
          events.ts DESC,
          events.id DESC
        LIMIT @limit OFFSET @offset
      `);
    if (filtered) listAgentEventsFilteredStmt = statement;
    else listAgentEventsStmt = statement;
    return statement;
  }

  function getListAgentEventsFallbackStmt(filtered = false) {
    const cached = filtered ? listAgentEventsFilteredFallbackStmt : listAgentEventsFallbackStmt;
    if (cached) return cached;
    const filterSql = filtered ? `
          AND (@log_event IS NULL OR events.event = @log_event)
          AND (@log_tool_name IS NULL OR events.tool_name = @log_tool_name)
          AND (@log_trace_id IS NULL OR events.trace_id = @log_trace_id)
          AND (@log_status IS NULL OR events.status = @log_status)` : '';
    const statement = db.prepare(`
        SELECT events.*, NULL AS severity
        FROM audit_events events
        WHERE events.agent_id = @agent_id
          ${filterSql}
        ORDER BY events.ts DESC, events.id DESC
        LIMIT @limit OFFSET @offset
      `);
    if (filtered) listAgentEventsFilteredFallbackStmt = statement;
    else listAgentEventsFallbackStmt = statement;
    return statement;
  }

  function getCountAgentEventsStmt(filtered = false) {
    const cached = filtered ? countAgentEventsFilteredStmt : countAgentEventsStmt;
    if (cached) return cached;
    const filterSql = filtered ? `
          AND (@log_event IS NULL OR events.event = @log_event)
          AND (@log_tool_name IS NULL OR events.tool_name = @log_tool_name)
          AND (@log_trace_id IS NULL OR events.trace_id = @log_trace_id)
          AND (@log_status IS NULL OR events.status = @log_status)
          AND (@severity IS NULL OR trace_severity.severity_rank = CASE @severity
            WHEN 'critical' THEN 4
            WHEN 'high' THEN 3
            WHEN 'medium' THEN 2
            WHEN 'low' THEN 1
            ELSE -1
          END)
          AND (@category IS NULL OR EXISTS (
            SELECT 1
            FROM audit_review_findings category_findings
            WHERE category_findings.agent_id = events.agent_id
              AND category_findings.trace_id = events.trace_id
              AND category_findings.category = @category
              AND NULLIF(TRIM(events.trace_id), '') IS NOT NULL
              AND events.trace_id <> 'trace_null'
          ))
          AND (@finding_status IS NULL OR EXISTS (
            SELECT 1
            FROM audit_review_findings status_findings
            WHERE status_findings.agent_id = events.agent_id
              AND status_findings.trace_id = events.trace_id
              AND status_findings.status = @finding_status
              AND NULLIF(TRIM(events.trace_id), '') IS NOT NULL
              AND events.trace_id <> 'trace_null'
          ))` : '';
    const traceSeveritySql = filtered ? `
        WITH trace_severity AS (
          SELECT
            findings.agent_id,
            findings.trace_id,
            MAX(CASE occurrences.severity
              WHEN 'critical' THEN 4
              WHEN 'high' THEN 3
              WHEN 'medium' THEN 2
              WHEN 'low' THEN 1
              ELSE 0
            END) AS severity_rank
          FROM audit_review_finding_occurrences occurrences
          JOIN audit_review_findings findings ON findings.finding_id = occurrences.finding_id
          WHERE findings.agent_id = @agent_id
            AND NULLIF(TRIM(findings.trace_id), '') IS NOT NULL
            AND findings.trace_id <> 'trace_null'
          GROUP BY findings.agent_id, findings.trace_id
        )` : '';
    const traceSeverityJoinSql = filtered ? `
        LEFT JOIN trace_severity
          ON trace_severity.agent_id = events.agent_id
          AND trace_severity.trace_id = events.trace_id` : '';
    const statement = db.prepare(`
        ${traceSeveritySql}
        SELECT COUNT(*) AS count FROM audit_events events
        ${traceSeverityJoinSql}
        WHERE events.agent_id = @agent_id
          ${filterSql}
      `);
    if (filtered) countAgentEventsFilteredStmt = statement;
    else countAgentEventsStmt = statement;
    return statement;
  }

  function getCountAgentEventsFallbackStmt() {
    if (!countAgentEventsFallbackStmt) {
      countAgentEventsFallbackStmt = db.prepare(`
        SELECT COUNT(*) AS count FROM audit_events
        WHERE agent_id = @agent_id
      `);
    }
    return countAgentEventsFallbackStmt;
  }

  function insertSystemAction({ findingId, actionType, fromStatus, toStatus, createdAt, note = null }) {
    const actionId = `act_${crypto.randomUUID()}`;
    insertActionStmt.run({
      action_id: actionId,
      finding_id: findingId,
      action_type: actionType,
      from_status: fromStatus,
      to_status: toStatus,
      actor: 'system',
      note,
      snoozed_until: null,
      created_at: createdAt,
    });
    return getActionStmt.get(actionId);
  }

  function upsertFindingWithOccurrence(finding) {
    const now = nowIso();
    const normalized = mergeReviewFindings([finding], now)[0];
    const findingHash = normalized.finding_hash;
    const reviewId = normalized.review_id;
    const evidenceEventIds = normalized.evidence_event_ids;
    const evidence = normalized.evidence;
    const evidenceEventIdsJson = JSON.stringify(evidenceEventIds);
    const evidenceJson = JSON.stringify(evidence);
    const observedAt = normalized.observed_at;
    const existing = findExistingStmt.get(findingHash);
    let findingId;
    let isNew = false;
    let severityEscalated = false;
    let reopened = false;
    let systemAction = null;

    if (existing) {
      findingId = existing.finding_id;
      const existingOccurrence = getOccurrenceStmt.get(reviewId, findingId);
      const occurrenceIncrement = existingOccurrence ? 0 : 1;
      severityEscalated = severityRank(normalized.severity) > severityRank(existing.severity);
      const maxSeverity = severityRank(normalized.severity) > severityRank(existing.max_severity ?? existing.severity)
        ? normalized.severity
        : (existing.max_severity ?? existing.severity);
      let status = existing.status;
      let stateVersionIncrement = 0;
      let clearSnoozed = 0;
      let clearResolved = 0;
      let actionType = null;

      if (existing.status === 'snoozed' && existing.snoozed_until && existing.snoozed_until <= observedAt) {
        status = 'open';
        stateVersionIncrement = 1;
        clearSnoozed = 1;
        actionType = 'snooze_expired';
      } else if (
        existing.status === 'resolved' &&
        existing.resolved_at &&
        observedAt > existing.resolved_at
      ) {
        status = 'open';
        stateVersionIncrement = 1;
        clearResolved = 1;
        reopened = true;
        actionType = 'recurrence';
      }

      const occurrenceEvidenceIds = existingOccurrence
        ? [...new Set([...parseJson(existingOccurrence.evidence_event_ids_json, []), ...evidenceEventIds])]
        : evidenceEventIds;
      const occurrenceEvidence = existingOccurrence
        ? mergeEvidence(parseJson(existingOccurrence.evidence_json, []), evidence)
        : evidence;

      updateFindingByHashStmt.run({
        finding_hash: findingHash,
        severity: normalized.severity,
        max_severity: maxSeverity,
        last_review_id: reviewId,
        title: normalized.title,
        summary: normalized.summary,
        recommendation: normalized.recommendation ?? null,
        requires_action: normalized.requires_action ? 1 : 0,
        evidence_event_ids_json: JSON.stringify(occurrenceEvidenceIds),
        evidence_json: JSON.stringify(occurrenceEvidence),
        occurrence_increment: occurrenceIncrement,
        last_seen_at: observedAt,
        status,
        state_version_increment: stateVersionIncrement,
        clear_snoozed: clearSnoozed,
        clear_resolved: clearResolved,
        clear_notified: severityEscalated || reopened ? 1 : 0,
      });
      upsertOccurrenceStmt.run({
        occurrence_id: existingOccurrence?.occurrence_id ?? `occ_${crypto.randomUUID()}`,
        finding_id: findingId,
        review_id: reviewId,
        severity: normalized.severity,
        title: normalized.title,
        summary: normalized.summary,
        recommendation: normalized.recommendation ?? null,
        evidence_event_ids_json: JSON.stringify(occurrenceEvidenceIds),
        evidence_json: JSON.stringify(occurrenceEvidence),
        observed_at: existingOccurrence?.observed_at > observedAt ? existingOccurrence.observed_at : observedAt,
        is_new: existingOccurrence?.is_new ?? 0,
        severity_escalated: severityEscalated ? 1 : 0,
        reopened: reopened ? 1 : 0,
        created_at: existingOccurrence?.created_at ?? now,
      });
      if (actionType) {
        systemAction = insertSystemAction({
          findingId,
          actionType,
          fromStatus: existing.status,
          toStatus: status,
          createdAt: observedAt,
        });
      }
    } else {
      isNew = true;
      findingId = normalized.finding_id ?? `fnd_${crypto.randomUUID()}`;
      insertFindingStmt.run({
        finding_id: findingId,
        review_id: reviewId,
        finding_hash: findingHash,
        category: normalized.category,
        severity: normalized.severity,
        agent_id: normalized.agent_id ?? null,
        tool_name: normalized.tool_name ?? null,
        trace_id: normalized.trace_id ?? null,
        entity_type: normalized.entity?.type ?? normalized.entity_type ?? null,
        entity_id: normalized.entity?.id ?? normalized.entity_id ?? null,
        title: normalized.title,
        summary: normalized.summary,
        recommendation: normalized.recommendation ?? null,
        requires_action: normalized.requires_action ? 1 : 0,
        evidence_event_ids_json: evidenceEventIdsJson,
        evidence_json: evidenceJson,
        status: 'open',
        occurrence_count: 1,
        created_at: now,
        last_seen_at: observedAt,
        last_notified_at: null,
        resolved_at: null,
        snoozed_until: null,
        acknowledged_at: null,
        acknowledged_by: null,
        risk_policy_version: normalized.risk_policy_version,
        prompt_version: normalized.prompt_version ?? null,
        reviewer_version: normalized.reviewer_version,
        first_review_id: reviewId,
        last_review_id: reviewId,
        max_severity: normalized.severity,
      });
      upsertOccurrenceStmt.run({
        occurrence_id: `occ_${crypto.randomUUID()}`,
        finding_id: findingId,
        review_id: reviewId,
        severity: normalized.severity,
        title: normalized.title,
        summary: normalized.summary,
        recommendation: normalized.recommendation ?? null,
        evidence_event_ids_json: evidenceEventIdsJson,
        evidence_json: evidenceJson,
        observed_at: observedAt,
        is_new: 1,
        severity_escalated: 0,
        reopened: 0,
        created_at: now,
      });
    }

    return {
      finding: hydrateFinding(getFindingStmt.get(findingId)),
      occurrence: hydrateOccurrence(getOccurrenceStmt.get(reviewId, findingId)),
      action: systemAction,
      isNew,
      severityEscalated,
      reopened,
    };
  }

  function finishRunInternal(reviewId, {
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
  }

  function expireSnoozedFindings(observedAt) {
    const actions = [];
    for (const finding of listExpiredSnoozedFindingsStmt.all(observedAt)) {
      const result = expireSnoozedFindingStmt.run(finding.finding_id);
      if (result.changes !== 1) continue;
      actions.push(insertSystemAction({
        findingId: finding.finding_id,
        actionType: 'snooze_expired',
        fromStatus: 'snoozed',
        toStatus: 'open',
        createdAt: observedAt,
      }));
    }
    return actions;
  }

  const upsertFindingTransaction = db.transaction((finding) => upsertFindingWithOccurrence(finding));
  const persistReviewResultTransaction = db.transaction((reviewId, options) => {
    if (!getRunStmt.get(reviewId)) {
      throw new Error(`persistReviewResult: review run not found: ${reviewId}`);
    }
    const observedAtFallback = options.observedAt ?? nowIso();
    const expiredActions = expireSnoozedFindings(observedAtFallback);
    const mergedFindings = mergeReviewFindings(options.findings, observedAtFallback)
      .map((finding) => ({ ...finding, review_id: reviewId }));
    const results = mergedFindings.map(upsertFindingWithOccurrence);
    const findingCount = countReviewOccurrencesStmt.get(reviewId).count;
    const run = finishRunInternal(reviewId, { ...options, findingCount });
    return { run, findings: results, findingCount, expiredActions };
  });

  const applyFindingActionTransaction = db.transaction((input) => {
    const existing = getFindingStmt.get(input.findingId);
    if (!existing) return { outcome: 'not_found' };
    if (existing.state_version !== input.expectedStateVersion) {
      return { outcome: 'version_conflict', finding: hydrateFinding(existing) };
    }
    const allowed = Array.isArray(input.allowedFromStatuses) ? input.allowedFromStatuses : [];
    if (!allowed.includes(existing.status)) {
      return { outcome: 'state_conflict', finding: hydrateFinding(existing) };
    }

    const patch = input.findingPatch ?? {};
    const actionInput = input.action ?? {};
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    const result = applyFindingActionStmt.run({
      finding_id: input.findingId,
      expected_state_version: input.expectedStateVersion,
      to_status: input.toStatus,
      set_acknowledged_at: has('acknowledgedAt') ? 1 : 0,
      acknowledged_at: patch.acknowledgedAt ?? null,
      set_acknowledged_by: has('acknowledgedBy') ? 1 : 0,
      acknowledged_by: patch.acknowledgedBy ?? null,
      set_snoozed_until: has('snoozedUntil') ? 1 : 0,
      patch_snoozed_until: patch.snoozedUntil ?? null,
      set_resolved_at: has('resolvedAt') ? 1 : 0,
      resolved_at: patch.resolvedAt ?? null,
      set_last_notified_at: has('lastNotifiedAt') ? 1 : 0,
      last_notified_at: patch.lastNotifiedAt ?? null,
    });
    if (result.changes !== 1) {
      const current = getFindingStmt.get(input.findingId);
      return { outcome: 'version_conflict', finding: hydrateFinding(current) };
    }

    const actionId = `act_${crypto.randomUUID()}`;
    insertActionStmt.run({
      action_id: actionId,
      finding_id: input.findingId,
      action_type: actionInput.actionType,
      from_status: existing.status,
      to_status: input.toStatus,
      actor: actionInput.actor,
      note: actionInput.note ?? null,
      snoozed_until: actionInput.snoozedUntil ?? null,
      created_at: actionInput.createdAt ?? nowIso(),
    });
    return {
      outcome: 'updated',
      finding: hydrateFinding(getFindingStmt.get(input.findingId)),
      action: getActionStmt.get(actionId),
    };
  });

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
      return finishRunInternal(reviewId, {
        status,
        scannedFiles,
        insertedEvents,
        parseErrorCount,
        candidateEventCount,
        findingCount,
        llmModel,
        errorCode,
        errorMessage,
      });
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
      return upsertFindingTransaction(finding);
    },

    insertFinding(finding) {
      return this.upsertFinding(finding);
    },

    persistReviewResult(reviewId, options = {}) {
      return persistReviewResultTransaction(reviewId, options);
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
      if (reviewId) {
        conditions.push(`finding_id IN (
          SELECT finding_id FROM audit_review_finding_occurrences WHERE review_id = @reviewId
        )`);
        params.reviewId = reviewId;
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = db.prepare(
        `SELECT * FROM audit_review_findings ${where} ORDER BY last_seen_at DESC LIMIT @limit OFFSET @offset`
      ).all(params);
      return rows.map(hydrateFinding);
    },

    listFindingActions({ findingId, limit = 100, offset = 0 } = {}) {
      return db.prepare(`
        SELECT * FROM audit_finding_actions
        WHERE finding_id = @finding_id
        ORDER BY created_at DESC, action_id DESC
        LIMIT @limit OFFSET @offset
      `).all({ finding_id: findingId, limit, offset });
    },

    listFindingOccurrences({ findingId, limit = 100, offset = 0 } = {}) {
      return db.prepare(`
        SELECT * FROM audit_review_finding_occurrences
        WHERE finding_id = @finding_id
        ORDER BY observed_at DESC, occurrence_id DESC
        LIMIT @limit OFFSET @offset
      `).all({ finding_id: findingId, limit, offset }).map(hydrateOccurrence);
    },

    listReviewOccurrences({ reviewId, limit = 100, offset = 0 } = {}) {
      return db.prepare(`
        SELECT * FROM audit_review_finding_occurrences
        WHERE review_id = @review_id
        ORDER BY severity DESC, observed_at DESC, occurrence_id DESC
        LIMIT @limit OFFSET @offset
      `).all({ review_id: reviewId, limit, offset }).map(hydrateOccurrence);
    },

    applyFindingAction(input) {
      return applyFindingActionTransaction(input);
    },

    listAgents({ limit = 100, offset = 0 } = {}) {
      const parsedLimit = Number(limit);
      const parsedOffset = Number(offset);
      const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 100;
      const safeOffset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? Math.floor(parsedOffset) : 0;
      try {
        return getListAgentsStmt().all({ limit: safeLimit, offset: safeOffset });
      } catch (error) {
        if (/no such table/i.test(error?.message ?? '')) return [];
        throw error;
      }
    },

    listAgentEvents({
      agentId,
      limit = 100,
      offset = 0,
      sort = 'time_desc',
      logEvent,
      logToolName,
      logTraceId,
      logStatus,
      severity,
      category,
      status,
    } = {}) {
      if (!agentId) return [];
      const parsedLimit = Number(limit);
      const parsedOffset = Number(offset);
      const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 100;
      const safeOffset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? Math.floor(parsedOffset) : 0;
      const safeSort = sort === 'severity_desc' ? 'severity_desc' : 'time_desc';
      const hasRiskFilters = Boolean(severity || category || status);
      const hasLogFilters = Boolean(logEvent || logToolName || logTraceId || logStatus || hasRiskFilters);
      const query = {
        agent_id: agentId,
        limit: safeLimit,
        offset: safeOffset,
        sort: safeSort,
        log_event: logEvent || null,
        log_tool_name: logToolName || null,
        log_trace_id: logTraceId || null,
        log_status: logStatus || null,
        severity: severity || null,
        category: category || null,
        finding_status: status || null,
      };
      try {
        return getListAgentEventsStmt(hasLogFilters).all(query);
      } catch (error) {
        if (/no such (?:table|column):\s*(?:audit_review_finding_occurrences|audit_review_findings|(?:\w+\.)?(?:trace_id|event|tool_name|status))/i.test(error?.message ?? '')) {
          if (hasRiskFilters) return [];
          try {
            return getListAgentEventsFallbackStmt(hasLogFilters).all(query);
          } catch (fallbackError) {
            if (/no such table/i.test(fallbackError?.message ?? '')) return [];
            throw fallbackError;
          }
        }
        if (/no such table/i.test(error?.message ?? '')) return [];
        throw error;
      }
    },

    countAgentEvents({
      agentId,
      logEvent,
      logToolName,
      logTraceId,
      logStatus,
      severity,
      category,
      status,
    } = {}) {
      if (!agentId) return 0;
      const query = {
        agent_id: agentId,
        log_event: logEvent || null,
        log_tool_name: logToolName || null,
        log_trace_id: logTraceId || null,
        log_status: logStatus || null,
        severity: severity || null,
        category: category || null,
        finding_status: status || null,
      };
      const hasRiskFilters = Boolean(severity || category || status);
      const hasLogFilters = Boolean(logEvent || logToolName || logTraceId || logStatus || hasRiskFilters);
      try {
        return getCountAgentEventsStmt(hasLogFilters).get(query)?.count ?? 0;
      } catch (error) {
        if (/no such (?:table|column)/i.test(error?.message ?? '')) {
          if (hasRiskFilters) return 0;
          try {
            return getCountAgentEventsFallbackStmt().get(query)?.count ?? 0;
          } catch (fallbackError) {
            if (/no such table/i.test(fallbackError?.message ?? '')) return 0;
            throw fallbackError;
          }
        }
        if (/no such table/i.test(error?.message ?? '')) return 0;
        throw error;
      }
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

    reserveLlmUsage({ day, calls = 1, estTokens = 0, maxCallsPerDay, maxTokensPerDay } = {}) {
      const key = String(day);
      const safeCalls = Number.isFinite(Number(calls)) ? Math.max(0, Math.floor(Number(calls))) : 0;
      const safeTokens = Number.isFinite(Number(estTokens)) ? Math.max(0, Math.floor(Number(estTokens))) : 0;
      const safeMaxCalls = Number.isFinite(Number(maxCallsPerDay))
        ? Math.max(0, Math.floor(Number(maxCallsPerDay)))
        : 0;
      const safeMaxTokens = Number.isFinite(Number(maxTokensPerDay))
        ? Math.max(0, Math.floor(Number(maxTokensPerDay)))
        : 0;
      const result = reserveLlmUsageStmt.run({
        day: key,
        calls: safeCalls,
        est_tokens: safeTokens,
        max_calls_per_day: safeMaxCalls,
        max_tokens_per_day: safeMaxTokens,
        updated_at: nowIso(),
      });
      return {
        reserved: result.changes > 0,
        ...this.getLlmUsage(key),
      };
    },
  };
}
