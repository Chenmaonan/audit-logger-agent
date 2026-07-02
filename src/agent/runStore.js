// src/agent/runStore.js
import crypto from 'crypto';
import { assertTransition } from './stateMachine.js';

function nowIso() {
  return new Date().toISOString();
}

function parseJsonField(value) {
  return value ? JSON.parse(value) : null;
}

function hydrateRun(row) {
  if (!row) return null;
  return {
    ...row,
    metadata_json: parseJsonField(row.metadata_json),
    plan_json: parseJsonField(row.plan_json),
    result_json: parseJsonField(row.result_json),
  };
}

export function createRunStore(db) {
  const insertRunStmt = db.prepare(`
    INSERT INTO agent_runs (
      run_id, channel, conversation_id, message_id, user_open_id, status,
      request_text, delivery_mode, delivery_callback_url, metadata_json,
      plan_json, current_step_index, result_json, error_code, error_message,
      idempotency_key, created_at, updated_at
    ) VALUES (
      @run_id, @channel, @conversation_id, @message_id, @user_open_id, @status,
      @request_text, @delivery_mode, @delivery_callback_url, @metadata_json,
      @plan_json, @current_step_index, @result_json, @error_code, @error_message,
      @idempotency_key, @created_at, @updated_at
    )
  `);

  const getRunStmt = db.prepare(`SELECT * FROM agent_runs WHERE run_id = ?`);
  const findByMessageStmt = db.prepare(`
    SELECT * FROM agent_runs
    WHERE channel = @channel AND message_id = @message_id AND message_id IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `);
  const findByIdempotencyStmt = db.prepare(`
    SELECT * FROM agent_runs WHERE idempotency_key = ? AND idempotency_key IS NOT NULL LIMIT 1
  `);
  const updateRunStmt = db.prepare(`
    UPDATE agent_runs
    SET status = @status,
        plan_json = @plan_json,
        current_step_index = @current_step_index,
        result_json = @result_json,
        error_code = @error_code,
        error_message = @error_message,
        updated_at = @updated_at
    WHERE run_id = @run_id
  `);

  const insertStepStmt = db.prepare(`
    INSERT INTO agent_run_steps (
      run_id, step_index, step_name, status, tool_name,
      input_json, output_json, started_at, finished_at
    ) VALUES (
      @run_id, @step_index, @step_name, @status, @tool_name,
      @input_json, @output_json, @started_at, @finished_at
    )
  `);

  const listStepsStmt = db.prepare(`
    SELECT *
    FROM agent_run_steps
    WHERE run_id = ?
    ORDER BY step_index ASC, id ASC
  `);

  return {
    createRun(input) {
      // P2-05: idempotency. Prefer an explicit idempotency key, then fall back
      // to (channel, message_id). A duplicate request returns the existing run
      // rather than creating a new one.
      if (input.idempotencyKey) {
        const existing = findByIdempotencyStmt.get(input.idempotencyKey);
        if (existing) return hydrateRun(existing);
      }
      if (input.channel && input.messageId) {
        const existing = findByMessageStmt.get({ channel: input.channel, message_id: input.messageId });
        if (existing) return hydrateRun(existing);
      }

      const timestamp = nowIso();
      const runId = `run_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
      insertRunStmt.run({
        run_id: runId,
        channel: input.channel,
        conversation_id: input.conversationId,
        message_id: input.messageId,
        user_open_id: input.userOpenId,
        status: 'created',
        request_text: input.requestText,
        delivery_mode: input.deliveryMode,
        delivery_callback_url: input.callbackUrl,
        metadata_json: JSON.stringify(input.metadata ?? {}),
        plan_json: null,
        current_step_index: 0,
        result_json: null,
        error_code: null,
        error_message: null,
        idempotency_key: input.idempotencyKey ?? null,
        created_at: timestamp,
        updated_at: timestamp,
      });
      return hydrateRun(getRunStmt.get(runId));
    },

    getRun(runId) {
      return hydrateRun(getRunStmt.get(runId));
    },

    updateRun(runId, patch) {
      const current = this.getRun(runId);
      if (!current) throw new Error(`Run not found: ${runId}`);
      updateRunStmt.run({
        run_id: runId,
        status: patch.status ?? current.status,
        plan_json: JSON.stringify(patch.plan ?? current.plan_json),
        current_step_index: patch.currentStepIndex ?? current.current_step_index,
        result_json: JSON.stringify(patch.result ?? current.result_json),
        error_code: patch.errorCode ?? current.error_code,
        error_message: patch.errorMessage ?? current.error_message,
        updated_at: nowIso(),
      });
      return this.getRun(runId);
    },

    transitionRun(runId, nextStatus, patch = {}) {
      const current = this.getRun(runId);
      if (!current) throw new Error(`Run not found: ${runId}`);
      assertTransition(current.status, nextStatus);
      return this.updateRun(runId, { ...patch, status: nextStatus });
    },

    appendStep(step) {
      const timestamp = nowIso();
      insertStepStmt.run({
        run_id: step.runId,
        step_index: step.stepIndex,
        step_name: step.stepName,
        status: step.status,
        tool_name: step.toolName,
        input_json: JSON.stringify(step.inputJson ?? null),
        output_json: JSON.stringify(step.outputJson ?? null),
        started_at: step.startedAt ?? timestamp,
        finished_at: step.finishedAt ?? timestamp,
      });
    },

    listSteps(runId) {
      return listStepsStmt.all(runId).map((row) => ({
        ...row,
        input_json: parseJsonField(row.input_json),
        output_json: parseJsonField(row.output_json),
      }));
    },

    listNonTerminalRuns() {
      return db.prepare(`
        SELECT * FROM agent_runs
        WHERE status IN ('created', 'planning', 'running')
        ORDER BY created_at ASC
      `).all().map(hydrateRun);
    },
  };
}