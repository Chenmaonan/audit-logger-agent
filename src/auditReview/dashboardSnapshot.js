import crypto from 'node:crypto';
import { renderDashboard } from './dashboardTemplate.js';

const SENSITIVE_PATTERN = /(authorization|bearer|set-cookie|cookie|token=|magic-link|\/dashboard\/open\/)/i;

function isDashboardServerHref(href) {
  const value = String(href ?? '').trim();
  if (value.startsWith('/dashboard')) return true;

  try {
    const url = new URL(value);
    return url.pathname.startsWith('/dashboard');
  } catch {
    return false;
  }
}

function sanitizeHref(value) {
  if (isDashboardServerHref(value) || SENSITIVE_PATTERN.test(value)) return '#';
  return value;
}

function ensureZhCnLang(html) {
  if (/<html\b[^>]*\blang=/i.test(html)) {
    return html.replace(/<html\b([^>]*?)\blang=(["'])[^"']*\2([^>]*)>/i, '<html$1lang="zh-CN"$3>');
  }

  if (/<html\b/i.test(html)) {
    return html.replace(/<html\b([^>]*)>/i, '<html$1 lang="zh-CN">');
  }

  return html;
}

export function sanitizeDashboardSnapshotHtml(html) {
  let sanitized = String(html ?? '');

  sanitized = ensureZhCnLang(sanitized);
  sanitized = sanitized.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  sanitized = sanitized.replace(/\s(?:src|data-src|action)=(["'])[^"']*\1/gi, '');
  sanitized = sanitized.replace(/\shref=(["'])([^"']*)\1/gi, (_match, quote, href) => ` href=${quote}${sanitizeHref(href)}${quote}`);
  sanitized = sanitized.replace(/<meta\b[^>]*(?:authorization|bearer|set-cookie|cookie|token=|magic-link|\/dashboard\/open\/)[^>]*>/gi, '');
  sanitized = sanitized.replace(/\s[\w:-]+=(["'])[^"']*(?:authorization|bearer|set-cookie|cookie|token=|magic-link|\/dashboard\/open\/)[^"']*\1/gi, '');
  sanitized = sanitized.replace(/Authorization\s*:\s*Bearer\s+[^\s<"']*/gi, '已移除');
  sanitized = sanitized.replace(/\bBearer\s+[^\s<"']*/gi, '已移除');
  sanitized = sanitized.replace(/\bAuthorization\b\s*:?[^\s<"']*/gi, '已移除');
  sanitized = sanitized.replace(/Set-Cookie\s*:?[^\s<"']*/gi, '已移除');
  sanitized = sanitized.replace(/magic-link\s*=\s*[^\s<"']*/gi, '已移除');
  sanitized = sanitized.replace(/token=[^&\s"'<>]*/gi, '已移除');
  sanitized = sanitized.replace(/\bcookie\b[^\s<"']*/gi, '已移除');
  sanitized = sanitized.replace(/\/dashboard\/open\/[^\s"'<>]*/gi, '#');

  return sanitized;
}

export function renderDownloadableDashboardHtml(pageOrHtml, _options = {}) {
  const html = typeof pageOrHtml === 'string'
    ? pageOrHtml
    : renderDashboard(pageOrHtml);

  return sanitizeDashboardSnapshotHtml(html);
}

function safeFilenameSegment(value, fallback) {
  const segment = String(value ?? '')
    .replace(/\.+/g, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');

  return segment || fallback;
}

function timestampForFilename(createdAt) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return 'unknown-time';
  return date.toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
}

export function snapshotFilename({ agentId, reviewId, createdAt } = {}) {
  const agent = safeFilenameSegment(agentId, 'unknown-agent');
  const review = safeFilenameSegment(reviewId, 'unknown-review');
  const timestamp = timestampForFilename(createdAt);
  return `audit-dashboard_${agent}-${review}_${timestamp}.html`;
}

export function hashHtml(html) {
  const content = String(html ?? '');
  return {
    sha256: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
    byteSize: Buffer.byteLength(content, 'utf8'),
  };
}
