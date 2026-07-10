# Audit Logger Agent

`audit-logger-agent` 是跨 Agent 的审计日志服务。它接收上游 Agent 主动推送的审计事件，保留原始证据，写入本地 SQLite，并提供查询、报表、周期审查、风险 Finding 与 Dashboard。

本文档同时是上游接入契约。`MT-agent`、`rental-price-agent` 和后续 Agent 的日志改造必须遵守“上游接入要求”一章；不要依赖旧的跨机器目录扫描方案。

## 1. 边界与运行链路

服务负责：

- 接收 `POST /v1/ingest` 的 JSON 或 NDJSON 审计事件；
- 校验字段、将已知事件名规范化，保留原始请求对象；
- 同步写入 `audit_events`，并追加到服务端本地 spool；
- 对事件做工具语义映射、规则筛选、周期性 LLM 审查与通知；
- 提供健康检查、查询、报表和 Dashboard。

服务不负责：

- 扫描其他机器或其他容器中的日志目录；
- 替上游 Agent 生成缺失的链路、用户上下文或业务实体；
- 存储密钥、Cookie、令牌、完整页面内容或大段用户隐私。

```text
上游 Agent
  ├─ 本地 audit-YYYY-MM-DD.jsonl（完整 NDJSON，故障证据）
  ├─ 异步 POST /v1/ingest
  └─ 失败队列 audit-retry-queue.jsonl（重试与回放）
                         │
                         ▼
audit-logger-agent
  ├─ 校验、spool：data/spool/incoming/<agent_id>/audit-YYYY-MM-DD.jsonl
  ├─ SQLite：data/db/audit.db（HTTP 接收成功时立即写入）
  └─ 语义映射 → 审查/通知 → 查询、报表、Dashboard
```

spool 是原始接收副本与恢复来源。周期审查也会增量读取它；由于 SQLite 使用 `raw_json` 的哈希去重，重复读取不会重复入库。它不改变 HTTP 收到事件后“立即入库”的行为。

## 2. 快速启动

### 2.1 前提

- Node.js 20 或更高版本；
- 项目目录可写，用于 `data/` 和 `logs/`；
- 若启动完整服务，需要可用的 OpenAI 兼容 LLM 凭证；
- 生产环境应使用受控内网或网关，不能将未鉴权的 ingest 端点直接暴露到公网。

安装依赖并启动：

```powershell
Set-Location E:\工作空间\audit-logger-agent
npm install
npm run server -- --port 9320
```

验证：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:9320/health'
```

返回 `status: "ok"` 且数据库可写表示服务可用。服务端实际监听地址由 `--bind` 或 `auditReview.http.bindHost` 控制；本地部署应保持 `127.0.0.1`，容器内跨服务访问才使用私网地址或 `0.0.0.0`。

### 2.2 LLM 配置

在项目根目录创建未纳入 Git 的 `.config`（JSON，不是 `.env`）：

```json
{
  "AUDIT_AGENT_LLM_API_KEY": "<api-key>",
  "AUDIT_AGENT_LLM_BASE_URL": "https://api.openai.com/v1",
  "AUDIT_AGENT_LLM_MODEL": "<model-name>",
  "AUDIT_AGENT_LLM_TIMEOUT_MS": "30000"
}
```

环境变量优先于 `.config`。手动触发审查的 Bearer Token 只从环境变量读取：

```powershell
$env:AUDIT_AGENT_DASHBOARD_TOKEN = 'replace-with-a-secret'
```

### 2.3 Docker Compose 演示

工作区根目录的 [docker-compose.yml](../docker-compose.yml) 启动审计服务、`mt-agent` 和 `rental-agent` 三个容器，并将两个上游 Agent 的 ingest 地址分别指向：

```text
http://audit:9320/v1/ingest
```

该编排使用模拟 LLM 凭证，只用于验证日志传输链路；不要照搬到生产环境。

## 3. 配置与数据目录

`config.json` 的常用字段：

| 字段 | 作用 | 默认/注意事项 |
| --- | --- | --- |
| `dbPath` | SQLite 数据库路径 | `data/db/audit.db` |
| `ingest.http.enabled` | 是否启用 HTTP ingest | 默认为启用 |
| `ingest.http.maxBodyBytes` | 单次请求最大字节数 | 默认 1 MiB |
| `ingest.http.maxLineBytes` | 单个事件或 NDJSON 单行最大字节数 | 默认 64 KiB |
| `ingest.spoolDir` | HTTP 接收副本目录 | `data/spool/incoming` |
| `logDir` | 服务运行日志目录 | `logs` |
| `auditReview.enabled` | 是否启动周期审查 | 本地 `config.json` 默认启用；容器示例默认关闭 |
| `auditReview.intervalMinutes` | 审查间隔 | 默认 30 分钟 |
| `auditReview.notification.callbackUrl` | Finding/摘要通知回调 | 必须是受控接收端 |
| `auditReview.http.bindHost` | HTTP 监听主机 | 本地建议 `127.0.0.1` |
| `retention` | 数据库与运行目录清理策略 | 生产前按留存要求评审 |

运行时目录均相对项目根目录解析，可通过 `paths` 覆盖。服务只管理自身的 `data/`、`logs/`、`tmpDir` 和 `capturesDir`，不会清理上游 Agent 的日志目录或工作区配置。

## 4. 上游 Agent 接入要求

这是所有新接入方必须实现的最小能力。

### 4.1 传输与可靠性

1. 每个事件先本地追加为一行完整 JSON，文件名使用 `audit-YYYY-MM-DD.jsonl`。
2. 用非阻塞方式将**同一个规范化 payload** `POST` 到 `/v1/ingest`。审计不可拖慢业务主流程。
3. 网络错误、超时、非 2xx，或响应中 `rejected > 0` 时，把未确认事件写入本地重试队列；后续业务事件开始时或进程退出前回放有限批次。
4. 回放必须保留原始 `ts`、`agent_id`、`trace_id`、`span_id` 和其他字段，不能重新生成事件。服务按原始 JSON 哈希去重，传输语义是 at-least-once。
5. 队列读写、日志写入和 ingest 失败只能记录诊断信息，不能改变业务动作的成功/失败结果。
6. 队列是有限回放缓冲而非长期归档；需要监控其持续增长、磁盘空间和错误率。

当前服务端没有 ingest 认证。只有同一受控内网中的 Agent 可以访问；跨机器或跨信任边界时，必须先通过 TLS、网络隔离和具备认证能力的反向代理保护端点。

### 4.2 HTTP 契约

| 项目 | 要求 |
| --- | --- |
| 方法与路径 | `POST /v1/ingest` |
| 单事件 | `Content-Type: application/json`，请求体为事件对象 |
| 批量事件 | `application/json`，请求体为 `{ "events": [...] }` |
| NDJSON | `Content-Type: application/x-ndjson`，每行一个事件对象 |
| 成功响应 | `202`，响应含 `accepted`、`rejected`、`errors` |
| 不支持媒体类型 | `415` |
| 请求体超过限制 | `413` |
| JSON 不合法或请求体结构错误 | `400` |

发送单事件示例：

```powershell
$event = @{
  ts = '2026-07-10T08:30:00.000Z'
  agent_id = 'example-agent'
  trace_id = 'request-8ecb'
  span_id = 'tool-27aa'
  event = 'tool.end'
  tool_name = 'catalog.getProduct'
  status = 'OK'
  result_summary = '读取商品摘要完成'
  duration_ms = 86
  channel = 'http'
  entity = @{ type = 'product'; id = '761' }
} | ConvertTo-Json -Compress

Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:9320/v1/ingest' `
  -ContentType 'application/json' -Body $event
```

成功示例：

```json
{"accepted":1,"rejected":0,"errors":[]}
```

批次可能部分成功。接入方必须读取响应体：只把被服务端确认的事件视为成功；若 `rejected` 非零，记录 `errors`，并让未确认事件进入队列或人工排查。不要因为一次 `202` 就忽略部分拒绝。

### 4.3 事件字段

必填字段：

| 字段 | 类型 | 具体要求 |
| --- | --- | --- |
| `ts` | string | 有效 ISO 8601 时间戳，回放时保持原值。 |
| `agent_id` | string | 稳定的生产者标识；仅允许字母、数字、`.`, `_`, `-`，不能含路径或 `..`。 |
| `trace_id` | string | 覆盖一次用户请求或一项自治任务的全链路。 |
| `span_id` | string | 覆盖一个 Agent/工具调用单元；建议 UUID。 |
| `event` | string | 见“事件名”。 |
| `tool_name` | string | 稳定的业务工具或运行组件名称，不能用自然语言描述替代。 |
| `status` | string | gRPC canonical code，见“状态码”。 |
| `result_summary` | string | 简短、可审计，最多 200 个字符。 |

可选字段：

| 字段 | 类型 | 何时填写 |
| --- | --- | --- |
| `parent_span_id` | string | 子工具调用关联父 span；没有父级则省略或使用空字符串。 |
| `duration_ms` | number | 结束或错误事件的耗时，单位毫秒。 |
| `channel` | string | 例如 `feishu`、`http`、`cli`。 |
| `user_id` | string | 用户触发的操作必须提供；自治任务可省略。 |
| `entity` | object | `{ "type": "product", "id": "761" }`；两个值都必须是非空字符串。 |
| `llm_intent` | object | LLM 驱动的工具调用可填写 `{ "input": "...", "output": "..." }`。 |
| `error` | object | 仅允许 `error.message`，放置经脱敏的失败原因。 |
| `tags` | string[] | 例如 `confirmed`、`high-risk`、`retry`。 |

禁止发送：

- `product_id`：改用 `entity: { type: "product", id: "..." }`；
- `error.code` 或顶层 `error_code`：改用 canonical `status` 与 `error.message`；
- API Key、Cookie、Token、Authorization、完整请求/响应体、页面 HTML、未脱敏个人数据；
- 大于 64 KiB 的单事件或超过服务端 `maxBodyBytes` 的请求。

### 4.4 事件名与状态码

上游应直接使用 canonical 事件名：

```text
tool.start   tool.end   tool.error
agent.start  agent.end  agent.error
run.start    run.resume run.waiting_user run.final_result run.failed
```

服务也接受上述名称的分隔符别名，例如 `tool/end`、`tool_end`、`tool-end`，并规范化为 `tool.end`。未知事件仍会接收并以 `event = "unknown"` 入库，原始值保存在 `raw_json`；这是一种兼容兜底，不是新接入的推荐写法。

`status` 必须是以下全大写 canonical 值之一：

```text
OK CANCELLED UNKNOWN INVALID_ARGUMENT DEADLINE_EXCEEDED NOT_FOUND
ALREADY_EXISTS PERMISSION_DENIED RESOURCE_EXHAUSTED FAILED_PRECONDITION
ABORTED OUT_OF_RANGE UNIMPLEMENTED INTERNAL UNAVAILABLE DATA_LOSS UNAUTHENTICATED
```

特别注意：ingest 端点不会把 `ok`、`success`、`failed` 等别名自动转换为 canonical code。上游日志器可以在本地规范化这些别名，但实际发送的 payload 必须是 `OK`、`INTERNAL` 等上述值。

### 4.5 链路与业务语义

- 每个请求或自治任务创建一个稳定 `trace_id`；不要为 start/end 各生成 trace。
- 对同一工具调用使用同一 `span_id`：`tool.start` 后必须是 `tool.end` 或 `tool.error`，并在结束事件填写 `duration_ms`。
- 嵌套调用以 `parent_span_id` 建树；顶层 Agent span 没有父 span。
- 高风险操作至少记录预览、用户确认（如适用）、实际执行和校验结果。`tool_name`、`tags`、`entity` 和脱敏后的 `llm_intent` 应足以让审计人员判断动作性质。
- 审计服务会按照 `tool_name`、`result_summary`、`llm_intent`、错误与上下文做工具语义映射；名称应保持稳定、可读、可区分，例如 `rental.priceApply`，不要使用随机或含请求参数的名称。

## 5. 两个已接入 Agent 的改造说明

### 5.1 MT-agent

实现位置：[src/observability/auditLogger.ts](../MT-agent-master/src/observability/auditLogger.ts)。现有实现会写本地 `audit-YYYY-MM-DD.jsonl`，异步推送同一 payload，并把失败事件追加到 `audit-retry-queue.jsonl`；每次记录新事件前尝试回放最多 50 条。

配置：

| 环境变量 | 含义 |
| --- | --- |
| `AUDIT_LOGGER_INGEST_URL` | ingest 地址；设为空字符串可关闭主动推送。默认 `http://127.0.0.1:9320/v1/ingest`。 |
| `AUDIT_LOGGER_INGEST_TIMEOUT_MS` | 单次请求超时，默认 1500 ms。 |
| `AUDIT_LOGGER_RETRY_ENABLED` | `false` 或 `0` 时关闭队列回放；默认启用。 |
| `MT_AUDIT_LOG_DIR` | 本地审计日志和重试队列目录。 |

集成时使用 `createAuditLogger('mt-agent', logDir)`，业务收尾前调用 `await audit.flush()`；需要显式排空已有缓冲时调用 `await audit.flushRetryQueue()`。不要在业务代码中自行拼装一个字段不同的 HTTP payload。

### 5.2 rental-price-agent

实现位置：[scripts/lib/audit-logger.js](../rental-price-agent-main/scripts/lib/audit-logger.js)。行为与 MT-agent 相同，但支持从其 `config.audit.ingest`、构造参数和环境变量合并配置；每次新事件前回放队列。

| 环境变量 | 含义 |
| --- | --- |
| `AUDIT_INGEST_URL` | ingest 地址；默认 `http://127.0.0.1:9320/v1/ingest`。 |
| `AUDIT_INGEST_TIMEOUT_MS` | 单次请求超时，默认 1500 ms。 |
| `AUDIT_RETRY_ENABLED` | `false` 或 `0` 时关闭失败队列；默认启用。 |
| `AUDIT_RETRY_MAX_BATCH` | 每轮回放数量；默认 50，必须是正整数。 |
| `RENTAL_AUDIT_LOG_DIR` | 本地审计日志和重试队列目录。 |

集成时使用 `createAuditLogger('rental-price-agent', logDir, { getConfig })`，并在可等待的收尾阶段调用 `await audit.flush()`；可按需调用 `await audit.flushRetryQueue()`。

现有日志器会把旧调用点的 `product_id` 规范化为 `entity`，并把常见业务状态映射为 canonical `status`。新业务代码仍应直接传 `entity` 与 canonical 状态，避免依赖兼容逻辑。

## 6. 查询、审查与运维

### 6.1 常用接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 服务与数据库健康状态。 |
| `GET` | `/query` | 查询事件。支持 `agent_id`、`trace_id`、`status`、`event`、`tool_name`、`entity_type`、`entity_id`、`channel`、`from`、`to`、分页等。 |
| `GET` | `/report/daily` | 每日汇总。 |
| `GET` | `/report/errors` | 错误报表。 |
| `GET` | `/report/tools` | 工具使用统计。 |
| `POST` | `/v1/ingest` | 上游写入审计事件。 |
| `POST` | `/v1/audit-reviews/run` | 手动触发审查；始终需要 Bearer Token。 |
| `GET` | `/dashboard` | Dashboard。 |

按 trace 验证写入：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:9320/query?trace_id=request-8ecb&limit=100'
```

服务端在收到事件后会异步执行工具语义映射；因此查询到事件不代表其 `mapped_tool_type` 已立即完成。映射失败会降级为 `unknown`，不会丢弃已接收日志。

### 6.2 运行日志、留存与备份

- 服务日志写入 `logs/server.log` 与 `logs/server.err.log`；根目录 `.server.log`、`.server.err.log` 与 `.callback-*.log`、`.callback-*.err.log` 仅为 runtime path migration 兼容项，不是正常运行路径，也 not part of app self-cleanup；
- SQLite 使用 WAL 模式。备份前应使用适合 SQLite WAL 的备份方式，或在维护窗口一致性复制数据库及 WAL/SHM 文件。例如在有 `sqlite3` 的受控维护窗口，可执行 `sqlite3 data/db/audit.db ".backup 'data/db/audit.db.backup'"`；
- 用 `node scripts/prune.js --dry-run` 先预览留存清理；实际清理前需复核 `retention` 配置和备份；
- spool 仅在确认整文件已被 ingest cursor 消费且达到留存周期后才可删除；
- 不要手动删除仍有重试队列的上游日志目录，否则会丢失未确认事件。

服务拥有的临时与捕获目录为 `data/tmp/`、`data/captures/` 和 `logs/`。`.agents/`、`.claude/`、`.superpowers/`、`record.json`、`Typora_Hook_Log.txt` 均 outside app self-cleanup scope，留存任务不会扫描或删除它们。

### 6.3 长期运行

- `.config` 含 `AUDIT_AGENT_LLM_API_KEY` 等敏感配置。在 Linux/macOS 上执行 `chmod 600 .config`，并用服务账户限制目录访问；
- 需要进程守护时可使用 PM2：`pm2 start npm --name audit-logger-agent -- run server -- --port 9320`，随后执行 `pm2 startup` 并按 PM2 输出保存启动配置；
- 使用 systemd 时，服务单元应设置 `Restart=always`，并以专用非 root 账户运行；
- 使用 logrotate 管理 `logs/*.log`，轮转后保留适合故障排查的周期，避免日志无限增长；
- 不要把 SQLite 主文件、WAL、重试队列或 `.config` 纳入发布制品和 Git。

### 6.4 故障定位顺序

1. `GET /health`：先确认服务与 SQLite 可写。
2. 检查上游 HTTP 响应：关注 `accepted`、`rejected` 与 `errors`，不是只看状态码。
3. 检查 `logs/server.err.log` 和上游的失败队列大小。
4. 使用 `/query?trace_id=...` 验证完整链路；缺少 end/error 时检查业务收尾的 `flush()`。
5. 若 Dashboard 没有新 Finding，检查 `auditReview.enabled`、审查批次、候选数、LLM 凭证和 Finding 去重状态。

常见原因：

| 现象 | 首先检查 |
| --- | --- |
| `400` | JSON 结构、必填字段、ISO 时间、canonical `status`、`result_summary` 长度。 |
| `413` | `maxBodyBytes` 或 `maxLineBytes`；分批发送，不能截断一个 JSON 事件。 |
| `415` | `Content-Type` 是否为 `application/json` 或 `application/x-ndjson`。 |
| `202` 但 `rejected > 0` | 逐项处理响应 `errors`，未确认事件不能从队列删除。 |
| 重试队列持续增长 | ingest URL、DNS/网络、服务健康、超时设置、服务端限制与 payload 合法性。 |
| 查询有事件但没有工具类型 | 语义映射异步执行；稍后重查 `mapping_status`。 |

## 7. 提交前接入检查清单

- [ ] 上游发送的是本地已记录的同一个完整 payload。
- [ ] 每次用户/任务使用统一 `trace_id`；每个调用的 start/end/error 使用统一 `span_id`。
- [ ] 请求 payload 不含 `product_id`、`error.code`、非 canonical `status` 或敏感信息。
- [ ] 接入端已处理网络异常、超时、非 2xx 与 `rejected > 0`。
- [ ] 重试队列回放不改变原始事件字段，且不会阻塞主业务流程。
- [ ] 已用真实服务验证 `/health`、一次成功 ingest、一次查询和至少一个失败回放场景。
- [ ] 部署网络未将未鉴权的 ingest 或查询端点暴露给不受信任的来源。
