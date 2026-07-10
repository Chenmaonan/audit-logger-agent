import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIPlanner } from '../../src/agent/openaiPlanner.js';
import { createToolRegistry } from '../../src/tools/registry.js';

function createRegistry() {
  const registry = createToolRegistry();
  registry.register({
    name: 'audit.queryEvents',
    description: 'Query audit events',
    inputSchema: { type: 'object' },
    async execute() {
      return [];
    },
  });
  registry.register({
    name: 'report.errorSummary',
    description: 'Summarize errors',
    inputSchema: { type: 'object' },
    async execute() {
      return [];
    },
  });
  return registry;
}

test('createInitialPlan retries once when the first structured response is invalid', async () => {
  let callCount = 0;
  const planner = createOpenAIPlanner({
    llmClient: {
      async createStructuredResponse() {
        callCount += 1;
        if (callCount === 1) {
          return {
            type: 'decision_request',
            plan: null,
            decision: {
              title: 'Need clarification',
              summary: 'Choose a scope',
              options: [
                { id: '', label: 'Today only', description: 'Only today' },
              ],
              formSchema: [],
              submitLabel: 'Continue',
            },
          };
        }

        return {
          type: 'plan',
          plan: {
            steps: [
              {
                stepName: 'load-errors',
                toolName: 'audit.queryEvents',
                input: { status: 'INTERNAL' },
              },
            ],
          },
          decision: null,
        };
      },
    },
    model: 'test-model',
    registry: createRegistry(),
  });

  const result = await planner.createInitialPlan({
    requestText: 'Analyze audit errors',
    metadata: {},
  });

  assert.equal(result.type, 'plan');
  assert.equal(result.plan.steps[0].toolName, 'audit.queryEvents');
  assert.equal(callCount, 2);
});

test('resumeFromDecision retries once until it gets a plan', async () => {
  let callCount = 0;
  const planner = createOpenAIPlanner({
    llmClient: {
      async createStructuredResponse() {
        callCount += 1;
        if (callCount === 1) {
          return {
            type: 'decision_request',
            plan: null,
            decision: {
              title: 'Still ambiguous',
              summary: 'Need one more choice',
              options: [
                { id: 'today_only', label: 'Today only', description: 'Only today' },
              ],
              formSchema: [],
              submitLabel: 'Continue',
            },
          };
        }

        return {
          type: 'plan',
          plan: {
            steps: [
              {
                stepName: 'summarize-errors',
                toolName: 'report.errorSummary',
                input: { from: '2026-07-02T00:00:00.000+08:00' },
              },
            ],
          },
          decision: null,
        };
      },
    },
    model: 'test-model',
    registry: createRegistry(),
  });

  const result = await planner.resumeFromDecision(
    { requestText: 'Analyze audit errors', metadata: {} },
    { selected_option: 'today_only', form_data: {} },
  );

  assert.equal(result.type, 'plan');
  assert.equal(result.plan.steps[0].toolName, 'report.errorSummary');
  assert.equal(callCount, 2);
});
