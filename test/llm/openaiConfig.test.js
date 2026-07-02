import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOpenAIConfig } from '../../src/llm/openaiConfig.js';

test('OpenAI config resolves required API settings from environment', () => {
  const config = loadOpenAIConfig({
    env: {
      OPENAI_API_KEY: 'sk-test-redacted',
      OPENAI_BASE_URL: 'https://example.test/v1',
      OPENAI_MODEL: 'gpt-test-planner',
      OPENAI_TIMEOUT_MS: '45000',
    },
    appConfig: {},
  });

  assert.equal(config.apiKey, 'sk-test-redacted');
  assert.equal(config.baseURL, 'https://example.test/v1');
  assert.equal(config.model, 'gpt-test-planner');
  assert.equal(config.timeoutMs, 45000);
});

test('OpenAI config requires API key and model', () => {
  assert.throws(
    () => loadOpenAIConfig({ env: { OPENAI_MODEL: 'gpt-test-planner' }, appConfig: {} }),
    /OPENAI_API_KEY is required/,
  );
  assert.throws(
    () => loadOpenAIConfig({ env: { OPENAI_API_KEY: 'sk-test-redacted' }, appConfig: {} }),
    /OPENAI_MODEL is required/,
  );
});

test('OpenAI config defaults base URL and timeout only', () => {
  const config = loadOpenAIConfig({
    env: {
      OPENAI_API_KEY: 'sk-test-redacted',
      OPENAI_MODEL: 'gpt-test-planner',
    },
    appConfig: {},
  });

  assert.equal(config.baseURL, 'https://api.openai.com/v1');
  assert.equal(config.timeoutMs, 30000);
});
