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
  entity_type TEXT,
  entity_id TEXT,
  llm_intent_json TEXT,
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
      spoolDir: 'data/spool/incoming',
    },
    capturesDir: 'data/captures',
    tmpDir: 'data/tmp',
    logDir: 'logs',
    retention: {
      enabled: true,
      runAtHour: 4,
      eventsDays: 90,
      runtimeRunsDays: 30,
      waitingStatesDays: 30,
      resolvedFindingsDays: 30,
      reviewRunsDays: 60,
      llmUsageDays: 90,
      outboxDays: 14,
      logFilesDays: 14,
      tmpFilesDays: 7,
      captureFilesDays: 30,
      vacuum: 'incremental',
      ...overrides.retention,
    },
    ...overrides,
  };
}

function writeFileWithMtime(filePath, contents, isoTime) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  const fileTime = new Date(isoTime);
  fs.utimesSync(filePath, fileTime, fileTime);
}

function insertEvent(db, id, ts) {
  db.prepare(`
    INSERT INTO audit_events (
      row_hash, ts, agent_id, trace_id, span_id, parent_span_id, event,
      tool_name, status, result_summary, duration_ms, channel, user_id,
      entity_type, entity_id, llm_intent_json, error_message, tags, raw_json
    ) VALUES (
      @row_hash, @ts, 'agent', 'trace', @span_id, NULL, 'tool.end',
      'tool.name', 'OK', NULL, 1, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, '{}'
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

function insertRun(db, runId, { status, createdAt, updatedAt = createdAt }) {
  db.prepare(`
    INSERT INTO agent_runs (
      run_id, channel, conversation_id, user_open_id, status,
      request_text, delivery_mode, current_step_index, created_at, updated_at
    ) VALUES (
      @run_id, 'test', 'conv-1', 'user-1', @status,
      'request', 'callback', 0, @created_at, @updated_at
    )
  `).run({
    run_id: runId,
    status,
    created_at: createdAt,
    updated_at: updatedAt,
  });
}

function insertRunStep(db, { runId, stepIndex, startedAt, finishedAt = startedAt }) {
  db.prepare(`
    INSERT INTO agent_run_steps (
      run_id, step_index, step_name, status, tool_name,
      input_json, output_json, started_at, finished_at
    ) VALUES (
      @run_id, @step_index, 'step', 'completed', 'tool.name',
      NULL, NULL, @started_at, @finished_at
    )
  `).run({
    run_id: runId,
    step_index: stepIndex,
    started_at: startedAt,
    finished_at: finishedAt,
  });
}

function insertWaitingState(db, decisionId, {
  runId,
  status,
  createdAt,
  resolvedAt = null,
}) {
  db.prepare(`
    INSERT INTO agent_waiting_states (
      decision_id, run_id, schema_json, context_json,
      requested_by_step, status, created_at, resolved_at
    ) VALUES (
      @decision_id, @run_id, '{}', '{}',
      0, @status, @created_at, @resolved_at
    )
  `).run({
    decision_id: decisionId,
    run_id: runId,
    status,
    created_at: createdAt,
    resolved_at: resolvedAt,
  });
}

function insertLlmUsage(db, day, { calls = 1, estTokens = 100, updatedAt = `${day}T12:00:00.000Z` } = {}) {
  db.prepare(`
    INSERT INTO audit_llm_usage (day, calls, est_tokens, updated_at)
    VALUES (@day, @calls, @est_tokens, @updated_at)
  `).run({
    day,
    calls,
    est_tokens: estTokens,
    updated_at: updatedAt,
  });
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
    agentRuns: 0,
    agentRunSteps: 0,
    agentWaitingStates: 0,
    reviewRuns: 1,
    resolvedFindings: 1,
    auditLlmUsage: 0,
    outboxEvents: 2,
    ingestCursors: 0,
    spoolFiles: 0,
    logFiles: 0,
    tmpFiles: 0,
    captureFiles: 0,
  });
  assert.equal(count(db, 'audit_events'), 2);
  assert.equal(count(db, 'audit_review_runs'), 2);
  assert.equal(count(db, 'audit_review_findings'), 3);
  assert.equal(count(db, 'agent_outbox_events'), 3);

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention deletes expired runtime rows and llm usage while keeping active waiting state', () => {
  const rootDir = tmpDir();
  const db = makeDb();
  const service = createRetentionService({
    db,
    config: makeConfig(rootDir, {
      retention: {
        runtimeRunsDays: 30,
        waitingStatesDays: 30,
        llmUsageDays: 60,
      },
    }),
    cursorStore: createIngestCursorStore(db),
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  insertRun(db, 'run-old-completed', {
    status: 'completed',
    createdAt: '2026-05-01T00:00:00.000Z',
  });
  insertRun(db, 'run-old-failed', {
    status: 'failed',
    createdAt: '2026-05-01T00:00:00.000Z',
  });
  insertRun(db, 'run-waiting-user', {
    status: 'waiting_user',
    createdAt: '2026-05-01T00:00:00.000Z',
  });
  insertRun(db, 'run-fresh-completed', {
    status: 'completed',
    createdAt: '2026-07-01T00:00:00.000Z',
  });

  insertRunStep(db, {
    runId: 'run-old-completed',
    stepIndex: 0,
    startedAt: '2026-05-01T00:00:00.000Z',
  });
  insertRunStep(db, {
    runId: 'run-old-failed',
    stepIndex: 0,
    startedAt: '2026-05-01T00:00:00.000Z',
  });
  insertRunStep(db, {
    runId: 'run-waiting-user',
    stepIndex: 0,
    startedAt: '2026-05-01T00:00:00.000Z',
  });
  insertRunStep(db, {
    runId: 'run-fresh-completed',
    stepIndex: 0,
    startedAt: '2026-07-01T00:00:00.000Z',
  });

  insertWaitingState(db, 'wait-resolved-old', {
    runId: 'run-old-completed',
    status: 'resolved',
    createdAt: '2026-05-01T00:00:00.000Z',
    resolvedAt: '2026-05-02T00:00:00.000Z',
  });
  insertWaitingState(db, 'wait-pending-terminal', {
    runId: 'run-old-failed',
    status: 'pending',
    createdAt: '2026-05-01T00:00:00.000Z',
  });
  insertWaitingState(db, 'wait-pending-active', {
    runId: 'run-waiting-user',
    status: 'pending',
    createdAt: '2026-05-01T00:00:00.000Z',
  });

  insertLlmUsage(db, '2026-04-01', { calls: 2, estTokens: 500 });
  insertLlmUsage(db, '2026-06-15', { calls: 1, estTokens: 120 });

  const result = service.run({ batchSize: 1 });

  assert.equal(result.deleted.agentRuns, 2);
  assert.equal(result.deleted.agentRunSteps, 2);
  assert.equal(result.deleted.agentWaitingStates, 2);
  assert.equal(result.deleted.auditLlmUsage, 1);
  assert.ok(result.batches.agentRuns.every((n) => n <= 1), 'agent_runs delete batches should respect batchSize');
  assert.ok(result.batches.agentWaitingStates.every((n) => n <= 1), 'agent_waiting_states delete batches should respect batchSize');
  assert.deepEqual(
    db.prepare(`SELECT run_id FROM agent_runs ORDER BY run_id`).all().map((row) => row.run_id),
    ['run-fresh-completed', 'run-waiting-user'],
  );
  assert.deepEqual(
    db.prepare(`SELECT run_id FROM agent_run_steps ORDER BY run_id`).all().map((row) => row.run_id),
    ['run-fresh-completed', 'run-waiting-user'],
  );
  assert.deepEqual(
    db.prepare(`SELECT decision_id FROM agent_waiting_states ORDER BY decision_id`).all().map((row) => row.decision_id),
    ['wait-pending-active'],
  );
  assert.deepEqual(
    db.prepare(`SELECT day FROM audit_llm_usage ORDER BY day`).all().map((row) => row.day),
    ['2026-06-15'],
  );

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
  const spoolAgentDir = path.join(rootDir, 'data', 'spool', 'incoming', 'agent-a');
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

test('retention dry-run counts expired app-owned files without deleting them', () => {
  const rootDir = tmpDir();
  const oldTime = '2026-06-01T00:00:00.000Z';

  const oldLog = path.join(rootDir, 'logs', 'server', 'old.log');
  const oldTmp = path.join(rootDir, 'data', 'tmp', 'jobs', 'old.tmp');
  const oldCapture = path.join(rootDir, 'data', 'captures', 'screens', 'old.png');
  writeFileWithMtime(oldLog, 'old log', oldTime);
  writeFileWithMtime(oldTmp, 'old tmp', oldTime);
  writeFileWithMtime(oldCapture, 'old capture', oldTime);

  const db = makeDb();
  const service = createRetentionService({
    db,
    config: makeConfig(rootDir, {
      retention: {
        logFilesDays: 14,
        tmpFilesDays: 7,
        captureFilesDays: 30,
      },
    }),
    cursorStore: createIngestCursorStore(db),
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  const result = service.run({ dryRun: true });

  assert.equal(result.deleted.logFiles, 1);
  assert.equal(result.deleted.tmpFiles, 1);
  assert.equal(result.deleted.captureFiles, 1);
  assert.equal(fs.existsSync(oldLog), true);
  assert.equal(fs.existsSync(oldTmp), true);
  assert.equal(fs.existsSync(oldCapture), true);

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention removes expired app-owned files and ignores non-app workspace directories', () => {
  const rootDir = tmpDir();
  const oldTime = '2026-06-01T00:00:00.000Z';
  const freshTime = '2026-07-05T00:00:00.000Z';

  const oldLog = path.join(rootDir, 'logs', 'server', 'old.log');
  const freshLog = path.join(rootDir, 'logs', 'server', 'fresh.log');
  const oldTmp = path.join(rootDir, 'data', 'tmp', 'jobs', 'old.tmp');
  const freshTmp = path.join(rootDir, 'data', 'tmp', 'jobs', 'fresh.tmp');
  const oldCapture = path.join(rootDir, 'data', 'captures', 'screens', 'old.png');
  const freshCapture = path.join(rootDir, 'data', 'captures', 'screens', 'fresh.png');
  const oldAgentsLog = path.join(rootDir, '.agents', 'old.log');
  const oldClaudeLog = path.join(rootDir, '.claude', 'old.log');
  const oldSuperpowersLog = path.join(rootDir, '.superpowers', 'old.log');
  const recordFile = path.join(rootDir, 'record.json');
  const typoraLog = path.join(rootDir, 'Typora_Hook_Log.txt');

  writeFileWithMtime(oldLog, 'old log', oldTime);
  writeFileWithMtime(freshLog, 'fresh log', freshTime);
  writeFileWithMtime(oldTmp, 'old tmp', oldTime);
  writeFileWithMtime(freshTmp, 'fresh tmp', freshTime);
  writeFileWithMtime(oldCapture, 'old capture', oldTime);
  writeFileWithMtime(freshCapture, 'fresh capture', freshTime);
  writeFileWithMtime(oldAgentsLog, 'keep agents', oldTime);
  writeFileWithMtime(oldClaudeLog, 'keep claude', oldTime);
  writeFileWithMtime(oldSuperpowersLog, 'keep superpowers', oldTime);
  writeFileWithMtime(recordFile, '{"keep":true}', oldTime);
  writeFileWithMtime(typoraLog, 'keep typora', oldTime);

  const db = makeDb();
  const service = createRetentionService({
    db,
    config: makeConfig(rootDir, {
      retention: {
        logFilesDays: 14,
        tmpFilesDays: 7,
        captureFilesDays: 30,
      },
    }),
    cursorStore: createIngestCursorStore(db),
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  const result = service.run();

  assert.equal(result.deleted.logFiles, 1);
  assert.equal(result.deleted.tmpFiles, 1);
  assert.equal(result.deleted.captureFiles, 1);
  assert.equal(fs.existsSync(oldLog), false);
  assert.equal(fs.existsSync(freshLog), true);
  assert.equal(fs.existsSync(oldTmp), false);
  assert.equal(fs.existsSync(freshTmp), true);
  assert.equal(fs.existsSync(oldCapture), false);
  assert.equal(fs.existsSync(freshCapture), true);
  assert.equal(fs.existsSync(oldAgentsLog), true);
  assert.equal(fs.existsSync(oldClaudeLog), true);
  assert.equal(fs.existsSync(oldSuperpowersLog), true);
  assert.equal(fs.existsSync(recordFile), true);
  assert.equal(fs.existsSync(typoraLog), true);

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention uses configured app-owned directories instead of hard-coded defaults', () => {
  const rootDir = tmpDir();
  const oldTime = '2026-06-01T00:00:00.000Z';

  const configuredLog = path.join(rootDir, 'runtime', 'logs', 'old.log');
  const configuredTmp = path.join(rootDir, 'runtime', 'tmp', 'old.tmp');
  const configuredCapture = path.join(rootDir, 'runtime', 'captures', 'old.png');
  const defaultLog = path.join(rootDir, 'logs', 'keep.log');
  const defaultTmp = path.join(rootDir, 'data', 'tmp', 'keep.tmp');
  const defaultCapture = path.join(rootDir, 'data', 'captures', 'keep.png');

  writeFileWithMtime(configuredLog, 'configured log', oldTime);
  writeFileWithMtime(configuredTmp, 'configured tmp', oldTime);
  writeFileWithMtime(configuredCapture, 'configured capture', oldTime);
  writeFileWithMtime(defaultLog, 'default log', oldTime);
  writeFileWithMtime(defaultTmp, 'default tmp', oldTime);
  writeFileWithMtime(defaultCapture, 'default capture', oldTime);

  const db = makeDb();
  const service = createRetentionService({
    db,
    config: makeConfig(rootDir, {
      logDir: 'runtime/logs',
      tmpDir: 'runtime/tmp',
      capturesDir: 'runtime/captures',
      retention: {
        logFilesDays: 14,
        tmpFilesDays: 7,
        captureFilesDays: 30,
      },
    }),
    cursorStore: createIngestCursorStore(db),
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  const result = service.run();

  assert.equal(result.deleted.logFiles, 1);
  assert.equal(result.deleted.tmpFiles, 1);
  assert.equal(result.deleted.captureFiles, 1);
  assert.equal(fs.existsSync(configuredLog), false);
  assert.equal(fs.existsSync(configuredTmp), false);
  assert.equal(fs.existsSync(configuredCapture), false);
  assert.equal(fs.existsSync(defaultLog), true);
  assert.equal(fs.existsSync(defaultTmp), true);
  assert.equal(fs.existsSync(defaultCapture), true);

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention keeps expired newline-complete spool files without completed cursor proof', () => {
  const rootDir = tmpDir();
  const spoolAgentDir = path.join(rootDir, 'data', 'spool', 'incoming', 'agent-a');
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
  const spoolAgentDir = path.join(rootDir, 'data', 'spool', 'incoming', 'agent-a');
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

test('retention removes cursors for external log files not present in spool', () => {
  const rootDir = tmpDir();
  const spoolAgentDir = path.join(rootDir, 'data', 'spool', 'incoming', 'agent-a');
  const externalDir = path.join(rootDir, 'external-logs');
  fs.mkdirSync(spoolAgentDir, { recursive: true });
  fs.mkdirSync(externalDir, { recursive: true });

  const spoolFile = path.join(spoolAgentDir, 'audit-2026-07-01.jsonl');
  const externalFile = path.join(externalDir, 'audit-2026-07-01.jsonl');
  fs.writeFileSync(spoolFile, '{"ok":true}\n');
  fs.writeFileSync(externalFile, '{"external":true}\n');

  const db = makeDb();
  const cursorStore = createIngestCursorStore(db);
  cursorStore.upsert({
    agentId: 'agent-a',
    filePath: spoolFile,
    fileMtimeMs: fs.statSync(spoolFile).mtimeMs,
    fileSizeBytes: fs.statSync(spoolFile).size,
    offsetBytes: fs.statSync(spoolFile).size,
  });
  cursorStore.upsert({
    agentId: 'agent-a',
    filePath: externalFile,
    fileMtimeMs: fs.statSync(externalFile).mtimeMs,
    fileSizeBytes: fs.statSync(externalFile).size,
    offsetBytes: fs.statSync(externalFile).size,
  });

  const service = createRetentionService({
    db,
    config: makeConfig(rootDir),
    cursorStore,
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  const result = service.run();

  assert.equal(result.deleted.ingestCursors, 1);
  assert.deepEqual(
    db.prepare(`SELECT file_path FROM audit_ingest_cursors ORDER BY file_path`).all().map((row) => row.file_path),
    [spoolFile],
  );

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
  assert.match(result.stdout, /"agentRuns": 0/);
  assert.match(result.stdout, /"agentRunSteps": 0/);
  assert.match(result.stdout, /"agentWaitingStates": 0/);
  assert.match(result.stdout, /"auditLlmUsage": 0/);
  assert.match(result.stdout, /"logFiles": 0/);
  assert.match(result.stdout, /"tmpFiles": 0/);
  assert.match(result.stdout, /"captureFiles": 0/);

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
