// src/auditReview/visualization.js
// Build template input objects for the dashboard pages.

function defaultVisualizationConfig(config) {
  return config?.auditReview?.visualization ?? {};
}

function nowIso() {
  return new Date().toISOString();
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

  function countOpenFindingsBySeverity() {
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    try {
      for (const sev of Object.keys(counts)) {
        const rows = reviewStore.listFindings({ limit: 1000, severity: sev, status: 'open' });
        counts[sev] = rows.length;
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

    return {
      page: {
        title: '审计审查 Dashboard',
        subtitle: '最近审查风险概览',
        updated_at: updatedAt,
      },
      summary_metrics: [
        { label: 'Critical', value: openBySev.critical, tone: 'critical' },
        { label: 'High', value: openBySev.high, tone: 'high' },
        { label: 'Medium', value: openBySev.medium, tone: 'medium' },
        { label: 'Low', value: openBySev.low, tone: 'low' },
        { label: 'Dead Letters', value: deadLetters, tone: 'neutral' },
      ],
      filters: [
        { id: 'severity', type: 'select', label: 'Severity' },
        { id: 'category', type: 'select', label: 'Category' },
        { id: 'agent_id', type: 'select', label: 'Agent' },
        { id: 'tool_name', type: 'select', label: 'Tool' },
        { id: 'status', type: 'select', label: 'Status' },
      ],
      sections: [
        {
          id: 'latest_findings',
          title: '最新风险',
          type: 'table',
          data_source: '/v1/audit-findings?limit=20',
        },
        {
          id: 'recent_reviews',
          title: '最近审查批次',
          type: 'table',
          data_source: '/v1/audit-reviews?limit=20',
        },
        {
          id: 'dead_letters',
          title: 'Dead Letter 投递失败',
          type: 'table',
          data_source: '/v1/audit-outbox/dead-letters',
        },
      ],
    };
  }

  function reviewDetailPage(reviewId) {
    const run = reviewStore.getRun(reviewId);
    const updatedAt = nowIso();
    const reviewFindings = reviewStore.listFindings({ limit: 1000, reviewId });
    const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of reviewFindings) {
      if (severityCounts[f.severity] != null) severityCounts[f.severity] += 1;
    }
    const findingCount = (run && run.finding_count) ?? reviewFindings.length;
    const windowTitle = (run && run.window_from && run.window_to) ?
      `审查批次 ${run.window_from} ~ ${run.window_to}` :
      `审查批次 ${reviewId}`;

    return {
      page: {
        title: windowTitle,
        subtitle: `Review ${reviewId}`,
        updated_at: updatedAt,
      },
      summary_metrics: [
        { label: 'Critical', value: severityCounts.critical || 0, tone: 'critical' },
        { label: 'High', value: severityCounts.high || 0, tone: 'high' },
        { label: 'Medium', value: severityCounts.medium || 0, tone: 'medium' },
        { label: 'Low', value: severityCounts.low || 0, tone: 'low' },
        { label: 'Findings', value: findingCount, tone: 'neutral' },
      ],
      filters: [],
      sections: [
        {
          id: 'top_findings',
          title: 'Top 风险发现',
          type: 'table',
          data_source: `/v1/audit-findings?review_id=${encodeURIComponent(reviewId)}&limit=20`,
        },
        {
          id: 'run_metadata',
          title: '审查运行元数据',
          type: 'metadata',
          data_source: `/v1/audit-reviews/${encodeURIComponent(reviewId)}`,
        },
      ],
    };
  }

  function findingDetailPage(findingId) {
    const finding = reviewStore.getFinding(findingId);
    const updatedAt = nowIso();
    const traceId = finding?.trace_id;
    const reviewId = finding?.review_id;
    const evidenceDataSource = traceId ?
      `/query?trace_id=${encodeURIComponent(traceId)}` :
      null;
    const linkedReviewUrl = reviewId ?
      `/dashboard/audit-reviews/${encodeURIComponent(reviewId)}` :
      null;

    return {
      page: {
        title: finding?.title ?? `Finding ${findingId}`,
        subtitle: `Finding ${findingId}`,
        updated_at: updatedAt,
      },
      summary_metrics: [
        { label: 'Severity', value: finding?.severity ?? 'unknown', tone: finding?.severity ?? 'neutral' },
        { label: 'Category', value: finding?.category ?? '-', tone: 'neutral' },
        { label: 'Status', value: finding?.status ?? 'open', tone: 'neutral' },
        { label: 'Confidence', value: finding?.confidence ?? '-', tone: 'neutral' },
      ],
      filters: [],
      sections: [
        {
          id: 'finding_detail',
          title: 'Finding 详情',
          type: 'metadata',
          data_source: `/v1/audit-findings/${encodeURIComponent(findingId)}`,
        },
        {
          id: 'evidence_table',
          title: 'Evidence Events',
          type: 'table',
          data_source: evidenceDataSource,
        },
        {
          id: 'linked_review',
          title: '关联审查批次',
          type: 'link',
          data_source: linkedReviewUrl,
        },
      ],
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