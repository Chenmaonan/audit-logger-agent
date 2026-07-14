// src/adapters/http/app.js
import http from 'http';
import fs from 'fs';
import {
  queryEvents,
  dailySummary,
  errorReport,
  toolUsageStats,
  reportDateForNow,
  reportTimezoneOffsetMinutes,
} from '../../../scripts/lib/db.js';
import { renderDashboard } from '../../auditReview/dashboardTemplate.js';
import { handleIngestRoute, isHttpIngestEnabled } from './ingestRoute.js';

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_QUERY_LIMIT = 1000;

function positiveInteger(value, defaultValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultValue;
  return Math.floor(parsed);
}

function maxBodyBytes(config = {}) {
  return positiveInteger(config.limits?.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
}

function maxQueryLimit(config = {}) {
  return positiveInteger(config.limits?.maxQueryLimit, DEFAULT_MAX_QUERY_LIMIT);
}

function clampLimit(value, defaultValue, maxValue) {
  if (value == null) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  const integer = Math.floor(parsed);
  if (integer < 1) return 1;
  return Math.min(integer, maxValue);
}

function clampOffset(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function paginationFromUrl(url, { defaultLimit, config }) {
  return {
    limit: clampLimit(url.searchParams.get('limit'), defaultLimit, maxQueryLimit(config)),
    offset: clampOffset(url.searchParams.get('offset')),
  };
}

function dbWritableProbe(db) {
  try {
    db.exec('BEGIN IMMEDIATE; ROLLBACK;');
    return { writable: true };
  } catch (error) {
    return { writable: false, error: error.message };
  }
}

function isMissingTableError(error) {
  return /no such table/i.test(error?.message ?? '');
}

function latestReview(db) {
  try {
    return db.prepare(`
      SELECT review_id, status, started_at, finished_at
      FROM audit_review_runs
      ORDER BY COALESCE(finished_at, started_at) DESC
      LIMIT 1
    `).get() ?? null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    return { error: error.message };
  }
}

function outboxCounts(db) {
  try {
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN delivery_status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN delivery_status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter
      FROM agent_outbox_events
    `).get();
    return {
      pending: row?.pending ?? 0,
      dead_letter: row?.dead_letter ?? 0,
    };
  } catch (error) {
    if (isMissingTableError(error)) return { pending: 0, dead_letter: 0 };
    return { pending: null, dead_letter: null, error: error.message };
  }
}

function safeFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    return null;
  }
}

function diskUsageEstimate(dbPath) {
  const dbBytes = safeFileSize(dbPath);
  const walBytes = safeFileSize(`${dbPath}-wal`);
  const shmBytes = safeFileSize(`${dbPath}-shm`);
  const sizes = [dbBytes, walBytes, shmBytes];
  const total = sizes.every((size) => typeof size === 'number')
    ? sizes.reduce((sum, size) => sum + size, 0)
    : null;
  return {
    db_bytes: dbBytes,
    wal_bytes: walBytes,
    shm_bytes: shmBytes,
    total_bytes: total,
  };
}

function json(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(data));
}

// Response helper for audit-review routes: applies CORS headers from dashboardAuth
// and supports bearer-token authorization. Used by the new /v1/audit-* and /dashboard routes.
function auditJson(res, status, data, corsHeaders) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  };
  Object.assign(headers, corsHeaders ?? {});
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function html(res, status, body, corsHeaders) {
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  };
  Object.assign(headers, corsHeaders ?? {});
  res.writeHead(status, headers);
  res.end(body);
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, {
    location,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end();
}

// Map dashboardAuth authorize failures to HTTP status + body.
function mapAuthFailure(authResult) {
  if (authResult.ok) return null;
  const status = authResult.status ?? 401;
  const code = authResult.code ?? 'unauthorized';
  return { status, body: { error_code: code, error: 'Unauthorized' } };
}

async function readJson(req, limitBytes = DEFAULT_MAX_BODY_BYTES) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limitBytes) {
    const error = new Error('Request body exceeds maxBodyBytes');
    error.code = 'body_too_large';
    throw error;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      const error = new Error('Request body exceeds maxBodyBytes');
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? JSON.parse(raw) : {};
}

function parseUrl(req) {
  return new URL(req.url, 'http://127.0.0.1');
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function validateCreateRunInput(input) {
  const errors = [];
  if (!isNonEmptyString(input.sourceType)) errors.push({ field: 'source.type', message: 'source.type is required' });
  if (!isNonEmptyString(input.sessionId)) errors.push({ field: 'source.session_id', message: 'source.session_id is required' });
  if (!isNonEmptyString(input.requesterId)) errors.push({ field: 'source.requester_id', message: 'source.requester_id is required' });
  if (!isNonEmptyString(input.requestText)) errors.push({ field: 'request.text', message: 'request.text is required' });
  if (!isNonEmptyString(input.deliveryMode)) errors.push({ field: 'delivery.mode', message: 'delivery.mode is required' });
  if (input.deliveryMode === 'callback' && !isNonEmptyString(input.deliveryTargetUrl)) {
    errors.push({ field: 'delivery.target_url', message: 'delivery.target_url is required when delivery.mode is callback' });
  }
  return errors;
}

// Normalizes the incoming run request into a generic shape consumed by
// runtime.startRun. Accepts both the new generic envelope
// ({ source, request, delivery, metadata }) and the legacy Bot-shaped body
// ({ channel, conversation_id, user, request, delivery }) for backwards compat.
function normalizeRunRequest(body, headers) {
  if (body?.source && body?.request) {
    return {
      sourceType: body.source.type,
      sessionId: body.source.session_id,
      messageId: body.source.message_id,
      requesterId: body.source.requester_id,
      requestText: body.request.text,
      deliveryMode: body.delivery?.mode,
      deliveryTargetUrl: body.delivery?.target_url,
      metadata: body.metadata,
      idempotencyKey: body.idempotency_key ?? headers['idempotency-key'],
    };
  }

  return {
    sourceType: body.channel,
    sessionId: body.conversation_id,
    messageId: body.message_id,
    requesterId: body.user?.open_id,
    requestText: body.request?.text,
    deliveryMode: body.delivery?.mode,
    deliveryTargetUrl: body.delivery?.callback_url,
    metadata: body.metadata,
    idempotencyKey: body.idempotency_key ?? headers['idempotency-key'],
  };
}

// Maps runtime-thrown errors (carrying a stable `code`) to HTTP status + body.
function mapRuntimeError(error) {
  const code = error?.code;
  if (code === 'body_too_large') return { status: 413, body: { error_code: 'payload_too_large', error: error.message } };
  if (code === 'run_not_found') return { status: 404, body: { error_code: code, error: error.message } };
  if (code === 'resume_conflict') return { status: 409, body: { error_code: code, error: error.message } };
  if (code === 'invalid_decision_response') return { status: 400, body: { error_code: code, error: error.message } };
  if (code === 'invalid_request') return { status: 400, body: { error_code: code, error: error.message } };
  return { status: 500, body: { error_code: 'internal_error', error: 'Internal server error' } };
}

export function createHttpApp({ db, config, runStore, runtime, scheduler, reviewStore, visualization, dashboardAuth, toolSemanticMapper, retentionService, now = () => new Date() } = {}) {
  // Helpers for audit-review routes. These are optional — if not provided
  // (e.g. in the existing runs-api test), the new routes return 503.
  const hasReviewDeps = !!(scheduler && reviewStore && visualization && dashboardAuth);
  function reviewCors(req) {
    if (!dashboardAuth) return {};
    const origin = req.headers.origin;
    return dashboardAuth.corsHeaders(origin);
  }
  return http.createServer(async (req, res) => {
    const url = parseUrl(req);

    if (req.method === 'OPTIONS') {
      json(res, 204, {});
      return;
    }

    try {
      // ===================== Dashboard Browser Login =====================
      if (hasReviewDeps && req.method === 'GET' && url.pathname === '/dashboard/login') {
        redirect(res, '/dashboard');
        return;
      }

      if (hasReviewDeps && req.method === 'POST' && url.pathname === '/dashboard/login') {
        redirect(res, '/dashboard');
        return;
      }

      if (hasReviewDeps && req.method === 'POST' && url.pathname === '/dashboard/logout') {
        redirect(res, '/dashboard', { 'set-cookie': dashboardAuth.clearSessionCookie(req) });
        return;
      }

      // ===================== Audit Review API (v1.4) =====================
      if (hasReviewDeps && req.method === 'GET' && url.pathname === '/v1/audit-reviews') {
        const cors = reviewCors(req);
        const auth = dashboardAuth.authorizeApi(req);
        const fail = mapAuthFailure(auth);
        if (fail) { auditJson(res, fail.status, fail.body, cors); return; }
        const { limit, offset } = paginationFromUrl(url, { defaultLimit: 50, config });
        const runs = reviewStore.listRuns({ limit, offset });
        auditJson(res, 200, { count: runs.length, results: runs }, cors);
        return;
      }

      if (hasReviewDeps && req.method === 'GET' && url.pathname.startsWith('/v1/audit-reviews/') && url.pathname !== '/v1/audit-reviews/run') {
        const cors = reviewCors(req);
        const auth = dashboardAuth.authorizeApi(req);
        const fail = mapAuthFailure(auth);
        if (fail) { auditJson(res, fail.status, fail.body, cors); return; }
        const reviewId = decodeURIComponent(url.pathname.split('/').pop());
        const run = reviewStore.getRun(reviewId);
        if (!run) { auditJson(res, 404, { error_code: 'review_not_found', error: 'Review not found' }, cors); return; }
        auditJson(res, 200, run, cors);
        return;
      }

      if (hasReviewDeps && req.method === 'GET' && url.pathname === '/v1/audit-findings') {
        const cors = reviewCors(req);
        const auth = dashboardAuth.authorizeApi(req);
        const fail = mapAuthFailure(auth);
        if (fail) { auditJson(res, fail.status, fail.body, cors); return; }
        const { limit, offset } = paginationFromUrl(url, { defaultLimit: 100, config });
        const severity = url.searchParams.get('severity') ?? undefined;
        const category = url.searchParams.get('category') ?? undefined;
        const agentId = url.searchParams.get('agent_id') ?? undefined;
        const toolName = url.searchParams.get('tool_name') ?? undefined;
        const statusFilter = url.searchParams.get('status') ?? undefined;
        const reviewId = url.searchParams.get('review_id') ?? undefined;
        const findings = reviewStore.listFindings({ limit, offset, severity, category, agentId, toolName, status: statusFilter, reviewId });
        auditJson(res, 200, { count: findings.length, results: findings }, cors);
        return;
      }

      if (hasReviewDeps && req.method === 'GET' && url.pathname.startsWith('/v1/audit-findings/')) {
        const cors = reviewCors(req);
        const auth = dashboardAuth.authorizeApi(req);
        const fail = mapAuthFailure(auth);
        if (fail) { auditJson(res, fail.status, fail.body, cors); return; }
        const findingId = decodeURIComponent(url.pathname.split('/').pop());
        const finding = reviewStore.getFinding(findingId);
        if (!finding) { auditJson(res, 404, { error_code: 'finding_not_found', error: 'Finding not found' }, cors); return; }
        auditJson(res, 200, finding, cors);
        return;
      }

      if (hasReviewDeps && req.method === 'POST' && url.pathname === '/v1/audit-reviews/run') {
        const cors = reviewCors(req);
        const auth = dashboardAuth.authorizeApi(req);
        const fail = mapAuthFailure(auth);
        if (fail) { auditJson(res, fail.status, fail.body, cors); return; }
        try {
          const result = await scheduler.runOnce({ triggerType: 'manual' });
          if (result.status === 'skipped') {
            auditJson(res, 409, { error_code: 'review_already_running', error: 'A review is already running', review_id: result.reviewId }, cors);
          } else {
            auditJson(res, 202, { review_id: result.reviewId, status: result.status }, cors);
          }
        } catch (error) {
          auditJson(res, 500, { error_code: 'internal_error', error: error.message }, cors);
        }
        return;
      }

      // ===================== Dashboard Pages (v1.4) =====================
      if (hasReviewDeps && req.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
        const cors = reviewCors(req);
        const auth = dashboardAuth.authorizeDashboard(req);
        const fail = mapAuthFailure(auth);
        if (fail) { html(res, fail.status, `<h1>${fail.body.error}</h1>`, cors); return; }
        const page = typeof visualization.agentIndexPage === 'function'
          ? visualization.agentIndexPage()
          : visualization.overviewPage();
        html(res, 200, renderDashboard(page), cors);
        return;
      }

      if (hasReviewDeps && req.method === 'GET' && (url.pathname === '/dashboard' || url.pathname === '/dashboard/')) {
        const cors = reviewCors(req);
        const auth = dashboardAuth.authorizeDashboard(req);
        const fail = mapAuthFailure(auth);
        if (fail) { html(res, fail.status, `<h1>${fail.body.error}</h1>`, cors); return; }
        const agentId = url.searchParams.get('agent_id') || undefined;
        const page = visualization.overviewPage({ agentId });
        html(res, 200, renderDashboard(page), cors);
        return;
      }

      if (hasReviewDeps && req.method === 'GET' && url.pathname.startsWith('/dashboard/audit-reviews/')) {
        const cors = reviewCors(req);
        const auth = dashboardAuth.authorizeDashboard(req);
        const fail = mapAuthFailure(auth);
        if (fail) { html(res, fail.status, `<h1>${fail.body.error}</h1>`, cors); return; }
        const reviewId = decodeURIComponent(url.pathname.split('/').pop());
        const run = reviewStore.getRun(reviewId);
        if (!run) { html(res, 404, '<h1>Review not found</h1>', cors); return; }
        const page = visualization.reviewDetailPage(reviewId);
        html(res, 200, renderDashboard(page), cors);
        return;
      }

      if (hasReviewDeps && req.method === 'GET' && url.pathname.startsWith('/dashboard/audit-findings/')) {
        const cors = reviewCors(req);
        const auth = dashboardAuth.authorizeDashboard(req);
        const fail = mapAuthFailure(auth);
        if (fail) { html(res, fail.status, `<h1>${fail.body.error}</h1>`, cors); return; }
        const findingId = decodeURIComponent(url.pathname.split('/').pop());
        const finding = reviewStore.getFinding(findingId);
        if (!finding) { html(res, 404, '<h1>Finding not found</h1>', cors); return; }
        const page = typeof visualization.findingDetailPageWithAnalysis === 'function'
          ? await visualization.findingDetailPageWithAnalysis(findingId)
          : visualization.findingDetailPage(findingId);
        html(res, 200, renderDashboard(page), cors);
        return;
      }

      // ===================== Existing Routes (unchanged) =====================
      if (req.method === 'GET' && url.pathname === '/health') {
        const dbProbe = dbWritableProbe(db);
        const status = dbProbe.writable ? 'ok' : 'error';
        json(res, dbProbe.writable ? 200 : 503, {
          status,
          checked_at: now().toISOString(),
          dbPath: config.dbPath,
          db: dbProbe,
          latest_review: latestReview(db),
          outbox: outboxCounts(db),
          disk: diskUsageEstimate(config.dbPath),
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/ingest' && isHttpIngestEnabled(config)) {
        await handleIngestRoute(req, res, {
          config,
          db,
          toolSemanticMapper,
          onAcceptedBatch: () => {
            if (typeof retentionService?.pruneAuditEvents === 'function') {
              try {
                retentionService.pruneAuditEvents();
              } catch {
                // Retention failures must not block review scheduling.
              }
            }
            if (typeof scheduler?.runAfterIngest === 'function') {
              return scheduler.runAfterIngest();
            }
            return undefined;
          },
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/query') {
        const filters = Object.fromEntries(url.searchParams.entries());
        const { limit, offset } = paginationFromUrl(url, { defaultLimit: 100, config });
        filters.limit = limit;
        filters.offset = offset;
        const results = queryEvents(db, filters, { maxQueryLimit: maxQueryLimit(config) });
        json(res, 200, { count: results.length, results });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/report/daily') {
        const timezoneOffsetMinutes = reportTimezoneOffsetMinutes(config);
        const date = url.searchParams.get('date') ?? reportDateForNow(now(), timezoneOffsetMinutes);
        json(res, 200, {
          date,
          timezone_offset_minutes: timezoneOffsetMinutes,
          results: dailySummary(db, date, undefined, { timezoneOffsetMinutes }),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/report/errors') {
        const from = url.searchParams.get('from') ?? '1970-01-01';
        const to = url.searchParams.get('to') ?? '2099-12-31';
        const agentId = url.searchParams.get('agent_id') ?? undefined;
        json(res, 200, { from, to, results: errorReport(db, from, to, agentId) });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/report/tools') {
        const from = url.searchParams.get('from') ?? '1970-01-01';
        const to = url.searchParams.get('to') ?? '2099-12-31';
        const agentId = url.searchParams.get('agent_id') ?? undefined;
        json(res, 200, { from, to, results: toolUsageStats(db, from, to, agentId) });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/runs') {
        const body = await readJson(req, maxBodyBytes(config));
        const normalized = normalizeRunRequest(body, req.headers);
        const validationErrors = validateCreateRunInput(normalized);
        if (validationErrors.length > 0) {
          json(res, 400, { error_code: 'invalid_request', error: 'Invalid request body', details: validationErrors });
          return;
        }
        // P2-01: startRun now creates the run synchronously and kicks off
        // execution in the background, so this returns immediately (async ACK).
        const created = await runtime.startRun(normalized);
        json(res, 202, { run_id: created.run_id, status: created.status });
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/v1/runs/') && url.pathname.endsWith('/resume')) {
        const runId = url.pathname.split('/')[3];
        const body = await readJson(req, maxBodyBytes(config));
        if (!body || !body.decision_id) {
          json(res, 400, { error_code: 'invalid_request', error: 'decision_id is required' });
          return;
        }
        if (!body.response || typeof body.response !== 'object') {
          json(res, 400, { error_code: 'invalid_request', error: 'response is required' });
          return;
        }
        try {
          const run = await runtime.resumeRun(runId, body);
          json(res, 202, { run_id: run.run_id, status: run.status });
        } catch (error) {
          const mapped = mapRuntimeError(error);
          json(res, mapped.status, mapped.body);
        }
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/v1/runs/')) {
        const runId = url.pathname.split('/').pop();
        const run = await runtime.getRun(runId);
        if (!run) {
          json(res, 404, { error_code: 'run_not_found', error: 'Run not found' });
          return;
        }
        json(res, 200, run);
        return;
      }

      json(res, 404, { error_code: 'not_found', error: 'Not found' });
    } catch (error) {
      const mapped = mapRuntimeError(error);
      json(res, mapped.status, mapped.body);
    }
  });
}
