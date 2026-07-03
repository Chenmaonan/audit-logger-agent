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

const EVIDENCE_COLUMNS = [
  { key: 'event_id', label: '日志 ID' },
  { key: 'ts', label: '时间' },
  { key: 'event', label: '事件' },
  { key: 'status', label: '状态' },
  { key: 'agent_name', label: 'Agent 名称' },
  { key: 'tool_name', label: '工具' },
  { key: 'result_summary', label: '日志摘要' },
  { key: 'error_message', label: '错误详情' },
];

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

function lastSeenAtOf(finding) {
  if (finding?.last_seen_at) return finding.last_seen_at;
  if (!Array.isArray(finding?.evidence)) return '';
  return finding.evidence
    .map((ev) => evidenceTimestamp(ev))
    .filter(Boolean)
    .sort((a, b) => compareByIsoDesc(a, b))[0] ?? '';
}

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
        body: '本轮审查以降级模式完成，结果可用于初步排查，但建议结合原始日志或后续批次复核。',
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
      { label: 'Finding ID', value: finding.finding_id ?? '' },
      { label: '审查批次 ID', value: finding.review_id ?? '' },
      { label: 'Agent 名称', value: finding.agent_name ?? '' },
      { label: 'Agent ID', value: finding.agent_id ?? '' },
      { label: '工具', value: finding.tool_name ?? '' },
      { label: 'Trace ID', value: finding.trace_id ?? '' },
      { label: '产品 ID', value: finding.product_id ?? '' },
      { label: '最近出现时间', value: formatTime(lastSeenAtOf(finding)) },
    ].filter((item) => isPresent(item.value));

    const evidenceRows = Array.isArray(finding.evidence)
      ? finding.evidence
          .slice()
          .sort((left, right) => Date.parse(evidenceTimestamp(left) || 0) - Date.parse(evidenceTimestamp(right) || 0))
          .map((ev) => {
            const details = ev.log_detail ?? {};
            return {
              event_id: String(ev.event_id ?? ''),
              ts: {
                text: formatTime(details.ts ?? ev.ts),
                mono: true,
              },
              event: details.event ?? '',
              status: {
                text: labelOf(STATUS_LABELS, details.status),
                tone: statusTone(details.status),
              },
              agent_name: ev.agent_name ?? '',
              tool_name: ev.tool_name ?? '',
              result_summary: details.result_summary ?? '',
              error_message: details.error_message ?? '',
              agent_id: ev.agent_id ?? '',
            };
          })
      : [];

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
    if (evidenceRows.length > 0) {
      sections.push({
        id: 'evidence_events',
        title: evidenceRows.length > 1 ? `证据日志（共 ${evidenceRows.length} 条）` : '证据日志',
        type: 'table',
        columns: EVIDENCE_COLUMNS,
        rows: evidenceRows,
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

  return {
    dashboardUrlFor,
    findingUrlFor,
    overviewPage,
    reviewDetailPage,
    findingDetailPage,
  };
}
