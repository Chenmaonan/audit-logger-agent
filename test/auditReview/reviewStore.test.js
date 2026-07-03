import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createReviewStore, computeFindingHash } from '../../src/auditReview/reviewStore.js';
import { createLockStore } from '../../src/auditReview/lockStore.js';
import { createIngestCursorStore } from '../../src/auditReview/ingestCursorStore.js';

function openDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = OFF');
  ensureReviewSchema(db);
  return db;
}

const baseFinding = {
  category: 'failed_call',
  agent_id: 'mt-agent',
  tool_name: 'publicTraffic.runReport',
  trace_id: 'trace_abc',
  product_id: 'rental',
  error_code: 'upstream_timeout',
  title: 'publicTraffic.runReport 连续失败',
  summary: '10 分钟内同一工具失败 5 次',
  recommendation: '检查上游服务',
  risk_policy_version: 'risk-policy-v1',
  reviewer_version: 'audit-reviewer-v1',
};

function makeFinding(overrides = {}) {
  return { ...baseFinding, ...overrides };
}

test('reviewStore: createRun inserts a running row and finishRun sets terminal state', () => {
  const db = openDb();
  const store = createReviewStore(db);
  const reviewId = `rev_${crypto.randomUUID()}`;
  const run = store.createRun({
    reviewId,
    windowFrom: '2026-07-03T10:00:00.000Z',
    windowTo: '2026-07-03T10:30:00.000Z',
    triggerType: 'scheduled',
    intervalMinutes: 30,
    riskPolicyVersion: 'risk-policy-v1',
    promptVersion: 'audit-review-prompt-v1',
    reviewerVersion: 'audit-reviewer-v1',
  });
  assert.equal(run.status, 'running');
  assert.equal(run.risk_policy_version, 'risk-policy-v1');
  assert.equal(run.finished_at, null);
  assert.equal(run.started_at != null, true);

  const finished = store.finishRun(reviewId, {
    status: 'completed',
    scannedFiles: 3,
    insertedEvents: 42,
    parseErrorCount: 1,
    candidateEventCount: 10,
    findingCount: 2,
    llmModel: 'gpt-4o-mini',
  });
  assert.equal(finished.status, 'completed');
  assert.equal(finished.scanned_files, 3);
  assert.equal(finished.finding_count, 2);
  assert.equal(finished.finished_at != null, true);

  assert.equal(store.getRun(reviewId).status, 'completed');
  db.close();
});

test('reviewStore: listRuns returns newest first', async () => {
  const db = openDb();
  const store = createReviewStore(db);
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const id = `rev_list_${i}_${crypto.randomUUID()}`;
    ids.push(id);
    store.createRun({
      reviewId: id,
      windowFrom: '2026-07-03T10:00:00.000Z',
      windowTo: '2026-07-03T10:30:00.000Z',
      triggerType: 'scheduled',
      intervalMinutes: 30,
      riskPolicyVersion: 'risk-policy-v1',
      reviewerVersion: 'audit-reviewer-v1',
    });
    // Sleep so started_at differs and newest-first ordering is deterministic.
    await new Promise((r) => setTimeout(r, 5));
  }
  const all = store.listRuns({ limit: 10 });
  assert.equal(all.length, 3);
  // newest first: last created must be first
  assert.equal(all[0].review_id, ids[2]);
  db.close();
});

test('reviewStore: listStaleRunning returns running rows started before cutoff', () => {
  const db = openDb();
  const store = createReviewStore(db);
  const id = `rev_stale_${crypto.randomUUID()}`;
  store.createRun({
    reviewId: id,
    windowFrom: '2026-07-03T10:00:00.000Z',
    windowTo: '2026-07-03T10:30:00.000Z',
    triggerType: 'scheduled',
    intervalMinutes: 30,
    riskPolicyVersion: 'risk-policy-v1',
    reviewerVersion: 'audit-reviewer-v1',
  });
  const stale = store.listStaleRunning({ staleBeforeIso: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].review_id, id);
  db.close();
});

test('reviewStore: upsertFinding dedupes by finding_hash and escalates severity in place', () => {
  const db = openDb();
  const store = createReviewStore(db);
  const reviewId = `rev_fnd_${crypto.randomUUID()}`;

  // First insert: brand new finding
  const r1 = store.upsertFinding(makeFinding({ review_id: reviewId, severity: 'medium' }));
  assert.equal(r1.isNew, true);
  assert.equal(r1.severityEscalated, false);
  assert.equal(r1.finding.status, 'open');
  assert.equal(r1.finding.occurrence_count, 1);
  assert.equal(r1.finding.severity, 'medium');

  // Second insert: same hash, severity escalated to high -> updates in place
  const r2 = store.upsertFinding(makeFinding({ review_id: reviewId, severity: 'high' }));
  assert.equal(r2.isNew, false);
  assert.equal(r2.severityEscalated, true);
  assert.equal(r2.finding.occurrence_count, 2);
  assert.equal(r2.finding.severity, 'high');
  assert.equal(r2.finding.last_notified_at, null); // cleared for re-notify

  // Verify only one row exists in the table
  const allFindings = store.listFindings({ limit: 100 });
  assert.equal(allFindings.length, 1);

  // Third insert: severity downgrade -> not escalated, occurrence_count increments
  const r3 = store.upsertFinding(makeFinding({ review_id: reviewId, severity: 'medium' }));
  assert.equal(r3.isNew, false);
  assert.equal(r3.severityEscalated, false);
  assert.equal(r3.finding.occurrence_count, 3);
  assert.equal(r3.finding.severity, 'medium');

  db.close();
});

test('reviewStore: computeFindingHash is stable and ignores severity', () => {
  const h1 = computeFindingHash({
    category: 'failed_call', agentId: 'a', toolName: 't',
    traceId: 'tr', productId: 'p', normalizedErrorCode: 'err',
  });
  const h2 = computeFindingHash({
    category: 'failed_call', agentId: 'a', toolName: 't',
    traceId: 'tr', productId: 'p', normalizedErrorCode: 'err',
  });
  assert.equal(h1, h2);
  assert.equal(h1.length, 16);
});

test('reviewStore: updateFinding lifecycle (acknowledge/snooze/resolve)', () => {
  const db = openDb();
  const store = createReviewStore(db);
  const reviewId = `rev_lc_${crypto.randomUUID()}`;
  const { finding } = store.upsertFinding(makeFinding({ review_id: reviewId, severity: 'high' }));

  const acked = store.updateFinding(finding.finding_id, {
    status: 'acknowledged',
    acknowledged_at: '2026-07-03T11:00:00.000Z',
    acknowledged_by: 'ops',
  });
  assert.equal(acked.status, 'acknowledged');
  assert.equal(acked.acknowledged_by, 'ops');

  const resolved = store.updateFinding(finding.finding_id, {
    status: 'resolved',
    resolved_at: '2026-07-03T12:00:00.000Z',
  });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolved_at, '2026-07-03T12:00:00.000Z');
  db.close();
});

test('reviewStore: listFindings filters by severity/category/agent', () => {
  const db = openDb();
  const store = createReviewStore(db);
  const reviewId = `rev_f_${crypto.randomUUID()}`;
  store.upsertFinding(makeFinding({ review_id: reviewId, severity: 'high', agent_id: 'agent-a', category: 'failed_call' }));
  store.upsertFinding({
    ...baseFinding,
    review_id: reviewId,
    severity: 'medium',
    agent_id: 'agent-b',
    tool_name: 'otherTool',
    trace_id: 'trace_other',
    category: 'repeated_call',
    title: 'repeated', summary: 's',
  });

  assert.equal(store.listFindings({ severity: 'high' }).length, 1);
  assert.equal(store.listFindings({ category: 'repeated_call' }).length, 1);
  assert.equal(store.listFindings({ agentId: 'agent-a' }).length, 1);
  assert.equal(store.listFindings({ toolName: 'otherTool' }).length, 1);
  assert.equal(store.listFindings({ status: 'open' }).length, 2);
  db.close();
});

test('reviewStore: listDeadLetterCount queries outbox dead letters', () => {
  const db = openDb();
  // Ensure outbox table exists via runtime schema so the query can run.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_outbox_events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT,
      type TEXT,
      payload_json TEXT,
      delivery_mode TEXT,
      delivery_status TEXT,
      delivery_attempts INTEGER,
      max_attempts INTEGER,
      next_attempt_at TEXT,
      callback_url TEXT,
      last_error TEXT,
      created_at TEXT,
      delivered_at TEXT
    );
  `);
  db.prepare(`INSERT INTO agent_outbox_events (event_id, delivery_status) VALUES (?, ?)`).run('e1', 'dead_letter');
  db.prepare(`INSERT INTO agent_outbox_events (event_id, delivery_status) VALUES (?, ?)`).run('e2', 'pending');

  const store = createReviewStore(db);
  assert.equal(store.listDeadLetterCount(), 1);
  db.close();
});

test('lockStore: acquire/refresh/release lifecycle', () => {
  const db = openDb();
  const lock = createLockStore(db);
  const owner = 'owner-1';

  const a1 = lock.acquire({ ownerId: owner, leaseMinutes: 10 });
  assert.equal(a1.acquired, true);
  assert.equal(a1.ownerId, owner);

  // Same owner can re-acquire (refresh)
  const a2 = lock.acquire({ ownerId: owner, leaseMinutes: 5 });
  assert.equal(a2.acquired, true);

  // Different owner cannot acquire while lease is fresh
  const a3 = lock.acquire({ ownerId: 'owner-2', leaseMinutes: 10 });
  assert.equal(a3.acquired, false);
  assert.equal(a3.currentOwner, owner);

  // Refresh extends lease
  const r = lock.refresh({ lockName: 'audit_review_scheduler', ownerId: owner, leaseMinutes: 30 });
  assert.equal(r.refreshed, 1);

  // Release only by owner
  const rel = lock.release({ lockName: 'audit_review_scheduler', ownerId: owner });
  assert.equal(rel.released, 1);
  assert.equal(lock.getLock('audit_review_scheduler'), null);
  db.close();
});

test('lockStore: expired lease can be preempted by a new owner', () => {
  const db = openDb();
  const lock = createLockStore(db);

  // Acquire with a 0-minute lease so it expires immediately
  const a1 = lock.acquire({ ownerId: 'owner-old', leaseMinutes: 0 });
  assert.equal(a1.acquired, true);

  // Wait a tick so now > lease_expires_at
  // leaseMinutes=0 -> expiresAt = now; "now" comparison uses <= so it should be expired
  const a2 = lock.acquire({ ownerId: 'owner-new', leaseMinutes: 10 });
  assert.equal(a2.acquired, true);
  assert.equal(a2.ownerId, 'owner-new');

  const current = lock.getLock('audit_review_scheduler');
  assert.equal(current.owner_id, 'owner-new');
  db.close();
});

test('lockStore: listExpired and forceRelease', () => {
  const db = openDb();
  const lock = createLockStore(db);
  lock.acquire({ lockName: 'exp_lock', ownerId: 'o1', leaseMinutes: 0 });

  const expired = lock.listExpired({ beforeIso: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(expired.length, 1);

  const fr = lock.forceRelease('exp_lock');
  assert.equal(fr.released, 1);
  assert.equal(lock.getLock('exp_lock'), null);
  db.close();
});

test('ingestCursorStore: get/upsert/remove', () => {
  const db = openDb();
  const cursors = createIngestCursorStore(db);

  assert.equal(cursors.get({ agentId: 'a', filePath: '/logs/x.jsonl' }), null);

  const row = cursors.upsert({
    agentId: 'a',
    filePath: '/logs/x.jsonl',
    fileMtimeMs: 1700000000000,
    fileSizeBytes: 4096,
    offsetBytes: 1024,
  });
  assert.equal(row.file_size_bytes, 4096);
  assert.equal(row.offset_bytes, 1024);
  assert.equal(row.last_error, null);

  const got = cursors.get({ agentId: 'a', filePath: '/logs/x.jsonl' });
  assert.equal(got.file_mtime_ms, 1700000000000);

  // upsert updates in place
  cursors.upsert({
    agentId: 'a',
    filePath: '/logs/x.jsonl',
    fileMtimeMs: 1700000000001,
    fileSizeBytes: 8192,
    offsetBytes: 2048,
    lastError: 'partial line',
  });
  const updated = cursors.get({ agentId: 'a', filePath: '/logs/x.jsonl' });
  assert.equal(updated.file_size_bytes, 8192);
  assert.equal(updated.last_error, 'partial line');

  const rm = cursors.remove({ agentId: 'a', filePath: '/logs/x.jsonl' });
  assert.equal(rm.removed, 1);
  assert.equal(cursors.get({ agentId: 'a', filePath: '/logs/x.jsonl' }), null);
  db.close();
});

test('ingestCursorStore: cleanupOrphans deletes cursors not in the keep set', () => {
  const db = openDb();
  const cursors = createIngestCursorStore(db);
  cursors.upsert({ agentId: 'a', filePath: '/logs/1.jsonl', fileMtimeMs: 1, fileSizeBytes: 10 });
  cursors.upsert({ agentId: 'a', filePath: '/logs/2.jsonl', fileMtimeMs: 1, fileSizeBytes: 10 });
  cursors.upsert({ agentId: 'b', filePath: '/logs/3.jsonl', fileMtimeMs: 1, fileSizeBytes: 10 });

  const keep = new Set(['a|/logs/1.jsonl', 'b|/logs/3.jsonl']);
  const res = cursors.cleanupOrphans({ existingFilePathsByAgent: keep });
  assert.equal(res.removed, 1);
  assert.equal(cursors.get({ agentId: 'a', filePath: '/logs/2.jsonl' }), null);
  assert.equal(cursors.get({ agentId: 'a', filePath: '/logs/1.jsonl' }).file_path, '/logs/1.jsonl');
  db.close();
});