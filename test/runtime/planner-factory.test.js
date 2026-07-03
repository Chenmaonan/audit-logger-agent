import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanner } from '../../src/agent/planner.js';
import { createToolRegistry } from '../../src/tools/registry.js';

test('planner factory creates the OpenAI planner path', async () => {
  const registry = createToolRegistry();
  registry.register({
    name: 'audit.queryEvents',
    description: 'Query audit events',
    inputSchema: { type: 'object' },
    async execute() {
      return [];
    },
  });

  let callCount = 0;
  const planner = createPlanner({
    model: 'test-model',
    registry,
    llmClient: {
      async createStructuredResponse() {
        callCount += 1;
        return {
          type: 'plan',
          plan: {
            steps: [
              {
                stepName: 'load-errors',
                toolName: 'audit.queryEvents',
                input: { status: 'error' },
              },
            ],
          },
          decision: null,
        };
      },
    },
  });

  const result = await planner.createInitialPlan({
    requestText: 'Create a plan to query audit errors.',
    metadata: {},
  });

  assert.equal(result.type, 'plan');
  assert.equal(result.plan.steps[0].toolName, 'audit.queryEvents');
  assert.equal(callCount, 1);
});
