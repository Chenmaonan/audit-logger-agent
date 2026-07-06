import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createIngestCursorStore } from '../../src/auditReview/ingestCursorStore.js';
import { createRetentionService } from '../../src/auditReview/retention.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const AUDIT_EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_events (
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
`;

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = OFF');
  db.exec(AUDIT_EVENTS_SCHEMA);
  ensureRuntimeSchema(db);
  ensureReviewSchema(db);
  return db;
}

function makeFileDb(rootDir) {
  const dbPath = path.join(rootDir, 'data', 'audit.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = OFF');
  db.exec(AUDIT_EVENTS_SCHEMA);
  ensureRuntimeSchema(db);
  ensureReviewSchema(db);
  return db;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-retention-'));
}

function makeConfig(rootDir, overrides = {}) {
  return {
    rootDir,
    dbPath: path.join(rootDir, 'data', 'audit.db'),
    agents: {},
    ingest: {
      spoolDir: 'data/incoming',
    },
    retention: {
      enabled: true,
      runAtHour: 4,
      eventsDays: 90,
      resolvedFindingsDays: 30,
      reviewRunsDays: 60,
      outboxDays: 14,
      vacuum: 'incremental',
      ...overrides.retention,
    },
    ...overrides,
  };
}

function insertEvent(db, id, ts) {
  db.prepare(`
    INSERT INTO audit_events (
      row_hash, ts, agent_id, trace_id, span_id, parent_span_id, event,
      tool_name, status, result_summary, duration_ms, channel, user_id,
      product_id, error_code, error_message, tags, raw_json
    ) VALUES (
      @row_hash, @ts, 'agent', 'trace', @span_id, NULL, 'tool.end',
      'tool.name', 'ok', NULL, 1, NULL, NULL,
      NULL, NULL, NULL, NULL, '{}'
    )
  `).run({ row_hash: `hash-${id}`, ts, span_id: `span-${id}` });
}

function insertReviewRun(db, id, startedAt) {
  db.prepare(`
    INSERT INTO audit_review_runs (
      review_id, window_from, window_to, status, trigger_type,
      risk_policy_version, reviewer_version, started_at
    ) VALUES (
      @review_id, @started_at, @started_at, 'completed', 'scheduled',
      'risk-policy-v1', 'reviewer-v1', @started_at
    )
  `).run({ review_id: id, started_at: startedAt });
}

function insertFinding(db, id, { status, createdAt, resolvedAt = null, acknowledgedAt = null }) {
  db.prepare(`
    INSERT INTO audit_review_findings (
      finding_id, review_id, finding_hash, category, severity, title, summary,
      evidence_event_ids_json, status, created_at, last_seen_at, resolved_at,
      acknowledged_at, risk_policy_version, reviewer_version
    ) VALUES (
      @finding_id, 'review-1', @finding_hash, 'failed_call', 'medium', 'title', 'summary',
      '[]', @status, @created_at, @created_at, @resolved_at,
      @acknowledged_at, 'risk-policy-v1', 'reviewer-v1'
    )
  `).run({
    finding_id: id,
    finding_hash: `hash-${id}`,
    status,
    created_at: createdAt,
    resolved_at: resolvedAt,
    acknowledged_at: acknowledgedAt,
  });
}

function insertOutbox(db, id, { status, createdAt }) {
  db.prepare(`
    INSERT INTO agent_outbox_events (
      event_id, run_id, type, payload_json, delivery_mode, delivery_status,
      delivery_attempts, max_attempts, created_at
    ) VALUES (
      @event_id, 'run-1', 'run.completed', '{}', 'callback', @delivery_status,
      0, 8, @created_at
    )
  `).run({ event_id: id, delivery_status: status, created_at: createdAt });
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

test('retention dry-run reports expired rows without deleting protected data', () => {
  const rootDir = tmpDir();
  const db = makeDb();
  const service = createRetentionService({
    db,
    config: makeConfig(rootDir),
    cursorStore: createIngestCursorStore(db),
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  insertEvent(db, 1, '2026-03-01T00:00:00.000Z');
  insertEvent(db, 2, '2026-06-20T00:00:00.000Z');
  insertReviewRun(db, 'old-run', '2026-04-01T00:00:00.000Z');
  insertReviewRun(db, 'new-run', '2026-06-20T00:00:00.000Z');
  insertFinding(db, 'resolved-old', {
    status: 'resolved',
    createdAt: '2026-04-01T00:00:00.000Z',
    resolvedAt: '2026-05-01T00:00:00.000Z',
  });
  insertFinding(db, 'open-old', {
    status: 'open',
    createdAt: '2026-04-01T00:00:00.000Z',
  });
  insertFinding(db, 'acked-old', {
    status: 'acknowledged',
    createdAt: '2026-04-01T00:00:00.000Z',
    acknowledgedAt: '2026-05-01T00:00:00.000Z',
  });
  insertOutbox(db, 'delivered-old', { status: 'delivered', createdAt: '2026-06-01T00:00:00.000Z' });
  insertOutbox(db, 'dead-old', { status: 'dead_letter', createdAt: '2026-06-01T00:00:00.000Z' });
  insertOutbox(db, 'pending-old', { status: 'pending', createdAt: '2026-06-01T00:00:00.000Z' });

  const result = service.run({ dryRun: true });

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.deleted, {
    auditEvents: 1,
    reviewRuns: 1,
    resolvedFindings: 1,
    outboxEvents: 2,
    ingestCursors: 0,
    spoolFiles: 0,
  });
  assert.equal(count(db, 'audit_events'), 2);
  assert.equal(count(db, 'audit_review_runs'), 2);
  assert.equal(count(db, 'audit_review_findings'), 3);
  assert.equal(count(db, 'agent_outbox_events'), 3);

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention deletes expired data in batches and keeps open or acknowledged findings', () => {
  const rootDir = tmpDir();
  const db = makeDb();
  const service = createRetentionService({
    db,
    config: makeConfig(rootDir),
    cursorStore: createIngestCursorStore(db),
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  for (let i = 1; i <= 5; i++) {
    insertEvent(db, i, `2026-03-0${i}T00:00:00.000Z`);
  }
  insertEvent(db, 99, '2026-07-01T00:00:00.000Z');
  insertFinding(db, 'resolved-old', {
    status: 'resolved',
    createdAt: '2026-04-01T00:00:00.000Z',
    resolvedAt: '2026-05-01T00:00:00.000Z',
  });
  insertFinding(db, 'open-old', {
    status: 'open',
    createdAt: '2026-04-01T00:00:00.000Z',
  });
  insertFinding(db, 'acked-old', {
    status: 'acknowledged',
    createdAt: '2026-04-01T00:00:00.000Z',
    acknowledgedAt: '2026-05-01T00:00:00.000Z',
  });

  const result = service.run({ batchSize: 2 });

  assert.equal(result.deleted.auditEvents, 5);
  assert.ok(result.batches.auditEvents.every((n) => n <= 2), 'each audit_events delete batch should respect batchSize');
  assert.deepEqual(
    db.prepare(`SELECT row_hash FROM audit_events ORDER BY row_hash`).all().map((row) => row.row_hash),
    ['hash-99'],
  );
  assert.deepEqual(
    db.prepare(`SELECT finding_id FROM audit_review_findings ORDER BY finding_id`).all().map((row) => row.finding_id),
    ['acked-old', 'open-old'],
  );

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention removes safe expired spool files and orphan cursors', () => {
  const rootDir = tmpDir();
  const spoolAgentDir = path.join(rootDir, 'data', 'incoming', 'agent-a');
  fs.mkdirSync(spoolAgentDir, { recursive: true });
  const oldComplete = path.join(spoolAgentDir, 'audit-2026-03-01.jsonl');
  const oldPartial = path.join(spoolAgentDir, 'audit-2026-03-02.jsonl');
  const fresh = path.join(spoolAgentDir, 'audit-2026-07-01.jsonl');
  fs.writeFileSync(oldComplete, '{"ok":true}\n');
  fs.writeFileSync(oldPartial, '{"partial":');
  fs.writeFileSync(fresh, '{"ok":true}\n');
  const oldTime = new Date('2026-03-01T00:00:00.000Z');
  const freshTime = new Date('2026-07-01T00:00:00.000Z');
  fs.utimesSync(oldComplete, oldTime, oldTime);
  fs.utimesSync(oldPartial, oldTime, oldTime);
  fs.utimesSync(fresh, freshTime, freshTime);

  const db = makeDb();
  const cursorStore = createIngestCursorStore(db);
  cursorStore.upsert({
    agentId: 'agent-a',
    filePath: oldComplete,
    fileMtimeMs: fs.statSync(oldComplete).mtimeMs,
    fileSizeBytes: fs.statSync(oldComplete).size,
    offsetBytes: fs.statSync(oldComplete).size,
  });
  cursorStore.upsert({
    agentId: 'agent-a',
    filePath: oldPartial,
    fileMtimeMs: fs.statSync(oldPartial).mtimeMs,
    fileSizeBytes: fs.statSync(oldPartial).size,
    offsetBytes: 0,
  });
  cursorStore.upsert({
    agentId: 'agent-a',
    filePath: path.join(spoolAgentDir, 'missing.jsonl'),
    fileMtimeMs: 1,
    fileSizeBytes: 1,
    offsetBytes: 1,
  });

  const service = createRetentionService({
    db,
    config: makeConfig(rootDir),
    cursorStore,
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  const result = service.run();

  assert.equal(result.deleted.spoolFiles, 1);
  assert.equal(result.deleted.ingestCursors, 2);
  assert.equal(fs.existsSync(oldComplete), false);
  assert.equal(fs.existsSync(oldPartial), true);
  assert.equal(fs.existsSync(fresh), true);
  assert.deepEqual(
    db.prepare(`SELECT file_path FROM audit_ingest_cursors ORDER BY file_path`).all().map((row) => row.file_path),
    [oldPartial],
  );

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention keeps expired newline-complete spool files without completed cursor proof', () => {
  const rootDir = tmpDir();
  const spoolAgentDir = path.join(rootDir, 'data', 'incoming', 'agent-a');
  fs.mkdirSync(spoolAgentDir, { recursive: true });
  const oldCompleteWithoutCursor = path.join(spoolAgentDir, 'audit-2026-03-01.jsonl');
  fs.writeFileSync(oldCompleteWithoutCursor, '{"accepted":true}\n');
  const oldTime = new Date('2026-03-01T00:00:00.000Z');
  fs.utimesSync(oldCompleteWithoutCursor, oldTime, oldTime);

  const db = makeDb();
  const cursorStore = createIngestCursorStore(db);
  const service = createRetentionService({
    db,
    config: makeConfig(rootDir),
    cursorStore,
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  const result = service.run();

  assert.equal(result.deleted.spoolFiles, 0);
  assert.equal(fs.existsSync(oldCompleteWithoutCursor), true);

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention dry-run counts cursors that would become orphaned by spool cleanup', () => {
  const rootDir = tmpDir();
  const spoolAgentDir = path.join(rootDir, 'data', 'incoming', 'agent-a');
  fs.mkdirSync(spoolAgentDir, { recursive: true });
  const oldComplete = path.join(spoolAgentDir, 'audit-2026-03-01.jsonl');
  fs.writeFileSync(oldComplete, '{"ok":true}\n');
  const oldTime = new Date('2026-03-01T00:00:00.000Z');
  fs.utimesSync(oldComplete, oldTime, oldTime);

  const db = makeDb();
  const cursorStore = createIngestCursorStore(db);
  cursorStore.upsert({
    agentId: 'agent-a',
    filePath: oldComplete,
    fileMtimeMs: fs.statSync(oldComplete).mtimeMs,
    fileSizeBytes: fs.statSync(oldComplete).size,
    offsetBytes: fs.statSync(oldComplete).size,
  });

  const service = createRetentionService({
    db,
    config: makeConfig(rootDir),
    cursorStore,
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  const result = service.run({ dryRun: true });

  assert.equal(result.deleted.spoolFiles, 1);
  assert.equal(result.deleted.ingestCursors, 1);
  assert.equal(fs.existsSync(oldComplete), true);
  assert.equal(count(db, 'audit_ingest_cursors'), 1);

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('prune CLI supports dry-run', () => {
  const rootDir = tmpDir();
  fs.writeFileSync(path.join(rootDir, 'config.json'), JSON.stringify(makeConfig(rootDir), null, 2));

  const result = spawnSync(process.execPath, ['scripts/prune.js', '--dry-run'], {
    cwd: repoRoot,
    env: { ...process.env, AUDIT_LOGGER_ROOT: rootDir },
    encoding: 'utf-8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"dryRun": true/);
  assert.match(result.stdout, /"auditEvents": 0/);

  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('prune CLI rejects missing batch size before cleanup', () => {
  const rootDir = tmpDir();
  fs.writeFileSync(path.join(rootDir, 'config.json'), JSON.stringify(makeConfig(rootDir), null, 2));

  const db = makeFileDb(rootDir);
  insertEvent(db, 1, '2026-03-01T00:00:00.000Z');
  db.close();

  const result = spawnSync(process.execPath, ['scripts/prune.js', '--batch-size', '--dry-run'], {
    cwd: repoRoot,
    env: { ...process.env, AUDIT_LOGGER_ROOT: rootDir },
    encoding: 'utf-8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--batch-size requires a positive integer/i);

  const verifyDb = new Database(path.join(rootDir, 'data', 'audit.db'));
  assert.equal(count(verifyDb, 'audit_events'), 1);
  verifyDb.close();

  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('prune CLI rejects invalid batch size before cleanup', () => {
  const rootDir = tmpDir();
  fs.writeFileSync(path.join(rootDir, 'config.json'), JSON.stringify(makeConfig(rootDir), null, 2));

  const db = makeFileDb(rootDir);
  insertEvent(db, 1, '2026-03-01T00:00:00.000Z');
  db.close();

  const result = spawnSync(process.execPath, ['scripts/prune.js', '--batch-size', 'nope', '--dry-run'], {
    cwd: repoRoot,
    env: { ...process.env, AUDIT_LOGGER_ROOT: rootDir },
    encoding: 'utf-8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--batch-size requires a positive integer/i);

  const verifyDb = new Database(path.join(rootDir, 'data', 'audit.db'));
  assert.equal(count(verifyDb, 'audit_events'), 1);
  verifyDb.close();

  fs.rmSync(rootDir, { recursive: true, force: true });
});
