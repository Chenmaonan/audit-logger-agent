# v1.5 Generic Delivery And Audit Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将运行时和审查系统从飞书/Bot 语义中解耦，保留通用发送机制，同时移除置信度指标、补齐日志所属 Agent 名称与日志详情，并把 Dashboard 升级为统一结构、中文、只展示有内容数据的页面。

**Architecture:** v1.5 分成两条主线推进。第一条是运行时入口与投递链路泛化：去掉 `feishu`、`bot`、`user_open_id` 这一类平台定制语义，但继续复用 `agent_outbox_events` 和 callback 推送机制，把它们定位为通用投递能力。第二条是审查结果表达升级：LLM 输出收缩到“风险判断 + evidence event id”，本地代码补齐 evidence 明细，Dashboard 改为服务端直接灌入数据的中文组件系统，模板只负责渲染，不在浏览器端再拼装数据。

**Tech Stack:** Node.js ESM, `better-sqlite3`, `node:test`, 原生 HTTP, 自包含 HTML/CSS, 现有 SQLite schema migration 模式。

## Global Constraints

- 不新增运行时依赖，不引入前端框架或构建链。
- 发送机制必须保留：`agent_outbox_events`、重试、dead letter、callback 传输都继续存在，但不再把它描述为飞书/Bot 专用能力。
- 运行时公开接口、文档、测试、模块命名中不得再出现飞书/Bot 适配语义。
- 出于兼容性，数据库内部 legacy 列名可以暂时保留为存储细节，但这些名称不能继续出现在公共 HTTP API、文档、模块边界和测试叙述里。
- `confidence` 必须从 LLM schema、prompt、持久化写入、API 返回、通知 payload、Dashboard 和文档中移除。
- 除日志 ID 外，每条 evidence 必须至少包含 `agent_id`、`agent_name` 和结构化 `log_detail`。
- Dashboard 页面全部使用中文文案，新增数据只能通过向 view model 填数据接入，模板不能依赖浏览器端 `fetch()` 动态拉取。
- 没有内容的 metric、字段、section、link、evidence block 一律不渲染。
- 不展示 `raw_json`、原始 input/output 或潜在敏感参数，只展示脱敏后的日志摘要字段。
- 所有行为变更都要有 `node:test` 覆盖，并通过现有 audit-review 与 runtime 关键测试。

---

## Scope Notes

这份计划覆盖两个相邻子系统：

1. 运行时入口与投递解耦
2. 审查结果 schema、evidence 与 Dashboard 升级

它们共享的数据边界是：运行时继续产出和投递结构化 payload，审查系统继续把结果写入 outbox，但“谁来消费 payload”在 v1.5 里不再被写死成飞书/Bot。

## Current State Summary

- `src/adapters/bot/callbackClient.js` 和 `scripts/server.js` 仍把 callback 发送能力组织成 Bot 适配器。
- `src/adapters/http/app.js` 的 `POST /v1/runs` 仍要求 `conversation_id`、`user.open_id`、`delivery.callback_url` 这类 Bot 消息结构。
- `src/observability/runtimeAudit.js` 默认 `agentId = 'feishu-independent-agent'` 且日志 `channel = 'feishu'`。
- `src/auditReview/candidateDetector.js` 仍将 `feishu` 视作高危工具的默认可信来源，其它来源会被判为异常。
- `src/auditReview/reviewSchema.js`、`src/auditReview/llmReviewer.js`、`src/db/reviewSchema.js`、`src/auditReview/reviewStore.js`、`src/auditReview/scheduler.js`、`src/auditReview/visualization.js` 仍贯穿 `confidence`。
- `src/auditReview/dashboardTemplate.js` 目前靠浏览器端 `fetch(data_source)` 渲染，文案有英文，字段名直接来自 JSON key，空数据也会占位渲染。
- finding 详情页当前主要靠 `/query?trace_id=...` 回查日志，没有稳定的 `agent_name` 和本地整理后的 `log_detail`。

## Target File Structure

- Create: `src/adapters/delivery/callbackClient.js`
  - 通用 callback 投递客户端，取代 Bot 命名。
- Delete: `src/adapters/bot/callbackClient.js`
  - 去掉平台语义文件路径。
- Modify: `scripts/server.js`
  - 切换到通用 delivery adapter，去掉注释和依赖命名中的 Bot 语义。
- Modify: `src/agent/eventPublisher.js`
  - 参数命名与注释改为通用 delivery，不再叫 `callbackClient` 也可接受 `deliveryClient`。
- Modify: `src/adapters/http/app.js`
  - `POST /v1/runs` 改为通用请求 envelope，并可在一段过渡期内兼容 legacy shape。
- Modify: `src/agent/runStore.js`
  - 运行时对外字段命名泛化，内部可继续映射 legacy DB 列。
- Modify: `src/db/runtimeSchema.js`
  - 如果需要新增通用列，按现有 migration 模式做 guarded ALTER；如果不新增列，则明确 legacy 列只作为内部存储细节。
- Modify: `src/observability/runtimeAudit.js`
  - 默认 agent/channel 命名去飞书化。
- Modify: `src/auditReview/candidateDetector.js`
  - 去掉 `feishu` 硬编码，改成可配置可信来源或取消该特例。
- Modify: `src/auditReview/reviewSchema.js`
  - 移除 `confidence`。
- Modify: `src/auditReview/llmReviewer.js`
  - 移除 prompt 和 schema 对 `confidence` 的要求。
- Modify: `src/db/reviewSchema.js`
  - 新建库不再创建 `audit_review_findings.confidence`。
- Modify: `src/auditReview/reviewStore.js`
  - 读写 finding 时忽略 legacy `confidence`，解析 evidence JSON。
- Create: `src/auditReview/evidence.js`
  - 从候选事件构建结构化 evidence，补齐 `agent_name` 与 `log_detail`。
- Modify: `src/auditReview/scheduler.js`
  - 本地补齐 evidence 明细，不再写 confidence。
- Modify: `src/auditReview/notification.js`
  - 继续产出通用 outbox payload，但不再提飞书；payload 中可带 compact evidence 摘要。
- Modify: `src/auditReview/visualization.js`
  - 输出中文、直填数据的 dashboard view model。
- Modify: `src/auditReview/dashboardTemplate.js`
  - 统一组件、统一样式、服务端渲染、中文、按内容显隐。
- Modify tests:
  - `test/http/runs-api.test.js`
  - `test/runtime/foundation.test.js`
  - `test/runtime/outbox.test.js`
  - `test/runtime/runtime.test.js`
  - `test/runtime/fixes.test.js`
  - `test/runtime/audit.test.js`
  - `test/runtime/openaiRuntime.test.js`
  - `test/auditReview/reviewSchema.test.js`
  - `test/auditReview/reviewStore.test.js`
  - `test/auditReview/scheduler.test.js`
  - `test/auditReview/notification.test.js`
  - `test/auditReview/httpIntegration.test.js`
  - `test/auditReview/dashboardTemplate.test.js`
  - `test/auditReview/detector.test.js`
- Modify docs after implementation:
  - `README.md`
  - `v1.4/PERIODIC_LLM_AUDIT_REVIEW_DESIGN.md`

---

## Public Interfaces After v1.5

### Generic run submission API

`POST /v1/runs` 目标请求体：

```json
{
  "source": {
    "type": "manual",
    "session_id": "session_manual_001",
    "message_id": "msg_manual_001",
    "requester_id": "user_manual"
  },
  "request": {
    "text": "分析今天的审计异常并汇总风险最高的链路"
  },
  "delivery": {
    "mode": "callback",
    "target_url": "http://127.0.0.1:9999/agent-events"
  },
  "metadata": {
    "tenant_key": "tenant_manual"
  },
  "idempotency_key": "req-001"
}
```

过渡策略：

- v1.5 的 HTTP 层允许 legacy body 继续进入，但在 `app.js` 里立即规范化为新的内部对象。
- 文档、测试与新代码只使用新接口名，不再新增任何 `feishu`、`conversation_id`、`user.open_id`、`callback_url` 示例。

### Normalized runtime input

运行时内部使用的 input 形态：

```js
{
  sourceType: 'manual',
  sessionId: 'session_manual_001',
  messageId: 'msg_manual_001',
  requesterId: 'user_manual',
  requestText: '分析今天的审计异常并汇总风险最高的链路',
  deliveryMode: 'callback',
  deliveryTargetUrl: 'http://127.0.0.1:9999/agent-events',
  metadata: { tenant_key: 'tenant_manual' },
  idempotencyKey: 'req-001',
}
```

### Structured evidence shape

`src/auditReview/evidence.js` 产出的 evidence：

```js
{
  event_id: 123,
  agent_id: 'mt-agent',
  agent_name: 'MT 审计 Agent',
  tool_name: 'db.delete',
  trace_id: 'trace-del-1',
  span_id: 'span-del-1',
  log_detail: {
    ts: '2026-07-03T10:00:00.000Z',
    event: 'tool.end',
    status: 'ok',
    duration_ms: 120,
    product_id: 'product-1',
    result_summary: 'deleted 5 rows',
    error_code: null,
    error_message: null,
    reason: 'tool_name matches high-risk pattern'
  }
}
```

### Dashboard view model

`visualization.js` 直接把数据灌给模板：

```js
{
  page: {
    title: '审计审查总览',
    subtitle: '最近审查与风险概览',
    updated_at: '2026-07-03T10:30:00.000Z'
  },
  summary_metrics: [
    { label: '高风险', value: 3, tone: 'high' }
  ],
  sections: [
    {
      id: 'latest_findings',
      type: 'table',
      title: '最新风险发现',
      columns: [
        { key: 'severity_label', label: '严重程度' },
        { key: 'title', label: '标题' },
        { key: 'agent_name', label: 'Agent 名称' }
      ],
      rows: []
    }
  ]
}
```

模板规则：

- metric `value` 为 `0`、空字符串、`null`、`undefined` 时不渲染。
- table `rows.length === 0` 时整个 section 不渲染。
- definition list 中 value 为空时该字段不渲染。
- 页面没有可展示内容时只显示 `暂无可展示的审查数据`。

---

## Task 1: Genericize Runtime Ingress And Delivery

**Files:**
- Create: `src/adapters/delivery/callbackClient.js`
- Delete: `src/adapters/bot/callbackClient.js`
- Modify: `scripts/server.js`
- Modify: `src/agent/eventPublisher.js`
- Modify: `src/adapters/http/app.js`
- Modify: `src/agent/runStore.js`
- Modify: `src/observability/runtimeAudit.js`
- Modify: `src/auditReview/candidateDetector.js`
- Test: `test/http/runs-api.test.js`
- Test: `test/runtime/foundation.test.js`
- Test: `test/runtime/outbox.test.js`
- Test: `test/runtime/runtime.test.js`
- Test: `test/runtime/fixes.test.js`
- Test: `test/runtime/audit.test.js`
- Test: `test/runtime/openaiRuntime.test.js`
- Test: `test/auditReview/detector.test.js`

**Interfaces:**
- Consumes: existing `runtime.startRun(...)`, `createEventPublisher(...)`, `createCallbackClient(...)`.
- Produces:
  - `createCallbackClient({ fetchImpl })` from `src/adapters/delivery/callbackClient.js`
  - `normalizeRunRequest(body, headers)` helper in `app.js`
  - `createRun(input)` now consumes `sourceType/sessionId/requesterId/deliveryTargetUrl`

- [ ] **Step 1: Write failing HTTP API test for the new run envelope**

Update `test/http/runs-api.test.js`:

```js
body: JSON.stringify({
  source: {
    type: 'manual',
    session_id: 'session_test',
    message_id: 'msg_test',
    requester_id: 'user_test'
  },
  request: { text: '帮我查询今天的异常任务并给出处理建议' },
  delivery: { mode: 'callback', target_url: 'http://127.0.0.1:9999/agent-events' },
  metadata: { tenant_key: 'tenant_test' }
}),
```

Add assertions:

```js
assert.equal(run.request_text, '帮我查询今天的异常任务并给出处理建议');
assert.equal(run.channel, 'manual');
assert.equal(run.conversation_id, 'session_test');
assert.equal(run.user_open_id, 'user_test');
```

- [ ] **Step 2: Run the HTTP API test and verify it fails**

Run: `node --test test/http/runs-api.test.js`

Expected: `400 invalid_request`, because the current HTTP layer still requires `conversation_id` and `user.open_id`.

- [ ] **Step 3: Add a request normalizer in `src/adapters/http/app.js`**

Add helper functions:

```js
function normalizeRunRequest(body, headers) {
  if (body?.source && body?.request) {
    return {
      sourceType: body.source.type,
      sessionId: body.source.session_id,
      messageId: body.source.message_id,
      requesterId: body.source.requester_id,
      requestText: body.request.text,
      deliveryMode: body.delivery?.mode,
      deliveryTargetUrl: body.delivery?.target_url,
      metadata: body.metadata,
      idempotencyKey: body.idempotency_key ?? headers['idempotency-key'],
    };
  }

  return {
    sourceType: body.channel,
    sessionId: body.conversation_id,
    messageId: body.message_id,
    requesterId: body.user?.open_id,
    requestText: body.request?.text,
    deliveryMode: body.delivery?.mode,
    deliveryTargetUrl: body.delivery?.callback_url,
    metadata: body.metadata,
    idempotencyKey: body.idempotency_key ?? headers['idempotency-key'],
  };
}
```

- [ ] **Step 4: Update validation to use the normalized shape**

Replace `validateCreateRunBody(body)` with validation over the normalized object:

```js
function validateCreateRunInput(input) {
  const errors = [];
  if (!isNonEmptyString(input.sourceType)) errors.push({ field: 'source.type', message: 'source.type is required' });
  if (!isNonEmptyString(input.sessionId)) errors.push({ field: 'source.session_id', message: 'source.session_id is required' });
  if (!isNonEmptyString(input.requesterId)) errors.push({ field: 'source.requester_id', message: 'source.requester_id is required' });
  if (!isNonEmptyString(input.requestText)) errors.push({ field: 'request.text', message: 'request.text is required' });
  if (!isNonEmptyString(input.deliveryMode)) errors.push({ field: 'delivery.mode', message: 'delivery.mode is required' });
  if (input.deliveryMode === 'callback' && !isNonEmptyString(input.deliveryTargetUrl)) {
    errors.push({ field: 'delivery.target_url', message: 'delivery.target_url is required when delivery.mode is callback' });
  }
  return errors;
}
```

- [ ] **Step 5: Update `runtime.startRun` call sites**

In `app.js`, call:

```js
const normalized = normalizeRunRequest(body, req.headers);
const created = await runtime.startRun(normalized);
```

In `src/agent/runStore.js`, map normalized names into existing persisted columns:

```js
channel: input.sourceType,
conversationId: input.sessionId,
userOpenId: input.requesterId,
callbackUrl: input.deliveryTargetUrl,
```

Do not expose legacy names back out of `app.js` error messages or docs.

- [ ] **Step 6: Move delivery client to a generic adapter path**

Create `src/adapters/delivery/callbackClient.js` with the existing implementation, changing only the error text:

```js
throw new Error(`Delivery callback failed with HTTP ${response.status}`);
```

Update imports in:

- `scripts/server.js`
- `test/runtime/outbox.test.js`
- any runtime test importing the old path

Delete `src/adapters/bot/callbackClient.js`.

- [ ] **Step 7: Remove Feishu defaults from runtime audit**

In `src/observability/runtimeAudit.js`, change defaults:

```js
export function createRuntimeAuditLogger(db, { agentId = 'audit-runtime-agent', channel = 'system' } = {}) {
```

And write `channel` into inserted events instead of hardcoded `'feishu'`.

- [ ] **Step 8: Remove hardcoded trusted `feishu` channel from candidate detector**

In `src/auditReview/candidateDetector.js`, replace:

```js
if (row.channel != null && row.channel !== 'feishu') {
```

with configurable behavior:

```js
const trustedChannels = policy.trustedChannels ?? [];
if (trustedChannels.length > 0 && row.channel != null && !trustedChannels.includes(row.channel)) {
```

This preserves the rule when teams explicitly configure trusted sources, but removes the hidden Flybook assumption.

- [ ] **Step 9: Update runtime fixtures**

Replace Feishu-shaped fixtures in:

- `test/runtime/foundation.test.js`
- `test/runtime/runtime.test.js`
- `test/runtime/fixes.test.js`
- `test/runtime/openaiRuntime.test.js`
- `test/runtime/audit.test.js`

Use values like:

```js
source: { type: 'manual', session_id: 'session_test', requester_id: 'user_test' }
```

and assertions like:

```js
assert.equal(created.channel, 'manual');
assert.equal(created.user_open_id, 'user_test');
```

- [ ] **Step 10: Verify runtime and detector changes**

Run:

```powershell
node --test test/http/runs-api.test.js test/runtime/foundation.test.js test/runtime/outbox.test.js test/runtime/runtime.test.js test/runtime/fixes.test.js test/runtime/audit.test.js test/runtime/openaiRuntime.test.js test/auditReview/detector.test.js
```

Expected: all listed tests pass.

---

## Task 2: Remove Confidence From The Audit Review Contract

**Files:**
- Modify: `src/auditReview/reviewSchema.js`
- Modify: `src/auditReview/llmReviewer.js`
- Modify: `src/db/reviewSchema.js`
- Modify: `src/auditReview/reviewStore.js`
- Modify: `src/auditReview/scheduler.js`
- Test: `test/auditReview/reviewSchema.test.js`
- Test: `test/auditReview/reviewStore.test.js`
- Test: `test/auditReview/scheduler.test.js`
- Test: `test/auditReview/httpIntegration.test.js`

**Interfaces:**
- Consumes: existing `reviewJsonSchema()`, `validateReview(review)`, `upsertFinding(finding)`.
- Produces:
  - review finding contract without `confidence`
  - store hydration that strips any legacy `confidence` column from returned findings

- [ ] **Step 1: Write failing schema tests**

Update `test/auditReview/reviewSchema.test.js`:

```js
test('validateReview accepts a finding without confidence', () => {
  const r = goodReview();
  delete r.findings[0].confidence;
  const result = validateReview(r);
  assert.equal(result.ok, true);
});

test('validateReview rejects confidence because v1.5 removed the field', () => {
  const r = goodReview();
  r.findings[0].confidence = 0.92;
  const result = validateReview(r);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /confidence/);
});
```

- [ ] **Step 2: Run schema tests and verify failure**

Run: `node --test test/auditReview/reviewSchema.test.js`

Expected: failure, because current schema still requires and accepts `confidence`.

- [ ] **Step 3: Remove confidence from review schema**

In `src/auditReview/reviewSchema.js`:

- delete the numeric range check
- delete `confidence` from JSON schema `properties`
- delete `confidence` from the required array
- reject the property when present:

```js
if (Object.prototype.hasOwnProperty.call(f, 'confidence')) {
  return invalid(`${ctx}.confidence has been removed in v1.5`);
}
```

- [ ] **Step 4: Update LLM prompt**

In `src/auditReview/llmReviewer.js`, replace the current finding requirements with:

```js
'Each finding MUST have: category, severity, agent_id, tool_name, trace_id, product_id (strings or null), title, summary (<=200 chars), recommendation, evidence_event_ids (array of integers referencing provided candidate event ids), requires_action (boolean).',
'- Assign severity based on evidence and context (trace, agent, tool, error).',
'- Do not output confidence, probability, or calibration fields.',
```

- [ ] **Step 5: Stop creating confidence anywhere**

Remove `confidence` assignments from:

- `src/auditReview/scheduler.js`
- `src/auditReview/reviewStore.js`
- degraded review builders
- parse error finding builders
- fake LLM fixtures in audit-review tests

- [ ] **Step 6: Drop confidence from new review DB schema**

In `src/db/reviewSchema.js`, remove:

```sql
confidence REAL,
```

Do not add a destructive migration. Existing DBs may retain the column, but v1.5 code must ignore it.

- [ ] **Step 7: Add store hydration to hide legacy confidence**

In `src/auditReview/reviewStore.js`, add a `hydrateFinding(row)` helper:

```js
function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hydrateFinding(row) {
  if (!row) return null;
  const { confidence, evidence_event_ids_json, evidence_json, ...rest } = row;
  void confidence;
  return {
    ...rest,
    evidence_event_ids: parseJson(evidence_event_ids_json, []),
    evidence: parseJson(evidence_json, []),
  };
}
```

Use it in `getFinding`, `listFindings`, `upsertFinding`, and `updateFinding`.

- [ ] **Step 8: Verify audit-review contract tests**

Run:

```powershell
node --test test/auditReview/reviewSchema.test.js test/auditReview/reviewStore.test.js test/auditReview/scheduler.test.js test/auditReview/httpIntegration.test.js
```

Expected: all listed tests pass.

---

## Task 3: Add Agent Name And Structured Log Detail To Evidence

**Files:**
- Create: `src/auditReview/evidence.js`
- Modify: `src/auditReview/scheduler.js`
- Modify: `src/auditReview/reviewStore.js`
- Modify: `src/auditReview/notification.js`
- Test: `test/auditReview/evidence.test.js`
- Test: `test/auditReview/scheduler.test.js`
- Test: `test/auditReview/notification.test.js`
- Test: `test/auditReview/httpIntegration.test.js`

**Interfaces:**
- Consumes: candidate detector output, config `agents` map.
- Produces:
  - `agentDisplayName(agentId, config)`
  - `buildEvidenceDetail(event, config)`
  - persisted `finding.evidence`

- [ ] **Step 1: Create failing evidence tests**

Create `test/auditReview/evidence.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentDisplayName, buildEvidenceDetail, buildEvidenceIndex, evidenceForEventIds } from '../../src/auditReview/evidence.js';

test('agentDisplayName prefers configured displayName and falls back to agent_id', () => {
  const config = { agents: { 'mt-agent': { displayName: 'MT 审计 Agent' } } };
  assert.equal(agentDisplayName('mt-agent', config), 'MT 审计 Agent');
  assert.equal(agentDisplayName('unknown-agent', config), 'unknown-agent');
});

test('buildEvidenceDetail includes agent name and log detail fields', () => {
  const detail = buildEvidenceDetail({
    event_id: 12,
    ts: '2026-07-03T10:00:00.000Z',
    agent_id: 'mt-agent',
    tool_name: 'db.delete',
    trace_id: 'trace-1',
    span_id: 'span-1',
    event: 'tool.end',
    status: 'ok',
    duration_ms: 120,
    product_id: 'product-1',
    result_summary: 'deleted 5 rows',
    error_code: null,
    error_message: null,
    reason: 'tool_name matches high-risk pattern',
  }, { agents: { 'mt-agent': { displayName: 'MT 审计 Agent' } } });

  assert.equal(detail.event_id, 12);
  assert.equal(detail.agent_id, 'mt-agent');
  assert.equal(detail.agent_name, 'MT 审计 Agent');
  assert.equal(detail.log_detail.result_summary, 'deleted 5 rows');
  assert.equal(Object.prototype.hasOwnProperty.call(detail, 'raw_json'), false);
});

test('evidenceForEventIds preserves event id order and skips unknown ids', () => {
  const index = buildEvidenceIndex([
    { event_id: 2, agent_id: 'a', result_summary: 'second' },
    { event_id: 1, agent_id: 'a', result_summary: 'first' },
  ]);
  const evidence = evidenceForEventIds([1, 2, 999], index);
  assert.deepEqual(evidence.map((item) => item.event_id), [1, 2]);
});
```

- [ ] **Step 2: Run evidence tests and verify failure**

Run: `node --test test/auditReview/evidence.test.js`

Expected: failure, because `src/auditReview/evidence.js` does not exist.

- [ ] **Step 3: Implement `src/auditReview/evidence.js`**

Use these exact exports:

```js
export function agentDisplayName(agentId, config = {}) {
  return config?.agents?.[agentId]?.displayName ?? config?.agents?.[agentId]?.name ?? agentId ?? '';
}

export function buildEvidenceDetail(event, config = {}) {
  return {
    event_id: event.event_id ?? event.id ?? null,
    agent_id: event.agent_id ?? null,
    agent_name: agentDisplayName(event.agent_id, config),
    tool_name: event.tool_name ?? null,
    trace_id: event.trace_id ?? null,
    span_id: event.span_id ?? null,
    log_detail: {
      ts: event.ts ?? null,
      event: event.event ?? null,
      status: event.status ?? null,
      duration_ms: event.duration_ms ?? null,
      product_id: event.product_id ?? null,
      result_summary: event.result_summary ?? null,
      error_code: event.error_code ?? null,
      error_message: event.error_message ?? null,
      reason: event.reason ?? null,
    },
  };
}

export function buildEvidenceIndex(candidates = [], config = {}) {
  return new Map(candidates.map((candidate) => [candidate.event_id, buildEvidenceDetail(candidate, config)]));
}

export function evidenceForEventIds(eventIds = [], evidenceIndex = new Map()) {
  return eventIds.map((id) => evidenceIndex.get(id)).filter(Boolean);
}
```

- [ ] **Step 4: Persist evidence from the scheduler**

In `src/auditReview/scheduler.js`:

```js
import { agentDisplayName, buildEvidenceDetail, buildEvidenceIndex, evidenceForEventIds } from './evidence.js';
```

After candidate detection:

```js
const evidenceIndex = buildEvidenceIndex(candidates.candidates, config);
```

When persisting LLM findings:

```js
const evidenceIds = Array.isArray(f.evidence_event_ids) ? f.evidence_event_ids : [];
const evidence = evidenceForEventIds(evidenceIds, evidenceIndex);
evidence_event_ids: evidenceIds,
evidence_event_ids_json: JSON.stringify(evidenceIds),
evidence_json: JSON.stringify(evidence),
```

For degraded single-candidate findings:

```js
const evidence = [buildEvidenceDetail(candidate, config)];
```

For parse errors:

```js
evidence_json: JSON.stringify(errors.slice(0, 3).map((errorRow) => ({
  event_id: null,
  agent_id: agentId,
  agent_name: agentDisplayName(agentId, config),
  tool_name: 'audit.ingest',
  trace_id: null,
  span_id: null,
  log_detail: {
    file: errorRow.file,
    line: errorRow.line,
    error: errorRow.error,
  },
}))),
```

- [ ] **Step 5: Extend notification payloads with compact evidence**

In `src/auditReview/notification.js`, enrich finding payloads:

```js
agent_name: finding.evidence?.[0]?.agent_name ?? finding.agent_id,
evidence: Array.isArray(finding.evidence) ? finding.evidence.slice(0, 5) : [],
```

`top_findings` rows should also prefer `agent_name`.

- [ ] **Step 6: Add scheduler and notification assertions**

In `test/auditReview/scheduler.test.js`:

```js
const firstFinding = findings[0];
assert.ok(Array.isArray(firstFinding.evidence));
assert.ok(firstFinding.evidence.length > 0);
assert.equal(firstFinding.evidence[0].agent_id, 'mt-agent');
assert.ok(firstFinding.evidence[0].agent_name);
assert.ok(firstFinding.evidence[0].log_detail);
```

In `test/auditReview/notification.test.js`:

```js
assert.equal(payload.agent_name, 'MT 审计 Agent');
assert.ok(Array.isArray(payload.evidence));
assert.ok(payload.evidence.length > 0);
```

- [ ] **Step 7: Verify evidence behavior**

Run:

```powershell
node --test test/auditReview/evidence.test.js test/auditReview/scheduler.test.js test/auditReview/notification.test.js test/auditReview/httpIntegration.test.js
```

Expected: all listed tests pass.

---

## Task 4: Rebuild The Dashboard As Chinese Direct-Data Components

**Files:**
- Modify: `src/auditReview/dashboardTemplate.js`
- Modify: `src/auditReview/visualization.js`
- Test: `test/auditReview/dashboardTemplate.test.js`
- Create: `test/auditReview/visualization.test.js`
- Test: `test/auditReview/httpIntegration.test.js`

**Interfaces:**
- Consumes: hydrated findings with `evidence`.
- Produces:
  - direct-data dashboard sections: `table`, `definition_list`, `link_list`, `callout`
  - Chinese labels and conditional visibility

- [ ] **Step 1: Replace template tests with direct-data assertions**

Update `test/auditReview/dashboardTemplate.test.js` with:

```js
test('renderDashboard renders Chinese labels and no browser fetch', () => {
  const html = renderDashboard({
    page: { title: '审计审查总览', subtitle: '最近审查与风险概览', updated_at: '2026-07-03T10:30:00.000Z' },
    summary_metrics: [{ label: '高风险', value: 3, tone: 'high' }],
    sections: [{
      id: 'latest_findings',
      type: 'table',
      title: '最新风险发现',
      columns: [{ key: 'title', label: '标题' }],
      rows: [{ title: '高危删除操作' }],
    }],
  });

  assert.ok(html.includes('审计审查总览'));
  assert.ok(html.includes('最新风险发现'));
  assert.equal(html.includes('Data source'), false);
  assert.equal(html.includes('fetch('), false);
  assert.equal(html.includes('Severity'), false);
});

test('renderDashboard hides empty metrics and empty sections', () => {
  const html = renderDashboard({
    page: { title: '审计审查总览' },
    summary_metrics: [
      { label: '严重', value: 0, tone: 'critical' },
      { label: '高风险', value: 2, tone: 'high' },
    ],
    sections: [
      { id: 'empty_table', type: 'table', title: '空表格', columns: [{ key: 'name', label: '名称' }], rows: [] },
      { id: 'detail', type: 'definition_list', title: '详情', items: [
        { label: 'Agent', value: 'mt-agent' },
        { label: '空字段', value: '' },
      ] },
    ],
  });

  assert.equal(html.includes('空表格'), false);
  assert.equal(html.includes('空字段'), false);
  assert.ok(html.includes('mt-agent'));
});
```

- [ ] **Step 2: Run dashboard template tests and verify failure**

Run: `node --test test/auditReview/dashboardTemplate.test.js`

Expected: failure, because current模板 still contains English copy and browser-side `fetch`.

- [ ] **Step 3: Add direct-data renderers in `dashboardTemplate.js`**

Implement helpers:

```js
function hasValue(value) {
  return value !== null && value !== undefined && value !== '' && value !== 0;
}

function visibleMetrics(metrics = []) {
  return metrics.filter((metric) => hasValue(metric.value));
}

function visibleSections(sections = []) {
  return sections.filter((section) => {
    if (section.type === 'table') return Array.isArray(section.rows) && section.rows.length > 0;
    if (section.type === 'definition_list') return Array.isArray(section.items) && section.items.some((item) => hasValue(item.value));
    if (section.type === 'link_list') return Array.isArray(section.links) && section.links.length > 0;
    if (section.type === 'callout') return hasValue(section.body) || hasValue(section.title);
    return false;
  });
}
```

And renderers:

```js
function renderTableSection(section) { /* render columns + rows directly */ }
function renderDefinitionListSection(section) { /* render dl/dd directly */ }
function renderLinkListSection(section) { /* render links directly */ }
function renderCalloutSection(section) { /* render a highlighted summary block */ }
```

- [ ] **Step 4: Replace English visual tokens**

Update:

```js
const SEVERITY_TONES = {
  critical: { color: '#9b1c1c', bg: '#fde8e8', label: '严重' },
  high: { color: '#b54708', bg: '#fef0e6', label: '高风险' },
  medium: { color: '#b7791f', bg: '#fff8e1', label: '中风险' },
  low: { color: '#667085', bg: '#f0f2f5', label: '低风险' },
  neutral: { color: '#475467', bg: '#f5f7fa', label: '信息' },
};
```

Also update:

- `Updated:` -> `更新时间：`
- footer -> `audit-logger-agent 审计看板`
- empty state -> `暂无可展示的审查数据`
- error state -> `加载错误`

- [ ] **Step 5: Create visualization tests**

Create `test/auditReview/visualization.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisualization } from '../../src/auditReview/visualization.js';

function fakeStore() {
  const finding = {
    finding_id: 'f1',
    review_id: 'r1',
    severity: 'high',
    category: 'high_risk_permission',
    status: 'open',
    title: '高危删除操作',
    summary: '检测到删除工具调用。',
    recommendation: '确认删除操作已授权。',
    agent_id: 'agent-test',
    tool_name: 'db.delete',
    trace_id: 'trace-del-1',
    evidence: [{
      event_id: 1,
      agent_id: 'agent-test',
      agent_name: '测试 Agent',
      tool_name: 'db.delete',
      trace_id: 'trace-del-1',
      span_id: 'span-del-1',
      log_detail: {
        ts: '2026-07-03T10:00:00.000Z',
        event: 'tool.end',
        status: 'ok',
        result_summary: 'deleted 5 rows',
        error_message: null,
      },
    }],
    last_seen_at: '2026-07-03T10:00:00.000Z',
  };

  return {
    listFindings({ severity, status, reviewId } = {}) {
      if (reviewId && reviewId !== 'r1') return [];
      if (severity && severity !== finding.severity) return [];
      if (status && status !== finding.status) return [];
      return [finding];
    },
    listRuns() {
      return [{
        review_id: 'r1',
        status: 'completed',
        window_from: '2026-07-03T09:30:00.000Z',
        window_to: '2026-07-03T10:00:00.000Z',
        finding_count: 1,
      }];
    },
    getRun(id) {
      return id === 'r1' ? this.listRuns()[0] : null;
    },
    getFinding(id) {
      return id === 'f1' ? finding : null;
    },
    listDeadLetterCount() {
      return 0;
    },
  };
}

test('overviewPage uses Chinese labels and hides empty dead-letter data', () => {
  const viz = createVisualization({ reviewStore: fakeStore(), config: { auditReview: { visualization: {} } } });
  const page = viz.overviewPage();
  assert.equal(page.page.title, '审计审查总览');
  assert.ok(page.summary_metrics.some((metric) => metric.label === '高风险' && metric.value === 1));
  assert.equal(page.summary_metrics.some((metric) => metric.label === 'Dead Letters'), false);
});

test('findingDetailPage includes evidence rows and no confidence metric', () => {
  const viz = createVisualization({ reviewStore: fakeStore(), config: { auditReview: { visualization: {} } } });
  const page = viz.findingDetailPage('f1');
  assert.equal(page.summary_metrics.some((metric) => metric.label === '置信度'), false);
  const evidenceSection = page.sections.find((section) => section.id === 'evidence_events');
  assert.ok(evidenceSection);
  assert.equal(evidenceSection.rows[0].agent_name, '测试 Agent');
  assert.equal(evidenceSection.rows[0].result_summary, 'deleted 5 rows');
});
```

- [ ] **Step 6: Rebuild `visualization.js` around direct data**

Add Chinese label maps:

```js
const SEVERITY_LABELS = { critical: '严重', high: '高风险', medium: '中风险', low: '低风险' };
const STATUS_LABELS = { open: '待处理', acknowledged: '已确认', snoozed: '已静默', resolved: '已解决', completed: '已完成', completed_degraded: '降级完成', failed: '失败', running: '运行中', skipped: '已跳过' };
const CATEGORY_LABELS = { high_risk_permission: '高危权限/变更', anomalous_call: '异常调用', repeated_call: '重复调用', failed_call: '失败调用', trace_integrity: '链路完整性', ingest_parse_error: '日志解析错误' };
```

Then build:

- overview metrics from open findings by severity, omitting zero values
- latest findings table rows with `severity_label` / `category_label` / `agent_name`
- recent reviews table rows with Chinese status
- dead-letter section only when `reviewStore.listDeadLetterCount() > 0`

For finding detail page, render:

- summary metrics: `严重程度`、`类别`、`状态`
- definition list: finding id, review id, agent id, agent name, tool, trace, product, recommendation
- evidence table columns:

```js
[
  { key: 'event_id', label: '日志 ID' },
  { key: 'agent_name', label: 'Agent 名称' },
  { key: 'agent_id', label: 'Agent ID' },
  { key: 'tool_name', label: '工具' },
  { key: 'ts', label: '时间' },
  { key: 'event', label: '事件' },
  { key: 'status', label: '状态' },
  { key: 'result_summary', label: '日志摘要' },
  { key: 'error_message', label: '错误详情' },
]
```

- [ ] **Step 7: Update HTTP integration assertions**

In `test/auditReview/httpIntegration.test.js`, change Dashboard assertions to:

```js
assert.ok(html.includes('审计审查总览') || html.includes('审查批次'));
assert.equal(html.includes('Severity'), false);
assert.equal(html.includes('Confidence'), false);
assert.equal(html.includes('Data source'), false);
```

For finding detail page:

```js
assert.ok(html.includes('日志 ID'));
assert.ok(html.includes('Agent 名称'));
assert.ok(html.includes('日志摘要'));
assert.equal(html.includes('置信度'), false);
```

- [ ] **Step 8: Verify dashboard behavior**

Run:

```powershell
node --test test/auditReview/dashboardTemplate.test.js test/auditReview/visualization.test.js test/auditReview/httpIntegration.test.js
```

Expected: all listed tests pass.

---

## Task 5: Update Notifications, Docs, And Final Verification

**Files:**
- Modify: `src/auditReview/notification.js`
- Modify: `README.md`
- Modify: `v1.4/PERIODIC_LLM_AUDIT_REVIEW_DESIGN.md`
- Test: `test/auditReview/notification.test.js`
- Test: `test/auditReview/httpIntegration.test.js`

**Interfaces:**
- Consumes: normalized findings and generic delivery mechanism.
- Produces:
  - generic outbox payload docs
  - code comments and README examples without Feishu/Bot wording

- [ ] **Step 1: Update notification copy and semantics**

In `src/auditReview/notification.js`, keep payload types `audit_review_summary` and `audit_review_finding`, but remove any Bot-only framing from comments and tests. `buildSummaryPayload()` and `buildFindingPayload()` should be documented as generic delivery payloads.

Ensure `pickTopFindings()` prefers `agent_name`:

```js
agent_name: f.agent_name ?? f.evidence?.[0]?.agent_name ?? f.agent_id,
```

- [ ] **Step 2: Update README runtime examples**

In `README.md`:

- replace `channel = "feishu"` with the new `source` block
- replace `delivery.callback_url` with `delivery.target_url`
- remove `Bot callback_url` wording, replacing it with `delivery target` or `callback receiver`
- replace all “飞书 Bot” 审查通知描述为 “通用回调投递” 或 “回调接收端”

- [ ] **Step 3: Update v1.4 design doc with v1.5 delta**

At the top of `v1.4/PERIODIC_LLM_AUDIT_REVIEW_DESIGN.md`, add a note like:

```markdown
> v1.5 delta: review payloads are still delivered through the outbox/callback mechanism, but the implementation no longer treats Flybook/Bot as a required platform. `confidence` has been removed from the active review contract. Dashboard pages now render direct data with Chinese labels and hide empty sections. Finding evidence includes log id, agent id, agent display name, and sanitized log details.
```

Update sections that currently say “飞书 Bot” or “Bot callback URL” to “通用回调接收端” unless they are explicitly historical notes.

- [ ] **Step 4: Add final regression assertions for payload shape**

In `test/auditReview/notification.test.js`, assert:

```js
assert.equal(Object.prototype.hasOwnProperty.call(payload.top_findings[0], 'confidence'), false);
assert.equal(payload.top_findings[0].agent_name, 'MT 审计 Agent');
```

In `test/auditReview/httpIntegration.test.js`, assert the fake outbox captured payloads without Feishu/Bot-specific required fields.

- [ ] **Step 5: Run focused review tests**

Run:

```powershell
node --test test/auditReview/notification.test.js test/auditReview/httpIntegration.test.js
```

Expected: both tests pass.

- [ ] **Step 6: Run full audit-review and runtime regression suites**

Run:

```powershell
node --test "test/auditReview/**/*.test.js"
npm run test:agent
```

Expected:

- all audit-review tests pass
- `npm run test:agent` passes, with OpenAI integration cases skipped automatically when local credentials are absent

- [ ] **Step 7: Run final language and confidence scans**

Run:

```powershell
rg -n "feishu|Feishu|飞书|bot|Bot|callback_url|confidence|Confidence|置信度" src test README.md
```

Expected after implementation:

- no active runtime/audit-review source or docs depend on Flybook/Bot wording
- no active review code, tests, or README references `confidence`

---

## Suggested Execution Order

1. Task 1: 先把运行时入口、发送链路和可信来源规则去飞书化。
2. Task 2: 再移除 confidence，避免后续 evidence 和 Dashboard 继续依赖旧字段。
3. Task 3: 加 evidence 明细和 Agent 名称。
4. Task 4: 重建 Dashboard 模板和 view model。
5. Task 5: 收尾通知、文档和全量验证。

这个顺序能减少返工：Task 1 先稳定运行时边界，Task 2 和 Task 3 稳定 finding 数据结构，Task 4 再消费最终数据结构做页面。

## Self-Review

**Spec coverage:**

- 去掉飞书/Bot 适配内容但保留发送机制：Task 1 和 Task 5 覆盖入口、适配器命名、文档和 outbox/callback 保留策略。
- 移除置信度：Task 2 全面覆盖 schema、prompt、持久化、API、Dashboard、测试。
- 附带日志所属 agent 名称、日志详情：Task 3 定义 evidence shape 并写入 finding。
- Dashboard 统一结构样式、中文、数据直填、空内容不展示：Task 4 负责模板与 view model，Task 5 更新文档与集成断言。

**Placeholder scan:** 本计划没有留下占位式步骤、未定义接口或“稍后补”的实现说明。每个任务都给出了目标文件、测试入口、关键代码形态和验证命令。

**Type consistency:** 运行时对外使用 `source/session/requester/delivery` 命名；审查 evidence 统一为 `finding.evidence` 数组；Dashboard section 统一使用 `table`、`definition_list`、`link_list`、`callout` 四类组件。
