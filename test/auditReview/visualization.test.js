import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisualization } from '../../src/auditReview/visualization.js';

function fakeStore({ traceEventsById, rawEventsById, cachedAnalysis } = {}) {
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
      llm_analysis: cachedAnalysis ?? null,
      analysis_generated_at: cachedAnalysis ? '2026-07-03T10:30:00.000Z' : null,
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

  const traces = traceEventsById ?? {
    'trace-critical-1': [
      {
        id: 11,
        ts: '2026-07-03T10:28:00.000Z',
        event: 'tool.start',
        status: 'ok',
        agent_id: 'agent-critical',
        tool_name: 'db.delete',
        trace_id: 'trace-critical-1',
        span_id: 'span-critical-1',
        parent_span_id: null,
        result_summary: 'delete requested',
        duration_ms: null,
        error_message: null,
      },
      {
        id: 12,
        ts: '2026-07-03T10:29:00.000Z',
        event: 'tool.end',
        status: 'error',
        agent_id: 'agent-critical',
        tool_name: 'db.delete',
        trace_id: 'trace-critical-1',
        span_id: 'span-critical-2',
        parent_span_id: 'span-critical-1',
        result_summary: 'delete failed after partial mutation',
        duration_ms: 640,
        error_message: 'permission denied',
      },
    ],
  };

  const rawEvents = rawEventsById ?? {
    1: { id: 1, raw_json: '{"event":"tool.start","tool_name":"db.delete","payload":{"b":2,"a":1}}' },
    2: { id: 2, raw_json: '{"event":"tool.end","tool_name":"db.delete","error_message":"permission denied"}' },
  };

  const store = {
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
    listTraceEvents({ traceId, limit } = {}) {
      const rows = traces[traceId] ?? [];
      return typeof limit === 'number' ? rows.slice(0, limit) : rows.slice();
    },
    listRawEventsByIds({ eventIds, limit } = {}) {
      const rows = (eventIds ?? []).map((id) => rawEvents[id]).filter(Boolean);
      return typeof limit === 'number' ? rows.slice(0, limit) : rows;
    },
    listDeadLetterCount() {
      return 0;
    },
  };
  store.saveFindingAnalysis = function saveFindingAnalysis(findingId, { analysis, generatedAt }) {
    const finding = findings.find((row) => row.finding_id === findingId);
    if (finding) {
      finding.llm_analysis = analysis;
      finding.analysis_generated_at = generatedAt;
    }
    return finding ?? null;
  };
  return store;
}

function createViz(storeOptions, visualizationOptions = {}) {
  return createVisualization({
    reviewStore: fakeStore(storeOptions),
    config: { auditReview: { visualization: { dashboardPath: '/dashboard' } } },
    ...visualizationOptions,
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
  assert.ok(findingsSection.columns.some((column) => column.key === 'trace_id' && column.label === '链路 ID'));
  assert.match(findingsSection.rows[0].title.href, /\/dashboard\/audit-findings\//);
  assert.equal(findingsSection.rows[0].trace_id.text, 'trace-critical-1');
  assert.match(findingsSection.rows[0].trace_id.href, /\/dashboard\/audit-findings\/f-critical#trace_sequence$/);
  assert.equal(findingsSection.rows[0].trace_id.mono, true);
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
  assert.ok(findingsSection.columns.some((column) => column.key === 'trace_id' && column.label === '链路 ID'));
  assert.match(findingsSection.rows[0].title.href, /\/dashboard\/audit-findings\//);
  assert.match(findingsSection.rows[0].trace_id.href, /\/dashboard\/audit-findings\/f-critical#trace_sequence$/);
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

  assert.equal(page.sections.some((section) => section.id === 'evidence_events'), false);

  const rawSection = page.sections.find((section) => section.id === 'evidence_raw_logs');
  assert.ok(rawSection);
  assert.equal(rawSection.title, '原始日志片段（共 2 条）');
  assert.deepEqual(rawSection.snippets.map((snippet) => snippet.label), ['日志 ID 1', '日志 ID 2']);
  assert.deepEqual(rawSection.snippets.map((snippet) => snippet.body), [
    '{"event":"tool.start","tool_name":"db.delete","payload":{"b":2,"a":1}}',
    '{"event":"tool.end","tool_name":"db.delete","error_message":"permission denied"}',
  ]);

  assert.equal(page.sections.some((section) => section.id === 'trace_timeline'), false);

  const linkSection = page.sections.find((section) => section.type === 'link_list');
  assert.ok(linkSection.links.some((link) => link.href === '/dashboard'));
});

test('findingDetailPage adds an ordered visual trace sequence without the old raw trace table', () => {
  const page = createViz().findingDetailPage('f-critical');

  const sequenceSection = page.sections.find((section) => section.id === 'trace_sequence');
  assert.ok(sequenceSection);
  assert.equal(page.sections.some((section) => section.id === 'trace_timeline'), false);
  assert.equal(page.sections.some((section) => section.id === 'evidence_events'), false);
  assert.equal(sequenceSection.type, 'trace_sequence');
  assert.equal(sequenceSection.title, '工具调用顺序（共 2 步）');
  assert.deepEqual(sequenceSection.steps.map((step) => step.order), [1, 2]);
  assert.deepEqual(sequenceSection.steps.map((step) => step.tool_name), ['db.delete', 'db.delete']);
  assert.deepEqual(sequenceSection.steps.map((step) => step.event), ['tool.start', 'tool.end']);
  assert.equal(sequenceSection.steps[0].status.text, '正常');
  assert.equal(sequenceSection.steps[1].status.text, '错误');
  assert.equal(sequenceSection.steps[1].duration_ms, '640 ms');
  assert.equal(sequenceSection.steps[1].parent_span_id, 'span-critical-1');
  assert.equal(sequenceSection.steps[1].summary, 'delete failed after partial mutation');
});

test('findingDetailPageWithAnalysis calls LLM and adds chain purpose analysis', async () => {
  const calls = [];
  const usageRecords = [];
  const store = fakeStore();
  store.getLlmUsage = function getLlmUsage(day) {
    return { day, calls: 0, est_tokens: 0 };
  };
  store.recordLlmUsage = function recordLlmUsage(record) {
    usageRecords.push(record);
    return {
      day: record.day,
      calls: record.calls,
      est_tokens: record.estTokens,
    };
  };
  const llmClient = {
    async createStructuredResponse(request) {
      calls.push(request);
      return {
        purpose: '尝试执行 db.delete 删除操作。',
        chain_summary: '链路先启动 db.delete，随后同一调用链返回 permission denied。',
        risk_points: ['删除操作失败但摘要显示可能已发生部分变更。'],
        next_actions: ['核查调用来源与实际数据变更。'],
      };
    },
  };

  const page = await createVisualization({
    reviewStore: store,
    llmClient,
    model: 'test-model',
    config: {
      auditReview: {
        visualization: { dashboardPath: '/dashboard' },
        llmBudget: { maxCallsPerDay: 500, maxTokensPerDay: 2000000 },
      },
    },
  }).findingDetailPageWithAnalysis('f-critical');

  assert.equal(calls.length, 1);
  assert.equal(usageRecords.length, 1);
  assert.equal(usageRecords[0].calls, 1);
  assert.ok(usageRecords[0].estTokens > 0);
  assert.equal(calls[0].model, 'test-model');
  assert.ok(JSON.stringify(calls[0].input).includes('trace-critical-1'));
  const analysisSection = page.sections.find((section) => section.id === 'trace_llm_analysis');
  assert.ok(analysisSection);
  assert.equal(analysisSection.type, 'trace_analysis');
  assert.equal(analysisSection.title, 'LLM 链路分析');
  assert.equal(analysisSection.purpose, '尝试执行 db.delete 删除操作。');
  assert.equal(analysisSection.chain_summary, '链路先启动 db.delete，随后同一调用链返回 permission denied。');
  assert.deepEqual(analysisSection.risk_points, ['删除操作失败但摘要显示可能已发生部分变更。']);
  assert.deepEqual(analysisSection.next_actions, ['核查调用来源与实际数据变更。']);
  assert.equal(analysisSection.model, 'test-model');
});

test('findingDetailPageWithAnalysis reuses cached analysis without calling LLM', async () => {
  const calls = [];
  const llmClient = {
    async createStructuredResponse(request) {
      calls.push(request);
      return {
        purpose: 'fresh purpose',
        chain_summary: 'fresh chain',
        risk_points: [],
        next_actions: [],
      };
    },
  };

  const page = await createViz({
    cachedAnalysis: {
      purpose: 'cached purpose',
      chain_summary: 'cached chain',
      risk_points: ['cached risk'],
      next_actions: ['cached action'],
    },
  }, {
    llmClient,
    model: 'test-model',
    config: {
      auditReview: {
        llmBudget: { cacheDetailAnalysis: true },
        visualization: { dashboardPath: '/dashboard' },
      },
    },
  }).findingDetailPageWithAnalysis('f-critical');

  assert.equal(calls.length, 0);
  const analysisSection = page.sections.find((section) => section.id === 'trace_llm_analysis');
  assert.ok(analysisSection);
  assert.equal(analysisSection.type, 'trace_analysis');
  assert.equal(analysisSection.purpose, 'cached purpose');
  assert.equal(analysisSection.chain_summary, 'cached chain');
  assert.deepEqual(analysisSection.risk_points, ['cached risk']);
  assert.deepEqual(analysisSection.next_actions, ['cached action']);
});

test('findingDetailPageWithAnalysis skips LLM when daily detail-analysis budget is exhausted', async () => {
  const calls = [];
  const store = fakeStore();
  store.getLlmUsage = function getLlmUsage(day) {
    return { day, calls: 1, est_tokens: 100 };
  };
  store.recordLlmUsage = function recordLlmUsage() {
    throw new Error('usage must not be recorded when call is skipped');
  };
  const llmClient = {
    async createStructuredResponse(request) {
      calls.push(request);
      return {
        purpose: 'fresh purpose',
        chain_summary: 'fresh chain',
        risk_points: [],
        next_actions: [],
      };
    },
  };

  const page = await createVisualization({
    reviewStore: store,
    llmClient,
    model: 'test-model',
    config: {
      auditReview: {
        llmBudget: {
          maxCallsPerDay: 1,
          maxTokensPerDay: 2000000,
          cacheDetailAnalysis: true,
        },
        visualization: { dashboardPath: '/dashboard' },
      },
    },
  }).findingDetailPageWithAnalysis('f-critical');

  assert.equal(calls.length, 0);
  const analysisSection = page.sections.find((section) => section.id === 'trace_llm_analysis');
  assert.ok(analysisSection);
  assert.equal(analysisSection.type, 'callout');
  assert.ok(analysisSection.body.includes('llm_budget_exceeded'));
});

test('findingDetailPageWithAnalysis degrades when LLM analysis fails', async () => {
  const llmClient = {
    async createStructuredResponse() {
      throw new Error('llm unavailable');
    },
  };

  const page = await createViz({}, { llmClient, model: 'test-model' }).findingDetailPageWithAnalysis('f-critical');

  const sequenceSection = page.sections.find((section) => section.id === 'trace_sequence');
  assert.ok(sequenceSection);
  const analysisSection = page.sections.find((section) => section.id === 'trace_llm_analysis');
  assert.ok(analysisSection);
  assert.equal(analysisSection.type, 'callout');
  assert.equal(analysisSection.title, 'LLM 链路分析不可用');
  assert.ok(analysisSection.body.includes('llm unavailable'));
});

test('findingDetailPageWithAnalysis fills a local chain summary when LLM omits it', async () => {
  const llmClient = {
    async createStructuredResponse() {
      return {
        purpose: '尝试执行 db.delete 删除操作。',
        chain_summary: '',
        risk_points: [],
        next_actions: [],
      };
    },
  };

  const page = await createViz({}, { llmClient, model: 'test-model' }).findingDetailPageWithAnalysis('f-critical');

  const analysisSection = page.sections.find((section) => section.id === 'trace_llm_analysis');
  assert.ok(analysisSection);
  assert.match(analysisSection.chain_summary, /tool.start/);
  assert.match(analysisSection.chain_summary, /tool.end/);
  assert.match(analysisSection.chain_summary, /permission denied/);
});

test('findingDetailPage shows a trace fallback callout when no timeline events exist', () => {
  const page = createViz({ traceEventsById: {} }).findingDetailPage('f-critical');

  assert.equal(page.sections.some((section) => section.id === 'trace_timeline'), false);
  const traceFallback = page.sections.find((section) => section.id === 'trace_sequence_empty');
  assert.ok(traceFallback);
  assert.equal(traceFallback.title, '工具调用顺序');
  assert.ok(traceFallback.body.includes('trace-critical-1'));
});

test('findingDetailPage uses Chinese labels for basic information fields', () => {
  const page = createViz().findingDetailPage('f-critical');
  const basicInfo = page.sections.find((section) => section.id === 'finding_detail');
  assert.ok(basicInfo);

  const labels = basicInfo.items.map((item) => item.label);
  assert.ok(labels.includes('风险发现 ID'));
  assert.ok(labels.includes('智能体 ID'));
  assert.ok(labels.includes('链路 ID'));
  assert.equal(labels.includes('Finding ID'), false);
  assert.equal(labels.includes('Agent ID'), false);
  assert.equal(labels.includes('Trace ID'), false);
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
