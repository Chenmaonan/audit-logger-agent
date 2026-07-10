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
import { createToolSemanticMapper } from '../../src/auditReview/toolSemanticMapper.js';
import { createHttpApp } from '../../src/adapters/http/app.js';

function makeUpstreamEvent(overrides = {}) {
  return {
    ts: '2026-07-06T07:33:08.200Z',
    agent_id: 'agent-test',
    trace_id: 'trace-1',
    span_id: 'span-1',
    event: 'tool.end',
    tool_name: 'search',
    status: 'OK',
    result_summary: 'search ok',
    duration_ms: 50,
    channel: 'http',
    user_id: 'user-1',
    entity: { type: 'product', id: 'product-1' },
    ...overrides,
  };
}

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

const MOJIBAKE_PATTERN = /(?:[涓楂椋闄浣淇鎴鍏椤瀵艰埅鐖璋鐩閾捐矾寤妯鏆棤鍙睍绀鐧诲綍璁块棶浠ょ墝鏇柊堕棿鎬昏澶氶潯佹嵁鏃瑙妫]{2,}|鈥\?|€�)/;

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
      status: 'INTERNAL',
      result_summary: 'search failed',
      duration_ms: 500,
      channel: 'feishu',
      user_id: 'user-1',
      entity: { type: 'product', id: 'product-1' },
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
      status: 'OK',
      result_summary: 'deleted 5 rows',
      duration_ms: 100,
      channel: 'feishu',
      user_id: 'user-1',
      entity: { type: 'product', id: 'product-1' },
    },
    {
      // Normal OK event -> not a candidate
      ts: new Date(now - 30 * 1000).toISOString(),
      agent_id: 'agent-test',
      trace_id: 'trace-ok-1',
      span_id: 'span-ok-1',
      event: 'tool.end',
      tool_name: 'search',
      status: 'OK',
      result_summary: 'search ok',
      duration_ms: 50,
      channel: 'feishu',
      user_id: 'user-1',
      entity: { type: 'product', id: 'product-1' },
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
      const eventId = payload.candidates?.find((candidate) => candidate.tool_name === 'db.delete')?.event_id
        ?? payload.candidates?.[0]?.event_id
        ?? 1;
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
            entity: null,
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
  const bearerHeaders = { Authorization: 'Bearer test-token-123' };

  try {
    // Browser login must not expose the shared token in form HTML or errors.
    {
      const loginPage = await fetch(`${baseUrl}/dashboard/login?token=test-token-123`);
      assert.equal(loginPage.status, 200);
      const html = await loginPage.text();
      assert.ok(html.includes('<form'));
      assert.ok(html.includes('Dashboard 登录'));
      assert.ok(html.includes('访问令牌'));
      assert.equal(html.includes('test-token-123'), false);
      assert.doesNotMatch(html, MOJIBAKE_PATTERN);
    }

    let dashboardCookie;
    {
      const failedLogin = await fetch(`${baseUrl}/dashboard/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'token=wrong-token',
      });
      assert.equal(failedLogin.status, 403);
      assert.equal((await failedLogin.text()).includes('test-token-123'), false);

      const login = await fetch(`${baseUrl}/dashboard/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'token=test-token-123',
      });
      assert.equal(login.status, 303);
      assert.equal(login.headers.get('location'), '/dashboard');
      const setCookie = login.headers.get('set-cookie');
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Lax/);
      assert.equal(setCookie.includes('test-token-123'), false);
      dashboardCookie = setCookie.split(';', 1)[0];
    }

    {
      const dashboard = await fetch(`${baseUrl}/dashboard`, { headers: { cookie: dashboardCookie } });
      assert.equal(dashboard.status, 200);
      assert.equal(dashboard.headers.get('cache-control'), 'no-store');
      const dashboardWithSlash = await fetch(`${baseUrl}/dashboard/`, { headers: { cookie: dashboardCookie } });
      assert.equal(dashboardWithSlash.status, 200);
      assert.equal(dashboardWithSlash.headers.get('cache-control'), 'no-store');
      const apiWithCookie = await fetch(`${baseUrl}/v1/audit-reviews`, { headers: { cookie: dashboardCookie } });
      assert.equal(apiWithCookie.status, 401);
      const apiWithBearer = await fetch(`${baseUrl}/v1/audit-reviews`, { headers: bearerHeaders });
      assert.equal(apiWithBearer.status, 200);
    }

    {
      const logout = await fetch(`${baseUrl}/dashboard/logout`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie: dashboardCookie },
      });
      assert.equal(logout.status, 303);
      assert.equal(logout.headers.get('location'), '/dashboard/login');
      assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    }

    // ------------------------------------------------------------------
    // Case 1: GET /v1/audit-reviews before any run -> 200 with Bearer auth
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews`, { headers: bearerHeaders });
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
      const res = await fetch(`${baseUrl}/v1/audit-reviews`, { headers: bearerHeaders });
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
      const res = await fetch(`${baseUrl}/v1/audit-reviews/${reviewId}`, { headers: bearerHeaders });
      assert.equal(res.status, 200, 'GET review by id should be 200');
      const body = await res.json();
      assert.equal(body.review_id, reviewId, 'review_id should match');
    }

    // ------------------------------------------------------------------
    // Case: GET /v1/audit-findings -> >= 1 finding
    // ------------------------------------------------------------------
    let findingId;
    {
      const res = await fetch(`${baseUrl}/v1/audit-findings`, { headers: bearerHeaders });
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
      const res = await fetch(`${baseUrl}/v1/audit-findings/${findingId}`, { headers: bearerHeaders });
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
      const res = await fetch(`${baseUrl}/dashboard`, { headers: bearerHeaders });
      assert.equal(res.status, 200, 'GET /dashboard should be 200');
      assert.equal(
        res.headers.get('content-type'),
        'text/html; charset=utf-8',
        'dashboard content-type should be text/html',
      );
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const html = await res.text();
      assert.ok(html.includes('<html'), 'dashboard html should contain <html');
      assert.ok(html.includes('审计审查总览'), 'dashboard should contain Chinese overview title');
      assert.ok(html.includes('严重级别'), 'dashboard should contain Chinese severity label');
      assert.equal(html.includes('Audit Review Overview'), false, 'dashboard should not contain English overview title');
      assert.equal(html.includes('Severity'), false, 'dashboard should not contain English Severity');
      assert.equal(html.includes('Confidence'), false, 'dashboard should not contain English Confidence');
      assert.equal(html.includes('Data source'), false, 'dashboard should not contain Data source');
      assert.ok(html.includes('Trace ID'), 'dashboard should contain trace link column');
      assert.ok(html.includes('#trace_sequence'), 'dashboard should link trace ids to the finding trace sequence');
      assert.doesNotMatch(html, MOJIBAKE_PATTERN);
    }

    // ------------------------------------------------------------------
    // Case: GET /dashboard/audit-reviews/:reviewId -> 200 html
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/dashboard/audit-reviews/${reviewId}`, { headers: bearerHeaders });
      assert.equal(res.status, 200, 'GET dashboard review detail should be 200');
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      const html = await res.text();
      assert.ok(html.includes('<html'), 'review detail html should contain <html');
      assert.ok(html.includes('审查批次'), 'review detail should contain Chinese review title');
      assert.ok(html.includes('Trace ID'), 'review detail should contain trace link column');
      assert.ok(html.includes('#trace_sequence'), 'review detail should link trace ids to the finding trace sequence');
      assert.doesNotMatch(html, MOJIBAKE_PATTERN);
    }

    // ------------------------------------------------------------------
    // Case: GET /dashboard/audit-findings/:findingId -> 200 html
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/dashboard/audit-findings/${findingId}`, { headers: bearerHeaders });
      assert.equal(res.status, 200, 'GET dashboard finding detail should be 200');
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      const html = await res.text();
      assert.ok(html.includes('<html'), 'finding detail html should contain <html');
      assert.ok(html.includes('id="trace_sequence"'), 'finding detail should render trace sequence anchor');
      assert.ok(html.includes('工具调用顺序'), 'finding detail should contain Chinese trace sequence section');
      assert.equal(html.includes('id="trace_timeline"'), false, 'finding detail should not render old trace timeline table');
      assert.equal(html.includes('id="evidence_events"'), false, 'finding detail should not render old evidence table');
      assert.ok(html.includes('trace-del-1'), 'finding detail should contain the finding trace id');
      assert.ok(html.includes('db.delete'), 'finding detail should contain the trace tool call');
      assert.ok(html.includes('deleted 5 rows'), 'finding detail should contain the trace event summary');
      assert.ok(html.includes('原始日志片段'), 'finding detail should contain Chinese raw evidence log snippets');
      assert.ok(html.includes('raw-log-pre'), 'finding detail should render raw snippets in preformatted blocks');
      assert.ok(html.includes('&quot;tool_name&quot;:&quot;db.delete&quot;'), 'raw snippet should preserve the original compact JSON field');
      assert.equal(html.includes('Tool call sequence'), false, 'finding detail should not contain English trace sequence section');
      assert.equal(html.includes('Raw log snippet'), false, 'finding detail should not contain English raw evidence label');
      assert.doesNotMatch(html, MOJIBAKE_PATTERN);
      assert.equal(html.includes('置信度'), false, 'finding detail should not contain 置信度');
    }

    // ------------------------------------------------------------------
    // Case: GET /v1/audit-reviews/nonexistent -> 404
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews/nonexistent`, { headers: bearerHeaders });
      assert.equal(res.status, 404, 'GET nonexistent review should be 404');
      const body = await res.json();
      assert.equal(body.error_code, 'review_not_found', 'should be review_not_found');
    }

    // ------------------------------------------------------------------
    // Case: GET /v1/audit-findings/nonexistent -> 404
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-findings/nonexistent`, { headers: bearerHeaders });
      assert.equal(res.status, 404, 'GET nonexistent finding should be 404');
      const body = await res.json();
      assert.equal(body.error_code, 'finding_not_found', 'should be finding_not_found');
    }

    // ------------------------------------------------------------------
    // Case: CORS — non-allowed origin should NOT be echoed
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews`, {
        headers: { ...bearerHeaders, Origin: 'http://evil.test' },
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
        headers: { ...bearerHeaders, Origin: 'http://127.0.0.1:9320' },
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
    // v1.5 regression: captured payloads must be generic delivery payloads
    // and must NOT carry Feishu/Bot-specific required fields. The generic
    // delivery target is the callback receiver; no bot-specific field is
    // required in the payload shape.
    for (const item of enqueued) {
      assert.ok(item.type === 'audit_review_summary' || item.type === 'audit_review_finding',
        `outbox item type should be a generic review payload, got ${item.type}`);
      assert.equal(
        Object.prototype.hasOwnProperty.call(item, 'callback_url'),
        false,
        'outbox item must not carry callback_url as a bot-specific required field',
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(item.payload, 'confidence'),
        false,
        'outbox payload must not carry confidence (removed in v1.5)',
      );
    }
  } finally {
    app.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('audit review ingests all events and sends mapped tool semantics to detector/LLM', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-review-alias-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = openDb(dbPath);
  ensureRuntimeSchema(db);
  ensureReviewSchema(db);

  const capturedPayloads = [];
  const schedulerNow = new Date('2026-07-08T10:00:00.000Z');
  const aliasEventTs = '2026-07-08T09:59:00.000Z';
  const unknownEventTs = '2026-07-08T09:59:30.000Z';
  const config = {
    dbPath,
    agents: {},
    ingest: {
      http: {
        enabled: true,
        maxBodyBytes: 1024 * 1024,
        maxLineBytes: 64 * 1024,
      },
      spoolDir: path.join(tmpDir, 'incoming'),
    },
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
        baseUrl: 'http://127.0.0.1:9321',
        dashboardPath: '/dashboard',
      },
      http: {
        bindHost: '127.0.0.1',
        requireDashboardToken: false,
        allowedOrigins: ['http://127.0.0.1:9321'],
      },
    },
    planner: { model: 'test-model' },
  };

  const reviewStore = createReviewStore(db);
  const lockStore = createLockStore(db);
  const cursorStore = createIngestCursorStore(db);
  const ingestService = createAuditIngestService({ db, config, cursorStore });
  const detector = createCandidateDetector({ db, riskPolicy: config.auditReview.riskPolicy });
  const fakeLlmClient = {
    async createStructuredResponse({ input }) {
      const userMsg = input.find((message) => message.role === 'user');
      const payload = JSON.parse(userMsg.content);
      capturedPayloads.push(payload);
      return {
        type: 'audit_review',
        review_id: payload.review_id,
        window: payload.window,
        summary: {
          title: 'Alias event review',
          overview: 'Canonical events and mapped tool semantics reached the reviewer.',
          severity_counts: { critical: 0, high: 1, medium: 0, low: 0 },
        },
        findings: [
          {
            category: 'high_risk_permission',
            severity: 'high',
            agent_id: payload.candidates[0]?.agent_id ?? 'agent-test',
            tool_name: payload.candidates[0]?.tool_name ?? 'db.delete',
            trace_id: payload.candidates[0]?.trace_id ?? 'trace-alias',
            entity: payload.candidates[0]?.entity ?? null,
            title: 'Canonical event with mapped tool type',
            summary: 'Reviewer received mapped tool semantics.',
            recommendation: 'Verify delete authorization.',
            evidence_event_ids: [payload.candidates[0]?.event_id ?? 1],
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
  const toolSemanticMapper = createToolSemanticMapper({
    db,
    llmClient: fakeLlmClient,
    model: 'test-model',
  });
  const notifier = createReviewNotifier({
    outboxStore: {
      enqueue(item) {
        return { event_id: `fake_evt_${item.type}` };
      },
    },
    config,
  });
  const visualization = createVisualization({
    reviewStore,
    config: {
      auditReview: {
        visualization: config.auditReview.visualization,
      },
    },
  });
  const dashboardAuth = createDashboardAuth({
    config,
    env: { AUDIT_AGENT_DASHBOARD_TOKEN: 'test-token-123' },
  });
  const scheduler = createAuditReviewScheduler({
    db,
    config,
    reviewStore,
    lockStore,
    ingestService,
    cursorStore,
    detector,
    llmReviewer,
    toolSemanticMapper,
    notifier,
    visualization,
    auditLogger: { log: async () => {} },
    now: () => schedulerNow,
  });
  const app = createHttpApp({
    db,
    config,
    scheduler,
    reviewStore,
    visualization,
    dashboardAuth,
    toolSemanticMapper,
  });

  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const { port } = app.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const aliasTraceId = 'trace-alias-tool-end';
  const unknownTraceId = 'trace-unknown-tool-finish';

  try {
    const aliasResponse = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeUpstreamEvent({
        ts: aliasEventTs,
        trace_id: aliasTraceId,
        span_id: 'span-alias-tool-end',
        event: 'tool_end',
        tool_name: 'db.delete',
        result_summary: 'deleted 2 rows',
      })),
    });
    assert.equal(aliasResponse.status, 202);
    assert.deepEqual(await aliasResponse.json(), { accepted: 1, rejected: 0, errors: [] });

    const unknownResponse = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeUpstreamEvent({
        ts: unknownEventTs,
        trace_id: unknownTraceId,
        span_id: 'span-unknown-tool-finish',
        event: 'tool.finish',
        tool_name: 'db.delete',
        result_summary: 'unknown lifecycle event should be accepted',
      })),
    });
    assert.equal(unknownResponse.status, 202);
    const unknownBody = await unknownResponse.json();
    assert.equal(unknownBody.accepted, 1);
    assert.equal(unknownBody.rejected, 0);
    assert.deepEqual(unknownBody.errors, []);

    const storedAlias = db.prepare('SELECT event, mapped_tool_type, mapping_status, raw_json FROM audit_events WHERE trace_id = ?').get(aliasTraceId);
    assert.equal(storedAlias.event, 'tool.end');
    assert.equal(storedAlias.mapped_tool_type, 'delete');
    assert.equal(storedAlias.mapping_status, 'mapped');
    assert.equal(JSON.parse(storedAlias.raw_json).event, 'tool_end');
    const storedUnknown = db.prepare('SELECT event, mapped_tool_type, mapping_status, raw_json FROM audit_events WHERE trace_id = ?').get(unknownTraceId);
    assert.equal(storedUnknown.event, 'unknown');
    assert.equal(storedUnknown.mapped_tool_type, 'delete');
    assert.equal(storedUnknown.mapping_status, 'mapped');
    assert.equal(JSON.parse(storedUnknown.raw_json).event, 'tool.finish');

    const spooled = fs.readFileSync(
      path.join(config.ingest.spoolDir, 'agent-test', `audit-${aliasEventTs.slice(0, 10)}.jsonl`),
      'utf-8',
    );
    assert.ok(spooled.includes(aliasTraceId));
    assert.ok(spooled.includes('"event":"tool_end"'));
    assert.ok(spooled.includes(unknownTraceId));

    const sawCombinedAutoReview = await waitFor(() =>
      capturedPayloads.some((payload) =>
        payload.candidates.some((candidate) => candidate.trace_id === aliasTraceId) &&
        payload.candidates.some((candidate) => candidate.trace_id === unknownTraceId)));
    assert.equal(sawCombinedAutoReview, true);

    const payload = capturedPayloads.find((candidatePayload) =>
      candidatePayload.candidates.some((candidate) => candidate.trace_id === aliasTraceId) &&
      candidatePayload.candidates.some((candidate) => candidate.trace_id === unknownTraceId));
    assert.equal(payload.candidates.length, 2);
    assert.equal(payload.candidates[0].trace_id, aliasTraceId);
    assert.equal(payload.candidates[0].tool_name, 'db.delete');
    assert.equal(payload.candidates[0].event, 'tool.end');
    assert.equal(payload.candidates[0].mapped_tool_type, 'delete');
    assert.ok(payload.candidates.some((candidate) => candidate.trace_id === unknownTraceId));
    assert.ok(payload.candidates.every((candidate) => candidate.mapped_tool_type === 'delete'));
  } finally {
    app.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('POST /v1/ingest triggers an audit review only when a batch is accepted', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-review-ingest-trigger-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = openDb(dbPath);
  ensureRuntimeSchema(db);
  ensureReviewSchema(db);

  const triggerCalls = [];
  const app = createHttpApp({
    db,
    config: {
      dbPath,
      ingest: {
        http: {
          enabled: true,
          maxBodyBytes: 1024 * 1024,
          maxLineBytes: 64 * 1024,
        },
        spoolDir: path.join(tmpDir, 'incoming'),
      },
    },
    scheduler: {
      runAfterIngest() {
        triggerCalls.push(Date.now());
        return Promise.resolve({ status: 'completed' });
      },
    },
  });

  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const { port } = app.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const acceptedResponse = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeUpstreamEvent({
        ts: '2026-07-10T08:15:38.000Z',
        trace_id: 'trace-trigger-review',
      })),
    });
    assert.equal(acceptedResponse.status, 202);
    assert.deepEqual(await acceptedResponse.json(), { accepted: 1, rejected: 0, errors: [] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(triggerCalls.length, 1);

    const rejectedResponse = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ts: '2026-07-10T08:15:39.000Z',
        agent_id: 'agent-test',
        trace_id: 'trace-rejected',
      }),
    });
    assert.equal(rejectedResponse.status, 202);
    const rejectedBody = await rejectedResponse.json();
    assert.equal(rejectedBody.accepted, 0);
    assert.equal(rejectedBody.rejected, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(triggerCalls.length, 1);
  } finally {
    app.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
