import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { normalizeEventId } from '../scripts/lib/auditSpec.js';
import { openDb, insertEvents, queryEvents } from '../scripts/lib/db.js';
import { normalizeEntry, parseNdjson } from '../scripts/lib/parser.js';

function validEntry(overrides = {}) {
  return {
    ts: '2026-07-06T01:02:03.000Z',
    agent_id: 'agent-1',
    trace_id: 'trace-1',
    span_id: 'span-1',
    event: 'tool.end',
    tool_name: 'example.tool',
    status: 'OK',
    result_summary: 'done',
    entity: { type: 'document', id: 'doc-1' },
    ...overrides,
  };
}

function parseOne(entry) {
  return parseNdjson(`${JSON.stringify(entry)}\n`);
}

test('normalizeEventId maps known aliases to canonical event ids only', () => {
  assert.equal(normalizeEventId('tool.end'), 'tool.end');
  assert.equal(normalizeEventId('tool/end'), 'tool.end');
  assert.equal(normalizeEventId('tool_end'), 'tool.end');
  assert.equal(normalizeEventId('tool-end'), 'tool.end');
  assert.equal(normalizeEventId('review-notification-enqueued'), 'review.notification.enqueued');
  assert.equal(normalizeEventId('tool/unknown'), null);
});

test('parser accepts canonical audit event fields and normalizes entity and llm_intent', () => {
  const { entries, errors } = parseOne(validEntry({
    parent_span_id: '',
    user_id: '',
    llm_intent: { input: 'summarize request', output: 'return concise answer' },
    error: { message: 'not used for OK' },
  }));

  assert.deepEqual(errors, []);
  assert.equal(entries.length, 1);

  const row = normalizeEntry(entries[0]);
  assert.equal(row.status, 'OK');
  assert.equal(row.parent_span_id, null);
  assert.equal(row.user_id, null);
  assert.equal(row.entity_type, 'document');
  assert.equal(row.entity_id, 'doc-1');
  assert.equal(row.error_message, 'not used for OK');
  assert.equal(row.llm_intent_json, JSON.stringify({ input: 'summarize request', output: 'return concise answer' }));
  assert.equal(Object.hasOwn(row, 'product_id'), false);
  assert.equal(Object.hasOwn(row, 'error_code'), false);
});

test('parser accepts alias event ids and stores canonical event while preserving raw event', () => {
  const entry = validEntry({ event: 'tool/end' });
  const { entries, errors } = parseOne(entry);

  assert.deepEqual(errors, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, 'tool/end');

  const row = normalizeEntry(entries[0]);
  assert.equal(row.event, 'tool.end');
  assert.equal(JSON.parse(row.raw_json).event, 'tool/end');
});

test('parser rejects legacy and malformed audit fields', () => {
  const cases = [
    ['legacy product_id', validEntry({ product_id: 'prod-1' }), /product_id/],
    ['legacy error.code', validEntry({ status: 'INTERNAL', error: { code: 'boom', message: 'boom' } }), /error\.code/],
    ['non-string parent_span_id', validEntry({ parent_span_id: 123 }), /parent_span_id/],
    ['non-string user_id', validEntry({ user_id: 123 }), /user_id/],
    ['incomplete entity', validEntry({ entity: { type: 'document' } }), /entity/],
    ['bad llm_intent', validEntry({ llm_intent: { input: 'x', output: 1 } }), /llm_intent/],
    ['non-canonical status', validEntry({ status: 'error' }), /status/],
    ['unknown event', validEntry({ event: 'tool/unknown' }), /invalid event/],
  ];

  for (const [name, entry, pattern] of cases) {
    const { entries, errors } = parseOne(entry);
    assert.equal(entries.length, 0, name);
    assert.ok(errors.some((error) => pattern.test(error)), `${name}: ${errors.join('; ')}`);
  }
});

test('insertEvents stores canonical event and preserves original raw event for dedupe traceability', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-event-alias-db-'));
  const db = openDb(path.join(tmpDir, 'audit.db'));
  try {
    const row = normalizeEntry(validEntry({
      trace_id: 'trace-alias',
      event: 'tool_end',
    }));

    assert.equal(row.event, 'tool.end');
    assert.equal(JSON.parse(row.raw_json).event, 'tool_end');
    assert.equal(insertEvents(db, [row]), 1);

    const stored = queryEvents(db, { trace_id: 'trace-alias' });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].event, 'tool.end');
    assert.equal(JSON.parse(stored[0].raw_json).event, 'tool_end');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('insertEvents stores entity and llm_intent columns and queryEvents filters by entity', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-spec-db-'));
  const db = openDb(path.join(tmpDir, 'audit.db'));
  try {
    const row = normalizeEntry(validEntry({
      trace_id: 'trace-entity',
      llm_intent: { input: 'look up doc', output: 'doc answer' },
    }));

    assert.equal(insertEvents(db, [row]), 1);

    const byEntity = queryEvents(db, { entity_type: 'document', entity_id: 'doc-1' });
    assert.equal(byEntity.length, 1);
    assert.equal(byEntity[0].trace_id, 'trace-entity');
    assert.equal(byEntity[0].entity_type, 'document');
    assert.equal(byEntity[0].entity_id, 'doc-1');
    assert.equal(byEntity[0].llm_intent_json, JSON.stringify({ input: 'look up doc', output: 'doc answer' }));

    const missing = queryEvents(db, { entity_type: 'document', entity_id: 'doc-2' });
    assert.equal(missing.length, 0);

    const columns = db.prepare('PRAGMA table_info(audit_events)').all().map((column) => column.name);
    assert.ok(columns.includes('entity_type'));
    assert.ok(columns.includes('entity_id'));
    assert.ok(columns.includes('llm_intent_json'));
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('openDb migrates legacy audit_events before creating entity index', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-legacy-db-'));
  const dbPath = path.join(tmpDir, 'audit.db');
  let db = openDb(dbPath);
  try {
    db.exec('DROP INDEX IF EXISTS idx_audit_entity;');
    db.exec('DROP TABLE audit_events;');
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
        error_message TEXT,
        tags TEXT,
        raw_json TEXT
      );
    `);
  } finally {
    db.close();
  }

  db = openDb(dbPath);
  try {
    const columns = db.prepare('PRAGMA table_info(audit_events)').all().map((column) => column.name);
    assert.ok(columns.includes('entity_type'));
    assert.ok(columns.includes('entity_id'));
    assert.ok(columns.includes('llm_intent_json'));
    const index = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_audit_entity'
    `).get();
    assert.equal(index.name, 'idx_audit_entity');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
