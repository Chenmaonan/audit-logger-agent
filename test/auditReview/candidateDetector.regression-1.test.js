import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createCandidateDetector } from '../../src/auditReview/candidateDetector.js';

const SCHEMA = `
CREATE TABLE audit_events (
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
  db.exec(SCHEMA);
  return db;
}

function insertEvent(db, n, overrides = {}) {
  const row = {
    row_hash: `regression-${n}`,
    ts: `2026-07-17T06:00:${String(n).padStart(2, '0')}.000Z`,
    agent_id: 'audit-worker-agent',
    trace_id: `trace-${n}`,
    span_id: `span-${n}`,
    parent_span_id: null,
    event: 'tool.end',
    tool_name: 'records.lookup',
    status: 'OK',
    result_summary: 'ok',
    duration_ms: 10,
    channel: null,
    user_id: null,
    entity_type: 'document',
    entity_id: 'doc-1',
    llm_intent_json: null,
    error_message: null,
    tags: null,
    raw_json: '{}',
    ...overrides,
  };

  const result = db.prepare(`INSERT INTO audit_events
    (row_hash, ts, agent_id, trace_id, span_id, parent_span_id, event, tool_name, status,
     result_summary, duration_ms, channel, user_id, entity_type, entity_id, llm_intent_json,
     error_message, tags, raw_json)
    VALUES (@row_hash, @ts, @agent_id, @trace_id, @span_id, @parent_span_id, @event, @tool_name,
     @status, @result_summary, @duration_ms, @channel, @user_id, @entity_type, @entity_id,
     @llm_intent_json, @error_message, @tags, @raw_json)`).run(row);

  return Number(result.lastInsertRowid);
}

function detect(db, riskPolicy = {}) {
  return createCandidateDetector({
    db,
    riskPolicy: {
      repeatWindowMinutes: 10,
      repeatThreshold: 5,
      slowCallDurationMs: 30000,
      highRiskToolPatterns: [],
      agentToolAllowlists: {},
      ...riskPolicy,
    },
  }).detect({
    windowFrom: '2026-07-17T06:00:00.000Z',
    windowTo: '2026-07-17T06:10:00.000Z',
    maxEventsPerReview: 500,
  });
}

// Regression: ISSUE-001
// Found by /qa on 2026-07-17
// Report: Docker QA session (no project report file)
test('repeated_call keeps one candidate anchored to the latest qualifying event', () => {
  const db = makeDb();
  const eventIds = [];

  for (let i = 1; i <= 6; i++) {
    eventIds.push(insertEvent(db, i, {
      ts: `2026-07-17T06:0${i}:00.000Z`,
      trace_id: 'trace-repeated-call',
      span_id: `span-repeated-${i}`,
    }));
  }

  const { candidates } = detect(db);
  const repeated = candidates.filter((candidate) => candidate.category === 'repeated_call');

  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].event_id, eventIds[5]);
  assert.equal(repeated[0].ts, '2026-07-17T06:06:00.000Z');
  assert.match(repeated[0].reason, /6 calls/);

  db.close();
});

// Regression: ISSUE-003
// Found by /ship adversarial review on 2026-07-17
// Report: Docker QA session (no project report file)
test('repeated_call counts unique spans instead of tool lifecycle rows', () => {
  const db = makeDb();

  for (let i = 1; i <= 3; i++) {
    const spanId = `span-paired-${i}`;
    insertEvent(db, 300 + (i * 2) - 1, {
      ts: `2026-07-17T06:0${i}:00.000Z`,
      trace_id: 'trace-paired-lifecycle',
      span_id: spanId,
      event: 'tool.start',
    });
    insertEvent(db, 300 + (i * 2), {
      ts: `2026-07-17T06:0${i}:01.000Z`,
      trace_id: 'trace-paired-lifecycle',
      span_id: spanId,
      event: 'tool.end',
    });
  }

  const { candidates } = detect(db);

  assert.equal(candidates.some((candidate) => candidate.category === 'repeated_call'), false);

  db.close();
});

// Regression: ISSUE-002
// Found by /qa on 2026-07-17
// Report: Docker QA session (no project report file)
test('review lifecycle events stay quiet while unknown tool lifecycle remains reviewable', () => {
  const db = makeDb();
  const internalEventIds = [];

  for (let i = 1; i <= 6; i++) {
    internalEventIds.push(insertEvent(db, 100 + i, {
      ts: `2026-07-17T06:0${i}:00.000Z`,
      agent_id: 'audit-logger-agent',
      trace_id: 'trace-audit-internal',
      span_id: `span-audit-internal-${i}`,
      event: i % 2 === 0 ? 'review.completed' : 'review.llm.completed',
      tool_name: 'audit.llm',
      status: 'INTERNAL',
      duration_ms: 45000,
      entity_type: 'review',
      entity_id: 'review-1',
    }));
  }

  internalEventIds.push(insertEvent(db, 107, {
    ts: '2026-07-17T06:07:00.000Z',
    agent_id: 'audit-logger-agent',
    trace_id: 'trace-audit-internal',
    span_id: 'span-audit-internal-7',
    event: 'review.completed',
    tool_name: 'audit.review',
    status: 'INTERNAL',
    duration_ms: 45000,
    entity_type: 'review',
    entity_id: 'review-1',
  }));

  const unknownHighRiskId = insertEvent(db, 108, {
    ts: '2026-07-17T06:07:30.000Z',
    agent_id: 'audit-logger-agent',
    trace_id: 'trace-unknown-high-risk',
    span_id: 'span-unknown-high-risk',
    event: 'unknown',
    tool_name: 'audit.delete',
    status: 'OK',
    entity_type: 'review',
    entity_id: 'review-1',
    raw_json: '{"event":"tool.finish"}',
  });

  internalEventIds.push(insertEvent(db, 109, {
    ts: '2026-07-17T06:07:40.000Z',
    agent_id: 'audit-logger-agent',
    trace_id: 'trace-unknown-non-tool',
    span_id: 'span-unknown-non-tool',
    event: 'unknown',
    tool_name: 'audit.delete',
    status: 'INTERNAL',
    duration_ms: 45000,
    entity_type: 'review',
    entity_id: 'review-1',
    raw_json: '{"event":"review.completed"}',
  }));

  const realToolErrorId = insertEvent(db, 200, {
    ts: '2026-07-17T06:08:00.000Z',
    agent_id: 'audit-logger-agent',
    trace_id: 'trace-real-tool-error',
    span_id: 'span-real-tool-error',
    event: 'tool.error',
    tool_name: 'records.lookup',
    status: 'INTERNAL',
    duration_ms: 20,
    entity_type: 'document',
    entity_id: 'doc-2',
    error_message: 'upstream unavailable',
  });

  const { candidates } = detect(db, {
    highRiskToolPatterns: ['audit.*'],
    agentToolAllowlists: {
      'audit-logger-agent': ['records.lookup'],
    },
  });
  const toolCallCategories = new Set([
    'failed_call',
    'repeated_call',
    'high_risk_permission',
    'anomalous_call',
  ]);
  const internalCandidates = candidates.filter((candidate) => (
    internalEventIds.includes(candidate.event_id)
      && toolCallCategories.has(candidate.category)
  ));

  assert.deepEqual(internalCandidates, []);
  assert.ok(candidates.some((candidate) => (
    candidate.event_id === realToolErrorId
      && candidate.category === 'failed_call'
  )));
  assert.ok(candidates.some((candidate) => (
    candidate.event_id === unknownHighRiskId
      && candidate.category === 'high_risk_permission'
  )));

  db.close();
});
