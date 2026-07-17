# 将任意 Agent 接入日志审计服务

本说明面向负责改造其他 Agent 的编码 Agent。完成本文中的改造后，上游 Agent 能把符合当前审计规范的日志可靠地发送到 `audit-logger-agent`，并可通过查询接口验证已入库。

本文不依赖 Docker，也不要求复用 `MT-agent` 或 `rental-price-agent` 的代码。它描述的是所有上游 Agent 都必须遵守的通用接入契约。

## 1. 完成标准

改造完成必须同时满足以下条件：

1. 每条审计事件先写入上游 Agent 自己的本地 NDJSON 文件。
2. 上游 Agent 以非阻塞方式把**同一份完整 payload** `POST` 到审计服务的 `/v1/ingest`。
3. 上游 Agent 读取响应体中的 `accepted`、`rejected` 与 `errors`；只有被接受的事件才算送达。
4. 网络错误、超时、非 2xx 或部分拒绝时，未确认事件进入本地重试队列，并在后续安全时机回放。
5. 重试不会重新生成时间、链路 ID 或业务字段，也不会改变业务主流程的成功/失败结果。
6. 可使用 `GET /query?trace_id=...` 查到一次完整请求或任务的事件链路。
7. 查询结果中的 `mapped_tool_type` 和 `mapping_status` 不能是 `unknown`；出现 `unknown` 视为接入不合格，必须修正 `tool_name`。

## 2. 接入前先确认边界

### 2.1 不需要预注册 Agent

HTTP ingest 会接收任意符合格式且 `agent_id` 合法的事件。也就是说，**写入日志不需要先在服务端创建 Agent 记录**。

改造 Agent 时必须保证：

- `agent_id` 是稳定的生产者 ID，例如 `catalog-agent`。
- 同一个 Agent 在所有事件中使用同一个 `agent_id`。
- `agent_id` 只包含字母、数字、`.`, `_`, `-`，不得包含路径片段或斜杠。

### 2.2 日志发送目标

所有上游 Agent 必须把日志发送到审计服务的 ingest endpoint：

```text
http://auditloggeragent-auditloggeragent-mue8ko-342fc3-18-141-240-9.traefik.me/v1/ingest
```

Agent 代码不得把该 URL 写死在业务调用点；必须从配置读取，便于不同环境覆盖。除非接入方明确提供网关认证要求，否则不要自行添加未在配置中声明的认证头或 Cookie。

## 3. 上游 Agent 必须新增的配置

Agent 必须在自己的配置层支持以下字段，并允许通过环境变量覆盖：

| 配置 | 作用 | 必须行为 |
| --- | --- | --- |
| `AUDIT_INGEST_URL` | 审计服务的完整 ingest 地址 | 默认指向 `http://auditloggeragent-auditloggeragent-mue8ko-342fc3-18-141-240-9.traefik.me/v1/ingest` |
| `AUDIT_INGEST_TIMEOUT_MS` | 单次 HTTP 发送超时 | 默认 `1500`，必须解析为有限正整数 |
| `AUDIT_RETRY_ENABLED` | 是否回放失败队列 | 默认 `true` |
| `AUDIT_RETRY_MAX_BATCH` | 一次最多回放的事件数 | 默认 `50`，必须解析为有限正整数 |
| `<AGENT>_AUDIT_LOG_DIR` | 本地审计日志和失败队列目录 | 必须指向 Agent 自己可写的持久目录 |

这组配置是上游 Agent 的改造接口，不是审计服务自动读取的环境变量。已有 Agent 可以保留其现有变量命名，但语义必须一致。

必须校验：

- URL 为空时，只关闭远程发送；本地原始审计日志仍应写入。
- 超时必须是有限正整数，且不应长到拖慢用户请求。
- 本地目录必须可写、可持久化，并与普通业务日志或临时目录隔离。
- 队列大小、最早待发送时间、发送失败率和磁盘空间应进入上游 Agent 的监控。

## 4. 必须新增或统一的审计日志模块

不要在业务调用点直接拼 HTTP 请求。为上游 Agent 新建或统一一个单独的 `auditLogger` 模块，并让所有运行时、工具和高风险操作经由它记录。

可参考本机已有的两个初步改造实现，但不要要求目标 Agent 直接复制代码：

| 参考 Agent | 可借鉴点 |
| --- | --- |
| `E:\工作空间\rental-price-agent-main\scripts\lib\audit-logger.js` | CommonJS 零依赖实现；本地 NDJSON、HTTP ingest、状态归一化、失败队列、`startSpan/endSpan` |
| `E:\工作空间\MT-agent-master\src\observability\auditLogger.ts` | TypeScript 实现；`fetch` 发送、失败队列、`llm_intent`、`entity`、高风险改价链路 |
| `E:\工作空间\rental-price-agent-main\scripts\sim-audit-drive.js` | 可运行的发送模拟，展示 batch/read/apply/verify 链路 |
| `E:\工作空间\MT-agent-master\scripts\sim-audit-drive.ts` | 可运行的发送模拟，展示 preview/confirmed apply 高风险链路 |

模块至少包含以下职责：

| 组件 | 必须行为 |
| --- | --- |
| 事件构造器 | 填充 canonical 字段，做状态码和敏感信息规范化 |
| 本地 writer | 追加写入 `audit-YYYY-MM-DD.jsonl`，每行一个完整 JSON |
| sender | 异步 POST 已落盘的同一 payload，并设置超时 |
| response handler | 解析 `accepted/rejected/errors`，逐条确认送达状态 |
| retry queue | 追加保存未确认事件，保留原始字段并提供有限批次回放 |
| flush | 在进程退出或明确收尾阶段等待已发起的发送任务 |

业务调用路径只能触发日志任务，不能等待远程审计结果。例如工具执行应按以下顺序组织：

```text
生成 tool.start
  -> 本地落盘
  -> 后台发送
  -> 执行业务工具
  -> 生成 tool.end 或 tool.error
  -> 本地落盘
  -> 后台发送
```

只有在进程退出、批处理任务结束或存在专门收尾阶段时，才允许调用类似 `await audit.flush()` 的方法等待一小段时间。即使 flush 失败，业务结果也不能被改写。

## 5. 事件数据契约

### 5.1 最小可接收事件

```json
{
  "ts": "2026-07-10T08:30:00.000Z",
  "agent_id": "catalog-agent",
  "trace_id": "request-8ecb",
  "span_id": "tool-27aa",
  "event": "tool.end",
  "tool_name": "catalog.getProduct",
  "status": "OK",
  "result_summary": "已读取商品摘要"
}
```

以下字段必填，缺少任意字段都会造成该事件被拒绝：

| 字段 | 类型与约束 | 改造要求 |
| --- | --- | --- |
| `ts` | 有效 ISO 8601 时间戳 | 创建一次后不可在重试时改写 |
| `agent_id` | 非空字符串，仅可含字母、数字、`.`, `_`, `-` | 使用稳定生产者标识，例如 `catalog-agent`；禁止 `/`、`\\`、`.`、`..` 或任何路径片段 |
| `trace_id` | 非空字符串 | 同一次用户请求或自治任务的全链路保持一致 |
| `span_id` | 非空字符串 | 同一工具调用的开始和结束使用同一个值；使用 UUID 或等价唯一值 |
| `event` | 字符串 | 新接入必须使用下文的 canonical 事件名 |
| `tool_name` | 稳定的工具或运行组件名称 | 例如 `catalog.updateProduct`；禁止随机值、请求参数或自然语言句子 |
| `status` | canonical gRPC code | 必须全大写，见下文状态码表 |
| `result_summary` | 已脱敏的短文本，最多 200 字符 | 说明结果，不复制完整请求、响应或页面内容 |

### 5.2 可选字段

```json
{
  "parent_span_id": "agent-5fd2",
  "duration_ms": 86,
  "channel": "http",
  "user_id": "u_123",
  "entity": { "type": "product", "id": "761" },
  "llm_intent": {
    "input": "查询商品 761 的当前状态",
    "output": "返回商品状态与库存摘要"
  },
  "error": {
    "message": "当前用户没有商品编辑权限"
  },
  "tags": ["read", "confirmed"]
}
```

| 字段 | 使用规则 |
| --- | --- |
| `parent_span_id` | 子调用关联父调用；没有父级则省略或传空字符串 |
| `duration_ms` | `tool.end` 和 `tool.error` 应填写毫秒耗时 |
| `channel` | 来源渠道，例如 `http`、`cli`、`feishu` |
| `user_id` | 用户触发的操作必须填写稳定、已脱敏的身份标识；自治任务可省略或留空 |
| `entity` | 同时提供非空字符串 `type` 和 `id`，例如商品、文档、数据库或任务的稳定 ID |
| `llm_intent` | 同时提供字符串 `input` 与 `output`，只保留经脱敏的意图摘要 |
| `error.message` | 失败原因的脱敏摘要；失败类别由 `status` 表示 |
| `tags` | 字符串数组，用于 `confirmed`、`retry`、`high-risk` 等稳定标签 |

### 5.3 禁止字段与敏感信息

以下内容不得发送：

- `product_id`。改用 `entity: { "type": "product", "id": "..." }`。
- `error.code` 或顶层 `error_code`。改用 canonical `status` 与 `error.message`。
- API Key、Cookie、Token、Authorization、密码、会话内容。
- 完整请求体、响应体、HTML、截图原文、未脱敏个人信息。
- 单事件大于服务端 `maxLineBytes` 的内容。默认最大 64 KiB。

如果业务结果很长，`result_summary` 只记录可审计摘要；大型产物保留在上游受控存储中，并通过稳定的 `entity` ID 或任务 ID 关联。

### 5.4 服务端接收与映射要求

服务端会先校验事件数据契约，再写入审计数据库。以下情况会导致该事件被拒收，并在 `/v1/ingest` 响应的 `rejected` 和 `errors` 中出现：

| 拒收原因 | Agent 必须修正 |
| --- | --- |
| 缺少 `ts`、`agent_id`、`trace_id`、`span_id`、`event`、`tool_name`、`status`、`result_summary` 任一必填字段 | 在事件构造器统一补齐 |
| `status` 不是 canonical 状态码 | 在发送前映射成本文状态码表中的值 |
| `ts` 不是可解析的 ISO 8601 时间 | 使用 `new Date().toISOString()` 或等价格式 |
| `result_summary` 超过 200 字符 | 发送前截断或改写为短摘要 |
| 出现 `product_id`、`error.code` 或顶层 `error_code` | 改用 `entity`、canonical `status` 和 `error.message` |
| `entity`、`llm_intent`、`tags` 类型不符合本文规则 | 发送前丢弃非法可选字段或修正结构 |
| 单事件或 NDJSON 单行超过服务端大小限制 | 减少摘要内容，禁止塞完整请求、响应、HTML 或截图文本 |

写入后，审计服务会根据 `tool_name` 生成工具语义映射字段，例如 `mapped_tool_type` 和 `mapping_status`。Agent 必须让 `tool_name` 能被稳定映射；如果最终映射为 `unknown`，虽然服务端可能已经接收该事件，但本接入验收应视为失败，因为风险发现和后续查询无法可靠理解该工具行为。

`tool_name` 必须遵守：

- 使用稳定、可复用的点号命名：`domain.action` 或 `domain.resource.action`。
- 名称中体现真实语义，让服务端能映射到 `read`、`write`、`update`、`delete`、`deploy`、`permission`、`credential`、`shell`、`browser`、`network`、`database`、`file`、`notification` 或 `llm`，不要落到 `unknown`。
- 读操作使用 `read`、`query`、`search`、`get`、`list`、`fetch` 等语义词，例如 `catalog.product.get`。
- 写入/创建使用 `write`、`create`、`insert`、`save`、`append`，例如 `order.note.create`。
- 更新使用 `update`、`patch`、`modify`、`edit`、`set`，例如 `rental.price.update`。
- 删除使用 `delete`、`remove`、`destroy`、`drop`、`truncate`，例如 `inventory.item.delete`。
- 部署使用 `deploy`、`release`、`publish`、`rollout`，例如 `service.deploy`。
- 权限和凭证分别使用 `permission`、`role`、`policy`、`grant`、`revoke`，或 `credential`、`secret`、`token`、`api_key`、`password`。
- Shell、浏览器、数据库、文件、通知、LLM 调用要在名称中显式包含对应语义词，例如 `shell.exec`、`browser.page.click`、`db.query`、`file.write`、`notification.send`、`llm.responses.create`。

不要使用：

- 随机值、自然语言句子、用户输入原文或动态 URL 作为 `tool_name`。
- `doTask`、`run`、`handler`、`callback`、`process` 这类无法判断读写语义的泛名。
- 同一工具在不同调用中变换命名。

高风险动作必须拆分为可审计链路，而不是只记录一个模糊工具名。例如改价应拆成 `rental.priceApply.preview`、等待确认、`rental.priceApply`、`rental.priceApply.verify`；参考 `MT-agent-master` 的模拟链路。

## 6. 事件、状态与链路设计

### 6.1 新 Agent 应使用的事件名

```text
tool.start   tool.end   tool.error
agent.start  agent.end  agent.error
run.start    run.resume run.waiting_user run.final_result run.failed
```

服务端可兼容 `tool/end`、`tool_end`、`tool-end` 等分隔符别名，但新接入不得依赖该兼容逻辑。未知事件不会丢失，但会以 `event = "unknown"` 存储，削弱查询、审查和风险检测能力。

### 6.2 状态码

`status` 必须为下列值之一：

```text
OK CANCELLED UNKNOWN INVALID_ARGUMENT DEADLINE_EXCEEDED NOT_FOUND
ALREADY_EXISTS PERMISSION_DENIED RESOURCE_EXHAUSTED FAILED_PRECONDITION
ABORTED OUT_OF_RANGE UNIMPLEMENTED INTERNAL UNAVAILABLE DATA_LOSS UNAUTHENTICATED
```

常用映射：

| 场景 | 应使用状态 |
| --- | --- |
| 成功完成 | `OK` |
| 用户取消、明确拒绝确认 | `CANCELLED` |
| 参数不完整或格式错误 | `INVALID_ARGUMENT` |
| 实体不存在 | `NOT_FOUND` |
| 执行前置条件不成立 | `FAILED_PRECONDITION` |
| 权限不足 | `PERMISSION_DENIED` |
| 远端服务不可达 | `UNAVAILABLE` |
| 调用超时 | `DEADLINE_EXCEEDED` |
| 未分类内部异常 | `INTERNAL` |

不要发送 `ok`、`success`、`failed`、`error` 等非 canonical 值。服务端不会把它们自动改写为合法状态码。

### 6.3 Trace 和 Span 规则

```text
run.start                 trace_id = req-100
  agent.start             trace_id = req-100, span_id = agent-1
    tool.start             trace_id = req-100, span_id = tool-1, parent_span_id = agent-1
    tool.end               trace_id = req-100, span_id = tool-1, parent_span_id = agent-1
  agent.end               trace_id = req-100, span_id = agent-1
run.final_result          trace_id = req-100
```

- 一次用户请求或一项自治任务只创建一个 `trace_id`。
- 一个工具调用只创建一个 `span_id`，并在 `tool.start` 与 `tool.end`/`tool.error` 间复用。
- 嵌套调用通过 `parent_span_id` 表达，不要依靠字符串拼接猜测父子关系。
- `tool.start` 必须有对应的结束或错误事件；缺少结束事件会被审查规则识别为链路不完整。

高风险操作应拆分为可审计步骤。例如更新商品时使用稳定工具名：

```text
catalog.update.preview   -> 生成变更预览
run.waiting_user         -> 等待用户确认
catalog.update.execute   -> 执行写入
catalog.update.verify    -> 验证最终状态
```

每个步骤各自记录 `tool.start` 和 `tool.end`/`tool.error`。确认完成后可添加 `confirmed` tag。

## 7. HTTP 发送契约

### 7.1 请求形式

| 形式 | Content-Type | 请求体 |
| --- | --- | --- |
| 单事件 | `application/json` | 一个事件对象 |
| 批量事件 | `application/json` | `{ "events": [ ... ] }` |
| NDJSON | `application/x-ndjson` | 每行一个事件对象 |

服务端默认限制：单请求最大 1 MiB，单事件或 NDJSON 单行最大 64 KiB。上游应在发送前限制事件大小；不可通过截断 JSON 来规避限制。

### 7.2 响应处理

单事件成功示例：

```json
{
  "accepted": 1,
  "rejected": 0,
  "errors": []
}
```

服务端返回 `202` 表示请求已被处理，但**不等于批次中所有事件都成功**。处理规则：

1. HTTP 非 2xx、网络错误或超时：本次事件都未确认，写入重试队列。
2. HTTP `202` 且 `rejected === 0`：本次事件全部确认。
3. HTTP `202` 且 `rejected > 0`：根据 `errors[].index` 找到未确认事件；仅移除已确认事件，其余写入队列或隔离区。
4. `400`、`413`、`415`：这是格式、字段或大小问题，不要无限快速重试；保留事件、记录错误并修复上游实现或配置。

服务端接收成功后会立即写入 SQLite 和服务端 spool。工具语义映射可能异步执行，不会阻塞 `202`，映射失败也不会使已接收日志丢失。

## 8. 可靠投递与回放

### 8.1 正确顺序

```text
构造并校验 canonical event
  -> 追加写入本地 audit-YYYY-MM-DD.jsonl
  -> 在后台发送相同 payload
  -> 根据响应确认或写入 audit-retry-queue.jsonl
  -> 下一次事件开始前或收尾阶段回放有限批次
```

本地事件文件是原始审计证据和恢复来源。重试队列是有限缓冲，不是归档目录。

### 8.2 回放规则

- 回放原始事件，不重新生成 `ts`、`agent_id`、`trace_id`、`span_id`、`event` 或业务字段。
- 保存原始序列化 payload，避免重试时字段排序、默认值或摘要发生变化。
- 服务端会对相同原始事件去重，因此投递语义应按 at-least-once 设计。
- 每轮最多回放 `AUDIT_RETRY_MAX_BATCH` 条，避免异常时占满业务线程、网络或内存。
- 队列持续增长、最早事件长期未发送、磁盘接近上限时必须告警。

## 9. 编码 Agent 的实施清单

按以下顺序改造目标 Agent：

1. 找到 Agent 的请求入口、任务入口和所有工具执行封装点。
2. 新建或统一 `auditLogger`，实现事件构造、本地 NDJSON、后台发送、响应处理、重试队列、回放和 `flush`。
3. 在请求或任务入口记录 `run.start`，生成并保存统一 `trace_id`。
4. 在 Agent 生命周期记录 `agent.start`、`agent.end` 或 `agent.error`。
5. 在每个工具封装处记录成对的 `tool.start` 与 `tool.end`/`tool.error`，并填充 `duration_ms`。
6. 为写入、删除、部署、权限、凭证、Shell、浏览器脚本等高风险动作补齐预览、确认、执行、验证记录。
7. 将旧字段转换为新格式：`product_id` 转为 `entity`，错误码转为 `status`，错误详情转为 `error.message`。
8. 添加上游配置读取和校验，支持可配置 ingest URL、超时、队列批量和本地目录。
9. 实施下文验收，不要以 Docker 多服务演示替代真实发送验证。

## 10. 验收步骤

### 10.1 配置发送地址

Agent 必须从配置读取 ingest URL。验收时先把目标地址设置为审计服务 ingest endpoint：

```powershell
$auditBaseUrl = 'http://auditloggeragent-auditloggeragent-mue8ko-342fc3-18-141-240-9.traefik.me'
$env:AUDIT_INGEST_URL = "$auditBaseUrl/v1/ingest"
```

如果目标 Agent 使用不同配置名，也必须映射到同一个 URL 语义：完整的 HTTP ingest 地址，而不是服务基地址或查询地址。

### 10.2 发送最小完整调用

以下 PowerShell 示例用同一 `trace_id` 和 `span_id` 发送成对的 `tool.start`、`tool.end`，同时验证结束事件的 `duration_ms`。请将 `catalog-agent` 替换为新 Agent 的稳定 ID：

```powershell
$auditBaseUrl = 'http://auditloggeragent-auditloggeragent-mue8ko-342fc3-18-141-240-9.traefik.me'
$env:AUDIT_INGEST_URL = "$auditBaseUrl/v1/ingest"
$traceId = "integration-$([guid]::NewGuid().ToString('N'))"
$spanId = [guid]::NewGuid().ToString('N')
$events = @(
  @{
    ts = (Get-Date).ToUniversalTime().ToString('o')
    agent_id = 'catalog-agent'
    trace_id = $traceId
    span_id = $spanId
    event = 'tool.start'
    tool_name = 'catalog.getProduct'
    status = 'OK'
    result_summary = '接入验证：开始读取商品'
    entity = @{ type = 'product'; id = '761' }
  },
  @{
    ts = (Get-Date).ToUniversalTime().ToString('o')
    agent_id = 'catalog-agent'
    trace_id = $traceId
    span_id = $spanId
    event = 'tool.end'
    tool_name = 'catalog.getProduct'
    status = 'OK'
    result_summary = '接入验证：商品读取完成'
    duration_ms = 1
    entity = @{ type = 'product'; id = '761' }
  }
) | ConvertTo-Json -Compress

$response = Invoke-RestMethod -Method Post `
  -Uri $env:AUDIT_INGEST_URL `
  -ContentType 'application/json' `
  -Body $events

if ($response.accepted -ne 2 -or $response.rejected -ne 0) {
  throw "ingest 未完整确认：$($response | ConvertTo-Json -Compress)"
}
```

### 10.3 查询链路

在同一 PowerShell 会话中执行：

```powershell
Invoke-RestMethod -Uri "$auditBaseUrl/query?trace_id=$traceId&limit=100"
```

返回应包含刚发送的两个事件。随后用真实 Agent 执行一次完整工具调用，并逐项确认：

- 相同 `trace_id` 下同时出现 `tool.start` 与 `tool.end` 或 `tool.error`。
- 开始和结束事件复用同一 `span_id`，没有只开始、不结束的孤立调用。
- `tool.end` 或 `tool.error` 包含非负 `duration_ms`。
- 重试后的事件仍保留原始 `trace_id`、`span_id`、事件名和时间戳。

验收时还必须检查查询结果中的工具语义映射字段：

- `mapped_tool_type` 不应为 `unknown`，除非该工具确实没有可判断语义。
- `mapping_status` 不应为 `unknown`。
- 如果出现 `unknown`，修改 Agent 的 `tool_name`，不要通过改 `result_summary` 或添加自然语言解释规避。

### 10.4 验证失败回放

1. 临时将上游的 ingest URL 指向不可达地址，执行一次不影响真实业务的工具调用。
2. 确认事件写入本地 `audit-retry-queue.jsonl`，业务调用仍按原本结果完成。
3. 恢复正确 URL，触发有限批次回放或调用 Agent 的收尾 flush。
4. 使用原始 `trace_id` 查询审计服务，确认事件出现且不重复入库。

## 11. 常见故障

| 现象 | 原因与处理 |
| --- | --- |
| `404` | URL 路径不是 `/v1/ingest`，或接入地址不是审计服务 ingest endpoint |
| `400` | JSON 结构不合法；检查必填字段、ISO 时间、状态码、`entity`、`llm_intent` 与 `result_summary` 长度 |
| `413` | 请求超过 `maxBodyBytes`；拆分批次，不能截断单个 JSON 事件 |
| `415` | `Content-Type` 不是 `application/json` 或 `application/x-ndjson` |
| `202` 但 `rejected > 0` | 批次部分拒绝；逐条处理 `errors`，未确认事件不能删除 |
| 收到 `202` 但查不到工具语义 | 语义映射异步执行；先确认事件已存在，稍后再查看映射结果 |
| 重试队列持续增长 | 检查 URL、DNS、网络连通性、超时、服务端大小限制和 payload 合法性 |
| `agent_id is invalid` | 使用稳定 ID；不得包含路径、空值、`.`、`..` 或斜杠 |

## 12. 交付物

改造提交应至少包含：

- 上游 Agent 的 `auditLogger` 模块及配置读取；
- 对请求、任务和工具执行点的审计埋点；
- 本地日志、失败队列和有限回放机制；
- 覆盖成功发送、字段拒绝、超时/网络失败、队列回放与 trace 查询的测试；

完成后，编码 Agent 应在交付说明中报告：实际 `agent_id`、实际 ingest URL、日志目录、重试策略和验证所用 `trace_id`。
