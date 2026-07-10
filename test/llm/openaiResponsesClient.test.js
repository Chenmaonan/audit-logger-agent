import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIResponsesClient } from '../../src/llm/openaiResponsesClient.js';

test('OpenAI responses client limits concurrent structured requests', async () => {
  let active = 0;
  let maxActive = 0;
  let releaseFirst;
  const firstStarted = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const fakeResponsesClient = {
    responses: {
      async create() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (active === 1) await firstStarted;
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { output_text: '{"ok":true}' };
      },
    },
  };

  const client = createOpenAIResponsesClient({
    apiKey: 'sk-test',
    model: 'test-model',
    maxConcurrency: 2,
    openaiClient: fakeResponsesClient,
  });
  const requests = [1, 2, 3, 4].map(() => client.createStructuredResponse({
    model: 'test-model',
    input: [],
    schema: { type: 'json_schema', name: 'test', strict: true, schema: { type: 'object' } },
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(maxActive, 2);
  releaseFirst();
  const results = await Promise.all(requests);

  assert.ok(results.every((result) => result.ok === true));
  assert.equal(maxActive, 2);
});
