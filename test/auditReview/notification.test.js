import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewNotifier, meetsMinSeverity } from '../../src/auditReview/notification.js';

function makeFakeOutboxStore() {
  const calls = [];
  return {
    calls,
    enqueue(event) {
      calls.push(event);
    },
  };
}

function makeRun() {
  return {
    review_id: 'review_test_1',
    window_from: '2026-07-03T10:00:00.000Z',
    window_to: '2026-07-03T10:30:00.000Z',
    status: 'completed',
    candidate_event_count: 128,
    finding_count: 2,
  };
}

function makeReview() {
  return {
    review_id: 'review_test_1',
    window: { from: '2026-07-03T10:00:00.000Z', to: '2026-07-03T10:30:00.000Z' },
    summary: {
      title: '审查发现 2 个高风险问题',
      overview: '过去 30 分钟审查 128 条事件，发现 2 个高风险。',
      severity_counts: { critical: 0, high: 2, medium: 0, low: 0 },
    },
    findings: [
      {
        finding_id: 'f1',
        category: 'failed_call',
        severity: 'high',
        confidence: 0.9,
        agent_id: 'mt-agent',
        tool_name: 'publicTraffic.runReport',
        trace_id: 'trace_1',
        title: 'publicTraffic.runReport 连续失败',
        summary: '10 分钟内失败 5 次。',
        recommendation: '检查上游服务。',
        requires_action: true,
      },
      {
        finding_id: 'f2',
        category: 'high_risk_permission',
        severity: 'high',
        confidence: 0.85,
        agent_id: 'rental-agent',
        tool_name: 'permission.grant',
        trace_id: 'trace_2',
        title: '权限提升调用',
        summary: '非预期用户执行了 permission.grant。',
        recommendation: '确认授权。',
        requires_action: true,
      },
    ],
  };
}

test('enqueue emits audit_review_summary with dashboard_url and top_findings', () => {
  const outbox = makeFakeOutboxStore();
  const notifier = createReviewNotifier({
    outboxStore: outbox,
    config: {
      auditReview: {
        notification: {
          mode: 'callback',
          callbackUrl: 'http://127.0.0.1:9999/audit-review-events',
          minSeverity: 'medium',
          sendEmptyReview: false,
        },
      },
    },
  });
  const result = notifier.enqueue({
    reviewId: 'review_test_1',
    run: makeRun(),
    review: makeReview(),
    dashboardUrl: 'http://127.0.0.1:9320/dashboard/audit-reviews/review_test_1',
  });
  assert.equal(result.enqueued, true);
  assert.equal(outbox.calls.length, 1);
  const call = outbox.calls[0];
  assert.equal(call.type, 'audit_review_summary');
  assert.equal(call.runId, 'review_test_1');
  assert.equal(call.deliveryMode, 'callback');
  assert.equal(call.callbackUrl, 'http://127.0.0.1:9999/audit-review-events');
  const payload = call.payload;
  assert.equal(payload.type, 'audit_review_summary');
  assert.equal(payload.review_id, 'review_test_1');
  assert.equal(payload.title, '审查发现 2 个高风险问题');
  assert.equal(payload.dashboard_url, 'http://127.0.0.1:9320/dashboard/audit-reviews/review_test_1');
  assert.deepEqual(payload.severity_counts, { critical: 0, high: 2, medium: 0, low: 0 });
  assert.equal(payload.top_findings.length, 2);
  assert.equal(payload.top_findings[0].finding_id, 'f1');
  assert.equal(payload.actions[0].id, 'open_dashboard');
  assert.equal(payload.actions[0].label, '打开 Dashboard');
  assert.equal(payload.actions[0].url, payload.dashboard_url);
});

test('sendEmptyReview=false skips empty review', () => {
  const outbox = makeFakeOutboxStore();
  const notifier = createReviewNotifier({
    outboxStore: outbox,
    config: { auditReview: { notification: { sendEmptyReview: false, callbackUrl: 'http://x' } } },
  });
  const emptyReview = { summary: { severity_counts: { critical: 0, high: 0, medium: 0, low: 0 }, title: '', overview: '' }, findings: [] };
  const result = notifier.enqueue({
    reviewId: 'r_empty',
    run: { window_from: 'a', window_to: 'b' },
    review: emptyReview,
    dashboardUrl: 'http://x/dash/r_empty',
  });
  assert.equal(result.enqueued, false);
  assert.equal(result.reason, 'empty');
  assert.equal(outbox.calls.length, 0);
});

test('sendEmptyReview=true enqueues even when findings empty', () => {
  const outbox = makeFakeOutboxStore();
  const notifier = createReviewNotifier({
    outboxStore: outbox,
    config: { auditReview: { notification: { sendEmptyReview: true, callbackUrl: 'http://x', minSeverity: 'low' } } },
  });
  const result = notifier.enqueue({
    reviewId: 'r_empty',
    run: { window_from: 'a', window_to: 'b' },
    review: { summary: { severity_counts: { critical: 0, high: 0, medium: 0, low: 0 }, title: '无风险', overview: 'OK' }, findings: [] },
    dashboardUrl: 'http://x/dash/r_empty',
  });
  assert.equal(result.enqueued, true);
  assert.equal(outbox.calls.length, 1);
});

test('enqueueFinding enqueues high/critical findings individually', () => {
  const outbox = makeFakeOutboxStore();
  const notifier = createReviewNotifier({
    outboxStore: outbox,
    config: { auditReview: { notification: { callbackUrl: 'http://x', minSeverity: 'medium' } } },
  });
  const finding = {
    finding_id: 'f1',
    severity: 'high',
    category: 'failed_call',
    title: '失败调用',
    summary: '失败 5 次',
    recommendation: '检查',
    agent_id: 'a',
    tool_name: 't',
    trace_id: 'tr',
    product_id: 'p',
  };
  const result = notifier.enqueueFinding({
    finding,
    reviewId: 'r1',
    run: { window_from: 'a', window_to: 'b' },
    dashboardUrl: 'http://x/dash/r1',
  });
  assert.equal(result.enqueued, true);
  assert.equal(outbox.calls.length, 1);
  assert.equal(outbox.calls[0].type, 'audit_review_finding');
  assert.equal(outbox.calls[0].payload.finding_id, 'f1');
  assert.equal(outbox.calls[0].payload.severity, 'high');
});

test('enqueueFinding skips medium findings', () => {
  const outbox = makeFakeOutboxStore();
  const notifier = createReviewNotifier({
    outboxStore: outbox,
    config: { auditReview: { notification: { callbackUrl: 'http://x' } } },
  });
  const result = notifier.enqueueFinding({
    finding: { finding_id: 'fm', severity: 'medium', category: 'x', title: 't', summary: 's' },
    reviewId: 'r1',
    run: {},
    dashboardUrl: 'http://x',
  });
  assert.equal(result.enqueued, false);
  assert.equal(result.reason, 'below_high');
});

test('meetsMinSeverity compares by index', () => {
  assert.equal(meetsMinSeverity('critical', 'low'), true);
  assert.equal(meetsMinSeverity('high', 'high'), true);
  assert.equal(meetsMinSeverity('medium', 'high'), false);
  assert.equal(meetsMinSeverity('low', 'medium'), false);
  assert.equal(meetsMinSeverity('critical', 'critical'), true);
});