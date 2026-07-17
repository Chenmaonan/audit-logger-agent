// src/agent/outboxStore.js
import crypto from 'crypto';

const DEFAULT_MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 2000;

function nowIso() {
  return new Date().toISOString();
}

function computeBackoff(attempts) {
  // Exponential backoff with full jitter: 2s, 4s, 8s, ... capped at ~5min.
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** attempts, 5 * 60 * 1000);
  return new Date(Date.now() + exp).toISOString();
}

export function createOutboxStore(db, { maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  const supportsDedupeKey = db.prepare('PRAGMA table_info(agent_outbox_events)').all()
    .some((column) => column.name === 'dedupe_key');
  const insertStmt = db.prepare(supportsDedupeKey ? `
    INSERT INTO agent_outbox_events (
      event_id, run_id, type, payload_json, delivery_mode,
      delivery_status, delivery_attempts, max_attempts, next_attempt_at,
      callback_url, dedupe_key, last_error, created_at, delivered_at
    ) VALUES (
      @event_id, @run_id, @type, @payload_json, @delivery_mode,
      @delivery_status, @delivery_attempts, @max_attempts, @next_attempt_at,
      @callback_url, @dedupe_key, @last_error, @created_at, @delivered_at
    )
  ` : `
    INSERT INTO agent_outbox_events (
      event_id, run_id, type, payload_json, delivery_mode,
      delivery_status, delivery_attempts, max_attempts, next_attempt_at,
      callback_url, last_error, created_at, delivered_at
    ) VALUES (
      @event_id, @run_id, @type, @payload_json, @delivery_mode,
      @delivery_status, @delivery_attempts, @max_attempts, @next_attempt_at,
      @callback_url, @last_error, @created_at, @delivered_at
    )
  `);

  const listStmt = db.prepare(`
    SELECT *
    FROM agent_outbox_events
    WHERE delivery_status = 'pending'
      AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
    ORDER BY created_at ASC
    LIMIT @limit
  `);

  const deliveredStmt = db.prepare(`
    UPDATE agent_outbox_events
    SET delivery_status = 'delivered',
        delivery_attempts = delivery_attempts + 1,
        delivered_at = @delivered_at,
        last_error = NULL,
        next_attempt_at = NULL
    WHERE event_id = @event_id
  `);

  const failedStmt = db.prepare(`
    UPDATE agent_outbox_events
    SET delivery_status = @delivery_status,
        delivery_attempts = delivery_attempts + 1,
        last_error = @last_error,
        next_attempt_at = @next_attempt_at
    WHERE event_id = @event_id
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
        ...(supportsDedupeKey ? { dedupe_key: dedupeKey } : {}),
        last_error: null,
        created_at: nowIso(),
        delivered_at: null,
      };

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
      return listStmt.all({ limit, now }).map((row) => ({
        ...row,
        payload_json: JSON.parse(row.payload_json),
      }));
    },

    listAll(limit = 100) {
      return db.prepare(`SELECT * FROM agent_outbox_events ORDER BY created_at DESC LIMIT @limit`).all({ limit })
        .map((row) => ({ ...row, payload_json: JSON.parse(row.payload_json) }));
    },

    markDelivered(eventId) {
      deliveredStmt.run({ event_id: eventId, delivered_at: nowIso() });
    },

    markFailed(eventId, error) {
      const row = db.prepare(`SELECT delivery_attempts, max_attempts FROM agent_outbox_events WHERE event_id = ?`).get(eventId);
      if (!row) return;
      const attempts = row.delivery_attempts + 1;
      const exhausted = attempts >= (row.max_attempts ?? maxAttempts);
      failedStmt.run({
        event_id: eventId,
        delivery_status: exhausted ? 'dead_letter' : 'pending',
        last_error: error.message,
        next_attempt_at: exhausted ? null : computeBackoff(attempts),
      });
    },

    requeue(eventId) {
      failedStmt.run({
        event_id: eventId,
        delivery_status: 'pending',
        last_error: null,
        next_attempt_at: null,
      });
    },
  };
}

export { DEFAULT_MAX_ATTEMPTS };
