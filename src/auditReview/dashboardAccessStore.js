import crypto from 'crypto';

function nowIso() {
  return new Date().toISOString();
}

function randomSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function normalizeAgentIds(allowedAgentIds) {
  return Array.isArray(allowedAgentIds) ? allowedAgentIds.map(String) : [];
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function expiryFrom({ ttlHours, expiresAt }) {
  if (expiresAt) return expiresAt;
  const hours = Number.isFinite(Number(ttlHours)) ? Number(ttlHours) : 24;
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export function createDashboardAccessStore(db) {
  const insertMagicStmt = db.prepare(`
    INSERT INTO dashboard_magic_links (
      token_hash, allowed_agent_ids_json, expires_at, consumed_at, created_at
    ) VALUES (
      @token_hash, @allowed_agent_ids_json, @expires_at, NULL, @created_at
    )
  `);
  const getMagicStmt = db.prepare(`SELECT * FROM dashboard_magic_links WHERE token_hash = ?`);
  const consumeMagicStmt = db.prepare(`
    UPDATE dashboard_magic_links
    SET consumed_at = @consumed_at
    WHERE token_hash = @token_hash
      AND consumed_at IS NULL
      AND expires_at > @now
  `);
  const insertSessionStmt = db.prepare(`
    INSERT INTO dashboard_sessions (
      session_hash, allowed_agent_ids_json, expires_at, created_at
    ) VALUES (
      @session_hash, @allowed_agent_ids_json, @expires_at, @created_at
    )
  `);
  const getSessionStmt = db.prepare(`
    SELECT * FROM dashboard_sessions WHERE session_hash = ? AND expires_at > ?
  `);
  const deleteMagicStmt = db.prepare(`DELETE FROM dashboard_magic_links WHERE expires_at <= ?`);
  const deleteSessionsStmt = db.prepare(`DELETE FROM dashboard_sessions WHERE expires_at <= ?`);

  const consumeTxn = db.transaction(({ tokenHash, now }) => {
    const info = consumeMagicStmt.run({ token_hash: tokenHash, consumed_at: now, now });
    if (info.changes === 0) return null;
    return getMagicStmt.get(tokenHash) ?? null;
  });

  return {
    issueMagicLink({ allowedAgentIds = [], ttlHours, expiresAt } = {}) {
      const token = randomSecret();
      const expires = expiryFrom({ ttlHours, expiresAt });
      insertMagicStmt.run({
        token_hash: hashSecret(token),
        allowed_agent_ids_json: JSON.stringify(normalizeAgentIds(allowedAgentIds)),
        expires_at: expires,
        created_at: nowIso(),
      });
      return { token, expiresAt: expires };
    },

    consumeMagicToken(token, { now = nowIso() } = {}) {
      const row = consumeTxn({ tokenHash: hashSecret(String(token)), now });
      if (!row) return null;
      return {
        allowedAgentIds: parseJsonArray(row.allowed_agent_ids_json),
        expiresAt: row.expires_at,
      };
    },

    createSession({ allowedAgentIds = [], expiresAt } = {}) {
      const sessionId = randomSecret();
      insertSessionStmt.run({
        session_hash: hashSecret(sessionId),
        allowed_agent_ids_json: JSON.stringify(normalizeAgentIds(allowedAgentIds)),
        expires_at: expiresAt,
        created_at: nowIso(),
      });
      return sessionId;
    },

    getSession(sessionId, { now = nowIso() } = {}) {
      const row = getSessionStmt.get(hashSecret(String(sessionId)), now);
      if (!row) return null;
      return {
        allowedAgentIds: parseJsonArray(row.allowed_agent_ids_json),
        expiresAt: row.expires_at,
      };
    },

    deleteExpiredAccess(now = nowIso()) {
      const magicLinksDeleted = deleteMagicStmt.run(now).changes;
      const sessionsDeleted = deleteSessionsStmt.run(now).changes;
      return { magicLinksDeleted, sessionsDeleted };
    },
  };
}
