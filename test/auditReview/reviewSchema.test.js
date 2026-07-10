import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReview, reviewJsonSchema, REVIEW_CATEGORIES, SEVERITIES } from '../../src/auditReview/reviewSchema.js';

function goodReview() {
  return {
    type: 'audit_review',
    review_id: 'review-1',
    window: { from: '2026-07-03T10:00:00.000Z', to: '2026-07-03T10:30:00.000Z' },
    summary: {
      title: '审查发现 3 个高风险问题',
      overview: '过去 30 分钟共审查 128 条事件。',
      severity_counts: { critical: 0, high: 3, medium: 5, low: 2 },
    },
    findings: [
      {
        category: 'failed_call',
        severity: 'high',
        agent_id: 'mt-agent',
        tool_name: 'publicTraffic.runReport',
        trace_id: 'trace-1',
        entity: { type: 'product', id: 'prod-1' },
        title: '连续失败',
        summary: '10 分钟内同一工具失败 5 次。',
        recommendation: '检查上游服务可用性。',
        evidence_event_ids: [123, 124, 125],
        requires_action: true,
      },
    ],
  };
}

test('validateReview accepts a well-formed review', () => {
  const result = validateReview(goodReview());
  assert.equal(result.ok, true);
  assert.equal(result.review.type, 'audit_review');
});

test('validateReview rejects bad severity', () => {
  const r = goodReview();
  r.findings[0].severity = 'urgent';
  const result = validateReview(r);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /severity/);
});

test('validateReview rejects bad category', () => {
  const r = goodReview();
  r.findings[0].category = 'made_up';
  const result = validateReview(r);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /category/);
});

test('validateReview accepts a finding without confidence', () => {
  const r = goodReview();
  delete r.findings[0].confidence;
  const result = validateReview(r);
  assert.equal(result.ok, true);
});

test('validateReview rejects confidence because v1.5 removed the field', () => {
  const r = goodReview();
  r.findings[0].confidence = 0.92;
  const result = validateReview(r);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /confidence/);
});

test('validateReview rejects legacy product_id in finding', () => {
  const r = goodReview();
  r.findings[0].product_id = 'prod-1';
  const result = validateReview(r);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /product_id/);
});

test('validateReview rejects malformed finding entity', () => {
  const r = goodReview();
  r.findings[0].entity = { type: 'product' };
  const result = validateReview(r);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /entity/);
});

test('validateReview rejects non-integer evidence_event_ids', () => {
  const r = goodReview();
  r.findings[0].evidence_event_ids = [123, 'abc'];
  const result = validateReview(r);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /evidence_event_ids/);
});

test('validateReview rejects wrong type', () => {
  const r = goodReview();
  r.type = 'something_else';
  const result = validateReview(r);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /type/);
});

test('validateReview rejects overlong summary text', () => {
  const r = goodReview();
  r.findings[0].summary = 'x'.repeat(301);
  const result = validateReview(r);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /summary/);
});

test('REVIEW_CATEGORIES and SEVERITIES contain expected values', () => {
  assert.deepEqual(REVIEW_CATEGORIES, ['high_risk_permission', 'anomalous_call', 'repeated_call', 'failed_call', 'trace_integrity', 'ingest_parse_error']);
  assert.deepEqual(SEVERITIES, ['critical', 'high', 'medium', 'low']);
});

test('reviewJsonSchema returns an object with type json_schema and strict true', () => {
  const schema = reviewJsonSchema();
  assert.equal(schema.type, 'json_schema');
  assert.equal(schema.strict, true);
  assert.equal(schema.name, 'audit_review');
  assert.equal(schema.schema.type, 'object');
  // evidence_event_ids items should be integer
  const findingItem = schema.schema.properties.findings.items;
  assert.deepEqual(findingItem.properties.evidence_event_ids.items, { type: 'integer' });
  assert.equal(findingItem.properties.requires_action.type, 'boolean');
  assert.deepEqual(findingItem.properties.entity.type, ['object', 'null']);
  assert.deepEqual(findingItem.properties.severity.enum, SEVERITIES);
  assert.deepEqual(findingItem.properties.category.enum, REVIEW_CATEGORIES);
});
