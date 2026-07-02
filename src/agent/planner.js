import { createOpenAIPlanner } from './openaiPlanner.js';

export function createPlanner(options = {}) {
  return createOpenAIPlanner({
    llmClient: options.llmClient,
    model: options.model,
    registry: options.registry,
    now: options.now,
  });
}

export { createOpenAIPlanner };
