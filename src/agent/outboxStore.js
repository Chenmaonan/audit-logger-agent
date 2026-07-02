// src/agent/outboxStore.js
import crypto from 'crypto';

function nowIso() {
  return new Date().toISOString();
}

export function createOutboxStore(db) {
  const insertStmt = db.prepare(`
    INSERT INTO agent_outbox_events (
      event_id, run_id, type, payload_json, delivery_mode,
      delivery_status, delivery_attempts, callback_url,
      last_error, created_at, delivered_at
    ) VALUES (
      @event_id, @run_id, @type, @payload_json, @delivery_mode,
      @delivery_status, @delivery_attempts, @callback_url,
      @last_error, @created_at, @delivered_at
    )
  `);

  const listStmt = db.prepare(`
    SELECT *
    FROM agent_outbox_events
    WHERE delivery_status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `);

  const deliveredStmt = db.prepare(`
    UPDATE agent_outbox_events
    SET delivery_status = 'delivered',
        delivery_attempts = delivery_attempts + 1,
        delivered_at = @delivered_at,
        last_error = NULL
    WHERE event_id = @event_id
  `);

  const failedStmt = db.prepare(`
    UPDATE agent_outbox_events
    SET delivery_status = 'pending',
        delivery_attempts = delivery_attempts + 1,
        last_error = @last_error
    WHERE event_id = @event_id
  `);

  return {
    enqueue(event) {
      insertStmt.run({
        event_id: `evt_${crypto.randomUUID()}`,
        run_id: event.runId,
        type: event.type,
        payload_json: JSON.stringify(event.payload),
        delivery_mode: event.deliveryMode,
        delivery_status: 'pending',
        delivery_attempts: 0,
        callback_url: event.callbackUrl,
        last_error: null,
        created_at: nowIso(),
        delivered_at: null,
      });
    },

    listPending(limit = 20) {
      return listStmt.all(limit).map((row) => ({
        ...row,
        payload_json: JSON.parse(row.payload_json),
      }));
    },

    markDelivered(eventId) {
      deliveredStmt.run({ event_id: eventId, delivered_at: nowIso() });
    },

    markFailed(eventId, error) {
      failedStmt.run({ event_id: eventId, last_error: error.message });
    },
  };
}