import {
  estimateTokensForPayload,
  llmBudgetFromConfig,
  llmUsageDayKey,
  usageWouldExceedBudget,
} from './llmBudget.js';

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
  ok: '正常',
  error: '错误',
};
const CATEGORY_LABELS = {
  high_risk_permission: '高危权限/变更',
  anomalous_call: '异常调用',
  repeated_call: '重复调用',
  failed_call: '失败调用',
  trace_integrity: '链路完整性',
  ingest_parse_error: '日志解析错误',
};

const OVERVIEW_FINDINGS_COLUMNS = [
  { key: 'title', label: '标题' },
  { key: 'severity_label', label: '严重程度' },
  { key: 'category_label', label: '类别' },
  { key: 'agent_name', label: 'Agent' },
  { key: 'tool_name', label: '工具' },
  { key: 'trace_id', label: '链路 ID' },
  { key: 'status', label: '状态' },
  { key: 'review_id', label: '所属审查批次' },
  { key: 'last_seen_at', label: '最近出现时间' },
];

const REVIEW_FINDINGS_COLUMNS = [
  { key: 'title', label: '标题' },
  { key: 'severity_label', label: '严重程度' },
  { key: 'category_label', label: '类别' },
  { key: 'agent_name', label: 'Agent' },
  { key: 'tool_name', label: '工具' },
  { key: 'trace_id', label: '链路 ID' },
  { key: 'status', label: '状态' },
  { key: 'evidence_count', label: '证据数' },
];

const REVIEWS_TABLE_COLUMNS = [
  { key: 'review_id', label: '审查批次 ID' },
  { key: 'status_label', label: '状态' },
  { key: 'time_window', label: '时间窗口' },
  { key: 'finding_count', label: '发现数' },
  { key: 'trigger_type', label: '触发方式' },
  { key: 'finished_at', label: '完成时间' },
];

const TRACE_ANALYSIS_SYSTEM_PROMPT = [
  'You analyze audit-log tool call traces for a Chinese audit dashboard.',
  'Return ONLY a JSON object matching the schema. No markdown, no prose outside JSON.',
  'Explain the likely purpose of the tool calls, the call order, and risks visible in the trace.',
  'All narrative fields MUST be written in Simplified Chinese. Keep tool names, IDs, trace IDs, and error codes verbatim.',
  'Do not invent events or outcomes that are not present in the provided trace.',
].join('\n');

function traceAnalysisJsonSchema() {
  return {
    type: 'json_schema',
    name: 'audit_trace_analysis',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        purpose: { type: 'string', maxLength: 300 },
        chain_summary: { type: 'string', maxLength: 500 },
        risk_points: {
          type: 'array',
          items: { type: 'string', maxLength: 220 },
          maxItems: 5,
        },
        next_actions: {
          type: 'array',
          items: { type: 'string', maxLength: 220 },
          maxItems: 5,
        },
      },
      required: ['purpose', 'chain_summary', 'risk_points', 'next_actions'],
    },
  };
}

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

function isPresent(value) {
  return value !== '' && value !== null && value !== undefined;
}

function formatTime(iso) {
  return iso ? String(iso) : '';
}

function severityRank(severity) {
  switch (severity) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

function severityTone(severity) {
  return ['critical', 'high', 'medium', 'low'].includes(severity) ? severity : 'neutral';
}

function statusTone(status) {
  switch (status) {
    case 'completed':
    case 'resolved':
    case 'ok':
      return 'success';
    case 'completed_degraded':
      return 'medium';
    case 'failed':
    case 'error':
      return 'critical';
    case 'open':
      return 'high';
    case 'snoozed':
      return 'low';
    case 'acknowledged':
    case 'running':
    case 'skipped':
    default:
      return 'neutral';
  }
}

function triggerLabel(triggerType) {
  if (triggerType === 'scheduled') return '定时';
  if (triggerType === 'manual') return '手动';
  return triggerType ?? '—';
}

function compareByIsoDesc(left, right) {
  const a = left ? Date.parse(left) : Number.NEGATIVE_INFINITY;
  const b = right ? Date.parse(right) : Number.NEGATIVE_INFINITY;
  return b - a;
}

function compareTraceEventsAsc(left, right) {
  const a = left?.ts ? Date.parse(left.ts) : Number.POSITIVE_INFINITY;
  const b = right?.ts ? Date.parse(right.ts) : Number.POSITIVE_INFINITY;
  if (a !== b) return a - b;
  const leftId = Number(left?.id ?? left?.event_id ?? 0);
  const rightId = Number(right?.id ?? right?.event_id ?? 0);
  return leftId - rightId;
}

function orderedTraceEvents(events) {
  return Array.isArray(events) ? events.slice().sort(compareTraceEventsAsc) : [];
}

function compareFindings(left, right) {
  const severityDelta = severityRank(right?.severity) - severityRank(left?.severity);
  if (severityDelta !== 0) return severityDelta;
  const leftOpen = left?.status === 'open' ? 1 : 0;
  const rightOpen = right?.status === 'open' ? 1 : 0;
  if (rightOpen !== leftOpen) return rightOpen - leftOpen;
  return compareByIsoDesc(lastSeenAtOf(left), lastSeenAtOf(right));
}

function formatWindow(run) {
  const from = formatTime(run?.window_from);
  const to = formatTime(run?.window_to);
  if (from && to) return `${from} ~ ${to}`;
  return from || to || '—';
}

function evidenceTimestamp(ev) {
  return ev?.log_detail?.ts ?? ev?.ts ?? '';
}

function evidenceEventIdsOf(finding) {
  if (Array.isArray(finding?.evidence_event_ids) && finding.evidence_event_ids.length > 0) {
    return finding.evidence_event_ids;
  }
  if (!Array.isArray(finding?.evidence)) return [];
  return finding.evidence.map((ev) => ev?.event_id).filter((eventId) => eventId !== null && eventId !== undefined);
}

function lastSeenAtOf(finding) {
  if (finding?.last_seen_at) return finding.last_seen_at;
  if (!Array.isArray(finding?.evidence)) return '';
  return finding.evidence
    .map((ev) => evidenceTimestamp(ev))
    .filter(Boolean)
    .sort((a, b) => compareByIsoDesc(a, b))[0] ?? '';
}

function traceSequenceSteps(events) {
  return orderedTraceEvents(events).map((event, index) => ({
    order: index + 1,
    timestamp: formatTime(event.ts),
    event: event.event ?? '',
    status: {
      text: labelOf(STATUS_LABELS, event.status),
      tone: statusTone(event.status),
    },
    tool_name: event.tool_name ?? '',
    span_id: event.span_id ?? '',
    parent_span_id: event.parent_span_id ?? '',
    duration_ms: isPresent(event.duration_ms) ? `${event.duration_ms} ms` : '',
    summary: event.result_summary ?? '',
    error_message: event.error_message ?? '',
  }));
}

function compactTraceEventForLlm(event, index) {
  return {
    order: index + 1,
    event_id: event.id ?? event.event_id ?? null,
    ts: event.ts ?? null,
    event: event.event ?? null,
    status: event.status ?? null,
    tool_name: event.tool_name ?? null,
    trace_id: event.trace_id ?? null,
    span_id: event.span_id ?? null,
    parent_span_id: event.parent_span_id ?? null,
    duration_ms: event.duration_ms ?? null,
    result_summary: event.result_summary ?? null,
    error_message: event.error_message ?? null,
  };
}

function buildTraceAnalysisInput({ finding, traceEvents }) {
  const orderedEvents = orderedTraceEvents(traceEvents);
  const payload = {
    finding: {
      finding_id: finding.finding_id ?? null,
      title: finding.title ?? null,
      severity: finding.severity ?? null,
      category: finding.category ?? null,
      summary: finding.summary ?? null,
      recommendation: finding.recommendation ?? null,
      agent_id: finding.agent_id ?? null,
      agent_name: finding.agent_name ?? null,
      tool_name: finding.tool_name ?? null,
      trace_id: finding.trace_id ?? null,
      product_id: finding.product_id ?? null,
    },
    trace_events: orderedEvents.map(compactTraceEventForLlm),
  };

  return [
    { role: 'system', content: TRACE_ANALYSIS_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(payload) },
  ];
}

function boundedText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function boundedTextList(value, { maxItems, maxLength }) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => boundedText(item, maxLength))
    .filter(isPresent)
    .slice(0, maxItems);
}

function localTraceChainSummary(traceEvents) {
  const orderedEvents = orderedTraceEvents(traceEvents);
  if (orderedEvents.length === 0) return '';
  const chain = orderedEvents.map((event, index) => {
    const toolName = event.tool_name ?? '未知工具';
    const eventName = event.event ?? '未知事件';
    const status = labelOf(STATUS_LABELS, event.status) || event.status || '未知状态';
    return `${index + 1}. ${toolName} ${eventName}（${status}）`;
  }).join(' -> ');
  const errors = orderedEvents.map((event) => event.error_message).filter(isPresent);
  const lastError = errors[errors.length - 1];
  return lastError ? `按时间顺序：${chain}。末尾错误：${lastError}` : `按时间顺序：${chain}。`;
}

function normalizeTraceAnalysis(raw, traceEvents = []) {
  if (!raw || typeof raw !== 'object') throw new Error('LLM 链路分析结果不是对象');
  const analysis = {
    purpose: boundedText(raw.purpose, 300),
    chain_summary: boundedText(raw.chain_summary, 500) || localTraceChainSummary(traceEvents),
    risk_points: boundedTextList(raw.risk_points, { maxItems: 5, maxLength: 220 }),
    next_actions: boundedTextList(raw.next_actions, { maxItems: 5, maxLength: 220 }),
  };
  if (!isPresent(analysis.purpose) && !isPresent(analysis.chain_summary)) {
    throw new Error('LLM 链路分析缺少 purpose 或 chain_summary');
  }
  return analysis;
}

function isFreshAnalysisCache(finding) {
  if (!finding?.llm_analysis || typeof finding.llm_analysis !== 'object') return false;
  if (!isPresent(finding.analysis_generated_at)) return false;
  if (!isPresent(finding.last_seen_at)) return true;
  const generatedAt = Date.parse(finding.analysis_generated_at);
  const lastSeenAt = Date.parse(finding.last_seen_at);
  if (!Number.isFinite(generatedAt)) return false;
  if (!Number.isFinite(lastSeenAt)) return true;
  return generatedAt >= lastSeenAt;
}

function traceAnalysisSection({ analysis, model }) {
  return {
    id: 'trace_llm_analysis',
    title: 'LLM 閾捐矾鍒嗘瀽',
    type: 'trace_analysis',
    model,
    ...analysis,
  };
}

function traceAnalysisUnavailableSection(message) {
  return {
    id: 'trace_llm_analysis',
    title: 'LLM analysis unavailable',
    type: 'callout',
    body: message,
  };
}

function insertSectionAfter(sections, anchorId, section) {
  const anchorIndex = sections.findIndex((item) => item?.id === anchorId);
  const insertIndex = anchorIndex >= 0 ? anchorIndex + 1 : sections.length;
  sections.splice(insertIndex, 0, section);
}

export function createVisualization({ reviewStore, config, llmClient, model } = {}) {
  const vizConfig = defaultVisualizationConfig(config);
  const baseUrl = vizConfig.baseUrl ?? 'http://127.0.0.1:9320';
  const dashboardPath = vizConfig.dashboardPath ?? '/dashboard';
  const traceAnalysisModel = model ?? config?.auditReview?.llmReview?.model ?? config?.planner?.model ?? null;
  const cacheDetailAnalysis = config?.auditReview?.llmBudget?.cacheDetailAnalysis !== false;
  const llmBudget = llmBudgetFromConfig(config);

  function dashboardUrlFor(reviewId) {
    return `${baseUrl}${dashboardPath}/audit-reviews/${encodeURIComponent(reviewId)}`;
  }

  function findingUrlFor(findingId) {
    return `${baseUrl}${dashboardPath}/audit-findings/${encodeURIComponent(findingId)}`;
  }

  function reviewUrl(reviewId) {
    return `${dashboardPath}/audit-reviews/${encodeURIComponent(reviewId)}`;
  }

  function findingUrl(findingId) {
    return `${dashboardPath}/audit-findings/${encodeURIComponent(findingId)}`;
  }

  function countOpenFindingsBySeverity() {
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    try {
      for (const severity of Object.keys(counts)) {
        const rows = reviewStore.listFindings({ limit: 1000, severity, status: 'open' });
        counts[severity] = Array.isArray(rows) ? rows.length : 0;
      }
    } catch {
      // reviewStore may throw or return a non-array count; keep zero defaults.
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

  function listRuns(limit = 20) {
    try {
      return reviewStore.listRuns?.({ limit }) ?? [];
    } catch {
      return [];
    }
  }

  function listFindings(limit = 1000, filters = {}) {
    try {
      return reviewStore.listFindings?.({ limit, ...filters }) ?? [];
    } catch {
      return [];
    }
  }

  function getRun(reviewId) {
    try {
      return reviewStore.getRun?.(reviewId) ?? null;
    } catch {
      return null;
    }
  }

  function getFinding(findingId) {
    try {
      return reviewStore.getFinding?.(findingId) ?? null;
    } catch {
      return null;
    }
  }

  function listTraceEvents(traceId, limit = 200) {
    if (!traceId) return [];
    try {
      const rows = reviewStore.listTraceEvents?.({ traceId, limit }) ?? [];
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  function listRawEventsByIds(eventIds, limit = 200) {
    if (!Array.isArray(eventIds) || eventIds.length === 0) return [];
    try {
      const rows = reviewStore.listRawEventsByIds?.({ eventIds, limit }) ?? [];
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  function traceTimelineHref(finding) {
    if (!finding?.trace_id || !finding?.finding_id) return undefined;
    return `${findingUrl(finding.finding_id)}#trace_sequence`;
  }

  function traceCellFor(finding) {
    if (!finding?.trace_id) return '';
    return {
      text: finding.trace_id,
      href: traceTimelineHref(finding),
      mono: true,
    };
  }

  function rawLogSnippets(events) {
    return events
      .filter((event) => isPresent(event?.raw_json))
      .map((event) => ({
        label: `日志 ID ${event.id}`,
        body: event.raw_json,
      }));
  }

  function overviewPage() {
    const openBySev = countOpenFindingsBySeverity();
    const deadLetters = getDeadLetterCount();
    const runs = listRuns(20);
    const findings = listFindings(1000).slice().sort(compareFindings);
    const updatedAt = nowIso();
    const openFindingTotal = Object.values(openBySev).reduce((sum, count) => sum + count, 0);
    const latestRun = runs[0] ?? null;

    const summary_metrics = [
      { label: SEVERITY_LABELS.critical, value: openBySev.critical, tone: 'critical', href: `${dashboardPath}?severity=critical#pending_findings` },
      { label: SEVERITY_LABELS.high, value: openBySev.high, tone: 'high', href: `${dashboardPath}?severity=high#pending_findings` },
      { label: SEVERITY_LABELS.medium, value: openBySev.medium, tone: 'medium', href: `${dashboardPath}?severity=medium#pending_findings` },
      { label: SEVERITY_LABELS.low, value: openBySev.low, tone: 'low', href: `${dashboardPath}?severity=low#pending_findings` },
      { label: '投递失败', value: deadLetters, tone: deadLetters > 0 ? 'critical' : 'neutral', href: `${dashboardPath}#dead_letters` },
    ];

    const context_badges = [];
    if (latestRun) {
      context_badges.push({
        label: `最近运行状态：${labelOf(STATUS_LABELS, latestRun.status)}`,
        tone: statusTone(latestRun.status),
      });
    }
    context_badges.push({
      label: `开放 finding 总数：${openFindingTotal}`,
      tone: openFindingTotal > 0 ? 'high' : 'neutral',
    });
    if (deadLetters > 0) {
      context_badges.push({
        label: `投递失败：${deadLetters}`,
        tone: 'critical',
      });
    }

    const page_actions = [];
    const latestRunWithFindings = runs.find((run) => (run?.finding_count ?? 0) > 0 && run?.review_id);
    if (latestRunWithFindings) {
      page_actions.push({
        label: '进入最新有发现批次',
        href: reviewUrl(latestRunWithFindings.review_id),
      });
    }
    const highestSeverityOpenFinding = findings.find((finding) => finding?.status === 'open' && finding?.finding_id);
    if (highestSeverityOpenFinding) {
      page_actions.push({
        label: '查看最高风险 finding',
        href: findingUrl(highestSeverityOpenFinding.finding_id),
      });
    }
    const degradedRun = runs.find((run) => run?.status === 'completed_degraded' && run?.review_id);
    if (degradedRun) {
      page_actions.push({
        label: '查看最近一次降级完成批次',
        href: reviewUrl(degradedRun.review_id),
      });
    }
    page_actions.forEach((action, index) => {
      action.kind = index === 0 ? 'primary' : 'secondary';
    });

    const findingRows = findings.map((finding) => ({
      title: {
        text: finding.title ?? '',
        href: finding.finding_id ? findingUrl(finding.finding_id) : undefined,
      },
      severity_label: {
        text: labelOf(SEVERITY_LABELS, finding.severity),
        tone: severityTone(finding.severity),
      },
      category_label: labelOf(CATEGORY_LABELS, finding.category),
      agent_name: finding.agent_name ?? finding.agent_id ?? '',
      tool_name: finding.tool_name ?? '',
      trace_id: traceCellFor(finding),
      status: {
        text: labelOf(STATUS_LABELS, finding.status),
        tone: statusTone(finding.status),
      },
      review_id: {
        text: finding.review_id ?? '',
        href: finding.review_id ? reviewUrl(finding.review_id) : undefined,
        mono: true,
        secondary: labelOf(STATUS_LABELS, getRun(finding.review_id)?.status),
      },
      last_seen_at: {
        text: formatTime(lastSeenAtOf(finding)),
        mono: true,
      },
    }));

    const runsWithFindings = runs.filter((run) => (run?.finding_count ?? 0) > 0);
    const runsWithoutFindings = runs.filter((run) => (run?.finding_count ?? 0) === 0);

    const reviewRowsFor = (rows, { includeSecondary }) => rows.map((run) => ({
      review_id: {
        text: run.review_id ?? '',
        href: run.review_id ? reviewUrl(run.review_id) : undefined,
        mono: true,
        secondary: includeSecondary ? `${run.finding_count ?? 0} 个发现` : undefined,
      },
      status_label: {
        text: labelOf(STATUS_LABELS, run.status),
        tone: statusTone(run.status),
      },
      time_window: {
        text: formatWindow(run),
        mono: true,
      },
      finding_count: {
        text: String(run.finding_count ?? 0),
        href: run.review_id ? reviewUrl(run.review_id) : undefined,
      },
      trigger_type: triggerLabel(run.trigger_type),
      finished_at: {
        text: formatTime(run.finished_at),
        mono: true,
      },
    }));

    const sections = [];
    if (findingRows.length > 0) {
      sections.push({
        id: 'pending_findings',
        title: '待处理风险发现',
        type: 'table',
        columns: OVERVIEW_FINDINGS_COLUMNS,
        rows: findingRows,
      });
    }
    if (runsWithFindings.length > 0) {
      sections.push({
        id: 'reviews_with_findings',
        title: '最近有发现的审查批次',
        type: 'table',
        columns: REVIEWS_TABLE_COLUMNS,
        rows: reviewRowsFor(runsWithFindings, { includeSecondary: true }),
      });
    }
    if (runsWithoutFindings.length > 0) {
      sections.push({
        id: 'reviews_without_findings',
        title: '最近完成但无发现的批次',
        type: 'table',
        columns: REVIEWS_TABLE_COLUMNS,
        rows: reviewRowsFor(runsWithoutFindings, { includeSecondary: false }),
      });
    }
    if (deadLetters > 0) {
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
        subtitle: '最近审查、待处理风险与证据入口',
        updated_at: updatedAt,
        breadcrumbs: [{ label: '总览', href: dashboardPath }],
        context_badges,
        page_actions,
      },
      summary_metrics,
      filters: [],
      sections,
    };
  }

  function reviewDetailPage(reviewId) {
    const run = getRun(reviewId);
    const updatedAt = nowIso();
    const reviewFindings = listFindings(1000, { reviewId }).slice().sort(compareFindings);
    const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const finding of reviewFindings) {
      if (severityCounts[finding.severity] != null) severityCounts[finding.severity] += 1;
    }
    const findingCount = run?.finding_count ?? reviewFindings.length;

    const summary_metrics = [
      { label: SEVERITY_LABELS.critical, value: severityCounts.critical, tone: 'critical', href: `${reviewUrl(reviewId)}?severity=critical#review_findings` },
      { label: SEVERITY_LABELS.high, value: severityCounts.high, tone: 'high', href: `${reviewUrl(reviewId)}?severity=high#review_findings` },
      { label: SEVERITY_LABELS.medium, value: severityCounts.medium, tone: 'medium', href: `${reviewUrl(reviewId)}?severity=medium#review_findings` },
      { label: SEVERITY_LABELS.low, value: severityCounts.low, tone: 'low', href: `${reviewUrl(reviewId)}?severity=low#review_findings` },
      { label: '发现总数', value: findingCount, tone: 'neutral' },
    ];

    const context_badges = [];
    if (run?.status) {
      context_badges.push({
        label: labelOf(STATUS_LABELS, run.status),
        tone: statusTone(run.status),
      });
    }
    context_badges.push({ label: `${findingCount} 个发现`, tone: 'neutral' });
    context_badges.push({ label: triggerLabel(run?.trigger_type), tone: 'neutral' });

    const page_actions = [
      { label: '返回总览', href: dashboardPath, kind: 'secondary' },
    ];
    if (reviewFindings[0]?.finding_id) {
      page_actions.unshift({
        label: '查看最高风险 finding',
        href: findingUrl(reviewFindings[0].finding_id),
        kind: 'primary',
      });
    }

    const sections = [];
    if (run?.status === 'completed_degraded') {
      sections.push({
        id: 'degraded_notice',
        title: '降级完成说明',
        type: 'callout',
        body: '本轮审查以降级模式完成，结果可用于初步排查，但建议结合证据日志或后续批次复核。',
      });
    }
    if (run?.error_code) {
      const body = run.error_message ? `${run.error_code}：${run.error_message}` : String(run.error_code);
      sections.push({
        id: 'run_error',
        title: '运行错误',
        type: 'callout',
        body,
      });
    }
    if (reviewFindings.length > 0) {
      sections.push({
        id: 'review_findings',
        title: '本批次风险发现',
        type: 'table',
        columns: REVIEW_FINDINGS_COLUMNS,
        rows: reviewFindings.map((finding) => ({
          title: {
            text: finding.title ?? '',
            href: finding.finding_id ? findingUrl(finding.finding_id) : undefined,
          },
          severity_label: {
            text: labelOf(SEVERITY_LABELS, finding.severity),
            tone: severityTone(finding.severity),
          },
          category_label: labelOf(CATEGORY_LABELS, finding.category),
          agent_name: finding.agent_name ?? finding.agent_id ?? '',
          tool_name: finding.tool_name ?? '',
          trace_id: traceCellFor(finding),
          status: {
            text: labelOf(STATUS_LABELS, finding.status),
            tone: statusTone(finding.status),
          },
          evidence_count: {
            text: String(Array.isArray(finding.evidence) ? finding.evidence.length : 0),
            mono: true,
            secondary: Array.isArray(finding.evidence) && finding.evidence.length > 1 ? '多条证据' : undefined,
          },
        })),
      });
    }
    if (run) {
      const metaItems = [
        { label: '审查批次 ID', value: run.review_id ?? '' },
        { label: '状态', value: labelOf(STATUS_LABELS, run.status) },
        { label: '时间窗口', value: formatWindow(run) },
        { label: '发现数', value: run.finding_count ?? 0 },
        { label: '触发方式', value: triggerLabel(run.trigger_type) },
        { label: '完成时间', value: formatTime(run.finished_at) },
        { label: '风险策略版本', value: run.risk_policy_version ?? '' },
        { label: '提示词版本', value: run.prompt_version ?? '' },
        { label: '审查器版本', value: run.reviewer_version ?? '' },
        { label: 'LLM 模型', value: run.llm_model ?? '' },
        { label: '扫描文件数', value: run.scanned_files },
        { label: '候选事件数', value: run.candidate_event_count },
      ].filter((item) => isPresent(item.value));
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
        title: '审查批次',
        subtitle: formatWindow(run) || reviewId,
        updated_at: updatedAt,
        breadcrumbs: [
          { label: '总览', href: dashboardPath },
          { label: '审查批次', href: reviewUrl(reviewId) },
        ],
        context_badges,
        page_actions,
      },
      summary_metrics,
      filters: [],
      sections,
    };
  }

  function findingDetailPage(findingId) {
    const finding = getFinding(findingId);
    const updatedAt = nowIso();
    if (!finding) {
      return {
        page: {
          title: '风险发现不存在',
          subtitle: `Finding ${findingId}`,
          updated_at: updatedAt,
          breadcrumbs: [{ label: '总览', href: dashboardPath }],
          context_badges: [],
          page_actions: [{ label: '返回总览', href: dashboardPath, kind: 'secondary' }],
        },
        summary_metrics: [],
        filters: [],
        sections: [
          { id: 'not_found', type: 'callout', title: '未找到', body: `未找到 finding ${findingId}` },
        ],
      };
    }

    const reviewId = finding.review_id;
    const breadcrumbs = [{ label: '总览', href: dashboardPath }];
    if (reviewId) breadcrumbs.push({ label: '审查批次', href: reviewUrl(reviewId) });
    breadcrumbs.push({ label: '风险发现', href: findingUrl(findingId) });

    const context_badges = [
      { label: labelOf(SEVERITY_LABELS, finding.severity), tone: severityTone(finding.severity) },
      { label: labelOf(CATEGORY_LABELS, finding.category), tone: 'neutral' },
      { label: labelOf(STATUS_LABELS, finding.status), tone: statusTone(finding.status) },
      { label: finding.agent_name ?? finding.agent_id ?? '', tone: 'neutral' },
      { label: finding.tool_name ?? '', tone: 'neutral' },
    ].filter((badge) => isPresent(badge.label));

    const page_actions = [{ label: '返回总览', href: dashboardPath, kind: 'secondary' }];
    if (reviewId) {
      page_actions.unshift({ label: '返回审查批次', href: reviewUrl(reviewId), kind: 'primary' });
    }

    const definitionItems = [
      { label: '风险发现 ID', value: finding.finding_id ?? '' },
      { label: '审查批次 ID', value: finding.review_id ?? '' },
      { label: 'Agent 名称', value: finding.agent_name ?? '' },
      { label: '智能体 ID', value: finding.agent_id ?? '' },
      { label: '工具', value: finding.tool_name ?? '' },
      { label: '链路 ID', value: finding.trace_id ?? '' },
      { label: '产品 ID', value: finding.product_id ?? '' },
      { label: '最近出现时间', value: formatTime(lastSeenAtOf(finding)) },
    ].filter((item) => isPresent(item.value));

    const traceEvents = orderedTraceEvents(listTraceEvents(finding.trace_id, 200));
    const traceSteps = traceSequenceSteps(traceEvents);
    const rawEvidenceEvents = listRawEventsByIds(evidenceEventIdsOf(finding), 200);
    const rawEvidenceSnippets = rawLogSnippets(rawEvidenceEvents);

    const linkItems = [];
    if (reviewId) {
      linkItems.push({ href: reviewUrl(reviewId), label: '返回审查批次' });
    }
    linkItems.push({ href: dashboardPath, label: '返回总览' });

    const sections = [];
    if (isPresent(finding.summary)) {
      sections.push({
        id: 'finding_summary',
        title: '判定摘要',
        type: 'callout',
        body: finding.summary,
      });
    }
    if (isPresent(finding.recommendation)) {
      sections.push({
        id: 'recommendation',
        title: '建议处置',
        type: 'callout',
        body: finding.recommendation,
      });
    }
    if (definitionItems.length > 0) {
      sections.push({
        id: 'finding_detail',
        title: '基本信息',
        type: 'definition_list',
        items: definitionItems,
      });
    }
    if (traceSteps.length > 0) {
      sections.push({
        id: 'trace_sequence',
        title: `工具调用顺序（共 ${traceSteps.length} 步）`,
        type: 'trace_sequence',
        steps: traceSteps,
      });
    }
    if (traceSteps.length === 0 && isPresent(finding.trace_id)) {
      sections.push({
        id: 'trace_sequence_empty',
        title: '工具调用顺序',
        type: 'callout',
        body: `未找到链路 ID ${finding.trace_id} 对应的完整工具调用事件，请结合下方原始日志片段继续排查。`,
      });
    }
    if (rawEvidenceSnippets.length > 0) {
      sections.push({
        id: 'evidence_raw_logs',
        title: rawEvidenceSnippets.length > 1 ? `原始日志片段（共 ${rawEvidenceSnippets.length} 条）` : '原始日志片段',
        type: 'raw_log_list',
        snippets: rawEvidenceSnippets,
      });
    }
    if (linkItems.length > 0) {
      sections.push({
        id: 'linked_navigation',
        title: '关联链接',
        type: 'link_list',
        links: linkItems,
      });
    }

    return {
      page: {
        title: finding.title ?? `风险发现 ${findingId}`,
        subtitle: '风险发现',
        updated_at: updatedAt,
        breadcrumbs,
        context_badges,
        page_actions,
      },
      summary_metrics: [],
      filters: [],
      sections,
    };
  }

  async function findingDetailPageWithAnalysis(findingId) {
    const page = findingDetailPage(findingId);
    const finding = getFinding(findingId);
    if (!finding || !llmClient || !traceAnalysisModel || !Array.isArray(page.sections)) return page;

    const traceEvents = orderedTraceEvents(listTraceEvents(finding.trace_id, 200));
    if (traceEvents.length === 0) return page;

    if (cacheDetailAnalysis && isFreshAnalysisCache(finding)) {
      insertSectionAfter(page.sections, 'trace_sequence', traceAnalysisSection({
        analysis: finding.llm_analysis,
        model: traceAnalysisModel,
      }));
      return page;
    }

    try {
      const input = buildTraceAnalysisInput({ finding, traceEvents });
      const schema = traceAnalysisJsonSchema();
      const estimatedTokens = estimateTokensForPayload({ model: traceAnalysisModel, input, schema });
      const usageDay = llmUsageDayKey();
      const usage = reviewStore.getLlmUsage?.(usageDay) ?? { day: usageDay, calls: 0, est_tokens: 0 };
      if (usageWouldExceedBudget(usage, llmBudget, estimatedTokens)) {
        insertSectionAfter(page.sections, 'trace_sequence', traceAnalysisUnavailableSection(
          'Cannot generate trace analysis: llm_budget_exceeded',
        ));
        return page;
      }

      let raw;
      let llmError = null;
      try {
        raw = await llmClient.createStructuredResponse({
          model: traceAnalysisModel,
          input,
          schema,
        });
      } catch (error) {
        llmError = error;
      } finally {
        try {
          reviewStore.recordLlmUsage?.({ day: usageDay, calls: 1, estTokens: estimatedTokens });
        } catch {
          // Usage accounting failures must not break the detail page.
        }
      }
      if (llmError) throw llmError;
      const analysis = normalizeTraceAnalysis(raw, traceEvents);
      if (cacheDetailAnalysis) {
        try {
          reviewStore.saveFindingAnalysis?.(finding.finding_id, { analysis, generatedAt: nowIso() });
        } catch {
          // Cache write failures must not break the detail page.
        }
      }
      insertSectionAfter(page.sections, 'trace_sequence', {
        id: 'trace_llm_analysis',
        title: 'LLM 链路分析',
        type: 'trace_analysis',
        model: traceAnalysisModel,
        ...analysis,
      });
    } catch (error) {
      insertSectionAfter(page.sections, 'trace_sequence', {
        id: 'trace_llm_analysis',
        title: 'LLM 链路分析不可用',
        type: 'callout',
        body: `无法生成链路分析：${error?.message ?? String(error)}`,
      });
    }

    return page;
  }

  return {
    dashboardUrlFor,
    findingUrlFor,
    overviewPage,
    reviewDetailPage,
    findingDetailPage,
    findingDetailPageWithAnalysis,
  };
}
