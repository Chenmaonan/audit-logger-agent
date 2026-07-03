import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisualization } from '../../src/auditReview/visualization.js';

function fakeStore() {
  const finding = {
    finding_id: 'f1',
    review_id: 'r1',
    severity: 'high',
    category: 'high_risk_permission',
    status: 'open',
    title: '高危删除操作',
    summary: '检测到删除工具调用。',
    recommendation: '确认删除操作已授权。',
    agent_id: 'agent-test',
    tool_name: 'db.delete',
    trace_id: 'trace-del-1',
    evidence: [{
      event_id: 1,
      agent_id: 'agent-test',
      agent_name: '测试 Agent',
      tool_name: 'db.delete',
      trace_id: 'trace-del-1',
      span_id: 'span-del-1',
      log_detail: {
        ts: '2026-07-03T10:00:00.000Z',
        event: 'tool.end',
        status: 'ok',
        result_summary: 'deleted 5 rows',
        error_message: null,
      },
    }],
    last_seen_at: '2026-07-03T10:00:00.000Z',
  };

  return {
    listFindings({ severity, status, reviewId } = {}) {
      if (reviewId && reviewId !== 'r1') return [];
      if (severity && severity !== finding.severity) return [];
      if (status && status !== finding.status) return [];
      return [finding];
    },
    listRuns() {
      return [{
        review_id: 'r1',
        status: 'completed',
        window_from: '2026-07-03T09:30:00.000Z',
        window_to: '2026-07-03T10:00:00.000Z',
        finding_count: 1,
      }];
    },
    getRun(id) {
      return id === 'r1' ? this.listRuns()[0] : null;
    },
    getFinding(id) {
      return id === 'f1' ? finding : null;
    },
    listDeadLetterCount() {
      return 0;
    },
  };
}

test('overviewPage uses Chinese labels and hides empty dead-letter data', () => {
  const viz = createVisualization({ reviewStore: fakeStore(), config: { auditReview: { visualization: {} } } });
  const page = viz.overviewPage();
  assert.equal(page.page.title, '审计审查总览');
  assert.ok(page.summary_metrics.some((metric) => metric.label === '高风险' && metric.value === 1));
  assert.equal(page.summary_metrics.some((metric) => metric.label === 'Dead Letters'), false);
});

test('findingDetailPage includes evidence rows and no confidence metric', () => {
  const viz = createVisualization({ reviewStore: fakeStore(), config: { auditReview: { visualization: {} } } });
  const page = viz.findingDetailPage('f1');
  assert.equal(page.summary_metrics.some((metric) => metric.label === '置信度'), false);
  const evidenceSection = page.sections.find((section) => section.id === 'evidence_events');
  assert.ok(evidenceSection);
  assert.equal(evidenceSection.rows[0].agent_name, '测试 Agent');
  assert.equal(evidenceSection.rows[0].result_summary, 'deleted 5 rows');
});