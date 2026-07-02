import { plannerDecisionJsonSchema, validatePlannerDecision } from './plannerSchema.js';
import { renderFinalResultInput, renderPlannerInput } from './plannerPrompt.js';

const FINAL_RESULT_SCHEMA = {
  type: 'json_schema',
  name: 'audit_agent_final_result',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: { enum: ['final_result'] },
      status: { enum: ['completed'] },
      title: { type: 'string' },
      summary: { type: 'string' },
      details_markdown: { type: 'string' },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string' }, label: { type: 'string' } },
          required: ['id', 'label'],
        },
      },
    },
    required: ['type', 'status', 'title', 'summary', 'details_markdown', 'actions'],
  },
};

function plannerError(message, code = 'planner_error') {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  return error;
}

export function createOpenAIPlanner({ llmClient, model, registry, now = () => new Date().toISOString() }) {
  if (!llmClient) throw new Error('llmClient is required for createOpenAIPlanner');
  if (!model) throw new Error('model is required for createOpenAIPlanner');
  if (!registry) throw new Error('registry is required for createOpenAIPlanner');

  return {
    async createInitialPlan(input) {
      const raw = await llmClient.createStructuredResponse({
        model,
        input: renderPlannerInput({
          requestText: input.requestText ?? '',
          metadata: input.metadata ?? {},
          nowIso: now(),
          tools: registry.describeTools(),
        }),
        schema: plannerDecisionJsonSchema(),
      });

      const validated = validatePlannerDecision(raw, { registry });
      if (!validated.ok) throw validated.error;
      return validated.decision;
    },

    async resumeFromDecision(waitingContext, response) {
      const raw = await llmClient.createStructuredResponse({
        model,
        input: renderPlannerInput({
          requestText: waitingContext?.requestText ?? '',
          metadata: { ...waitingContext?.metadata, decisionResponse: response },
          nowIso: now(),
          tools: registry.describeTools(),
        }),
        schema: plannerDecisionJsonSchema(),
      });

      const validated = validatePlannerDecision(raw, { registry });
      if (!validated.ok) throw validated.error;
      if (validated.decision.type !== 'plan') {
        throw plannerError('resumeFromDecision must return a plan', 'invalid_planner_decision');
      }
      return validated.decision;
    },

    async synthesizeFinalResult(context) {
      const result = await llmClient.createStructuredResponse({
        model,
        input: renderFinalResultInput(context),
        schema: FINAL_RESULT_SCHEMA,
      });

      if (!result || result.type !== 'final_result' || result.status !== 'completed') {
        throw plannerError('OpenAI final result did not match final_result contract', 'invalid_final_result');
      }
      return result;
    },
  };
}
