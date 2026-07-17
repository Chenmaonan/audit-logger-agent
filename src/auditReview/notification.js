// src/auditReview/notification.js
// Build generic audit review delivery payloads and enqueue them into the outbox.
// Payload types `audit_review_summary` / `audit_review_finding` are generic
// delivery payloads: they are platform-agnostic and rely on the outbox flush
// mechanism to deliver them to whatever callback receiver is configured.

import crypto from 'crypto';
import { buildHighRiskAlertPayloads, groupHighRiskFindings } from './feishuCards.js';
import { agentDisplayName } from './evidence.js';

const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'];

function severityRank(severity) {
  const idx = SEVERITY_ORDER.indexOf(severity);
  return idx === -1 ? 0 : idx;
}

export function meetsMinSeverity(severity, min) {
  return severityRank(severity) >= severityRank(min);
}

function defaultNotificationConfig(config) {
  return config?.auditReview?.notification ?? {};
}

function pickTopFindings(findings, limit = 5) {
  if (!Array.isArray(findings)) return [];
  return [...findings]
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, limit)
    .map((f) => ({
      finding_id: f.finding_id ?? f.id,
      severity: f.severity,
      category: f.category,
      title: f.title,
      agent_id: f.agent_id,
      agent_name: f.agent_name ?? f.evidence?.[0]?.agent_name ?? f.agent_id,
      tool_name: f.tool_name,
      summary: f.summary,
    }));
}

export function buildSummaryPayload({ reviewId, run, review, dashboardUrl }) {
  const severityCounts = review?.summary?.severity_counts ?? { critical: 0, high: 0, medium: 0, low: 0 };
  const totalFindings = (severityCounts.critical || 0) + (severityCounts.high || 0) +
    (severityCounts.medium || 0) + (severityCounts.low || 0);
  const title = review?.summary?.title ?? `审计审查发现 ${totalFindings} 个问题`;
  const overview = review?.summary?.overview ?? `审查 ${run?.candidate_event_count ?? 0} 条事件，发现 ${totalFindings} 个风险。`;
  const windowFrom = run?.window_from ?? review?.window?.from;
  const windowTo = run?.window_to ?? review?.window?.to;

  return {
    type: 'audit_review_summary',
    review_id: reviewId,
    title,
    summary: overview,
    dashboard_url: dashboardUrl,
    window: { from: windowFrom, to: windowTo },
    severity_counts: severityCounts,
    top_findings: pickTopFindings(review?.findings, 5),
    actions: [
      { id: 'open_dashboard', label: '打开 Dashboard', url: dashboardUrl },
    ],
  };
}

export function buildFindingPayload({ finding, reviewId, run, dashboardUrl }) {
  const windowFrom = run?.window_from;
  const windowTo = run?.window_to;
  return {
    type: 'audit_review_finding',
    review_id: reviewId,
    finding_id: finding.finding_id ?? finding.id,
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    summary: finding.summary,
    recommendation: finding.recommendation,
    agent_id: finding.agent_id,
    agent_name: finding.agent_name ?? finding.evidence?.[0]?.agent_name ?? finding.agent_id,
    tool_name: finding.tool_name,
    trace_id: finding.trace_id,
    entity: finding.entity ?? (
      finding.entity_type || finding.entity_id
        ? { type: finding.entity_type ?? null, id: finding.entity_id ?? null }
        : null
    ),
    evidence: Array.isArray(finding.evidence) ? finding.evidence.slice(0, 5) : [],
    dashboard_url: dashboardUrl,
    window: { from: windowFrom, to: windowTo },
    actions: [
      { id: 'open_dashboard', label: '打开 Dashboard', url: dashboardUrl },
    ],
  };
}

function dedupeIdentity(prefix, values) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 24);
  return `${prefix}:${digest}`;
}

export function createReviewNotifier({ outboxStore, config, feishuMode = 'disabled' }) {
  const notifyConfig = defaultNotificationConfig(config);
  const notificationsEnabled = notifyConfig.enabled !== false;
  const minSeverity = notifyConfig.minSeverity ?? 'medium';
  const sendEmptyReview = notifyConfig.sendEmptyReview ?? false;
  const callbackUrl = notifyConfig.callbackUrl;
  const deliveryMode = notifyConfig.mode ?? 'callback';
  const maxAttempts = notifyConfig.maxAttempts;
  const cardConfig = notifyConfig.card ?? {};
  const agentsConfig = config?.agents
    ? config
    : (config?.auditReview?.agents ? { agents: config.auditReview.agents } : config);

  function enqueue({ reviewId, run, review, dashboardUrl }) {
    if (!notificationsEnabled) {
      return { enqueued: false, reason: 'disabled' };
    }
    const findings = review?.findings ?? [];
    if (findings.length === 0 && !sendEmptyReview) {
      return { enqueued: false, reason: 'empty' };
    }
    if (deliveryMode === 'feishu_bot') {
      return { enqueued: false, reason: 'feishu_high_risk_group_only' };
    }

    const payload = buildSummaryPayload({ reviewId, run, review, dashboardUrl });
    outboxStore.enqueue({
      runId: reviewId,
      type: 'audit_review_summary',
      payload,
      deliveryMode,
      callbackUrl,
      maxAttempts,
    });
    return { enqueued: true, payload };
  }

  function enqueueFinding({ finding, reviewId, run, dashboardUrl }) {
    if (!notificationsEnabled) {
      return { enqueued: false, reason: 'disabled' };
    }
    const sev = finding.severity;
    if (!meetsMinSeverity(sev, 'high')) {
      return { enqueued: false, reason: 'below_high' };
    }
    if (deliveryMode === 'feishu_bot') {
      return enqueueHighRiskGroups({ findings: [finding], reviewId, run, dashboardUrl });
    }
    const payload = buildFindingPayload({ finding, reviewId, run, dashboardUrl });
    outboxStore.enqueue({
      runId: reviewId,
      type: 'audit_review_finding',
      payload,
      deliveryMode,
      callbackUrl,
      maxAttempts,
    });
    return { enqueued: true, payload };
  }

  function enqueueHighRiskGroups({ findings, reviewId, run, dashboardUrl }) {
    if (!notificationsEnabled) {
      return { enqueued: false, reason: 'disabled', groups: [] };
    }
    const groups = groupHighRiskFindings(findings);
    if (groups.length === 0) {
      return { enqueued: false, reason: 'below_high', groups: [] };
    }
    if (deliveryMode !== 'feishu_bot') {
      const results = groups.flatMap((group) => group.findings.map((finding) =>
        enqueueFinding({ finding, reviewId, run, dashboardUrl })));
      return {
        enqueued: results.some((result) => result.enqueued),
        groups,
        results,
      };
    }
    if (feishuMode === 'disabled') {
      return { enqueued: false, reason: 'disabled', groups: [] };
    }

    const rendered = groups.map((group) => {
      const agentName = agentDisplayName(group.agentId, agentsConfig);
      return {
        ...group,
        agentName,
        payloads: buildHighRiskAlertPayloads({
          reviewId,
          window: { from: run?.window_from, to: run?.window_to },
          agentId: group.agentId,
          agentName,
          traceId: group.traceId,
          findings: group.findings,
          dashboardUrl,
          maxPayloadBytes: cardConfig.maxPayloadBytes,
          foldThresholdChars: cardConfig.foldThresholdChars,
        }),
      };
    });
    if (feishuMode === 'dry-run') {
      return { enqueued: false, reason: 'dry_run', groups: rendered };
    }

    let enqueuedCount = 0;
    for (const group of rendered) {
      group.payloads.forEach((payload, index) => {
        const result = outboxStore.enqueue({
          runId: reviewId,
          type: 'audit_review_high_risk_group',
          payload,
          deliveryMode: 'feishu_bot',
          callbackUrl: null,
          maxAttempts,
          dedupeKey: dedupeIdentity('feishu_alert', [reviewId, group.agentId, group.traceId, index]),
        });
        if (result?.enqueued !== false) enqueuedCount += 1;
      });
    }
    return {
      enqueued: enqueuedCount > 0,
      enqueuedCount,
      groups: rendered,
    };
  }

  return {
    enqueue,
    enqueueFinding,
    enqueueHighRiskGroups,
    buildSummaryPayload,
    buildFindingPayload,
    meetsMinSeverity,
  };
}

export { SEVERITY_ORDER };
