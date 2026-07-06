const DEFAULT_LLM_BUDGET = {
  maxCallsPerDay: 500,
  maxTokensPerDay: 2000000,
  maxConcurrency: 2,
  cacheDetailAnalysis: true,
};

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function llmBudgetFromConfig(config) {
  const raw = config?.auditReview?.llmBudget ?? {};
  return {
    maxCallsPerDay: positiveInteger(raw.maxCallsPerDay, DEFAULT_LLM_BUDGET.maxCallsPerDay),
    maxTokensPerDay: positiveInteger(raw.maxTokensPerDay, DEFAULT_LLM_BUDGET.maxTokensPerDay),
    maxConcurrency: positiveInteger(raw.maxConcurrency, DEFAULT_LLM_BUDGET.maxConcurrency),
    cacheDetailAnalysis: raw.cacheDetailAnalysis !== false,
  };
}

export function estimateTokensForPayload(payload) {
  return Math.max(1, Math.ceil(JSON.stringify(payload ?? {}).length / 4));
}

export function usageWouldExceedBudget(usage, budget, estimatedTokens) {
  const calls = Number(usage?.calls ?? 0);
  const estTokens = Number(usage?.est_tokens ?? 0);
  return (calls + 1) > budget.maxCallsPerDay ||
    (estTokens + estimatedTokens) > budget.maxTokensPerDay;
}

export function llmUsageDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}
