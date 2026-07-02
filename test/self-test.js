/**
 * Self-test for audit-logger-agent.
 * Creates a temp DB, ingests a fixture NDJSON log, then runs query + report
 * functions and asserts the results. Exits non-zero on any failure.
 *
 * Run: node test/self-test.js
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { openDb, queryEvents, dailySummary, errorReport, toolUsageStats, insertEvents } from '../scripts/lib/db.js';
import { parseNdjson, normalizeEntry } from '../scripts/lib/parser.js';
import { scanLogFiles, ingestFile } from '../scripts/lib/indexer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS: ${msg}`);
  } else {
    console.log(`  FAIL: ${msg}`);
    failures++;
  }
}

// Fixture NDJSON — covers start/end/error, agent spans, nested parent_span_id, error objects
const FIXTURE = [
  { ts: '2026-07-02T10:00:00.000+08:00', agent_id: 'rental-price-agent', trace_id: 't1', span_id: 's1', event: 'tool.start', tool_name: 'rental.read', status: 'ok', result_summary: 'Starting rental.read', channel: 'http', product_id: '761' },
  { ts: '2026-07-02T10:00:01.000+08:00', agent_id: 'rental-price-agent', trace_id: 't1', span_id: 's1', event: 'tool.end', tool_name: 'rental.read', status: 'ok', result_summary: 'Read product 761: price=99.00', duration_ms: 1000, channel: 'http', product_id: '761' },
  { ts: '2026-07-02T10:00:02.000+08:00', agent_id: 'rental-price-agent', trace_id: 't2', span_id: 's2', event: 'tool.start', tool_name: 'rental.apply', status: 'ok', result_summary: 'Starting rental.apply', channel: 'http', product_id: '762' },
  { ts: '2026-07-02T10:00:03.000+08:00', agent_id: 'rental-price-agent', trace_id: 't2', span_id: 's2', event: 'tool.error', tool_name: 'rental.apply', status: 'error', result_summary: 'Apply failed: field not found', duration_ms: 1000, channel: 'http', product_id: '762', error: { code: 'FIELD_NOT_FOUND', message: 'Field rent1day not found on page' } },
  { ts: '2026-07-02T10:00:04.000+08:00', agent_id: 'rental-price-agent', trace_id: 't3', span_id: 's3', event: 'agent.start', tool_name: 'batch.execute', status: 'ok', result_summary: 'Batch: 1 product', channel: 'cli' },
  { ts: '2026-07-02T10:00:05.000+08:00', agent_id: 'rental-price-agent', trace_id: 't3', span_id: 's4', parent_span_id: 's3', event: 'tool.start', tool_name: 'batch.processProduct', status: 'ok', result_summary: 'Starting', channel: 'cli', product_id: '761' },
  { ts: '2026-07-02T10:00:06.000+08:00', agent_id: 'rental-price-agent', trace_id: 't3', span_id: 's4', parent_span_id: 's3', event: 'tool.end', tool_name: 'batch.processProduct', status: 'ok', result_summary: 'Product 761 ok', duration_ms: 1000, channel: 'cli', product_id: '761' },
  { ts: '2026-07-02T10:00:07.000+08:00', agent_id: 'rental-price-agent', trace_id: 't3', span_id: 's3', event: 'agent.end', tool_name: 'batch.execute', status: 'ok', result_summary: 'Batch done', duration_ms: 3000, channel: 'cli' },
  { ts: '2026-07-02T11:00:00.000+08:00', agent_id: 'mt-agent', trace_id: 't4', span_id: 's5', event: 'tool.end', tool_name: 'publicTraffic.runReport', status: 'ok', result_summary: 'Report generated', duration_ms: 5000, channel: 'feishu' },
].map((e) => JSON.stringify(e)).join('\n') + '\n';

// 1. Parser validation
console.log('\n[1] Parser validation');
{
  const { entries, errors } = parseNdjson(FIXTURE);
  assert(errors.length === 0, `fixture parses with 0 errors (got ${errors.length})`);
  assert(entries.length === 9, `9 entries parsed (got ${entries.length})`);

  const bad = '{"ts":"2026-07-02","agent_id":"x","trace_id":"t","span_id":"s","event":"bad.event","tool_name":"x","status":"ok","result_summary":"x"}\n';
  const { errors: badErrors } = parseNdjson(bad);
  assert(badErrors.length > 0, `invalid event type is rejected (${badErrors.length} errors)`);
}

// 2. Setup temp DB + fixture log dir, ingest
console.log('\n[2] Ingest');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
const dbPath = path.join(tmpDir, 'audit.db');
const logDir = path.join(tmpDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(path.join(logDir, 'audit-2026-07-02.jsonl'), FIXTURE, 'utf-8');

const db = openDb(dbPath);

{
  const result = ingestFile(db, path.join(logDir, 'audit-2026-07-02.jsonl'));
  assert(result.inserted === 9, `ingest inserts 9 events (got ${result.inserted})`);
  assert(result.errors.length === 0, `ingest reports 0 errors`);
}

// 3. Idempotency — re-ingest must not duplicate
console.log('\n[3] Idempotency');
{
  const result = ingestFile(db, path.join(logDir, 'audit-2026-07-02.jsonl'));
  assert(result.inserted === 0, `re-ingest inserts 0 events (got ${result.inserted})`);
}

// 4. Query filters
console.log('\n[4] Query');
{
  const all = queryEvents(db, {});
  assert(all.length === 9, `query all returns 9 (got ${all.length})`);

  const errs = queryEvents(db, { status: 'error' });
  assert(errs.length === 1, `query status=error returns 1 (got ${errs.length})`);

  const trace = queryEvents(db, { trace_id: 't3' });
  assert(trace.length === 4, `query trace=t3 returns 4 spans (got ${trace.length})`);

  const agent = queryEvents(db, { agent_id: 'mt-agent' });
  assert(agent.length === 1, `query agent=mt-agent returns 1 (got ${agent.length})`);

  const wild = queryEvents(db, { tool_name: 'rental.%' });
  assert(wild.length === 4, `query tool=rental.% (LIKE) returns 4 (got ${wild.length})`);
}

// 5. Reports
console.log('\n[5] Reports');
{
  const daily = dailySummary(db, '2026-07-02');
  assert(daily.length >= 5, `daily summary has >=5 rows (got ${daily.length})`);

  const dailyAgent = dailySummary(db, '2026-07-02', 'mt-agent');
  assert(dailyAgent.length === 1, `daily filtered to mt-agent has 1 row (got ${dailyAgent.length})`);
  assert(dailyAgent[0].agent_id === 'mt-agent', `daily mt-agent row agent_id correct`);

  const errs = errorReport(db, '1970-01-01', '2099-12-31');
  assert(errs.length === 1, `error report returns 1 (got ${errs.length})`);
  assert(errs[0].error_code === 'FIELD_NOT_FOUND', `error report has error_code FIELD_NOT_FOUND`);

  const errsFiltered = errorReport(db, '1970-01-01', '2099-12-31', 'mt-agent');
  assert(errsFiltered.length === 0, `error report filtered to mt-agent returns 0 (got ${errsFiltered.length})`);

  const tools = toolUsageStats(db, '1970-01-01', '2099-12-31');
  const applyRow = tools.find((r) => r.tool_name === 'rental.apply');
  assert(applyRow && applyRow.error_count === 1, `tool stats: rental.apply has 1 error`);
  const readRow = tools.find((r) => r.tool_name === 'rental.read');
  assert(readRow && readRow.ok_count === 1 && readRow.avg_duration_ms === 1000, `tool stats: rental.read avg_duration_ms=1000`);
}

// 6. scanLogFiles --since filter
console.log('\n[6] scanLogFiles --since');
{
  const allFiles = scanLogFiles(logDir, 'audit-*.jsonl');
  assert(allFiles.length === 1, `scan finds 1 file (got ${allFiles.length})`);

  const futureFiles = scanLogFiles(logDir, 'audit-*.jsonl', '2030-01-01');
  assert(futureFiles.length === 0, `scan --since 2030 finds 0 files (got ${futureFiles.length})`);

  const pastFiles = scanLogFiles(logDir, 'audit-*.jsonl', '2026-07-01');
  assert(pastFiles.length === 1, `scan --since 2026-07-01 finds 1 file (got ${pastFiles.length})`);
}

// Cleanup
db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);