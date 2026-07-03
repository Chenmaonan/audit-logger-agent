// test/auditReview/httpIntegration.test.js
//
// Integration smoke test for v1.4 audit-review HTTP routes.
// Exercises createHttpApp end-to-end with a real in-memory SQLite DB,
// real dependency graph (reviewStore, lockStore, scheduler, etc.),
// and fake LLM + outbox. No source files are modified.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb, insertEvents } from '../../scripts/lib/db.js';
import { normalizeEntry } from '../../scripts/lib/parser.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createReviewStore } from '../../src/auditReview/reviewStore.js';
import { createLockStore } from '../../src/auditReview/lockStore.js';
import { createIngestCursorStore } from '../../src/auditReview/ingestCursorStore.js';
import { createAuditIngestService } from '../../src/auditReview/ingestService.js';
import { createCandidateDetector } from '../../src/auditReview/candidateDetector.js';
import { createLlmReviewer } from '../../src/auditReview/llmReviewer.js';
import { createReviewNotifier } from '../../src/auditReview/notification.js';
import { createVisualization } from '../../src/auditReview/visualization.js';
import { createDashboardAuth } from '../../src/auditReview/dashboardAuth.js';
import { createAuditReviewScheduler } from '../../src/auditReview/scheduler.js';
import { createHttpApp } from '../../src/adapters/http/app.js';

test('audit review HTTP integration smoke test', async () => {
  // ------------------------------------------------------------------
  // 1. Build a real DB with runtime + review schema and seed audit_events
  // ------------------------------------------------------------------
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-review-http-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = openDb(dbPath);
  ensureRuntimeSchema(db);
  ensureReviewSchema(db);

  const now = Date.now();
  const entries = [
    {
      // Error event -> failed_call candidate
      ts: new Date(now - 2 * 60 * 1000).toISOString(),
      agent_id: 'agent-test',
      trace_id: 'trace-err-1',
      span_id: 'span-err-1',
      event: 'tool.error',
      tool_name: 'search',
      status: 'error',
      result_summary: 'search failed',
      duration_ms: 500,
      channel: 'feishu',
      user_id: 'user-1',
      product_id: 'product-1',
      error: { code: 'E_SEARCH', message: 'search engine down' },
    },
    {
      // High-risk delete tool -> high_risk_permission candidate
      ts: new Date(now - 60 * 1000).toISOString(),
      agent_id: 'agent-test',
      trace_id: 'trace-del-1',
      span_id: 'span-del-1',
      event: 'tool.end',
      tool_name: 'db.delete',
      status: 'ok',
      result_summary: 'deleted 5 rows',
      duration_ms: 100,
      channel: 'feishu',
      user_id: 'user-1',
      product_id: 'product-1',
    },
    {
      // Normal OK event -> not a candidate
      ts: new Date(now - 30 * 1000).toISOString(),
      agent_id: 'agent-test',
      trace_id: 'trace-ok-1',
      span_id: 'span-ok-1',
      event: 'tool.end',
      tool_name: 'search',
      status: 'ok',
      result_summary: 'search ok',
      duration_ms: 50,
      channel: 'feishu',
      user_id: 'user-1',
      product_id: 'product-1',
    },
  ];
  insertEvents(db, entries.map(normalizeEntry));

  // ------------------------------------------------------------------
  // 2. Construct the dependency graph (mirrors scripts/server.js)
  // ------------------------------------------------------------------
  const config = {
    dbPath,
    agents: {},
    auditReview: {
      intervalMinutes: 30,
      lookbackOverlapMinutes: 5,
      maxEventsPerReview: 500,
      riskPolicy: {
        version: 'risk-test-v1',
        highRiskToolPatterns: ['*delete*'],
        repeatWindowMinutes: 10,
        repeatThreshold: 5,
        slowCallDurationMs: 30000,
        agentToolAllowlists: {},
      },
      llmReview: {
        promptVersion: 'prompt-test-v1',
        reviewerVersion: 'reviewer-test-v1',
        model: 'test-model',
      },
      visualization: {
        baseUrl: 'http://127.0.0.1:9320',
        dashboardPath: '/dashboard',
      },
      http: {
        bindHost: '127.0.0.1',
        requireDashboardToken: false,
        allowedOrigins: ['http://127.0.0.1:9320'],
      },
    },
    planner: { model: 'test-model' },
  };

  const reviewStore = createReviewStore(db);
  const lockStore = createLockStore(db);
  const cursorStore = createIngestCursorStore(db);
  const ingestService = createAuditIngestService({ db, config, cursorStore });
  const detector = createCandidateDetector({ db, riskPolicy: config.auditReview.riskPolicy });

  // Fake LLM client: returns a valid review with 1 finding referencing a candidate event id.
  const fakeLlmClient = {
    async createStructuredResponse({ input }) {
      const userMsg = input.find((m) => m.role === 'user');
      const payload = JSON.parse(userMsg.content);
      const eventId = payload.candidates?.[0]?.event_id ?? 1;
      return {
        type: 'audit_review',
        review_id: payload.review_id,
        window: payload.window,
        summary: {
          title: '测试审查发现 1 个风险',
          overview: '基于候选事件发现 1 个高风险操作。',
          severity_counts: { critical: 0, high: 1, medium: 0, low: 0 },
        },
        findings: [
          {
            category: 'high_risk_permission',
            severity: 'high',
            agent_id: 'agent-test',
            tool_name: 'db.delete',
            trace_id: 'trace-del-1',
            product_id: null,
            title: '高危删除操作',
            summary: '检测到删除工具调用，需要审查。',
            recommendation: '确认删除操作已授权。',
            evidence_event_ids: [eventId],
            requires_action: true,
          },
        ],
      };
    },
  };

  const llmReviewer = createLlmReviewer({
    llmClient: fakeLlmClient,
    model: 'test-model',
    promptVersion: 'prompt-test-v1',
    reviewerVersion: 'reviewer-test-v1',
  });

  // Fake outbox store: captures enqueued notifications in-memory.
  const enqueued = [];
  const fakeOutboxStore = {
    enqueue(item) {
      enqueued.push(item);
      return { event_id: 'fake_evt_' + enqueued.length };
    },
  };

  const notifier = createReviewNotifier({ outboxStore: fakeOutboxStore, config });

  const visualization = createVisualization({
    reviewStore,
    config: {
      auditReview: {
        visualization: {
          baseUrl: 'http://127.0.0.1:9320',
          dashboardPath: '/dashboard',
        },
      },
    },
  });

  const dashboardAuth = createDashboardAuth({
    config: {
      auditReview: {
        http: {
          bindHost: '127.0.0.1',
          requireDashboardToken: false,
          allowedOrigins: ['http://127.0.0.1:9320'],
        },
      },
    },
    env: { AUDIT_AGENT_DASHBOARD_TOKEN: 'test-token-123' },
  });

  // ------------------------------------------------------------------
  // 3. Build the scheduler with all deps + a fake audit logger
  // ------------------------------------------------------------------
  const scheduler = createAuditReviewScheduler({
    db,
    config,
    reviewStore,
    lockStore,
    ingestService,
    cursorStore,
    detector,
    llmReviewer,
    notifier,
    visualization,
    auditLogger: { log: async () => {} },
  });

  // ------------------------------------------------------------------
  // 4. createHttpApp + listen on ephemeral port
  // ------------------------------------------------------------------
  const app = createHttpApp({
    db,
    config: { dbPath },
    scheduler,
    reviewStore,
    visualization,
    dashboardAuth,
  });

  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const { port } = app.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // ------------------------------------------------------------------
    // Case 1: GET /v1/audit-reviews before any run -> 200 with empty results
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews`);
      assert.equal(res.status, 200, 'GET /v1/audit-reviews should be 200');
      const body = await res.json();
      assert.equal(body.count, 0, 'should have zero runs');
      assert.equal(body.results.length, 0, 'results array should be empty');
    }

    // ------------------------------------------------------------------
    // Case 2a: POST /v1/audit-reviews/run WITHOUT auth -> 401
    // (loopback write requires token even when requireDashboardToken=false)
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews/run`, { method: 'POST' });
      assert.equal(res.status, 401, 'POST without auth should be 401');
      const body = await res.json();
      assert.equal(body.error_code, 'missing_token', 'should be missing_token');
    }

    // ------------------------------------------------------------------
    // Case 2b: POST with WRONG bearer token -> 403
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews/run`, {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong-token' },
      });
      assert.equal(res.status, 403, 'POST with wrong token should be 403');
      const body = await res.json();
      assert.equal(body.error_code, 'invalid_token', 'should be invalid_token');
    }

    // ------------------------------------------------------------------
    // Case 2c: POST with CORRECT token -> 202 with review_id
    // ------------------------------------------------------------------
    let reviewId;
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews/run`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token-123' },
      });
      assert.equal(res.status, 202, 'POST with correct token should be 202');
      const body = await res.json();
      assert.ok(body.review_id, 'response should include review_id');
      assert.ok(body.status, 'response should include status');
      reviewId = body.review_id;
    }

    // ------------------------------------------------------------------
    // Case: GET /v1/audit-reviews -> new run listed
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.count >= 1, 'should list at least 1 run');
      const found = body.results.find((r) => r.review_id === reviewId);
      assert.ok(found, 'new run should appear in the list');
    }

    // ------------------------------------------------------------------
    // Case: GET /v1/audit-reviews/:reviewId -> 200
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews/${reviewId}`);
      assert.equal(res.status, 200, 'GET review by id should be 200');
      const body = await res.json();
      assert.equal(body.review_id, reviewId, 'review_id should match');
    }

    // ------------------------------------------------------------------
    // Case: GET /v1/audit-findings -> >= 1 finding
    // ------------------------------------------------------------------
    let findingId;
    {
      const res = await fetch(`${baseUrl}/v1/audit-findings`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.count >= 1, 'should have at least 1 finding');
      findingId = body.results[0].finding_id;
      assert.ok(findingId, 'finding should have finding_id');
    }

    // ------------------------------------------------------------------
    // Case: GET /v1/audit-findings/:findingId -> 200
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-findings/${findingId}`);
      assert.equal(res.status, 200, 'GET finding by id should be 200');
      const body = await res.json();
      assert.equal(body.finding_id, findingId, 'finding_id should match');
    }

    // ------------------------------------------------------------------
    // Case: Concurrency 409 — acquire lock manually, then POST
    // ------------------------------------------------------------------
    {
      const acquired = lockStore.acquire({ ownerId: 'holder' });
      assert.ok(acquired.acquired, 'manual lock acquire should succeed');

      const res = await fetch(`${baseUrl}/v1/audit-reviews/run`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token-123' },
      });
      assert.equal(res.status, 409, 'POST while lock held should be 409');
      const body = await res.json();
      assert.equal(body.error_code, 'review_already_running', 'should be review_already_running');

      lockStore.release({ lockName: 'audit_review_scheduler', ownerId: 'holder' });
    }

    // ------------------------------------------------------------------
    // Case: GET /dashboard -> 200 text/html with 审计 or Severity
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/dashboard`);
      assert.equal(res.status, 200, 'GET /dashboard should be 200');
      assert.equal(
        res.headers.get('content-type'),
        'text/html; charset=utf-8',
        'dashboard content-type should be text/html',
      );
      const html = await res.text();
      assert.ok(html.includes('<html'), 'dashboard html should contain <html');
      assert.ok(
        html.includes('审计') || html.includes('Severity'),
        'dashboard should contain 审计 or Severity',
      );
    }

    // ------------------------------------------------------------------
    // Case: GET /dashboard/audit-reviews/:reviewId -> 200 html
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/dashboard/audit-reviews/${reviewId}`);
      assert.equal(res.status, 200, 'GET dashboard review detail should be 200');
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      const html = await res.text();
      assert.ok(html.includes('<html'), 'review detail html should contain <html');
    }

    // ------------------------------------------------------------------
    // Case: GET /dashboard/audit-findings/:findingId -> 200 html
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/dashboard/audit-findings/${findingId}`);
      assert.equal(res.status, 200, 'GET dashboard finding detail should be 200');
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      const html = await res.text();
      assert.ok(html.includes('<html'), 'finding detail html should contain <html');
    }

    // ------------------------------------------------------------------
    // Case: GET /v1/audit-reviews/nonexistent -> 404
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews/nonexistent`);
      assert.equal(res.status, 404, 'GET nonexistent review should be 404');
      const body = await res.json();
      assert.equal(body.error_code, 'review_not_found', 'should be review_not_found');
    }

    // ------------------------------------------------------------------
    // Case: GET /v1/audit-findings/nonexistent -> 404
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-findings/nonexistent`);
      assert.equal(res.status, 404, 'GET nonexistent finding should be 404');
      const body = await res.json();
      assert.equal(body.error_code, 'finding_not_found', 'should be finding_not_found');
    }

    // ------------------------------------------------------------------
    // Case: CORS — non-allowed origin should NOT be echoed
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews`, {
        headers: { Origin: 'http://evil.test' },
      });
      assert.equal(res.status, 200);
      assert.notEqual(
        res.headers.get('access-control-allow-origin'),
        'http://evil.test',
        'evil origin should NOT be echoed in ACAO',
      );
    }

    // ------------------------------------------------------------------
    // Case: CORS — allowed origin should be echoed
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews`, {
        headers: { Origin: 'http://127.0.0.1:9320' },
      });
      assert.equal(res.status, 200);
      assert.equal(
        res.headers.get('access-control-allow-origin'),
        'http://127.0.0.1:9320',
        'allowed origin should be echoed in ACAO',
      );
    }

    // ------------------------------------------------------------------
    // Sanity: the fake outbox should have captured at least 1 enqueue
    // (the summary notification for the successful run).
    // ------------------------------------------------------------------
    assert.ok(enqueued.length >= 1, 'notifier should have enqueued at least 1 notification');
  } finally {
    app.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});