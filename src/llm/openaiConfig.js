import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_CONCURRENCY = 2;

const ENV_API_KEY = 'AUDIT_AGENT_LLM_API_KEY';
const ENV_BASE_URL = 'AUDIT_AGENT_LLM_BASE_URL';
const ENV_MODEL = 'AUDIT_AGENT_LLM_MODEL';
const ENV_TIMEOUT_MS = 'AUDIT_AGENT_LLM_TIMEOUT_MS';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function defaultProjectRoot() {
  // src/llm/openaiConfig.js -> project root is two levels up.
  return path.resolve(__dirname, '..', '..');
}

function readProjectConfig(rootDir) {
  const configPath = path.join(rootDir, '.config');
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function pick(name, sources) {
  for (const source of sources) {
    const value = source?.[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function parseTimeout(value) {
  if (value == null || value === '') return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`AUDIT_AGENT_LLM_TIMEOUT_MS must be a positive number, got ${value}`);
  }
  return parsed;
}

function parseMaxConcurrency(value) {
  if (value == null || value === '') return DEFAULT_MAX_CONCURRENCY;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`auditReview.llmBudget.maxConcurrency must be a positive number, got ${value}`);
  }
  return Math.floor(parsed);
}

export function loadOpenAIConfig({ env = process.env, appConfig = {}, projectRoot } = {}) {
  const rootDir = projectRoot ?? defaultProjectRoot();
  const projectConfig = readProjectConfig(rootDir);
  const plannerConfig = appConfig.planner ?? {};
  const llmBudgetConfig = appConfig.auditReview?.llmBudget ?? {};

  const apiKey = pick(ENV_API_KEY, [env, projectConfig]);
  const model = pick(ENV_MODEL, [env, projectConfig, plannerConfig]) ?? plannerConfig.model;
  const baseURL = pick(ENV_BASE_URL, [env, projectConfig, plannerConfig]) ?? plannerConfig.baseURL ?? DEFAULT_BASE_URL;
  const timeoutRaw = pick(ENV_TIMEOUT_MS, [env, projectConfig, plannerConfig]) ?? plannerConfig.timeoutMs;
  const maxConcurrencyRaw = llmBudgetConfig.maxConcurrency;

  if (!apiKey) throw new Error(`${ENV_API_KEY} is required (set it in .config or the process environment)`);
  if (!model) throw new Error(`${ENV_MODEL} is required (set it in .config or the process environment)`);

  return {
    apiKey,
    baseURL,
    model,
    timeoutMs: parseTimeout(timeoutRaw),
    maxConcurrency: parseMaxConcurrency(maxConcurrencyRaw),
  };
}
