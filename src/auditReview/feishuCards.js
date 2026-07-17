const FEISHU_WEBHOOK_MAX_BYTES = 20 * 1024;
const DEFAULT_MAX_PAYLOAD_BYTES = 19 * 1024;
const DEFAULT_FOLD_THRESHOLD_CHARS = 800;
const MAX_DETAIL_SEGMENT_CHARS = 1800;

function utf8Bytes(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function normalizedLimit(value, fallback, max = FEISHU_WEBHOOK_MAX_BYTES) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1024) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export function sanitizeFeishuText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/</g, '＜')
    .replace(/>/g, '＞')
    .replace(/\[/g, '［')
    .replace(/\]/g, '］')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function splitText(value, maxChars = MAX_DETAIL_SEGMENT_CHARS) {
  const text = sanitizeFeishuText(value);
  if (text.length <= maxChars) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let boundary = remaining.lastIndexOf('\n', maxChars);
    if (boundary < Math.floor(maxChars * 0.5)) boundary = remaining.lastIndexOf('。', maxChars);
    if (boundary < Math.floor(maxChars * 0.5)) boundary = maxChars;
    else boundary += 1;
    parts.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function normalizeSeverity(value) {
  return value === 'critical' ? 'critical' : 'high';
}

function findingEntries(findings) {
  const entries = [];
  for (const finding of findings) {
    const title = sanitizeFeishuText(finding.title || finding.tool_name || finding.category || '未命名风险');
    const summaryParts = splitText(finding.summary || '无摘要');
    summaryParts.forEach((summary, index) => {
      entries.push({
        kind: 'finding',
        severity: normalizeSeverity(finding.severity),
        title: summaryParts.length > 1 ? `${title}（${index + 1}/${summaryParts.length}）` : title,
        summary,
      });
    });
  }
  return entries;
}

function toolEntries(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => ({
    kind: 'tool',
    title: sanitizeFeishuText(tool.tool_name || 'unknown'),
    summary: `调用 ${Number(tool.total) || 0} 次，异常 ${Number(tool.error_count) || 0} 次`,
  }));
}

function entryMarkdown(entry, index) {
  const severity = entry.severity === 'critical' ? '严重' : entry.severity === 'high' ? '高风险' : null;
  const label = severity ? `［${severity}］` : '';
  return `**${index + 1}. ${label}${entry.title}**\n${entry.summary}`;
}

function identityMarkdown({ agentId, traceId }) {
  return [
    `**Agent ID**：${sanitizeFeishuText(agentId || 'unknown')}`,
    `**Trace ID**：${sanitizeFeishuText(traceId || 'unknown')}`,
  ].join('\n');
}

function detailElement(entries, { fold, title = '查看明细' } = {}) {
  const elements = entries.map((entry, index) => ({
    tag: 'markdown',
    content: entryMarkdown(entry, index),
  }));
  if (!fold) return elements;
  return [{
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'plain_text', content: `${title}（${entries.length} 项）` },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '16px 16px',
      },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px',
    elements,
  }];
}

function metadataElement(content) {
  return {
    tag: 'div',
    text: {
      tag: 'plain_text',
      content,
      text_size: 'notation',
      text_color: 'grey',
      text_align: 'left',
    },
  };
}

function envelope(card) {
  return { msg_type: 'interactive', card };
}

function baseCard({ title, subtitle, template, preview, elements }) {
  return envelope({
    schema: '2.0',
    config: {
      update_multi: true,
      enable_forward: false,
      width_mode: 'fill',
      summary: { content: preview },
    },
    header: {
      title: { tag: 'plain_text', content: title },
      subtitle: { tag: 'plain_text', content: subtitle },
      template,
      padding: '12px',
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      vertical_spacing: '8px',
      elements,
    },
  });
}

function safeHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function packEntries(entries, makePayload, maxPayloadBytes) {
  const chunks = [];
  let current = [];
  for (const entry of entries) {
    const candidate = [...current, entry];
    const payload = makePayload(candidate, 999, 999);
    if (current.length > 0 && utf8Bytes(payload) > maxPayloadBytes) {
      chunks.push(current);
      current = [entry];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  if (chunks.length === 0) chunks.push([]);
  return chunks.map((chunk, index) => {
    const payload = makePayload(chunk, index + 1, chunks.length);
    if (utf8Bytes(payload) > maxPayloadBytes) {
      throw new Error('Feishu card exceeds configured payload byte limit');
    }
    return payload;
  });
}

export function groupHighRiskFindings(findings) {
  const groups = new Map();
  const eligibleFindings = Array.isArray(findings) ? findings : [];
  for (const [index, finding] of eligibleFindings.entries()) {
    if (finding?.severity !== 'high' && finding?.severity !== 'critical') continue;
    const agentId = finding.agent_id ?? null;
    const traceId = finding.trace_id ?? null;
    const hasCompleteIdentity = agentId !== null && agentId !== '' && traceId !== null && traceId !== '';
    // Missing identity must fail isolated: otherwise unrelated findings with
    // null/empty IDs would collapse into one cross-source notification.
    const key = hasCompleteIdentity
      ? JSON.stringify([agentId, traceId])
      : JSON.stringify(['isolated_missing_identity', finding.finding_id ?? finding.id ?? index, index]);
    const group = groups.get(key) ?? { agentId, traceId, findings: [] };
    group.findings.push(finding);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function buildHighRiskAlertPayloads({
  reviewId,
  window,
  agentId,
  traceId,
  findings,
  dashboardUrl,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
  foldThresholdChars = DEFAULT_FOLD_THRESHOLD_CHARS,
} = {}) {
  const eligible = (Array.isArray(findings) ? findings : [])
    .filter((finding) => finding?.severity === 'high' || finding?.severity === 'critical');
  if (eligible.length === 0) return [];
  const entries = findingEntries(eligible);
  const criticalCount = eligible.filter((finding) => finding.severity === 'critical').length;
  const detailChars = entries.reduce((sum, entry) => sum + entry.title.length + entry.summary.length, 0);
  const shouldFold = entries.length > 2 || detailChars > Number(foldThresholdChars || DEFAULT_FOLD_THRESHOLD_CHARS);
  const byteLimit = normalizedLimit(maxPayloadBytes, DEFAULT_MAX_PAYLOAD_BYTES);
  const makePayload = (chunk, part, totalParts) => {
    const partLabel = totalParts > 1 ? `（${part}/${totalParts}）` : '';
    const primaryRisk = sanitizeFeishuText(eligible[0]?.title || '未命名风险');
    const elements = [
      {
        tag: 'markdown',
        content: [
          identityMarkdown({ agentId, traceId }),
          `**本批次风险**：${eligible.length} 条（严重 ${criticalCount} 条）`,
          `**首要风险**：${primaryRisk}`,
        ].join('\n'),
      },
      ...detailElement(chunk, { fold: shouldFold, title: '高风险日志名称与摘要' }),
      metadataElement(`批次 ${sanitizeFeishuText(reviewId || 'unknown')}｜${sanitizeFeishuText(window?.from || '')} 至 ${sanitizeFeishuText(window?.to || '')}`),
    ];
    const detailUrl = safeHttpUrl(dashboardUrl);
    if (detailUrl) {
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '查看审计详情' },
        type: 'default',
        width: 'default',
        behaviors: [{ type: 'open_url', default_url: detailUrl }],
      });
    }
    return baseCard({
      title: `高风险审计告警${partLabel}`,
      subtitle: `${sanitizeFeishuText(agentId || 'unknown')} / ${sanitizeFeishuText(traceId || 'unknown')}`,
      template: criticalCount > 0 ? 'carmine' : 'red',
      preview: `高风险审计告警：${sanitizeFeishuText(agentId || 'unknown')} / ${sanitizeFeishuText(traceId || 'unknown')}`,
      elements,
    });
  };
  return packEntries(entries, makePayload, byteLimit);
}

export function buildDailyReportPayloads({
  date,
  generatedAt,
  group,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
  foldThresholdChars = DEFAULT_FOLD_THRESHOLD_CHARS,
} = {}) {
  if (!group) return [];
  const findings = (Array.isArray(group.findings) ? group.findings : [])
    .filter((finding) => finding?.severity === 'high' || finding?.severity === 'critical');
  const entries = [...toolEntries(group.tools), ...findingEntries(findings)];
  const byteLimit = normalizedLimit(maxPayloadBytes, DEFAULT_MAX_PAYLOAD_BYTES);
  const detailChars = entries.reduce((sum, entry) => sum + entry.title.length + entry.summary.length, 0);
  const shouldFold = entries.length > 3 || detailChars > Number(foldThresholdChars || DEFAULT_FOLD_THRESHOLD_CHARS);
  const makePayload = (chunk, part, totalParts) => {
    const partLabel = totalParts > 1 ? `（${part}/${totalParts}）` : '';
    const highRiskCount = findings.length;
    const elements = [
      {
        tag: 'markdown',
        content: [
          identityMarkdown({ agentId: group.agent_id, traceId: group.trace_id }),
          `**事件数**：${Number(group.event_count) || 0}`,
          `**异常事件**：${Number(group.error_count) || 0}`,
          `**涉及工具**：${Number(group.tool_count) || 0}`,
          `**高风险发现**：${highRiskCount}`,
        ].join('\n'),
      },
      ...detailElement(chunk, { fold: shouldFold, title: '工具统计与风险明细' }),
      metadataElement(`统计日期 ${sanitizeFeishuText(date)}（Asia/Shanghai）｜更新于 ${sanitizeFeishuText(generatedAt)}`),
    ];
    return baseCard({
      title: `审计信息日报${partLabel}`,
      subtitle: `${sanitizeFeishuText(group.agent_id || 'unknown')} / ${sanitizeFeishuText(group.trace_id || 'unknown')}`,
      template: highRiskCount > 0 ? 'orange' : 'blue',
      preview: `审计日报：${sanitizeFeishuText(group.agent_id || 'unknown')} / ${sanitizeFeishuText(group.trace_id || 'unknown')}`,
      elements,
    });
  };
  return packEntries(entries, makePayload, byteLimit);
}

export function feishuPayloadBytes(payload) {
  return utf8Bytes(payload);
}

export { DEFAULT_MAX_PAYLOAD_BYTES, FEISHU_WEBHOOK_MAX_BYTES };
