import OpenAI from 'openai';

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

export function createOpenAIResponsesClient({ apiKey, baseURL, timeoutMs = 30000 } = {}) {
  const client = new OpenAI({ apiKey, baseURL, timeout: timeoutMs });

  return {
    async createStructuredResponse({ model, input, schema, signal }) {
      const response = await client.responses.create({
        model,
        input,
        text: { format: schema },
      }, signal ? { signal } : undefined);

      return parseOutputText(response);
    },
  };
}
