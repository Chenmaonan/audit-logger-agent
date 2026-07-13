import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createDashboardAccessStore } from '../../src/auditReview/dashboardAccessStore.js';

function openDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = OFF');
  ensureReviewSchema(db);
  return db;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('dashboardAccessStore stores only token/session hashes and roundtrips allowed agent scope', () => {
  const db = openDb();
  const store = createDashboardAccessStore(db);
  const expiresAt = '2026-07-11T10:00:00.000Z';

  const issued = store.issueMagicLink({ allowedAgentIds: ['agent-a', 'agent-b'], expiresAt });
  assert.equal(typeof issued.token, 'string');
  assert.ok(issued.token.length >= 32);
  assert.equal(issued.expiresAt, expiresAt);

  const magicRow = db.prepare('SELECT * FROM dashboard_magic_links').get();
  assert.equal(magicRow.token_hash, sha256(issued.token));
  assert.notEqual(magicRow.token_hash, issued.token);
  assert.equal(JSON.stringify(['agent-a', 'agent-b']), magicRow.allowed_agent_ids_json);

  const consumed = store.consumeMagicToken(issued.token, { now: '2026-07-10T10:00:00.000Z' });
  assert.deepEqual(consumed, { allowedAgentIds: ['agent-a', 'agent-b'], expiresAt });

  const sessionId = store.createSession({ allowedAgentIds: consumed.allowedAgentIds, expiresAt });
  assert.equal(typeof sessionId, 'string');
  assert.ok(sessionId.length >= 32);
  const sessionRow = db.prepare('SELECT * FROM dashboard_sessions').get();
  assert.equal(sessionRow.session_hash, sha256(sessionId));
  assert.notEqual(sessionRow.session_hash, sessionId);

  assert.deepEqual(store.getSession(sessionId, { now: '2026-07-10T10:00:00.000Z' }), {
    allowedAgentIds: ['agent-a', 'agent-b'],
    expiresAt,
  });
  db.close();
});

test('dashboardAccessStore rejects expired or repeatedly consumed magic tokens without leaking reason', () => {
  const db = openDb();
  const store = createDashboardAccessStore(db);

  const expired = store.issueMagicLink({
    allowedAgentIds: ['agent-a'],
    expiresAt: '2026-07-10T09:00:00.000Z',
  });
  assert.equal(store.consumeMagicToken(expired.token, { now: '2026-07-10T10:00:00.000Z' }), null);

  const fresh = store.issueMagicLink({
    allowedAgentIds: ['agent-b'],
    expiresAt: '2026-07-10T11:00:00.000Z',
  });
  assert.deepEqual(store.consumeMagicToken(fresh.token, { now: '2026-07-10T10:00:00.000Z' }), {
    allowedAgentIds: ['agent-b'],
    expiresAt: '2026-07-10T11:00:00.000Z',
  });
  assert.equal(store.consumeMagicToken(fresh.token, { now: '2026-07-10T10:05:00.000Z' }), null);
  assert.equal(store.consumeMagicToken('missing-token', { now: '2026-07-10T10:00:00.000Z' }), null);
  db.close();
});

test('dashboardAccessStore deletes expired access rows only', () => {
  const db = openDb();
  const store = createDashboardAccessStore(db);
  const oldToken = store.issueMagicLink({ allowedAgentIds: ['old'], expiresAt: '2026-07-10T09:00:00.000Z' });
  const newToken = store.issueMagicLink({ allowedAgentIds: ['new'], expiresAt: '2026-07-10T11:00:00.000Z' });
  const oldSession = store.createSession({ allowedAgentIds: ['old'], expiresAt: '2026-07-10T09:00:00.000Z' });
  const newSession = store.createSession({ allowedAgentIds: ['new'], expiresAt: '2026-07-10T11:00:00.000Z' });

  assert.deepEqual(store.deleteExpiredAccess('2026-07-10T10:00:00.000Z'), {
    magicLinksDeleted: 1,
    sessionsDeleted: 1,
  });
  assert.equal(db.prepare('SELECT 1 FROM dashboard_magic_links WHERE token_hash = ?').get(sha256(oldToken.token)), undefined);
  assert.ok(db.prepare('SELECT 1 FROM dashboard_magic_links WHERE token_hash = ?').get(sha256(newToken.token)));
  assert.equal(store.getSession(oldSession, { now: '2026-07-10T10:00:00.000Z' }), null);
  assert.ok(store.getSession(newSession, { now: '2026-07-10T10:00:00.000Z' }));
  db.close();
});
