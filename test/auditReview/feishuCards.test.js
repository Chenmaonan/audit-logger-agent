import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEISHU_WEBHOOK_MAX_BYTES,
  buildDailyReportPayloads,
  buildHighRiskAlertPayloads,
  feishuPayloadBytes,
  groupHighRiskFindings,
  sanitizeFeishuText,
} from '../../src/auditReview/feishuCards.js';

test('groupHighRiskFindings never crosses agent_id or trace_id boundaries', () => {
  const groups = groupHighRiskFindings([
    { severity: 'high', agent_id: 'a1', trace_id: 't1', title: '1', summary: '1' },
    { severity: 'critical', agent_id: 'a1', trace_id: 't1', title: '2', summary: '2' },
    { severity: 'high', agent_id: 'a1', trace_id: 't2', title: '3', summary: '3' },
    { severity: 'high', agent_id: 'a2', trace_id: 't1', title: '4', summary: '4' },
    { severity: 'medium', agent_id: 'a1', trace_id: 't1', title: 'skip', summary: 'skip' },
  ]);

  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((group) => [group.agentId, group.traceId, group.findings.length]), [
    ['a1', 't1', 2],
    ['a1', 't2', 1],
    ['a2', 't1', 1],
  ]);
});

test('groupHighRiskFindings isolates findings with incomplete identity', () => {
  const groups = groupHighRiskFindings([
    { finding_id: 'f-null-1', severity: 'high', agent_id: null, trace_id: null, title: '1', summary: '1' },
    { finding_id: 'f-null-2', severity: 'critical', agent_id: null, trace_id: null, title: '2', summary: '2' },
    { finding_id: 'f-partial-1', severity: 'high', agent_id: 'a1', trace_id: null, title: '3', summary: '3' },
    { finding_id: 'f-partial-2', severity: 'high', agent_id: 'a1', trace_id: null, title: '4', summary: '4' },
  ]);

  assert.equal(groups.length, 4);
  assert.ok(groups.every((group) => group.findings.length === 1));
});

test('high-risk card uses JSON 2.0, folds long detail, and excludes raw evidence', () => {
  const payloads = buildHighRiskAlertPayloads({
    reviewId: 'review-1',
    window: { from: '2026-07-17T00:00:00.000Z', to: '2026-07-17T00:30:00.000Z' },
    agentId: 'agent-1',
    traceId: 'trace-1',
    findings: [
      { severity: 'high', title: '危险写入', summary: '摘要 A', evidence: [{ raw_json: 'SECRET' }] },
      { severity: 'critical', title: '权限提升', summary: '摘要 B', evidence: [{ raw_json: 'SECRET' }] },
      { severity: 'high', title: '删除调用', summary: '摘要 C', evidence: [{ raw_json: 'SECRET' }] },
    ],
    foldThresholdChars: 1,
  });

  assert.equal(payloads.length, 1);
  const payload = payloads[0];
  assert.equal(payload.msg_type, 'interactive');
  assert.equal(payload.card.schema, '2.0');
  assert.equal(payload.card.header.template, 'carmine');
  assert.ok(payload.card.body.elements.some((element) => element.tag === 'collapsible_panel' && element.expanded === false));
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /"tag":"note"/);
  assert.match(serialized, /"text_size":"notation"/);
  for (const expected of ['危险写入', '摘要 A', '权限提升', '摘要 B', '删除调用', '摘要 C']) {
    assert.match(serialized, new RegExp(expected));
  }
  assert.doesNotMatch(serialized, /SECRET|raw_json|evidence/);
});

test('oversized high-risk content is split within one agent/trace and every payload stays below 20 KiB', () => {
  const findings = Array.from({ length: 30 }, (_, index) => ({
    severity: 'high',
    title: `风险-${index}`,
    summary: `摘要-${index}-` + '长内容'.repeat(350),
  }));
  const payloads = buildHighRiskAlertPayloads({
    reviewId: 'review-large',
    window: { from: 'a', to: 'b' },
    agentId: 'agent-large',
    traceId: 'trace-large',
    findings,
    maxPayloadBytes: 19 * 1024,
    foldThresholdChars: 1,
  });

  assert.ok(payloads.length > 1);
  for (const payload of payloads) {
    assert.ok(feishuPayloadBytes(payload) <= 19 * 1024);
    assert.ok(feishuPayloadBytes(payload) < FEISHU_WEBHOOK_MAX_BYTES);
    assert.match(JSON.stringify(payload), /agent-large/);
    assert.match(JSON.stringify(payload), /trace-large/);
  }
  const all = JSON.stringify(payloads);
  findings.forEach((finding) => assert.match(all, new RegExp(finding.title)));
});

test('sanitization neutralizes Feishu mention and link markup from untrusted logs', () => {
  const sanitized = sanitizeFeishuText('<at id=all></at> [click](https://example.com)');
  assert.doesNotMatch(sanitized, /<at|\[click\]/);
  assert.match(sanitized, /＜at id=all＞/);
});

test('daily report card keeps one group identity and folds detailed tool/risk rows', () => {
  const payloads = buildDailyReportPayloads({
    date: '2026-07-17',
    generatedAt: '2026-07-17T02:00:00.000Z',
    group: {
      agent_id: 'agent-daily',
      trace_id: 'trace-daily',
      event_count: 12,
      error_count: 2,
      tool_count: 2,
      tools: [
        { tool_name: 'db.read', total: 8, error_count: 0 },
        { tool_name: 'db.write', total: 4, error_count: 2 },
      ],
      findings: [{ severity: 'high', title: '写入异常', summary: '连续失败' }],
    },
    foldThresholdChars: 1,
  });

  assert.equal(payloads.length, 1);
  const serialized = JSON.stringify(payloads[0]);
  assert.match(serialized, /agent-daily/);
  assert.match(serialized, /trace-daily/);
  assert.match(serialized, /db\.read/);
  assert.match(serialized, /写入异常/);
  assert.doesNotMatch(serialized, /"tag":"note"/);
  assert.ok(payloads[0].card.body.elements.some((element) => element.tag === 'collapsible_panel'));
});
