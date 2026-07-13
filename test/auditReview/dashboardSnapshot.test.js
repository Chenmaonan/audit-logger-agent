import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  hashHtml,
  renderDownloadableDashboardHtml,
  sanitizeDashboardSnapshotHtml,
  snapshotFilename,
} from '../../src/auditReview/dashboardSnapshot.js';

const FORBIDDEN_EXPORT_TEXT = [
  'Authorization',
  'Bearer',
  'cookie',
  '/dashboard/open/',
  'token=',
  'Set-Cookie',
];

const MOJIBAKE_RE = /[鏃鈥瀹鎵閾澶楂浣淇鎴鍏鐖璋椋寤妯鏆鍔鏇鐪鎬]/;

function assertNoForbiddenExportText(html) {
  for (const text of FORBIDDEN_EXPORT_TEXT) {
    assert.equal(html.includes(text), false, `导出的 HTML 不应包含 ${text}`);
  }
}

test('renderDownloadableDashboardHtml renders a sanitized zh-CN dashboard from a view model', () => {
  const html = renderDownloadableDashboardHtml({
    page: {
      title: '审计看板',
      subtitle: '离线快照',
      updated_at: '2026-07-10T08:00:00.000Z',
      page_actions: [
        { label: '打开详情', href: '/dashboard/audit-reviews/review-1?token=secret', kind: 'primary' },
      ],
    },
    summary_metrics: [{ label: '高风险', value: 1, tone: 'high' }],
    sections: [{
      id: 'latest_findings',
      type: 'table',
      title: '最新发现',
      columns: [{ key: 'title', label: '标题' }],
      rows: [{ title: '需要复核' }],
    }],
  });

  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('lang="zh-CN"'));
  assert.ok(html.includes('<style>'));
  assert.ok(html.includes('审计看板'));
  assert.ok(html.includes('最新发现'));
  assert.equal(html.includes('fetch('), false);
  assert.equal(html.includes('/v1/'), false);
  assertNoForbiddenExportText(html);
});

test('renderDownloadableDashboardHtml output does not contain mojibake for Chinese dashboard text', () => {
  const html = renderDownloadableDashboardHtml({
    page: {
      title: '\u5ba1\u8ba1\u770b\u677f',
      subtitle: '\u79bb\u7ebf\u5feb\u7167',
      updated_at: '2026-07-10T08:00:00.000Z',
    },
    summary_metrics: [{ label: '\u9ad8\u98ce\u9669', value: 1, tone: 'high' }],
    sections: [{
      id: 'latest_findings',
      type: 'table',
      title: '\u6700\u65b0\u53d1\u73b0',
      columns: [{ key: 'title', label: '\u6807\u9898' }],
      rows: [{ title: '\u9700\u8981\u590d\u6838' }],
    }],
  });

  assert.ok(html.includes('\u5ba1\u8ba1\u770b\u677f'));
  assert.ok(html.includes('\u6700\u65b0\u53d1\u73b0'));
  assert.doesNotMatch(html, MOJIBAKE_RE);
  assertNoForbiddenExportText(html);
});

test('renderDownloadableDashboardHtml accepts existing HTML and sanitizes it', () => {
  const html = renderDownloadableDashboardHtml(`<!DOCTYPE html>
<html lang="zh-CN">
<head><style>body { color: #111; }</style></head>
<body><a href="/dashboard/audit-findings/finding-1">详情</a><p>Authorization: Bearer secret</p></body>
</html>`);

  assert.ok(html.includes('lang="zh-CN"'));
  assert.ok(html.includes('<style>body { color: #111; }</style>'));
  assert.ok(html.includes('href="#"'));
  assertNoForbiddenExportText(html);
});

test('sanitizeDashboardSnapshotHtml rewrites dashboard server links for offline use', () => {
  const html = sanitizeDashboardSnapshotHtml(`
    <a href="/dashboard">总览</a>
    <a href="/dashboard/audit-reviews/review-1">批次</a>
    <a href="/dashboard/open/review-1?token=secret">令牌链接</a>
    <a href="#trace_sequence">链路</a>
    <a href="https://example.test/docs">文档</a>
  `);

  assert.equal(html.includes('href="/dashboard"'), false);
  assert.equal(html.includes('href="/dashboard/audit-reviews/review-1"'), false);
  assert.equal(html.includes('/dashboard/open/'), false);
  assert.equal((html.match(/href="#"/g) ?? []).length, 3);
  assert.ok(html.includes('href="#trace_sequence"'));
  assert.ok(html.includes('href="https://example.test/docs"'));
  assertNoForbiddenExportText(html);
});

test('sanitizeDashboardSnapshotHtml removes token, cookie, Authorization, Bearer, Set-Cookie, and magic-link content', () => {
  const html = sanitizeDashboardSnapshotHtml(`
    <meta name="cookie" content="session=abc">
    <div data-header="Authorization: Bearer secret">Authorization: Bearer secret</div>
    <p>Set-Cookie: sid=abc</p>
    <p>magic-link=https://example.test/dashboard/open/review?token=secret</p>
    <a href="/dashboard/audit-reviews/review-1?token=secret&x=1">带令牌</a>
  `);

  assertNoForbiddenExportText(html);
  assert.equal(/magic-link/i.test(html), false);
  assert.equal(/secret/i.test(html), false);
  assert.ok(html.includes('带令牌'));
});

test('snapshotFilename returns a safe html filename without path traversal', () => {
  const filename = snapshotFilename({
    agentId: '../agent:一号',
    reviewId: '..\\review/open',
    createdAt: '2026-07-10T08:09:10.123Z',
  });

  assert.equal(filename.endsWith('.html'), true);
  assert.equal(filename.includes('..'), false);
  assert.equal(/[\\/:\0]/.test(filename), false);
  assert.match(filename, /^audit-dashboard_agent-review-open_20260710T080910Z\.html$/);
});

test('hashHtml returns sha256 and UTF-8 byte size', () => {
  const html = '<html lang="zh-CN"><body>审计</body></html>';
  const result = hashHtml(html);

  assert.deepEqual(result, {
    sha256: crypto.createHash('sha256').update(html, 'utf8').digest('hex'),
    byteSize: Buffer.byteLength(html, 'utf8'),
  });
});
