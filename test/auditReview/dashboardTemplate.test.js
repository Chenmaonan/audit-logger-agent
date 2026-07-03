import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDashboard } from '../../src/auditReview/dashboardTemplate.js';

test('renderDashboard renders Chinese labels and no browser fetch', () => {
  const html = renderDashboard({
    page: { title: '审计审查总览', subtitle: '最近审查与风险概览', updated_at: '2026-07-03T10:30:00.000Z' },
    summary_metrics: [{ label: '高风险', value: 3, tone: 'high' }],
    sections: [{
      id: 'latest_findings',
      type: 'table',
      title: '最新风险发现',
      columns: [{ key: 'title', label: '标题' }],
      rows: [{ title: '高危删除操作' }],
    }],
  });

  assert.ok(html.includes('审计审查总览'));
  assert.ok(html.includes('最新风险发现'));
  assert.equal(html.includes('Data source'), false);
  assert.equal(html.includes('fetch('), false);
  assert.equal(html.includes('Severity'), false);
});

test('renderDashboard hides empty metrics and empty sections', () => {
  const html = renderDashboard({
    page: { title: '审计审查总览' },
    summary_metrics: [
      { label: '严重', value: 0, tone: 'critical' },
      { label: '高风险', value: 2, tone: 'high' },
    ],
    sections: [
      { id: 'empty_table', type: 'table', title: '空表格', columns: [{ key: 'name', label: '名称' }], rows: [] },
      { id: 'detail', type: 'definition_list', title: '详情', items: [
        { label: 'Agent', value: 'mt-agent' },
        { label: '空字段', value: '' },
      ] },
    ],
  });

  assert.equal(html.includes('空表格'), false);
  assert.equal(html.includes('空字段'), false);
  assert.ok(html.includes('mt-agent'));
});