import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createReviewStore } from '../../src/auditReview/reviewStore.js';
import { createLockStore } from '../../src/auditReview/lockStore.js';
import { createIngestCursorStore } from '../../src/auditReview/ingestCursorStore.js';
import { createCandidateDetector } from '../../src/auditReview/candidateDetector.js';
import { createLlmReviewer } from '../../src/auditReview/llmReviewer.js';
import { createReviewNotifier } from '../../src/auditReview/notification.js';
import { createVisualization } from '../../src/auditReview/visualization.js';
import { createRuntimeAuditLogger } from '../../src/observability/runtimeAudit.js';
import { createAuditReviewScheduler } from '../../src/auditReview/scheduler.js';

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
  product_id TEXT,
  error_code TEXT,
  error_message TEXT,
  tags TEXT,
  raw_json TEXT
);
`;

const OUTBOX_SCHEMA = `
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
`;

const RISK_POLICY = {
  version: 'risk-policy-v1',
  repeatWindowMinutes: 10,
  repeatThreshold: 5,
  slowCallDurationMs: 30000,
  highRiskToolPatterns: ['*delete*', '*write*', 'shell.*'],
  agentToolAllowlists: {},
};

function makeConfig(overrides = {}) {
  return {
    dbPath: ':memory:',
    agents: {
      'mt-agent': { displayName: 'MT 审计 Agent' },
    },
    auditReview: {
      enabled: true,
      intervalMinutes: 30,
      initialDelaySeconds: 30,
      lookbackOverlapMinutes: 5,
      maxEventsPerReview: 500,
      notification: {
        mode: 'callback',
        callbackUrl: 'http://127.0.0.1:9999/audit-review-events',
        minSeverity: 'medium',
        sendEmptyReview: false,
      },
      http: {
        bindHost: '127.0.0.1',
        requireDashboardToken: false,
        allowedOrigins: [],
      },
      riskPolicy: RISK_POLICY,
      llmReview: {
        promptVersion: 'audit-review-prompt-v1',
        reviewerVersion: 'audit-reviewer-v1',
      },
      visualization: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:9320',
        dashboardPath: '/dashboard',
      },
      ...overrides,
    },
  };
}

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = OFF');
  db.exec(AUDIT_EVENTS_SCHEMA);
  db.exec(OUTBOX_SCHEMA);
  ensureRuntimeSchema(db);
  ensureReviewSchema(db);
  return db;
}

function insertEvent(db, n, opts = {}) {
  const o = {
    row_hash: `hash-${n}`,
    ts: opts.ts ?? '2026-07-03T10:00:00.000Z',
    agent_id: opts.agent_id ?? 'mt-agent',
    trace_id: opts.trace_id ?? 'trace-1',
    span_id: opts.span_id ?? `span-${n}`,
    parent_span_id: null,
    event: opts.event ?? 'tool.end',
    tool_name: opts.tool_name ?? 'some.tool',
    status: opts.status ?? 'ok',
    result_summary: opts.result_summary ?? null,
    duration_ms: opts.duration_ms ?? 10,
    channel: opts.channel ?? null,
    user_id: null,
    product_id: opts.product_id ?? null,
    error_code: opts.error_code ?? null,
    error_message: opts.error_message ?? null,
    tags: null,
    raw_json: opts.raw_json ?? '{}',
  };
  db.prepare(`INSERT INTO audit_events
    (row_hash, ts, agent_id, trace_id, span_id, parent_span_id, event, tool_name, status,
     result_summary, duration_ms, channel, user_id, product_id, error_code, error_message, tags, raw_json)
    VALUES (@row_hash, @ts, @agent_id, @trace_id, @span_id, @parent_span_id, @event, @tool_name, @status,
     @result_summary, @duration_ms, @channel, @user_id, @product_id, @error_code, @error_message, @tags, @raw_json)`)
    .run(o);
}

/**
 * Fake LLM client that returns a valid review object via createStructuredResponse.
 */
function makeFakeLlmClient(reviewOverride) {
  return {
    async createStructuredResponse({ reviewId, window, candidates }) {
      void reviewId; void window; void candidates;
      return reviewOverride ?? {
        type: 'audit_review',
        review_id: 'fake',
        window: { from: '2026-07-03T10:00:00.000Z', to: '2026-07-03T10:30:00.000Z' },
        summary: {
          title: '审查发现 1 个风险',
          overview: '过去 30 分钟共审查 1 条事件，发现 1 个失败调用。',
          severity_counts: { critical: 0, high: 0, medium: 1, low: 0 },
        },
        findings: [
          {
            category: 'failed_call',
            severity: 'medium',
            agent_id: 'mt-agent',
            tool_name: 'some.tool',
            trace_id: 'trace-1',
            product_id: null,
            title: '工具调用失败',
            summary: 'some.tool 状态为 error',
            recommendation: '检查工具调用',
            evidence_event_ids: [1],
            requires_action: false,
          },
        ],
      };
    },
  };
}

function makeFakeLlmClientFailing() {
  return {
    async createStructuredResponse() {
      throw new Error('LLM service unavailable');
    },
  };
}

// Inline real outbox store to keep tests self-contained.
import { createOutboxStore } from '../../src/agent/outboxStore.js';

function buildRealDeps(db, { llmClient } = {}) {
  const config = makeConfig();
  const reviewStore = createReviewStore(db);
  const lockStore = createLockStore(db);
  const cursorStore = createIngestCursorStore(db);
  const outboxStore = createOutboxStore(db);
  const ingestService = {
    ingestSince() {
      return { inserted: 0, scannedFiles: 0, parseErrors: [], cursorUpdates: 0 };
    },
  };
  const detector = createCandidateDetector({ db, riskPolicy: RISK_POLICY });
  const llmReviewer = createLlmReviewer({
    llmClient: llmClient ?? makeFakeLlmClient(),
    model: 'test-model',
  });
  const notifier = createReviewNotifier({ outboxStore, config });
  const visualization = createVisualization({ reviewStore, config });
  const auditLogger = createRuntimeAuditLogger(db, { agentId: 'audit-logger-agent' });
  return { config, reviewStore, lockStore, cursorStore, ingestService, detector, llmReviewer, notifier, visualization, auditLogger };
}

// ===================== Tests =====================

test('scheduler.runOnce happy path: creates completed run, persists findings, releases lock, logs audit events', async () => {
  const db = makeDb();
  // Insert an error event so the detector finds a candidate.
  insertEvent(db, 1, {
    ts: '2026-07-03T10:00:01.000Z',
    tool_name: 'some.query',
    status: 'error',
    error_code: 'boom',
    event: 'tool.end',
  });

  const deps = buildRealDeps(db);
  const scheduler = createAuditReviewScheduler({ db, ...deps, now: () => new Date('2026-07-03T10:30:00.000Z') });

  const result = await scheduler.runOnce({ triggerType: 'scheduled' });

  assert.equal(result.status, 'completed', `expected completed, got ${result.status}`);
  assert.ok(result.reviewId.startsWith('review_'));

  const run = deps.reviewStore.getRun(result.reviewId);
  assert.ok(run, 'run row should exist');
  assert.equal(run.status, 'completed');
  assert.equal(run.trigger_type, 'scheduled');

  // Findings should be persisted.
  const findings = deps.reviewStore.listFindings({ limit: 100 });
  assert.ok(findings.length > 0, 'should have at least one finding');

  // Evidence should be structured with agent_name and log_detail.
  const firstFinding = findings[0];
  assert.ok(Array.isArray(firstFinding.evidence));
  assert.ok(firstFinding.evidence.length > 0, 'finding should carry at least one evidence entry');
  assert.equal(firstFinding.evidence[0].agent_id, 'mt-agent');
  assert.ok(firstFinding.evidence[0].agent_name, 'evidence should carry agent_name');
  assert.ok(firstFinding.evidence[0].log_detail, 'evidence should carry log_detail');

  // Lock should be released.
  const lock = deps.lockStore.getLock('audit_review_scheduler');
  assert.equal(lock, null, 'lock should be released after run');

  // Audit events should be logged by the scheduler.
  const auditRows = db.prepare(`SELECT * FROM audit_events WHERE agent_id = 'audit-logger-agent'`).all();
  const events = auditRows.map((r) => r.event);
  assert.ok(events.includes('review.start'), 'should log review.start');
  assert.ok(events.includes('review.completed'), 'should log review.completed');
  assert.ok(events.includes('review.ingest.completed'), 'should log review.ingest.completed');

  db.close();
});

test('scheduler.runOnce with LLM failing: status completed_degraded, still inserts rule-based findings, lock released', async () => {
  const db = makeDb();
  insertEvent(db, 1, {
    ts: '2026-07-03T10:00:01.000Z',
    tool_name: 'some.query',
    status: 'error',
    error_code: 'boom',
    event: 'tool.end',
  });

  const deps = buildRealDeps(db, { llmClient: makeFakeLlmClientFailing() });
  const scheduler = createAuditReviewScheduler({ db, ...deps, now: () => new Date('2026-07-03T10:30:00.000Z') });

  const result = await scheduler.runOnce({ triggerType: 'scheduled' });

  assert.equal(result.status, 'completed_degraded');
  assert.ok(result.reviewId.startsWith('review_'));

  const run = deps.reviewStore.getRun(result.reviewId);
  assert.equal(run.status, 'completed_degraded');

  // Degraded mode: each candidate becomes a finding.
  const findings = deps.reviewStore.listFindings({ limit: 100 });
  assert.ok(findings.length > 0, 'degraded mode should still produce findings from candidates');

  const lock = deps.lockStore.getLock('audit_review_scheduler');
  assert.equal(lock, null, 'lock should be released');

  // Verify review.llm.completed was logged with error status.
  const auditRows = db.prepare(`SELECT * FROM audit_events WHERE agent_id = 'audit-logger-agent' AND event = 'review.llm.completed'`).all();
  assert.ok(auditRows.length > 0, 'should log review.llm.completed');
  assert.equal(auditRows[0].status, 'error');

  db.close();
});

test('scheduler concurrency: when lock is held, runOnce returns skipped and creates a skipped run', async () => {
  const db = makeDb();
  insertEvent(db, 1, {
    ts: '2026-07-03T10:00:01.000Z',
    tool_name: 'some.query',
    status: 'error',
    event: 'tool.end',
  });

  const deps = buildRealDeps(db);
  // Manually acquire the lock first to simulate a concurrent run.
  const ownerOther = 'owner-other';
  deps.lockStore.acquire({ ownerId: ownerOther, leaseMinutes: 10 });

  const scheduler = createAuditReviewScheduler({ db, ...deps, now: () => new Date('2026-07-03T10:30:00.000Z') });
  const result = await scheduler.runOnce({ triggerType: 'scheduled' });

  assert.equal(result.status, 'skipped');
  assert.ok(result.reviewId.startsWith('review_'));

  const run = deps.reviewStore.getRun(result.reviewId);
  assert.ok(run, 'skipped run row should be created');
  assert.equal(run.status, 'skipped');

  // The lock should still be held by the original owner.
  const lock = deps.lockStore.getLock('audit_review_scheduler');
  assert.ok(lock, 'lock should still exist');
  assert.equal(lock.owner_id, ownerOther);

  // Should log review.lock.skipped.
  const auditRows = db.prepare(`SELECT * FROM audit_events WHERE agent_id = 'audit-logger-agent' AND event = 'review.lock.skipped'`).all();
  assert.ok(auditRows.length > 0, 'should log review.lock.skipped');

  // Clean up
  deps.lockStore.release({ ownerId: ownerOther });
  db.close();
});

test('scheduler.recoverStaleRuns: marks stale running run as failed with review_interrupted', () => {
  const db = makeDb();
  const deps = buildRealDeps(db);
  const reviewStore = deps.reviewStore;
  const lockStore = deps.lockStore;

  // Insert a "running" run with an old started_at.
  const reviewId = `rev_stale_${crypto.randomUUID()}`;
  reviewStore.createRun({
    reviewId,
    windowFrom: '2026-07-03T09:00:00.000Z',
    windowTo: '2026-07-03T09:30:00.000Z',
    triggerType: 'scheduled',
    intervalMinutes: 30,
    riskPolicyVersion: 'risk-policy-v1',
    reviewerVersion: 'audit-reviewer-v1',
  });
  // Manually set started_at to the past so it's stale.
  db.prepare(`UPDATE audit_review_runs SET started_at = ? WHERE review_id = ?`)
    .run('2026-07-03T09:00:00.000Z', reviewId);

  // Insert an expired lock.
  lockStore.acquire({ ownerId: 'old-owner', leaseMinutes: 0 });

  const scheduler = createAuditReviewScheduler({ db, ...deps, now: () => new Date('2026-07-03T10:30:00.000Z') });
  scheduler.recoverStaleRuns();

  const recovered = reviewStore.getRun(reviewId);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error_code, 'review_interrupted');

  // Expired lock should be released.
  const lock = lockStore.getLock('audit_review_scheduler');
  assert.equal(lock, null, 'expired lock should be released');

  // Should log review.recovered.
  const auditRows = db.prepare(`SELECT * FROM audit_events WHERE agent_id = 'audit-logger-agent' AND event = 'review.recovered'`).all();
  assert.ok(auditRows.length > 0, 'should log review.recovered');

  db.close();
});

test('scheduler manual trigger 409 path: runOnce returns skipped when lock held', async () => {
  const db = makeDb();
  insertEvent(db, 1, {
    ts: '2026-07-03T10:00:01.000Z',
    tool_name: 'some.query',
    status: 'error',
    event: 'tool.end',
  });

  const deps = buildRealDeps(db);
  // Hold the lock.
  deps.lockStore.acquire({ ownerId: 'blocking-owner', leaseMinutes: 10 });

  const scheduler = createAuditReviewScheduler({ db, ...deps, now: () => new Date('2026-07-03T10:30:00.000Z') });
  const result = await scheduler.runOnce({ triggerType: 'manual' });

  // The scheduler returns skipped — the HTTP layer maps this to 409.
  assert.equal(result.status, 'skipped');

  // Verify the skipped run has trigger_type manual.
  const run = deps.reviewStore.getRun(result.reviewId);
  assert.ok(run);
  assert.equal(run.trigger_type, 'manual');
  assert.equal(run.status, 'skipped');

  deps.lockStore.release({ ownerId: 'blocking-owner' });
  db.close();
});