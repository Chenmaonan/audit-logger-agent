# OpenAI LLM Agent Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the current keyword/template planner into an OpenAI-backed LLM planner while keeping the existing run state machine, tool registry, audit database, waiting/resume flow, and outbox delivery contract stable.

**Architecture:** Add a narrow OpenAI integration layer that loads API configuration from environment/config, calls the OpenAI Responses API through the official Node SDK, and returns a validated planner decision object. The LLM does not execute tools directly; it emits a structured plan using registered tool names, then the existing runtime executes those tools and persists steps exactly as v1.1 does today. The OpenAI-backed planner becomes the single planner path for v1.3.

**Tech Stack:** Node.js ESM, official `openai` Node SDK, OpenAI Responses API, structured JSON schema output, existing `better-sqlite3`, existing `node:test`, existing HTTP server and runtime modules.

## Global Constraints

- Do not store `OPENAI_API_KEY` in `config.json`, SQLite, audit events, outbox payloads, test fixtures, or docs examples with real values.
- Support `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, and `OPENAI_TIMEOUT_MS`.
- Default `OPENAI_BASE_URL` to `https://api.openai.com/v1` when not provided.
- Use the OpenAI Responses API via `client.responses.create(...)`.
- Use structured output so planner responses are machine-validated before the runtime sees them.
- Never let raw model text mutate run state; every model output must pass local validation first.
- Keep existing `/v1/runs`, `/v1/runs/{runId}/resume`, `/query`, and `/report/*` contracts compatible.
- Planner integration tests may call the real OpenAI API and must require an explicit `OPENAI_API_KEY`.
- The LLM planner may choose only tools registered in the local registry.
- If OpenAI planning fails, convert the error to a structured planner error and let runtime failure convergence produce a failed `final_result`.
- Official docs to verify during execution: `https://platform.openai.com/docs/api-reference/responses/create`, `https://platform.openai.com/docs/guides/structured-outputs`, and `https://platform.openai.com/docs/libraries`.

---

## Current Data Path To Preserve

```text
Bot or caller
  -> POST /v1/runs
  -> Runtime.startRun
  -> Planner.createInitialPlan
  -> ToolRegistry.execute
  -> agent_run_steps
  -> Planner.synthesizeFinalResult
  -> agent_outbox_events
  -> Bot callback_url
```

## Target v1.3 Data Path

```text
Bot or caller
  -> POST /v1/runs
  -> Runtime.startRun
  -> OpenAI-backed planner
  -> OpenAI Responses API
  -> structured planner decision
  -> local plan validation
  -> ToolRegistry.execute
  -> agent_run_steps
  -> LLM or deterministic final-result synthesis
  -> agent_outbox_events
  -> Bot callback_url
```

## File Map

| File | Responsibility |
|------|----------------|
| `package.json` | Add the official `openai` SDK dependency and update test script entries. |
| `package-lock.json` | Lock the `openai` dependency. |
| `config.json` | Keep existing audit config; do not add secrets. A non-secret `planner` block can be added if desired. |
| `src/app/loadConfig.js` | Load non-secret planner settings from config and environment. |
| `src/llm/openaiConfig.js` | Resolve OpenAI API key, base URL, model, and timeout. |
| `src/llm/openaiResponsesClient.js` | Wrap the official SDK behind a small project-local interface. |
| `src/agent/planner.js` | Export the OpenAI-backed planner as the single planner path. |
| `src/agent/openaiPlanner.js` | Convert run input to OpenAI prompt, call the Responses API, validate output, and expose the planner interface. |
| `src/agent/plannerSchema.js` | Define and validate the structured planner decision schema. |
| `src/agent/plannerPrompt.js` | Hold the system/developer prompt and tool manifest rendering. |
| `src/tools/registry.js` | Expose tool metadata for the LLM planner. |
| `src/tools/auditQueryTool.js` | Add description and input schema metadata. |
| `src/tools/reportTool.js` | Add description and input schema metadata. |
| `scripts/server.js` | Wire planner factory with OpenAI config and the real SDK client. |
| `test/llm/openaiConfig.test.js` | Verify config resolution without leaking secrets. |
| `test/llm/openaiResponsesClient.test.js` | Verify request shape and response parsing with real OpenAI credentials. |
| `test/runtime/openaiPlanner.test.js` | Verify LLM planner success, invalid tool rejection, and decision request flow with real OpenAI credentials. |

## Interfaces

```js
// src/llm/openaiConfig.js
export function loadOpenAIConfig({ env = process.env, appConfig = {} } = {}) {
  return {
    apiKey: string,
    baseURL: string,
    model: string,
    timeoutMs: number,
  };
}
```

```js
// src/llm/openaiResponsesClient.js
export function createOpenAIResponsesClient({ apiKey, baseURL, timeoutMs } = {}) {
  return {
    createStructuredResponse({ model, input, schema, signal }): Promise<object>,
  };
}
```

```js
// src/agent/openaiPlanner.js
export function createOpenAIPlanner({ llmClient, model, registry, now = () => new Date().toISOString() }) {
  return {
    createInitialPlan(input): Promise<PlannerDecision>,
    resumeFromDecision(waitingContext, response): Promise<{ type: 'plan', plan: ExecutionPlan }>,
    synthesizeFinalResult(context): Promise<FinalResultPayload>,
  };
}
```

```js
// src/agent/plannerSchema.js
export function plannerDecisionJsonSchema() {
  return object;
}

export function validatePlannerDecision(value, { registry }) {
  return { ok: true, decision: value } | { ok: false, error: Error };
}
```

---

### Task 1: Add OpenAI Configuration And SDK Wrapper

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/llm/openaiConfig.js`
- Create: `src/llm/openaiResponsesClient.js`
- Test: `test/llm/openaiConfig.test.js`
- Test: `test/llm/openaiResponsesClient.test.js`

**Interfaces:**
- Consumes: `process.env`
- Produces: `loadOpenAIConfig({ env, appConfig })`
- Produces: `createOpenAIResponsesClient({ apiKey, baseURL, timeoutMs, sdkClient })`

- [ ] **Step 1: Write the failing config test**

```js
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
```

- [ ] **Step 2: Write the failing client integration test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOpenAIConfig } from '../../src/llm/openaiConfig.js';
import { createOpenAIResponsesClient } from '../../src/llm/openaiResponsesClient.js';

test('OpenAI responses client calls the real Responses API with structured output', async () => {
  assert.ok(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY is required for this integration test');
  assert.ok(process.env.OPENAI_MODEL, 'OPENAI_MODEL is required for this integration test');

  const config = loadOpenAIConfig({ env: process.env, appConfig: {} });
  const client = createOpenAIResponsesClient(config);

  const result = await client.createStructuredResponse({
    model: config.model,
    input: [
      { role: 'system', content: 'Return the exact structured object requested by the schema.' },
      { role: 'user', content: 'Return {"type":"plan","plan":{"steps":[]},"decision":null}.' },
    ],
    schema: {
      type: 'json_schema',
      name: 'audit_agent_planner_decision',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { enum: ['plan'] },
          plan: {
            type: 'object',
            additionalProperties: false,
            properties: { steps: { type: 'array', items: { type: 'object' } } },
            required: ['steps'],
          },
          decision: { type: ['object', 'null'] },
        },
        required: ['type', 'plan', 'decision'],
      },
    },
  });

  assert.equal(result.type, 'plan');
  assert.deepEqual(result.plan.steps, []);
  assert.equal(result.decision, null);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
node --test test/llm/openaiConfig.test.js test/llm/openaiResponsesClient.test.js
```

Expected: FAIL with module not found errors for `src/llm/openaiConfig.js` and `src/llm/openaiResponsesClient.js`.

- [ ] **Step 4: Add the `openai` dependency**

Run:

```bash
npm install openai --save
```

Expected: `package.json` and `package-lock.json` update with the `openai` dependency.

- [ ] **Step 5: Implement `src/llm/openaiConfig.js`**

```js
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
```

- [ ] **Step 6: Implement `src/llm/openaiResponsesClient.js`**

```js
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
```

- [ ] **Step 7: Run tests to verify they pass**

Run:

```bash
node --test test/llm/openaiConfig.test.js test/llm/openaiResponsesClient.test.js
```

Expected: PASS with `4` passing tests when `OPENAI_API_KEY` and `OPENAI_MODEL` are set.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/llm/openaiConfig.js src/llm/openaiResponsesClient.js test/llm/openaiConfig.test.js test/llm/openaiResponsesClient.test.js
git commit -m "feat: add OpenAI planner configuration and responses client"
```

---

### Task 2: Add Planner Schema And Tool Metadata

**Files:**
- Create: `src/agent/plannerSchema.js`
- Modify: `src/tools/registry.js`
- Modify: `src/tools/auditQueryTool.js`
- Modify: `src/tools/reportTool.js`
- Test: `test/runtime/plannerSchema.test.js`
- Test: `test/runtime/toolMetadata.test.js`

**Interfaces:**
- Consumes: `createToolRegistry()`
- Produces: `plannerDecisionJsonSchema()`
- Produces: `validatePlannerDecision(value, { registry })`
- Produces: `registry.describeTools(): Array<{ name, description, inputSchema }>`

- [ ] **Step 1: Write the failing planner schema test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../../src/tools/registry.js';
import { plannerDecisionJsonSchema, validatePlannerDecision } from '../../src/agent/plannerSchema.js';

test('planner schema accepts a valid plan using registered tools', () => {
  const registry = createToolRegistry();
  registry.register({ name: 'audit.queryEvents', description: 'Query audit events', inputSchema: { type: 'object' }, async execute() { return []; } });

  const value = {
    type: 'plan',
    plan: {
      steps: [
        { stepName: 'load-errors', toolName: 'audit.queryEvents', input: { status: 'error', limit: 100 } },
      ],
    },
  };

  const result = validatePlannerDecision(value, { registry });
  assert.equal(result.ok, true);
  assert.deepEqual(result.decision, value);
});

test('planner schema rejects unknown tools', () => {
  const registry = createToolRegistry();
  const result = validatePlannerDecision({
    type: 'plan',
    plan: {
      steps: [
        { stepName: 'bad-step', toolName: 'unknown.tool', input: {} },
      ],
    },
  }, { registry });

  assert.equal(result.ok, false);
  assert.match(result.error.message, /Unknown planner tool/);
});

test('planner schema exposes JSON schema for OpenAI structured output', () => {
  const schema = plannerDecisionJsonSchema();
  assert.equal(schema.type, 'json_schema');
  assert.equal(schema.name, 'audit_agent_planner_decision');
  assert.equal(schema.strict, true);
  assert.equal(schema.schema.type, 'object');
});
```

- [ ] **Step 2: Write the failing tool metadata test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../../src/tools/registry.js';
import { buildAuditQueryTool } from '../../src/tools/auditQueryTool.js';
import { buildReportTool } from '../../src/tools/reportTool.js';

test('tool registry exposes metadata for LLM planning prompts', () => {
  const registry = createToolRegistry();
  registry.register(buildAuditQueryTool({ db: {} }));
  registry.register(buildReportTool({ db: {} }));

  const tools = registry.describeTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['audit.queryEvents', 'report.errorSummary']);
  assert.ok(tools.every((tool) => typeof tool.description === 'string' && tool.description.length > 10));
  assert.ok(tools.every((tool) => tool.inputSchema && tool.inputSchema.type === 'object'));
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
node --test test/runtime/plannerSchema.test.js test/runtime/toolMetadata.test.js
```

Expected: FAIL because `plannerSchema.js` and `describeTools()` do not exist.

- [ ] **Step 4: Implement `src/agent/plannerSchema.js`**

```js
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
```

- [ ] **Step 5: Add `describeTools()` to `src/tools/registry.js`**

```js
// Add inside the returned registry object.
describeTools() {
  return Array.from(tools.values()).map((tool) => ({
    name: tool.name,
    description: tool.description ?? `Tool ${tool.name}`,
    inputSchema: tool.inputSchema ?? { type: 'object', additionalProperties: true },
  }));
},
```

- [ ] **Step 6: Add metadata to `src/tools/auditQueryTool.js`**

```js
import { queryEvents } from '../../scripts/lib/db.js';

export function buildAuditQueryTool({ db }) {
  return {
    name: 'audit.queryEvents',
    description: 'Query audit_events by agent, tool, event, status, trace, product, channel, time range, limit, and offset.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent_id: { type: 'string' },
        tool_name: { type: 'string' },
        status: { enum: ['ok', 'error', 'timeout', 'cancelled'] },
        event: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        trace_id: { type: 'string' },
        product_id: { type: 'string' },
        channel: { type: 'string' },
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
    },
    async execute(input) {
      return queryEvents(db, input);
    },
  };
}
```

- [ ] **Step 7: Add metadata to `src/tools/reportTool.js`**

```js
import { errorReport } from '../../scripts/lib/db.js';

export function buildReportTool({ db }) {
  return {
    name: 'report.errorSummary',
    description: 'Return audit error rows for a time range, optionally filtered by agentId, for final user-facing summaries.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        agentId: { type: ['string', 'null'] },
      },
      required: ['from', 'to'],
    },
    async execute(input) {
      return errorReport(db, input.from, input.to, input.agentId);
    },
  };
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run:

```bash
node --test test/runtime/plannerSchema.test.js test/runtime/toolMetadata.test.js
```

Expected: PASS with `4` passing tests.

- [ ] **Step 9: Commit**

```bash
git add src/agent/plannerSchema.js src/tools/registry.js src/tools/auditQueryTool.js src/tools/reportTool.js test/runtime/plannerSchema.test.js test/runtime/toolMetadata.test.js
git commit -m "feat: add planner schema and tool metadata"
```

---

### Task 3: Add OpenAI Planner As The Sole Planner

**Files:**
- Modify: `src/agent/planner.js`
- Create: `src/agent/plannerPrompt.js`
- Create: `src/agent/openaiPlanner.js`
- Test: `test/runtime/openaiPlanner.test.js`

**Interfaces:**
- Consumes: `plannerDecisionJsonSchema()`
- Consumes: `validatePlannerDecision(value, { registry })`
- Consumes: `llmClient.createStructuredResponse({ model, input, schema, signal })`
- Produces: `createOpenAIPlanner({ llmClient, model, registry, now })`
- Produces: `createPlanner({ llmClient, model, registry, now })`

- [ ] **Step 1: Write the failing OpenAI planner integration test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOpenAIConfig } from '../../src/llm/openaiConfig.js';
import { createOpenAIResponsesClient } from '../../src/llm/openaiResponsesClient.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { createOpenAIPlanner } from '../../src/agent/openaiPlanner.js';

function registryWithTools() {
  const registry = createToolRegistry();
  registry.register({ name: 'audit.queryEvents', description: 'Query audit events', inputSchema: { type: 'object' }, async execute() { return []; } });
  registry.register({ name: 'report.errorSummary', description: 'Summarize errors', inputSchema: { type: 'object' }, async execute() { return []; } });
  return registry;
}

test('OpenAI planner converts natural language into a validated local tool plan', async () => {
  assert.ok(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY is required for this integration test');
  assert.ok(process.env.OPENAI_MODEL, 'OPENAI_MODEL is required for this integration test');

  const config = loadOpenAIConfig({ env: process.env, appConfig: {} });
  const planner = createOpenAIPlanner({
    llmClient: createOpenAIResponsesClient(config),
    model: config.model,
    registry: registryWithTools(),
    now: () => '2026-07-02T09:00:00.000+08:00',
  });

  const result = await planner.createInitialPlan({
    requestText: 'Analyze all audit error events for today. Do not ask for clarification.',
    metadata: { tenant_key: 'tenant_test' },
  });

  assert.equal(result.type, 'plan');
  assert.ok(result.plan.steps.length >= 1);
  for (const step of result.plan.steps) {
    assert.ok(registryWithTools().has(step.toolName), `unexpected tool: ${step.toolName}`);
  }
});

test('OpenAI planner synthesizes a structured final result', async () => {
  assert.ok(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY is required for this integration test');
  assert.ok(process.env.OPENAI_MODEL, 'OPENAI_MODEL is required for this integration test');

  const config = loadOpenAIConfig({ env: process.env, appConfig: {} });
  const planner = createOpenAIPlanner({
    llmClient: createOpenAIResponsesClient(config),
    model: config.model,
    registry: registryWithTools(),
  });

  const result = await planner.synthesizeFinalResult({
    runId: 'run_openai_test',
    toolResults: [
      { stepName: 'load-errors', result: [{ tool_name: 'demo.tool', result_summary: 'demo failed' }] },
    ],
  });

  assert.equal(result.type, 'final_result');
  assert.equal(result.status, 'completed');
  assert.ok(result.summary.length > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test test/runtime/openaiPlanner.test.js
```

Expected: FAIL because `src/agent/openaiPlanner.js` does not exist.

- [ ] **Step 3: Replace `src/agent/planner.js` with the OpenAI planner factory**

```js
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
```

- [ ] **Step 4: Implement `src/agent/plannerPrompt.js`**

```js
export function renderPlannerInput({ requestText, metadata, nowIso, tools }) {
  return [
    {
      role: 'system',
      content: [
        'You are the planner for an audit-log agent.',
        'Return only a structured planner decision that matches the supplied JSON schema.',
        'You may choose only tools listed in the tool manifest.',
        'Prefer asking for a decision_request when the request scope is ambiguous.',
        'Never invent tool names, database tables, callback URLs, or user identities.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        now: nowIso,
        requestText,
        metadata: metadata ?? {},
        tools,
        expectedOutputs: {
          plan: 'Use when the request can be executed directly.',
          decision_request: 'Use when the user must choose scope, date range, agent, product, or risk level.',
        },
      }),
    },
  ];
}

export function renderFinalResultInput({ runId, toolResults }) {
  return [
    {
      role: 'system',
      content: [
        'You summarize audit-tool results for a human user.',
        'Return concise operational findings.',
        'Do not claim remediation was performed unless tool results prove it.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({ runId, toolResults }),
    },
  ];
}
```

- [ ] **Step 5: Implement `src/agent/openaiPlanner.js`**

```js
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
```

- [ ] **Step 6: Run OpenAI planner tests**

Run:

```bash
node --test test/runtime/openaiPlanner.test.js
```

Expected: PASS when `OPENAI_API_KEY` and `OPENAI_MODEL` are set.

- [ ] **Step 7: Commit**

```bash
git add src/agent/planner.js src/agent/plannerPrompt.js src/agent/openaiPlanner.js test/runtime/openaiPlanner.test.js
git commit -m "feat: add OpenAI-backed LLM planner"
```

---

### Task 4: Wire OpenAI Planner Into Server Boot

**Files:**
- Modify: `scripts/server.js`
- Modify: `src/app/loadConfig.js`
- Test: `test/runtime/planner-factory.test.js`
- Test: `test/http/runs-api.test.js`

**Interfaces:**
- Consumes: `loadOpenAIConfig({ env, appConfig })`
- Consumes: `createOpenAIResponsesClient(openAIConfig)`
- Consumes: `createPlanner({ llmClient, model, registry })`
- Produces: server boot that always uses the OpenAI planner.

- [ ] **Step 1: Write planner factory integration test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOpenAIConfig } from '../../src/llm/openaiConfig.js';
import { createOpenAIResponsesClient } from '../../src/llm/openaiResponsesClient.js';
import { createPlanner } from '../../src/agent/planner.js';
import { createToolRegistry } from '../../src/tools/registry.js';

test('planner factory creates the OpenAI planner path', async () => {
  assert.ok(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY is required for this integration test');
  assert.ok(process.env.OPENAI_MODEL, 'OPENAI_MODEL is required for this integration test');

  const config = loadOpenAIConfig({ env: process.env, appConfig: {} });
  const registry = createToolRegistry();
  registry.register({ name: 'audit.queryEvents', description: 'Query audit events', inputSchema: { type: 'object' }, async execute() { return []; } });

  const planner = createPlanner({
    model: config.model,
    registry,
    llmClient: createOpenAIResponsesClient(config),
  });

  const result = await planner.createInitialPlan({
    requestText: 'Create a plan to query audit errors. Use only available tools.',
    metadata: {},
  });
  assert.ok(['plan', 'decision_request'].includes(result.type));
});
```

- [ ] **Step 2: Run test to verify it fails until server-side planner dependencies exist**

Run:

```bash
node --test test/runtime/planner-factory.test.js
```

Expected: PASS after Task 3 when `OPENAI_API_KEY` and `OPENAI_MODEL` are set.

- [ ] **Step 3: Extend `src/app/loadConfig.js` for non-secret planner config**

```js
import fs from 'fs';
import path from 'path';

export function loadAppConfig(rootDir) {
  const configPath = path.join(rootDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json not found at ${configPath}`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return {
    ...config,
    planner: config.planner ?? {},
  };
}
```

- [ ] **Step 4: Update `scripts/server.js` planner wiring**

```js
import { loadOpenAIConfig } from '../src/llm/openaiConfig.js';
import { createOpenAIResponsesClient } from '../src/llm/openaiResponsesClient.js';
```

Replace the current planner injection with:

```js
const openAIConfig = loadOpenAIConfig({ env: process.env, appConfig: config });
const llmClient = createOpenAIResponsesClient({
  apiKey: openAIConfig.apiKey,
  baseURL: openAIConfig.baseURL,
  timeoutMs: openAIConfig.timeoutMs,
});

const planner = createPlanner({
  llmClient,
  model: openAIConfig.model,
  registry,
});
```

Then pass `planner` into runtime:

```js
const runtime = createRuntime({
  runStore,
  outboxStore,
  waitStore,
  planner,
  registry,
  eventPublisher,
  auditLogger,
  executor: (task) => setImmediate(task),
});
```

- [ ] **Step 5: Run server/API tests**

Run:

```bash
node --test test/runtime/planner-factory.test.js test/http/runs-api.test.js test/runtime/runtime.test.js
```

Expected: PASS when `OPENAI_API_KEY` and `OPENAI_MODEL` are set.

- [ ] **Step 6: Commit**

```bash
git add scripts/server.js src/app/loadConfig.js test/runtime/planner-factory.test.js test/http/runs-api.test.js
git commit -m "feat: wire OpenAI planner selection into server boot"
```

---

### Task 5: Add Real OpenAI Runtime Integration Tests

**Files:**
- Create: `test/runtime/openaiRuntime.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `createRuntime(...)`
- Consumes: `loadOpenAIConfig({ env, appConfig })`
- Consumes: `createOpenAIResponsesClient(openAIConfig)`
- Produces: test coverage proving the real OpenAI planner path integrates with runtime.

- [ ] **Step 1: Write OpenAI runtime integration test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../scripts/lib/db.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { createRunStore } from '../../src/agent/runStore.js';
import { createOutboxStore } from '../../src/agent/outboxStore.js';
import { createWaitStore } from '../../src/agent/waitStore.js';
import { createEventPublisher } from '../../src/agent/eventPublisher.js';
import { createRuntime } from '../../src/agent/runtime.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { createPlanner } from '../../src/agent/planner.js';
import { loadOpenAIConfig } from '../../src/llm/openaiConfig.js';
import { createOpenAIResponsesClient } from '../../src/llm/openaiResponsesClient.js';

async function waitForTerminal(runStore, runId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = runStore.getRun(runId);
    if (run && ['completed', 'failed', 'waiting_user'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return runStore.getRun(runId);
}

test('runtime executes an OpenAI-planned audit task through the real Responses API', async () => {
  assert.ok(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY is required for this integration test');
  assert.ok(process.env.OPENAI_MODEL, 'OPENAI_MODEL is required for this integration test');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-runtime-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);

  const runStore = createRunStore(db);
  const outboxStore = createOutboxStore(db);
  const waitStore = createWaitStore(db);
  const eventPublisher = createEventPublisher({ outboxStore, callbackClient: { async send() {} } });

  const registry = createToolRegistry();
  registry.register({ name: 'audit.queryEvents', description: 'Query audit events', inputSchema: { type: 'object' }, async execute() { return [{ tool_name: 'demo.tool', result_summary: 'demo failed' }]; } });
  registry.register({ name: 'report.errorSummary', description: 'Summarize errors', inputSchema: { type: 'object' }, async execute() { return [{ tool_name: 'demo.tool', result_summary: 'demo failed' }]; } });

  const config = loadOpenAIConfig({ env: process.env, appConfig: {} });

  const runtime = createRuntime({
    runStore,
    outboxStore,
    waitStore,
    planner: createPlanner({
      model: config.model,
      registry,
      llmClient: createOpenAIResponsesClient(config),
    }),
    registry,
    eventPublisher,
    auditLogger: { async log() {} },
  });

  const created = await runtime.startRun({
    channel: 'feishu',
    conversationId: 'oc_test',
    messageId: 'om_openai',
    userOpenId: 'ou_test',
    requestText: 'Please analyze all audit failures',
    deliveryMode: 'callback',
    callbackUrl: 'http://127.0.0.1:9999/agent-events',
    metadata: {},
  });

  const completed = await waitForTerminal(runStore, created.run_id);
  assert.equal(completed.status, 'completed');
  assert.ok(runStore.listSteps(created.run_id).length >= 1);
  assert.ok(outboxStore.listAll(20).find((event) => event.type === 'final_result'));

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Update `package.json` test script**

Add the new tests to `test:agent`:

```json
"test:agent": "node --test test/runtime/foundation.test.js test/http/runs-api.test.js test/runtime/outbox.test.js test/runtime/plannerSchema.test.js test/runtime/toolMetadata.test.js test/runtime/openaiPlanner.test.js test/runtime/planner-factory.test.js test/runtime/openaiRuntime.test.js test/runtime/runtime.test.js test/runtime/audit.test.js test/runtime/encoding.test.js test/runtime/fixes.test.js test/llm/openaiConfig.test.js test/llm/openaiResponsesClient.test.js && node test/self-test.js"
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
node --test test/runtime/openaiRuntime.test.js
```

Expected: PASS when `OPENAI_API_KEY` and `OPENAI_MODEL` are set.

- [ ] **Step 4: Run full test suite**

Run:

```bash
npm run test:agent
```

Expected: all runtime tests pass and `node test/self-test.js` prints `ALL TESTS PASSED` when `OPENAI_API_KEY` and `OPENAI_MODEL` are set.

- [ ] **Step 5: Commit**

```bash
git add package.json test/runtime/openaiRuntime.test.js
git commit -m "test: cover OpenAI planner runtime integration"
```

---

### Task 6: Document Runtime Configuration And Local Smoke Test

**Files:**
- Create: `v1.3/OPENAI_LLM_AGENT_USAGE.md`
- Modify: `SKILL.md`
- Test: manual localhost smoke test with real OpenAI credentials.

**Interfaces:**
- Consumes: `npm run server -- --port <port>` or `node scripts/server.js --port <port>`
- Produces: documented environment variables and request examples.

- [ ] **Step 1: Create `v1.3/OPENAI_LLM_AGENT_USAGE.md`**

```md
# OpenAI LLM Agent Usage

## Environment

Set these variables before starting the server:

```powershell
$env:OPENAI_API_KEY = "<redacted>"
$env:OPENAI_BASE_URL = "https://api.openai.com/v1"
$env:OPENAI_MODEL = "<your-openai-model>"
$env:OPENAI_TIMEOUT_MS = "30000"
```

Do not commit real API keys. `OPENAI_BASE_URL` exists for proxies and compatible gateways; leave it unset for the official OpenAI API.

## Start Server

```powershell
node scripts/server.js --port 9320
```

## Create Run

```powershell
$body = @{
  channel = "feishu"
  conversation_id = "oc_manual"
  message_id = "om_manual_openai"
  user = @{ open_id = "ou_manual" }
  request = @{ text = "Analyze all audit failures and summarize the riskiest traces" }
  delivery = @{ mode = "callback"; callback_url = "http://127.0.0.1:9999/agent-events" }
  metadata = @{ tenant_key = "tenant_manual" }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Uri "http://127.0.0.1:9320/v1/runs" -Method Post -ContentType "application/json" -Body $body
```

## Check Run

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:9320/v1/runs/<run_id>" -Method Get
```

## Expected Behavior

- The server returns `202` quickly.
- The planner calls OpenAI through the configured Responses API endpoint.
- The LLM returns a structured plan.
- The existing runtime executes local tools.
- Progress and final result events are stored in `agent_outbox_events`.
- Runtime lifecycle events are stored in `audit_events`.
```

- [ ] **Step 2: Update `SKILL.md` action description**

Add this section under the existing server action:

```md
### OpenAI-backed planner

The v1.3 planner uses OpenAI. Start the server with:

```powershell
$env:OPENAI_API_KEY = "<redacted>"
$env:OPENAI_BASE_URL = "https://api.openai.com/v1"
$env:OPENAI_MODEL = "<your-openai-model>"
node scripts/server.js --port 9320
```

The LLM planner uses structured output to produce either a local tool execution plan or a `decision_request`. Tool execution remains local and auditable.
```

- [ ] **Step 3: Run docs smoke check**

Run:

```bash
rg -n "OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_MODEL|<your-openai-model>" v1.3 SKILL.md
```

Expected: the command prints only documentation references and no real API key values.

- [ ] **Step 4: Commit**

```bash
git add v1.3/OPENAI_LLM_AGENT_USAGE.md SKILL.md
git commit -m "docs: document OpenAI LLM planner mode"
```

---

## Self-Review

### Spec Coverage

- "Make the planner OpenAI-backed": Task 3 adds `createOpenAIPlanner`; Task 4 wires it into server boot.
- "OpenAI API and URL content": Task 1 adds `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, timeout, and official SDK client; Task 6 documents usage.
- "Only plan for now": this file is the only v1.3 artifact in this turn.
- "Keep existing data flow": Global constraints and Tasks 3-5 keep runtime, tools, SQLite, outbox, and audit events intact.
- "Reliable and testable": Tasks 1-5 require explicit OpenAI credentials for planner integration tests and keep local schema validation around model output.

### Placeholder Scan

- The plan contains no intentionally blank implementation sections or deferred work markers.
- Every task names exact files, test commands, expected results, and commit commands.

### Type Consistency

- `loadOpenAIConfig`, `createOpenAIResponsesClient`, `createOpenAIPlanner`, `plannerDecisionJsonSchema`, and `validatePlannerDecision` are defined before later tasks consume them.
- `createPlanner({ mode, llmClient, model, registry })` is the single server-facing factory.
- `registry.describeTools()` is introduced before the OpenAI prompt consumes tool metadata.

## Execution Handoff

Plan complete and saved to `v1.3/OPENAI_LLM_AGENT_INTEGRATION_PLAN.md`. Two execution options:

**1. Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
