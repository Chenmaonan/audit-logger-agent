// Local rule-based candidate detection for v1.4 audit review.
// See v1.4 PERIODIC_LLM_AUDIT_REVIEW_DESIGN.md sections 6.4 and 6.6.

const EVIDENCE_FIELDS = [
  'event_id',
  'ts',
  'agent_id',
  'tool_name',
  'event',
  'status',
  'duration_ms',
  'trace_id',
  'span_id',
  'entity_type',
  'entity_id',
  'error_message',
  'result_summary',
  'mapped_tool_type',
  'mapping_status',
  'mapping_reason',
];

function matchGlob(name, pattern) {
  if (typeof name !== 'string' || typeof pattern !== 'string') return false;
  const lowerName = name.toLowerCase();
  const lowerPattern = pattern.toLowerCase();
  // Convert glob pattern to regex: '*' -> '.*', escape other regex metachars.
  let regex = '';
  for (let i = 0; i < lowerPattern.length; i++) {
    const ch = lowerPattern[i];
    if (ch === '*') {
      regex += '.*';
    } else {
      regex += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${regex}$`).test(lowerName);
}

function isHighRisk(toolName, patterns) {
  return (patterns ?? []).some((p) => matchGlob(toolName, p));
}

function toEpochMs(ts) {
  if (ts == null) return null;
  const n = Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

function makeCandidate(row, category, reason, extras = {}) {
  return {
    event_id: row.id,
    ts: row.ts,
    agent_id: row.agent_id,
    tool_name: row.tool_name,
    event: row.event,
    status: row.status,
    duration_ms: row.duration_ms,
    trace_id: row.trace_id,
    span_id: row.span_id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    error_message: row.error_message,
    result_summary: row.result_summary,
    mapped_tool_type: row.mapped_tool_type,
    mapping_status: row.mapping_status,
    mapping_reason: row.mapping_reason,
    category,
    reason,
    ...extras,
  };
}

export function createCandidateDetector({ db, riskPolicy } = {}) {
  if (!db) throw new Error('createCandidateDetector: db is required');
  const columns = new Set(db.prepare('PRAGMA table_info(audit_events)').all().map((row) => row.name));
  const selectOrNull = (column) => columns.has(column) ? column : `NULL AS ${column}`;
  const policy = riskPolicy ?? {};
  const repeatWindowMs = (policy.repeatWindowMinutes ?? 10) * 60000;
  const repeatThreshold = policy.repeatThreshold ?? 5;
  const slowCallDurationMs = policy.slowCallDurationMs ?? 30000;
  const highRiskToolPatterns = policy.highRiskToolPatterns ?? [];
  const agentToolAllowlists = policy.agentToolAllowlists ?? {};
  const trustedChannels = policy.trustedChannels ?? [];

  const selectSql = `
    SELECT id, ts, agent_id, trace_id, span_id, parent_span_id, event, tool_name,
           status, result_summary, duration_ms, channel, user_id, entity_type,
           entity_id, error_message, ${selectOrNull('mapped_tool_type')},
           ${selectOrNull('mapping_status')}, ${selectOrNull('mapping_reason')}
    FROM audit_events
    WHERE ts >= @from AND ts <= @to
    ORDER BY ts ASC
  `;
  const stmt = db.prepare(selectSql);

  function detect({ windowFrom, windowTo, maxEventsPerReview = 500 } = {}) {
    if (!windowFrom || !windowTo) throw new Error('detect requires windowFrom and windowTo');
    const rows = stmt.all({ from: windowFrom, to: windowTo });
    const totalEvents = rows.length;

    const candidates = [];
    // For repeated_call sliding window: key -> array of { tsMs, row } (sorted ascending).
    const repeatBuckets = new Map();
    // For trace_integrity: span_ids that have end/error events.
    const endedSpanIds = new Set();
    // To avoid duplicate candidates for the same anchor event.
    const emittedEventIds = new Set();

    // First pass: collect ended span_ids and build repeat buckets.
    for (const row of rows) {
      if (row.event === 'tool.end' || row.event === 'tool.error') {
        if (row.span_id) endedSpanIds.add(row.span_id);
      }
    }

    // Repeated-call: for each event, push into its bucket and check threshold.
    // Emit at most one candidate per key when threshold first reached within the window.
    const repeatEmittedKeys = new Set();
    for (const row of rows) {
      const tsMs = toEpochMs(row.ts);
      if (tsMs == null) continue;
      const key = `${row.agent_id}|${row.tool_name}|${row.entity_type ?? ''}|${row.entity_id ?? ''}`;
      const bucket = repeatBuckets.get(key) ?? [];
      // Drop timestamps older than (tsMs - repeatWindowMs).
      const cutoff = tsMs - repeatWindowMs;
      const kept = [];
      for (const entry of bucket) {
        if (entry.tsMs >= cutoff) kept.push(entry);
      }
      kept.push({ tsMs, row });
      repeatBuckets.set(key, kept);

      if (!repeatEmittedKeys.has(key) && kept.length >= repeatThreshold) {
        repeatEmittedKeys.add(key);
        const anchor = kept[0].row;
        if (!emittedEventIds.has(anchor.id)) {
          emittedEventIds.add(anchor.id);
          candidates.push(
            makeCandidate(
              anchor,
              'repeated_call',
              `${kept.length} calls to same agent/tool/entity within ${Math.round(repeatWindowMs / 60000)} min window`,
            ),
          );
        }
      }
    }

    // Second pass: apply per-event rules (failed, high-risk, slow, channel, trace_integrity, unknown tool).
    // Reset emittedEventIds tracking is not needed; we want all distinct category candidates.
    // We allow the same event_id to appear under multiple categories (e.g., a slow high-risk call).
    for (const row of rows) {
      // 1. failed_call
      if (row.status !== 'OK') {
        candidates.push(
          makeCandidate(row, 'failed_call', `status=${row.status}`),
        );
      }

      // 3a. high_risk_permission
      const highRisk = isHighRisk(row.tool_name, highRiskToolPatterns);
      if (highRisk) {
        candidates.push(
          makeCandidate(row, 'high_risk_permission', `tool_name matches high-risk pattern`, { min_severity: 'high' }),
        );
        // 5. abnormal channel for high-risk tool
        if (trustedChannels.length > 0 && row.channel != null && !trustedChannels.includes(row.channel)) {
          candidates.push(
            makeCandidate(row, 'anomalous_call', `high-risk tool on unexpected channel=${row.channel}`),
          );
        }
      }

      // 3b. unknown tool -> anomalous_call
      const allowlist = agentToolAllowlists[row.agent_id];
      if (Array.isArray(allowlist) && allowlist.length > 0 && !allowlist.includes(row.tool_name)) {
        candidates.push(
          makeCandidate(row, 'anomalous_call', `tool not in agent allowlist`),
        );
      }

      // 4. slow call -> anomalous_call
      if (row.duration_ms != null && row.duration_ms >= slowCallDurationMs) {
        candidates.push(
          makeCandidate(row, 'anomalous_call', `duration_ms=${row.duration_ms} >= ${slowCallDurationMs}`),
        );
      }

      // 6. trace_integrity: tool.start without matching tool.end/tool.error
      if (row.event === 'tool.start' && row.span_id && !endedSpanIds.has(row.span_id)) {
        candidates.push(
          makeCandidate(row, 'trace_integrity', `tool.start for span_id=${row.span_id} has no matching tool.end/tool.error within window`),
        );
      }
    }

    // Trimming: if totalEvents > maxEventsPerReview, keep ALL candidates but cap at maxEventsPerReview.
    let trimmed = false;
    if (totalEvents > maxEventsPerReview) {
      trimmed = true;
    }
    // Cap candidates to bound LLM input.
    const capped = candidates.slice(0, maxEventsPerReview);

    return {
      candidates: capped,
      totalEvents,
      trimmed,
    };
  }

  return { detect };
}

export { EVIDENCE_FIELDS, matchGlob };
