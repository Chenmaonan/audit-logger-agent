// src/auditReview/dashboardTemplate.js
// Renders a complete, self-contained HTML dashboard from a direct-data view model.
// No browser-side fetch — the template receives fully-populated sections and renders them directly.

const SEVERITY_TONES = {
  critical: { color: '#9b1c1c', bg: '#fde8e8', label: '严重' },
  high: { color: '#b54708', bg: '#fef0e6', label: '高风险' },
  medium: { color: '#b7791f', bg: '#fff8e1', label: '中风险' },
  low: { color: '#667085', bg: '#f0f2f5', label: '低风险' },
  neutral: { color: '#475467', bg: '#f5f7fa', label: '信息' },
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
    return false;
  });
}

function renderSummaryMetric(metric) {
  const tone = SEVERITY_TONES[metric.tone] ?? SEVERITY_TONES.neutral;
  const value = escapeHtml(metric.value);
  const label = escapeHtml(metric.label ?? tone.label ?? '');
  return `<div class="metric-card" style="border-top: 3px solid ${tone.color}; background:${tone.bg}">
    <div class="metric-value" style="color:${tone.color}">${value}</div>
    <div class="metric-label">${label}</div>
  </div>`;
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

function renderTableSection(section) {
  const id = escapeHtml(section.id ?? '');
  const title = escapeHtml(section.title ?? '');
  const tableId = `table-${id}`;
  const columns = Array.isArray(section.columns) ? section.columns : [];
  const rows = Array.isArray(section.rows) ? section.rows : [];
  if (rows.length === 0) return '';

  const thead = columns.length > 0
    ? `<tr>${columns.map((c) => `<th>${escapeHtml(c.label ?? c.key ?? '')}</th>`).join('')}</tr>`
    : '<tr><th></th></tr>';
  const tbody = rows.map((row) => {
    if (columns.length > 0) {
      return `<tr>${columns.map((c) => `<td>${escapeHtml(row?.[c.key] ?? '')}</td>`).join('')}</tr>`;
    }
    return `<tr><td>${escapeHtml(row ?? '')}</td></tr>`;
  }).join('');

  return `<section class="data-section">
    <h3>${title}</h3>
    <table id="${tableId}" class="data-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>
  </section>`;
}

function renderDefinitionListSection(section) {
  const id = escapeHtml(section.id ?? '');
  const title = escapeHtml(section.title ?? '');
  const items = Array.isArray(section.items) ? section.items.filter((item) => hasValue(item.value)) : [];
  if (items.length === 0) return '';

  const rows = items.map((item) => {
    const label = escapeHtml(item.label ?? '');
    const value = escapeHtml(item.value ?? '');
    return `<div class="meta-row"><span class="meta-key">${label}</span><span class="meta-val">${value}</span></div>`;
  }).join('');

  return `<section class="data-section">
    <h3>${title}</h3>
    <div id="meta-${id}" class="metadata-block">${rows}</div>
  </section>`;
}

function renderLinkListSection(section) {
  const title = escapeHtml(section.title ?? '');
  const links = Array.isArray(section.links) ? section.links : [];
  if (links.length === 0) return '';

  const items = links.map((link) => {
    const href = escapeHtml(link.href ?? '');
    const text = escapeHtml(link.label ?? link.text ?? '');
    return `<li><a href="${href}" class="section-link">${text}</a></li>`;
  }).join('');

  return `<section class="data-section">
    <h3>${title}</h3>
    <ul class="link-list">${items}</ul>
  </section>`;
}

function renderCalloutSection(section) {
  const title = escapeHtml(section.title ?? '');
  const body = escapeHtml(section.body ?? '');
  if (!title && !body) return '';
  return `<section class="data-section callout">
    ${title ? `<h3>${title}</h3>` : ''}
    ${body ? `<div class="callout-body">${body}</div>` : ''}
  </section>`;
}

function renderSection(section) {
  if (!section) return '';
  switch (section.type) {
    case 'table': return renderTableSection(section);
    case 'definition_list': return renderDefinitionListSection(section);
    case 'link_list': return renderLinkListSection(section);
    case 'callout': return renderCalloutSection(section);
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
  const sections = renderSections(templateInput?.sections);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root {
  --bg: #f7f9fc;
  --card-bg: #ffffff;
  --border: #e4e7ec;
  --text: #1d2939;
  --text-muted: #667085;
  --primary: #1d4ed8;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
}
.header-bar {
  background: var(--card-bg);
  border-bottom: 1px solid var(--border);
  padding: 16px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.header-bar .header-title { font-size: 20px; font-weight: 600; }
.header-bar .header-subtitle { font-size: 14px; color: var(--text-muted); }
.container { padding: 24px; max-width: 1200px; margin: 0 auto; }
.time-range-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 16px;
}
.time-range-bar .updated { margin-left: auto; }
.summary-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}
.metric-card {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}
.metric-value { font-size: 28px; font-weight: 700; }
.metric-label { font-size: 13px; color: var(--text-muted); margin-top: 4px; }
.severity-legend {
  display: flex;
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
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 24px;
}
.filter-item { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.filter-item label { color: var(--text-muted); }
.filter-item select { padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px; background: #fff; color: var(--text-muted); }
.data-section {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
}
.data-section h3 { margin: 0 0 8px 0; font-size: 16px; }
.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-table th, .data-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; }
.data-table th { background: #f9fafb; font-weight: 600; }
.metadata-block { font-size: 13px; }
.meta-row { display: flex; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--border); }
.meta-key { width: 180px; color: var(--text-muted); }
.meta-val { flex: 1; word-break: break-all; }
.link-list { list-style: none; padding: 0; margin: 0; }
.link-list li { padding: 4px 0; }
.section-link { color: var(--primary); text-decoration: none; }
.callout-body { font-size: 14px; color: var(--text); }
.empty-state, .empty, .error-state, .error { color: var(--text-muted); font-size: 13px; padding: 12px; }
.error-state, .error { color: #9b1c1c; }
footer { text-align: center; color: var(--text-muted); font-size: 12px; padding: 24px; }
</style>
</head>
<body>
<header class="header-bar">
  <div>
    <div class="header-title">${title}</div>
    ${subtitle ? `<div class="header-subtitle">${subtitle}</div>` : ''}
  </div>
</header>
<main class="container">
  <div class="time-range-bar">
    <span>更新时间：${updatedAt}</span>
  </div>
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