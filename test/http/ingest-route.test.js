import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb } from '../../scripts/lib/db.js';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createIngestCursorStore } from '../../src/auditReview/ingestCursorStore.js';
import { createAuditIngestService } from '../../src/auditReview/ingestService.js';
import { createHttpApp } from '../../src/adapters/http/app.js';

function makeEvent(overrides = {}) {
  return {
    ts: '2026-07-06T01:02:03.000Z',
    agent_id: 'remote-agent',
    trace_id: 'trace-1',
    span_id: 'span-1',
    event: 'tool.end',
    tool_name: 'example.tool',
    status: 'ok',
    result_summary: 'ok',
    ...overrides,
  };
}

async function withIngestServer(fn, configOverrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-http-ingest-'));
  const dbPath = path.join(tmpDir, 'audit.db');
  const db = openDb(dbPath);
  ensureReviewSchema(db);
  const config = {
    dbPath,
    agents: {},
    ingest: {
      http: { enabled: true, maxBodyBytes: 1024, maxLineBytes: 512 },
      spoolDir: path.join(tmpDir, 'incoming'),
    },
    ...configOverrides,
  };
  const cursorStore = createIngestCursorStore(db);
  const ingestService = createAuditIngestService({ db, config, cursorStore });
  const server = createHttpApp({ db, config });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await fn({
      baseUrl: `http://127.0.0.1:${port}`,
      tmpDir,
      db,
      config,
      ingestService,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function readSpool(config, agentId, date = '2026-07-06') {
  const file = path.join(config.ingest.spoolDir, agentId, `audit-${date}.jsonl`);
  return fs.readFileSync(file, 'utf-8');
}

test('POST /v1/ingest accepts one JSON event, spools it, and ingestSince imports it', async () => {
  await withIngestServer(async ({ baseUrl, config, ingestService, db }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeEvent({ trace_id: 'json-single', span_id: 'span-json-single' })),
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 1, rejected: 0, errors: [] });
    assert.match(readSpool(config, 'remote-agent'), /json-single/);

    const ingestResult = ingestService.ingestSince({ sinceDate: '2026-07-06' });
    assert.equal(ingestResult.inserted, 1);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE trace_id = ?').get('json-single').count,
      1
    );
  });
});

test('POST /v1/ingest accepts JSON event batches', async () => {
  await withIngestServer(async ({ baseUrl, config, ingestService, db }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          makeEvent({ trace_id: 'batch-1', span_id: 'span-batch-1' }),
          makeEvent({ trace_id: 'batch-2', span_id: 'span-batch-2' }),
        ],
      }),
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 2, rejected: 0, errors: [] });
    assert.match(readSpool(config, 'remote-agent'), /batch-1/);
    assert.match(readSpool(config, 'remote-agent'), /batch-2/);

    const ingestResult = ingestService.ingestSince({ sinceDate: '2026-07-06' });
    assert.equal(ingestResult.inserted, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 2);
  });
});

test('POST /v1/ingest accepts NDJSON bodies', async () => {
  await withIngestServer(async ({ baseUrl, config, ingestService, db }) => {
    const body = [
      JSON.stringify(makeEvent({ trace_id: 'ndjson-1', span_id: 'span-ndjson-1' })),
      JSON.stringify(makeEvent({ trace_id: 'ndjson-2', span_id: 'span-ndjson-2' })),
    ].join('\n') + '\n';

    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body,
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 2, rejected: 0, errors: [] });
    assert.match(readSpool(config, 'remote-agent'), /ndjson-1/);
    assert.match(readSpool(config, 'remote-agent'), /ndjson-2/);

    const ingestResult = ingestService.ingestSince({ sinceDate: '2026-07-06' });
    assert.equal(ingestResult.inserted, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 2);
  });
});

test('POST /v1/ingest rejects path-traversal agent_id and writes nothing outside spool', async () => {
  await withIngestServer(async ({ baseUrl, config, tmpDir }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeEvent({ agent_id: '../evil', trace_id: 'evil' })),
    });

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.accepted, 0);
    assert.equal(body.rejected, 1);
    assert.match(body.errors[0].error, /agent_id/);
    assert.equal(fs.existsSync(path.join(config.ingest.spoolDir, 'evil')), false);
    assert.equal(fs.existsSync(path.join(tmpDir, 'evil')), false);
  });
});

test('POST /v1/ingest returns 413 for oversized bodies', async () => {
  await withIngestServer(async ({ baseUrl, config }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeEvent({ result_summary: 'x'.repeat(600) })),
    });

    assert.equal(response.status, 413);
    assert.equal(fs.existsSync(config.ingest.spoolDir), false);
  }, {
    ingest: {
      http: { enabled: true, maxBodyBytes: 300, maxLineBytes: 512 },
      spoolDir: path.join(os.tmpdir(), `audit-http-ingest-unused-${Date.now()}`),
    },
  });
});

test('POST /v1/ingest rejects overlong events and does not spool them', async () => {
  await withIngestServer(async ({ baseUrl, config }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeEvent({ result_summary: 'x'.repeat(80) })),
    });

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.accepted, 0);
    assert.equal(body.rejected, 1);
    assert.match(body.errors[0].error, /maxLineBytes/);
    assert.equal(fs.existsSync(config.ingest.spoolDir), false);
  }, {
    ingest: {
      http: { enabled: true, maxBodyBytes: 1024, maxLineBytes: 120 },
      spoolDir: path.join(os.tmpdir(), `audit-http-ingest-overlong-${Date.now()}`),
    },
  });
});

test('POST /v1/ingest counts one invalid event as one rejected row', async () => {
  await withIngestServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'remote-agent' }),
    });

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.accepted, 0);
    assert.equal(body.rejected, 1);
    assert.ok(body.errors.length > 1);
  });
});

test('POST /v1/ingest reposting the same row ingests once through existing dedupe', async () => {
  await withIngestServer(async ({ baseUrl, ingestService, db }) => {
    const event = makeEvent({ trace_id: 'dedupe', span_id: 'span-dedupe' });
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${baseUrl}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      });
      assert.equal(response.status, 202);
      assert.equal((await response.json()).accepted, 1);
    }

    const ingestResult = ingestService.ingestSince({ sinceDate: '2026-07-06' });
    assert.equal(ingestResult.inserted, 1);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE trace_id = ?').get('dedupe').count,
      1
    );
  });
});

test('POST /v1/ingest is disabled when ingest.http.enabled is false', async () => {
  await withIngestServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeEvent()),
    });

    assert.equal(response.status, 404);
  }, {
    ingest: {
      http: { enabled: false, maxBodyBytes: 1024, maxLineBytes: 512 },
      spoolDir: path.join(os.tmpdir(), `audit-http-ingest-disabled-${Date.now()}`),
    },
  });
});
