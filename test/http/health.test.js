import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb } from '../../scripts/lib/db.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createHttpApp } from '../../src/adapters/http/app.js';

async function withServer({ db, config }, fn) {
  const server = createHttpApp({ db, config });
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
      assert.equal(typeof body.disk.total_bytes, 'number');
      assert.ok(body.disk.total_bytes >= body.disk.db_bytes);
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
