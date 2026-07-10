import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../../src/tools/registry.js';
import { plannerDecisionJsonSchema, validatePlannerDecision } from '../../src/agent/plannerSchema.js';

test('planner schema accepts a valid plan using registered tools', () => {
  const registry = createToolRegistry();
  registry.register({ name: 'audit.queryEvents', description: 'Query audit events', inputSchema: { type: 'object' }, async execute() { return []; } });

  const value = {
    type: 'plan',
    plan: {
      steps: [
        { stepName: 'load-errors', toolName: 'audit.queryEvents', input: { status: 'INTERNAL', limit: 100 } },
      ],
    },
  };

  const result = validatePlannerDecision(value, { registry });
  assert.equal(result.ok, true);
  assert.deepEqual(result.decision, value);
});

test('planner schema rejects unknown tools', () => {
  const registry = createToolRegistry();
  const result = validatePlannerDecision({
    type: 'plan',
    plan: {
      steps: [
        { stepName: 'bad-step', toolName: 'unknown.tool', input: {} },
      ],
    },
  }, { registry });

  assert.equal(result.ok, false);
  assert.match(result.error.message, /Unknown planner tool/);
});

test('planner schema exposes JSON schema for OpenAI structured output', () => {
  const schema = plannerDecisionJsonSchema();
  assert.equal(schema.type, 'json_schema');
  assert.equal(schema.name, 'audit_agent_planner_decision');
  assert.equal(schema.strict, true);
  assert.equal(schema.schema.type, 'object');
});
