// src/auditReview/evidence.js
//
// Build structured evidence payloads for audit review findings.
// See v1.5/V1_5_GENERIC_DELIVERY_AND_AUDIT_REVIEW_PLAN.md Task 3.

/**
 * Resolve a human-friendly display name for an agent.
 * Falls back to the raw agent_id when no config entry exists.
 */
export function agentDisplayName(agentId, config = {}) {
  return config?.agents?.[agentId]?.displayName ?? config?.agents?.[agentId]?.name ?? agentId ?? '';
}

/**
 * Build a structured evidence detail object from a candidate event row.
 * Never exposes raw_json or other raw input/output blobs.
 */
export function buildEvidenceDetail(event, config = {}) {
  return {
    event_id: event.event_id ?? event.id ?? null,
    agent_id: event.agent_id ?? null,
    agent_name: agentDisplayName(event.agent_id, config),
    tool_name: event.tool_name ?? null,
    trace_id: event.trace_id ?? null,
    span_id: event.span_id ?? null,
    log_detail: {
      ts: event.ts ?? null,
      event: event.event ?? null,
      status: event.status ?? null,
      duration_ms: event.duration_ms ?? null,
      product_id: event.product_id ?? null,
      result_summary: event.result_summary ?? null,
      error_code: event.error_code ?? null,
      error_message: event.error_message ?? null,
      reason: event.reason ?? null,
    },
  };
}

/**
 * Build a lookup index (Map<event_id, evidenceDetail>) from candidate rows.
 */
export function buildEvidenceIndex(candidates = [], config = {}) {
  return new Map(candidates.map((candidate) => [candidate.event_id, buildEvidenceDetail(candidate, config)]));
}

/**
 * Resolve evidence details for a list of event ids, preserving the requested
 * order and skipping ids that are not present in the index.
 */
export function evidenceForEventIds(eventIds = [], evidenceIndex = new Map()) {
  return eventIds.map((id) => evidenceIndex.get(id)).filter(Boolean);
}