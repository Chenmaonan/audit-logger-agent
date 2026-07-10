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
import { createRuntime } from '../../src/agent/runtime.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { createPlanner } from '../../src/agent/planner.js';
import { loadOpenAIConfig } from '../../src/llm/openaiConfig.js';
import { createOpenAIResponsesClient } from '../../src/llm/openaiResponsesClient.js';

async function waitForTerminal(runStore, runId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = runStore.getRun(runId);
    if (run && ['completed', 'failed', 'waiting_user'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return runStore.getRun(runId);
}

test('runtime executes an OpenAI-planned audit task through the real Responses API', async (t) => {
  let config;
  try {
    config = loadOpenAIConfig({ env: process.env, appConfig: {} });
  } catch {
    t.skip('AUDIT_AGENT_LLM_API_KEY / AUDIT_AGENT_LLM_MODEL not set in .config or environment');
    return;
  }
  assert.ok(config.apiKey, 'AUDIT_AGENT_LLM_API_KEY is required for this integration test');
  assert.ok(config.model, 'AUDIT_AGENT_LLM_MODEL is required for this integration test');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-runtime-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);

  const runStore = createRunStore(db);
  const outboxStore = createOutboxStore(db);
  const waitStore = createWaitStore(db);
  const eventPublisher = createEventPublisher({ outboxStore, callbackClient: { async send() {} } });

  const registry = createToolRegistry();
  registry.register({ name: 'audit.queryEvents', description: 'Query audit events', inputSchema: { type: 'object' }, async execute() { return [{ tool_name: 'demo.tool', result_summary: 'demo failed' }]; } });
  registry.register({ name: 'report.errorSummary', description: 'Summarize errors', inputSchema: { type: 'object' }, async execute() { return [{ tool_name: 'demo.tool', result_summary: 'demo failed' }]; } });

  const runtime = createRuntime({
    runStore,
    outboxStore,
    waitStore,
    planner: createPlanner({
      model: config.model,
      registry,
      llmClient: createOpenAIResponsesClient(config),
    }),
    registry,
    eventPublisher,
    auditLogger: { async log() {} },
  });

  const created = await runtime.startRun({
    sourceType: 'manual',
    sessionId: 'session_test',
    messageId: 'om_openai',
    requesterId: 'user_test',
    requestText: 'Analyze all audit error events for today (2026-07-02) and summarize them. Do not ask for clarification — execute directly.',
    deliveryMode: 'callback',
    deliveryTargetUrl: 'http://127.0.0.1:9999/agent-events',
    metadata: {},
  });

  let terminal = await waitForTerminal(runStore, created.run_id);

  // If the planner judged the scope ambiguous and paused for a decision,
  // resume with the first option so the run reaches a terminal completed/failed state.
  if (terminal.status === 'waiting_user') {
    const decisionEvent = outboxStore.listAll(20).find((event) => event.type === 'decision_request');
    const options = decisionEvent?.payload_json?.decision?.options ?? [];
    const firstOption = options[0];
    if (!firstOption) throw new Error('waiting_user but no decision options offered');
    const waiting = waitStore.findPendingForRun(created.run_id);
    await runtime.resumeRun(created.run_id, {
      decision_id: waiting.decision_id,
      user: { open_id: 'ou_test' },
      response: { selected_option: firstOption.id, form_data: {} },
    });
    terminal = await waitForTerminal(runStore, created.run_id);
  }

  assert.equal(terminal.status, 'completed');
  assert.ok(runStore.listSteps(created.run_id).length >= 1);
  assert.ok(outboxStore.listAll(20).find((event) => event.type === 'final_result'));

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
