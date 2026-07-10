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
      title: 'Audit review found 2 high risk findings',
      overview: 'Reviewed 128 events and found 2 high risk findings.',
      severity_counts: { critical: 0, high: 2, medium: 0, low: 0 },
    },
    findings: [
      {
        finding_id: 'f1',
        category: 'failed_call',
        severity: 'high',
        agent_id: 'mt-agent',
        tool_name: 'publicTraffic.runReport',
        trace_id: 'trace_1',
        title: 'publicTraffic.runReport failed repeatedly',
        summary: 'Failed 5 times in 10 minutes.',
        recommendation: 'Check upstream availability.',
        requires_action: true,
        evidence: [
          {
            event_id: 1,
            agent_id: 'mt-agent',
            agent_name: 'MT Audit Agent',
            tool_name: 'publicTraffic.runReport',
            trace_id: 'trace_1',
            span_id: 'span-1',
            log_detail: {
              ts: '2026-07-03T10:00:00.000Z',
              event: 'tool.end',
              status: 'INTERNAL',
              duration_ms: 120,
              entity: { type: 'product', id: 'product-1' },
              result_summary: 'failed',
              error_message: 'down',
              reason: 'repeated failure',
            },
          },
        ],
      },
      {
        finding_id: 'f2',
        category: 'high_risk_permission',
        severity: 'high',
        agent_id: 'rental-agent',
        tool_name: 'permission.grant',
        trace_id: 'trace_2',
        title: 'Permission grant call',
        summary: 'Unexpected permission.grant call.',
        recommendation: 'Confirm authorization.',
        requires_action: true,
        evidence: [
          {
            event_id: 2,
            agent_id: 'rental-agent',
            agent_name: 'Rental Agent',
            tool_name: 'permission.grant',
            trace_id: 'trace_2',
            span_id: 'span-2',
            log_detail: {
              ts: '2026-07-03T10:01:00.000Z',
              event: 'tool.end',
              status: 'OK',
              duration_ms: 50,
              entity: null,
              result_summary: 'granted',
              error_message: null,
              reason: 'high-risk permission',
            },
          },
        ],
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
  assert.equal(payload.title, 'Audit review found 2 high risk findings');
  assert.equal(payload.dashboard_url, 'http://127.0.0.1:9320/dashboard/audit-reviews/review_test_1');
  assert.deepEqual(payload.severity_counts, { critical: 0, high: 2, medium: 0, low: 0 });
  assert.equal(payload.top_findings.length, 2);
  assert.equal(payload.top_findings[0].finding_id, 'f1');
  assert.equal(Object.hasOwn(payload.top_findings[0], 'confidence'), false);
  assert.equal(payload.top_findings[0].agent_name, 'MT Audit Agent');
  assert.equal(payload.actions[0].id, 'open_dashboard');
  assert.equal(payload.actions[0].url, payload.dashboard_url);
});

test('sendEmptyReview=false skips empty review', () => {
  const outbox = makeFakeOutboxStore();
  const notifier = createReviewNotifier({
    outboxStore: outbox,
    config: { auditReview: { notification: { sendEmptyReview: false, callbackUrl: 'http://x' } } },
  });
  const emptyReview = {
    summary: { severity_counts: { critical: 0, high: 0, medium: 0, low: 0 }, title: '', overview: '' },
    findings: [],
  };
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
    review: {
      summary: { severity_counts: { critical: 0, high: 0, medium: 0, low: 0 }, title: 'No risk', overview: 'OK' },
      findings: [],
    },
    dashboardUrl: 'http://x/dash/r_empty',
  });
  assert.equal(result.enqueued, true);
  assert.equal(outbox.calls.length, 1);
});

test('notification enabled=false prevents review and finding delivery from entering the outbox', () => {
  const outbox = makeFakeOutboxStore();
  const notifier = createReviewNotifier({
    outboxStore: outbox,
    config: { auditReview: { notification: { enabled: false, callbackUrl: 'http://127.0.0.1:9999' } } },
  });

  const summaryResult = notifier.enqueue({
    reviewId: 'r_disabled',
    run: makeRun(),
    review: makeReview(),
    dashboardUrl: '/dashboard/audit-reviews/r_disabled',
  });
  const findingResult = notifier.enqueueFinding({
    finding: makeReview().findings[0],
    reviewId: 'r_disabled',
    run: makeRun(),
    dashboardUrl: '/dashboard/audit-reviews/r_disabled',
  });

  assert.deepEqual(summaryResult, { enqueued: false, reason: 'disabled' });
  assert.deepEqual(findingResult, { enqueued: false, reason: 'disabled' });
  assert.equal(outbox.calls.length, 0);
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
    title: 'Failed call',
    summary: 'Failed 5 times.',
    recommendation: 'Check service.',
    agent_id: 'mt-agent',
    tool_name: 't',
    trace_id: 'tr',
    entity: { type: 'product', id: 'p' },
    evidence: [
      {
        event_id: 1,
        agent_id: 'mt-agent',
        agent_name: 'MT Audit Agent',
        tool_name: 't',
        trace_id: 'tr',
        span_id: 's1',
        log_detail: {
          ts: '2026-07-03T10:00:00.000Z',
          event: 'tool.end',
          status: 'INTERNAL',
          duration_ms: 100,
          entity: { type: 'product', id: 'p' },
          result_summary: 'failed',
          error_message: 'down',
          reason: 'repeated',
        },
      },
    ],
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
  const payload = outbox.calls[0].payload;
  assert.equal(payload.finding_id, 'f1');
  assert.equal(payload.severity, 'high');
  assert.equal(payload.agent_name, 'MT Audit Agent');
  assert.deepEqual(payload.entity, { type: 'product', id: 'p' });
  assert.ok(Array.isArray(payload.evidence));
  assert.ok(payload.evidence.length > 0);
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
