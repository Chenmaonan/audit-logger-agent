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

## 2. 接入前先确认边界

### 2.1 服务端并不要求预注册 Agent

HTTP ingest 会接收任意符合格式且 `agent_id` 合法的事件。也就是说，**写入日志不需要先在服务端创建 Agent 记录**。

但新 Agent 上线前仍应在审计服务的 `config.json` 中补充以下可选配置：

- `agents.<agent_id>.displayName`：Dashboard 和 Finding 中展示人类可读名称；未配置时直接显示 `agent_id`。
- `auditReview.riskPolicy.agentToolAllowlists.<agent_id>`：该 Agent 的允许工具名列表。列表非空时，调用名单外工具会被标记为异常调用；它不阻止日志接收。

示例：

```json
{
  "agents": {
    "catalog-agent": {
      "displayName": "商品目录 Agent"
    }
  },
  "auditReview": {
    "riskPolicy": {
      "agentToolAllowlists": {
        "catalog-agent": [
          "catalog.getProduct",
          "catalog.updateProduct"
        ]
      }
    }
  }
}
```

暂时无法列全工具时，可先使用空数组，后续再补齐。不要为了避免告警而填写不相关的工具名。

### 2.2 网络与安全边界

审计服务的默认监听地址是 `127.0.0.1`。同机部署时，上游地址应为：

```text
http://127.0.0.1:9320/v1/ingest
```

跨机器部署时，由服务端运维人员在 `config.json` 设置受控私网监听地址：

```json
{
  "auditReview": {
    "http": {
      "bindHost": "10.10.20.15"
    }
  }
}
```

然后启动服务：

```powershell
npm run server -- --port 9320
```

上游使用：

```text
http://10.10.20.15:9320/v1/ingest
```

当前 `/v1/ingest` 没有内建认证。不要把它直接暴露到公网，也不要假设附加 `Authorization` 请求头就会被应用校验。跨主机时必须至少满足其一：

- 上游和审计服务位于同一受控私网，并以防火墙或安全组限制来源；
- 通过反向代理或网关提供 TLS、身份认证与来源限制，并且仅放行必要路由；
- 使用受控 VPN、mTLS 或等效的网络身份边界。

审计服务的 Dashboard 页面不要求登录，Dashboard Token 也不用于 ingest 认证，不能用它代替网络隔离。

## 3. 上游 Agent 必须新增的配置

审计服务不强制上游使用某组环境变量名。新 Agent 应在自己的配置层定义等价配置，并让它们可由环境变量覆盖。推荐字段如下：

| 建议配置 | 作用 | 推荐默认值 |
| --- | --- | --- |
| `AUDIT_INGEST_URL` | 审计服务的完整 ingest 地址 | 同机时 `http://127.0.0.1:9320/v1/ingest` |
| `AUDIT_INGEST_TIMEOUT_MS` | 单次 HTTP 发送超时 | `1500` |
| `AUDIT_RETRY_ENABLED` | 是否回放失败队列 | `true` |
| `AUDIT_RETRY_MAX_BATCH` | 一次最多回放的事件数 | `50` |
| `<AGENT>_AUDIT_LOG_DIR` | 本地审计日志和失败队列目录 | Agent 自己可写的持久目录 |

这组配置是上游 Agent 的改造接口，不是审计服务自动读取的环境变量。已有 Agent 可以保留其现有变量命名，但语义必须一致。

必须校验：

- URL 为空时，只关闭远程发送；本地原始审计日志仍应写入。
- 超时必须是有限正整数，且不应长到拖慢用户请求。
- 本地目录必须可写、可持久化，并与普通业务日志或临时目录隔离。
- 队列大小、最早待发送时间、发送失败率和磁盘空间应进入上游 Agent 的监控。

## 4. 必须新增或统一的审计日志模块

不要在业务调用点直接拼 HTTP 请求。为上游 Agent 新建或统一一个单独的 `auditLogger` 模块，并让所有运行时、工具和高风险操作经由它记录。

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
| `span_id` | 非空字符串 | 同一工具调用的开始和结束使用同一个值；建议 UUID |
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

| 场景 | 推荐状态 |
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
- 建议保存原始序列化 payload，避免重试时字段排序、默认值或摘要发生变化。
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
9. 在审计服务 `config.json` 添加新 Agent 的显示名；工具清单明确后增加 allowlist。
10. 实施下文的本地与部署验收，不要以 Docker 多服务演示替代验收。

## 10. 验收步骤

### 10.1 启动并检查审计服务

服务启动前，运维人员必须已通过未纳入 Git 的 `.config` 或环境变量提供 `AUDIT_AGENT_LLM_API_KEY` 和 `AUDIT_AGENT_LLM_MODEL`；缺少任一项时服务不会启动。`AUDIT_AGENT_LLM_BASE_URL` 和 `AUDIT_AGENT_LLM_TIMEOUT_MS` 可按实际 LLM 服务配置。

在审计服务目录执行：

```powershell
npm run server -- --port 9320
Invoke-RestMethod -Uri 'http://127.0.0.1:9320/health'
```

返回中应表明服务正常且数据库可写。

### 10.2 发送最小事件

以下 PowerShell 示例可验证服务端契约。请将 `catalog-agent` 替换为新 Agent 的稳定 ID：

```powershell
$traceId = "integration-$([guid]::NewGuid().ToString('N'))"
$event = @{
  ts = (Get-Date).ToUniversalTime().ToString('o')
  agent_id = 'catalog-agent'
  trace_id = $traceId
  span_id = [guid]::NewGuid().ToString('N')
  event = 'tool.end'
  tool_name = 'catalog.getProduct'
  status = 'OK'
  result_summary = '接入验证：商品读取完成'
  entity = @{ type = 'product'; id = '761' }
} | ConvertTo-Json -Compress

$response = Invoke-RestMethod -Method Post `
  -Uri 'http://127.0.0.1:9320/v1/ingest' `
  -ContentType 'application/json' `
  -Body $event

if ($response.accepted -ne 1 -or $response.rejected -ne 0) {
  throw "ingest 未完整确认：$($response | ConvertTo-Json -Compress)"
}
```

### 10.3 查询链路

在同一 PowerShell 会话中执行：

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:9320/query?trace_id=$traceId&limit=100"
```

返回应包含刚发送的事件。随后用真实 Agent 执行一次完整工具调用，确认相同 `trace_id` 下同时出现 `tool.start` 与 `tool.end` 或 `tool.error`。

### 10.4 验证失败回放

1. 临时将上游的 ingest URL 指向不可达地址，执行一次不影响真实业务的工具调用。
2. 确认事件写入本地 `audit-retry-queue.jsonl`，业务调用仍按原本结果完成。
3. 恢复正确 URL，触发有限批次回放或调用 Agent 的收尾 flush。
4. 使用原始 `trace_id` 查询审计服务，确认事件出现且不重复入库。

## 11. 常见故障

| 现象 | 原因与处理 |
| --- | --- |
| `404` | `ingest.http.enabled` 为 `false`，或 URL 路径不是 `/v1/ingest` |
| `400` | JSON 结构不合法；检查必填字段、ISO 时间、状态码、`entity`、`llm_intent` 与 `result_summary` 长度 |
| `413` | 请求超过 `maxBodyBytes`；拆分批次，不能截断单个 JSON 事件 |
| `415` | `Content-Type` 不是 `application/json` 或 `application/x-ndjson` |
| `202` 但 `rejected > 0` | 批次部分拒绝；逐条处理 `errors`，未确认事件不能删除 |
| 收到 `202` 但查不到工具语义 | 语义映射异步执行；先确认事件已存在，稍后再查看映射结果 |
| 重试队列持续增长 | 检查 URL、DNS、网络策略、服务健康、超时、服务端大小限制和 payload 合法性 |
| `agent_id is invalid` | 使用稳定 ID；不得包含路径、空值、`.`、`..` 或斜杠 |

## 12. 交付物

改造提交应至少包含：

- 上游 Agent 的 `auditLogger` 模块及配置读取；
- 对请求、任务和工具执行点的审计埋点；
- 本地日志、失败队列和有限回放机制；
- 覆盖成功发送、字段拒绝、超时/网络失败、队列回放与 trace 查询的测试；
- 审计服务中该 Agent 的显示名和已确认工具 allowlist（若已具备工具清单）。

完成后，编码 Agent 应在交付说明中报告：实际 `agent_id`、ingest URL 部署方式、日志目录、重试策略、验证所用 `trace_id`，以及任何暂未配置的网络认证或工具白名单项。

## 相关文档

- [README：项目概览与部署入口](../README.md#接入与部署)
- [其他 Agent 服务化接入改造方案](other-agent-server-integration-plan-2026-07-07.md)
