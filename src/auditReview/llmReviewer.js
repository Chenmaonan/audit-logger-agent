// LLM structured review layer for v1.4 audit review.
// See v1.4 PERIODIC_LLM_AUDIT_REVIEW_DESIGN.md sections 6.5, 6.6, 6.7, 6.8.

import { reviewJsonSchema, validateReview, REVIEW_CATEGORIES, SEVERITIES } from './reviewSchema.js';

const SYSTEM_PROMPT = [
  'You are the audit reviewer for an audit-log agent.',
  'Return ONLY a JSON object matching the structured-output contract. No prose, no markdown fences, no commentary.',
  'Top-level fields: "type" (exactly "audit_review"), "review_id", "window" {from,to}, "summary" {title,overview,severity_counts}, "findings" array.',
  `Severity values (use exactly these): ${SEVERITIES.map((s) => JSON.stringify(s)).join(', ')}.`,
  `Category values (use exactly these): ${REVIEW_CATEGORIES.map((c) => JSON.stringify(c)).join(', ')}.`,
  'Each finding MUST have: category, severity, agent_id, tool_name, trace_id, product_id (strings or null), title, summary (<=200 chars), recommendation, evidence_event_ids (array of integers referencing provided candidate event ids), requires_action (boolean).',
  'Duties:',
  '- Merge duplicate candidates that describe the same underlying issue into a single finding.',
  '- Assign severity based on evidence and context (trace, agent, tool, error).',
  '- Do not output confidence, probability, or calibration fields.',
  '- Give a concise one-line title for each finding.',
  '- Summary must be <= 200 chars, describing the issue and evidence.',
  '- Recommendation must be actionable and <= 200 chars.',
  '- evidence_event_ids MUST reference only the event ids provided in the candidates. NEVER invent event ids.',
  '- requires_action=true when the finding needs immediate human attention.',
  '- severity_counts in summary must reflect the count of findings at each severity.',
  'You do NOT execute tools, modify databases, or send notifications. You only produce the structured review JSON.',
].join('\n');

function buildInput({ reviewId, window, candidates }) {
  const userPayload = {
    review_id: reviewId,
    window,
    candidates: candidates.map((c) => ({
      event_id: c.event_id,
      ts: c.ts,
      agent_id: c.agent_id,
      tool_name: c.tool_name,
      event: c.event,
      status: c.status,
      duration_ms: c.duration_ms,
      trace_id: c.trace_id,
      span_id: c.span_id,
      product_id: c.product_id,
      error_code: c.error_code,
      error_message: c.error_message,
      result_summary: c.result_summary,
      category: c.category,
      reason: c.reason,
    })),
  };

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(userPayload) },
  ];
}

export function createLlmReviewer({
  llmClient,
  model,
  promptVersion = 'audit-review-prompt-v1',
  reviewerVersion = 'audit-reviewer-v1',
} = {}) {
  if (!llmClient) throw new Error('createLlmReviewer: llmClient is required');
  if (!model) throw new Error('createLlmReviewer: model is required');

  async function review({ reviewId, window, candidates, reviewStore }) {
    // reviewStore is accepted for future use but must never be called by the reviewer.
    void reviewStore;

    const input = buildInput({ reviewId, window, candidates });

    let raw;
    try {
      raw = await llmClient.createStructuredResponse({
        model,
        input,
        schema: reviewJsonSchema(),
      });
    } catch (err) {
      return { ok: false, degraded: true, error: err?.message ?? String(err) };
    }

    const result = validateReview(raw);
    if (!result.ok) {
      return { ok: false, degraded: true, error: result.error.message };
    }

    return { ok: true, review: result.review, degraded: false };
  }

  return { review, promptVersion, reviewerVersion };
}

export { SYSTEM_PROMPT };