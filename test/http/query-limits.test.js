import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, insertEvents } from '../../scripts/lib/db.js';
import { createHttpApp } from '../../src/adapters/http/app.js';

function makeEvent(index) {
  const event = {
    ts: `2026-07-03T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
    agent_id: 'test-agent',
    trace_id: `trace-${index}`,
    span_id: `span-${index}`,
    event: 'tool.end',
    tool_name: 'example.tool',
    status: 'ok',
    result_summary: `ok-${index}`,
  };
  return {
    ts: event.ts,
    agent_id: event.agent_id,
    trace_id: event.trace_id,
    span_id: event.span_id,
    parent_span_id: null,
    event: event.event,
    tool_name: event.tool_name,
    status: event.status,
    result_summary: event.result_summary,
    duration_ms: null,
    channel: null,
    user_id: null,
    product_id: null,
    error_code: null,
    error_message: null,
    tags: null,
    raw_json: JSON.stringify(event),
  };
}

test('GET /query clamps huge limit to configured maximum', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-http-query-limit-'));
  let server;
  let db;
  try {
    const dbPath = path.join(tmpDir, 'audit.db');
    db = openDb(dbPath);
    insertEvents(db, Array.from({ length: 1005 }, (_, index) => makeEvent(index)));
    server = createHttpApp({
      db,
      config: {
        dbPath,
        agents: {},
        limits: { maxQueryLimit: 1000 },
      },
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/query?limit=99999999`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.count, 1000);
    assert.equal(body.results.length, 1000);
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    db?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
