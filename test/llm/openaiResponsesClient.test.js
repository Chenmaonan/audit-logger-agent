import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOpenAIConfig } from '../../src/llm/openaiConfig.js';
import { createOpenAIResponsesClient } from '../../src/llm/openaiResponsesClient.js';

test('OpenAI responses client calls the real Responses API with structured output', async (t) => {
  let config;
  try {
    config = loadOpenAIConfig({ env: process.env, appConfig: {} });
  } catch {
    t.skip('AUDIT_AGENT_LLM_API_KEY / AUDIT_AGENT_LLM_MODEL not set in .config or environment');
    return;
  }
  assert.ok(config.apiKey, 'AUDIT_AGENT_LLM_API_KEY is required for this integration test');
  assert.ok(config.model, 'AUDIT_AGENT_LLM_MODEL is required for this integration test');

  const client = createOpenAIResponsesClient(config);

  const result = await client.createStructuredResponse({
    model: config.model,
    input: [
      { role: 'system', content: 'Return the exact structured object requested by the schema.' },
      { role: 'user', content: 'Return {"type":"plan","plan":{"steps":[]},"decision":null}.' },
    ],
    schema: {
      type: 'json_schema',
      name: 'audit_agent_planner_decision',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { enum: ['plan'] },
          plan: {
            type: 'object',
            additionalProperties: false,
            properties: { steps: { type: 'array', items: { type: 'object' } } },
            required: ['steps'],
          },
          decision: { type: ['object', 'null'] },
        },
        required: ['type', 'plan', 'decision'],
      },
    },
  });

  assert.equal(result.type, 'plan');
  assert.deepEqual(result.plan.steps, []);
  assert.equal(result.decision, null);
});
