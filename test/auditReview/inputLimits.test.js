import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { parseNdjson } from '../../scripts/lib/parser.js';
import { insertEvents, openDb, queryEvents } from '../../scripts/lib/db.js';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createIngestCursorStore } from '../../src/auditReview/ingestCursorStore.js';
import { createAuditIngestService } from '../../src/auditReview/ingestService.js';

function makeEvent(index, overrides = {}) {
  return {
    ts: `2026-07-03T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
    agent_id: 'test-agent',
    trace_id: `trace-${index}`,
    span_id: `span-${index}`,
    event: 'tool.end',
    tool_name: 'example.tool',
    status: 'ok',
    result_summary: `ok-${index}`,
    ...overrides,
  };
}

function normalizeForInsert(event) {
  return {
    ts: event.ts,
    agent_id: event.agent_id,
    trace_id: event.trace_id,
    span_id: event.span_id,
    parent_span_id: event.parent_span_id || null,
    event: event.event,
    tool_name: event.tool_name,
    status: event.status,
    result_summary: event.result_summary,
    duration_ms: event.duration_ms ?? null,
    channel: event.channel || null,
    user_id: event.user_id || null,
    product_id: event.product_id || null,
    error_code: null,
    error_message: null,
    tags: null,
    raw_json: JSON.stringify(event),
  };
}

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      row_hash TEXT UNIQUE NOT NULL,
      ts TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      parent_span_id TEXT,
      event TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      result_summary TEXT,
      duration_ms INTEGER,
      channel TEXT,
      user_id TEXT,
      product_id TEXT,
      error_code TEXT,
      error_message TEXT,
      tags TEXT,
      raw_json TEXT
    );
    CREATE INDEX idx_audit_ts ON audit_events(ts);
  `);
  ensureReviewSchema(db);
  return db;
}

test('parseNdjson rejects over-max lines without JSON.parse', () => {
  const originalParse = JSON.parse;
  let parseCalls = 0;
  JSON.parse = (...args) => {
    parseCalls += 1;
    return originalParse(...args);
  };

  try {
    const overLimitLine = '{"result":"' + 'x'.repeat(80) + '"}';
    const result = parseNdjson(`${overLimitLine}\n`, { maxLineBytes: 64 });

    assert.equal(parseCalls, 0);
    assert.equal(result.entries.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /line 1: exceeds maxLineBytes \(64\)/);
  } finally {
    JSON.parse = originalParse;
  }
});

test('ingestSince continues reading an unchanged large append over multiple limited chunks', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-input-limits-'));
  try {
    const logDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'audit-2026-07-03.jsonl');
    const lines = [
      JSON.stringify(makeEvent(1)),
      JSON.stringify(makeEvent(2)),
      JSON.stringify(makeEvent(3)),
    ];
    fs.writeFileSync(logFile, `${lines.join('\n')}\n`, 'utf-8');

    const dbPath = path.join(tmpDir, 'audit.db');
    const db = makeDb();
    const cursorStore = createIngestCursorStore(db);
    const config = {
      dbPath,
      agents: {
        'test-agent': {
          logDir: path.relative(path.dirname(dbPath), logDir),
          pattern: 'audit-*.jsonl',
        },
      },
      limits: {
        maxChunkBytes: Buffer.byteLength(lines[0], 'utf-8') + 8,
        maxLineBytes: 65536,
      },
    };
    const service = createAuditIngestService({ db, config, cursorStore });

    const first = service.ingestSince({ sinceDate: '2026-07-03' });
    const second = service.ingestSince({ sinceDate: '2026-07-03' });
    const third = service.ingestSince({ sinceDate: '2026-07-03' });

    assert.equal(first.inserted, 1);
    assert.equal(second.inserted, 1);
    assert.equal(third.inserted, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 3);

    const cursor = cursorStore.get({ agentId: 'test-agent', filePath: logFile });
    assert.equal(cursor.offset_bytes, cursor.file_size_bytes);
    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ingestSince records overlong line errors without inserting the row', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-overlong-line-'));
  let db;
  try {
    const logDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'audit-2026-07-03.jsonl');
    const validLine = JSON.stringify(makeEvent(1));
    const overlongLine = '{"ts":"' + 'x'.repeat(64 * 1024) + '"}';
    fs.writeFileSync(logFile, `${overlongLine}\n${validLine}\n`, 'utf-8');

    const dbPath = path.join(tmpDir, 'audit.db');
    db = makeDb();
    const cursorStore = createIngestCursorStore(db);
    const service = createAuditIngestService({
      db,
      cursorStore,
      config: {
        dbPath,
        agents: {
          'test-agent': {
            logDir: path.relative(path.dirname(dbPath), logDir),
            pattern: 'audit-*.jsonl',
          },
        },
        limits: {
          maxLineBytes: 64 * 1024,
          maxChunkBytes: 16 * 1024 * 1024,
        },
      },
    });

    const result = service.ingestSince({ sinceDate: '2026-07-03' });

    assert.equal(result.inserted, 1);
    assert.equal(result.parseErrors.length, 1);
    assert.match(result.parseErrors[0].error, /line 1: exceeds maxLineBytes \(65536\)/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 1);
    assert.equal(db.prepare('SELECT trace_id FROM audit_events').get().trace_id, 'trace-1');
  } finally {
    db?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('queryEvents clamps requested limit to the default maximum', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-query-limit-'));
  let db;
  try {
    db = openDb(path.join(tmpDir, 'audit.db'));
    const rows = Array.from({ length: 1005 }, (_, index) => normalizeForInsert(makeEvent(index)));
    insertEvents(db, rows);

    const results = queryEvents(db, { limit: 99999999 });

    assert.equal(results.length, 1000);
  } finally {
    db?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
