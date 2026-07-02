import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../scripts/lib/db.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { createRunStore } from '../../src/agent/runStore.js';
import { createOutboxStore } from '../../src/agent/outboxStore.js';
import { createWaitStore } from '../../src/agent/waitStore.js';
import { createEventPublisher } from '../../src/agent/eventPublisher.js';
import { createPlanner } from '../../src/agent/planner.js';
import { createRuntime } from '../../src/agent/runtime.js';
import { createToolRegistry } from '../../src/tools/registry.js';

test('runtime pauses for user decision and resumes to final result', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);

  const runStore = createRunStore(db);
  const outboxStore = createOutboxStore(db);
  const waitStore = createWaitStore(db);
  const eventPublisher = createEventPublisher({
    outboxStore,
    callbackClient: { async send() {} },
  });

  const registry = createToolRegistry();
  registry.register({
    name: 'audit.queryEvents',
    async execute() {
      return [{ tool_name: 'demo.tool', result_summary: 'demo failed' }];
    },
  });
  registry.register({
    name: 'report.errorSummary',
    async execute() {
      return [{ tool_name: 'demo.tool', result_summary: 'demo failed' }];
    },
  });

  const runtime = createRuntime({
    runStore,
    outboxStore,
    waitStore,
    planner: createPlanner({ now: () => '2026-07-02T09:00:00.000+08:00' }),
    registry,
    eventPublisher,
    auditLogger: { async log() {} },
  });

  const created = await runtime.startRun({
    channel: 'feishu',
    conversationId: 'oc_test',
    messageId: 'om_test',
    userOpenId: 'ou_test',
    requestText: '帮我处理异常任务',
    deliveryMode: 'callback',
    callbackUrl: 'http://127.0.0.1:9999/agent-events',
    metadata: {},
  });

  const waitingRun = runtime.getRun(created.run_id);
  assert.equal(waitingRun.status, 'waiting_user');

  const decisionEvent = outboxStore.listPending(10).find((event) => event.type === 'decision_request');
  assert.ok(decisionEvent);

  await runtime.resumeRun(created.run_id, {
    decision_id: decisionEvent.payload_json.decision_id,
    user: { open_id: 'ou_test' },
    response: { selected_option: 'today_only', form_data: {} },
  });

  const completedRun = runtime.getRun(created.run_id);
  assert.equal(completedRun.status, 'completed');

  const finalEvent = outboxStore.listPending(10).find((event) => event.type === 'final_result');
  assert.ok(finalEvent);

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});