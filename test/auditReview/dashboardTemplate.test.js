import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDashboard, renderOverviewHtml } from '../../src/auditReview/dashboardTemplate.js';

const sampleInput = {
  page: { title: '审计审查 Dashboard', subtitle: '最近审查风险概览', updated_at: '2026-07-03T10:30:00.000Z' },
  summary_metrics: [
    { label: 'Critical', value: 0, tone: 'critical' },
    { label: 'High', value: 3, tone: 'high' },
    { label: 'Medium', value: 5, tone: 'medium' },
    { label: 'Low', value: 2, tone: 'low' },
  ],
  filters: [
    { id: 'severity', type: 'select', label: 'Severity' },
    { id: 'agent_id', type: 'select', label: 'Agent' },
  ],
  sections: [
    { id: 'latest_findings', title: '最新风险', type: 'table', data_source: '/v1/audit-findings?limit=20' },
  ],
};

test('renderDashboard returns a complete HTML string', () => {
  const html = renderDashboard(sampleInput);
  assert.equal(typeof html, 'string');
  assert.ok(html.toLowerCase().includes('<html'), 'should contain <html');
  assert.ok(html.includes('Severity'), 'should contain Severity');
  assert.ok(html.includes(sampleInput.page.title), 'should contain the page title');
  assert.ok(html.includes('<!DOCTYPE html>'), 'should be a complete doctype document');
  assert.ok(html.includes('<style>'), 'should have inline css');
});

test('renderOverviewHtml is an alias for renderDashboard', () => {
  const html = renderOverviewHtml(sampleInput);
  assert.equal(html, renderDashboard(sampleInput));
});

test('renderDashboard renders metric values and legend', () => {
  const html = renderDashboard(sampleInput);
  assert.ok(html.includes('Critical'), 'should render Critical legend');
  assert.ok(html.includes('High'), 'should render High legend');
});

test('renderDashboard renders empty state when sections is empty', () => {
  const html = renderDashboard({ page: { title: 'Empty' }, summary_metrics: [], filters: [], sections: [] });
  assert.ok(html.includes('empty-state'), 'should render empty state');
});