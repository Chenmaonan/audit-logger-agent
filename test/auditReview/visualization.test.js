import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisualization } from '../../src/auditReview/visualization.js';

const MOJIBAKE_RE = /[鏃鈥瀹鎵閾澶楂浣淇鎴鍏鐖璋椋寤妯鏆鍔鏇鐪鎬]/;

function assertNoMojibake(value) {
  assert.doesNotMatch(JSON.stringify(value), MOJIBAKE_RE);
}

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
    listFindings({ reviewId, severity, status } = {}) {
      let rows = [critical];
      if (reviewId && reviewId !== critical.review_id) rows = [];
      if (arguments[0]?.agentId) rows = rows.filter((row) => row.agent_id === arguments[0].agentId);
      if (severity) rows = rows.filter((row) => row.severity === severity);
      if (status) rows = rows.filter((row) => row.status === status);
      return rows;
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

  assert.equal(page.page.title, 'Audit Review Overview');
  assert.ok(page.summary_metrics.some((metric) => metric.label === 'Critical'));
  assert.ok(page.page.page_actions.some((action) => action.href.includes('/dashboard/audit-reviews/')));

  const findingsSection = page.sections.find((section) => section.id === 'pending_findings');
  assert.equal(findingsSection.title, 'Open findings');
  assert.ok(findingsSection.columns.some((column) => column.key === 'trace_id' && column.label === 'Trace ID'));
  assert.match(findingsSection.rows[0].title.href, /\/dashboard\/audit-findings\/f-critical/);
  assert.match(findingsSection.rows[0].trace_id.href, /#trace_sequence$/);

  assert.ok(page.sections.find((section) => section.id === 'reviews_with_findings'));
  assert.ok(page.sections.find((section) => section.id === 'reviews_without_findings'));
});

test('reviewDetailPage shows degraded callout and linked finding rows', () => {
  const page = createViz().reviewDetailPage('r-degraded');

  assert.equal(page.page.title, 'Review');
  assert.ok(page.page.page_actions.some((action) => action.label === 'Back to overview'));
  assert.ok(page.sections.find((section) => section.type === 'callout' && section.title === 'Degraded review'));

  const findingsSection = page.sections.find((section) => section.id === 'review_findings');
  assert.match(findingsSection.rows[0].title.href, /\/dashboard\/audit-findings\/f-critical/);
  assert.equal(typeof findingsSection.rows[0].evidence_count, 'object');
});

test('findingDetailPage includes details, raw logs, links, and ordered trace sequence', () => {
  const page = createViz().findingDetailPage('f-critical');

  assert.equal(page.page.breadcrumbs[0].label, 'Overview');
  assert.ok(page.page.page_actions.some((action) => action.label === 'Back to overview'));
  assert.ok(page.sections.find((section) => section.id === 'finding_summary'));
  assert.ok(page.sections.find((section) => section.id === 'recommendation'));

  const detail = page.sections.find((section) => section.id === 'finding_detail');
  const labels = detail.items.map((item) => item.label);
  assert.ok(labels.includes('Finding ID'));
  assert.ok(labels.includes('Agent ID'));
  assert.ok(labels.includes('Trace ID'));
  assert.ok(labels.includes('Entity'));

  const raw = page.sections.find((section) => section.id === 'evidence_raw_logs');
  assert.equal(raw.title, 'Raw log snippets (2)');
  assert.deepEqual(raw.snippets.map((snippet) => snippet.label), ['Log ID 1', 'Log ID 2']);

  const sequence = page.sections.find((section) => section.id === 'trace_sequence');
  assert.equal(sequence.title, 'Tool call sequence (2 steps)');
  assert.deepEqual(sequence.steps.map((step) => step.order), [1, 2]);
  assert.deepEqual(sequence.steps.map((step) => step.status.text), ['OK', 'Internal']);
  assert.equal(sequence.steps[1].duration_ms, '640 ms');
});

test('findingDetailPage shows a trace fallback callout when no timeline events exist', () => {
  const page = createViz({ traceEvents: [] }).findingDetailPage('f-critical');
  const fallback = page.sections.find((section) => section.id === 'trace_sequence_empty');
  assert.equal(fallback.title, 'Tool call sequence');
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
  assert.equal(analysis.title, 'LLM trace analysis');
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
  assert.ok(section.body.includes('llm_budget_exceeded'));
});

test('findingDetailPageWithAnalysis degrades when LLM analysis fails', async () => {
  const llmClient = { async createStructuredResponse() { throw new Error('llm unavailable'); } };
  const page = await createViz({}, { llmClient, model: 'test-model' }).findingDetailPageWithAnalysis('f-critical');

  const section = page.sections.find((item) => item.id === 'trace_llm_analysis');
  assert.equal(section.type, 'callout');
  assert.equal(section.title, 'LLM trace analysis unavailable');
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

test('agentSelectorPage shows allowed agents with latest and history links', () => {
  const page = createViz().agentSelectorPage({
    allowedAgentIds: ['agent-1', 'agent-2'],
    snapshots: [
      { agent_id: 'agent-1', agent_name: 'Agent One', created_at: '2026-07-03T10:31:00.000Z' },
    ],
  });

  assert.equal(page.page.title, '选择 Agent');
  assert.ok(page.page.breadcrumbs.some((crumb) => crumb.label === 'Agent'));

  const agents = page.sections.find((section) => section.id === 'agent_selector');
  assert.equal(agents.title, '可选 Agent');
  assert.equal(agents.rows.length, 2);
  assert.equal(agents.rows[0].agent_id.text, 'agent-1');
  assert.equal(agents.rows[0].latest.href, '/dashboard/agents/agent-1/latest');
  assert.equal(agents.rows[0].history.href, '/dashboard/agents/agent-1/history');
  assert.equal(agents.rows[0].latest_snapshot.text, '2026-07-03T10:31:00.000Z');

  const payload = JSON.stringify(page);
  assert.equal(payload.includes('fetch('), false);
  assert.equal(payload.includes('<script'), false);
  assert.doesNotMatch(payload, /Bearer|cookie|magic token|é|�|Ã|Â|鈥|涓|鎬|瀹/);
});

test('agentLatestPage shows latest agent findings or a Chinese empty callout', () => {
  const withData = createViz().agentLatestPage('agent-1');
  assert.equal(withData.page.title, 'Agent 最新审查');
  assert.ok(withData.page.page_actions.some((action) => action.label === '查看历史'));

  const findings = withData.sections.find((section) => section.id === 'agent_latest_findings');
  assert.equal(findings.title, '最近发现');
  assert.equal(findings.rows[0].agent_name, 'Agent One');
  assert.equal(findings.rows[0].trace_id.text, 'trace-critical-1');

  const empty = createViz({ finding: { agent_id: 'agent-other' } }).agentLatestPage('agent-1');
  const callout = empty.sections.find((section) => section.id === 'agent_latest_empty');
  assert.equal(callout.title, '暂无数据');
  assert.match(callout.body, /暂未找到该 Agent 的审查发现/);
  assert.doesNotMatch(JSON.stringify([withData, empty]), /é|�|Ã|Â|鈥|涓|鎬|瀹/);
});

test('agentHistoryPage lists last 24h snapshots with view and download links', () => {
  const page = createViz().agentHistoryPage('agent-1', [
    {
      snapshot_id: 'snap-1',
      review_id: 'r-degraded',
      agent_id: 'agent-1',
      agent_name: 'Agent One',
      created_at: '2026-07-03T10:31:00.000Z',
      finding_count: 1,
      html_href: '/dashboard/agents/agent-1/snapshots/snap-1.html',
      download_href: '/dashboard/agents/agent-1/snapshots/snap-1.html?download=1',
    },
  ]);

  assert.equal(page.page.title, 'Agent 历史快照');
  assert.ok(page.page.page_actions.some((action) => action.label === '最新审查'));

  const history = page.sections.find((section) => section.id === 'agent_history');
  assert.equal(history.title, '过去 24h 快照');
  assert.equal(history.rows[0].view.href, '/dashboard/agents/agent-1/snapshots/snap-1.html');
  assert.equal(history.rows[0].download.href, '/dashboard/agents/agent-1/snapshots/snap-1.html?download=1');
  assert.equal(history.rows[0].download.download, true);
  assert.doesNotMatch(JSON.stringify(page), /Bearer|cookie|magic token|é|�|Ã|Â|鈥|涓|鎬|瀹/);
});

test('snapshotDetailPage returns a snapshot view model with download action', () => {
  const page = createViz().snapshotDetailPage({
    snapshot_id: 'snap-1',
    review_id: 'r-degraded',
    agent_id: 'agent-1',
    agent_name: 'Agent One',
    created_at: '2026-07-03T10:31:00.000Z',
    finding_count: 1,
    html_href: '/dashboard/agents/agent-1/snapshots/snap-1.html',
    download_href: '/dashboard/agents/agent-1/snapshots/snap-1.html?download=1',
  });

  assert.equal(page.page.title, '快照详情');
  assert.ok(page.page.page_actions.some((action) => action.label === '下载 HTML' && action.download === true));
  assert.ok(page.sections.find((section) => section.id === 'snapshot_metadata'));
  assert.doesNotMatch(JSON.stringify(page), /Bearer|cookie|magic token|é|�|Ã|Â|鈥|涓|鎬|瀹/);
});
