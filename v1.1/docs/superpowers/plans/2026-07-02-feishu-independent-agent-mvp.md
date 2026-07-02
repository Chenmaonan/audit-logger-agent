# Feishu Independent Agent MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first runnable version of the independent Feishu-facing agent service on top of the existing audit logger repository, including run state, Bot callback delivery, waiting/resume flow, and structured final results.

**Architecture:** Keep the existing `scripts/` entrypoints and audit-log data path intact while adding a new `src/` runtime layer for the Agent lifecycle. Use SQLite for durable run state, an explicit state machine for lifecycle control, a Bot-facing outbox for reliable callback delivery, and a constrained planner plus tool registry for deterministic first-version autonomy.

**Tech Stack:** Node.js ESM, built-in `http`, built-in `fetch`, SQLite via `better-sqlite3`, built-in `node:test`, existing audit DB helpers in `scripts/lib/db.js`

## Global Constraints

- 飞书 Bot 作为纯转发层，不承载任务规划、执行和长期状态维护。
- Agent 负责任务理解、规划、执行、等待用户、恢复执行和最终结果产出。
- 第一阶段继续使用 SQLite 作为运行时状态存储。
- 当前仓库继续使用 Node.js ESM，不引入 TypeScript 编译链。
- `scripts/` 继续保留作兼容层和入口层，`src/` 承载新运行时逻辑。
- Bot callback push 是第一优先的出站投递模式。
- 第一阶段优先可靠性、可恢复性、可观测性，而不是吞吐量。
- 第一阶段不做多 Agent 编排、分布式队列、动态插件装载、飞书 SDK 深度集成、无边界自主循环。

## File Map

| File | Responsibility |
|------|----------------|
| `src/db/runtimeSchema.js` | 创建和维护 Agent 运行时表结构 |
| `src/agent/stateMachine.js` | 定义 run 生命周期状态机 |
| `src/agent/runStore.js` | 管理 run 与 step 的持久化读写 |
| `src/agent/outboxStore.js` | 管理待投递给 Bot 的出站事件 |
| `src/agent/waitStore.js` | 管理等待用户输入时的上下文快照 |
| `src/agent/payloads.js` | 统一生成 `progress_update`、`decision_request`、`final_result` |
| `src/agent/planner.js` | 第一版受约束规划器 |
| `src/agent/runtime.js` | 主执行编排器，串联 planner、tools、store、outbox、audit |
| `src/tools/registry.js` | 工具注册与执行入口 |
| `src/tools/auditQueryTool.js` | 复用现有审计查询能力 |
| `src/tools/reportTool.js` | 复用现有报表能力 |
| `src/adapters/http/app.js` | HTTP 路由，包含旧接口和新 Agent 接口 |
| `src/adapters/bot/callbackClient.js` | 向 Bot callback URL 发送出站事件 |
| `src/observability/runtimeAudit.js` | 为 Agent 运行时写入审计事件 |
| `scripts/server.js` | 启动数据库、runtime 和 HTTP server |
| `test/runtime/*.test.js` | 运行时单元与集成测试 |
| `test/http/*.test.js` | HTTP 接口测试 |

## Phase Map

| Design Phase | Plan Task |
|--------------|-----------|
| 阶段 1：Agent 运行骨架 | Task 1, Task 2 |
| 阶段 2：Bot 回调输出链路 | Task 3 |
| 阶段 3：规划器与工具注册表 | Task 4 |
| 阶段 4：等待用户与恢复执行 | Task 5 |
| 阶段 5：最终结果与飞书契约 | Task 5 |
| 阶段 6：审计、恢复、上线准备 | Task 6 |

---

### Task 1: Runtime Schema And State Foundation

**Files:**
- Create: `src/db/runtimeSchema.js`
- Create: `src/agent/stateMachine.js`
- Create: `src/agent/runStore.js`
- Test: `test/runtime/foundation.test.js`

**Interfaces:**
- Consumes: `openDb(dbPath: string): Database` from `scripts/lib/db.js`
- Produces: `ensureRuntimeSchema(db): void`
- Produces: `canTransition(from: string, to: string): boolean`
- Produces: `assertTransition(from: string, to: string): void`
- Produces: `createRunStore(db): { createRun(input), getRun(runId), updateRun(runId, patch), transitionRun(runId, nextStatus, patch), appendStep(step), listSteps(runId) }`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../scripts/lib/db.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { canTransition, assertTransition } from '../../src/agent/stateMachine.js';
import { createRunStore } from '../../src/agent/runStore.js';

test('runtime schema creates all agent tables', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-foundation-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);

  const rows = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'agent_runs',
      'agent_run_steps',
      'agent_waiting_states',
      'agent_outbox_events'
    )
    ORDER BY name
  `).all();

  assert.deepEqual(rows.map((row) => row.name), [
    'agent_outbox_events',
    'agent_run_steps',
    'agent_runs',
    'agent_waiting_states',
  ]);

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('state machine only allows supported transitions', () => {
  assert.equal(canTransition('created', 'planning'), true);
  assert.equal(canTransition('planning', 'running'), true);
  assert.equal(canTransition('running', 'waiting_user'), true);
  assert.equal(canTransition('waiting_user', 'running'), true);
  assert.equal(canTransition('running', 'completed'), true);
  assert.equal(canTransition('completed', 'running'), false);
  assert.throws(() => assertTransition('completed', 'running'));
});

test('run store creates and transitions runs', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-store-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const runStore = createRunStore(db);

  const created = runStore.createRun({
    channel: 'feishu',
    conversationId: 'oc_test',
    messageId: 'om_test',
    userOpenId: 'ou_test',
    requestText: '帮我处理异常任务',
    deliveryMode: 'callback',
    callbackUrl: 'http://127.0.0.1:9999/agent-events',
    metadata: { tenant_key: 'tenant_test' },
  });

  assert.equal(created.status, 'created');
  assert.equal(created.channel, 'feishu');
  assert.equal(created.user_open_id, 'ou_test');

  const planned = runStore.transitionRun(created.run_id, 'planning');
  assert.equal(planned.status, 'planning');

  runStore.appendStep({
    runId: created.run_id,
    stepIndex: 0,
    stepName: 'interpret-request',
    status: 'completed',
    toolName: null,
    inputJson: { text: '帮我处理异常任务' },
    outputJson: { intent: 'handle-exceptions' },
  });

  const steps = runStore.listSteps(created.run_id);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].step_name, 'interpret-request');

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/runtime/foundation.test.js`

Expected: FAIL with module not found errors for `src/db/runtimeSchema.js`, `src/agent/stateMachine.js`, or `src/agent/runStore.js`

- [ ] **Step 3: Write minimal implementation**

```js
// src/db/runtimeSchema.js
export const RUNTIME_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT,
  user_open_id TEXT NOT NULL,
  status TEXT NOT NULL,
  request_text TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,
  delivery_callback_url TEXT,
  metadata_json TEXT,
  plan_json TEXT,
  current_step_index INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_run_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL,
  tool_name TEXT,
  input_json TEXT,
  output_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_waiting_states (
  decision_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  context_json TEXT NOT NULL,
  requested_by_step INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_outbox_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,
  delivery_status TEXT NOT NULL,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  callback_url TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_updated_at ON agent_runs(updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_run_steps_run_id ON agent_run_steps(run_id, step_index);
CREATE INDEX IF NOT EXISTS idx_agent_waiting_states_run_id ON agent_waiting_states(run_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_outbox_events_status ON agent_outbox_events(delivery_status, created_at);
`;

export function ensureRuntimeSchema(db) {
  db.exec(RUNTIME_SCHEMA);
}
```

```js
// src/agent/stateMachine.js
export const RUN_STATUSES = [
  'created',
  'planning',
  'running',
  'waiting_user',
  'completed',
  'failed',
  'cancelled',
];

const ALLOWED_TRANSITIONS = {
  created: new Set(['planning', 'cancelled']),
  planning: new Set(['running', 'failed', 'cancelled']),
  running: new Set(['waiting_user', 'completed', 'failed', 'cancelled']),
  waiting_user: new Set(['running', 'failed', 'cancelled']),
  completed: new Set([]),
  failed: new Set([]),
  cancelled: new Set([]),
};

export function canTransition(from, to) {
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid run status transition: ${from} -> ${to}`);
  }
}
```

```js
// src/agent/runStore.js
import crypto from 'crypto';
import { assertTransition } from './stateMachine.js';

function nowIso() {
  return new Date().toISOString();
}

function parseJsonField(value) {
  return value ? JSON.parse(value) : null;
}

function hydrateRun(row) {
  if (!row) return null;
  return {
    ...row,
    metadata_json: parseJsonField(row.metadata_json),
    plan_json: parseJsonField(row.plan_json),
    result_json: parseJsonField(row.result_json),
  };
}

export function createRunStore(db) {
  const insertRunStmt = db.prepare(`
    INSERT INTO agent_runs (
      run_id, channel, conversation_id, message_id, user_open_id, status,
      request_text, delivery_mode, delivery_callback_url, metadata_json,
      plan_json, current_step_index, result_json, error_code, error_message,
      created_at, updated_at
    ) VALUES (
      @run_id, @channel, @conversation_id, @message_id, @user_open_id, @status,
      @request_text, @delivery_mode, @delivery_callback_url, @metadata_json,
      @plan_json, @current_step_index, @result_json, @error_code, @error_message,
      @created_at, @updated_at
    )
  `);

  const getRunStmt = db.prepare(`SELECT * FROM agent_runs WHERE run_id = ?`);
  const updateRunStmt = db.prepare(`
    UPDATE agent_runs
    SET status = @status,
        plan_json = @plan_json,
        current_step_index = @current_step_index,
        result_json = @result_json,
        error_code = @error_code,
        error_message = @error_message,
        updated_at = @updated_at
    WHERE run_id = @run_id
  `);

  const insertStepStmt = db.prepare(`
    INSERT INTO agent_run_steps (
      run_id, step_index, step_name, status, tool_name,
      input_json, output_json, started_at, finished_at
    ) VALUES (
      @run_id, @step_index, @step_name, @status, @tool_name,
      @input_json, @output_json, @started_at, @finished_at
    )
  `);

  const listStepsStmt = db.prepare(`
    SELECT *
    FROM agent_run_steps
    WHERE run_id = ?
    ORDER BY step_index ASC, id ASC
  `);

  return {
    createRun(input) {
      const timestamp = nowIso();
      const runId = `run_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
      insertRunStmt.run({
        run_id: runId,
        channel: input.channel,
        conversation_id: input.conversationId,
        message_id: input.messageId,
        user_open_id: input.userOpenId,
        status: 'created',
        request_text: input.requestText,
        delivery_mode: input.deliveryMode,
        delivery_callback_url: input.callbackUrl,
        metadata_json: JSON.stringify(input.metadata ?? {}),
        plan_json: null,
        current_step_index: 0,
        result_json: null,
        error_code: null,
        error_message: null,
        created_at: timestamp,
        updated_at: timestamp,
      });
      return hydrateRun(getRunStmt.get(runId));
    },

    getRun(runId) {
      return hydrateRun(getRunStmt.get(runId));
    },

    updateRun(runId, patch) {
      const current = this.getRun(runId);
      if (!current) throw new Error(`Run not found: ${runId}`);
      updateRunStmt.run({
        run_id: runId,
        status: patch.status ?? current.status,
        plan_json: JSON.stringify(patch.plan ?? current.plan_json),
        current_step_index: patch.currentStepIndex ?? current.current_step_index,
        result_json: JSON.stringify(patch.result ?? current.result_json),
        error_code: patch.errorCode ?? current.error_code,
        error_message: patch.errorMessage ?? current.error_message,
        updated_at: nowIso(),
      });
      return this.getRun(runId);
    },

    transitionRun(runId, nextStatus, patch = {}) {
      const current = this.getRun(runId);
      if (!current) throw new Error(`Run not found: ${runId}`);
      assertTransition(current.status, nextStatus);
      return this.updateRun(runId, { ...patch, status: nextStatus });
    },

    appendStep(step) {
      const timestamp = nowIso();
      insertStepStmt.run({
        run_id: step.runId,
        step_index: step.stepIndex,
        step_name: step.stepName,
        status: step.status,
        tool_name: step.toolName,
        input_json: JSON.stringify(step.inputJson ?? null),
        output_json: JSON.stringify(step.outputJson ?? null),
        started_at: step.startedAt ?? timestamp,
        finished_at: step.finishedAt ?? timestamp,
      });
    },

    listSteps(runId) {
      return listStepsStmt.all(runId).map((row) => ({
        ...row,
        input_json: parseJsonField(row.input_json),
        output_json: parseJsonField(row.output_json),
      }));
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/runtime/foundation.test.js`

Expected: PASS with `3` passing tests and `0` failing tests

- [ ] **Step 5: Commit**

```bash
git add src/db/runtimeSchema.js src/agent/stateMachine.js src/agent/runStore.js test/runtime/foundation.test.js
git commit -m "feat: add agent runtime schema and state foundation"
```

### Task 2: Add Run Creation And Status HTTP APIs

**Files:**
- Create: `src/app/loadConfig.js`
- Create: `src/adapters/http/app.js`
- Modify: `scripts/server.js`
- Test: `test/http/runs-api.test.js`

**Interfaces:**
- Consumes: `ensureRuntimeSchema(db): void`
- Consumes: `createRunStore(db)`
- Produces: `loadAppConfig(rootDir): { dbPath, agents }`
- Produces: `createHttpApp({ db, config, runStore, runtime }): http.Server`
- Produces: `POST /v1/runs`
- Produces: `GET /v1/runs/:runId`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../scripts/lib/db.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { createRunStore } from '../../src/agent/runStore.js';
import { createHttpApp } from '../../src/adapters/http/app.js';

test('POST /v1/runs creates a run and GET /v1/runs/:id returns it', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-http-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const runStore = createRunStore(db);

  const server = createHttpApp({
    db,
    config: { dbPath: path.join(tmpDir, 'runtime.db'), agents: {} },
    runStore,
    runtime: {
      async startRun(input) {
        return runStore.createRun(input);
      },
      async getRun(runId) {
        return runStore.getRun(runId);
      },
    },
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const createResponse = await fetch(`${baseUrl}/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      channel: 'feishu',
      conversation_id: 'oc_test',
      message_id: 'om_test',
      user: { open_id: 'ou_test', name: 'Alice' },
      request: { text: '帮我查询今天的异常任务并给出处理建议', attachments: [] },
      delivery: { mode: 'callback', callback_url: 'http://127.0.0.1:9999/agent-events' },
      metadata: { tenant_key: 'tenant_test' },
    }),
  });

  assert.equal(createResponse.status, 202);
  const created = await createResponse.json();
  assert.equal(created.status, 'created');
  assert.ok(created.run_id.startsWith('run_'));

  const readResponse = await fetch(`${baseUrl}/v1/runs/${created.run_id}`);
  assert.equal(readResponse.status, 200);
  const run = await readResponse.json();
  assert.equal(run.run_id, created.run_id);
  assert.equal(run.user_open_id, 'ou_test');

  server.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/http/runs-api.test.js`

Expected: FAIL with missing export or route implementation errors for `createHttpApp`

- [ ] **Step 3: Write minimal implementation**

```js
// src/app/loadConfig.js
import fs from 'fs';
import path from 'path';

export function loadAppConfig(rootDir) {
  const configPath = path.join(rootDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json not found at ${configPath}`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}
```

```js
// src/adapters/http/app.js
import http from 'http';
import { queryEvents, dailySummary, errorReport, toolUsageStats } from '../../../scripts/lib/db.js';

function json(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? JSON.parse(raw) : {};
}

function parseUrl(req) {
  return new URL(req.url, 'http://127.0.0.1');
}

export function createHttpApp({ db, config, runStore, runtime }) {
  return http.createServer(async (req, res) => {
    const url = parseUrl(req);

    if (req.method === 'OPTIONS') {
      json(res, 204, {});
      return;
    }

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, { status: 'ok', dbPath: config.dbPath });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/query') {
        const filters = Object.fromEntries(url.searchParams.entries());
        if (filters.limit) filters.limit = Number(filters.limit);
        json(res, 200, { count: queryEvents(db, filters).length, results: queryEvents(db, filters) });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/report/daily') {
        const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
        json(res, 200, { date, results: dailySummary(db, date) });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/report/errors') {
        const from = url.searchParams.get('from') ?? '1970-01-01';
        const to = url.searchParams.get('to') ?? '2099-12-31';
        const agentId = url.searchParams.get('agent_id') ?? undefined;
        json(res, 200, { from, to, results: errorReport(db, from, to, agentId) });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/report/tools') {
        const from = url.searchParams.get('from') ?? '1970-01-01';
        const to = url.searchParams.get('to') ?? '2099-12-31';
        const agentId = url.searchParams.get('agent_id') ?? undefined;
        json(res, 200, { from, to, results: toolUsageStats(db, from, to, agentId) });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/runs') {
        const body = await readJson(req);
        const created = await runtime.startRun({
          channel: body.channel,
          conversationId: body.conversation_id,
          messageId: body.message_id,
          userOpenId: body.user?.open_id,
          requestText: body.request?.text,
          deliveryMode: body.delivery?.mode,
          callbackUrl: body.delivery?.callback_url,
          metadata: body.metadata,
        });
        json(res, 202, { run_id: created.run_id, status: created.status });
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/v1/runs/')) {
        const runId = url.pathname.split('/').pop();
        const run = await runtime.getRun(runId);
        if (!run) {
          json(res, 404, { error: 'Run not found' });
          return;
        }
        json(res, 200, run);
        return;
      }

      json(res, 404, { error: 'Not found' });
    } catch (error) {
      json(res, 500, { error: error.message });
    }
  });
}
```

```js
// scripts/server.js
import path from 'path';
import { fileURLToPath } from 'url';
import { openDb } from './lib/db.js';
import { ensureRuntimeSchema } from '../src/db/runtimeSchema.js';
import { createRunStore } from '../src/agent/runStore.js';
import { createHttpApp } from '../src/adapters/http/app.js';
import { loadAppConfig } from '../src/app/loadConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const config = loadAppConfig(rootDir);
const dbPath = path.resolve(rootDir, config.dbPath);
const db = openDb(dbPath);
ensureRuntimeSchema(db);

const runStore = createRunStore(db);
const runtime = {
  async startRun(input) {
    return runStore.createRun(input);
  },
  async getRun(runId) {
    return runStore.getRun(runId);
  },
};

const app = createHttpApp({ db, config: { ...config, dbPath }, runStore, runtime });
const portIndex = process.argv.indexOf('--port');
const portArg = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 9320;
const port = Number.isFinite(portArg) ? portArg : 9320;

app.listen(port, '127.0.0.1', () => {
  console.log(`Agent API on http://127.0.0.1:${port}`);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/http/runs-api.test.js`

Expected: PASS with `1` passing test and `0` failing tests

- [ ] **Step 5: Commit**

```bash
git add src/app/loadConfig.js src/adapters/http/app.js scripts/server.js test/http/runs-api.test.js
git commit -m "feat: add run creation and status APIs"
```

### Task 3: Add Reliable Bot Callback Outbox

**Files:**
- Create: `src/agent/outboxStore.js`
- Create: `src/adapters/bot/callbackClient.js`
- Create: `src/agent/eventPublisher.js`
- Test: `test/runtime/outbox.test.js`

**Interfaces:**
- Consumes: `createRunStore(db)`
- Produces: `createOutboxStore(db): { enqueue(event), markDelivered(eventId), markFailed(eventId, error), listPending(limit) }`
- Produces: `createCallbackClient({ fetchImpl }): { send(url, payload): Promise<void> }`
- Produces: `createEventPublisher({ outboxStore, callbackClient }): { enqueueRunEvent(run, type, payload), flushPending(limit): Promise<void> }`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { openDb } from '../../scripts/lib/db.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { createOutboxStore } from '../../src/agent/outboxStore.js';
import { createCallbackClient } from '../../src/adapters/bot/callbackClient.js';
import { createEventPublisher } from '../../src/agent/eventPublisher.js';

test('outbox event is delivered to callback url and marked delivered', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-outbox-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const outboxStore = createOutboxStore(db);

  let receivedBody = null;
  const sink = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
  const { port } = sink.address();
  const callbackUrl = `http://127.0.0.1:${port}/agent-events`;

  const callbackClient = createCallbackClient({ fetchImpl: fetch });
  const publisher = createEventPublisher({ outboxStore, callbackClient });

  publisher.enqueueRunEvent(
    { run_id: 'run_test', delivery_mode: 'callback', delivery_callback_url: callbackUrl },
    'progress_update',
    { type: 'progress_update', run_id: 'run_test', title: '处理中', summary: '已完成 1/3' },
  );

  const pendingBefore = outboxStore.listPending(10);
  assert.equal(pendingBefore.length, 1);

  await publisher.flushPending(10);

  const pendingAfter = outboxStore.listPending(10);
  assert.equal(pendingAfter.length, 0);
  assert.equal(receivedBody.type, 'progress_update');
  assert.equal(receivedBody.run_id, 'run_test');

  sink.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/runtime/outbox.test.js`

Expected: FAIL with missing module errors for outbox or callback delivery helpers

- [ ] **Step 3: Write minimal implementation**

```js
// src/agent/outboxStore.js
import crypto from 'crypto';

function nowIso() {
  return new Date().toISOString();
}

export function createOutboxStore(db) {
  const insertStmt = db.prepare(`
    INSERT INTO agent_outbox_events (
      event_id, run_id, type, payload_json, delivery_mode,
      delivery_status, delivery_attempts, callback_url,
      last_error, created_at, delivered_at
    ) VALUES (
      @event_id, @run_id, @type, @payload_json, @delivery_mode,
      @delivery_status, @delivery_attempts, @callback_url,
      @last_error, @created_at, @delivered_at
    )
  `);

  const listStmt = db.prepare(`
    SELECT *
    FROM agent_outbox_events
    WHERE delivery_status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `);

  const deliveredStmt = db.prepare(`
    UPDATE agent_outbox_events
    SET delivery_status = 'delivered',
        delivery_attempts = delivery_attempts + 1,
        delivered_at = @delivered_at,
        last_error = NULL
    WHERE event_id = @event_id
  `);

  const failedStmt = db.prepare(`
    UPDATE agent_outbox_events
    SET delivery_status = 'pending',
        delivery_attempts = delivery_attempts + 1,
        last_error = @last_error
    WHERE event_id = @event_id
  `);

  return {
    enqueue(event) {
      insertStmt.run({
        event_id: `evt_${crypto.randomUUID()}`,
        run_id: event.runId,
        type: event.type,
        payload_json: JSON.stringify(event.payload),
        delivery_mode: event.deliveryMode,
        delivery_status: 'pending',
        delivery_attempts: 0,
        callback_url: event.callbackUrl,
        last_error: null,
        created_at: nowIso(),
        delivered_at: null,
      });
    },

    listPending(limit = 20) {
      return listStmt.all(limit).map((row) => ({
        ...row,
        payload_json: JSON.parse(row.payload_json),
      }));
    },

    markDelivered(eventId) {
      deliveredStmt.run({ event_id: eventId, delivered_at: nowIso() });
    },

    markFailed(eventId, error) {
      failedStmt.run({ event_id: eventId, last_error: error.message });
    },
  };
}
```

```js
// src/adapters/bot/callbackClient.js
export function createCallbackClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required');
  }

  return {
    async send(url, payload) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Bot callback failed with HTTP ${response.status}`);
      }
    },
  };
}
```

```js
// src/agent/eventPublisher.js
export function createEventPublisher({ outboxStore, callbackClient }) {
  return {
    enqueueRunEvent(run, type, payload) {
      outboxStore.enqueue({
        runId: run.run_id,
        type,
        payload,
        deliveryMode: run.delivery_mode,
        callbackUrl: run.delivery_callback_url,
      });
    },

    async flushPending(limit = 20) {
      const pending = outboxStore.listPending(limit);
      for (const event of pending) {
        try {
          await callbackClient.send(event.callback_url, event.payload_json);
          outboxStore.markDelivered(event.event_id);
        } catch (error) {
          outboxStore.markFailed(event.event_id, error);
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/runtime/outbox.test.js`

Expected: PASS with `1` passing test and `0` failing tests

- [ ] **Step 5: Commit**

```bash
git add src/agent/outboxStore.js src/adapters/bot/callbackClient.js src/agent/eventPublisher.js test/runtime/outbox.test.js
git commit -m "feat: add bot callback outbox delivery"
```

### Task 4: Add Constrained Planner And Tool Registry

**Files:**
- Create: `src/tools/registry.js`
- Create: `src/tools/auditQueryTool.js`
- Create: `src/tools/reportTool.js`
- Create: `src/agent/planner.js`
- Test: `test/runtime/planner.test.js`

**Interfaces:**
- Consumes: `queryEvents(db, filters)`, `dailySummary(db, date, agentId)`, `errorReport(db, from, to, agentId)` from `scripts/lib/db.js`
- Produces: `createToolRegistry(): { register(tool), execute(name, input, context), has(name) }`
- Produces: `buildAuditQueryTool({ db }): { name, execute(input) }`
- Produces: `buildReportTool({ db }): { name, execute(input) }`
- Produces: `createPlanner({ now }): { createInitialPlan(input), resumeFromDecision(waitingContext, response), synthesizeFinalResult(context) }`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb, insertEvents } from '../../scripts/lib/db.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { buildAuditQueryTool } from '../../src/tools/auditQueryTool.js';
import { buildReportTool } from '../../src/tools/reportTool.js';
import { createPlanner } from '../../src/agent/planner.js';

test('planner asks for decision when request scope is ambiguous', async () => {
  const planner = createPlanner({ now: () => '2026-07-02T09:00:00.000+08:00' });
  const result = await planner.createInitialPlan({
    requestText: '帮我处理异常任务',
    metadata: {},
  });

  assert.equal(result.type, 'decision_request');
  assert.equal(result.decision.options.length, 2);
});

test('planner returns executable plan for today error analysis request', async () => {
  const planner = createPlanner({ now: () => '2026-07-02T09:00:00.000+08:00' });
  const result = await planner.createInitialPlan({
    requestText: '帮我查询今天的异常任务并给出处理建议',
    metadata: {},
  });

  assert.equal(result.type, 'plan');
  assert.equal(result.plan.steps[0].toolName, 'audit.queryEvents');
  assert.equal(result.plan.steps[1].toolName, 'report.errorSummary');
});

test('tool registry executes registered audit tool', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  insertEvents(db, [{
    ts: '2026-07-02T08:00:00.000+08:00',
    agent_id: 'feishu-agent',
    trace_id: 't1',
    span_id: 's1',
    parent_span_id: null,
    event: 'tool.error',
    tool_name: 'demo.tool',
    status: 'error',
    result_summary: 'demo failed',
    duration_ms: 12,
    channel: 'feishu',
    user_id: 'ou_test',
    product_id: null,
    error_code: 'DEMO',
    error_message: 'demo error',
    tags: null,
    raw_json: JSON.stringify({
      ts: '2026-07-02T08:00:00.000+08:00',
      agent_id: 'feishu-agent',
      trace_id: 't1',
      span_id: 's1',
      event: 'tool.error',
      tool_name: 'demo.tool',
      status: 'error',
      result_summary: 'demo failed'
    }),
  }]);

  const registry = createToolRegistry();
  registry.register(buildAuditQueryTool({ db }));
  registry.register(buildReportTool({ db }));

  const rows = await registry.execute('audit.queryEvents', { status: 'error' }, {});
  assert.equal(rows.length, 1);

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/runtime/planner.test.js`

Expected: FAIL with missing planner or registry modules

- [ ] **Step 3: Write minimal implementation**

```js
// src/tools/registry.js
export function createToolRegistry() {
  const tools = new Map();

  return {
    register(tool) {
      if (!tool?.name || typeof tool.execute !== 'function') {
        throw new Error('Invalid tool definition');
      }
      tools.set(tool.name, tool);
    },

    has(name) {
      return tools.has(name);
    },

    async execute(name, input, context) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      return tool.execute(input, context);
    },
  };
}
```

```js
// src/tools/auditQueryTool.js
import { queryEvents } from '../../scripts/lib/db.js';

export function buildAuditQueryTool({ db }) {
  return {
    name: 'audit.queryEvents',
    async execute(input) {
      return queryEvents(db, input);
    },
  };
}
```

```js
// src/tools/reportTool.js
import { errorReport } from '../../scripts/lib/db.js';

export function buildReportTool({ db }) {
  return {
    name: 'report.errorSummary',
    async execute(input) {
      return errorReport(db, input.from, input.to, input.agentId);
    },
  };
}
```

```js
// src/agent/planner.js
function dayRange(nowIso) {
  const date = nowIso.slice(0, 10);
  return {
    from: `${date}T00:00:00.000+08:00`,
    to: `${date}T23:59:59.999+08:00`,
  };
}

export function createPlanner({ now = () => new Date().toISOString() } = {}) {
  return {
    async createInitialPlan(input) {
      const text = input.requestText ?? '';
      const scopeKnown = text.includes('今天') || text.includes('今日') || text.includes('全部');

      if (text.includes('异常') && !scopeKnown) {
        return {
          type: 'decision_request',
          decision: {
            title: '需要确认处理范围',
            summary: '当前请求未明确范围，请先选择处理今天的异常，还是处理全部异常。',
            options: [
              { id: 'today_only', label: '只处理今天', description: '优先处理当天问题' },
              { id: 'all_errors', label: '处理全部异常', description: '覆盖全部历史异常' },
            ],
            formSchema: [],
            submitLabel: '继续执行',
          },
        };
      }

      const range = dayRange(now());
      return {
        type: 'plan',
        plan: {
          steps: [
            {
              stepName: 'load-errors',
              toolName: 'audit.queryEvents',
              input: text.includes('全部')
                ? { status: 'error', limit: 100 }
                : { status: 'error', from: range.from, to: range.to, limit: 100 },
            },
            {
              stepName: 'summarize-errors',
              toolName: 'report.errorSummary',
              input: text.includes('全部')
                ? { from: '1970-01-01', to: '2099-12-31', agentId: undefined }
                : { from: range.from, to: range.to, agentId: undefined },
            },
          ],
        },
      };
    },

    async resumeFromDecision(waitingContext, response) {
      const selected = response.selected_option;
      const nowIso = now();
      const range = dayRange(nowIso);

      if (selected === 'today_only') {
        return {
          type: 'plan',
          plan: {
            steps: [
              { stepName: 'load-errors', toolName: 'audit.queryEvents', input: { status: 'error', from: range.from, to: range.to, limit: 100 } },
              { stepName: 'summarize-errors', toolName: 'report.errorSummary', input: { from: range.from, to: range.to, agentId: undefined } },
            ],
          },
        };
      }

      return {
        type: 'plan',
        plan: {
          steps: [
            { stepName: 'load-errors', toolName: 'audit.queryEvents', input: { status: 'error', limit: 100 } },
            { stepName: 'summarize-errors', toolName: 'report.errorSummary', input: { from: '1970-01-01', to: '2099-12-31', agentId: undefined } },
          ],
        },
      };
    },

    async synthesizeFinalResult(context) {
      const errorRows = context.toolResults.find((item) => item.stepName === 'load-errors')?.result ?? [];
      const summaryRows = context.toolResults.find((item) => item.stepName === 'summarize-errors')?.result ?? [];
      const urgentCount = errorRows.slice(0, 5).length;

      return {
        type: 'final_result',
        status: 'completed',
        title: '异常任务分析已完成',
        summary: `共发现 ${errorRows.length} 条异常，建议优先处理前 ${urgentCount} 条。`,
        details_markdown: summaryRows.length === 0
          ? '未查询到异常记录。'
          : summaryRows.map((row, index) => `${index + 1}. ${row.tool_name} | ${row.result_summary}`).join('\n'),
        actions: [{ id: 'view_trace', label: '查看执行轨迹' }],
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/runtime/planner.test.js`

Expected: PASS with `3` passing tests and `0` failing tests

- [ ] **Step 5: Commit**

```bash
git add src/tools/registry.js src/tools/auditQueryTool.js src/tools/reportTool.js src/agent/planner.js test/runtime/planner.test.js
git commit -m "feat: add constrained planner and tool registry"
```

### Task 5: Implement Runtime Execution, Waiting, Resume, And Final Result

**Files:**
- Create: `src/agent/waitStore.js`
- Create: `src/agent/payloads.js`
- Create: `src/agent/runtime.js`
- Modify: `src/adapters/http/app.js`
- Test: `test/runtime/runtime.test.js`

**Interfaces:**
- Consumes: `createRunStore(db)`
- Consumes: `createOutboxStore(db)`
- Consumes: `createPlanner({ now })`
- Consumes: `createToolRegistry()`
- Consumes: `createEventPublisher({ outboxStore, callbackClient })`
- Produces: `createWaitStore(db): { createWaitingState(input), getWaitingState(decisionId), resolveWaitingState(decisionId) }`
- Produces: `createProgressPayload(run, summary, currentStep, totalSteps): object`
- Produces: `createDecisionPayload(run, decisionId, decision): object`
- Produces: `createRuntime(deps): { startRun(input), getRun(runId), resumeRun(runId, body) }`
- Produces: `POST /v1/runs/:runId/resume`

- [ ] **Step 1: Write the failing test**

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
import { createPlanner } from '../../src/agent/planner.js';
import { createRuntime } from '../../src/agent/runtime.js';
import { createToolRegistry } from '../../src/tools/registry.js';

test('runtime pauses for user decision and resumes to final result', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runtime-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);

  const runStore = createRunStore(db);
  const outboxStore = createOutboxStore(db);
  const waitStore = createWaitStore(db);
  const eventPublisher = createEventPublisher({
    outboxStore,
    callbackClient: { async send() {} },
  });

  const registry = createToolRegistry();
  registry.register({
    name: 'audit.queryEvents',
    async execute() {
      return [{ tool_name: 'demo.tool', result_summary: 'demo failed' }];
    },
  });
  registry.register({
    name: 'report.errorSummary',
    async execute() {
      return [{ tool_name: 'demo.tool', result_summary: 'demo failed' }];
    },
  });

  const runtime = createRuntime({
    runStore,
    outboxStore,
    waitStore,
    planner: createPlanner({ now: () => '2026-07-02T09:00:00.000+08:00' }),
    registry,
    eventPublisher,
    auditLogger: { async log() {} },
  });

  const created = await runtime.startRun({
    channel: 'feishu',
    conversationId: 'oc_test',
    messageId: 'om_test',
    userOpenId: 'ou_test',
    requestText: '帮我处理异常任务',
    deliveryMode: 'callback',
    callbackUrl: 'http://127.0.0.1:9999/agent-events',
    metadata: {},
  });

  const waitingRun = runtime.getRun(created.run_id);
  assert.equal(waitingRun.status, 'waiting_user');

  const decisionEvent = outboxStore.listPending(10).find((event) => event.type === 'decision_request');
  assert.ok(decisionEvent);

  await runtime.resumeRun(created.run_id, {
    decision_id: decisionEvent.payload_json.decision_id,
    user: { open_id: 'ou_test' },
    response: { selected_option: 'today_only', form_data: {} },
  });

  const completedRun = runtime.getRun(created.run_id);
  assert.equal(completedRun.status, 'completed');

  const finalEvent = outboxStore.listPending(10).find((event) => event.type === 'final_result');
  assert.ok(finalEvent);

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/runtime/runtime.test.js`

Expected: FAIL with missing runtime orchestration or waiting-state helpers

- [ ] **Step 3: Write minimal implementation**

```js
// src/agent/waitStore.js
import crypto from 'crypto';

function nowIso() {
  return new Date().toISOString();
}

export function createWaitStore(db) {
  const insertStmt = db.prepare(`
    INSERT INTO agent_waiting_states (
      decision_id, run_id, schema_json, context_json,
      requested_by_step, status, created_at, resolved_at
    ) VALUES (
      @decision_id, @run_id, @schema_json, @context_json,
      @requested_by_step, @status, @created_at, @resolved_at
    )
  `);

  const getStmt = db.prepare(`SELECT * FROM agent_waiting_states WHERE decision_id = ?`);
  const resolveStmt = db.prepare(`
    UPDATE agent_waiting_states
    SET status = 'resolved', resolved_at = @resolved_at
    WHERE decision_id = @decision_id
  `);

  return {
    createWaitingState(input) {
      const decisionId = input.decisionId ?? `dec_${crypto.randomUUID()}`;
      insertStmt.run({
        decision_id: decisionId,
        run_id: input.runId,
        schema_json: JSON.stringify(input.schemaJson),
        context_json: JSON.stringify(input.contextJson),
        requested_by_step: input.requestedByStep,
        status: 'pending',
        created_at: nowIso(),
        resolved_at: null,
      });
      return decisionId;
    },

    getWaitingState(decisionId) {
      const row = getStmt.get(decisionId);
      if (!row) return null;
      return {
        ...row,
        schema_json: JSON.parse(row.schema_json),
        context_json: JSON.parse(row.context_json),
      };
    },

    resolveWaitingState(decisionId) {
      resolveStmt.run({ decision_id: decisionId, resolved_at: nowIso() });
    },
  };
}
```

```js
// src/agent/payloads.js
export function createProgressPayload(run, summary, currentStep, totalSteps) {
  return {
    type: 'progress_update',
    run_id: run.run_id,
    title: '任务执行中',
    summary,
    progress: { current_step: currentStep, total_steps: totalSteps },
  };
}

export function createDecisionPayload(run, decisionId, decision) {
  return {
    type: 'decision_request',
    run_id: run.run_id,
    decision_id: decisionId,
    title: decision.title,
    summary: decision.summary,
    options: decision.options,
    form_schema: decision.formSchema,
    submit_label: decision.submitLabel,
  };
}

export function createFinalResultPayload(run, result) {
  return {
    ...result,
    run_id: run.run_id,
  };
}
```

```js
// src/agent/runtime.js
import { createDecisionPayload, createFinalResultPayload, createProgressPayload } from './payloads.js';

export function createRuntime({ runStore, outboxStore, waitStore, planner, registry, eventPublisher, auditLogger }) {
  return {
    getRun(runId) {
      return runStore.getRun(runId);
    },

    async startRun(input) {
      const created = runStore.createRun(input);
      await auditLogger.log({ runId: created.run_id, event: 'run.start', status: 'ok', summary: 'Run created' });
      return this.#planAndExecute(created.run_id);
    },

    async resumeRun(runId, body) {
      const run = runStore.getRun(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);
      const waiting = waitStore.getWaitingState(body.decision_id);
      if (!waiting || waiting.run_id !== runId || waiting.status !== 'pending') {
        throw new Error('Waiting state not found or already resolved');
      }

      waitStore.resolveWaitingState(body.decision_id);
      const planning = await planner.resumeFromDecision(waiting.context_json, body.response);
      runStore.transitionRun(runId, 'running', { plan: planning.plan });
      await auditLogger.log({ runId, event: 'run.resume', status: 'ok', summary: 'Run resumed from user decision' });
      return this.#executePlan(runId, planning.plan);
    },

    async #planAndExecute(runId) {
      const run = runStore.transitionRun(runId, 'planning');
      const decision = await planner.createInitialPlan({
        requestText: run.request_text,
        metadata: run.metadata_json,
      });

      if (decision.type === 'decision_request') {
        const decisionId = waitStore.createWaitingState({
          runId,
          schemaJson: decision.decision,
          contextJson: { requestText: run.request_text, metadata: run.metadata_json },
          requestedByStep: 0,
        });
        const waitingRun = runStore.transitionRun(runId, 'waiting_user');
        eventPublisher.enqueueRunEvent(waitingRun, 'decision_request', createDecisionPayload(waitingRun, decisionId, decision.decision));
        await auditLogger.log({ runId, event: 'run.waiting_user', status: 'ok', summary: 'Run waiting for user input' });
        return waitingRun;
      }

      runStore.transitionRun(runId, 'running', { plan: decision.plan });
      return this.#executePlan(runId, decision.plan);
    },

    async #executePlan(runId, plan) {
      const run = runStore.getRun(runId);
      const toolResults = [];

      for (let index = 0; index < plan.steps.length; index += 1) {
        const step = plan.steps[index];
        const progressPayload = createProgressPayload(run, `正在执行 ${step.stepName}`, index + 1, plan.steps.length);
        eventPublisher.enqueueRunEvent(run, 'progress_update', progressPayload);

        const result = await registry.execute(step.toolName, step.input, { runId });
        toolResults.push({ stepName: step.stepName, result });
        runStore.appendStep({
          runId,
          stepIndex: index,
          stepName: step.stepName,
          status: 'completed',
          toolName: step.toolName,
          inputJson: step.input,
          outputJson: result,
        });
      }

      const finalResult = await planner.synthesizeFinalResult({ runId, toolResults });
      const completedRun = runStore.transitionRun(runId, 'completed', { result: finalResult, currentStepIndex: plan.steps.length });
      eventPublisher.enqueueRunEvent(completedRun, 'final_result', createFinalResultPayload(completedRun, finalResult));
      await auditLogger.log({ runId, event: 'run.final_result', status: 'ok', summary: finalResult.summary });
      return completedRun;
    },
  };
}
```

```js
// append to src/adapters/http/app.js
      if (req.method === 'POST' && url.pathname.startsWith('/v1/runs/') && url.pathname.endsWith('/resume')) {
        const runId = url.pathname.split('/')[3];
        const body = await readJson(req);
        const run = await runtime.resumeRun(runId, body);
        json(res, 202, { run_id: run.run_id, status: run.status });
        return;
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/runtime/runtime.test.js`

Expected: PASS with `1` passing test and `0` failing tests

- [ ] **Step 5: Commit**

```bash
git add src/agent/waitStore.js src/agent/payloads.js src/agent/runtime.js src/adapters/http/app.js test/runtime/runtime.test.js
git commit -m "feat: add runtime execution and resume flow"
```

### Task 6: Wire Runtime Audit, Background Delivery, And Full Server Boot

**Files:**
- Create: `src/observability/runtimeAudit.js`
- Modify: `scripts/server.js`
- Modify: `package.json`
- Test: `test/runtime/audit.test.js`

**Interfaces:**
- Consumes: `insertEvents(db, events)` from `scripts/lib/db.js`
- Consumes: `createRuntime(...)`
- Produces: `createRuntimeAuditLogger(db, options): { log(event): Promise<void> }`
- Produces: server boot that assembles `runStore`, `waitStore`, `outboxStore`, `planner`, `registry`, `runtime`, and delivery flusher
- Produces: `npm run test:agent`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb, queryEvents } from '../../scripts/lib/db.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { createRuntimeAuditLogger } from '../../src/observability/runtimeAudit.js';

test('runtime audit logger writes run lifecycle events into audit_events', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-audit-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const auditLogger = createRuntimeAuditLogger(db, { agentId: 'feishu-independent-agent' });

  await auditLogger.log({
    runId: 'run_test',
    traceId: 'trace_test',
    event: 'run.start',
    status: 'ok',
    summary: 'Run created',
  });

  const rows = queryEvents(db, { agent_id: 'feishu-independent-agent' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'run.start');
  assert.equal(rows[0].result_summary, 'Run created');

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/runtime/audit.test.js`

Expected: FAIL with missing runtime audit logger implementation

- [ ] **Step 3: Write minimal implementation**

```js
// src/observability/runtimeAudit.js
import crypto from 'crypto';
import { insertEvents } from '../../scripts/lib/db.js';

export function createRuntimeAuditLogger(db, { agentId = 'feishu-independent-agent' } = {}) {
  return {
    async log({ runId, traceId = null, event, status, summary, toolName = 'agent.runtime' }) {
      insertEvents(db, [{
        ts: new Date().toISOString(),
        agent_id: agentId,
        trace_id: traceId ?? `trace_${runId}`,
        span_id: crypto.randomUUID(),
        parent_span_id: null,
        event,
        tool_name: toolName,
        status,
        result_summary: summary,
        duration_ms: null,
        channel: 'feishu',
        user_id: null,
        product_id: null,
        error_code: null,
        error_message: null,
        tags: JSON.stringify(['agent-runtime']),
        raw_json: JSON.stringify({
          ts: new Date().toISOString(),
          agent_id: agentId,
          trace_id: traceId ?? `trace_${runId}`,
          event,
          tool_name: toolName,
          status,
          result_summary: summary,
        }),
      }]);
    },
  };
}
```

```js
// replace scripts/server.js
import path from 'path';
import { fileURLToPath } from 'url';
import { openDb } from './lib/db.js';
import { ensureRuntimeSchema } from '../src/db/runtimeSchema.js';
import { createRunStore } from '../src/agent/runStore.js';
import { createWaitStore } from '../src/agent/waitStore.js';
import { createOutboxStore } from '../src/agent/outboxStore.js';
import { createPlanner } from '../src/agent/planner.js';
import { createRuntime } from '../src/agent/runtime.js';
import { createToolRegistry } from '../src/tools/registry.js';
import { buildAuditQueryTool } from '../src/tools/auditQueryTool.js';
import { buildReportTool } from '../src/tools/reportTool.js';
import { createCallbackClient } from '../src/adapters/bot/callbackClient.js';
import { createEventPublisher } from '../src/agent/eventPublisher.js';
import { createRuntimeAuditLogger } from '../src/observability/runtimeAudit.js';
import { createHttpApp } from '../src/adapters/http/app.js';
import { loadAppConfig } from '../src/app/loadConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const config = loadAppConfig(rootDir);
const dbPath = path.resolve(rootDir, config.dbPath);
const db = openDb(dbPath);
ensureRuntimeSchema(db);

const runStore = createRunStore(db);
const waitStore = createWaitStore(db);
const outboxStore = createOutboxStore(db);
const registry = createToolRegistry();
registry.register(buildAuditQueryTool({ db }));
registry.register(buildReportTool({ db }));

const eventPublisher = createEventPublisher({
  outboxStore,
  callbackClient: createCallbackClient({ fetchImpl: fetch }),
});

const runtime = createRuntime({
  runStore,
  outboxStore,
  waitStore,
  planner: createPlanner(),
  registry,
  eventPublisher,
  auditLogger: createRuntimeAuditLogger(db),
});

const app = createHttpApp({ db, config: { ...config, dbPath }, runStore, runtime });
const portIndex = process.argv.indexOf('--port');
const portArg = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 9320;
const port = Number.isFinite(portArg) ? portArg : 9320;

const flushInterval = setInterval(async () => {
  try {
    await eventPublisher.flushPending(20);
  } catch (error) {
    console.error(error.message);
  }
}, 1000);

app.listen(port, '127.0.0.1', () => {
  console.log(`Agent API on http://127.0.0.1:${port}`);
});

process.on('SIGINT', () => {
  clearInterval(flushInterval);
  db.close();
  process.exit(0);
});
```

```json
// package.json
{
  "name": "audit-logger-agent",
  "version": "1.0.0",
  "description": "Cross-agent audit log ingestion, query, and reporting tool",
  "type": "module",
  "main": "scripts/ingest.js",
  "scripts": {
    "ingest": "node scripts/ingest.js",
    "query": "node scripts/query.js",
    "report": "node scripts/report.js",
    "server": "node scripts/server.js",
    "test:agent": "node --test test/runtime/foundation.test.js test/http/runs-api.test.js test/runtime/outbox.test.js test/runtime/planner.test.js test/runtime/runtime.test.js test/runtime/audit.test.js && node test/self-test.js"
  },
  "dependencies": {
    "better-sqlite3": "^11.7.0"
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/runtime/audit.test.js`

Expected: PASS with `1` passing test and `0` failing tests

Run: `npm run test:agent`

Expected: all runtime tests pass, then `node test/self-test.js` passes, and the command exits with code `0`

- [ ] **Step 5: Commit**

```bash
git add src/observability/runtimeAudit.js scripts/server.js package.json test/runtime/audit.test.js
git commit -m "feat: wire feishu independent agent runtime"
```

## Self-Review

### Spec coverage

- 独立 Agent 服务边界：Task 2, Task 5, Task 6
- 运行状态机：Task 1
- Bot callback push：Task 3, Task 6
- 规划器与工具体系：Task 4
- 等待用户与恢复执行：Task 5
- 最终结果结构化输出：Task 5
- 审计与可观测性：Task 6

### Placeholder scan

- 未使用 `TODO`、`TBD`、`implement later`、`fill in details`
- 每个任务都给出了明确文件、接口、测试命令和实现代码块

### Type consistency

- `createRunStore`, `createOutboxStore`, `createWaitStore`, `createRuntime`, `createPlanner`, `createToolRegistry` 在各任务中的命名保持一致
- 运行状态命名统一使用 `created/planning/running/waiting_user/completed/failed/cancelled`
- 出站消息类型统一使用 `progress_update/decision_request/final_result`

## Risks To Watch During Implementation

- `scripts/server.js` 中运行时装配必须保持 `eventPublisher` 独立创建并注入 `runtime`，避免在定时刷新 Outbox 时引用未初始化对象。
- 第一版规划器是规则驱动的最小可用实现，不要在实现期额外扩大成 LLM 编排器，否则会破坏计划范围。
- `audit_events` 的 `event` 字段当前第一版校验主要围绕既有事件枚举，运行时新增 `run.start` 这类事件时，需要同步更新解析校验规则。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-02-feishu-independent-agent-mvp.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
