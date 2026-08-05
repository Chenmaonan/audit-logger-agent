// src/agent/outboxStore.js
import crypto from 'crypto';

const DEFAULT_MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 2000;
const DEFAULT_PRIORITY = 0;
const DAILY_REPORT_PRIORITY = 100;
const DEFAULT_CLAIM_LEASE_MS = 5 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function computeBackoff(attempts) {
  // Exponential backoff with full jitter: 2s, 4s, 8s, ... capped at ~5min.
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** attempts, 5 * 60 * 1000);
  return new Date(Date.now() + exp).toISOString();
}

function parseRows(rows) {
  return rows.map((row) => ({
    ...row,
    payload_json: JSON.parse(row.payload_json),
  }));
}

function normalizedPriority(event) {
  const fallback = event.type === 'audit_daily_trace_report'
    ? DAILY_REPORT_PRIORITY
    : DEFAULT_PRIORITY;
  const priority = Number(event.priority ?? fallback);
  if (!Number.isSafeInteger(priority)) {
    throw new Error('outbox priority must be an integer');
  }
  return priority;
}

function normalizedLimit(limit) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.trunc(parsed);
}

function normalizedDeliveryModes(deliveryModes, fieldName) {
  if (deliveryModes == null) return null;
  if (!Array.isArray(deliveryModes)) throw new Error(`outbox ${fieldName} must be an array`);
  return [...new Set(deliveryModes.filter((mode) => typeof mode === 'string' && mode.length > 0))];
}

export function createOutboxStore(db, { maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  const columns = new Set(db.prepare('PRAGMA table_info(agent_outbox_events)').all()
    .map((column) => column.name));
  const supportsDedupeKey = columns.has('dedupe_key');
  const supportsPriority = columns.has('priority');
  const supportsClaims = columns.has('claim_owner')
    && columns.has('claim_token')
    && columns.has('claim_expires_at');

  const insertColumns = [
    'event_id', 'run_id', 'type', 'payload_json', 'delivery_mode',
    'delivery_status', 'delivery_attempts', 'max_attempts', 'next_attempt_at',
    'callback_url', 'last_error', 'created_at', 'delivered_at',
  ];
  if (supportsDedupeKey) insertColumns.push('dedupe_key');
  if (supportsPriority) insertColumns.push('priority');
  if (supportsClaims) insertColumns.push('claim_owner', 'claim_token', 'claim_expires_at');
  const insertStmt = db.prepare(`
    INSERT INTO agent_outbox_events (${insertColumns.join(', ')})
    VALUES (${insertColumns.map((column) => `@${column}`).join(', ')})
  `);

  const claimableClause = supportsClaims
    ? 'AND (claim_token IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= @now)'
    : '';
  const priorityOrder = supportsPriority ? 'priority DESC, ' : '';

  function selectPending(limit = 20, now = nowIso(), deliveryModes = null, excludedDeliveryModes = null) {
    const normalized = normalizedLimit(limit);
    if (normalized === 0) return [];
    const modes = normalizedDeliveryModes(deliveryModes, 'deliveryModes');
    const excludedModes = normalizedDeliveryModes(excludedDeliveryModes, 'excludedDeliveryModes');
    if (modes?.length === 0) return [];
    const params = { limit: normalized, now };
    let deliveryModeClause = '';
    if (modes) {
      const placeholders = modes.map((mode, index) => {
        const key = `delivery_mode_${index}`;
        params[key] = mode;
        return `@${key}`;
      });
      deliveryModeClause = `AND delivery_mode IN (${placeholders.join(', ')})`;
    }
    let excludedDeliveryModeClause = '';
    if (excludedModes?.length) {
      const placeholders = excludedModes.map((mode, index) => {
        const key = `excluded_delivery_mode_${index}`;
        params[key] = mode;
        return `@${key}`;
      });
      excludedDeliveryModeClause = `AND delivery_mode NOT IN (${placeholders.join(', ')})`;
    }
    return db.prepare(`
      SELECT *
      FROM agent_outbox_events
      WHERE delivery_status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
        ${claimableClause}
        ${deliveryModeClause}
        ${excludedDeliveryModeClause}
      ORDER BY ${priorityOrder}created_at ASC, event_id ASC
      LIMIT @limit
    `).all(params);
  }

  const claimStmt = supportsClaims ? db.prepare(`
    UPDATE agent_outbox_events
    SET claim_owner = @claim_owner,
        claim_token = @claim_token,
        claim_expires_at = @claim_expires_at
    WHERE event_id = @event_id
      AND delivery_status = 'pending'
      AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
      AND (claim_token IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= @now)
  `) : null;

  const deliveredAssignments = `
    delivery_status = 'delivered',
    delivery_attempts = delivery_attempts + 1,
    delivered_at = @delivered_at,
    last_error = NULL,
    next_attempt_at = NULL
    ${supportsClaims ? ', claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL' : ''}
  `;
  const deliveredStmt = db.prepare(`
    UPDATE agent_outbox_events
    SET ${deliveredAssignments}
    WHERE event_id = @event_id
      ${supportsClaims ? 'AND claim_token IS NULL' : ''}
  `);
  const claimedDeliveredStmt = supportsClaims ? db.prepare(`
    UPDATE agent_outbox_events
    SET ${deliveredAssignments}
    WHERE event_id = @event_id AND claim_token = @claim_token
  `) : null;

  function failureStmt(requireClaimToken) {
    return db.prepare(`
      UPDATE agent_outbox_events
      SET delivery_status = @delivery_status,
          delivery_attempts = delivery_attempts + 1,
          last_error = @last_error,
          next_attempt_at = @next_attempt_at
          ${supportsClaims ? ', claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL' : ''}
      WHERE event_id = @event_id
        ${supportsClaims && !requireClaimToken ? 'AND claim_token IS NULL' : ''}
        ${requireClaimToken ? 'AND claim_token = @claim_token' : ''}
    `);
  }

  const failedStmt = failureStmt(false);
  const claimedFailedStmt = supportsClaims ? failureStmt(true) : null;
  const releaseClaimStmt = supportsClaims ? db.prepare(`
    UPDATE agent_outbox_events
    SET claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL
    WHERE event_id = @event_id AND claim_token = @claim_token
  `) : null;
  const requeueStmt = db.prepare(`
    UPDATE agent_outbox_events
    SET delivery_status = 'pending',
        delivery_attempts = delivery_attempts + 1,
        last_error = NULL,
        next_attempt_at = NULL
        ${supportsClaims ? ', claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL' : ''}
    WHERE event_id = @event_id
      ${supportsClaims ? 'AND claim_token IS NULL' : ''}
  `);

  return {
    enqueue(event) {
      const dedupeKey = event.dedupeKey ?? event.dedupe_key ?? null;
      if (dedupeKey != null && typeof dedupeKey !== 'string') {
        throw new Error('outbox dedupeKey must be a string');
      }
      if (dedupeKey != null && dedupeKey.length === 0) {
        throw new Error('outbox dedupeKey must not be empty');
      }

      if (supportsDedupeKey && dedupeKey != null) {
        const existing = db.prepare('SELECT event_id FROM agent_outbox_events WHERE dedupe_key = ?').get(dedupeKey);
        if (existing) return { eventId: existing.event_id, enqueued: false };
      }

      const eventId = `evt_${crypto.randomUUID()}`;
      const params = {
        event_id: eventId,
        run_id: event.runId,
        type: event.type,
        payload_json: JSON.stringify(event.payload),
        delivery_mode: event.deliveryMode,
        delivery_status: 'pending',
        delivery_attempts: 0,
        max_attempts: event.maxAttempts ?? maxAttempts,
        next_attempt_at: null,
        callback_url: event.callbackUrl,
        last_error: null,
        created_at: nowIso(),
        delivered_at: null,
      };
      if (supportsDedupeKey) params.dedupe_key = dedupeKey;
      if (supportsPriority) params.priority = normalizedPriority(event);
      if (supportsClaims) {
        params.claim_owner = null;
        params.claim_token = null;
        params.claim_expires_at = null;
      }

      try {
        insertStmt.run(params);
        return { eventId, enqueued: true };
      } catch (error) {
        if (supportsDedupeKey && dedupeKey != null && error?.code?.startsWith('SQLITE_CONSTRAINT')) {
          const existing = db.prepare('SELECT event_id FROM agent_outbox_events WHERE dedupe_key = ?').get(dedupeKey);
          if (existing) return { eventId: existing.event_id, enqueued: false };
        }
        throw error;
      }
    },

    listPending(limit = 20, now = nowIso()) {
      return parseRows(selectPending(limit, now));
    },

    claimPending(limit = 20, {
      ownerId = `publisher_${crypto.randomUUID()}`,
      leaseMs = DEFAULT_CLAIM_LEASE_MS,
      now = nowIso(),
      deliveryModes = null,
      excludedDeliveryModes = null,
    } = {}) {
      if (typeof ownerId !== 'string' || ownerId.length === 0) {
        throw new Error('outbox claim ownerId must be a non-empty string');
      }
      if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
        throw new Error('outbox claim leaseMs must be positive');
      }
      const nowMs = Date.parse(now);
      if (!Number.isFinite(nowMs)) throw new Error('outbox claim now must be an ISO timestamp');

      if (!supportsClaims) {
        return parseRows(selectPending(limit, now, deliveryModes, excludedDeliveryModes));
      }

      const claimExpiresAt = new Date(nowMs + leaseMs).toISOString();
      const claimBatch = db.transaction(() => {
        const rows = selectPending(limit, now, deliveryModes, excludedDeliveryModes);
        const claimed = [];
        for (const row of rows) {
          const claimToken = `claim_${crypto.randomUUID()}`;
          const result = claimStmt.run({
            event_id: row.event_id,
            claim_owner: ownerId,
            claim_token: claimToken,
            claim_expires_at: claimExpiresAt,
            now,
          });
          if (result.changes === 1) {
            claimed.push({
              ...row,
              claim_owner: ownerId,
              claim_token: claimToken,
              claim_expires_at: claimExpiresAt,
            });
          }
        }
        return claimed;
      });
      return parseRows(claimBatch.immediate());
    },

    listAll(limit = 100) {
      return parseRows(db.prepare(`
        SELECT * FROM agent_outbox_events
        ORDER BY created_at DESC, event_id DESC
        LIMIT @limit
      `).all({ limit }));
    },

    markDelivered(eventId, claimToken) {
      const deliveredAt = nowIso();
      if (supportsClaims && claimToken != null) {
        return claimedDeliveredStmt.run({
          event_id: eventId,
          claim_token: claimToken,
          delivered_at: deliveredAt,
        }).changes === 1;
      }
      return deliveredStmt.run({ event_id: eventId, delivered_at: deliveredAt }).changes === 1;
    },

    markFailed(eventId, error, claimToken) {
      const requireClaimToken = supportsClaims && claimToken != null;
      const markFailure = db.transaction(() => {
        const row = db.prepare(`
          SELECT delivery_attempts, max_attempts
          FROM agent_outbox_events
          WHERE event_id = @event_id
            ${supportsClaims && !requireClaimToken ? 'AND claim_token IS NULL' : ''}
            ${requireClaimToken ? 'AND claim_token = @claim_token' : ''}
        `).get({ event_id: eventId, ...(requireClaimToken ? { claim_token: claimToken } : {}) });
        if (!row) return false;
        const attempts = row.delivery_attempts + 1;
        const exhausted = attempts >= (row.max_attempts ?? maxAttempts);
        const result = (requireClaimToken ? claimedFailedStmt : failedStmt).run({
          event_id: eventId,
          ...(requireClaimToken ? { claim_token: claimToken } : {}),
          delivery_status: exhausted ? 'dead_letter' : 'pending',
          last_error: error.message,
          next_attempt_at: exhausted ? null : computeBackoff(attempts),
        });
        return result.changes === 1;
      });
      return markFailure.immediate();
    },

    releaseClaim(eventId, claimToken) {
      if (!supportsClaims || claimToken == null) return false;
      return releaseClaimStmt.run({ event_id: eventId, claim_token: claimToken }).changes === 1;
    },

    requeue(eventId) {
      requeueStmt.run({ event_id: eventId });
    },
  };
}

export {
  DAILY_REPORT_PRIORITY,
  DEFAULT_CLAIM_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
};
