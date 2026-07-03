// src/auditReview/visualization.js
// Build direct-data view models for the dashboard pages.
// The template receives fully-populated sections (rows/items/links) — no browser-side fetch.

const SEVERITY_LABELS = { critical: '严重', high: '高风险', medium: '中风险', low: '低风险' };
const STATUS_LABELS = {
  open: '待处理',
  acknowledged: '已确认',
  snoozed: '已静默',
  resolved: '已解决',
  completed: '已完成',
  completed_degraded: '降级完成',
  failed: '失败',
  running: '运行中',
  skipped: '已跳过',
};
const CATEGORY_LABELS = {
  high_risk_permission: '高危权限/变更',
  anomalous_call: '异常调用',
  repeated_call: '重复调用',
  failed_call: '失败调用',
  trace_integrity: '链路完整性',
  ingest_parse_error: '日志解析错误',
};

function defaultVisualizationConfig(config) {
  return config?.auditReview?.visualization ?? {};
}

function nowIso() {
  return new Date().toISOString();
}

function labelOf(map, value) {
  if (value === null || value === undefined) return '';
  return map[value] ?? String(value);
}

const FINDINGS_TABLE_COLUMNS = [
  { key: 'title', label: '标题' },
  { key: 'severity_label', label: '严重程度' },
  { key: 'category_label', label: '类别' },
  { key: 'agent_name', label: 'Agent' },
  { key: 'tool_name', label: '工具' },
  { key: 'status', label: '状态' },
];

const REVIEWS_TABLE_COLUMNS = [
  { key: 'review_id', label: '审查批次 ID' },
  { key: 'status_label', label: '状态' },
  { key: 'window_from', label: '窗口起' },
  { key: 'window_to', label: '窗口止' },
  { key: 'finding_count', label: '发现数' },
];

const DEAD_LETTER_COLUMNS = [
  { key: 'event_id', label: '事件 ID' },
  { key: 'error_code', label: '错误码' },
  { key: 'error_message', label: '错误信息' },
  { key: 'last_attempt_at', label: '最近尝试' },
];

const EVIDENCE_COLUMNS = [
  { key: 'event_id', label: '日志 ID' },
  { key: 'agent_name', label: 'Agent 名称' },
  { key: 'agent_id', label: 'Agent ID' },
  { key: 'tool_name', label: '工具' },
  { key: 'ts', label: '时间' },
  { key: 'event', label: '事件' },
  { key: 'status', label: '状态' },
  { key: 'result_summary', label: '日志摘要' },
  { key: 'error_message', label: '错误详情' },
];

export function createVisualization({ reviewStore, config }) {
  const vizConfig = defaultVisualizationConfig(config);
  const baseUrl = vizConfig.baseUrl ?? 'http://127.0.0.1:9320';
  const dashboardPath = vizConfig.dashboardPath ?? '/dashboard';

  function dashboardUrlFor(reviewId) {
    return `${baseUrl}${dashboardPath}/audit-reviews/${encodeURIComponent(reviewId)}`;
  }
  function findingUrlFor(findingId) {
    return `${baseUrl}${dashboardPath}/audit-findings/${encodeURIComponent(findingId)}`;
  }

  function countOpenFindingsBySeverity() {
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    try {
      for (const sev of Object.keys(counts)) {
        const rows = reviewStore.listFindings({ limit: 1000, severity: sev, status: 'open' });
        counts[sev] = Array.isArray(rows) ? rows.length : 0;
      }
    } catch {
      // reviewStore may return a count instead; defensive default.
    }
    return counts;
  }

  function getDeadLetterCount() {
    try {
      return reviewStore.listDeadLetterCount?.() ?? 0;
    } catch {
      return 0;
    }
  }

  function overviewPage() {
    const openBySev = countOpenFindingsBySeverity();
    const deadLetters = getDeadLetterCount();
    const updatedAt = nowIso();

    const summary_metrics = [];
    if (openBySev.critical) summary_metrics.push({ label: SEVERITY_LABELS.critical, value: openBySev.critical, tone: 'critical' });
    if (openBySev.high) summary_metrics.push({ label: SEVERITY_LABELS.high, value: openBySev.high, tone: 'high' });
    if (openBySev.medium) summary_metrics.push({ label: SEVERITY_LABELS.medium, value: openBySev.medium, tone: 'medium' });
    if (openBySev.low) summary_metrics.push({ label: SEVERITY_LABELS.low, value: openBySev.low, tone: 'low' });
    if (deadLetters) summary_metrics.push({ label: '投递失败', value: deadLetters, tone: 'neutral' });

    // Latest findings
    let latestFindings = [];
    try {
      latestFindings = reviewStore.listFindings({ limit: 20 }) ?? [];
    } catch {
      latestFindings = [];
    }
    const findingRows = latestFindings.map((f) => ({
      title: f.title ?? '',
      severity_label: labelOf(SEVERITY_LABELS, f.severity),
      category_label: labelOf(CATEGORY_LABELS, f.category),
      agent_name: f.agent_name ?? f.agent_id ?? '',
      tool_name: f.tool_name ?? '',
      status: labelOf(STATUS_LABELS, f.status),
    }));

    // Recent reviews
    let runs = [];
    try {
      runs = reviewStore.listRuns({ limit: 20 }) ?? [];
    } catch {
      runs = [];
    }
    const reviewRows = runs.map((r) => ({
      review_id: r.review_id ?? '',
      status_label: labelOf(STATUS_LABELS, r.status),
      window_from: r.window_from ?? '',
      window_to: r.window_to ?? '',
      finding_count: r.finding_count ?? 0,
    }));

    const sections = [];
    if (findingRows.length > 0) {
      sections.push({
        id: 'latest_findings',
        title: '最新风险发现',
        type: 'table',
        columns: FINDINGS_TABLE_COLUMNS,
        rows: findingRows,
      });
    }
    if (reviewRows.length > 0) {
      sections.push({
        id: 'recent_reviews',
        title: '最近审查批次',
        type: 'table',
        columns: REVIEWS_TABLE_COLUMNS,
        rows: reviewRows,
      });
    }
    if (deadLetters > 0) {
      // Only surface the dead-letter section when there is a non-zero count.
      // The store does not expose row-level dead-letter listings via this method,
      // so we render a callout directing the operator to investigate.
      sections.push({
        id: 'dead_letters',
        title: '投递失败（Dead Letter）',
        type: 'callout',
        body: `当前有 ${deadLetters} 条投递失败的消息待处理。`,
      });
    }

    return {
      page: {
        title: '审计审查总览',
        subtitle: '最近审查与风险概览',
        updated_at: updatedAt,
      },
      summary_metrics,
      filters: [],
      sections,
    };
  }

  function reviewDetailPage(reviewId) {
    const run = reviewStore.getRun(reviewId);
    const updatedAt = nowIso();
    const reviewFindings = reviewStore.listFindings({ limit: 1000, reviewId }) ?? [];
    const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of reviewFindings) {
      if (severityCounts[f.severity] != null) severityCounts[f.severity] += 1;
    }
    const findingCount = (run && run.finding_count) ?? reviewFindings.length;
    const windowTitle = (run && run.window_from && run.window_to) ?
      `审查批次 ${run.window_from} ~ ${run.window_to}` :
      `审查批次 ${reviewId}`;

    const summary_metrics = [];
    if (severityCounts.critical) summary_metrics.push({ label: SEVERITY_LABELS.critical, value: severityCounts.critical, tone: 'critical' });
    if (severityCounts.high) summary_metrics.push({ label: SEVERITY_LABELS.high, value: severityCounts.high, tone: 'high' });
    if (severityCounts.medium) summary_metrics.push({ label: SEVERITY_LABELS.medium, value: severityCounts.medium, tone: 'medium' });
    if (severityCounts.low) summary_metrics.push({ label: SEVERITY_LABELS.low, value: severityCounts.low, tone: 'low' });
    if (findingCount) summary_metrics.push({ label: '发现总数', value: findingCount, tone: 'neutral' });

    const findingRows = reviewFindings.slice(0, 20).map((f) => ({
      title: f.title ?? '',
      severity_label: labelOf(SEVERITY_LABELS, f.severity),
      category_label: labelOf(CATEGORY_LABELS, f.category),
      agent_name: f.agent_name ?? f.agent_id ?? '',
      tool_name: f.tool_name ?? '',
      status: labelOf(STATUS_LABELS, f.status),
    }));

    const sections = [];
    if (findingRows.length > 0) {
      sections.push({
        id: 'top_findings',
        title: 'Top 风险发现',
        type: 'table',
        columns: FINDINGS_TABLE_COLUMNS,
        rows: findingRows,
      });
    }
    if (run) {
      const metaItems = [
        { label: '审查批次 ID', value: run.review_id ?? '' },
        { label: '状态', value: labelOf(STATUS_LABELS, run.status) },
        { label: '窗口起', value: run.window_from ?? '' },
        { label: '窗口止', value: run.window_to ?? '' },
        { label: '发现数', value: run.finding_count ?? 0 },
        { label: '风险策略版本', value: run.risk_policy_version ?? '' },
        { label: '提示词版本', value: run.prompt_version ?? '' },
        { label: '审查器版本', value: run.reviewer_version ?? '' },
        { label: 'LLM 模型', value: run.llm_model ?? '' },
      ].filter((item) => item.value !== '' && item.value !== 0);
      if (metaItems.length > 0) {
        sections.push({
          id: 'run_metadata',
          title: '审查运行元数据',
          type: 'definition_list',
          items: metaItems,
        });
      }
    }

    return {
      page: {
        title: windowTitle,
        subtitle: `审查批次 ${reviewId}`,
        updated_at: updatedAt,
      },
      summary_metrics,
      filters: [],
      sections,
    };
  }

  function findingDetailPage(findingId) {
    const finding = reviewStore.getFinding(findingId);
    const updatedAt = nowIso();
    if (!finding) {
      return {
        page: { title: '风险发现不存在', subtitle: `Finding ${findingId}`, updated_at: updatedAt },
        summary_metrics: [],
        filters: [],
        sections: [
          { id: 'not_found', type: 'callout', title: '未找到', body: `未找到 finding ${findingId}` },
        ],
      };
    }

    const reviewId = finding.review_id;
    const linkedReviewUrl = reviewId ?
      `${dashboardPath}/audit-reviews/${encodeURIComponent(reviewId)}` :
      null;

    const summary_metrics = [
      { label: '严重程度', value: labelOf(SEVERITY_LABELS, finding.severity), tone: finding.severity ?? 'neutral' },
      { label: '类别', value: labelOf(CATEGORY_LABELS, finding.category), tone: 'neutral' },
      { label: '状态', value: labelOf(STATUS_LABELS, finding.status), tone: 'neutral' },
    ].filter((metric) => metric.value !== '' && metric.value !== null && metric.value !== undefined);

    const definitionItems = [
      { label: 'Finding ID', value: finding.finding_id ?? '' },
      { label: '审查批次 ID', value: finding.review_id ?? '' },
      { label: 'Agent ID', value: finding.agent_id ?? '' },
      { label: 'Agent 名称', value: finding.agent_name ?? '' },
      { label: '工具', value: finding.tool_name ?? '' },
      { label: 'Trace ID', value: finding.trace_id ?? '' },
      { label: '产品 ID', value: finding.product_id ?? '' },
      { label: '建议处置', value: finding.recommendation ?? '' },
    ];

    // Evidence rows: flatten log_detail into top-level keys for the table columns.
    const evidenceRows = Array.isArray(finding.evidence) ? finding.evidence.map((ev) => {
      const ld = ev.log_detail ?? {};
      return {
        event_id: ev.event_id ?? '',
        agent_name: ev.agent_name ?? '',
        agent_id: ev.agent_id ?? '',
        tool_name: ev.tool_name ?? '',
        ts: ld.ts ?? '',
        event: ld.event ?? '',
        status: ld.status ?? '',
        result_summary: ld.result_summary ?? '',
        error_message: ld.error_message ?? '',
      };
    }) : [];

    const sections = [];
    if (definitionItems.some((item) => item.value !== '' && item.value !== null && item.value !== undefined)) {
      sections.push({
        id: 'finding_detail',
        title: '风险发现详情',
        type: 'definition_list',
        items: definitionItems,
      });
    }
    if (evidenceRows.length > 0) {
      sections.push({
        id: 'evidence_events',
        title: '证据日志',
        type: 'table',
        columns: EVIDENCE_COLUMNS,
        rows: evidenceRows,
      });
    }
    if (linkedReviewUrl) {
      sections.push({
        id: 'linked_review',
        title: '关联审查批次',
        type: 'link_list',
        links: [{ href: linkedReviewUrl, label: `审查批次 ${reviewId}` }],
      });
    }

    return {
      page: {
        title: finding.title ?? `风险发现 ${findingId}`,
        subtitle: `风险发现 ${findingId}`,
        updated_at: updatedAt,
      },
      summary_metrics,
      filters: [],
      sections,
    };
  }

  return {
    dashboardUrlFor,
    findingUrlFor,
    overviewPage,
    reviewDetailPage,
    findingDetailPage,
  };
}