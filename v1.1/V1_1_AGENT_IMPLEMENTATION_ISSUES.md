# v1.1 Agent 实现问题统计

日期：2026-07-02

本文档基于当前仓库实现，对照 `v1.1/V2_FEISHU_INDEPENDENT_AGENT_DESIGN.md` 和 `v1.1/docs/superpowers/plans/2026-07-02-feishu-independent-agent-mvp.md` 进行检查。结论：项目已经具备独立 Agent 的第一版骨架，包括 run 状态表、HTTP 接口、Planner、工具注册表、Outbox 回调和等待用户恢复流程，但还没有完全达到“飞书 Bot 调用后可可靠独立规划、执行、请求用户决策、产出最终结果”的预期。

## 检查基线

- 当前测试：`npm run test:agent` 通过。
- 测试结果：`node --test` 10 个测试通过，`node test/self-test.js` 全部通过。
- 重要说明：当前测试覆盖了 happy path 和基础 schema，不覆盖工具失败、resume 状态冲突、异步 ACK、回调重试上限、输入校验、幂等、进程恢复等生产关键路径。

## 问题统计

| 严重级别 | 数量 | 含义 |
| --- | ---: | --- |
| P1 | 1 | 会直接破坏 run 状态正确性或用户可见终态，需要优先修复 |
| P2 | 8 | 会影响飞书 Bot 内部接入稳定性、可靠性或可恢复性 |
| P3 | 4 | 质量、可维护性、可观测性或后续扩展风险 |
| 合计 | 13 | 当前 v1.1 实现仍需补齐后才能作为可靠独立 Agent 交付 |

## P1 问题

### P1-01 工具执行失败后 run 卡在 `running`，没有失败终态和 `final_result`

证据：

- `src/agent/runtime.js:79` 进入 `#executePlan`。
- `src/agent/runtime.js:88` 直接 `await this.#registry.execute(...)`，外层没有 try/catch。
- `src/agent/runtime.js:102` 只有成功路径才 transition 到 `completed`。
- `src/agent/stateMachine.js:15` 支持 `running -> failed`，但 Runtime 没有使用。
- 设计要求：`v1.1/V2_FEISHU_INDEPENDENT_AGENT_DESIGN.md:124` 到 `127` 要求成功或失败都生成 `final_result`，并将 run 置为 `completed` 或 `failed`。

复现结果：

```json
{
  "thrown": "tool boom",
  "run": {
    "status": "running",
    "error_code": null,
    "error_message": null,
    "result_json": "null"
  }
}
```

影响：

- Bot 端收不到标准失败结果卡片。
- 用户看到任务一直进行中。
- 后续恢复、重试、审计都无法判断这个 run 已经失败。

建议修复：

- 在 `startRun`、`resumeRun`、`#planAndExecute`、`#executePlan` 外层增加统一失败收敛。
- 工具失败时写入 `agent_run_steps.status = failed`，run transition 到 `failed`。
- 生成失败态 `final_result`，通过 Outbox 投递给 Bot。
- 写入 `run.error` 或等价审计事件，并补充测试：工具抛错、Planner 抛错、final synthesis 抛错。

## P2 问题

### P2-01 `POST /v1/runs` 不是异步 ACK，会等待 Agent 执行完成或进入等待态后才返回

证据：

- `src/adapters/http/app.js:70` 到 `82` 中 endpoint 直接 `await runtime.startRun(...)`。
- `src/agent/runtime.js:31` 到 `34` 中 `startRun` 创建 run 后直接进入 `#planAndExecute`。
- 设计要求 callback 推送模式：`v1.1/V2_FEISHU_INDEPENDENT_AGENT_DESIGN.md:314` 到 `320` 明确推荐 Bot 提供 callback URL，Agent 异步执行并回调推送。

复现结果：

```json
{
  "elapsedMs": 126,
  "response": {
    "status": "planning"
  }
}
```

该复现只在 `runtime.startRun` 内加入 100ms 延迟，就能观察到 HTTP 响应被阻塞。

影响：

- 工具慢或卡住时，飞书 Bot 的创建请求也会卡住。
- 与“Bot 创建运行，Agent 独立执行，进度/结果通过 callback 推送”的预期不一致。
- 当前 P1 工具失败或 P2 工具超时缺失会进一步放大这个问题。

建议修复：

- `POST /v1/runs` 只负责创建 run 并快速返回 `202 { run_id, status: "created" }` 或 `"planning"`。
- 后台执行可先用单进程任务队列、`setImmediate` 或 `queueMicrotask` 包一层 runner，后续再升级为 Worker。
- `startRun` 拆成 `createRun` 和 `executeRun` 两个语义。
- 增加测试：创建接口在工具延迟时仍快速返回，进度和最终结果通过 Outbox 发送。

### P2-02 `resumeRun` 先关闭 waiting，再执行恢复规划，失败后无法重试同一决策

证据：

- `src/agent/runtime.js:45` 先调用 `resolveWaitingState`。
- `src/agent/runtime.js:46` 之后才调用 `planner.resumeFromDecision(...)`。
- `src/agent/runtime.js:47` 之后才将 run transition 到 `running`。

复现结果：

```json
{
  "thrown": "planner boom",
  "waiting": {
    "status": "resolved"
  },
  "run": {
    "status": "waiting_user"
  }
}
```

影响：

- 用户点击飞书卡片后，如果恢复规划失败，等待态已经被关闭。
- 同一张卡片再次提交会被判定为 already resolved。
- run 仍停在 `waiting_user`，但没有可用的 pending decision。

建议修复：

- 把 resume 处理做成事务。
- 先校验响应，再生成恢复计划，再把 waiting 从 `pending` 改为 `resolved`。
- 或引入 `resolving` 状态，失败时可回滚到 `pending`。
- 增加测试：resume 过程中 planner/tool 失败时，用户可以重试或收到明确失败卡片。

### P2-03 用户决策响应没有按 `decision_request` schema 校验，非法选项会落到默认全量处理

证据：

- `src/agent/runtime.js:46` 将 `body.response` 直接交给 Planner。
- `src/agent/runtime.js:37` 到 `45` 没有明确校验 run 当前状态必须是 `waiting_user`。
- `src/agent/planner.js:58` 到 `83` 只判断 `selected_option === 'today_only'`，其他值都会走全量异常处理。
- 设计阶段 4 要求支持用户选项与表单输入校验：`v1.1/V2_FEISHU_INDEPENDENT_AGENT_DESIGN.md:741` 到 `744`。

影响：

- 用户或恶意调用方传入未知选项，系统可能执行比预期更大的范围。
- Bot 卡片和 Agent 执行语义不再一致。
- 表单字段缺失、类型错误、选项过期都没有明确错误。

建议修复：

- waiting state 保存 decision schema 后，resume 时按 schema 校验 `selected_option` 和 `form_data`。
- resume 时校验 run 当前状态为 `waiting_user`，非等待态返回 `409 resume_conflict`。
- 非法选项返回 `400 invalid_decision_response`，不关闭 waiting。
- Planner 不应把未知选项当作 `all_errors`。

### P2-04 Outbox 回调失败会无限 pending 重试，没有退避、最大次数和死信状态

证据：

- `src/agent/eventPublisher.js:14` 到 `23` 每次 flush pending。
- `src/agent/outboxStore.js:40` 到 `42` 失败后仍设置 `delivery_status = 'pending'`。
- `scripts/server.js:54` 到 `60` 每 1 秒 flush 一次。
- 设计要求：Outbox 应可重试且可见投递失败状态：`v1.1/V2_FEISHU_INDEPENDENT_AGENT_DESIGN.md:494` 到 `495`。

复现结果：

```json
{
  "delivery_status": "pending",
  "delivery_attempts": 2,
  "last_error": "callback down"
}
```

影响：

- Bot callback URL 配错或持续故障时，系统会每秒永久重试。
- DB 写入和日志噪音会持续增长。
- 没有 dead-letter 或人工介入状态，无法判断消息是否已经不可投递。

建议修复：

- 增加 `next_attempt_at`、指数退避、`max_attempts`。
- 超过阈值后转为 `failed` 或 `dead_letter`。
- 保留手动重投入口或运维脚本。
- 增加测试：失败重试次数、退避时间、超过阈值后不再立即重试。

### P2-05 创建 run 缺少幂等控制，同一个飞书消息重试会创建多个 run

证据：

- `src/db/runtimeSchema.js:6` 到 `7` 保存 `conversation_id` 和 `message_id`，但没有唯一约束。
- `src/agent/runStore.js:72` 到 `82` 每次调用都会生成新的 `run_id` 并插入。
- 设计说明中提到 run/waiting/outbox 拆分后更容易做幂等：`v1.1/V2_FEISHU_INDEPENDENT_AGENT_DESIGN.md:156` 和 `497`。

复现结果：

```json
{
  "first": "run_...",
  "second": "run_...",
  "sameMessageRunCount": 2
}
```

影响：

- Bot 或网络重试同一条飞书消息时，会创建多个独立任务。
- 用户可能收到多张进度卡、多个最终结果。
- 后续审计和成本统计会重复。

建议修复：

- 引入 `idempotency_key`，优先使用 Bot 请求头或 `channel + message_id`。
- 对 `channel, message_id` 建唯一索引，或在 `runStore.createRun` 前查重。
- 重复请求返回已有 run 的 `run_id` 和当前状态。
- 增加测试：同一 message_id 重复创建只返回同一 run。

### P2-06 工具执行没有超时、失败分类和错误摘要

证据：

- `src/tools/registry.js:16` 到 `19` 直接调用 `tool.execute(input, context)`。
- 没有 `AbortController`、超时配置、错误类型映射或统一工具结果 envelope。
- 设计要求：每个工具都要支持超时、失败分类和错误摘要：`v1.1/V2_FEISHU_INDEPENDENT_AGENT_DESIGN.md:386`，错误类型包含 `tool_timeout`：`v1.1/V2_FEISHU_INDEPENDENT_AGENT_DESIGN.md:529`。

影响：

- 任意工具 hang 住会让 run 长时间停在 `running`。
- 因为 P2-01，创建请求也可能被一起卡住。
- Bot 端无法收到可解释的错误卡片。

建议修复：

- 在 registry 层包装工具执行，提供默认 timeout 和工具级 override。
- 错误统一转换为 `{ code, message, retryable, summary }`。
- Runtime 根据错误策略决定 retry、failed 或请求用户决策。
- 增加测试：工具超时、未注册工具、工具返回非法结构。

### P2-07 HTTP 输入校验和错误语义不足，坏请求返回 500

证据：

- `src/adapters/http/app.js:72` 到 `80` 直接读取 body 字段传入 Runtime。
- `src/agent/runStore.js:74` 到 `81` 直接写入数据库。
- `src/adapters/http/app.js:106` 到 `107` 捕获所有错误并返回 500。
- `src/db/runtimeSchema.js:3` 到 `11` 对关键字段有 NOT NULL 约束，但 HTTP 层没有提前转换为 400。

复现结果：

```json
{
  "status": 500,
  "body": {
    "error": "NOT NULL constraint failed: agent_runs.channel"
  }
}
```

影响：

- Bot 调用方无法区分参数错误、运行冲突、资源不存在和服务异常。
- 数据库错误信息泄漏到 API 响应。
- `delivery.mode`、`callback_url`、`request.text`、`user.open_id` 等字段缺失时没有清晰提示。

建议修复：

- 为 `/v1/runs` 和 `/resume` 增加请求 schema 校验。
- 参数错误返回 `400`，run 不存在返回 `404`，状态冲突返回 `409`。
- 响应使用稳定错误码，例如 `invalid_request`、`run_not_found`、`resume_conflict`。

### P2-08 Runtime 审计事件名与现有 parser 契约不兼容

证据：

- Runtime 写入 `run.start`、`run.resume`、`run.waiting_user`、`run.final_result`：`src/agent/runtime.js:33`、`48`、`71`、`104`。
- parser 只接受 `tool.start`、`tool.end`、`tool.error`、`agent.start`、`agent.end`、`agent.error`：`scripts/lib/parser.js:2`。
- `src/observability/runtimeAudit.js:7` 到 `31` 直接调用 `insertEvents`，绕过 parser 校验。

复现结果：

```json
{
  "entries": [],
  "errors": [
    "line 1: invalid event \"run.start\""
  ]
}
```

影响：

- 直接入库时看起来正常，但导出再重放或离线 ingestion 会失败。
- v1.0 日志规范和 v1.1 runtime 事件契约不一致。
- 后续审计、恢复、跨 Agent 分析会出现割裂。

建议修复：

- 二选一：扩展 parser 的 `VALID_EVENTS` 接受 `run.*`，或把 runtime 事件映射为 `agent.start/end/error` 并通过 tag/status 表达 run 生命周期。
- 更新 `v1.0/LOG_SPEC.md` 或新增 v1.1 runtime audit spec。
- 增加测试：runtime audit 事件可以被 parser 接受。

## P3 问题

### P3-01 `/query` 对同一条件执行了两次查询

证据：

- `src/adapters/http/app.js:44` 同时调用 `queryEvents(db, filters).length` 和 `queryEvents(db, filters)`。

影响：

- 数据量大时浪费查询成本。
- 两次查询之间如果数据变化，`count` 和 `results` 可能不一致。

建议修复：

- 只查询一次：`const results = queryEvents(db, filters); json(... { count: results.length, results })`。

### P3-02 Windows/PowerShell 下中文源码显示存在编码一致性风险，需要确认

证据：

- `rg` 能正确显示 `src/agent/planner.js:19` 到 `23`、`src/agent/payloads.js:6` 等中文字符串。
- PowerShell `Get-Content -Raw` 在本机输出中出现 mojibake。
- 当前 Node 测试通过，所以这更像终端/读取编码问题，而不是已确认的运行时源码损坏。

影响：

- 开发者用不同工具查看或复制中文字符串时，可能引入真实乱码。
- 飞书卡片文案和测试 fixture 容易被误改。

建议修复：

- 明确仓库编码为 UTF-8。
- 增加 `.editorconfig`：`charset = utf-8`。
- 对包含中文的 payload 增加 snapshot 或字符串断言，避免误提交乱码。

### P3-03 Planner 仍是硬编码 MVP 规则，尚未达到更通用的独立规划能力

证据：

- `src/agent/planner.js:9` 到 `36` 基于关键词判断范围。
- `src/agent/planner.js:37` 到 `55` 固定生成 `audit.queryEvents` 和 `report.errorSummary` 两步。
- 设计允许第一阶段采用受约束规划：`v1.1/V2_FEISHU_INDEPENDENT_AGENT_DESIGN.md:340` 到 `359`，因此这不是第一版阻断问题。

影响：

- 当前 Agent 只覆盖异常查询和汇总场景。
- 用户请求稍微变化时，无法生成新的工具计划或澄清问题。
- “独立规划运行”的能力还处于演示级。

建议修复：

- 保留受约束规划，但把意图、槽位、工具模板配置化。
- 增加 plan validation，确保工具存在、输入合法、步骤可解释。
- 后续阶段再接入 LLM planner 或规则加模型的混合 planner。

### P3-04 缺少进程重启后的 in-flight run 恢复策略

证据：

- `scripts/server.js:54` 到 `60` 只恢复 Outbox pending 投递。
- 未看到 server 启动时扫描 `created/planning/running/waiting_user` run 并恢复或标记的逻辑。
- 设计阶段 6 是“补齐审计、恢复与上线准备”：`v1.1/V2_FEISHU_INDEPENDENT_AGENT_DESIGN.md:781` 到 `800`。

影响：

- 进程在工具执行中崩溃后，run 可能永久停在 `running`。
- 用户端无法收到失败结果，也无法知道是否应重试。

建议修复：

- server 启动时扫描非终态 run。
- 对 `running/planning` 超过阈值的 run 标记为 `failed` 并发送失败 `final_result`。
- 对 `waiting_user` 保留等待态，但补发 decision card 或提供查询状态。

## 建议修复顺序

1. 修复 P1-01：统一失败收敛，保证所有异常都有 `failed` 终态和失败 `final_result`。
2. 修复 P2-03：resume 必须做 run 状态、decision schema 校验。
3. 修复 P2-01：拆分创建和执行，实现真正异步 ACK。
4. 修复 P2-02：resume waiting 状态改为事务化或可重试。
5. 修复 P2-06：工具执行层增加 timeout、错误分类和统一结果 envelope。
6. 修复 P2-04：Outbox 增加退避、最大次数、dead-letter。
7. 修复 P2-05、P2-07：补齐幂等、HTTP 校验和错误码。
8. 修复 P2-08：统一 runtime audit 和 parser 事件契约。
9. 处理 P3：查询性能、编码守护、Planner 扩展、进程恢复。

## 第一阶段验收建议

在继续扩展 Planner 或飞书卡片之前，建议把以下测试补齐，并作为 v1.1 第一阶段验收门槛：

- 工具抛错时 run 进入 `failed`，Outbox 产生失败 `final_result`。
- 工具超时时 run 进入 `failed` 或按策略重试。
- `POST /v1/runs` 在工具延迟时仍快速返回 202。
- 非 waiting run resume 返回 409。
- 非法 `selected_option` 返回 400，waiting 仍为 pending。
- 同一 `message_id` 重复创建只返回同一个 run。
- callback 连续失败后进入 dead-letter 或 failed delivery 状态。
- runtime audit 事件可以通过 parser 校验。

## 当前不是问题的部分

- 没有直接接入飞书 SDK 不算问题。当前方案二的边界是 Agent 输出标准 payload，由飞书 Bot 转换为飞书卡片。
- SQLite 作为第一阶段运行时存储不算问题。当前目标是单体可靠跑通，不是先做分布式队列。
- 受约束 Planner 不算第一版阻断问题，但需要明确标注为 MVP 能力，不应被当作完整自主规划能力。
- 根据最新范围确认：这是内部使用工具，不会流出，也不需要权限控制。因此飞书用户身份校验、Bot 鉴权、签名校验和权限控制暂不纳入 v1.1 必修问题；后续如果开放到跨团队、公网或真实审批处置场景，再作为安全增强项重新评估。
