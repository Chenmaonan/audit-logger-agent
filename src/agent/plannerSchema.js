export function plannerDecisionJsonSchema() {
  return {
    type: 'json_schema',
    name: 'audit_agent_planner_decision',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { enum: ['plan', 'decision_request'] },
        plan: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: {
            steps: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  stepName: { type: 'string', minLength: 1 },
                  toolName: { type: 'string', minLength: 1 },
                  input: { type: 'object' },
                },
                required: ['stepName', 'toolName', 'input'],
              },
            },
          },
          required: ['steps'],
        },
        decision: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['id', 'label', 'description'],
              },
            },
            formSchema: { type: 'array', items: { type: 'object' } },
            submitLabel: { type: 'string' },
          },
          required: ['title', 'summary', 'options', 'formSchema', 'submitLabel'],
        },
      },
      required: ['type', 'plan', 'decision'],
    },
  };
}

function invalid(message) {
  return { ok: false, error: Object.assign(new Error(message), { code: 'invalid_planner_decision', retryable: false }) };
}

export function validatePlannerDecision(value, { registry }) {
  if (!value || typeof value !== 'object') return invalid('Planner decision must be an object');
  if (!['plan', 'decision_request'].includes(value.type)) return invalid(`Invalid planner decision type: ${String(value.type)}`);

  if (value.type === 'plan') {
    if (!value.plan || !Array.isArray(value.plan.steps)) return invalid('Planner plan.steps must be an array');
    for (const step of value.plan.steps) {
      if (!step || typeof step !== 'object') return invalid('Planner step must be an object');
      if (typeof step.stepName !== 'string' || step.stepName.trim() === '') return invalid('Planner stepName is required');
      if (typeof step.toolName !== 'string' || step.toolName.trim() === '') return invalid('Planner toolName is required');
      if (!registry.has(step.toolName)) return invalid(`Unknown planner tool: ${step.toolName}`);
      if (!step.input || typeof step.input !== 'object' || Array.isArray(step.input)) return invalid(`Planner input for ${step.toolName} must be an object`);
    }
    return { ok: true, decision: value };
  }

  if (!value.decision || !Array.isArray(value.decision.options)) return invalid('decision_request requires decision.options');
  const optionIds = new Set();
  for (const option of value.decision.options) {
    if (!option.id || optionIds.has(option.id)) return invalid('decision_request option ids must be non-empty and unique');
    optionIds.add(option.id);
  }
  return { ok: true, decision: value };
}
