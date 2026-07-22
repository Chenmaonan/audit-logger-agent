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
    listFindings({ reviewId, severity, category, status, agentId } = {}) {
      let rows = findings;
      if (reviewId) rows = rows.filter((row) => row.review_id === reviewId);
      if (severity) rows = rows.filter((row) => row.severity === severity);
      if (category) rows = rows.filter((row) => row.category === category);
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
    listAgentEvents({ agentId, limit = 100, offset = 0, sort = 'time_desc' }) {
      if (agentId !== 'agent-1') return [];
      return traceEvents
        .filter((row) => (row.agent_id ?? 'agent-1') === agentId)
        .slice()
        .sort((left, right) => {
          const ranks = { critical: 4, high: 3, medium: 2, low: 1 };
          if (sort === 'severity_desc') {
            const severityDelta = (ranks[right.severity] ?? 0) - (ranks[left.severity] ?? 0);
            if (severityDelta !== 0) return severityDelta;
          }
          return Date.parse(right.ts) - Date.parse(left.ts) || right.id - left.id;
        })
        .slice(offset, offset + limit);
    },
    countAgentEvents({ agentId }) {
      return agentId === 'agent-1'
        ? traceEvents.filter((row) => (row.agent_id ?? 'agent-1') === agentId).length
        : 0;
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

function traceEvent(index, overrides = {}) {
  return {
    id: index,
    ts: new Date(Date.parse('2026-07-03T10:00:00.000Z') + index * 1000).toISOString(),
    event: 'tool.end',
    status: 'OK',
    tool_name: `tool.${index}`,
    trace_id: 'trace-critical-1',
    span_id: `span-${index}`,
    parent_span_id: null,
    duration_ms: index,
    result_summary: `step ${index}`,
    raw_json: `{"event":"tool.end","id":${index}}`,
    ...overrides,
  };
}

function traceEvents(count) {
  return Array.from({ length: count }, (_, index) => traceEvent(index + 1));
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
  assert.equal(findingsSection.title, '风险发现');
  assert.deepEqual(findingsSection.columns.map((column) => column.key), [
    'title',
    'agent_tool',
    'severity_label',
    'last_seen_at',
    'status',
    'details',
  ]);
  assert.ok(findingsSection.columns.every((column) => ['primary', 'secondary', 'metadata'].includes(column.priority)));
  assert.match(findingsSection.rows[0].title.href, /\/dashboard\/audit-findings\/f-critical/);
  assert.equal(findingsSection.rows[0].title.secondary, '高风险权限');
  assert.equal(findingsSection.rows[0].agent_tool.text, 'Agent One');
  assert.equal(findingsSection.rows[0].agent_tool.secondary, 'db.delete');
  assert.match(findingsSection.rows[0].details.href, /\/dashboard\/audit-findings\/f-critical$/);

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

test('manualDailyReportPage returns a server-rendered Beijing-time confirmation model', () => {
  const status = {
    label: '飞书通知正常',
    tone: 'success',
    href: '/dashboard/daily-report/send',
    active: true,
    allowed: true,
    date: '2026-07-20',
    window: { to: '2026-07-20T06:35:42.000Z' },
    localTime: '2026-07-20 14:35:42',
    timezoneOffsetMinutes: 480,
  };
  const page = createViz().manualDailyReportPage({ status });

  assert.equal(page.page.title, '确认发送当前日报');
  assert.equal(page.page.updated_at, '2026-07-20T06:35:42.000Z');
  assert.equal(page.page.notification_status, status);
  assert.deepEqual(page.summary_metrics, []);
  assert.deepEqual(page.filters, []);

  const section = page.sections.find((item) => item.id === 'manual_daily_report_confirmation');
  assert.equal(section.type, 'confirmation');
  assert.deepEqual(section.items.map((item) => item.label), ['操作', '统计日期', '统计范围', '覆盖范围']);
  assert.equal(section.items.find((item) => item.label === '统计日期').value, '2026-07-20（北京时间）');
  assert.equal(section.items.find((item) => item.label === '统计范围').value, '00:00 至 14:35');
  assert.equal(section.items.find((item) => item.label === '覆盖范围').value, '全部 Agent 与业务链路');
  assert.deepEqual(section.form, {
    method: 'post',
    action: '/dashboard/daily-report/send',
    submit_label: '确认发送',
    cancel_label: '返回',
    cancel_href: '/dashboard',
  });
});

test('manualDailyReportPage does not expose a POST action when sending is unavailable', () => {
  const page = createViz().manualDailyReportPage({
    status: {
      label: '飞书通知未启用',
      tone: 'neutral',
      href: '/dashboard/daily-report/send',
      active: false,
      allowed: false,
      message: '当前为演练模式，不能发送真实日报。',
      date: '2026-07-20',
      window: { to: '2026-07-20T06:35:00.000Z' },
      localTime: '14:35',
      timezoneOffsetMinutes: 480,
    },
  });
  const section = page.sections[0];

  assert.equal(section.allowed, false);
  assert.equal(section.description, '当前为演练模式，不能发送真实日报。');
  assert.equal(section.form.action, undefined);
  assert.equal(section.form.submit_label, undefined);
  assert.equal(section.form.cancel_href, '/dashboard');
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
  assert.equal(page.page.page_actions.find((action) => action.href === '/').kind, 'secondary');
  assert.equal(page.page.page_actions.find((action) => action.label === '打开最高风险发现').kind, 'primary');
  assert.equal(page.page.page_actions.some((action) => action.label === '打开最新降级审查'), false);
  assert.ok(page.summary_metrics.some((metric) => metric.href === '/dashboard?agent_id=agent-1&severity=critical#pending_findings'));
  const logsSection = page.sections.find((section) => section.id === 'agent_logs');
  assert.equal(logsSection.title, 'Agent 日志（第 1/1 页，共 2 条）');
  assert.deepEqual(logsSection.columns.map((column) => column.key), [
    'timestamp',
    'event',
    'tool_name',
    'status',
    'severity',
    'duration_ms',
    'trace_id',
    'span_id',
    'summary',
    'error_message',
  ]);
  assert.deepEqual(logsSection.rows.map((row) => row.event.text), ['tool.end', 'tool.start']);
  assert.equal(logsSection.rows[0].status.text, '内部错误');
  assert.equal(logsSection.rows[0].severity.text, '无风险');
  assert.equal(logsSection.rows[0].duration_ms.text, '640 ms');
  assert.equal(logsSection.rows[0].span_id.text, 'span-1');
  const rawLogs = page.sections.find((section) => section.id === 'agent_raw_logs');
  assert.equal(rawLogs.title, '当前页原始日志');
  assert.equal(rawLogs.collapsible, true);
  assert.equal(rawLogs.snippets.length, 2);
  const findingsSection = page.sections.find((section) => section.id === 'pending_findings');
  assert.equal(findingsSection.rows.length, 1);
  assert.equal(findingsSection.rows[0].agent_tool.text, 'Agent One');
  assert.equal(JSON.stringify(page).includes('Other agent finding'), false);
});

test('overviewPage defaults the risk queue to all statuses while explicit status filters it', () => {
  const resolved = finding({
    finding_id: 'f-resolved',
    title: 'Resolved finding',
    status: 'resolved',
    severity: 'high',
    trace_id: 'trace-resolved',
  });
  const viz = createViz({ findings: [resolved] });

  const defaultPage = viz.overviewPage();
  const defaultQueue = defaultPage.sections.find((section) => section.id === 'pending_findings');
  assert.equal(defaultQueue.title, '风险发现');
  assert.deepEqual(defaultQueue.rows.map((row) => row.title.text), ['Critical delete failure', 'Resolved finding']);
  const statusFilter = defaultPage.filters.find((filter) => filter.id === 'status');
  assert.equal(statusFilter.value, '');
  assert.equal(statusFilter.active_label, '全部状态');
  assert.equal(statusFilter.options[0].label, '全部状态');

  const resolvedPage = viz.overviewPage({ status: 'resolved' });
  const resolvedQueue = resolvedPage.sections.find((section) => section.id === 'pending_findings');
  assert.equal(resolvedQueue.title, '风险发现（已解决）');
  assert.deepEqual(resolvedQueue.rows.map((row) => row.title.text), ['Resolved finding']);
});

test('overviewPage supports time and severity finding sorting with time descending as default', () => {
  const latestLow = finding({
    finding_id: 'f-latest-low',
    title: 'Latest low',
    severity: 'low',
    trace_id: 'trace-latest-low',
    last_seen_at: '2026-07-03T11:00:00.000Z',
  });
  const viz = createViz({ findings: [latestLow] });

  const defaultQueue = viz.overviewPage().sections.find((section) => section.id === 'pending_findings');
  assert.deepEqual(defaultQueue.rows.map((row) => row.title.text), ['Latest low', 'Critical delete failure']);

  const severityPage = viz.overviewPage({ sort: 'severity_desc' });
  const severityQueue = severityPage.sections.find((section) => section.id === 'pending_findings');
  assert.deepEqual(severityQueue.rows.map((row) => row.title.text), ['Critical delete failure', 'Latest low']);
  const sortFilter = severityPage.filters.find((filter) => filter.id === 'sort');
  assert.equal(sortFilter.value, 'severity_desc');
  assert.deepEqual(sortFilter.options.map((option) => option.label), ['按时间排序', '按严重级别排序']);
  assert.equal(sortFilter.options.find((option) => option.value === 'severity_desc').active, true);
});

test('overviewPage paginates agent logs by 100 and preserves filters in navigation links', () => {
  const events = traceEvents(205).map((event) => ({ ...event, agent_id: 'agent-1' }));
  const page = createViz({ traceEvents: events }).overviewPage({
    agentId: 'agent-1',
    severity: 'high',
    category: 'failed_call',
    status: 'resolved',
    reviewId: 'r-clean',
    sort: 'severity_desc',
    logPage: 2,
  });

  const logs = page.sections.find((section) => section.id === 'agent_logs');
  assert.equal(logs.title, 'Agent 日志（第 2/3 页，共 205 条）');
  assert.equal(logs.rows.length, 100);
  assert.equal(logs.rows[0].event.text, 'tool.end');
  assert.equal(logs.rows[0].tool_name.text, 'tool.105');
  assert.equal(logs.rows[99].tool_name.text, 'tool.6');

  const pagination = page.sections.find((section) => section.id === 'agent_log_pagination');
  assert.equal(pagination.type, 'pagination');
  assert.equal(pagination.currentPage, 2);
  assert.equal(pagination.totalPages, 3);
  assert.equal(
    pagination.previousHref,
    '/dashboard?agent_id=agent-1&severity=high&category=failed_call&status=resolved&review_id=r-clean&sort=severity_desc&log_page=1#agent_logs',
  );
  assert.equal(
    pagination.nextHref,
    '/dashboard?agent_id=agent-1&severity=high&category=failed_call&status=resolved&review_id=r-clean&sort=severity_desc&log_page=3#agent_logs',
  );
  const rawLogs = page.sections.find((section) => section.id === 'agent_raw_logs');
  assert.equal(rawLogs.snippets.length, 100);
});

test('overviewPage resets Agent log pagination and anchors the sort controls at the logs', () => {
  const events = traceEvents(205).map((event) => ({ ...event, agent_id: 'agent-1' }));
  const page = createViz({ traceEvents: events }).overviewPage({
    agentId: 'agent-1',
    sort: 'time_desc',
    logPage: 3,
  });

  const sortFilter = page.filters.find((filter) => filter.id === 'sort');
  assert.equal(
    sortFilter.options.find((option) => option.value === 'severity_desc').href,
    '/dashboard?agent_id=agent-1&sort=severity_desc&log_page=1#agent_logs',
  );
  assert.equal(
    sortFilter.options.find((option) => option.value === 'time_desc').href,
    '/dashboard?agent_id=agent-1&sort=time_desc&log_page=1#agent_logs',
  );
});

test('overviewPage labels risk-projected and no-risk Agent logs distinctly', () => {
  const events = [
    traceEvent(2, { agent_id: 'agent-1', severity: 'critical' }),
    traceEvent(1, { agent_id: 'agent-1', severity: null }),
  ];
  const page = createViz({ traceEvents: events }).overviewPage({ agentId: 'agent-1', sort: 'severity_desc' });
  const logs = page.sections.find((section) => section.id === 'agent_logs');

  assert.equal(logs.rows[0].severity.text, '严重');
  assert.equal(logs.rows[0].severity.tone, 'critical');
  assert.equal(logs.rows[1].severity.text, '无风险');
  assert.equal(logs.rows[1].severity.tone, 'neutral');
});

test('overviewPage combines filters, preserves them in GET links, and exposes clear links', () => {
  const matching = finding({
    finding_id: 'f-matching',
    severity: 'high',
    category: 'failed_call',
    status: 'resolved',
    review_id: 'r-clean',
    title: 'Matching resolved failure',
    trace_id: 'trace-matching',
  });
  const page = createViz({ findings: [matching] }).overviewPage({
    agentId: 'agent-1',
    severity: 'high',
    category: 'failed_call',
    status: 'resolved',
    reviewId: 'r-clean',
  });

  const queue = page.sections.find((section) => section.id === 'pending_findings');
  assert.deepEqual(queue.rows.map((row) => row.title.text), ['Matching resolved failure']);
  const categoryFilter = page.filters.find((filter) => filter.id === 'category');
  const statusFilter = page.filters.find((filter) => filter.id === 'status');
  assert.equal(categoryFilter.value, 'failed_call');
  assert.equal(statusFilter.value, 'resolved');
  assert.equal(
    categoryFilter.options.find((option) => option.value === 'anomalous_call').href,
    '/dashboard?agent_id=agent-1&severity=high&category=anomalous_call&status=resolved&review_id=r-clean#pending_findings',
  );
  assert.equal(
    statusFilter.options.find((option) => option.value === 'open').href,
    '/dashboard?agent_id=agent-1&severity=high&category=failed_call&status=open&review_id=r-clean#pending_findings',
  );
  assert.equal(categoryFilter.clear_href, '/dashboard?agent_id=agent-1&severity=high&status=resolved&review_id=r-clean#pending_findings');
  assert.equal(page.clear_filters_href, '/dashboard?agent_id=agent-1#pending_findings');
});

test('overviewPage summary always counts open findings without severity or status pollution', () => {
  const openHigh = finding({
    finding_id: 'f-open-high',
    severity: 'high',
    category: 'failed_call',
    status: 'open',
    title: 'Open high',
    trace_id: 'trace-open-high',
  });
  const resolvedCritical = finding({
    finding_id: 'f-resolved-critical',
    severity: 'critical',
    category: 'failed_call',
    status: 'resolved',
    title: 'Resolved critical',
    trace_id: 'trace-resolved-critical',
  });
  const page = createViz({ findings: [openHigh, resolvedCritical] }).overviewPage({
    severity: 'critical',
    category: 'failed_call',
    status: 'resolved',
  });

  assert.equal(page.summary_metrics.find((metric) => metric.label === '严重').value, 0);
  assert.equal(page.summary_metrics.find((metric) => metric.label === '高风险').value, 1);
  assert.equal(
    page.summary_metrics.find((metric) => metric.label === '高风险').href,
    '/dashboard?severity=high&category=failed_call#pending_findings',
  );
});

test('overviewPage keeps agent-associated reviews independent from queue filters', () => {
  const page = createViz({
    findings: [
      finding({
        finding_id: 'f-agent-review',
        review_id: 'r-clean',
        severity: 'low',
        status: 'resolved',
        title: 'Agent review association',
        trace_id: 'trace-agent-review',
      }),
    ],
  }).overviewPage({ agentId: 'agent-1', severity: 'critical', status: 'open', reviewId: 'r-degraded' });

  assert.ok(page.sections.find((section) => section.id === 'reviews_with_findings'));
  assert.ok(page.sections.find((section) => section.id === 'reviews_without_findings'));
});

test('overviewPage preserves pending_findings anchor for empty filtered results', () => {
  const page = createViz().overviewPage({ severity: 'low', category: 'failed_call' });
  const section = page.sections.find((item) => item.id === 'pending_findings');

  assert.equal(section.type, 'callout');
  assert.equal(section.title, '风险发现');
  assert.match(section.body, /没有匹配/);
});

test('visualization view models use Chinese UI labels without mojibake', () => {
  const viz = createViz();
  const pages = [
    viz.agentIndexPage(),
    viz.overviewPage(),
    viz.manualDailyReportPage(),
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
  assert.ok(findingsSection.columns.every((column) => ['primary', 'secondary', 'metadata'].includes(column.priority)));
  assert.equal(page.sections.find((section) => section.id === 'run_metadata').collapsible, true);
});

test('reviewDetailPage reads occurrence snapshots and marks repeat, escalation, and recurrence', () => {
  const page = createViz({
    store: {
      listReviewOccurrences({ reviewId }) {
        assert.equal(reviewId, 'r-degraded');
        return [{
          occurrence_id: 'occ-1',
          finding_id: 'f-critical',
          review_id: reviewId,
          severity: 'high',
          title: 'Occurrence snapshot title',
          observed_at: '2026-07-04T10:00:00.000Z',
          is_new: 0,
          severity_escalated: 1,
          reopened: 1,
          evidence_json: JSON.stringify([{ event_id: 9, raw_json: '{"snapshot":true}' }]),
        }];
      },
    },
  }).reviewDetailPage('r-degraded');

  const section = page.sections.find((item) => item.id === 'review_findings');
  assert.deepEqual(section.rows.map((row) => row.title.text), ['Occurrence snapshot title']);
  assert.equal(section.rows[0].severity_label.text, '高风险');
  assert.equal(section.rows[0].occurrence_flags.text, '重复出现 · 严重级别上升 · 已解决后复发');
  assert.equal(section.rows[0].evidence_count.text, '1');
  assert.equal(page.summary_metrics.find((metric) => metric.label === '高风险').value, 1);
  assert.equal(page.summary_metrics.find((metric) => metric.label === '严重').value, 0);
});

test('reviewDetailPage filters its queue while summary uses the unfiltered review set', () => {
  const page = createViz({
    findings: [
      finding({
        finding_id: 'f-review-high',
        severity: 'high',
        category: 'failed_call',
        status: 'resolved',
        title: 'Review high resolved',
        trace_id: 'trace-review-high',
      }),
    ],
  }).reviewDetailPage('r-degraded', { severity: 'high', category: 'failed_call', status: 'resolved' });

  assert.equal(page.summary_metrics.find((metric) => metric.label === '严重').value, 1);
  assert.equal(page.summary_metrics.find((metric) => metric.label === '高风险').value, 1);
  const queue = page.sections.find((section) => section.id === 'review_findings');
  assert.deepEqual(queue.rows.map((row) => row.title.text), ['Review high resolved']);
  assert.equal(page.filters.find((filter) => filter.id === 'category').value, 'failed_call');
  assert.equal(page.filters.find((filter) => filter.id === 'status').value, 'resolved');
  assert.equal(page.clear_filters_href, '/dashboard/audit-reviews/r-degraded#review_findings');
});

test('reviewDetailPage preserves review_findings anchor for empty filtered results', () => {
  const page = createViz().reviewDetailPage('r-degraded', { severity: 'low' });
  const section = page.sections.find((item) => item.id === 'review_findings');

  assert.equal(section.type, 'callout');
  assert.match(section.body, /没有匹配/);
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

  const orderedIds = page.sections.map((section) => section.id);
  assert.ok(orderedIds.indexOf('finding_summary') < orderedIds.indexOf('recommendation'));
  assert.ok(orderedIds.indexOf('recommendation') < orderedIds.indexOf('trace_sequence'));
  assert.ok(orderedIds.indexOf('trace_sequence') < orderedIds.indexOf('finding_detail'));
  assert.ok(orderedIds.indexOf('finding_detail') < orderedIds.indexOf('evidence_raw_logs'));
});

test('findingDetailPage hides lifecycle forms while preserving occurrence/action history, snapshots, and notices', () => {
  const page = createViz({
    finding: {
      state_version: 7,
      first_review_id: 'r-first',
      last_review_id: 'r-latest',
      max_severity: 'critical',
      status: 'resolved',
    },
    store: {
      listFindingOccurrences({ findingId }) {
        assert.equal(findingId, 'f-critical');
        return [
          {
            occurrence_id: 'occ-2',
            finding_id: findingId,
            review_id: 'r-latest',
            severity: 'critical',
            observed_at: '2026-07-05T10:00:00.000Z',
            is_new: 0,
            severity_escalated: 1,
            reopened: 1,
            evidence_json: JSON.stringify([{ event_id: 88, raw_json: '{"historical":"evidence"}' }]),
          },
          {
            occurrence_id: 'occ-1',
            finding_id: findingId,
            review_id: 'r-first',
            severity: 'high',
            observed_at: '2026-07-03T10:00:00.000Z',
            is_new: 1,
            severity_escalated: 0,
            reopened: 0,
            evidence_json: '[]',
          },
        ];
      },
      listFindingActions() {
        return [{
          action_id: 'act-1',
          action_type: 'resolve',
          from_status: 'open',
          to_status: 'resolved',
          actor: 'operator-1',
          note: '已修复',
          created_at: '2026-07-04T10:00:00.000Z',
        }];
      },
    },
  }).findingDetailPage('f-critical', { notice: 'finding_version_conflict', action: 'reopen' });

  assert.equal(page.sections.some((section) => section.id === 'finding_actions'), false);

  const detail = page.sections.find((section) => section.id === 'finding_detail');
  assert.equal(detail.items.find((item) => item.label === '复发次数').value, 1);
  assert.equal(detail.items.find((item) => item.label === '历史最高严重级别').value, '严重');
  assert.equal(detail.items.find((item) => item.label === '最近审查批次 ID').value, 'r-latest');
  assert.ok(page.sections.find((section) => section.id === 'occurrence_history'));
  assert.ok(page.sections.find((section) => section.id === 'action_history'));
  const snapshots = page.sections.find((section) => section.id === 'historical_evidence_snapshots');
  assert.equal(snapshots.snippets[0].body, '{"historical":"evidence"}');
  assert.equal(page.notices[0].title, '操作未完成');
  assert.match(page.notices[0].body, /其他操作更新/);
});

test('findingDetailPage limits dashboard trace sequence to first 20 steps and flags over-50 traces', () => {
  const page = createViz({ traceEvents: traceEvents(60) }).findingDetailPage('f-critical');

  const sequence = page.sections.find((section) => section.id === 'trace_sequence');
  assert.equal(sequence.title, '工具调用顺序（显示前 20 步，共 60 步）');
  assert.equal(sequence.steps.length, 20);
  assert.deepEqual(sequence.steps.map((step) => step.order), Array.from({ length: 20 }, (_, index) => index + 1));
  assert.equal(sequence.steps[19].tool_name, 'tool.20');
  assert.equal(JSON.stringify(sequence).includes('tool.21'), false);

  const abnormal = page.sections.find((section) => section.id === 'trace_sequence_abnormal');
  assert.equal(abnormal.title, '异常情况');
  assert.ok(abnormal.body.includes('60 步'));
  assert.ok(abnormal.body.includes('超过 50 步阈值'));
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
  assert.ok(page.sections.indexOf(analysis) < page.sections.findIndex((section) => section.id === 'trace_sequence'));
});

test('findingDetailPageWithAnalysis sends only first 20 trace events to LLM', async () => {
  const calls = [];
  const llmClient = {
    async createStructuredResponse(request) {
      calls.push(request);
      return {
        purpose: 'purpose',
        chain_summary: 'chain',
        risk_points: [],
        next_actions: [],
      };
    },
  };

  await createViz({ traceEvents: traceEvents(25) }, { llmClient, model: 'test-model' })
    .findingDetailPageWithAnalysis('f-critical');

  assert.equal(calls.length, 1);
  const userMessage = calls[0].input.find((message) => message.role === 'user');
  const payload = JSON.parse(userMessage.content);
  assert.equal(payload.trace_event_count, 25);
  assert.equal(payload.analyzed_trace_event_count, 20);
  assert.equal(payload.trace_events_truncated, true);
  assert.equal(payload.trace_events.length, 20);
  assert.equal(payload.trace_events[19].event_id, 20);
  assert.equal(JSON.stringify(payload.trace_events).includes('"event_id":21'), false);
});

test('findingDetailPageWithAnalysis skips LLM for over-50 trace chains', async () => {
  const calls = [];
  const llmClient = {
    async createStructuredResponse(request) {
      calls.push(request);
      throw new Error('should not call');
    },
  };

  const page = await createViz({ traceEvents: traceEvents(51) }, { llmClient, model: 'test-model' })
    .findingDetailPageWithAnalysis('f-critical');

  assert.equal(calls.length, 0);
  const abnormal = page.sections.find((section) => section.id === 'trace_sequence_abnormal');
  assert.equal(abnormal.title, '异常情况');
  assert.ok(abnormal.body.includes('51 步'));
  assert.equal(page.sections.some((section) => section.id === 'trace_llm_analysis'), false);
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
    viz.manualDailyReportPage(),
    viz.reviewDetailPage('r-degraded'),
    viz.findingDetailPage('f-critical'),
  ]);

  assert.equal(payload.includes('fetch('), false);
  assert.equal(payload.includes('<script'), false);
});
