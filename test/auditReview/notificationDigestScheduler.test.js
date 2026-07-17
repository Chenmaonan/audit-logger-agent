import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  createNotificationDigestScheduler,
  nextDailyReportAt,
} from '../../src/auditReview/notificationDigestScheduler.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE audit_review_findings (
      finding_id TEXT PRIMARY KEY,
      agent_id TEXT,
      trace_id TEXT
    );
    CREATE TABLE audit_review_finding_occurrences (
      occurrence_id TEXT PRIMARY KEY,
      finding_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );
  `);
  return db;
}

function insertSamples(db) {
  const insertEvent = db.prepare(`
    INSERT INTO audit_events (id, ts, agent_id, trace_id, tool_name, status)
    VALUES (@id, @ts, @agent_id, @trace_id, @tool_name, @status)
  `);
  insertEvent.run({ id: 1, ts: '2026-07-17T01:00:00.000Z', agent_id: 'a1', trace_id: 't1', tool_name: 'read', status: 'OK' });
  insertEvent.run({ id: 2, ts: '2026-07-17T01:10:00.000Z', agent_id: 'a1', trace_id: 't1', tool_name: 'write', status: 'INTERNAL' });
  insertEvent.run({ id: 3, ts: '2026-07-17T01:20:00.000Z', agent_id: 'a1', trace_id: 't2', tool_name: 'read', status: 'OK' });
  insertEvent.run({ id: 4, ts: '2026-07-17T01:30:00.000Z', agent_id: 'a2', trace_id: 't1', tool_name: 'deploy', status: 'OK' });
  db.prepare('INSERT INTO audit_review_findings (finding_id, agent_id, trace_id) VALUES (?, ?, ?)').run('f1', 'a1', 't1');
  db.prepare(`
    INSERT INTO audit_review_finding_occurrences
      (occurrence_id, finding_id, severity, title, summary, observed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('o1', 'f1', 'high', '高风险写入', '写入摘要', '2026-07-17T01:15:00.000Z');
}

function config() {
  return {
    report: { timezoneOffsetMinutes: 480 },
    auditReview: {
      notification: {
        enabled: true,
        mode: 'feishu_bot',
        dailyReport: { enabled: true, hours: [10, 17], timezoneOffsetMinutes: 480 },
        card: { foldThresholdChars: 1 },
      },
    },
  };
}

test('nextDailyReportAt uses Beijing 10:00 and 17:00 independent of host timezone', () => {
  assert.equal(
    nextDailyReportAt(new Date('2026-07-17T01:59:00.000Z')).toISOString(),
    '2026-07-17T02:00:00.000Z',
  );
  assert.equal(
    nextDailyReportAt(new Date('2026-07-17T02:00:00.000Z')).toISOString(),
    '2026-07-17T09:00:00.000Z',
  );
  assert.equal(
    nextDailyReportAt(new Date('2026-07-17T09:00:00.000Z')).toISOString(),
    '2026-07-18T02:00:00.000Z',
  );
});

test('dry-run renders one isolated daily card group per agent_id and trace_id without outbox writes', () => {
  const db = makeDb();
  insertSamples(db);
  const calls = [];
  const scheduler = createNotificationDigestScheduler({
    db,
    outboxStore: { enqueue: (event) => calls.push(event) },
    config: config(),
    feishuMode: 'dry-run',
  });

  const result = scheduler.runNow({ scheduledFor: new Date('2026-07-17T02:00:00.000Z') });

  assert.equal(result.reason, 'dry_run');
  assert.equal(result.groups.length, 3);
  assert.equal(calls.length, 0);
  const identities = result.groups.map(({ group }) => `${group.agent_id}/${group.trace_id}`).sort();
  assert.deepEqual(identities, ['a1/t1', 'a1/t2', 'a2/t1']);
  for (const item of result.groups) {
    const serialized = JSON.stringify(item.payloads);
    assert.match(serialized, new RegExp(item.group.agent_id));
    assert.match(serialized, new RegExp(item.group.trace_id));
  }
  db.close();
});

test('live daily run enqueues feishu_bot payloads with no callback URL and stable dedupe keys', () => {
  const db = makeDb();
  insertSamples(db);
  const calls = [];
  const scheduler = createNotificationDigestScheduler({
    db,
    outboxStore: {
      enqueue(event) {
        calls.push(event);
        return { enqueued: true };
      },
    },
    config: config(),
    feishuMode: 'live',
  });

  const result = scheduler.runNow({ scheduledFor: new Date('2026-07-17T09:00:00.000Z') });

  assert.equal(result.enqueued, true);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.deliveryMode === 'feishu_bot'));
  assert.ok(calls.every((call) => call.callbackUrl === null));
  assert.equal(new Set(calls.map((call) => call.dedupeKey)).size, 3);
  db.close();
});

test('scheduler start installs the next calendar timer and stop clears it', () => {
  const db = makeDb();
  const timers = [];
  const cleared = [];
  const now = () => new Date('2026-07-17T01:59:00.000Z');
  const scheduler = createNotificationDigestScheduler({
    db,
    outboxStore: { enqueue() {} },
    config: config(),
    feishuMode: 'dry-run',
    now,
    timerApi: {
      setTimeout(callback, delayMs) {
        const timer = { callback, delayMs };
        timers.push(timer);
        return timer;
      },
      clearTimeout(timer) { cleared.push(timer); },
    },
  });

  scheduler.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 60_000);
  scheduler.stop();
  assert.deepEqual(cleared, [timers[0]]);
  db.close();
});
