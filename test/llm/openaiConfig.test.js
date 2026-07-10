import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadOpenAIConfig } from '../../src/llm/openaiConfig.js';

test('OpenAI config resolves required API settings from environment', () => {
  const config = loadOpenAIConfig({
    env: {
      AUDIT_AGENT_LLM_API_KEY: 'sk-test-redacted',
      AUDIT_AGENT_LLM_BASE_URL: 'https://example.test/v1',
      AUDIT_AGENT_LLM_MODEL: 'gpt-test-planner',
      AUDIT_AGENT_LLM_TIMEOUT_MS: '45000',
    },
    appConfig: {},
    projectRoot: os.tmpdir(),
  });

  assert.equal(config.apiKey, 'sk-test-redacted');
  assert.equal(config.baseURL, 'https://example.test/v1');
  assert.equal(config.model, 'gpt-test-planner');
  assert.equal(config.timeoutMs, 45000);
});

test('OpenAI config requires API key and model', () => {
  assert.throws(
    () => loadOpenAIConfig({ env: { AUDIT_AGENT_LLM_MODEL: 'gpt-test-planner' }, appConfig: {}, projectRoot: os.tmpdir() }),
    /AUDIT_AGENT_LLM_API_KEY is required/,
  );
  assert.throws(
    () => loadOpenAIConfig({ env: { AUDIT_AGENT_LLM_API_KEY: 'sk-test-redacted' }, appConfig: {}, projectRoot: os.tmpdir() }),
    /AUDIT_AGENT_LLM_MODEL is required/,
  );
});

test('OpenAI config defaults base URL and timeout only', () => {
  const config = loadOpenAIConfig({
    env: {
      AUDIT_AGENT_LLM_API_KEY: 'sk-test-redacted',
      AUDIT_AGENT_LLM_MODEL: 'gpt-test-planner',
    },
    appConfig: {},
    projectRoot: os.tmpdir(),
  });

  assert.equal(config.baseURL, 'https://api.openai.com/v1');
  assert.equal(config.timeoutMs, 30000);
  assert.equal(config.maxConcurrency, 2);
});

test('OpenAI config loads max concurrency from audit review budget', () => {
  const config = loadOpenAIConfig({
    env: {
      AUDIT_AGENT_LLM_API_KEY: 'sk-test-redacted',
      AUDIT_AGENT_LLM_MODEL: 'gpt-test-planner',
    },
    appConfig: {
      auditReview: {
        llmBudget: {
          maxConcurrency: 4,
        },
      },
    },
    projectRoot: os.tmpdir(),
  });

  assert.equal(config.maxConcurrency, 4);
});

test('OpenAI config loads values from project-level .config file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-config-'));
  fs.writeFileSync(
    path.join(tmpDir, '.config'),
    JSON.stringify({
      AUDIT_AGENT_LLM_API_KEY: 'sk-from-config',
      AUDIT_AGENT_LLM_BASE_URL: 'https://gateway.test/v1',
      AUDIT_AGENT_LLM_MODEL: 'gpt-from-config',
      AUDIT_AGENT_LLM_TIMEOUT_MS: '12000',
    }),
    'utf-8',
  );

  try {
    const config = loadOpenAIConfig({ env: {}, appConfig: {}, projectRoot: tmpDir });
    assert.equal(config.apiKey, 'sk-from-config');
    assert.equal(config.baseURL, 'https://gateway.test/v1');
    assert.equal(config.model, 'gpt-from-config');
    assert.equal(config.timeoutMs, 12000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('environment variables override .config file values', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-config-override-'));
  fs.writeFileSync(
    path.join(tmpDir, '.config'),
    JSON.stringify({
      AUDIT_AGENT_LLM_API_KEY: 'sk-from-config',
      AUDIT_AGENT_LLM_MODEL: 'gpt-from-config',
    }),
    'utf-8',
  );

  try {
    const config = loadOpenAIConfig({
      env: { AUDIT_AGENT_LLM_API_KEY: 'sk-from-env', AUDIT_AGENT_LLM_MODEL: 'gpt-from-env' },
      appConfig: {},
      projectRoot: tmpDir,
    });
    assert.equal(config.apiKey, 'sk-from-env');
    assert.equal(config.model, 'gpt-from-env');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
