import OpenAI from 'openai';

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function createConcurrencyGate(maxConcurrency) {
  let active = 0;
  const waiters = [];

  async function acquire() {
    if (active < maxConcurrency) {
      active += 1;
      return;
    }
    await new Promise((resolve) => waiters.push(resolve));
  }

  function release() {
    const next = waiters.shift();
    if (next) {
      next();
    } else {
      active -= 1;
    }
  }

  return async function runWithGate(fn) {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

function parseOutputText(response) {
  const text = response.output_text;
  if (typeof text !== 'string' || text.trim() === '') {
    const error = new Error('OpenAI response did not include output_text');
    error.code = 'openai_empty_response';
    error.retryable = true;
    throw error;
  }

  try {
    return JSON.parse(text);
  } catch (cause) {
    const error = new Error(`OpenAI response was not valid JSON: ${cause.message}`);
    error.code = 'openai_invalid_json';
    error.retryable = false;
    throw error;
  }
}

export function createOpenAIResponsesClient({
  apiKey,
  baseURL,
  timeoutMs = 30000,
  maxConcurrency = 2,
  openaiClient,
} = {}) {
  const client = openaiClient ?? new OpenAI({ apiKey, baseURL, timeout: timeoutMs });
  const runWithGate = createConcurrencyGate(positiveInteger(maxConcurrency, 2));

  return {
    async createStructuredResponse({ model, input, schema, signal }) {
      const response = await runWithGate(() => client.responses.create({
        model,
        input,
        text: { format: schema },
      }, signal ? { signal } : undefined));

      return parseOutputText(response);
    },
  };
}
