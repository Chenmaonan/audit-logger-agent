import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOpenAIConfig } from '../../src/llm/openaiConfig.js';
import { createOpenAIResponsesClient } from '../../src/llm/openaiResponsesClient.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { createOpenAIPlanner } from '../../src/agent/openaiPlanner.js';

function registryWithTools() {
  const registry = createToolRegistry();
  registry.register({ name: 'audit.queryEvents', description: 'Query audit events', inputSchema: { type: 'object' }, async execute() { return []; } });
  registry.register({ name: 'report.errorSummary', description: 'Summarize errors', inputSchema: { type: 'object' }, async execute() { return []; } });
  return registry;
}

test('OpenAI planner converts natural language into a validated local tool plan', async () => {
  assert.ok(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY is required for this integration test');
  assert.ok(process.env.OPENAI_MODEL, 'OPENAI_MODEL is required for this integration test');

  const config = loadOpenAIConfig({ env: process.env, appConfig: {} });
  const planner = createOpenAIPlanner({
    llmClient: createOpenAIResponsesClient(config),
    model: config.model,
    registry: registryWithTools(),
    now: () => '2026-07-02T09:00:00.000+08:00',
  });

  const result = await planner.createInitialPlan({
    requestText: 'Analyze all audit error events for today. Do not ask for clarification.',
    metadata: { tenant_key: 'tenant_test' },
  });

  assert.equal(result.type, 'plan');
  assert.ok(result.plan.steps.length >= 1);
  for (const step of result.plan.steps) {
    assert.ok(registryWithTools().has(step.toolName), `unexpected tool: ${step.toolName}`);
  }
});

test('OpenAI planner synthesizes a structured final result', async () => {
  assert.ok(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY is required for this integration test');
  assert.ok(process.env.OPENAI_MODEL, 'OPENAI_MODEL is required for this integration test');

  const config = loadOpenAIConfig({ env: process.env, appConfig: {} });
  const planner = createOpenAIPlanner({
    llmClient: createOpenAIResponsesClient(config),
    model: config.model,
    registry: registryWithTools(),
  });

  const result = await planner.synthesizeFinalResult({
    runId: 'run_openai_test',
    toolResults: [
      { stepName: 'load-errors', result: [{ tool_name: 'demo.tool', result_summary: 'demo failed' }] },
    ],
  });

  assert.equal(result.type, 'final_result');
  assert.equal(result.status, 'completed');
  assert.ok(result.summary.length > 0);
});
