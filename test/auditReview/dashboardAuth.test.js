import test from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardAuth } from '../../src/auditReview/dashboardAuth.js';

function makeReq({ remoteAddress, headers = {} } = {}) {
  return { socket: { remoteAddress }, headers };
}

test('loopback GET is authorized without token when requireDashboardToken=false', () => {
  const auth = createDashboardAuth({
    config: { auditReview: { http: { bindHost: '127.0.0.1', requireDashboardToken: false, allowedOrigins: ['http://127.0.0.1:9320'] } } },
    env: {},
  });
  const res = auth.authorize(makeReq({ remoteAddress: '127.0.0.1' }), { isWrite: false });
  assert.equal(res.ok, true);
});

test('loopback POST requires token and returns 401 when missing', () => {
  const auth = createDashboardAuth({
    config: { auditReview: { http: { bindHost: '127.0.0.1', requireDashboardToken: false, allowedOrigins: [] } } },
    env: { AUDIT_AGENT_DASHBOARD_TOKEN: 'secret-token' },
  });
  const res = auth.authorize(makeReq({ remoteAddress: '127.0.0.1' }), { isWrite: true });
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.equal(res.code, 'missing_token');
});

test('loopback POST returns 403 when token is wrong', () => {
  const auth = createDashboardAuth({
    config: { auditReview: { http: { bindHost: '127.0.0.1', requireDashboardToken: false, allowedOrigins: [] } } },
    env: { AUDIT_AGENT_DASHBOARD_TOKEN: 'secret-token' },
  });
  const res = auth.authorize(
    makeReq({ remoteAddress: '127.0.0.1', headers: { authorization: 'Bearer wrong-token' } }),
    { isWrite: true },
  );
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  assert.equal(res.code, 'invalid_token');
});

test('loopback POST is authorized when token is correct', () => {
  const auth = createDashboardAuth({
    config: { auditReview: { http: { bindHost: '127.0.0.1', requireDashboardToken: false, allowedOrigins: [] } } },
    env: { AUDIT_AGENT_DASHBOARD_TOKEN: 'secret-token' },
  });
  const res = auth.authorize(
    makeReq({ remoteAddress: '127.0.0.1', headers: { authorization: 'Bearer secret-token' } }),
    { isWrite: true },
  );
  assert.equal(res.ok, true);
});

test('non-loopback GET without token returns 401', () => {
  const auth = createDashboardAuth({
    config: { auditReview: { http: { bindHost: '0.0.0.0', requireDashboardToken: false, allowedOrigins: [] } } },
    env: {},
  });
  const res = auth.authorize(makeReq({ remoteAddress: '10.0.0.5' }), { isWrite: false });
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
});

test('non-loopback GET with correct token is authorized', () => {
  const auth = createDashboardAuth({
    config: { auditReview: { http: { bindHost: '0.0.0.0', requireDashboardToken: false, allowedOrigins: [] } } },
    env: { AUDIT_AGENT_DASHBOARD_TOKEN: 'tok' },
  });
  const res = auth.authorize(
    makeReq({ remoteAddress: '10.0.0.5', headers: { authorization: 'Bearer tok' } }),
    { isWrite: false },
  );
  assert.equal(res.ok, true);
});

test('validateBoot throws when non-loopback and no token configured without dashboard session auth', () => {
  const auth = createDashboardAuth({
    config: { auditReview: { http: { bindHost: '0.0.0.0', requireDashboardToken: false, allowedOrigins: [] } } },
    env: {},
  });
  assert.throws(() => auth.validateBoot({ bindHost: '0.0.0.0' }), /AUDIT_AGENT_DASHBOARD_TOKEN/);
});

test('validateBoot allows non-loopback without token when dashboard session auth is enabled', () => {
  const auth = createDashboardAuth({
    config: { auditReview: { http: { bindHost: '0.0.0.0', requireDashboardToken: true, allowedOrigins: [] } } },
    env: {},
  });
  auth.validateBoot({ bindHost: '0.0.0.0', allowDashboardSessions: true });
});

test('validateBoot does not throw when loopback and no token', () => {
  const auth = createDashboardAuth({
    config: { auditReview: { http: { bindHost: '127.0.0.1', requireDashboardToken: false, allowedOrigins: [] } } },
    env: {},
  });
  auth.validateBoot({ bindHost: '127.0.0.1' });
});

test('corsHeaders allows configured origin', () => {
  const auth = createDashboardAuth({
    config: { auditReview: { http: { allowedOrigins: ['http://127.0.0.1:9320'] } } },
    env: {},
  });
  const headers = auth.corsHeaders('http://127.0.0.1:9320');
  assert.equal(headers['access-control-allow-origin'], 'http://127.0.0.1:9320');
  assert.equal(headers['access-control-allow-methods'], 'GET, POST, OPTIONS');
  assert.equal(headers.vary, 'origin');
});

test('corsHeaders blocks unconfigured origins', () => {
  const auth = createDashboardAuth({
    config: { auditReview: { http: { allowedOrigins: ['http://127.0.0.1:9320'] } } },
    env: {},
  });
  const headers = auth.corsHeaders('http://evil.example.com');
  assert.deepEqual(headers, {});
});

test('corsHeaders returns empty for no origin', () => {
  const auth = createDashboardAuth({
    config: { auditReview: { http: { allowedOrigins: ['http://127.0.0.1:9320'] } } },
    env: {},
  });
  const headers = auth.corsHeaders(undefined);
  assert.deepEqual(headers, {});
});

test('isLoopback handles ::ffff:127.0.0.1', () => {
  const auth = createDashboardAuth({
    config: { auditReview: { http: {} } },
    env: {},
  });
  assert.equal(auth.isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(auth.isLoopback('10.0.0.1'), false);
});
