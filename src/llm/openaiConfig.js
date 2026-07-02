const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 30000;

function parseTimeout(value) {
  if (value == null || value === '') return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`OPENAI_TIMEOUT_MS must be a positive number, got ${value}`);
  }
  return parsed;
}

export function loadOpenAIConfig({ env = process.env, appConfig = {} } = {}) {
  const plannerConfig = appConfig.planner ?? {};
  const apiKey = env.OPENAI_API_KEY ?? null;
  const model = env.OPENAI_MODEL ?? plannerConfig.model ?? null;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required');
  if (!model) throw new Error('OPENAI_MODEL is required');

  return {
    apiKey,
    baseURL: env.OPENAI_BASE_URL ?? plannerConfig.baseURL ?? DEFAULT_BASE_URL,
    model,
    timeoutMs: parseTimeout(env.OPENAI_TIMEOUT_MS ?? plannerConfig.timeoutMs),
  };
}
