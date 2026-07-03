// src/auditReview/dashboardTemplate.js
// Renders a complete, self-contained HTML dashboard from a template input object.

const SEVERITY_TONES = {
  critical: { color: '#9b1c1c', bg: '#fde8e8', label: 'Critical' },
  high: { color: '#b54708', bg: '#fef0e6', label: 'High' },
  medium: { color: '#b7791f', bg: '#fff8e1', label: 'Medium' },
  low: { color: '#667085', bg: '#f0f2f5', label: 'Low' },
  neutral: { color: '#475467', bg: '#f5f7fa', label: '' },
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
  if (!Array.isArray(metrics) || metrics.length === 0) return '';
  return `<div class="summary-metrics">${metrics.map(renderSummaryMetric).join('\n')}</div>`;
}

function renderSeverityLegend() {
  const items = Object.entries(SEVERITY_TONES)
    .filter(([key]) => key !== 'neutral')
    .map(([key, tone]) => `<span class="legend-item"><span class="legend-dot" style="background:${tone.color}"></span>${tone.label}</span>`)
    .join('');
  return `<div class="severity-legend">${items}</div>`;
}

function renderFilterBar(filters) {
  if (!Array.isArray(filters) || filters.length === 0) return '';
  const selects = filters.map((f) => {
    const id = escapeHtml(f.id ?? '');
    const label = escapeHtml(f.label ?? f.id ?? '');
    return `<div class="filter-item"><label for="filter-${id}">${label}</label><select id="filter-${id}" name="${id}" disabled><option value="">All</option></select></div>`;
  }).join('\n');
  return `<div class="filter-bar">${selects}</div>`;
}

function renderTableSection(section) {
  const id = escapeHtml(section.id ?? '');
  const title = escapeHtml(section.title ?? '');
  const ds = escapeHtml(section.data_source ?? '');
  const tableId = `table-${id}`;
  return `<section class="data-section">
    <h3>${title}</h3>
    <div class="data-source-note">Data source: <code>${ds}</code></div>
    <table id="${tableId}" class="data-table"><thead><tr><th>(loading)</th></tr></thead><tbody></tbody></table>
    <script>
    (function(){
      var table = document.getElementById(${JSON.stringify(tableId)});
      var ds = ${JSON.stringify(ds)};
      if(!table || !ds) return;
      fetch(ds, { headers: { 'accept': 'application/json' } })
        .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function(data){
          var rows = (data && data.results) || (Array.isArray(data) ? data : []);
          if(!rows.length){ var tb = table.querySelector('tbody'); tb.innerHTML = '<tr><td class="empty">无数据</td></tr>'; return; }
          var keys = Object.keys(rows[0]);
          var thead = '<tr>' + keys.map(function(k){ return '<th>' + k + '</th>'; }).join('') + '</tr>';
          var tbody = rows.map(function(row){
            return '<tr>' + keys.map(function(k){ return '<td>' + (row[k] === null || row[k] === undefined ? '' : String(row[k])) + '</td>'; }).join('') + '</tr>';
          }).join('');
          table.querySelector('thead').innerHTML = thead;
          table.querySelector('tbody').innerHTML = tbody;
        })
        .catch(function(err){
          var tb = table.querySelector('tbody');
          tb.innerHTML = '<tr><td class="error">加载失败: ' + (err && err.message ? err.message : 'unknown') + '</td></tr>';
        });
    })();
    </script>
  </section>`;
}

function renderMetadataSection(section) {
  const id = escapeHtml(section.id ?? '');
  const title = escapeHtml(section.title ?? '');
  const ds = escapeHtml(section.data_source ?? '');
  const containerId = `meta-${id}`;
  return `<section class="data-section">
    <h3>${title}</h3>
    <div class="data-source-note">Data source: <code>${ds}</code></div>
    <div id="${containerId}" class="metadata-block">(loading)</div>
    <script>
    (function(){
      var el = document.getElementById(${JSON.stringify(containerId)});
      var ds = ${JSON.stringify(ds)};
      if(!el || !ds) return;
      fetch(ds, { headers: { 'accept': 'application/json' } })
        .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .then(function(data){
          if(!data || typeof data !== 'object'){ el.innerHTML = '<span class="empty">无数据</span>'; return; }
          var rows = Object.keys(data).map(function(k){ return '<div class="meta-row"><span class="meta-key">' + k + '</span><span class="meta-val">' + (data[k] === null || data[k] === undefined ? '' : String(data[k])) + '</span></div>'; }).join('');
          el.innerHTML = rows || '<span class="empty">无数据</span>';
        })
        .catch(function(err){ el.innerHTML = '<span class="error">加载失败: ' + (err && err.message ? err.message : 'unknown') + '</span>'; });
    })();
    </script>
  </section>`;
}

function renderLinkSection(section) {
  const title = escapeHtml(section.title ?? '');
  const ds = escapeHtml(section.data_source ?? '');
  if (!ds) return '';
  return `<section class="data-section">
    <h3>${title}</h3>
    <a href="${ds}" class="section-link">查看 ${title}</a>
  </section>`;
}

function renderSection(section) {
  if (!section) return '';
  switch (section.type) {
    case 'table': return renderTableSection(section);
    case 'metadata': return renderMetadataSection(section);
    case 'link': return renderLinkSection(section);
    default: return '';
  }
}

function renderSections(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return '<div class="empty-state">暂无数据</div>';
  return sections.map(renderSection).join('\n');
}

function renderEmptyState() {
  return '<div class="empty-state">暂无数据</div>';
}

function renderErrorState(message) {
  return `<div class="error-state">加载错误: ${escapeHtml(message ?? '')}</div>`;
}

export function renderDashboard(templateInput) {
  const page = templateInput?.page ?? {};
  const title = escapeHtml(page.title ?? 'Dashboard');
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
.data-source-note { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; }
.data-source-note code { background: #f0f2f5; padding: 1px 6px; border-radius: 3px; }
.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-table th, .data-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; }
.data-table th { background: #f9fafb; font-weight: 600; }
.metadata-block { font-size: 13px; }
.meta-row { display: flex; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--border); }
.meta-key { width: 180px; color: var(--text-muted); }
.meta-val { flex: 1; word-break: break-all; }
.section-link { color: var(--primary); text-decoration: none; }
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
    <span>Updated: ${updatedAt}</span>
  </div>
  ${metrics}
  ${legend}
  ${filters}
  ${sections}
</main>
<footer>audit-logger-agent dashboard</footer>
</body>
</html>`;
}

export function renderOverviewHtml(templateInput) {
  return renderDashboard(templateInput);
}

export { renderEmptyState, renderErrorState, SEVERITY_TONES };