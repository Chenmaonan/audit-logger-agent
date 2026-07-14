import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisualization } from '../../src/auditReview/visualization.js';

function finding(overrides = {}) {
  return {
    finding_id: 'f-critical',
    review_id: 'r-degraded',
    title: 'Critical delete failure',
    summary: 'Delete failed after partial mutation.',
    recommendation: 'Verify authorization and data state.',
    severity: 'critical',
    category: 'high_risk_permission',
    status: 'open',
    agent_id: 'agent-1',
    agent_name: 'Agent One',
    tool_name: 'db.delete',
    trace_id: 'trace-critical-1',
    entity: { type: 'database', id: 'db-1' },
    evidence_event_ids: [1, 2],
    evidence: [{ event_id: 1 }, { event_id: 2 }],
    last_seen_at: '2026-07-03T10:02:00.000Z',
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    review_id: 'r-degraded',
    status: 'completed_degraded',
    window_from: '2026-07-03T10:00:00.000Z',
    window_to: '2026-07-03T10:30:00.000Z',
    finding_count: 1,
    trigger_type: 'scheduled',
    finished_at: '2026-07-03T10:31:00.000Z',
    risk_policy_version: 'risk-v1',
    prompt_version: 'prompt-v1',
    reviewer_version: 'reviewer-v1',
    candidate_event_count: 2,
    scanned_files: 1,
    ...overrides,
  };
}

function fakeStore(overrides = {}) {
  const critical = finding(overrides.finding);
  const findings = [critical, ...(overrides.findings ?? [])];
  const cleanRun = run({ review_id: 'r-clean', status: 'completed', finding_count: 0 });
  const degraded = run();
  const traceEvents = overrides.traceEvents ?? [
    {
      id: 1,
      ts: '2026-07-03T10:01:00.000Z',
      event: 'tool.start',
      status: 'OK',
      tool_name: 'db.delete',
      trace_id: 'trace-critical-1',
      span_id: 'span-1',
      parent_span_id: null,
      result_summary: 'delete requested',
      raw_json: '{"event":"tool.start"}',
    },
    {
      id: 2,
      ts: '2026-07-03T10:02:00.000Z',
      event: 'tool.end',
      status: 'INTERNAL',
      tool_name: 'db.delete',
      trace_id: 'trace-critical-1',
      span_id: 'span-1',
      parent_span_id: null,
      duration_ms: 640,
      result_summary: 'delete failed after partial mutation',
      error_message: 'permission denied',
      raw_json: '{"event":"tool.end","error_message":"permission denied"}',
    },
  ];

  return {
    listFindings({ reviewId, severity, status, agentId } = {}) {
      let rows = findings;
      if (reviewId) rows = rows.filter((row) => row.review_id === reviewId);
      if (severity) rows = rows.filter((row) => row.severity === severity);
      if (status) rows = rows.filter((row) => row.status === status);
      if (agentId) rows = rows.filter((row) => row.agent_id === agentId);
      return rows;
    },
    listAgents() {
      return overrides.agents ?? [
        {
          agent_id: 'agent-1',
          event_count: 2,
          last_event_at: '2026-07-03T10:02:00.000Z',
          finding_count: 1,
          open_finding_count: 1,
        },
      ];
    },
    listRuns() {
      return [degraded, cleanRun];
    },
    getRun(reviewId) {
      return [degraded, cleanRun].find((row) => row.review_id === reviewId) ?? null;
    },
    getFinding(findingId) {
      return findingId === critical.finding_id ? critical : null;
    },
    listTraceEvents({ traceId }) {
      return traceId === 'trace-critical-1' ? traceEvents : [];
    },
    listRawEventsByIds({ eventIds }) {
      return traceEvents.filter((row) => eventIds.includes(row.id));
    },
    listDeadLetterCount() {
      return overrides.deadLetters ?? 0;
    },
    getLlmUsage(day) {
      return { day, calls: 0, est_tokens: 0 };
    },
    reserveLlmUsage({ day, calls = 1, estTokens = 0 }) {
      return { reserved: true, day, calls, est_tokens: estTokens };
    },
    saveFindingAnalysis() {},
    ...overrides.store,
  };
}

function createViz(storeOptions = {}, visualizationOptions = {}) {
  return createVisualization({
    reviewStore: fakeStore(storeOptions),
    config: { auditReview: { visualization: { dashboardPath: '/dashboard' }, llmBudget: { maxCallsPerDay: 100, maxTokensPerDay: 1000000 } } },
    ...visualizationOptions,
  });
}

test('overviewPage returns linked review and finding sections', () => {
  const page = createViz().overviewPage();

  assert.equal(page.page.title, '审计审查总览');
  assert.ok(page.summary_metrics.some((metric) => metric.label === '严重'));
  assert.ok(page.page.page_actions.some((action) => action.href.includes('/dashboard/audit-reviews/')));

  const findingsSection = page.sections.find((section) => section.id === 'pending_findings');
  assert.equal(findingsSection.title, '待处理风险发现');
  assert.ok(findingsSection.columns.some((column) => column.key === 'trace_id' && column.label === 'Trace ID'));
  assert.match(findingsSection.rows[0].title.href, /\/dashboard\/audit-findings\/f-critical/);
  assert.match(findingsSection.rows[0].trace_id.href, /#trace_sequence$/);

  assert.ok(page.sections.find((section) => section.id === 'reviews_with_findings'));
  assert.ok(page.sections.find((section) => section.id === 'reviews_without_findings'));
});

test('agentIndexPage lists received agent ids linked to filtered dashboard', () => {
  const page = createViz({
    agents: [
      {
        agent_id: 'agent-1',
        event_count: 3,
        last_event_at: '2026-07-03T10:02:00.000Z',
        finding_count: 1,
        open_finding_count: 1,
      },
      {
        agent_id: 'agent.2',
        event_count: 1,
        last_event_at: '2026-07-03T09:50:00.000Z',
        finding_count: 0,
        open_finding_count: 0,
      },
    ],
  }).agentIndexPage();

  assert.equal(page.page.title, 'Agent 日志入口');
  const section = page.sections.find((item) => item.id === 'received_agents');
  assert.equal(section.title, '已接收日志的 Agent');
  assert.equal(section.rows[0].agent_id.text, 'agent-1');
  assert.equal(section.rows[0].agent_id.href, '/dashboard?agent_id=agent-1');
  assert.equal(section.rows[1].agent_id.href, '/dashboard?agent_id=agent.2');
  assert.ok(page.page.page_actions.some((action) => action.href === '/dashboard'));
});

test('overviewPage filters findings by agent id and links back to agent index', () => {
  const page = createViz({
    findings: [
      finding({
        finding_id: 'f-other',
        agent_id: 'agent-2',
        trace_id: 'trace-agent-2',
        title: 'Other agent finding',
      }),
    ],
  }).overviewPage({ agentId: 'agent-1' });

  assert.equal(page.page.title, 'Agent 日志审计：agent-1');
  assert.ok(page.page.breadcrumbs.some((crumb) => crumb.href === '/'));
  assert.ok(page.page.page_actions.some((action) => action.href === '/'));
  assert.ok(page.summary_metrics.some((metric) => metric.href === '/dashboard?agent_id=agent-1&severity=critical#pending_findings'));
  const findingsSection = page.sections.find((section) => section.id === 'pending_findings');
  assert.equal(findingsSection.rows.length, 1);
  assert.equal(findingsSection.rows[0].agent_name, 'Agent One');
  assert.equal(JSON.stringify(page).includes('Other agent finding'), false);
});

test('visualization view models use Chinese UI labels without mojibake', () => {
  const viz = createViz();
  const pages = [
    viz.agentIndexPage(),
    viz.overviewPage(),
    viz.reviewDetailPage('r-degraded'),
    viz.findingDetailPage('f-critical'),
  ];
  const payload = JSON.stringify(pages);

  assert.ok(payload.includes('审计审查总览'));
  assert.ok(payload.includes('风险发现'));
  assert.ok(payload.includes('审查批次'));
  assert.ok(payload.includes('返回总览'));
  assert.ok(payload.includes('工具调用顺序'));
  assert.ok(payload.includes('原始日志片段'));
  assert.equal(payload.includes('Audit Review Overview'), false);
  assert.equal(payload.includes('Open findings'), false);
  assert.equal(payload.includes('Back to overview'), false);
  assert.equal(payload.includes('Tool call sequence'), false);
  assert.equal(payload.includes('Raw log snippet'), false);
  assert.doesNotMatch(payload, /(?:涓|楂|椋|闄|浣|淇|鎴|鍏|鈥|椤|瀵|艰|埅|鐖|璋|鐩|閾|捐|矾|寤|妯|鏆|棤|鍙|睍|绀|鐧|诲|綍|璁|块|棶|浠|ょ|墝|鏇|柊|堕|棿|鎬|昏||规||澶|氭|潯|佹|嵁)/);
});

test('reviewDetailPage shows degraded callout and linked finding rows', () => {
  const page = createViz().reviewDetailPage('r-degraded');

  assert.equal(page.page.title, '审查批次');
  assert.ok(page.page.page_actions.some((action) => action.label === '返回总览'));
  assert.ok(page.sections.find((section) => section.type === 'callout' && section.title === '降级审查'));

  const findingsSection = page.sections.find((section) => section.id === 'review_findings');
  assert.match(findingsSection.rows[0].title.href, /\/dashboard\/audit-findings\/f-critical/);
  assert.equal(typeof findingsSection.rows[0].evidence_count, 'object');
});

test('findingDetailPage includes details, raw logs, links, and ordered trace sequence', () => {
  const page = createViz().findingDetailPage('f-critical');

  assert.equal(page.page.breadcrumbs[0].label, '总览');
  assert.ok(page.page.page_actions.some((action) => action.label === '返回总览'));
  assert.ok(page.sections.find((section) => section.id === 'finding_summary'));
  assert.ok(page.sections.find((section) => section.id === 'recommendation'));

  const detail = page.sections.find((section) => section.id === 'finding_detail');
  const labels = detail.items.map((item) => item.label);
  assert.ok(labels.includes('风险发现 ID'));
  assert.ok(labels.includes('Agent ID'));
  assert.ok(labels.includes('Trace ID'));
  assert.ok(labels.includes('实体'));

  const raw = page.sections.find((section) => section.id === 'evidence_raw_logs');
  assert.equal(raw.title, '原始日志片段（2 条）');
  assert.deepEqual(raw.snippets.map((snippet) => snippet.label), ['日志 ID 1', '日志 ID 2']);

  const sequence = page.sections.find((section) => section.id === 'trace_sequence');
  assert.equal(sequence.title, '工具调用顺序（共 2 步）');
  assert.deepEqual(sequence.steps.map((step) => step.order), [1, 2]);
  assert.deepEqual(sequence.steps.map((step) => step.status.text), ['正常', '内部错误']);
  assert.equal(sequence.steps[1].duration_ms, '640 ms');
});

test('findingDetailPage shows a trace fallback callout when no timeline events exist', () => {
  const page = createViz({ traceEvents: [] }).findingDetailPage('f-critical');
  const fallback = page.sections.find((section) => section.id === 'trace_sequence_empty');
  assert.equal(fallback.title, '工具调用顺序');
  assert.ok(fallback.body.includes('trace-critical-1'));
});

test('findingDetailPageWithAnalysis calls LLM and inserts trace analysis', async () => {
  const calls = [];
  const llmClient = {
    async createStructuredResponse(request) {
      calls.push(request);
      return {
        purpose: 'delete database row',
        chain_summary: 'tool.start then tool.end failed',
        risk_points: ['partial mutation possible'],
        next_actions: ['verify data state'],
      };
    },
  };

  const page = await createViz({}, { llmClient, model: 'test-model' }).findingDetailPageWithAnalysis('f-critical');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'test-model');
  assert.ok(JSON.stringify(calls[0].input).includes('trace-critical-1'));
  const analysis = page.sections.find((section) => section.id === 'trace_llm_analysis');
  assert.equal(analysis.title, 'LLM 链路分析');
  assert.equal(analysis.type, 'trace_analysis');
  assert.equal(analysis.purpose, 'delete database row');
});

test('findingDetailPageWithAnalysis reuses cached analysis without calling LLM', async () => {
  const cached = {
    purpose: 'cached purpose',
    chain_summary: 'cached chain',
    risk_points: ['cached risk'],
    next_actions: ['cached action'],
  };
  const llmClient = { async createStructuredResponse() { throw new Error('should not call'); } };

  const page = await createViz({
    finding: { llm_analysis: cached, analysis_generated_at: '2026-07-03T10:03:00.000Z' },
  }, { llmClient, model: 'test-model' }).findingDetailPageWithAnalysis('f-critical');

  const analysis = page.sections.find((section) => section.id === 'trace_llm_analysis');
  assert.equal(analysis.purpose, 'cached purpose');
});

test('findingDetailPageWithAnalysis skips LLM when budget reservation fails', async () => {
  const llmClient = { async createStructuredResponse() { throw new Error('should not call'); } };
  const page = await createVisualization({
    reviewStore: fakeStore({ store: { reserveLlmUsage: () => ({ reserved: false }) } }),
    llmClient,
    model: 'test-model',
    config: { auditReview: { visualization: { dashboardPath: '/dashboard' }, llmBudget: { maxCallsPerDay: 1, maxTokensPerDay: 1 } } },
  }).findingDetailPageWithAnalysis('f-critical');

  const section = page.sections.find((item) => item.id === 'trace_llm_analysis');
  assert.equal(section.type, 'callout');
  assert.ok(section.body.includes('LLM 预算已用尽'));
});

test('findingDetailPageWithAnalysis degrades when LLM analysis fails', async () => {
  const llmClient = { async createStructuredResponse() { throw new Error('llm unavailable'); } };
  const page = await createViz({}, { llmClient, model: 'test-model' }).findingDetailPageWithAnalysis('f-critical');

  const section = page.sections.find((item) => item.id === 'trace_llm_analysis');
  assert.equal(section.type, 'callout');
  assert.equal(section.title, 'LLM 链路分析不可用');
  assert.ok(section.body.includes('llm unavailable'));
});

test('findingDetailPageWithAnalysis fills local chain summary when LLM omits it', async () => {
  const llmClient = {
    async createStructuredResponse() {
      return { purpose: 'purpose', chain_summary: '', risk_points: [], next_actions: [] };
    },
  };

  const page = await createViz({}, { llmClient, model: 'test-model' }).findingDetailPageWithAnalysis('f-critical');
  const section = page.sections.find((item) => item.id === 'trace_llm_analysis');
  assert.match(section.chain_summary, /tool.start/);
  assert.match(section.chain_summary, /tool.end/);
  assert.match(section.chain_summary, /permission denied/);
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
