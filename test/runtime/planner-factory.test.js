import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOpenAIConfig } from '../../src/llm/openaiConfig.js';
import { createOpenAIResponsesClient } from '../../src/llm/openaiResponsesClient.js';
import { createPlanner } from '../../src/agent/planner.js';
import { createToolRegistry } from '../../src/tools/registry.js';

test('planner factory creates the OpenAI planner path', {
  skip: !process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL,
}, async () => {
  const config = loadOpenAIConfig({ env: process.env, appConfig: {} });
  const registry = createToolRegistry();
  registry.register({ name: 'audit.queryEvents', description: 'Query audit events', inputSchema: { type: 'object' }, async execute() { return []; } });

  const planner = createPlanner({
    model: config.model,
    registry,
    llmClient: createOpenAIResponsesClient(config),
  });

  const result = await planner.createInitialPlan({
    requestText: 'Create a plan to query audit errors. Use only available tools.',
    metadata: {},
  });
  assert.ok(['plan', 'decision_request'].includes(result.type));
});
