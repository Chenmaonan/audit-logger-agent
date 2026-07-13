import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createLogBatchStore } from '../../src/auditReview/logBatchStore.js';

function openDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = OFF');
  db.exec(`
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      row_hash TEXT UNIQUE NOT NULL,
      ts TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      event TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      raw_json TEXT
    );
  `);
  ensureReviewSchema(db);
  return db;
}

test('ensureReviewSchema migrates audit_events with nullable batch_id', () => {
  const db = new Database(':memory:');
  db.pragma('journal_mode = OFF');
  db.exec(`
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      row_hash TEXT UNIQUE NOT NULL,
      ts TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      event TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      raw_json TEXT
    );
  `);

  ensureReviewSchema(db);
  const columns = db.prepare('PRAGMA table_info(audit_events)').all().map((row) => row.name);
  assert.ok(columns.includes('batch_id'));
  db.close();
});

test('logBatchStore reuses open batch and creates a new open batch when locking for review', () => {
  const db = openDb();
  const store = createLogBatchStore(db);

  const first = store.getOrCreateOpenBatch('agent-a', { now: '2026-07-10T10:00:00.000Z' });
  assert.equal(first.agent_id, 'agent-a');
  assert.equal(first.status, 'open');
  assert.equal(store.getOrCreateOpenBatch('agent-a', { now: '2026-07-10T10:05:00.000Z' }).batch_id, first.batch_id);

  const locked = store.lockOpenBatchForReview({
    agentId: 'agent-a',
    reviewId: 'review-1',
    now: '2026-07-10T10:10:00.000Z',
  });
  assert.equal(locked.lockedBatch.batch_id, first.batch_id);
  assert.equal(locked.lockedBatch.status, 'locked');
  assert.equal(locked.lockedBatch.review_id, 'review-1');
  assert.equal(locked.openBatch.status, 'open');
  assert.notEqual(locked.openBatch.batch_id, first.batch_id);

  assert.deepEqual(
    store.listBatches({ agentId: 'agent-a' }).map((row) => row.status),
    ['open', 'locked'],
  );
  db.close();
});

test('logBatchStore marks reviewed and raw deleted batches', () => {
  const db = openDb();
  const store = createLogBatchStore(db);
  const batch = store.getOrCreateOpenBatch('agent-a', { now: '2026-07-10T10:00:00.000Z' });

  const reviewed = store.markReviewed({
    batchId: batch.batch_id,
    reviewId: 'review-2',
    snapshotId: 'snapshot-2',
    now: '2026-07-10T10:30:00.000Z',
  });
  assert.equal(reviewed.status, 'reviewed');
  assert.equal(reviewed.review_id, 'review-2');
  assert.equal(reviewed.snapshot_id, 'snapshot-2');

  const deleted = store.markRawDeleted({ batchId: batch.batch_id, now: '2026-07-10T11:00:00.000Z' });
  assert.equal(deleted.status, 'raw_deleted');
  assert.equal(deleted.raw_deleted_at, '2026-07-10T11:00:00.000Z');
  assert.deepEqual(
    store.listBatches({ agentId: 'agent-a', status: 'raw_deleted' }).map((row) => row.batch_id),
    [batch.batch_id],
  );
  db.close();
});

test('logBatchStore deletes reviewed raw rows only for snapshotted batches in the same agent', () => {
  const db = openDb();
  const store = createLogBatchStore(db);

  const reviewed = store.getOrCreateOpenBatch('agent-a', { now: '2026-07-10T09:00:00.000Z' });
  const noSnapshot = store.getOrCreateOpenBatch('agent-b', { now: '2026-07-10T09:05:00.000Z' });
  const otherAgent = store.getOrCreateOpenBatch('agent-c', { now: '2026-07-10T09:10:00.000Z' });

  store.markReviewed({ batchId: reviewed.batch_id, reviewId: 'review-old', snapshotId: 'snapshot-old' });
  store.markReviewed({ batchId: noSnapshot.batch_id, reviewId: 'review-no-snapshot', snapshotId: null });
  store.markReviewed({ batchId: otherAgent.batch_id, reviewId: 'review-other', snapshotId: 'snapshot-other' });
  const current = store.getOrCreateOpenBatch('agent-a', { now: '2026-07-10T10:00:00.000Z' });

  const insert = db.prepare(`
    INSERT INTO audit_events (
      row_hash, ts, agent_id, trace_id, span_id, event, tool_name, status, raw_json, batch_id
    ) VALUES (
      @row_hash, @ts, @agent_id, @trace_id, @span_id, 'tool.end', 'tool', 'OK', '{}', @batch_id
    )
  `);
  insert.run({
    row_hash: 'old-a-1',
    ts: '2026-07-10T09:01:00.000Z',
    agent_id: 'agent-a',
    trace_id: 'old-a-1',
    span_id: 'old-a-1',
    batch_id: reviewed.batch_id,
  });
  insert.run({
    row_hash: 'old-a-2',
    ts: '2026-07-10T09:02:00.000Z',
    agent_id: 'agent-a',
    trace_id: 'old-a-2',
    span_id: 'old-a-2',
    batch_id: reviewed.batch_id,
  });
  insert.run({
    row_hash: 'current-a',
    ts: '2026-07-10T10:01:00.000Z',
    agent_id: 'agent-a',
    trace_id: 'current-a',
    span_id: 'current-a',
    batch_id: current.batch_id,
  });
  insert.run({
    row_hash: 'no-snapshot',
    ts: '2026-07-10T09:06:00.000Z',
    agent_id: 'agent-b',
    trace_id: 'no-snapshot',
    span_id: 'no-snapshot',
    batch_id: noSnapshot.batch_id,
  });
  insert.run({
    row_hash: 'other-agent',
    ts: '2026-07-10T09:11:00.000Z',
    agent_id: 'agent-c',
    trace_id: 'other-agent',
    span_id: 'other-agent',
    batch_id: otherAgent.batch_id,
  });

  const result = store.deleteReviewedRawLogsForAgent({
    agentId: 'agent-a',
    excludeBatchId: current.batch_id,
    now: '2026-07-10T10:30:00.000Z',
  });

  assert.equal(result.skipped, false);
  assert.deepEqual(result.batchIds, [reviewed.batch_id]);
  assert.equal(result.deletedRows, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE batch_id = ?').get(reviewed.batch_id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE batch_id = ?').get(current.batch_id).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE batch_id = ?').get(noSnapshot.batch_id).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE batch_id = ?').get(otherAgent.batch_id).count, 1);

  const deletedBatch = db.prepare('SELECT status, raw_deleted_at FROM audit_log_batches WHERE batch_id = ?').get(reviewed.batch_id);
  assert.equal(deletedBatch.status, 'raw_deleted');
  assert.equal(deletedBatch.raw_deleted_at, '2026-07-10T10:30:00.000Z');
  assert.equal(db.prepare('SELECT raw_deleted_at FROM audit_log_batches WHERE batch_id = ?').get(noSnapshot.batch_id).raw_deleted_at, null);

  db.close();
});

test('logBatchStore skips raw deletion when audit_events table or batch_id column is unavailable', () => {
  const dbWithoutEvents = new Database(':memory:');
  dbWithoutEvents.pragma('journal_mode = OFF');
  ensureReviewSchema(dbWithoutEvents);
  const storeWithoutEvents = createLogBatchStore(dbWithoutEvents);
  const missingTable = storeWithoutEvents.deleteReviewedRawLogsForAgent({ agentId: 'agent-a' });
  assert.equal(missingTable.skipped, true);
  assert.equal(missingTable.reason, 'missing_audit_events_table');
  dbWithoutEvents.close();

  const dbWithoutBatchId = new Database(':memory:');
  dbWithoutBatchId.pragma('journal_mode = OFF');
  dbWithoutBatchId.exec(`
    CREATE TABLE audit_log_batches (
      batch_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      locked_at TEXT,
      review_id TEXT,
      snapshot_id TEXT,
      raw_deleted_at TEXT
    );
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      row_hash TEXT UNIQUE NOT NULL,
      ts TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      event TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      raw_json TEXT
    );
  `);
  const storeWithoutBatchId = createLogBatchStore(dbWithoutBatchId);
  const missingColumn = storeWithoutBatchId.deleteReviewedRawLogsForAgent({ agentId: 'agent-a' });
  assert.equal(missingColumn.skipped, true);
  assert.equal(missingColumn.reason, 'missing_audit_events_batch_id');
  dbWithoutBatchId.close();
});
