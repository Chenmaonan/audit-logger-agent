// LLM audit-review output schema and local validation.
// See v1.4 PERIODIC_LLM_AUDIT_REVIEW_DESIGN.md sections 6.2, 6.3, 6.7.

export const REVIEW_CATEGORIES = [
  'high_risk_permission',
  'anomalous_call',
  'repeated_call',
  'failed_call',
  'trace_integrity',
  'ingest_parse_error',
];

export const SEVERITIES = ['critical', 'high', 'medium', 'low'];

const MAX_TEXT_LEN = 300;

function isString(v) {
  return typeof v === 'string';
}

function invalid(message) {
  return { ok: false, error: Object.assign(new Error(message), { code: 'invalid_audit_review' }) };
}

export function validateReview(review) {
  if (!review || typeof review !== 'object') return invalid('review must be an object');
  if (review.type !== 'audit_review') return invalid(`review.type must be 'audit_review', got ${String(review.type)}`);

  if (!isString(review.review_id) || review.review_id.trim() === '') return invalid('review.review_id is required');

  const window = review.window;
  if (!window || typeof window !== 'object') return invalid('review.window is required');
  if (!isString(window.from) || window.from.trim() === '') return invalid('review.window.from is required');
  if (!isString(window.to) || window.to.trim() === '') return invalid('review.window.to is required');

  const summary = review.summary;
  if (!summary || typeof summary !== 'object') return invalid('review.summary is required');
  if (!isString(summary.title) || summary.title.length > MAX_TEXT_LEN) return invalid('review.summary.title is required and must be <= 300 chars');
  if (!isString(summary.overview) || summary.overview.length > MAX_TEXT_LEN) return invalid('review.summary.overview is required and must be <= 300 chars');
  if (!summary.severity_counts || typeof summary.severity_counts !== 'object') return invalid('review.summary.severity_counts is required');
  for (const sev of SEVERITIES) {
    const c = summary.severity_counts[sev];
    if (c == null) return invalid(`review.summary.severity_counts.${sev} is required`);
    if (!Number.isInteger(c) || c < 0) return invalid(`review.summary.severity_counts.${sev} must be a non-negative integer`);
  }

  if (!Array.isArray(review.findings)) return invalid('review.findings must be an array');
  for (let i = 0; i < review.findings.length; i++) {
    const f = review.findings[i];
    const ctx = `findings[${i}]`;
    if (!f || typeof f !== 'object') return invalid(`${ctx} must be an object`);

    if (!REVIEW_CATEGORIES.includes(f.category)) return invalid(`${ctx}.category must be one of ${REVIEW_CATEGORIES.join(', ')}`);
    if (!SEVERITIES.includes(f.severity)) return invalid(`${ctx}.severity must be one of ${SEVERITIES.join(', ')}`);

    if (Object.prototype.hasOwnProperty.call(f, 'confidence')) {
      return invalid(`${ctx}.confidence has been removed in v1.5`);
    }

    if (!isString(f.agent_id) && f.agent_id != null) return invalid(`${ctx}.agent_id must be a string or null/omitted`);
    if (!isString(f.tool_name) && f.tool_name != null) return invalid(`${ctx}.tool_name must be a string or null/omitted`);
    if (!isString(f.trace_id) && f.trace_id != null) return invalid(`${ctx}.trace_id must be a string or null/omitted`);
    if (Object.prototype.hasOwnProperty.call(f, 'product_id')) {
      return invalid(`${ctx}.product_id has been removed; use entity`);
    }
    if (f.entity != null) {
      if (typeof f.entity !== 'object' || Array.isArray(f.entity)) return invalid(`${ctx}.entity must be an object or null/omitted`);
      if (!isString(f.entity.type) || f.entity.type.trim() === '') return invalid(`${ctx}.entity.type is required`);
      if (!isString(f.entity.id) || f.entity.id.trim() === '') return invalid(`${ctx}.entity.id is required`);
    }

    if (!isString(f.title) || f.title.length > MAX_TEXT_LEN) return invalid(`${ctx}.title is required and must be <= 300 chars`);
    if (!isString(f.summary) || f.summary.length > MAX_TEXT_LEN) return invalid(`${ctx}.summary is required and must be <= 300 chars`);
    if (!isString(f.recommendation) || f.recommendation.length > MAX_TEXT_LEN) return invalid(`${ctx}.recommendation is required and must be <= 300 chars`);

    if (!Array.isArray(f.evidence_event_ids)) return invalid(`${ctx}.evidence_event_ids must be an array`);
    for (let j = 0; j < f.evidence_event_ids.length; j++) {
      const id = f.evidence_event_ids[j];
      if (!Number.isInteger(id)) return invalid(`${ctx}.evidence_event_ids[${j}] must be an integer`);
    }

    if (typeof f.requires_action !== 'boolean') return invalid(`${ctx}.requires_action must be a boolean`);
  }

  return { ok: true, review };
}

export function reviewJsonSchema() {
  return {
    type: 'json_schema',
    name: 'audit_review',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: ['audit_review'] },
        review_id: { type: 'string', minLength: 1 },
        window: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
          },
          required: ['from', 'to'],
        },
        summary: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', maxLength: MAX_TEXT_LEN },
            overview: { type: 'string', maxLength: MAX_TEXT_LEN },
            severity_counts: {
              type: 'object',
              additionalProperties: false,
              properties: {
                critical: { type: 'integer', minimum: 0 },
                high: { type: 'integer', minimum: 0 },
                medium: { type: 'integer', minimum: 0 },
                low: { type: 'integer', minimum: 0 },
              },
              required: ['critical', 'high', 'medium', 'low'],
            },
          },
          required: ['title', 'overview', 'severity_counts'],
        },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              category: { type: 'string', enum: REVIEW_CATEGORIES },
              severity: { type: 'string', enum: SEVERITIES },
              agent_id: { type: ['string', 'null'] },
              tool_name: { type: ['string', 'null'] },
              trace_id: { type: ['string', 'null'] },
              entity: {
                type: ['object', 'null'],
                additionalProperties: false,
                properties: {
                  type: { type: 'string' },
                  id: { type: 'string' },
                },
                required: ['type', 'id'],
              },
              title: { type: 'string', maxLength: MAX_TEXT_LEN },
              summary: { type: 'string', maxLength: MAX_TEXT_LEN },
              recommendation: { type: 'string', maxLength: MAX_TEXT_LEN },
              evidence_event_ids: { type: 'array', items: { type: 'integer' } },
              requires_action: { type: 'boolean' },
            },
            required: [
              'category',
              'severity',
              'agent_id',
              'tool_name',
              'trace_id',
              'entity',
              'title',
              'summary',
              'recommendation',
              'evidence_event_ids',
              'requires_action',
            ],
          },
        },
      },
      required: ['type', 'review_id', 'window', 'summary', 'findings'],
    },
  };
}
