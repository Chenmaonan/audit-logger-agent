// src/auditReview/dashboardTemplate.js
// Renders a complete, self-contained HTML dashboard from a direct-data view model.
// No browser-side fetch — the template receives fully-populated sections and renders them directly.

const SEVERITY_TONES = {
  critical: { color: '#B42318', bg: '#fdecea', label: '严重' },
  high: { color: '#C2410C', bg: '#fff1e8', label: '高风险' },
  medium: { color: '#B7791F', bg: '#fff8e1', label: '中风险' },
  low: { color: '#475569', bg: '#f1f5f9', label: '低风险' },
  neutral: { color: '#475467', bg: '#f5f7fa', label: '信息' },
  success: { color: '#15803D', bg: '#ecfdf5', label: '成功' },
};

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function hasValue(value) {
  return value !== null && value !== undefined && value !== '' && value !== 0;
}

function visibleMetrics(metrics = []) {
  return metrics.filter((metric) => hasValue(metric.value));
}

function visibleSections(sections = []) {
  return sections.filter((section) => {
    if (section.type === 'table') return Array.isArray(section.rows) && section.rows.length > 0;
    if (section.type === 'definition_list') return Array.isArray(section.items) && section.items.some((item) => hasValue(item.value));
    if (section.type === 'link_list') return Array.isArray(section.links) && section.links.length > 0;
    if (section.type === 'callout') return hasValue(section.body) || hasValue(section.title);
    if (section.type === 'raw_log_list') return Array.isArray(section.snippets) && section.snippets.some((snippet) => hasValue(snippet.body));
    if (section.type === 'trace_sequence') return Array.isArray(section.steps) && section.steps.length > 0;
    if (section.type === 'trace_analysis') {
      return hasValue(section.purpose) || hasValue(section.chain_summary)
        || (Array.isArray(section.risk_points) && section.risk_points.length > 0)
        || (Array.isArray(section.next_actions) && section.next_actions.length > 0);
    }
    return false;
  });
}

function toneFor(tone) {
  return SEVERITY_TONES[tone] ?? SEVERITY_TONES.neutral;
}

function renderStatusTag(text, toneKey) {
  const tone = toneFor(toneKey);
  return `<span class="status-tag" style="color:${tone.color};background:${tone.bg}">${escapeHtml(text)}</span>`;
}

function renderSecondaryText(secondary) {
  return hasValue(secondary) ? `<div class="cell-secondary">${escapeHtml(secondary)}</div>` : '';
}

function renderTextValue(text, { href, mono, tone } = {}) {
  const escapedText = escapeHtml(text ?? '');

  if (tone) {
    const tag = renderStatusTag(text, tone);
    if (href) {
      return `<a href="${escapeHtml(href)}" class="cell-link">${tag}</a>`;
    }
    return tag;
  }

  const className = mono ? 'cell-link mono' : 'cell-link';
  if (href) {
    return `<a href="${escapeHtml(href)}" class="${className}">${escapedText}</a>`;
  }

  const valueClass = mono ? 'cell-primary mono' : 'cell-primary';
  return `<span class="${valueClass}">${escapedText}</span>`;
}

function renderTableCellValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const primary = renderTextValue(value.text, value);
    const secondary = renderSecondaryText(value.secondary);
    return `<div class="cell-stack">${primary}${secondary}</div>`;
  }

  return escapeHtml(value ?? '');
}

function renderSectionIdAttr(id) {
  return hasValue(id) ? ` id="${escapeHtml(id)}"` : '';
}

function renderSummaryMetric(metric) {
  const tone = toneFor(metric.tone);
  const value = escapeHtml(metric.value);
  const label = escapeHtml(metric.label ?? tone.label ?? '');
  const cardContent = `<div class="metric-card" data-tone="${escapeHtml(metric.tone ?? 'neutral')}" style="border-top: 3px solid ${tone.color}; background:${tone.bg}">
    <div class="metric-value" style="color:${tone.color}">${value}</div>
    <div class="metric-label">${label}</div>
  </div>`;

  if (metric.href) {
    return `<a href="${escapeHtml(metric.href)}" class="metric-card-link">${cardContent}</a>`;
  }

  return cardContent;
}

function renderSummaryMetrics(metrics) {
  const visible = visibleMetrics(metrics);
  if (!Array.isArray(visible) || visible.length === 0) return '';
  return `<div class="summary-metrics">${visible.map(renderSummaryMetric).join('\n')}</div>`;
}

function renderSeverityLegend() {
  const items = Object.entries(SEVERITY_TONES)
    .filter(([key]) => key !== 'neutral')
    .map(([, tone]) => `<span class="legend-item"><span class="legend-dot" style="background:${tone.color}"></span>${tone.label}</span>`)
    .join('');
  return `<div class="severity-legend">${items}</div>`;
}

function renderFilterBar(filters) {
  if (!Array.isArray(filters) || filters.length === 0) return '';
  const selects = filters.map((f) => {
    const id = escapeHtml(f.id ?? '');
    const label = escapeHtml(f.label ?? f.id ?? '');
    return `<div class="filter-item"><label for="filter-${id}">${label}</label><select id="filter-${id}" name="${id}" disabled><option value="">全部</option></select></div>`;
  }).join('\n');
  return `<div class="filter-bar">${selects}</div>`;
}

function renderBreadcrumbs(breadcrumbs) {
  if (!Array.isArray(breadcrumbs) || breadcrumbs.length === 0) return '';

  const items = breadcrumbs.map((crumb, index) => {
    const isLast = index === breadcrumbs.length - 1;
    const label = escapeHtml(crumb.label ?? '');

    if (!isLast && crumb.href) {
      return `<a href="${escapeHtml(crumb.href)}" class="breadcrumb-link">${label}</a>`;
    }

    return `<span class="breadcrumb-current"${isLast ? ' aria-current="page"' : ''}>${label}</span>`;
  }).join('<span class="breadcrumb-separator" aria-hidden="true">›</span>');

  return `<nav class="breadcrumbs" aria-label="页面导航">${items}</nav>`;
}

function renderContextBadges(badges) {
  if (!Array.isArray(badges) || badges.length === 0) return '';
  return `<div class="context-badges">${badges.map((badge) => {
    const tone = toneFor(badge.tone);
    return `<span class="context-badge" style="color:${tone.color};background:${tone.bg}">${escapeHtml(badge.label ?? '')}</span>`;
  }).join('')}</div>`;
}

function renderPageActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return '';
  return `<div class="page-actions">${actions.map((action) => {
    const kind = action.kind === 'primary' ? 'primary' : 'secondary';
    return `<a href="${escapeHtml(action.href ?? '')}" class="page-action ${kind}">${escapeHtml(action.label ?? '')}</a>`;
  }).join('')}</div>`;
}

function renderTableSection(section) {
  const id = section.id ?? '';
  const escapedId = escapeHtml(id);
  const title = escapeHtml(section.title ?? '');
  const tableId = `table-${escapedId}`;
  const columns = Array.isArray(section.columns) ? section.columns : [];
  const rows = Array.isArray(section.rows) ? section.rows : [];
  if (rows.length === 0) return '';

  const thead = columns.length > 0
    ? `<tr>${columns.map((c) => `<th>${escapeHtml(c.label ?? c.key ?? '')}</th>`).join('')}</tr>`
    : '<tr><th></th></tr>';
  const tbody = rows.map((row) => {
    if (columns.length > 0) {
      return `<tr>${columns.map((c) => `<td>${renderTableCellValue(row?.[c.key])}</td>`).join('')}</tr>`;
    }
    return `<tr><td>${escapeHtml(row ?? '')}</td></tr>`;
  }).join('');

  return `<section${renderSectionIdAttr(id)} class="data-section">
    <h3>${title}</h3>
    <div class="table-scroll"><table id="${tableId}" class="data-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>
  </section>`;
}

function isMonoMetaItem(item) {
  const label = String(item?.label ?? '');
  return /(^|\b)(id|trace|time|timestamp|时间|日期)(\b|$)/i.test(label);
}

function renderDefinitionListSection(section) {
  const id = section.id ?? '';
  const escapedId = escapeHtml(id);
  const title = escapeHtml(section.title ?? '');
  const items = Array.isArray(section.items) ? section.items.filter((item) => hasValue(item.value)) : [];
  if (items.length === 0) return '';

  const rows = items.map((item) => {
    const label = escapeHtml(item.label ?? '');
    const value = escapeHtml(item.value ?? '');
    const valueClass = isMonoMetaItem(item) ? 'meta-val mono' : 'meta-val';
    return `<div class="meta-row"><span class="meta-key">${label}</span><span class="${valueClass}">${value}</span></div>`;
  }).join('');

  return `<section${renderSectionIdAttr(id)} class="data-section">
    <h3>${title}</h3>
    <div id="meta-${escapedId}" class="metadata-block">${rows}</div>
  </section>`;
}

function renderLinkListSection(section) {
  const id = section.id ?? '';
  const title = escapeHtml(section.title ?? '');
  const links = Array.isArray(section.links) ? section.links : [];
  if (links.length === 0) return '';

  const items = links.map((link) => {
    const href = escapeHtml(link.href ?? '');
    const text = escapeHtml(link.label ?? link.text ?? '');
    return `<li><a href="${href}" class="section-link">${text}</a></li>`;
  }).join('');

  return `<section${renderSectionIdAttr(id)} class="data-section">
    <h3>${title}</h3>
    <ul class="link-list">${items}</ul>
  </section>`;
}

function renderCalloutSection(section) {
  const id = section.id ?? '';
  const title = escapeHtml(section.title ?? '');
  const body = escapeHtml(section.body ?? '');
  if (!title && !body) return '';
  return `<section${renderSectionIdAttr(id)} class="data-section callout">
    ${title ? `<h3>${title}</h3>` : ''}
    ${body ? `<div class="callout-body">${body}</div>` : ''}
  </section>`;
}

function renderRawLogListSection(section) {
  const id = section.id ?? '';
  const title = escapeHtml(section.title ?? '');
  const snippets = Array.isArray(section.snippets) ? section.snippets.filter((snippet) => hasValue(snippet.body)) : [];
  if (snippets.length === 0) return '';

  const items = snippets.map((snippet) => `<article class="raw-log-snippet">
      ${hasValue(snippet.label) ? `<div class="raw-log-label">${escapeHtml(snippet.label)}</div>` : ''}
      <pre class="raw-log-pre"><code>${escapeHtml(snippet.body)}</code></pre>
    </article>`).join('');

  return `<section${renderSectionIdAttr(id)} class="data-section raw-log-section">
    <h3>${title}</h3>
    <div class="raw-log-list">${items}</div>
  </section>`;
}

function renderTraceSequenceSection(section) {
  const id = section.id ?? '';
  const title = escapeHtml(section.title ?? '');
  const steps = Array.isArray(section.steps) ? section.steps : [];
  if (steps.length === 0) return '';

  const items = steps.map((step) => {
    const status = step.status && typeof step.status === 'object'
      ? renderStatusTag(step.status.text ?? '', step.status.tone)
      : '';
    const metaItems = [
      hasValue(step.timestamp) ? `<span>${escapeHtml(step.timestamp)}</span>` : '',
      hasValue(step.span_id) ? `<span>Span ${escapeHtml(step.span_id)}</span>` : '',
      hasValue(step.parent_span_id) ? `<span>父 Span ${escapeHtml(step.parent_span_id)}</span>` : '',
      hasValue(step.duration_ms) ? `<span>${escapeHtml(step.duration_ms)}</span>` : '',
    ].filter(Boolean).join('');
    const summary = hasValue(step.error_message) ? step.error_message : step.summary;

    return `<li class="trace-step">
        <span class="trace-step-index">${escapeHtml(step.order ?? '')}</span>
        <div class="trace-step-body">
          <div class="trace-step-head">
            <span class="trace-step-tool mono">${escapeHtml(step.tool_name ?? '')}</span>
            <span class="trace-step-event">${escapeHtml(step.event ?? '')}</span>
            ${status}
          </div>
          ${metaItems ? `<div class="trace-step-meta mono">${metaItems}</div>` : ''}
          ${hasValue(summary) ? `<div class="trace-step-summary">${escapeHtml(summary)}</div>` : ''}
        </div>
      </li>`;
  }).join('');

  return `<section${renderSectionIdAttr(id)} class="data-section trace-sequence-section">
    <h3>${title}</h3>
    <ol class="trace-sequence">${items}</ol>
  </section>`;
}

function renderTraceAnalysisSection(section) {
  const id = section.id ?? '';
  const title = escapeHtml(section.title ?? '');
  const riskPoints = Array.isArray(section.risk_points) ? section.risk_points.filter(hasValue) : [];
  const nextActions = Array.isArray(section.next_actions) ? section.next_actions.filter(hasValue) : [];
  if (!hasValue(section.purpose) && !hasValue(section.chain_summary) && riskPoints.length === 0 && nextActions.length === 0) return '';

  const renderList = (items) => items.length > 0
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : '';

  return `<section${renderSectionIdAttr(id)} class="data-section trace-analysis-section">
    <h3>${title}</h3>
    <div class="trace-analysis-grid">
      ${hasValue(section.purpose) ? `<div class="trace-analysis-block"><div class="trace-analysis-label">调用目的</div><p>${escapeHtml(section.purpose)}</p></div>` : ''}
      ${hasValue(section.chain_summary) ? `<div class="trace-analysis-block"><div class="trace-analysis-label">链路解读</div><p>${escapeHtml(section.chain_summary)}</p></div>` : ''}
      ${riskPoints.length > 0 ? `<div class="trace-analysis-block"><div class="trace-analysis-label">风险点</div>${renderList(riskPoints)}</div>` : ''}
      ${nextActions.length > 0 ? `<div class="trace-analysis-block"><div class="trace-analysis-label">建议动作</div>${renderList(nextActions)}</div>` : ''}
    </div>
    ${hasValue(section.model) ? `<div class="trace-analysis-model mono">模型：${escapeHtml(section.model)}</div>` : ''}
  </section>`;
}

function renderSection(section) {
  if (!section) return '';
  switch (section.type) {
    case 'table': return renderTableSection(section);
    case 'definition_list': return renderDefinitionListSection(section);
    case 'link_list': return renderLinkListSection(section);
    case 'callout': return renderCalloutSection(section);
    case 'raw_log_list': return renderRawLogListSection(section);
    case 'trace_sequence': return renderTraceSequenceSection(section);
    case 'trace_analysis': return renderTraceAnalysisSection(section);
    default: return '';
  }
}

function renderSections(sections) {
  const visible = visibleSections(sections);
  if (!Array.isArray(visible) || visible.length === 0) return '<div class="empty-state">暂无可展示的审查数据</div>';
  return visible.map(renderSection).join('\n');
}

function renderEmptyState() {
  return '<div class="empty-state">暂无可展示的审查数据</div>';
}

function renderErrorState(message) {
  return `<div class="error-state">加载错误: ${escapeHtml(message ?? '')}</div>`;
}

export function renderDashboard(templateInput) {
  const page = templateInput?.page ?? {};
  const title = escapeHtml(page.title ?? '审计看板');
  const subtitle = escapeHtml(page.subtitle ?? '');
  const updatedAt = escapeHtml(page.updated_at ?? '');
  const metrics = renderSummaryMetrics(templateInput?.summary_metrics);
  const legend = renderSeverityLegend();
  const filters = renderFilterBar(templateInput?.filters);
  const breadcrumbs = renderBreadcrumbs(page.breadcrumbs);
  const contextBadges = renderContextBadges(page.context_badges);
  const pageActions = renderPageActions(page.page_actions);
  const sections = renderSections(templateInput?.sections);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root {
  --bg: #F8FAFC;
  --surface: #FFFFFF;
  --surface-muted: #EAEFF3;
  --border: #E2E8F0;
  --text: #1E293B;
  --text-muted: #64748B;
  --accent: #2563EB;
  --primary: var(--accent);
  --critical: #B42318;
  --high: #C2410C;
  --medium: #B7791F;
  --low: #475569;
  --success: #15803D;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
}
a {
  color: inherit;
  transition: color 180ms ease, background-color 180ms ease, border-color 180ms ease, box-shadow 180ms ease;
}
a:hover {
  text-decoration: underline;
}
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.mono {
  font-family: "JetBrains Mono", "Cascadia Code", monospace;
}
.header-bar {
  background: linear-gradient(180deg, rgba(37, 99, 235, 0.08) 0%, rgba(255, 255, 255, 0.96) 100%);
  border-bottom: 1px solid var(--border);
  padding: 20px 24px;
}
.header-shell {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.header-copy {
  min-width: 0;
}
.header-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
}
.header-bar .header-title { font-size: 24px; font-weight: 700; }
.header-bar .header-subtitle { font-size: 14px; color: var(--text-muted); margin-top: 4px; }
.container { padding: 24px; max-width: 1200px; margin: 0 auto; }
.time-range-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 12px;
}
.time-range-bar .updated { margin-left: auto; }
.breadcrumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  color: var(--text-muted);
  font-size: 13px;
}
.breadcrumb-link {
  color: var(--accent);
  text-decoration: none;
}
.breadcrumb-current {
  color: var(--text);
  font-weight: 600;
}
.breadcrumb-separator {
  color: var(--text-muted);
}
.context-badges,
.page-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.context-badge,
.status-tag {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}
.page-actions {
  margin-bottom: 16px;
}
.page-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  text-decoration: none;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}
.page-action.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #ffffff;
}
.page-action.secondary {
  background: var(--surface);
}
.summary-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}
.metric-card-link {
  display: block;
  color: inherit;
  text-decoration: none;
}
.metric-card {
  min-height: 104px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease;
}
.metric-card-link:hover .metric-card,
.metric-card-link:focus-visible .metric-card {
  box-shadow: 0 6px 18px rgba(37, 99, 235, 0.10);
  border-color: rgba(37, 99, 235, 0.28);
}
.metric-value { font-size: 28px; font-weight: 700; }
.metric-label { font-size: 13px; color: var(--text-muted); margin-top: 4px; }
.severity-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 16px;
}
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.legend-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px 16px;
  margin-bottom: 24px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}
.filter-item { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.filter-item label { color: var(--text-muted); }
.filter-item select { padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: #fff; color: var(--text-muted); min-height: 44px; }
.data-section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}
.data-section h3 { margin: 0 0 12px 0; font-size: 16px; }
.table-scroll {
  overflow-x: auto;
}
.data-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 375px; }
.data-table th, .data-table td { padding: 12px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
.data-table th { background: #f8fafc; font-weight: 600; color: var(--text-muted); }
.data-table tbody tr {
  transition: background-color 180ms ease;
}
.data-table tbody tr:hover { background: var(--surface-muted); }
.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cell-primary {
  color: var(--text);
}
.cell-secondary {
  color: var(--text-muted);
  font-size: 12px;
}
.cell-link,
.section-link {
  color: var(--accent);
  text-decoration: none;
}
.metadata-block { font-size: 13px; }
.meta-row { display: flex; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.meta-key { width: 180px; color: var(--text-muted); flex-shrink: 0; }
.meta-val { flex: 1; word-break: break-all; }
.raw-log-list { display: flex; flex-direction: column; gap: 12px; }
.raw-log-label { font-size: 12px; color: var(--text-muted); margin-bottom: 6px; }
.raw-log-pre {
  margin: 0;
  padding: 12px;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #0f172a;
  color: #e2e8f0;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre;
}
.raw-log-pre code { font-family: "JetBrains Mono", "Cascadia Code", monospace; }
.link-list { list-style: none; padding: 0; margin: 0; }
.link-list li { padding: 6px 0; }
.callout-body { font-size: 14px; color: var(--text); }
.trace-sequence {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.trace-step {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: 12px;
}
.trace-step-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
}
.trace-step-body {
  min-width: 0;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.trace-step:last-child .trace-step-body {
  border-bottom: 0;
  padding-bottom: 0;
}
.trace-step-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.trace-step-tool {
  font-weight: 700;
  word-break: break-all;
}
.trace-step-event {
  color: var(--text-muted);
  font-size: 12px;
}
.trace-step-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
  color: var(--text-muted);
  font-size: 12px;
}
.trace-step-summary {
  margin-top: 6px;
  font-size: 13px;
  color: var(--text);
}
.trace-analysis-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px 20px;
}
.trace-analysis-block {
  min-width: 0;
}
.trace-analysis-label {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 6px;
}
.trace-analysis-block p {
  margin: 0;
  font-size: 14px;
}
.trace-analysis-block ul {
  margin: 0;
  padding-left: 18px;
  font-size: 14px;
}
.trace-analysis-model {
  margin-top: 12px;
  color: var(--text-muted);
  font-size: 12px;
}
.empty-state, .empty, .error-state, .error { color: var(--text-muted); font-size: 13px; padding: 12px; }
.error-state, .error { color: var(--critical); }
footer { text-align: center; color: var(--text-muted); font-size: 12px; padding: 24px; }
@media (max-width: 768px) {
  .header-shell,
  .header-meta {
    align-items: stretch;
  }
  .header-shell {
    flex-direction: column;
  }
  .header-meta {
    align-items: flex-start;
  }
  .context-badges,
  .page-actions {
    justify-content: flex-start;
  }
  .container {
    padding: 16px;
  }
  .meta-row {
    flex-direction: column;
    gap: 4px;
  }
  .meta-key {
    width: auto;
  }
}
</style>
</head>
<body>
<header class="header-bar">
  <div class="header-shell">
    <div class="header-copy">
      <div class="header-title">${title}</div>
      ${subtitle ? `<div class="header-subtitle">${subtitle}</div>` : ''}
    </div>
    <div class="header-meta">
      ${contextBadges}
    </div>
  </div>
</header>
<main class="container">
  <div class="time-range-bar">
    <span>更新时间：${updatedAt}</span>
  </div>
  ${breadcrumbs}
  ${pageActions}
  ${metrics}
  ${legend}
  ${filters}
  ${sections}
</main>
<footer>audit-logger-agent 审计看板</footer>
</body>
</html>`;
}

export function renderOverviewHtml(templateInput) {
  return renderDashboard(templateInput);
}

export { renderEmptyState, renderErrorState, SEVERITY_TONES, hasValue, visibleMetrics, visibleSections };
