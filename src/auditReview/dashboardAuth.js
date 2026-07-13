// src/auditReview/dashboardAuth.js
// Access control for dashboard and audit review API.

export const DASHBOARD_SESSION_COOKIE = 'dashboard_session';

function isLoopback(remoteAddress) {
  if (!remoteAddress) return false;
  if (remoteAddress === '127.0.0.1' || remoteAddress === '::1') return true;
  // IPv4-mapped IPv6
  if (remoteAddress === '::ffff:127.0.0.1') return true;
  // Bracketed IPv6 loopback
  if (remoteAddress.toLowerCase() === '[::1]') return true;
  return false;
}

function constantTimeEqualBuffer(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function timingSafeEqualString(actual, expected) {
  const a = Buffer.from(String(actual), 'utf-8');
  const b = Buffer.from(String(expected), 'utf-8');
  return constantTimeEqualBuffer(a, b);
}

export function createDashboardAuth({ config, env }) {
  const httpConfig = config?.auditReview?.http ?? {};
  const envObj = env ?? process.env;

  function token() {
    const envToken = envObj.AUDIT_AGENT_DASHBOARD_TOKEN;
    if (envToken && envToken.trim() !== '') return envToken;
    if (httpConfig.dashboardToken && httpConfig.dashboardToken.trim() !== '') {
      return httpConfig.dashboardToken;
    }
    return null;
  }

  function shouldRequireToken({ bindHost }) {
    // loopback + not requireDashboardToken -> no token required (GET)
    // anything else requires token
    if (!bindHost) return false;
    if (isLoopback(bindHost) && !httpConfig.requireDashboardToken) {
      return false;
    }
    return true;
  }

  function validateBoot({ bindHost }) {
    if (shouldRequireToken({ bindHost })) {
      const t = token();
      if (!t) {
        throw new Error(
          'AUDIT_AGENT_DASHBOARD_TOKEN must be configured when binding to a non-loopback address'
        );
      }
    }
  }

  function extractBearerToken(req) {
    const auth = req?.headers?.authorization ?? '';
    if (!auth || typeof auth !== 'string') return null;
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : null;
  }

  function extractCookie(req, name) {
    const header = req?.headers?.cookie;
    if (!header || typeof header !== 'string') return null;
    for (const part of header.split(';')) {
      const [rawKey, ...rawValue] = part.trim().split('=');
      if (rawKey === name) return rawValue.join('=');
    }
    return null;
  }

  function authorizeBearer(req) {
    const configured = token();
    if (!configured) {
      return { ok: false, status: 401, code: 'missing_token' };
    }
    const provided = extractBearerToken(req);
    if (!provided) {
      return { ok: false, status: 401, code: 'missing_token' };
    }
    if (!timingSafeEqualString(provided, configured)) {
      return { ok: false, status: 403, code: 'invalid_token' };
    }
    return { ok: true, type: 'bearer', allowedAgentIds: null };
  }

  function authorize(req, { isWrite } = {}) {
    const remoteAddress = req?.socket?.remoteAddress ?? req?.remoteAddress;
    const loopback = isLoopback(remoteAddress);
    const requireToken = httpConfig.requireDashboardToken || !loopback;

    if (!requireToken && loopback && !isWrite) {
      return { ok: true };
    }

    // Either non-loopback, or isWrite, or requireDashboardToken
    const configured = token();
    if (!configured) {
      return { ok: false, status: 401, code: 'missing_token' };
    }
    const provided = extractBearerToken(req);
    if (!provided) {
      return { ok: false, status: 401, code: 'missing_token' };
    }
    if (!timingSafeEqualString(provided, configured)) {
      return { ok: false, status: 403, code: 'invalid_token' };
    }
    return { ok: true };
  }

  function authorizeDashboard(req, { accessStore, now } = {}) {
    const bearer = extractBearerToken(req);
    if (bearer) return authorizeBearer(req);

    if (accessStore) {
      const sessionId = extractCookie(req, DASHBOARD_SESSION_COOKIE);
      if (!sessionId) {
        return { ok: false, status: 401, code: 'missing_session' };
      }
      const session = accessStore.getSession(sessionId, now ? { now } : undefined);
      if (!session) {
        return { ok: false, status: 401, code: 'invalid_session' };
      }
      return {
        ok: true,
        type: 'session',
        allowedAgentIds: session.allowedAgentIds,
        expiresAt: session.expiresAt,
      };
    }

    const fallback = authorize(req, { isWrite: false });
    if (!fallback.ok) return fallback;
    return { ok: true, type: 'legacy', allowedAgentIds: null };
  }

  function isAgentAllowed(authResult, agentId) {
    if (!authResult?.ok) return false;
    if (!Array.isArray(authResult.allowedAgentIds)) return true;
    return authResult.allowedAgentIds.includes(String(agentId));
  }

  function corsHeaders(origin) {
    const allowed = httpConfig.allowedOrigins ?? [];
    if (!origin) return {};
    if (Array.isArray(allowed) && allowed.includes(origin)) {
      return {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization',
        'vary': 'origin',
      };
    }
    return {};
  }

  return {
    isLoopback,
    token,
    shouldRequireToken,
    validateBoot,
    authorize,
    authorizeBearer,
    authorizeDashboard,
    isAgentAllowed,
    corsHeaders,
  };
}

export { isLoopback };
