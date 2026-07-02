import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDb, queryEvents, dailySummary, errorReport, toolUsageStats } from './lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(__dirname, '..', 'config.json');

if (!fs.existsSync(configPath)) {
  console.error('config.json not found.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const dbPath = path.resolve(__dirname, '..', config.dbPath);

if (!fs.existsSync(path.dirname(dbPath))) {
  console.error('No database found. Run ingest first.');
  process.exit(1);
}

const db = openDb(dbPath);
const portIdx = process.argv.indexOf('--port');
const portArg = portIdx >= 0 ? process.argv[portIdx + 1] : null;
const PORT = (portArg && /^\d+$/.test(portArg)) ? parseInt(portArg, 10) : 9320;

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function parseQuery(url) {
  const parsed = new URL(url, 'http://localhost');
  const filters = {};
  for (const [k, v] of parsed.searchParams) {
    if (v) filters[k] = v;
  }
  if (filters.limit) filters.limit = parseInt(filters.limit, 10);
  return filters;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' });
    res.end();
    return;
  }

  try {
    if (url.pathname === '/health') {
      json(res, { status: 'ok', dbPath });
    } else if (url.pathname === '/query') {
      const filters = parseQuery(req.url);
      const rows = queryEvents(db, filters);
      json(res, { count: rows.length, results: rows });
    } else if (url.pathname === '/report/daily') {
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const rows = dailySummary(db, date);
      json(res, { date, results: rows });
    } else if (url.pathname === '/report/errors') {
      const from = url.searchParams.get('from') || '1970-01-01';
      const to = url.searchParams.get('to') || '2099-12-31';
      const rows = errorReport(db, from, to);
      json(res, { from, to, count: rows.length, results: rows });
    } else if (url.pathname === '/report/tools') {
      const from = url.searchParams.get('from') || '1970-01-01';
      const to = url.searchParams.get('to') || '2099-12-31';
      const rows = toolUsageStats(db, from, to);
      json(res, { from, to, results: rows });
    } else {
      json(res, { error: 'Not found' }, 404);
    }
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Audit Logger API on http://127.0.0.1:${PORT}`);
  console.log(`  GET /health`);
  console.log(`  GET /query?agent_id=...&tool_name=...&from=...&to=...&limit=100`);
  console.log(`  GET /report/daily?date=YYYY-MM-DD`);
  console.log(`  GET /report/errors?from=...&to=...`);
  console.log(`  GET /report/tools?from=...&to=...`);
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
