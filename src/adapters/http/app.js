// src/adapters/http/app.js
import http from 'http';
import { queryEvents, dailySummary, errorReport, toolUsageStats } from '../../../scripts/lib/db.js';

function json(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? JSON.parse(raw) : {};
}

function parseUrl(req) {
  return new URL(req.url, 'http://127.0.0.1');
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function validateCreateRunBody(body) {
  const errors = [];
  if (!isNonEmptyString(body.channel)) errors.push({ field: 'channel', message: 'channel is required' });
  if (!isNonEmptyString(body.conversation_id)) errors.push({ field: 'conversation_id', message: 'conversation_id is required' });
  if (!body.user || !isNonEmptyString(body.user.open_id)) errors.push({ field: 'user.open_id', message: 'user.open_id is required' });
  if (!body.request || !isNonEmptyString(body.request.text)) errors.push({ field: 'request.text', message: 'request.text is required' });
  if (!body.delivery || !isNonEmptyString(body.delivery.mode)) errors.push({ field: 'delivery.mode', message: 'delivery.mode is required' });
  if (body.delivery && body.delivery.mode === 'callback' && !isNonEmptyString(body.delivery.callback_url)) {
    errors.push({ field: 'delivery.callback_url', message: 'delivery.callback_url is required when delivery.mode is callback' });
  }
  return errors;
}

// Maps runtime-thrown errors (carrying a stable `code`) to HTTP status + body.
function mapRuntimeError(error) {
  const code = error?.code;
  if (code === 'run_not_found') return { status: 404, body: { error_code: code, error: error.message } };
  if (code === 'resume_conflict') return { status: 409, body: { error_code: code, error: error.message } };
  if (code === 'invalid_decision_response') return { status: 400, body: { error_code: code, error: error.message } };
  if (code === 'invalid_request') return { status: 400, body: { error_code: code, error: error.message } };
  return { status: 500, body: { error_code: 'internal_error', error: 'Internal server error' } };
}

export function createHttpApp({ db, config, runStore, runtime }) {
  return http.createServer(async (req, res) => {
    const url = parseUrl(req);

    if (req.method === 'OPTIONS') {
      json(res, 204, {});
      return;
    }

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, { status: 'ok', dbPath: config.dbPath });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/query') {
        const filters = Object.fromEntries(url.searchParams.entries());
        if (filters.limit) filters.limit = Number(filters.limit);
        const results = queryEvents(db, filters);
        json(res, 200, { count: results.length, results });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/report/daily') {
        const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
        json(res, 200, { date, results: dailySummary(db, date) });
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
        const body = await readJson(req);
        const validationErrors = validateCreateRunBody(body);
        if (validationErrors.length > 0) {
          json(res, 400, { error_code: 'invalid_request', error: 'Invalid request body', details: validationErrors });
          return;
        }
        // P2-01: startRun now creates the run synchronously and kicks off
        // execution in the background, so this returns immediately (async ACK).
        const created = await runtime.startRun({
          channel: body.channel,
          conversationId: body.conversation_id,
          messageId: body.message_id,
          userOpenId: body.user?.open_id,
          requestText: body.request?.text,
          deliveryMode: body.delivery?.mode,
          callbackUrl: body.delivery?.callback_url,
          metadata: body.metadata,
          idempotencyKey: body.idempotency_key ?? req.headers['idempotency-key'],
        });
        json(res, 202, { run_id: created.run_id, status: created.status });
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/v1/runs/') && url.pathname.endsWith('/resume')) {
        const runId = url.pathname.split('/')[3];
        const body = await readJson(req);
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