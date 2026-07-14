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

test('ensureReviewSchema migrates legacy finding and LLM usage tables', () => {
  const db = new Database(':memory:');
  db.pragma('journal_mode = OFF');
  db.exec(`
    CREATE TABLE audit_review_findings (
      finding_id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL,
      finding_hash TEXT NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      agent_id TEXT,
      tool_name TEXT,
      trace_id TEXT,
      entity_type TEXT,
      entity_id TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      recommendation TEXT,
      requires_action INTEGER NOT NULL DEFAULT 0,
      evidence_event_ids_json TEXT NOT NULL,
      evidence_json TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_notified_at TEXT,
      resolved_at TEXT,
      snoozed_until TEXT,
      acknowledged_at TEXT,
      acknowledged_by TEXT,
      risk_policy_version TEXT NOT NULL,
      prompt_version TEXT,
      reviewer_version TEXT NOT NULL
    );
  `);

  ensureReviewSchema(db);
  const findingColumns = db.prepare(`PRAGMA table_info(audit_review_findings)`).all().map((row) => row.name);
  assert.ok(findingColumns.includes('llm_analysis_json'));
  assert.ok(findingColumns.includes('analysis_generated_at'));
  const usageColumns = db.prepare(`PRAGMA table_info(audit_llm_usage)`).all().map((row) => row.name);
  assert.deepEqual(usageColumns, ['day', 'calls', 'est_tokens', 'updated_at']);
  db.close();
});

const baseFinding = {
  category: 'failed_call',
  agent_id: 'mt-agent',
  tool_name: 'publicTraffic.runReport',
  trace_id: 'trace_abc',
  entity: { type: 'product', id: 'rental' },
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

test('reviewStore: persists and clears cached finding LLM analysis when finding is seen again', async () => {
  const db = openDb();
  const store = createReviewStore(db);
  const reviewId = `rev_analysis_${crypto.randomUUID()}`;
  const { finding } = store.upsertFinding(makeFinding({ review_id: reviewId, severity: 'medium' }));

  const cachedAt = '2026-07-03T10:05:00.000Z';
  store.saveFindingAnalysis(finding.finding_id, {
    analysis: {
      purpose: 'explain purpose',
      chain_summary: 'explain chain',
      risk_points: ['risk'],
      next_actions: ['act'],
    },
    generatedAt: cachedAt,
  });

  const cached = store.getFinding(finding.finding_id);
  assert.deepEqual(cached.llm_analysis, {
    purpose: 'explain purpose',
    chain_summary: 'explain chain',
    risk_points: ['risk'],
    next_actions: ['act'],
  });
  assert.equal(cached.analysis_generated_at, cachedAt);

  await new Promise((r) => setTimeout(r, 5));
  const updated = store.upsertFinding(makeFinding({ review_id: reviewId, severity: 'high' })).finding;
  assert.equal(updated.llm_analysis, null);
  assert.equal(updated.analysis_generated_at, null);

  db.close();
});

test('reviewStore: tracks daily LLM usage counters', () => {
  const db = openDb();
  const store = createReviewStore(db);

  assert.deepEqual(store.getLlmUsage('2026-07-03'), { day: '2026-07-03', calls: 0, est_tokens: 0 });
  store.recordLlmUsage({ day: '2026-07-03', calls: 1, estTokens: 120 });
  store.recordLlmUsage({ day: '2026-07-03', calls: 2, estTokens: 30 });

  assert.deepEqual(store.getLlmUsage('2026-07-03'), { day: '2026-07-03', calls: 3, est_tokens: 150 });
  assert.deepEqual(store.getLlmUsage('2026-07-04'), { day: '2026-07-04', calls: 0, est_tokens: 0 });
  db.close();
});

test('reviewStore: atomically reserves LLM usage within daily limits', () => {
  const db = openDb();
  const store = createReviewStore(db);

  const first = store.reserveLlmUsage({
    day: '2026-07-03',
    calls: 1,
    estTokens: 120,
    maxCallsPerDay: 1,
    maxTokensPerDay: 200,
  });
  const second = store.reserveLlmUsage({
    day: '2026-07-03',
    calls: 1,
    estTokens: 20,
    maxCallsPerDay: 1,
    maxTokensPerDay: 200,
  });
  const tokenLimited = store.reserveLlmUsage({
    day: '2026-07-04',
    calls: 1,
    estTokens: 220,
    maxCallsPerDay: 2,
    maxTokensPerDay: 200,
  });

  assert.equal(first.reserved, true);
  assert.deepEqual(
    { day: first.day, calls: first.calls, est_tokens: first.est_tokens },
    { day: '2026-07-03', calls: 1, est_tokens: 120 },
  );
  assert.equal(second.reserved, false);
  assert.deepEqual(
    { day: second.day, calls: second.calls, est_tokens: second.est_tokens },
    { day: '2026-07-03', calls: 1, est_tokens: 120 },
  );
  assert.equal(tokenLimited.reserved, false);
  assert.deepEqual(store.getLlmUsage('2026-07-04'), { day: '2026-07-04', calls: 0, est_tokens: 0 });
  db.close();
});

test('reviewStore: computeFindingHash is stable and ignores severity', () => {
  const h1 = computeFindingHash({
    category: 'failed_call', agentId: 'a', toolName: 't',
    traceId: 'tr', entityType: 'product', entityId: 'p', normalizedErrorCode: 'err',
  });
  const h2 = computeFindingHash({
    category: 'failed_call', agentId: 'a', toolName: 't',
    traceId: 'tr', entityType: 'product', entityId: 'p', normalizedErrorCode: 'err',
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

test('reviewStore: listAgents summarizes received audit events by agent', () => {
  const db = openDb();
  db.exec(`
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      agent_id TEXT NOT NULL
    );
  `);
  const insert = db.prepare(`INSERT INTO audit_events (ts, agent_id) VALUES (?, ?)`);
  insert.run('2026-07-03T10:00:00.000Z', 'agent-a');
  insert.run('2026-07-03T10:05:00.000Z', 'agent-b');
  insert.run('2026-07-03T10:10:00.000Z', 'agent-a');

  const store = createReviewStore(db);
  const reviewId = `rev_agents_${crypto.randomUUID()}`;
  store.upsertFinding(makeFinding({ review_id: reviewId, severity: 'high', agent_id: 'agent-a' }));
  const { finding } = store.upsertFinding({
    ...baseFinding,
    review_id: reviewId,
    severity: 'medium',
    agent_id: 'agent-b',
    tool_name: 'otherTool',
    trace_id: 'trace_agent_b',
    category: 'repeated_call',
    title: 'agent-b repeated',
    summary: 's',
  });
  store.updateFinding(finding.finding_id, {
    status: 'resolved',
    resolved_at: '2026-07-03T10:20:00.000Z',
  });

  const agents = store.listAgents({ limit: 10 });
  assert.deepEqual(agents.map((agent) => agent.agent_id), ['agent-a', 'agent-b']);
  assert.equal(agents[0].event_count, 2);
  assert.equal(agents[0].last_event_at, '2026-07-03T10:10:00.000Z');
  assert.equal(agents[0].finding_count, 1);
  assert.equal(agents[0].open_finding_count, 1);
  assert.equal(agents[1].event_count, 1);
  assert.equal(agents[1].finding_count, 1);
  assert.equal(agents[1].open_finding_count, 0);
  db.close();
});

test('reviewStore: listAgents returns empty when audit_events table is unavailable', () => {
  const db = openDb();
  const store = createReviewStore(db);
  assert.deepEqual(store.listAgents({ limit: 10 }), []);
  db.close();
});

test('reviewStore: listTraceEvents returns audit events for a trace in chronological order', () => {
  const db = openDb();
  db.exec(`
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      parent_span_id TEXT,
      ts TEXT NOT NULL,
      event TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      result_summary TEXT,
      duration_ms INTEGER,
      error_message TEXT
    );
  `);
  const insert = db.prepare(`
    INSERT INTO audit_events
      (trace_id, span_id, parent_span_id, ts, event, tool_name, status, result_summary, duration_ms, error_message)
    VALUES
      (@trace_id, @span_id, @parent_span_id, @ts, @event, @tool_name, @status, @result_summary, @duration_ms, @error_message)
  `);
  insert.run({
    trace_id: 'trace_keep',
    span_id: 'span_2',
    parent_span_id: 'span_1',
    ts: '2026-07-03T10:02:00.000Z',
    event: 'tool.end',
    tool_name: 'db.delete',
    status: 'INTERNAL',
    result_summary: 'delete failed',
    duration_ms: 420,
    error_message: 'permission denied',
  });
  insert.run({
    trace_id: 'trace_other',
    span_id: 'span_other',
    parent_span_id: null,
    ts: '2026-07-03T10:00:30.000Z',
    event: 'tool.end',
    tool_name: 'search',
    status: 'OK',
    result_summary: 'ignored',
    duration_ms: 25,
    error_message: null,
  });
  insert.run({
    trace_id: 'trace_keep',
    span_id: 'span_1',
    parent_span_id: null,
    ts: '2026-07-03T10:01:00.000Z',
    event: 'tool.start',
    tool_name: 'db.delete',
    status: 'OK',
    result_summary: 'delete requested',
    duration_ms: null,
    error_message: null,
  });

  const store = createReviewStore(db);
  const rows = store.listTraceEvents({ traceId: 'trace_keep', limit: 10 });

  assert.deepEqual(rows.map((row) => row.span_id), ['span_1', 'span_2']);
  assert.deepEqual(rows.map((row) => row.tool_name), ['db.delete', 'db.delete']);
  assert.equal(rows[1].parent_span_id, 'span_1');
  assert.equal(rows[1].error_message, 'permission denied');
  assert.equal(store.listTraceEvents({ traceId: 'trace_keep', limit: 1 }).length, 1);
  assert.deepEqual(store.listTraceEvents({ traceId: '' }), []);
  db.close();
});

test('reviewStore: listRawEventsByIds returns raw_json snippets in evidence order', () => {
  const db = openDb();
  db.exec(`
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_json TEXT
    );
  `);
  const insert = db.prepare(`INSERT INTO audit_events (id, raw_json) VALUES (?, ?)`);
  insert.run(7, '{"event":"tool.error","message":"keep this exact string"}');
  insert.run(3, '{"event":"tool.start","payload":{"b":2,"a":1}}');
  insert.run(9, '{"event":"tool.end"}');

  const store = createReviewStore(db);
  const rows = store.listRawEventsByIds({ eventIds: [3, 7], limit: 10 });

  assert.deepEqual(rows.map((row) => row.id), [3, 7]);
  assert.deepEqual(rows.map((row) => row.raw_json), [
    '{"event":"tool.start","payload":{"b":2,"a":1}}',
    '{"event":"tool.error","message":"keep this exact string"}',
  ]);
  assert.deepEqual(store.listRawEventsByIds({ eventIds: [7, 3], limit: 1 }).map((row) => row.id), [7]);
  assert.deepEqual(store.listRawEventsByIds({ eventIds: [] }), []);
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
