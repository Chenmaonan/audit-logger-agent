import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisualization } from '../../src/auditReview/visualization.js';

function fakeStore() {
  const findings = [
    {
      finding_id: 'f-critical',
      review_id: 'r-degraded',
      severity: 'critical',
      category: 'failed_call',
      status: 'open',
      title: 'Critical database deletion',
      summary: '检测到关键删除操作，且返回异常。',
      recommendation: '立即核查操作来源并回滚未授权变更。',
      agent_id: 'agent-critical',
      agent_name: '测试 Agent',
      tool_name: 'db.delete',
      trace_id: 'trace-critical-1',
      product_id: 'product-1',
      last_seen_at: '2026-07-03T10:29:00.000Z',
      evidence: [
        {
          event_id: 1,
          agent_id: 'agent-critical',
          agent_name: '测试 Agent',
          tool_name: 'db.delete',
          trace_id: 'trace-critical-1',
          span_id: 'span-critical-1',
          log_detail: {
            ts: '2026-07-03T10:28:00.000Z',
            event: 'tool.start',
            status: 'ok',
            result_summary: 'delete requested',
            error_message: null,
          },
        },
        {
          event_id: 2,
          agent_id: 'agent-critical',
          agent_name: '测试 Agent',
          tool_name: 'db.delete',
          trace_id: 'trace-critical-1',
          span_id: 'span-critical-2',
          log_detail: {
            ts: '2026-07-03T10:29:00.000Z',
            event: 'tool.end',
            status: 'error',
            result_summary: 'delete failed after partial mutation',
            error_message: 'permission denied',
          },
        },
      ],
    },
    {
      finding_id: 'f-medium',
      review_id: 'r-old',
      severity: 'medium',
      category: 'anomalous_call',
      status: 'open',
      title: 'Unusual export pattern',
      summary: '检测到非常规导出行为。',
      recommendation: '',
      agent_id: 'agent-medium',
      agent_name: '巡检 Agent',
      tool_name: 'export.run',
      trace_id: 'trace-medium-1',
      product_id: 'product-2',
      last_seen_at: '2026-07-03T08:20:00.000Z',
      evidence: [
        {
          event_id: 3,
          agent_id: 'agent-medium',
          agent_name: '巡检 Agent',
          tool_name: 'export.run',
          trace_id: 'trace-medium-1',
          span_id: 'span-medium-1',
          log_detail: {
            ts: '2026-07-03T08:20:00.000Z',
            event: 'tool.end',
            status: 'ok',
            result_summary: 'export completed',
            error_message: null,
          },
        },
      ],
    },
    {
      finding_id: 'f-high-ack',
      review_id: 'r-degraded',
      severity: 'high',
      category: 'high_risk_permission',
      status: 'acknowledged',
      title: 'Privileged role escalation',
      summary: '检测到高危权限升级。',
      recommendation: '确认是否为计划内提权。',
      agent_id: 'agent-high',
      agent_name: '权限 Agent',
      tool_name: 'iam.grant',
      trace_id: 'trace-high-1',
      product_id: 'product-3',
      last_seen_at: '2026-07-03T10:10:00.000Z',
      evidence: [
        {
          event_id: 4,
          agent_id: 'agent-high',
          agent_name: '权限 Agent',
          tool_name: 'iam.grant',
          trace_id: 'trace-high-1',
          span_id: 'span-high-1',
          log_detail: {
            ts: '2026-07-03T10:10:00.000Z',
            event: 'tool.end',
            status: 'ok',
            result_summary: 'grant executed',
            error_message: null,
          },
        },
      ],
    },
  ];

  const runs = [
    {
      review_id: 'r-degraded',
      status: 'completed_degraded',
      window_from: '2026-07-03T10:00:00.000Z',
      window_to: '2026-07-03T10:30:00.000Z',
      finding_count: 2,
      trigger_type: 'manual',
      finished_at: '2026-07-03T10:31:00.000Z',
      scanned_files: 12,
      candidate_event_count: 34,
      risk_policy_version: '1.5.0',
      prompt_version: 'prompt-v2',
      reviewer_version: 'reviewer-v1',
      llm_model: 'claude-sonnet-5',
      error_code: 'PARTIAL_LOGS',
      error_message: '部分日志缺失，已使用降级结果。',
    },
    {
      review_id: 'r-clean',
      status: 'completed',
      window_from: '2026-07-03T09:00:00.000Z',
      window_to: '2026-07-03T09:30:00.000Z',
      finding_count: 0,
      trigger_type: 'scheduled',
      finished_at: '2026-07-03T09:31:00.000Z',
      scanned_files: 8,
      candidate_event_count: 20,
    },
    {
      review_id: 'r-old',
      status: 'completed',
      window_from: '2026-07-03T08:00:00.000Z',
      window_to: '2026-07-03T08:30:00.000Z',
      finding_count: 1,
      trigger_type: 'scheduled',
      finished_at: '2026-07-03T08:31:00.000Z',
      scanned_files: 9,
      candidate_event_count: 16,
    },
  ];

  return {
    listFindings({ severity, status, reviewId, limit } = {}) {
      let rows = findings.slice();
      if (reviewId) rows = rows.filter((finding) => finding.review_id === reviewId);
      if (severity) rows = rows.filter((finding) => finding.severity === severity);
      if (status) rows = rows.filter((finding) => finding.status === status);
      return typeof limit === 'number' ? rows.slice(0, limit) : rows;
    },
    listRuns({ limit } = {}) {
      return typeof limit === 'number' ? runs.slice(0, limit) : runs.slice();
    },
    getRun(id) {
      return runs.find((run) => run.review_id === id) ?? null;
    },
    getFinding(id) {
      return findings.find((finding) => finding.finding_id === id) ?? null;
    },
    listDeadLetterCount() {
      return 0;
    },
  };
}

function createViz() {
  return createVisualization({
    reviewStore: fakeStore(),
    config: { auditReview: { visualization: { dashboardPath: '/dashboard' } } },
  });
}

test('overviewPage uses Chinese labels and hides empty dead-letter data', () => {
  const page = createViz().overviewPage();
  assert.equal(page.page.title, '审计审查总览');
  assert.ok(page.summary_metrics.some((metric) => metric.label === '高风险'));
  assert.equal(page.summary_metrics.some((metric) => metric.label === 'Dead Letters'), false);
  assert.equal(page.sections.some((section) => section.id === 'dead_letters'), false);
});

test('overviewPage adds actions links split sections and clickable finding rows', () => {
  const page = createViz().overviewPage();

  assert.ok(Array.isArray(page.page.page_actions));
  assert.ok(page.page.page_actions.length >= 1);
  assert.ok(page.page.page_actions[0].href.includes('/dashboard/audit-reviews/'));

  const findingsSection = page.sections.find((section) => section.id === 'pending_findings');
  assert.ok(findingsSection);
  assert.equal(findingsSection.title, '待处理风险发现');
  assert.match(findingsSection.rows[0].title.href, /\/dashboard\/audit-findings\//);
  assert.match(findingsSection.rows[0].review_id.href, /\/dashboard\/audit-reviews\//);

  const reviewsWithFindings = page.sections.find((section) => section.id === 'reviews_with_findings');
  const reviewsWithoutFindings = page.sections.find((section) => section.id === 'reviews_without_findings');
  assert.ok(reviewsWithFindings);
  assert.ok(reviewsWithoutFindings);
  assert.deepEqual(reviewsWithFindings.rows.map((row) => row.review_id.text), ['r-degraded', 'r-old']);
  assert.deepEqual(reviewsWithoutFindings.rows.map((row) => row.review_id.text), ['r-clean']);

  const severityMetrics = page.summary_metrics.filter((metric) => ['严重', '高风险', '中风险', '低风险'].includes(metric.label));
  assert.ok(severityMetrics.length >= 1);
  assert.ok(severityMetrics.every((metric) => typeof metric.href === 'string' && metric.href.includes('#pending_findings')));
});

test('reviewDetailPage links finding rows and shows degraded callout', () => {
  const page = createViz().reviewDetailPage('r-degraded');

  assert.equal(page.page.title, '审查批次');
  assert.equal(page.page.subtitle, '2026-07-03T10:00:00.000Z ~ 2026-07-03T10:30:00.000Z');
  assert.ok(page.page.page_actions.some((action) => action.label === '返回总览' && action.href === '/dashboard'));

  const findingsSection = page.sections.find((section) => section.id === 'review_findings');
  assert.ok(findingsSection);
  assert.match(findingsSection.rows[0].title.href, /\/dashboard\/audit-findings\//);
  assert.equal(typeof findingsSection.rows[0].evidence_count, 'object');

  const degradedCallout = page.sections.find((section) => section.type === 'callout' && section.title === '降级完成说明');
  assert.ok(degradedCallout);
});

test('findingDetailPage includes breadcrumbs summary callouts and overview navigation', () => {
  const page = createViz().findingDetailPage('f-critical');

  assert.equal(page.summary_metrics.some((metric) => metric.label === '置信度'), false);
  assert.equal(page.page.breadcrumbs[0].label, '总览');
  assert.equal(page.page.breadcrumbs[0].href, '/dashboard');
  assert.equal(page.page.breadcrumbs[1].label, '审查批次');
  assert.match(page.page.breadcrumbs[1].href, /\/dashboard\/audit-reviews\//);
  assert.ok(page.page.page_actions.some((action) => action.label === '返回总览' && action.href === '/dashboard'));

  const summarySection = page.sections.find((section) => section.id === 'finding_summary');
  const recommendationSection = page.sections.find((section) => section.id === 'recommendation');
  assert.ok(summarySection);
  assert.equal(summarySection.body, '检测到关键删除操作，且返回异常。');
  assert.ok(recommendationSection);

  const evidenceSection = page.sections.find((section) => section.id === 'evidence_events');
  assert.ok(evidenceSection);
  assert.equal(evidenceSection.rows[0].agent_name, '测试 Agent');
  assert.equal(evidenceSection.rows[1].result_summary, 'delete failed after partial mutation');

  const linkSection = page.sections.find((section) => section.type === 'link_list');
  assert.ok(linkSection.links.some((link) => link.href === '/dashboard'));
});

test('visualization view models remain server-renderable data only', () => {
  const viz = createViz();
  const payload = JSON.stringify([
    viz.overviewPage(),
    viz.reviewDetailPage('r-degraded'),
    viz.findingDetailPage('f-critical'),
  ]);

  assert.equal(payload.includes('fetch('), false);
  assert.equal(payload.includes('<script'), false);
});
