import test from 'node:test';
import assert from 'node:assert/strict';
import { agentDisplayName, buildEvidenceDetail, buildEvidenceIndex, evidenceForEventIds } from '../../src/auditReview/evidence.js';

test('agentDisplayName prefers configured displayName and falls back to agent_id', () => {
  const config = { agents: { 'mt-agent': { displayName: 'MT 审计 Agent' } } };
  assert.equal(agentDisplayName('mt-agent', config), 'MT 审计 Agent');
  assert.equal(agentDisplayName('unknown-agent', config), 'unknown-agent');
});

test('buildEvidenceDetail includes agent name and log detail fields', () => {
  const detail = buildEvidenceDetail({
    event_id: 12,
    ts: '2026-07-03T10:00:00.000Z',
    agent_id: 'mt-agent',
    tool_name: 'db.delete',
    trace_id: 'trace-1',
    span_id: 'span-1',
    event: 'tool.end',
    status: 'OK',
    duration_ms: 120,
    entity_type: 'document',
    entity_id: 'product-1',
    result_summary: 'deleted 5 rows',
    error_message: null,
    reason: 'tool_name matches high-risk pattern',
  }, { agents: { 'mt-agent': { displayName: 'MT 审计 Agent' } } });

  assert.equal(detail.event_id, 12);
  assert.equal(detail.agent_id, 'mt-agent');
  assert.equal(detail.agent_name, 'MT 审计 Agent');
  assert.equal(detail.log_detail.result_summary, 'deleted 5 rows');
  assert.equal(Object.prototype.hasOwnProperty.call(detail, 'raw_json'), false);
});

test('evidenceForEventIds preserves event id order and skips unknown ids', () => {
  const index = buildEvidenceIndex([
    { event_id: 2, agent_id: 'a', result_summary: 'second' },
    { event_id: 1, agent_id: 'a', result_summary: 'first' },
  ]);
  const evidence = evidenceForEventIds([1, 2, 999], index);
  assert.deepEqual(evidence.map((item) => item.event_id), [1, 2]);
});
