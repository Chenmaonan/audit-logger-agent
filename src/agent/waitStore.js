// src/agent/waitStore.js
import crypto from 'crypto';

function nowIso() {
  return new Date().toISOString();
}

export function createWaitStore(db) {
  const insertStmt = db.prepare(`
    INSERT INTO agent_waiting_states (
      decision_id, run_id, schema_json, context_json,
      requested_by_step, status, created_at, resolved_at
    ) VALUES (
      @decision_id, @run_id, @schema_json, @context_json,
      @requested_by_step, @status, @created_at, @resolved_at
    )
  `);

  const getStmt = db.prepare(`SELECT * FROM agent_waiting_states WHERE decision_id = ?`);
  const resolveStmt = db.prepare(`
    UPDATE agent_waiting_states
    SET status = 'resolved', resolved_at = @resolved_at
    WHERE decision_id = @decision_id
  `);

  const listPendingByRunStmt = db.prepare(`
    SELECT * FROM agent_waiting_states
    WHERE run_id = ? AND status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1
  `);

  return {
    createWaitingState(input) {
      const decisionId = input.decisionId ?? `dec_${crypto.randomUUID()}`;
      insertStmt.run({
        decision_id: decisionId,
        run_id: input.runId,
        schema_json: JSON.stringify(input.schemaJson),
        context_json: JSON.stringify(input.contextJson),
        requested_by_step: input.requestedByStep,
        status: 'pending',
        created_at: nowIso(),
        resolved_at: null,
      });
      return decisionId;
    },

    getWaitingState(decisionId) {
      const row = getStmt.get(decisionId);
      if (!row) return null;
      return {
        ...row,
        schema_json: JSON.parse(row.schema_json),
        context_json: JSON.parse(row.context_json),
      };
    },

    resolveWaitingState(decisionId) {
      resolveStmt.run({ decision_id: decisionId, resolved_at: nowIso() });
    },

    findPendingForRun(runId) {
      const row = listPendingByRunStmt.get(runId);
      if (!row) return null;
      return {
        ...row,
        schema_json: JSON.parse(row.schema_json),
        context_json: JSON.parse(row.context_json),
      };
    },
  };
}