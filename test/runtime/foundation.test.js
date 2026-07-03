import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../scripts/lib/db.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { canTransition, assertTransition } from '../../src/agent/stateMachine.js';
import { createRunStore } from '../../src/agent/runStore.js';

test('runtime schema creates all agent tables', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-foundation-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);

  const rows = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'agent_runs',
      'agent_run_steps',
      'agent_waiting_states',
      'agent_outbox_events'
    )
    ORDER BY name
  `).all();

  assert.deepEqual(rows.map((row) => row.name), [
    'agent_outbox_events',
    'agent_run_steps',
    'agent_runs',
    'agent_waiting_states',
  ]);

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('state machine only allows supported transitions', () => {
  assert.equal(canTransition('created', 'planning'), true);
  assert.equal(canTransition('planning', 'running'), true);
  assert.equal(canTransition('running', 'waiting_user'), true);
  assert.equal(canTransition('waiting_user', 'running'), true);
  assert.equal(canTransition('running', 'completed'), true);
  assert.equal(canTransition('completed', 'running'), false);
  assert.throws(() => assertTransition('completed', 'running'));
});

test('run store creates and transitions runs', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-store-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const runStore = createRunStore(db);

  const created = runStore.createRun({
    sourceType: 'manual',
    sessionId: 'session_test',
    messageId: 'om_test',
    requesterId: 'user_test',
    requestText: '帮我处理异常任务',
    deliveryMode: 'callback',
    deliveryTargetUrl: 'http://127.0.0.1:9999/agent-events',
    metadata: { tenant_key: 'tenant_test' },
  });

  assert.equal(created.status, 'created');
  assert.equal(created.channel, 'manual');
  assert.equal(created.user_open_id, 'user_test');

  const planned = runStore.transitionRun(created.run_id, 'planning');
  assert.equal(planned.status, 'planning');

  runStore.appendStep({
    runId: created.run_id,
    stepIndex: 0,
    stepName: 'interpret-request',
    status: 'completed',
    toolName: null,
    inputJson: { text: '帮我处理异常任务' },
    outputJson: { intent: 'handle-exceptions' },
  });

  const steps = runStore.listSteps(created.run_id);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].step_name, 'interpret-request');

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});