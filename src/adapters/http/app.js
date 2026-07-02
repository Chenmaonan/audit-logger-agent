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
        json(res, 200, { count: queryEvents(db, filters).length, results: queryEvents(db, filters) });
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
        const created = await runtime.startRun({
          channel: body.channel,
          conversationId: body.conversation_id,
          messageId: body.message_id,
          userOpenId: body.user?.open_id,
          requestText: body.request?.text,
          deliveryMode: body.delivery?.mode,
          callbackUrl: body.delivery?.callback_url,
          metadata: body.metadata,
        });
        json(res, 202, { run_id: created.run_id, status: created.status });
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/v1/runs/') && url.pathname.endsWith('/resume')) {
        const runId = url.pathname.split('/')[3];
        const body = await readJson(req);
        const run = await runtime.resumeRun(runId, body);
        json(res, 202, { run_id: run.run_id, status: run.status });
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/v1/runs/')) {
        const runId = url.pathname.split('/').pop();
        const run = await runtime.getRun(runId);
        if (!run) {
          json(res, 404, { error: 'Run not found' });
          return;
        }
        json(res, 200, run);
        return;
      }

      json(res, 404, { error: 'Not found' });
    } catch (error) {
      json(res, 500, { error: error.message });
    }
  });
}