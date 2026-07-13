import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb } from '../../scripts/lib/db.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createHttpApp } from '../../src/adapters/http/app.js';
import { createDashboardAccessStore } from '../../src/auditReview/dashboardAccessStore.js';
import { createDashboardSnapshotStore } from '../../src/auditReview/dashboardSnapshotStore.js';
import { createDashboardAuth } from '../../src/auditReview/dashboardAuth.js';
import { createReviewStore } from '../../src/auditReview/reviewStore.js';
import { createVisualization } from '../../src/auditReview/visualization.js';

const TEST_NOW = new Date('2026-07-10T10:00:00.000Z');
const FUTURE_EXPIRES_AT = new Date(TEST_NOW.getTime() + 24 * 60 * 60 * 1000).toISOString();

async function withDashboardServer(fn, { configOverrides = {} } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-dashboard-magic-'));
  const dbPath = path.join(tmpDir, 'audit.db');
  const db = openDb(dbPath);
  ensureRuntimeSchema(db);
  ensureReviewSchema(db);

  const config = {
    dbPath,
    rootDir: tmpDir,
    auditReview: {
      http: {
        requireDashboardToken: true,
        allowedOrigins: [],
        ...(configOverrides.auditReview?.http ?? {}),
      },
      visualization: {
        baseUrl: 'http://127.0.0.1:9320',
        dashboardPath: '/dashboard',
        ...(configOverrides.auditReview?.visualization ?? {}),
      },
    },
    ...Object.fromEntries(Object.entries(configOverrides).filter(([key]) => key !== 'auditReview')),
  };
  const reviewStore = createReviewStore(db);
  const dashboardAccessStore = createDashboardAccessStore(db);
  const dashboardSnapshotStore = createDashboardSnapshotStore(db);
  const dashboardAuth = createDashboardAuth({
    config,
    env: { AUDIT_AGENT_DASHBOARD_TOKEN: 'api-token' },
  });
  const visualization = createVisualization({ reviewStore, config });
  const app = createHttpApp({
    db,
    config,
    reviewStore,
    dashboardAuth,
    dashboardAccessStore,
    dashboardSnapshotStore,
    visualization,
    scheduler: { runOnce: async () => ({ reviewId: 'review-test', status: 'completed' }) },
    now: () => TEST_NOW,
  });

  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const { port } = app.address();
  try {
    await fn({
      baseUrl: `http://127.0.0.1:${port}`,
      tmpDir,
      db,
      reviewStore,
      dashboardAccessStore,
      dashboardSnapshotStore,
    });
  } finally {
    await new Promise((resolve) => app.close(resolve));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function createSnapshotFile(tmpDir, name, html) {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, html, 'utf-8');
  return filePath;
}

test('magic link creates a scoped dashboard session and snapshot routes enforce agent scope', async () => {
  await withDashboardServer(async ({
    baseUrl,
    tmpDir,
    reviewStore,
    dashboardAccessStore,
    dashboardSnapshotStore,
  }) => {
    const agentAFile = createSnapshotFile(
      tmpDir,
      'agent-a.html',
      '<!doctype html><html lang="zh-CN"><body>agent-a snapshot</body></html>',
    );
    const agentBFile = createSnapshotFile(
      tmpDir,
      'agent-b.html',
      '<!doctype html><html lang="zh-CN"><body>agent-b snapshot</body></html>',
    );
    const globalFile = createSnapshotFile(
      tmpDir,
      'global.html',
      '<!doctype html><html lang="zh-CN"><body>global snapshot</body></html>',
    );

    dashboardSnapshotStore.createSnapshotMetadata({
      snapshotId: 'snap-agent-a',
      reviewId: 'review-a',
      agentId: 'agent-a',
      generatedAt: '2026-07-10T09:00:00.000Z',
      expiresAt: FUTURE_EXPIRES_AT,
      filePath: agentAFile,
      sha256: 'sha-a',
      byteSize: 64,
      title: 'Agent A 快照',
      status: 'completed',
      findingCount: 1,
    });
    dashboardSnapshotStore.createSnapshotMetadata({
      snapshotId: 'snap-agent-b',
      reviewId: 'review-b',
      agentId: 'agent-b',
      generatedAt: '2026-07-10T09:00:00.000Z',
      expiresAt: FUTURE_EXPIRES_AT,
      filePath: agentBFile,
      sha256: 'sha-b',
      byteSize: 64,
      title: 'Agent B 快照',
      status: 'completed',
      findingCount: 1,
    });
    dashboardSnapshotStore.createSnapshotMetadata({
      snapshotId: 'snap-global',
      reviewId: 'review-global',
      agentId: null,
      generatedAt: '2026-07-10T09:00:00.000Z',
      expiresAt: FUTURE_EXPIRES_AT,
      filePath: globalFile,
      sha256: 'sha-global',
      byteSize: 64,
      title: '全局快照',
      status: 'completed',
      findingCount: 2,
    });

    reviewStore.createRun({
      reviewId: 'review-a',
      windowFrom: '2026-07-10T08:00:00.000Z',
      windowTo: '2026-07-10T09:00:00.000Z',
      triggerType: 'scheduled',
      intervalMinutes: 60,
      riskPolicyVersion: 'risk-test',
      promptVersion: 'prompt-test',
      reviewerVersion: 'reviewer-test',
    });
    reviewStore.finishRun('review-a', { status: 'completed', findingCount: 1 });
    reviewStore.upsertFinding({
      finding_id: 'finding-agent-a',
      review_id: 'review-a',
      category: 'failed_call',
      severity: 'medium',
      agent_id: 'agent-a',
      tool_name: 'tool.a',
      trace_id: 'trace-a',
      title: 'Agent A finding',
      summary: 'Agent A scoped finding',
      recommendation: '',
      requires_action: 0,
      evidence_event_ids: [],
      evidence_json: '[]',
      risk_policy_version: 'risk-test',
      prompt_version: 'prompt-test',
      reviewer_version: 'reviewer-test',
    });
    reviewStore.createRun({
      reviewId: 'review-b',
      windowFrom: '2026-07-10T08:00:00.000Z',
      windowTo: '2026-07-10T09:00:00.000Z',
      triggerType: 'scheduled',
      intervalMinutes: 60,
      riskPolicyVersion: 'risk-test',
      promptVersion: 'prompt-test',
      reviewerVersion: 'reviewer-test',
    });
    reviewStore.finishRun('review-b', { status: 'completed', findingCount: 1 });
    reviewStore.upsertFinding({
      finding_id: 'finding-agent-b',
      review_id: 'review-b',
      category: 'failed_call',
      severity: 'medium',
      agent_id: 'agent-b',
      tool_name: 'tool.b',
      trace_id: 'trace-b',
      title: 'Agent B finding',
      summary: 'Agent B scoped finding',
      recommendation: '',
      requires_action: 0,
      evidence_event_ids: [],
      evidence_json: '[]',
      risk_policy_version: 'risk-test',
      prompt_version: 'prompt-test',
      reviewer_version: 'reviewer-test',
    });

    const issued = dashboardAccessStore.issueMagicLink({
      allowedAgentIds: ['agent-a'],
      expiresAt: FUTURE_EXPIRES_AT,
    });

    const openResponse = await fetch(`${baseUrl}/dashboard/open/${issued.token}`, {
      redirect: 'manual',
    });
    assert.equal(openResponse.status, 302);
    assert.equal(openResponse.headers.get('location'), '/dashboard/agents');
    assert.equal(openResponse.headers.get('referrer-policy'), 'no-referrer');

    const setCookie = openResponse.headers.get('set-cookie');
    assert.match(setCookie, /^dashboard_session=[^;]+;/);
    assert.match(setCookie, /HttpOnly/i);
    assert.equal(/Secure/i.test(setCookie), false);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\//i);
    assert.match(setCookie, /Max-Age=86400/i);
    assert.equal(/Domain=/i.test(setCookie), false);
    const cookie = setCookie.split(';')[0];

    const reusedToken = await fetch(`${baseUrl}/dashboard/open/${issued.token}`, { redirect: 'manual' });
    assert.equal(reusedToken.status, 404);
    assert.equal(reusedToken.headers.get('referrer-policy'), 'no-referrer');

    const agentsResponse = await fetch(`${baseUrl}/dashboard/agents`, {
      headers: { cookie },
    });
    assert.equal(agentsResponse.status, 200);
    const agentsHtml = await agentsResponse.text();
    assert.ok(agentsHtml.includes('agent-a'));
    assert.equal(agentsHtml.includes('agent-b'), false);

    const allowedLatest = await fetch(`${baseUrl}/dashboard/agents/agent-a/latest`, {
      headers: { cookie },
    });
    assert.equal(allowedLatest.status, 200);

    const forbiddenLatest = await fetch(`${baseUrl}/dashboard/agents/agent-b/latest`, {
      headers: { cookie },
    });
    assert.equal(forbiddenLatest.status, 403);

    const snapshotResponse = await fetch(`${baseUrl}/dashboard/snapshots/snap-agent-a`, {
      headers: { cookie },
    });
    assert.equal(snapshotResponse.status, 200);
    assert.equal(snapshotResponse.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await snapshotResponse.text(), '<!doctype html><html lang="zh-CN"><body>agent-a snapshot</body></html>');

    const downloadResponse = await fetch(`${baseUrl}/dashboard/snapshots/snap-agent-a/download`, {
      headers: { cookie },
    });
    assert.equal(downloadResponse.status, 200);
    assert.match(downloadResponse.headers.get('content-disposition'), /^attachment; filename="audit-dashboard_agent-a-review-a_/);

    const forbiddenSnapshot = await fetch(`${baseUrl}/dashboard/snapshots/snap-agent-b`, {
      headers: { cookie },
    });
    assert.equal(forbiddenSnapshot.status, 403);

    const forbiddenGlobalSnapshot = await fetch(`${baseUrl}/dashboard/snapshots/snap-global`, {
      headers: { cookie },
    });
    assert.equal(forbiddenGlobalSnapshot.status, 403);

    const forbiddenGlobalDownload = await fetch(`${baseUrl}/dashboard/snapshots/snap-global/download`, {
      headers: { cookie },
    });
    assert.equal(forbiddenGlobalDownload.status, 403);

    const bearerGlobalSnapshot = await fetch(`${baseUrl}/dashboard/snapshots/snap-global`, {
      headers: { authorization: 'Bearer api-token' },
    });
    assert.equal(bearerGlobalSnapshot.status, 200);
    assert.equal(await bearerGlobalSnapshot.text(), '<!doctype html><html lang="zh-CN"><body>global snapshot</body></html>');

    const bearerGlobalDownload = await fetch(`${baseUrl}/dashboard/snapshots/snap-global/download`, {
      headers: { authorization: 'Bearer api-token' },
    });
    assert.equal(bearerGlobalDownload.status, 200);
    assert.match(bearerGlobalDownload.headers.get('content-disposition'), /^attachment; filename="audit-dashboard_unknown-agent-review-global_/);

    const allowedFinding = await fetch(`${baseUrl}/dashboard/audit-findings/finding-agent-a`, {
      headers: { cookie },
    });
    assert.equal(allowedFinding.status, 200);

    const forbiddenFinding = await fetch(`${baseUrl}/dashboard/audit-findings/finding-agent-b`, {
      headers: { cookie },
    });
    assert.equal(forbiddenFinding.status, 403);

    const allowedReview = await fetch(`${baseUrl}/dashboard/audit-reviews/review-a`, {
      headers: { cookie },
    });
    assert.equal(allowedReview.status, 200);

    const forbiddenReview = await fetch(`${baseUrl}/dashboard/audit-reviews/review-b`, {
      headers: { cookie },
    });
    assert.equal(forbiddenReview.status, 403);

    const bearerFinding = await fetch(`${baseUrl}/dashboard/audit-findings/finding-agent-b`, {
      headers: { authorization: 'Bearer api-token' },
    });
    assert.equal(bearerFinding.status, 200);

    const bearerReview = await fetch(`${baseUrl}/dashboard/audit-reviews/review-b`, {
      headers: { authorization: 'Bearer api-token' },
    });
    assert.equal(bearerReview.status, 200);

    const cookieOnlyApi = await fetch(`${baseUrl}/v1/audit-reviews`, {
      headers: { cookie },
    });
    assert.equal(cookieOnlyApi.status, 401);

    const bearerApi = await fetch(`${baseUrl}/v1/audit-reviews`, {
      headers: { authorization: 'Bearer api-token' },
    });
    assert.equal(bearerApi.status, 200);
  });
});

test('dashboard automatically issues a 24h read-only session for new visitors', async () => {
  await withDashboardServer(async ({
    baseUrl,
    tmpDir,
    dashboardSnapshotStore,
  }) => {
    const agentAFile = createSnapshotFile(
      tmpDir,
      'auto-agent-a.html',
      '<!doctype html><html lang="zh-CN"><body>agent-a snapshot</body></html>',
    );
    const agentBFile = createSnapshotFile(
      tmpDir,
      'auto-agent-b.html',
      '<!doctype html><html lang="zh-CN"><body>agent-b snapshot</body></html>',
    );

    dashboardSnapshotStore.createSnapshotMetadata({
      snapshotId: 'auto-snap-agent-a',
      reviewId: 'auto-review-a',
      agentId: 'agent-a',
      generatedAt: '2026-07-10T09:00:00.000Z',
      expiresAt: FUTURE_EXPIRES_AT,
      filePath: agentAFile,
      sha256: 'sha-auto-a',
      byteSize: 64,
      title: 'Agent A 快照',
      status: 'completed',
      findingCount: 1,
    });
    dashboardSnapshotStore.createSnapshotMetadata({
      snapshotId: 'auto-snap-agent-b',
      reviewId: 'auto-review-b',
      agentId: 'agent-b',
      generatedAt: '2026-07-10T09:00:00.000Z',
      expiresAt: FUTURE_EXPIRES_AT,
      filePath: agentBFile,
      sha256: 'sha-auto-b',
      byteSize: 64,
      title: 'Agent B 快照',
      status: 'completed',
      findingCount: 1,
    });

    const openResponse = await fetch(`${baseUrl}/dashboard`, { redirect: 'manual' });
    assert.equal(openResponse.status, 302);
    assert.equal(openResponse.headers.get('location'), '/dashboard/agents');
    assert.equal(openResponse.headers.get('referrer-policy'), 'no-referrer');
    const setCookie = openResponse.headers.get('set-cookie');
    assert.match(setCookie, /^dashboard_session=[^;]+;/);
    assert.match(setCookie, /HttpOnly/i);
    assert.equal(/Secure/i.test(setCookie), false);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Max-Age=86400/i);

    const cookie = setCookie.split(';')[0];
    const agentsResponse = await fetch(`${baseUrl}/dashboard/agents`, { headers: { cookie } });
    assert.equal(agentsResponse.status, 200);
    const html = await agentsResponse.text();
    assert.ok(html.includes('agent-a'));
    assert.ok(html.includes('agent-b'));
  });
});

test('automatic dashboard sessions honor configured public agent allowlist', async () => {
  await withDashboardServer(async ({
    baseUrl,
    tmpDir,
    dashboardSnapshotStore,
  }) => {
    const agentAFile = createSnapshotFile(
      tmpDir,
      'allow-agent-a.html',
      '<!doctype html><html lang="zh-CN"><body>agent-a snapshot</body></html>',
    );
    const agentBFile = createSnapshotFile(
      tmpDir,
      'allow-agent-b.html',
      '<!doctype html><html lang="zh-CN"><body>agent-b snapshot</body></html>',
    );

    dashboardSnapshotStore.createSnapshotMetadata({
      snapshotId: 'allow-snap-agent-a',
      reviewId: 'allow-review-a',
      agentId: 'agent-a',
      generatedAt: '2026-07-10T09:00:00.000Z',
      expiresAt: FUTURE_EXPIRES_AT,
      filePath: agentAFile,
      sha256: 'sha-allow-a',
      byteSize: 64,
      title: 'Agent A 快照',
      status: 'completed',
      findingCount: 1,
    });
    dashboardSnapshotStore.createSnapshotMetadata({
      snapshotId: 'allow-snap-agent-b',
      reviewId: 'allow-review-b',
      agentId: 'agent-b',
      generatedAt: '2026-07-10T09:00:00.000Z',
      expiresAt: FUTURE_EXPIRES_AT,
      filePath: agentBFile,
      sha256: 'sha-allow-b',
      byteSize: 64,
      title: 'Agent B 快照',
      status: 'completed',
      findingCount: 1,
    });

    const openResponse = await fetch(`${baseUrl}/dashboard`, { redirect: 'manual' });
    assert.equal(openResponse.status, 302);
    const cookie = openResponse.headers.get('set-cookie').split(';')[0];

    const agentsResponse = await fetch(`${baseUrl}/dashboard/agents`, { headers: { cookie } });
    assert.equal(agentsResponse.status, 200);
    const html = await agentsResponse.text();
    assert.ok(html.includes('agent-a'));
    assert.equal(html.includes('agent-b'), false);

    const forbiddenLatest = await fetch(`${baseUrl}/dashboard/agents/agent-b/latest`, {
      headers: { cookie },
    });
    assert.equal(forbiddenLatest.status, 403);
  }, {
    configOverrides: {
      auditReview: {
        http: {
          publicDashboardAgentIds: ['agent-a'],
        },
      },
    },
  });
});

test('dashboard session cookies are secure when forwarded protocol is https', async () => {
  await withDashboardServer(async ({ baseUrl }) => {
    const openResponse = await fetch(`${baseUrl}/dashboard`, {
      redirect: 'manual',
      headers: { 'x-forwarded-proto': 'https' },
    });
    assert.equal(openResponse.status, 302);
    const setCookie = openResponse.headers.get('set-cookie');
    assert.match(setCookie, /^dashboard_session=[^;]+;/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Max-Age=86400/i);
  });
});
