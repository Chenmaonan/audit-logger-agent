import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDashboard } from '../../src/auditReview/dashboardTemplate.js';

test('renderDashboard renders Chinese labels, zh-CN, and no browser fetch', () => {
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

  assert.ok(html.includes('lang="zh-CN"'));
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

test('renderDashboard renders rich table cells with links, mono text, secondary text, and tone tags', () => {
  const html = renderDashboard({
    page: { title: '审计审查总览' },
    sections: [{
      id: 'reviews',
      type: 'table',
      title: '最近有发现的审查批次',
      columns: [
        { key: 'review', label: '审查批次' },
        { key: 'status', label: '状态' },
      ],
      rows: [{
        review: {
          text: 'review_<unsafe>',
          href: '/dashboard/audit-reviews/review_1?x=1&y=2',
          mono: true,
          secondary: '5 个发现',
        },
        status: {
          text: '已完成',
          tone: 'success',
        },
      }],
    }],
  });

  assert.ok(html.includes('<a href="/dashboard/audit-reviews/review_1?x=1&amp;y=2" class="cell-link mono">review_&lt;unsafe&gt;</a>'));
  assert.ok(html.includes('<div class="cell-secondary">5 个发现</div>'));
  assert.ok(html.includes('class="status-tag"'));
  assert.equal((html.match(/已完成/g) ?? []).length, 1);
});

test('renderDashboard renders summary metric cards as links only when href is present', () => {
  const html = renderDashboard({
    page: { title: '审计审查总览' },
    summary_metrics: [
      { label: '高风险', value: 3, tone: 'high', href: '/dashboard?severity=high#findings' },
      { label: '低风险', value: 1, tone: 'low' },
    ],
    sections: [{
      id: 'latest_findings',
      type: 'table',
      title: '最新风险发现',
      columns: [{ key: 'title', label: '标题' }],
      rows: [{ title: '高危删除操作' }],
    }],
  });

  assert.ok(html.includes('<a href="/dashboard?severity=high#findings" class="metric-card-link"><div class="metric-card" data-tone="high"'));
  assert.ok(html.includes('<div class="metric-card" data-tone="low"'));
  assert.equal(html.includes('<a href="" class="metric-card-link">'), false);
});

test('renderDashboard renders breadcrumbs, context badges, and page actions', () => {
  const html = renderDashboard({
    page: {
      title: '审查批次',
      subtitle: '2026-07-03 16:35 - 16:49',
      updated_at: '2026-07-03T10:30:00.000Z',
      breadcrumbs: [
        { label: '总览', href: '/dashboard' },
        { label: '审查批次' },
      ],
      context_badges: [
        { label: '开放 finding 15', tone: 'neutral' },
        { label: '降级完成', tone: 'medium' },
      ],
      page_actions: [
        { label: '返回总览', href: '/dashboard', kind: 'secondary' },
        { label: '最新有发现批次', href: '/dashboard/audit-reviews/review_1', kind: 'primary' },
      ],
    },
    sections: [{
      id: 'latest_findings',
      type: 'table',
      title: '最新风险发现',
      columns: [{ key: 'title', label: '标题' }],
      rows: [{ title: '高危删除操作' }],
    }],
  });

  assert.ok(html.includes('<nav class="breadcrumbs" aria-label="页面导航">'));
  assert.ok(html.includes('class="context-badge"'));
  assert.ok(html.includes('开放 finding 15'));
  assert.ok(html.includes('<a href="/dashboard/audit-reviews/review_1" class="page-action primary">最新有发现批次</a>'));
});

test('renderDashboard includes focus ring and row hover CSS rules', () => {
  const html = renderDashboard({
    page: { title: '审计审查总览' },
    sections: [{
      id: 'latest_findings',
      type: 'table',
      title: '最新风险发现',
      columns: [{ key: 'title', label: '标题' }],
      rows: [{ title: '高危删除操作' }],
    }],
  });

  assert.ok(html.includes(':focus-visible {'));
  assert.ok(html.includes('outline: 2px solid var(--accent);'));
  assert.ok(html.includes('.data-table tbody tr:hover { background: var(--surface-muted); }'));
});
