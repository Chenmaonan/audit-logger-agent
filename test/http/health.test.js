import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb } from '../../scripts/lib/db.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createHttpApp } from '../../src/adapters/http/app.js';

async function withServer({ db, config, ...dependencies }, fn) {
  const server = createHttpApp({ db, config, ...dependencies });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function insertReviewRun(db) {
  db.prepare(`
    INSERT INTO audit_review_runs (
      review_id, window_from, window_to, status, trigger_type, interval_minutes,
      scanned_files, inserted_events, parse_error_count, candidate_event_count, finding_count,
      llm_model, risk_policy_version, prompt_version, reviewer_version,
      error_code, error_message, started_at, finished_at
    ) VALUES (
      'review_latest', '2026-07-06T08:00:00.000Z', '2026-07-06T08:30:00.000Z',
      'completed', 'scheduled', 30, 1, 2, 0, 3, 4,
      'test-model', 'risk-policy-v1', 'prompt-v1', 'reviewer-v1',
      NULL, NULL, '2026-07-06T08:30:00.000Z', '2026-07-06T08:31:00.000Z'
    )
  `).run();
}

function insertOutboxEvent(db, eventId, status) {
  db.prepare(`
    INSERT INTO agent_outbox_events (
      event_id, run_id, type, payload_json, delivery_mode, delivery_status,
      delivery_attempts, max_attempts, next_attempt_at, callback_url,
      last_error, created_at, delivered_at
    ) VALUES (
      @event_id, 'run_health', 'progress_update', '{}', 'callback', @status,
      0, 8, NULL, 'http://127.0.0.1/callback', NULL,
      '2026-07-06T08:00:00.000Z', NULL
    )
  `).run({ event_id: eventId, status });
}

function insertDailyDigestEvent(db, {
  eventId,
  runId,
  status = 'delivered',
  createdAt,
  deliveredAt,
  payload = '{}',
  lastError = null,
}) {
  db.prepare(`
    INSERT INTO agent_outbox_events (
      event_id, run_id, type, payload_json, delivery_mode, delivery_status,
      delivery_attempts, max_attempts, next_attempt_at, callback_url,
      last_error, created_at, delivered_at
    ) VALUES (
      @event_id, @run_id, 'audit_daily_trace_report', @payload_json, 'feishu_bot', @delivery_status,
      1, 8, NULL, NULL, @last_error, @created_at, @delivered_at
    )
  `).run({
    event_id: eventId,
    run_id: runId,
    payload_json: payload,
    delivery_status: status,
    last_error: lastError,
    created_at: createdAt,
    delivered_at: deliveredAt,
  });
}

function notificationScheduler(overrides = {}) {
  return {
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/never-expose-this',
    liveConfirmation: 'CONFIRM_FEISHU_LIVE',
    getHealthStatus() {
      return {
        feishu_mode: 'live',
        configured_enabled: true,
        scheduler_started: true,
        active: true,
        timezone: 'UTC+08:00',
        timezone_offset_minutes: 480,
        schedule_hours: [10, 17],
        catch_up_window_minutes: 30,
        next_run_at_utc: '2026-07-20T02:00:00.000Z',
        next_run_at_local: '2026-07-20T10:00:00+08:00',
        last_slot: {
          slot_key: 'daily:2026-07-19:17',
          report_date: '2026-07-19',
          slot_hour: 17,
          scheduled_for: '2026-07-19T09:00:00.000Z',
          timezone_offset_minutes: 480,
          trigger_type: 'scheduled',
          status: 'enqueued',
          attempts: 1,
          enqueued_count: 2,
          started_at: '2026-07-19T09:00:00.010Z',
          completed_at: '2026-07-19T09:00:00.200Z',
          last_error: 'never expose slot error',
        },
        webhook_url: 'https://open.feishu.cn/open-apis/bot/v2/hook/also-never-expose-this',
        last_error: 'secret delivery error',
        ...overrides,
      };
    },
  };
}

test('GET /health reports writable DB, latest review, outbox counts, and disk usage', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-health-ok-'));
  const dbPath = path.join(tmpDir, 'audit.db');
  const db = openDb(dbPath);
  ensureRuntimeSchema(db);
  ensureReviewSchema(db);
  insertReviewRun(db);
  insertOutboxEvent(db, 'evt_pending', 'pending');
  insertOutboxEvent(db, 'evt_dead', 'dead_letter');

  try {
    await withServer({ db, config: { dbPath } }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.status, 'ok');
      assert.equal(body.db.writable, true);
      assert.equal(body.latest_review.review_id, 'review_latest');
      assert.equal(body.latest_review.status, 'completed');
      assert.deepEqual(body.outbox, { pending: 1, dead_letter: 1 });
      assert.equal(body.notification_digest, null);
      assert.equal(typeof body.disk.total_bytes, 'number');
      assert.ok(body.disk.total_bytes >= body.disk.db_bytes);
    });
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GET /health exposes sanitized Feishu digest schedule and latest fully delivered batch', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-health-notification-'));
  const dbPath = path.join(tmpDir, 'audit.db');
  const db = openDb(dbPath);
  ensureRuntimeSchema(db);
  ensureReviewSchema(db);

  insertDailyDigestEvent(db, {
    eventId: 'evt_old',
    runId: 'daily_2026-07-19_10',
    createdAt: '2026-07-19T02:00:00.050Z',
    deliveredAt: '2026-07-19T02:00:00.500Z',
  });
  insertDailyDigestEvent(db, {
    eventId: 'evt_latest_1',
    runId: 'daily_2026-07-19_17',
    createdAt: '2026-07-19T09:00:00.100Z',
    deliveredAt: '2026-07-19T09:00:00.900Z',
    payload: '{"secret":"payload-secret"}',
  });
  insertDailyDigestEvent(db, {
    eventId: 'evt_latest_2',
    runId: 'daily_2026-07-19_17',
    createdAt: '2026-07-19T09:00:00.200Z',
    deliveredAt: '2026-07-19T09:00:01.300Z',
    lastError: 'webhook-secret-error',
  });
  insertOutboxEvent(db, 'evt_unrelated_newer', 'pending');
  db.prepare(`UPDATE agent_outbox_events SET created_at = '2026-07-19T10:00:00.000Z' WHERE event_id = 'evt_unrelated_newer'`).run();

  try {
    await withServer({
      db,
      config: { dbPath },
      notificationDigestScheduler: notificationScheduler(),
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(body.notification_digest, {
        status_error: false,
        feishu_mode: 'live',
        configured_enabled: true,
        scheduler_started: true,
        active: true,
        timezone: 'UTC+08:00',
        timezone_offset_minutes: 480,
        schedule_hours: [10, 17],
        catch_up_window_minutes: 30,
        next_run_at_utc: '2026-07-20T02:00:00.000Z',
        next_run_at_local: '2026-07-20T10:00:00+08:00',
        last_slot: {
          slot_key: 'daily:2026-07-19:17',
          report_date: '2026-07-19',
          slot_hour: 17,
          scheduled_for: '2026-07-19T09:00:00.000Z',
          timezone_offset_minutes: 480,
          trigger_type: 'scheduled',
          status: 'enqueued',
          attempts: 1,
          enqueued_count: 2,
          started_at: '2026-07-19T09:00:00.010Z',
          completed_at: '2026-07-19T09:00:00.200Z',
        },
        delivery_slot_key: 'daily:2026-07-19:17',
        last_enqueued_at: '2026-07-19T09:00:00.200Z',
        last_delivered_at: '2026-07-19T09:00:01.300Z',
        delivery_lag_ms: 1300,
      });
      const serialized = JSON.stringify(body);
      assert.doesNotMatch(serialized, /never-expose|payload-secret|webhook-secret|CONFIRM_FEISHU_LIVE|last_error|webhook_url/i);
    });
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GET /health does not report a delivery time until every card in the latest digest batch is delivered', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-health-notification-pending-'));
  const dbPath = path.join(tmpDir, 'audit.db');
  const db = openDb(dbPath);
  ensureRuntimeSchema(db);
  ensureReviewSchema(db);

  insertDailyDigestEvent(db, {
    eventId: 'evt_delivered',
    runId: 'daily_2026-07-19_17',
    createdAt: '2026-07-19T09:00:00.100Z',
    deliveredAt: '2026-07-19T09:00:00.900Z',
  });
  insertDailyDigestEvent(db, {
    eventId: 'evt_pending',
    runId: 'daily_2026-07-19_17',
    status: 'pending',
    createdAt: '2026-07-19T09:00:00.200Z',
    deliveredAt: null,
  });

  try {
    await withServer({
      db,
      config: { dbPath },
      notificationDigestScheduler: notificationScheduler(),
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.notification_digest.delivery_slot_key, 'daily:2026-07-19:17');
      assert.equal(body.notification_digest.last_enqueued_at, '2026-07-19T09:00:00.200Z');
      assert.equal(body.notification_digest.last_delivered_at, null);
      assert.equal(body.notification_digest.delivery_lag_ms, null);
    });
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GET /health keeps delivery metrics aligned with the latest digest slot', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-health-notification-empty-'));
  const dbPath = path.join(tmpDir, 'audit.db');
  const db = openDb(dbPath);
  ensureRuntimeSchema(db);
  ensureReviewSchema(db);
  insertDailyDigestEvent(db, {
    eventId: 'evt_previous_delivered',
    runId: 'daily_2026-07-19_10',
    createdAt: '2026-07-19T02:00:00.100Z',
    deliveredAt: '2026-07-19T02:00:00.900Z',
  });

  try {
    await withServer({
      db,
      config: { dbPath },
      notificationDigestScheduler: notificationScheduler({
        last_slot: {
          slot_key: 'daily:2026-07-19:17',
          report_date: '2026-07-19',
          slot_hour: 17,
          scheduled_for: '2026-07-19T09:00:00.000Z',
          timezone_offset_minutes: 480,
          trigger_type: 'scheduled',
          status: 'empty',
          attempts: 1,
          enqueued_count: 0,
          started_at: '2026-07-19T09:00:00.010Z',
          completed_at: '2026-07-19T09:00:00.020Z',
        },
      }),
    }, async (baseUrl) => {
      const body = await (await fetch(`${baseUrl}/health`)).json();
      assert.equal(body.notification_digest.last_slot.status, 'empty');
      assert.equal(body.notification_digest.delivery_slot_key, 'daily:2026-07-19:17');
      assert.equal(body.notification_digest.last_enqueued_at, null);
      assert.equal(body.notification_digest.last_delivered_at, null);
      assert.equal(body.notification_digest.delivery_lag_ms, null);
    });
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GET /health calculates historical delivery lag from the persisted slot schedule', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-health-notification-lag-'));
  const dbPath = path.join(tmpDir, 'audit.db');
  const db = openDb(dbPath);
  ensureRuntimeSchema(db);
  ensureReviewSchema(db);
  insertDailyDigestEvent(db, {
    eventId: 'evt_historical_offset',
    runId: 'daily_2026-07-19_17',
    createdAt: '2026-07-19T09:00:00.100Z',
    deliveredAt: '2026-07-19T09:00:01.000Z',
  });

  try {
    await withServer({
      db,
      config: { dbPath },
      notificationDigestScheduler: notificationScheduler({
        timezone: 'UTC+00:00',
        timezone_offset_minutes: 0,
        last_slot: {
          slot_key: 'daily:2026-07-19:17',
          report_date: '2026-07-19',
          slot_hour: 17,
          scheduled_for: '2026-07-19T09:00:00.000Z',
          timezone_offset_minutes: 480,
          trigger_type: 'scheduled',
          status: 'enqueued',
          attempts: 1,
          enqueued_count: 1,
          started_at: '2026-07-19T09:00:00.010Z',
          completed_at: '2026-07-19T09:00:00.100Z',
        },
      }),
    }, async (baseUrl) => {
      const body = await (await fetch(`${baseUrl}/health`)).json();
      assert.equal(body.notification_digest.timezone_offset_minutes, 0);
      assert.equal(body.notification_digest.last_slot.timezone_offset_minutes, 480);
      assert.equal(body.notification_digest.delivery_lag_ms, 1000);
    });
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GET /health returns non-ok when DB writable probe fails', async () => {
  const failingDb = {
    exec() {
      throw new Error('readonly database');
    },
    prepare() {
      throw new Error('readonly database');
    },
  };

  await withServer({ db: failingDb, config: { dbPath: 'data/audit.db' } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.status, 'error');
    assert.equal(body.db.writable, false);
    assert.match(body.db.error, /readonly database/);
  });
});
