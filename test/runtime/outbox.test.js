import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { openDb } from '../../scripts/lib/db.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { createOutboxStore } from '../../src/agent/outboxStore.js';
import { createCallbackClient } from '../../src/adapters/delivery/callbackClient.js';
import { createEventPublisher } from '../../src/agent/eventPublisher.js';

test('outbox event is delivered to callback url and marked delivered', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-outbox-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const outboxStore = createOutboxStore(db);

  let receivedBody = null;
  const sink = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
  const { port } = sink.address();
  const callbackUrl = `http://127.0.0.1:${port}/agent-events`;

  const callbackClient = createCallbackClient({ fetchImpl: fetch });
  const publisher = createEventPublisher({ outboxStore, callbackClient });

  publisher.enqueueRunEvent(
    { run_id: 'run_test', delivery_mode: 'callback', delivery_callback_url: callbackUrl },
    'progress_update',
    { type: 'progress_update', run_id: 'run_test', title: '处理中', summary: '已完成 1/3' },
  );

  const pendingBefore = outboxStore.listPending(10);
  assert.equal(pendingBefore.length, 1);

  await publisher.flushPending(10);

  const pendingAfter = outboxStore.listPending(10);
  assert.equal(pendingAfter.length, 0);
  assert.equal(receivedBody.type, 'progress_update');
  assert.equal(receivedBody.run_id, 'run_test');

  sink.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('callback delivery times out instead of blocking the outbox lease indefinitely', async () => {
  const callbackClient = createCallbackClient({
    timeoutMs: 10,
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });

  await assert.rejects(
    () => callbackClient.send('https://callback.invalid/events', { ok: true }),
    /timed out/,
  );
});

test('outbox optional dedupe key is idempotent while legacy enqueue remains compatible', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-outbox-dedupe-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const outboxStore = createOutboxStore(db);
  const common = {
    runId: 'run_dedupe',
    type: 'audit_review_finding',
    payload: { title: 'high risk' },
    deliveryMode: 'feishu_bot',
    callbackUrl: null,
  };

  const first = outboxStore.enqueue({ ...common, dedupeKey: 'agent-a:trace-a:batch-1' });
  const duplicate = outboxStore.enqueue({ ...common, dedupeKey: 'agent-a:trace-a:batch-1' });
  const distinct = outboxStore.enqueue({ ...common, dedupeKey: 'agent-a:trace-b:batch-1' });
  const legacy = outboxStore.enqueue({ ...common });

  assert.deepEqual(duplicate, { eventId: first.eventId, enqueued: false });
  assert.equal(first.enqueued, true);
  assert.equal(distinct.enqueued, true);
  assert.equal(legacy.enqueued, true);
  assert.notEqual(distinct.eventId, first.eventId);
  assert.notEqual(legacy.eventId, first.eventId);
  assert.equal(outboxStore.listAll(10).length, 3);
  assert.equal(db.prepare('SELECT callback_url FROM agent_outbox_events WHERE event_id = ?').get(first.eventId).callback_url, null);

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runtime schema migrates an existing outbox and adds dedupe uniqueness', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-outbox-migration-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  db.exec(`
    CREATE TABLE agent_outbox_events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      delivery_mode TEXT NOT NULL,
      delivery_status TEXT NOT NULL,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      callback_url TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    );
  `);

  ensureRuntimeSchema(db);
  const columns = db.prepare('PRAGMA table_info(agent_outbox_events)').all().map((column) => column.name);
  assert.ok(columns.includes('dedupe_key'));
  assert.ok(columns.includes('priority'));
  assert.ok(columns.includes('claim_owner'));
  assert.ok(columns.includes('claim_token'));
  assert.ok(columns.includes('claim_expires_at'));

  const outboxStore = createOutboxStore(db);
  const event = {
    runId: 'run_migrated',
    type: 'daily_digest',
    payload: {},
    deliveryMode: 'feishu_bot',
    callbackUrl: null,
    dedupeKey: 'daily:agent-a:trace-a:2026-07-17',
  };
  const inserted = outboxStore.enqueue(event);
  assert.deepEqual(outboxStore.enqueue(event), { eventId: inserted.eventId, enqueued: false });
  assert.equal(outboxStore.listAll(10).length, 1);

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('outbox claims higher-priority daily reports before older ordinary events', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-outbox-priority-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const outboxStore = createOutboxStore(db);

  const ordinary = outboxStore.enqueue({
    runId: 'run_ordinary',
    type: 'audit_review_finding',
    payload: { title: 'ordinary' },
    deliveryMode: 'feishu_bot',
    callbackUrl: null,
  });
  const daily = outboxStore.enqueue({
    runId: 'run_daily',
    type: 'audit_daily_trace_report',
    payload: { title: 'daily' },
    deliveryMode: 'feishu_bot',
    callbackUrl: null,
  });

  const claimed = outboxStore.claimPending(1, {
    ownerId: 'publisher-priority',
    leaseMs: 60_000,
    now: '2026-07-19T10:00:00.000Z',
  });

  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].event_id, daily.eventId);
  assert.equal(claimed[0].priority, 100);
  assert.equal(claimed[0].claim_owner, 'publisher-priority');
  assert.notEqual(claimed[0].claim_token, null);
  assert.deepEqual(
    outboxStore.listPending(10, '2026-07-19T10:00:30.000Z').map((event) => event.event_id),
    [ordinary.eventId],
  );

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('outbox recovers expired claims and rejects stale claim tokens for delivery and failure', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-outbox-lease-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const outboxStore = createOutboxStore(db);
  const deliveredEvent = outboxStore.enqueue({
    runId: 'run_claim_delivery',
    type: 'audit_review_finding',
    payload: { title: 'claim delivery' },
    deliveryMode: 'feishu_bot',
    callbackUrl: null,
  });

  const first = outboxStore.claimPending(1, {
    ownerId: 'publisher-old',
    leaseMs: 60_000,
    now: '2026-07-19T10:00:00.000Z',
  })[0];
  assert.equal(outboxStore.markDelivered(deliveredEvent.eventId), false);
  assert.equal(outboxStore.markFailed(deliveredEvent.eventId, new Error('missing token')), false);
  assert.deepEqual(outboxStore.claimPending(1, {
    ownerId: 'publisher-too-early',
    leaseMs: 60_000,
    now: '2026-07-19T10:00:59.000Z',
  }), []);

  const recovered = outboxStore.claimPending(1, {
    ownerId: 'publisher-new',
    leaseMs: 60_000,
    now: '2026-07-19T10:01:01.000Z',
  })[0];
  assert.equal(recovered.event_id, deliveredEvent.eventId);
  assert.notEqual(recovered.claim_token, first.claim_token);
  assert.equal(outboxStore.markDelivered(deliveredEvent.eventId, first.claim_token), false);
  assert.equal(outboxStore.markDelivered(deliveredEvent.eventId, recovered.claim_token), true);

  const failedEvent = outboxStore.enqueue({
    runId: 'run_claim_failure',
    type: 'audit_review_finding',
    payload: { title: 'claim failure' },
    deliveryMode: 'feishu_bot',
    callbackUrl: null,
  });
  const failedClaim = outboxStore.claimPending(1, {
    ownerId: 'publisher-failure',
    leaseMs: 60_000,
    now: '2026-07-19T10:02:00.000Z',
  })[0];
  assert.equal(outboxStore.markFailed(failedEvent.eventId, new Error('stale'), 'claim_stale'), false);
  assert.equal(outboxStore.markFailed(failedEvent.eventId, new Error('retry'), failedClaim.claim_token), true);

  const deliveredRow = db.prepare('SELECT * FROM agent_outbox_events WHERE event_id = ?').get(deliveredEvent.eventId);
  assert.equal(deliveredRow.delivery_status, 'delivered');
  assert.equal(deliveredRow.delivery_attempts, 1);
  assert.equal(deliveredRow.claim_token, null);
  const failedRow = db.prepare('SELECT * FROM agent_outbox_events WHERE event_id = ?').get(failedEvent.eventId);
  assert.equal(failedRow.delivery_status, 'pending');
  assert.equal(failedRow.delivery_attempts, 1);
  assert.equal(failedRow.claim_token, null);
  assert.match(failedRow.last_error, /retry/);

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('separate event publishers cannot send the same claimed outbox event concurrently', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-outbox-multi-publisher-'));
  const dbPath = path.join(tmpDir, 'runtime.db');
  const firstDb = openDb(dbPath);
  ensureRuntimeSchema(firstDb);
  const secondDb = openDb(dbPath);
  const firstOutboxStore = createOutboxStore(firstDb);
  const secondOutboxStore = createOutboxStore(secondDb);
  firstOutboxStore.enqueue({
    runId: 'run_multi_publisher',
    type: 'progress_update',
    payload: { title: 'once' },
    deliveryMode: 'callback',
    callbackUrl: 'https://callback.invalid/events',
  });

  let releaseSend;
  let sendCalls = 0;
  const callbackClient = {
    async send() {
      sendCalls += 1;
      await new Promise((resolve) => { releaseSend = resolve; });
    },
  };
  const firstPublisher = createEventPublisher({
    outboxStore: firstOutboxStore,
    callbackClient,
    claimOwnerId: 'publisher-one',
  });
  const secondPublisher = createEventPublisher({
    outboxStore: secondOutboxStore,
    callbackClient,
    claimOwnerId: 'publisher-two',
  });

  const firstFlush = firstPublisher.flushPending();
  await new Promise((resolve) => setImmediate(resolve));
  const secondFlush = secondPublisher.flushPending();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sendCalls, 1);
  releaseSend();
  await Promise.all([firstFlush, secondFlush]);
  assert.equal(firstOutboxStore.listPending(10).length, 0);

  firstDb.close();
  secondDb.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('publisher skips inactive Feishu claims without starving live callback delivery', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-outbox-mode-filter-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const outboxStore = createOutboxStore(db);
  const feishuEvent = outboxStore.enqueue({
    runId: 'run_feishu_disabled',
    type: 'audit_daily_trace_report',
    payload: { title: 'daily pending' },
    deliveryMode: 'feishu_bot',
    callbackUrl: null,
  });
  const callbackEvent = outboxStore.enqueue({
    runId: 'run_callback_live',
    type: 'progress_update',
    payload: { title: 'callback live' },
    deliveryMode: 'callback',
    callbackUrl: 'https://callback.invalid/events',
  });
  const sent = [];
  const publisher = createEventPublisher({
    outboxStore,
    callbackClient: { async send(_url, payload) { sent.push(payload); } },
    feishuBotClient: { mode: 'dry-run', async send() { throw new Error('must not send'); } },
    claimOwnerId: 'publisher-mode-filter',
  });

  await publisher.flushPending(20);

  assert.deepEqual(sent, [{ title: 'callback live' }]);
  const feishuRow = db.prepare('SELECT * FROM agent_outbox_events WHERE event_id = ?').get(feishuEvent.eventId);
  const callbackRow = db.prepare('SELECT * FROM agent_outbox_events WHERE event_id = ?').get(callbackEvent.eventId);
  assert.equal(feishuRow.delivery_status, 'pending');
  assert.equal(feishuRow.claim_token, null);
  assert.equal(callbackRow.delivery_status, 'delivered');

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('publisher still fails claimed events whose delivery client is missing', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-outbox-missing-client-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const outboxStore = createOutboxStore(db);
  const event = outboxStore.enqueue({
    runId: 'run_missing_client',
    type: 'unknown_delivery',
    payload: { title: 'missing client' },
    deliveryMode: 'unknown_mode',
    callbackUrl: null,
  });
  const publisher = createEventPublisher({
    outboxStore,
    claimOwnerId: 'publisher-missing-client',
  });

  await publisher.flushPending(20);

  const row = db.prepare('SELECT * FROM agent_outbox_events WHERE event_id = ?').get(event.eventId);
  assert.equal(row.delivery_status, 'pending');
  assert.equal(row.delivery_attempts, 1);
  assert.equal(row.claim_token, null);
  assert.match(row.last_error, /No delivery client configured/);

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('event publisher routes feishu_bot without persisting webhook and prevents overlapping flushes', async () => {
  let releaseSend;
  const sent = [];
  const rows = [{
    event_id: 'evt_feishu',
    run_id: 'run_feishu',
    type: 'audit_review_finding',
    payload_json: { msg_type: 'interactive', card: {} },
    delivery_mode: 'feishu_bot',
    callback_url: null,
  }];
  let listCalls = 0;
  const outboxStore = {
    enqueued: [],
    enqueue(event) { this.enqueued.push(event); return 'evt_enqueued'; },
    listPending() { listCalls += 1; return rows; },
    markDelivered(eventId) { sent.push(`delivered:${eventId}`); },
    markFailed(_eventId, error) { throw error; },
  };
  const publisher = createEventPublisher({
    outboxStore,
    feishuBotClient: {
      async send(payload) {
        sent.push(payload);
        await new Promise((resolve) => { releaseSend = resolve; });
      },
    },
  });

  publisher.enqueueRunEvent({
    run_id: 'run_feishu',
    delivery_mode: 'feishu_bot',
    delivery_callback_url: 'https://must-not-be-persisted.invalid/hook',
  }, 'audit_review_finding', rows[0].payload_json, { dedupeKey: 'dedupe-1' });
  assert.equal(outboxStore.enqueued[0].callbackUrl, null);
  assert.equal(outboxStore.enqueued[0].dedupeKey, 'dedupe-1');

  const firstFlush = publisher.flushPending();
  const overlappingFlush = publisher.flushPending();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listCalls, 1);
  assert.equal(sent.length, 1);
  releaseSend();
  await Promise.all([firstFlush, overlappingFlush]);
  assert.deepEqual(sent, [rows[0].payload_json, 'delivered:evt_feishu']);
});

test('event publisher preserves pending Feishu events outside live mode', async () => {
  const rows = [{
    event_id: 'evt_pending_feishu',
    run_id: 'run_pending_feishu',
    type: 'audit_review_high_risk_group',
    payload_json: { msg_type: 'interactive', card: {} },
    delivery_mode: 'feishu_bot',
    callback_url: null,
  }];

  for (const mode of ['dry-run', 'disabled']) {
    const stateChanges = [];
    let sendCalls = 0;
    const publisher = createEventPublisher({
      outboxStore: {
        listPending() { return rows; },
        markDelivered(eventId) { stateChanges.push(`delivered:${eventId}`); },
        markFailed(eventId) { stateChanges.push(`failed:${eventId}`); },
      },
      feishuBotClient: {
        mode,
        async send() {
          sendCalls += 1;
          return { mode, delivered: false };
        },
      },
    });

    await publisher.flushPending();

    assert.deepEqual(stateChanges, [], `${mode} must not mutate pending delivery state`);
    assert.equal(sendCalls, 0);
  }
});
