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
  assert.ok(html.includes('<a class="skip-link" href="#main-content">跳到主要内容</a>'));
  assert.ok(html.includes('<main id="main-content" class="container">'));
  assert.ok(html.includes('<h1 id="page-title" class="page-title">审计审查总览</h1>'));
  assert.ok(html.includes('<nav class="app-nav" aria-label="主导航">'));
  assert.ok(html.includes('href="/dashboard#pending_findings"'));
  assert.ok(html.includes('href="/dashboard#reviews_with_findings"'));
  assert.ok(html.includes('审计审查总览'));
  assert.ok(html.includes('最新风险发现'));
  assert.equal(html.includes('Data source'), false);
  assert.equal(html.includes('fetch('), false);
  assert.equal(html.includes('<script'), false);
  assert.equal(html.includes('<link'), false);
  assert.equal(html.includes('gradient'), false);
  assert.equal(html.includes('severity-legend'), false);
  assert.equal(html.includes('Severity'), false);
});

test('renderDashboard keeps zero metrics visible and hides only empty values and sections', () => {
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
  assert.ok(html.includes('<div class="metric-value">0</div>'));
  assert.ok(html.includes('严重'));
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

test('renderDashboard renders a continuous summary strip and links only actionable metrics', () => {
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

  assert.ok(html.includes('<section class="summary-metrics" aria-label="概要指标">'));
  assert.ok(html.includes('<a href="/dashboard?severity=high#findings" class="summary-metric-link"><div class="summary-metric" data-tone="high"'));
  assert.ok(html.includes('<div class="summary-metric" data-tone="low"'));
  assert.equal(html.includes('<a href="" class="summary-metric-link">'), false);
  assert.ok(html.includes('gap: 0;'));
});

test('renderDashboard renders safe section ids for anchor navigation', () => {
  const html = renderDashboard({
    page: { title: '审计审查总览' },
    sections: [
      {
        id: 'safe_anchor',
        type: 'table',
        title: '安全锚点',
        columns: [{ key: 'event', label: '事件' }],
        rows: [{ event: 'tool.end' }],
      },
      {
        id: 'bad" onclick="x',
        type: 'callout',
        title: '异常提示',
        body: '已转义',
      },
    ],
  });

  assert.ok(html.includes('<section id="safe_anchor" class="data-section">'));
  assert.ok(html.includes('<section id="bad&quot; onclick=&quot;x" class="data-section callout">'));
  assert.equal(html.includes('id="bad" onclick="x"'), false);
});

test('renderDashboard renders raw log snippets without parsing or splitting them', () => {
  const raw = '{"event":"tool.error","payload":{"b":2,"a":1},"text":"<unsafe>&value"}';
  const html = renderDashboard({
    page: { title: '审计审查总览' },
    sections: [{
      id: 'evidence_raw_logs',
      type: 'raw_log_list',
      title: '原始日志片段',
      snippets: [{ label: '日志 ID 7', body: raw }],
    }],
  });

  assert.ok(html.includes('<details id="evidence_raw_logs" class="data-section raw-log-section collapsible-section">'));
  assert.equal(html.includes('<details id="evidence_raw_logs" class="data-section raw-log-section collapsible-section" open>'), false);
  assert.ok(html.includes('<summary class="section-summary"><span class="section-title">原始日志片段</span>'));
  assert.ok(html.includes('<div class="raw-log-label">日志 ID 7</div>'));
  assert.ok(html.includes('<pre class="raw-log-pre"><code>'));
  assert.ok(html.includes('{&quot;event&quot;:&quot;tool.error&quot;,&quot;payload&quot;:{&quot;b&quot;:2,&quot;a&quot;:1},&quot;text&quot;:&quot;&lt;unsafe&gt;&amp;value&quot;}'));
  assert.equal(html.includes('<td>{'), false);
});

test('renderDashboard renders trace sequence and LLM analysis sections', () => {
  const html = renderDashboard({
    page: { title: '风险发现' },
    sections: [
      {
        id: 'trace_sequence',
        type: 'trace_sequence',
        title: '工具调用顺序（共 2 步）',
        steps: [
          {
            order: 1,
            timestamp: '2026-07-03T10:28:00.000Z',
            event: 'tool.start',
            status: { text: '正常', tone: 'success' },
            tool_name: 'db.delete',
            span_id: 'span-1',
            parent_span_id: '',
            duration_ms: '',
            summary: 'delete requested',
          },
          {
            order: 2,
            timestamp: '2026-07-03T10:29:00.000Z',
            event: 'tool.end',
            status: { text: '错误', tone: 'critical' },
            tool_name: 'db.delete',
            span_id: 'span-2',
            parent_span_id: 'span-1',
            duration_ms: '640 ms',
            summary: 'delete failed <unsafe>',
          },
        ],
      },
      {
        id: 'trace_llm_analysis',
        type: 'trace_analysis',
        title: 'LLM 链路分析',
        purpose: '尝试执行 db.delete 删除操作。',
        chain_summary: '先启动工具，再返回 permission denied。',
        risk_points: ['可能存在部分变更。'],
        next_actions: ['核查授权记录。'],
        model: 'test-model',
      },
    ],
  });

  assert.ok(html.includes('<section id="trace_sequence" class="data-section trace-sequence-section">'));
  assert.ok(html.includes('<ol class="trace-sequence">'));
  assert.ok(html.includes('<span class="trace-step-index">1</span>'));
  assert.ok(html.includes('db.delete'));
  assert.ok(html.includes('delete failed &lt;unsafe&gt;'));
  assert.ok(html.includes('<section id="trace_llm_analysis" class="data-section trace-analysis-section">'));
  assert.ok(html.includes('尝试执行 db.delete 删除操作。'));
  assert.ok(html.includes('可能存在部分变更。'));
  assert.ok(html.includes('test-model'));
  assert.equal(html.includes('<script'), false);
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

test('renderDashboard renders real GET filter links, active state, and clear actions', () => {
  const html = renderDashboard({
    page: {
      title: '审计审查总览',
    },
    clear_filters_href: '/dashboard?status=open',
    filters: [{
      id: 'severity',
      label: '严重级别',
      value: 'high',
      clear_href: '/dashboard?status=open',
      options: [
        { value: 'critical', label: '严重', href: '/dashboard?status=open&severity=critical' },
        { value: 'high', label: '高风险', href: '/dashboard?status=open&severity=high', active: true },
      ],
    }],
    sections: [{
      id: 'pending_findings',
      type: 'table',
      title: '待处理风险发现',
      columns: [{ key: 'title', label: '标题', priority: 'primary' }],
      rows: [{ title: '风险项' }],
    }],
  });

  assert.ok(html.includes('<nav class="filter-bar" aria-label="审计筛选">'));
  assert.ok(html.includes('href="/dashboard?status=open&amp;severity=high" class="filter-option active" aria-current="true">高风险</a>'));
  assert.ok(html.includes('href="/dashboard?status=open" class="filter-clear">清除严重级别</a>'));
  assert.ok(html.includes('href="/dashboard?status=open" class="filter-clear-all">清除全部筛选</a>'));
  assert.equal(html.includes('<select'), false);
  assert.equal(html.includes('disabled'), false);
});

test('renderDashboard adds scoped responsive column classes from safe keys and priorities', () => {
  const html = renderDashboard({
    page: { title: '审计审查总览' },
    sections: [{
      id: 'pending_findings',
      type: 'table',
      title: '待处理风险发现',
      columns: [
        { key: 'title', label: '标题', priority: 'primary' },
        { key: 'agent_name', label: 'Agent', priority: 'secondary' },
        { key: 'trace id onclick=x', label: 'Trace ID', priority: 'metadata' },
      ],
      rows: [{ title: '风险项', agent_name: 'agent-1', 'trace id onclick=x': 'trace-1' }],
    }],
  });

  assert.ok(html.includes('<th scope="col" class="column-title column-priority-primary">标题</th>'));
  assert.ok(html.includes('<td class="column-agent_name column-priority-secondary">agent-1</td>'));
  assert.ok(html.includes('<th scope="col" class="column-trace-id-onclick-x column-priority-metadata">Trace ID</th>'));
  assert.equal(html.includes('class="column-trace id onclick=x'), false);
});

test('renderDashboard supports collapsible metadata and semantic status markers', () => {
  const html = renderDashboard({
    page: {
      title: '审查批次',
      context_badges: [{ label: '降级完成', tone: 'medium' }],
    },
    sections: [
      {
        id: 'run_metadata',
        type: 'definition_list',
        title: '审查元数据',
        collapsible: true,
        items: [{ label: 'Review ID', value: 'review-1' }],
      },
      {
        id: 'review_findings',
        type: 'table',
        title: '本批风险发现',
        columns: [{ key: 'status', label: '状态' }],
        rows: [{ status: { text: 'Open', tone: 'critical' } }],
      },
    ],
  });

  assert.ok(html.includes('<details id="run_metadata" class="data-section collapsible-section">'));
  assert.ok(html.includes('class="context-badge" data-tone="medium"><span class="status-marker" aria-hidden="true"></span><span>降级完成</span>'));
  assert.ok(html.includes('class="status-tag" data-tone="critical"><span class="status-marker" aria-hidden="true"></span><span>Open</span>'));
});

test('renderDashboard includes sticky headers, trace connectors, responsive breakpoints, and reduced motion', () => {
  const html = renderDashboard({
    page: { title: '风险发现' },
    sections: [{
      id: 'trace_sequence',
      type: 'trace_sequence',
      title: 'Trace',
      steps: [
        { order: 1, tool_name: 'db.read', event: 'tool.start', status: { text: '正常', tone: 'success' } },
        { order: 2, tool_name: 'db.read', event: 'tool.end', status: { text: '完成', tone: 'success' } },
      ],
    }],
  });

  assert.ok(html.includes('.data-table thead th {'));
  assert.ok(html.includes('position: sticky;'));
  assert.ok(html.includes('.trace-step:not(:last-child)::after {'));
  assert.ok(html.includes('@media (max-width: 768px)'));
  assert.ok(html.includes('@media (max-width: 375px)'));
  assert.ok(html.includes('.column-priority-metadata { display: none; }'));
  assert.ok(html.includes('@media (prefers-reduced-motion: reduce)'));
  assert.ok(html.includes('overflow-x: hidden;'));
  assert.ok(html.includes('overscroll-behavior-inline: contain;'));
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

test('renderDashboard default UI text is readable Chinese without mojibake', () => {
  const html = renderDashboard({
    sections: [{
      id: 'trace_sequence',
      type: 'trace_sequence',
      title: '工具调用顺序',
      steps: [{
        order: 1,
        timestamp: '2026-07-10T08:15:38.000Z',
        event: 'tool.end',
        status: { text: '正常', tone: 'success' },
        tool_name: 'db.delete',
        span_id: 'span-1',
        parent_span_id: 'parent-1',
        duration_ms: '20 ms',
        summary: '完成',
      }],
    }],
  });

  assert.ok(html.includes('审计看板'));
  assert.ok(html.includes('更新时间'));
  assert.ok(html.includes('父 Span parent-1'));
  assert.ok(html.includes('audit-logger-agent 审计看板'));
  assert.doesNotMatch(html, /(?:涓|楂|椋|闄|浣|淇|鎴|鍏|鈥|椤|瀵|艰|埅|鐖|璋|鐩|閾|捐|矾|寤|妯|鏆|棤|鍙|睍|绀|鐧|诲|綍|璁|块|棶|浠|ょ|墝|鏇|柊|堕|棿|鎬|昏||规||澶|氭|潯|佹|嵁)/);
});
