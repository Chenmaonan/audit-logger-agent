# Audit Logger Agent

`audit-logger-agent` 是一个本地运行的 Agent 审计日志中台。它负责采集多个 Agent 输出的 NDJSON 审计日志，写入本地 SQLite，提供命令行查询、HTTP API、周期性 LLM 审查、风险发现 Dashboard 和回调通知。

本文档面向部署和运维，说明如何配置、启动、关闭、采集日志、查询数据，以及上游 Agent 需要携带哪些日志字段。

## 适用范围

适合以下场景：

- 多个 Agent 都会产生日志，需要统一归档和查询。
- 需要按 `trace_id` 还原一次任务里的工具调用顺序。
- 需要周期性发现失败调用、高风险工具调用、异常调用、重复调用和链路缺失。
- 需要用 LLM 对候选事件做结构化审查，生成可读的风险 finding。
- 需要本地 Dashboard 查看审查批次、风险发现、工具调用顺序和 LLM 链路分析。

## 运行时组成

```text
上游 Agent 审计日志 (*.jsonl)
  -> ingest / scheduler 增量采集
  -> audit_events SQLite 表
     -> CLI 查询 / 报表
     -> HTTP 查询 / 报表 API
     -> LLM Runtime 本地工具
     -> Audit Review 周期性审查
        -> 规则预筛
        -> LLM 结构化审查
        -> audit_review_runs / audit_review_findings
        -> Dashboard / Callback 通知
```

核心目录：

```text
config.json               主配置文件
package.json              npm 脚本和依赖
scripts/ingest.js         批量采集日志
scripts/query.js          命令行查询审计事件
scripts/report.js         命令行报表
scripts/server.js         HTTP 服务入口
scripts/lib/              解析、扫描、数据库基础能力
src/                      服务端运行源码
data/audit.db             本地 SQLite 数据库，本地生成，不进入 Git
.config                   本地 LLM 凭证，本地创建，不进入 Git
```

## 环境要求

- Node.js 20 或更高版本。
- 能访问上游 Agent 日志目录的本地文件权限。
- 项目目录可写，用于创建 `data/audit.db`。
- 启动 `server` 模式时必须提供 OpenAI 兼容 LLM 凭证。
- 如果启用回调通知，需要准备一个可访问的 HTTP 回调接收端。

安装依赖：

```bash
npm install
```

Windows PowerShell 下也可以使用同一命令。

## 配置文件

### `config.json`

`config.json` 是主配置文件。当前默认配置采集两个上游 Agent：

```json
{
  "dbPath": "data/audit.db",
  "agents": {
    "rental-price-agent": {
      "logDir": "../../rental-price-agent-main/tasks/logs",
      "pattern": "audit-*.jsonl"
    },
    "mt-agent": {
      "logDir": "../../MT-agent-master/output/logs",
      "pattern": "audit-*.jsonl"
    }
  }
}
```

关键字段：

| 字段 | 说明 |
| --- | --- |
| `dbPath` | SQLite 数据库路径。目录不存在时会自动创建。 |
| `agents` | 需要采集的上游 Agent 列表。对象 key 通常与日志里的 `agent_id` 对应。 |
| `agents.<id>.logDir` | 该 Agent 的日志目录。 |
| `agents.<id>.pattern` | 日志文件匹配模式，常用 `audit-*.jsonl`。 |
| `auditReview.enabled` | 是否启动周期性审查调度器。 |
| `auditReview.intervalMinutes` | 周期性审查间隔，单位分钟。 |
| `auditReview.initialDelaySeconds` | 服务启动后第一次自动审查延迟秒数。 |
| `auditReview.lookbackOverlapMinutes` | 审查窗口回看重叠时间，用于降低边界漏采风险。 |
| `auditReview.maxEventsPerReview` | 单轮审查最多送入规则和 LLM 的事件数量上限。 |
| `auditReview.notification.callbackUrl` | 审查摘要和高风险 finding 的通知回调地址。 |
| `auditReview.http.requireDashboardToken` | 是否要求 Dashboard 读接口也必须带 Token。 |
| `auditReview.http.allowedOrigins` | 审查 API 和 Dashboard 的 CORS 白名单。 |
| `auditReview.riskPolicy.highRiskToolPatterns` | 本地规则中被视为高风险的工具名模式。 |
| `auditReview.riskPolicy.agentToolAllowlists` | Agent 允许调用的工具清单。空数组表示未配置允许工具，会更容易触发异常调用。 |
| `auditReview.visualization.baseUrl` | 通知中生成 Dashboard 链接的地址前缀。 |
| `auditReview.visualization.dashboardPath` | Dashboard 路由前缀，默认 `/dashboard`。 |

### `.config`

`.config` 用于本地 LLM 凭证，必须手动创建，内容是 JSON，不是 `.env` 格式。

示例：

```json
{
  "AUDIT_AGENT_LLM_API_KEY": "<your-api-key>",
  "AUDIT_AGENT_LLM_BASE_URL": "https://api.openai.com/v1",
  "AUDIT_AGENT_LLM_MODEL": "<your-model>",
  "AUDIT_AGENT_LLM_TIMEOUT_MS": "30000"
}
```

加载优先级：

```text
进程环境变量 > .config > config.json.planner
```

LLM 相关变量：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `AUDIT_AGENT_LLM_API_KEY` | 是 | OpenAI 兼容 API Key。 |
| `AUDIT_AGENT_LLM_MODEL` | 是 | 模型名称。 |
| `AUDIT_AGENT_LLM_BASE_URL` | 否 | OpenAI 兼容网关地址，默认 `https://api.openai.com/v1`。 |
| `AUDIT_AGENT_LLM_TIMEOUT_MS` | 否 | LLM 请求超时时间，默认 `30000`。 |

Dashboard / 手动审查写接口 Token：

| 变量 | 说明 |
| --- | --- |
| `AUDIT_AGENT_DASHBOARD_TOKEN` | `POST /v1/audit-reviews/run` 必须使用的 Bearer Token。 |

建议把 `AUDIT_AGENT_DASHBOARD_TOKEN` 放在进程环境变量中，不要写入 `.config`。当前 `.config` 不参与 Dashboard Token 加载。

PowerShell 示例：

```powershell
$env:AUDIT_AGENT_DASHBOARD_TOKEN = "replace-this-token"
```

Bash 示例：

```bash
export AUDIT_AGENT_DASHBOARD_TOKEN="replace-this-token"
```

## 启动服务

### 前台启动

在项目根目录执行：

```bash
npm run server -- --port 9320
```

等价命令：

```bash
node scripts/server.js --port 9320
```

在 VS Code / PowerShell 里如果当前目录不稳定，推荐直接指定项目路径：

```powershell
npm --prefix "e:\工作空间\audit-logger-agent" run server -- --port 9320
```

正常启动输出类似：

```text
Audit review scheduler started.
Agent API on http://127.0.0.1:9320
```

启动后会自动完成：

1. 打开 SQLite 数据库并初始化表结构。
2. 初始化 LLM planner。
3. 初始化审查 reviewer。
4. 恢复中断的运行任务。
5. 恢复 stale review。
6. 启动周期性审查调度器。
7. 每秒 flush 一次 Outbox 待投递事件。

### 验证服务是否启动

```bash
curl http://127.0.0.1:9320/health
```

PowerShell：

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:9320/health"
```

正常返回：

```json
{
  "status": "ok",
  "dbPath": "e:\\工作空间\\audit-logger-agent\\data\\audit.db"
}
```

### 访问 Dashboard

总览页：

```text
http://127.0.0.1:9320/dashboard
```

审查批次页：

```text
http://127.0.0.1:9320/dashboard/audit-reviews/{reviewId}
```

风险发现详情页：

```text
http://127.0.0.1:9320/dashboard/audit-findings/{findingId}
```

风险发现详情页会展示：

- 判定摘要。
- 建议处置。
- 基本信息。
- 工具调用顺序，按 `trace_id` 下的时间顺序展示 span 链路。
- LLM 链路分析，包括调用目的和链路解读。
- 原始日志片段。

## 关闭服务

### 前台启动时关闭

如果服务在当前终端前台运行，按：

```text
Ctrl + C
```

服务会停止调度器、清理 flush interval、关闭 SQLite 连接并退出。

### PowerShell 按端口关闭

如果忘记服务在哪个终端里运行，可以先查端口：

```powershell
Get-NetTCPConnection -LocalPort 9320 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, State, OwningProcess
```

确认 `OwningProcess` 是本项目服务后再停止：

```powershell
Stop-Process -Id <OwningProcess>
```

如果要一行完成查询和停止：

```powershell
$p = Get-NetTCPConnection -LocalPort 9320 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($p) { Stop-Process -Id $p.OwningProcess }
```

### macOS / Linux 按端口关闭

```bash
lsof -i :9320
kill <PID>
```

如果普通 `kill` 无法结束，再根据实际情况使用更强制的方式。

### PM2 托管时关闭

启动：

```bash
pm2 start npm --name audit-logger-agent -- run server -- --port 9320
```

停止：

```bash
pm2 stop audit-logger-agent
```

删除 PM2 进程：

```bash
pm2 delete audit-logger-agent
```

查看日志：

```bash
pm2 logs audit-logger-agent --lines 100
```

## 命令行用法

### 采集日志

```bash
npm run ingest
```

按文件名日期过滤：

```bash
npm run ingest -- --since 2026-07-01
```

说明：

- CLI 采集会扫描 `config.json` 中所有 `agents`。
- 去重依据是原始 JSON 行的哈希 `row_hash`。
- 同一 span 的 `tool.start` 和 `tool.end` 是两条独立事件。
- 解析失败的行会打印错误，不会写入 `audit_events`。

### 查询日志

```bash
npm run query -- --status error --limit 20
```

JSON 输出：

```bash
npm run query -- --agent-id mt-agent --format json --limit 50
```

支持参数：

| 参数 | 说明 |
| --- | --- |
| `--agent-id` | 按 Agent ID 过滤。 |
| `--tool-name` | 按工具名过滤；包含 `%` 时按 SQL LIKE 查询。 |
| `--status` | 按状态过滤。 |
| `--event` | 按事件类型过滤。 |
| `--from` | 起始时间，比较 `ts >= from`。 |
| `--to` | 结束时间，比较 `ts <= to`。 |
| `--trace-id` | 按链路 ID 过滤。 |
| `--product-id` | 按产品 ID 过滤。 |
| `--channel` | 按来源渠道过滤。 |
| `--limit` | 返回数量，默认 100。 |
| `--offset` | 分页偏移。 |
| `--format` | `json` 或默认文本格式。 |

### 生成报表

每日汇总：

```bash
npm run report -- --type daily --date 2026-07-06
```

错误报表：

```bash
npm run report -- --type errors --from 2026-07-01 --to 2026-07-06
```

工具使用统计：

```bash
npm run report -- --type tools --from 2026-07-01 --to 2026-07-06
```

报表参数：

| 参数 | 说明 |
| --- | --- |
| `--type daily` | 按日期统计 Agent、工具、状态数量。 |
| `--type errors` | 输出错误事件明细。 |
| `--type tools` | 输出工具调用总量、成功数、失败数、平均耗时、最大耗时。 |
| `--date` | `daily` 报表日期。 |
| `--from` | `errors` / `tools` 起始时间。 |
| `--to` | `errors` / `tools` 结束时间。 |
| `--agent-id` | 限定 Agent。 |

## 手动触发审查

服务启动后，可以手动触发一轮审查。

PowerShell：

```powershell
Invoke-RestMethod `
  -Uri "http://127.0.0.1:9320/v1/audit-reviews/run" `
  -Method POST `
  -Headers @{ Authorization = "Bearer $env:AUDIT_AGENT_DASHBOARD_TOKEN" }
```

Bash：

```bash
curl -X POST http://127.0.0.1:9320/v1/audit-reviews/run \
  -H "Authorization: Bearer $AUDIT_AGENT_DASHBOARD_TOKEN"
```

成功返回：

```json
{
  "review_id": "review_2026-07-06T07-34-57-746Z_8d7ad9cf",
  "status": "completed"
}
```

如果已有审查正在运行，会返回 `409`：

```json
{
  "error_code": "review_already_running",
  "error": "A review is already running",
  "review_id": "..."
}
```

## HTTP API

### 基础接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查。 |
| `GET` | `/query` | 查询 `audit_events`。 |
| `GET` | `/report/daily` | 每日报表。 |
| `GET` | `/report/errors` | 错误报表。 |
| `GET` | `/report/tools` | 工具使用统计。 |

`/query` 支持的查询参数与 CLI `query` 基本一致：

```text
agent_id, tool_name, status, event, from, to, trace_id, product_id, channel, limit, offset
```

示例：

```text
http://127.0.0.1:9320/query?status=error&limit=20
```

### LLM Runtime 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/runs` | 创建一个 LLM 驱动的审计任务。 |
| `GET` | `/v1/runs/{runId}` | 查询任务状态。 |
| `POST` | `/v1/runs/{runId}/resume` | 用户补充决策后恢复任务。 |

`POST /v1/runs` 推荐请求体：

```json
{
  "source": {
    "type": "manual",
    "session_id": "session_001",
    "message_id": "msg_001",
    "requester_id": "user_001"
  },
  "request": {
    "text": "分析今天所有异常调用并总结高风险链路"
  },
  "delivery": {
    "mode": "callback",
    "target_url": "http://127.0.0.1:9999/agent-events"
  },
  "metadata": {
    "tenant_key": "tenant_demo"
  },
  "idempotency_key": "run-20260706-001"
}
```

当前 Runtime 暴露给 LLM 的本地工具：

| 工具 | 说明 |
| --- | --- |
| `audit.queryEvents` | 查询审计事件。 |
| `report.errorSummary` | 生成错误摘要。 |

### 审查与 Dashboard 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/audit-reviews` | 审查批次列表。 |
| `GET` | `/v1/audit-reviews/{reviewId}` | 单个审查批次。 |
| `GET` | `/v1/audit-findings` | 风险发现列表。 |
| `GET` | `/v1/audit-findings/{findingId}` | 单个风险发现。 |
| `POST` | `/v1/audit-reviews/run` | 手动触发审查。 |
| `GET` | `/dashboard` | Dashboard 总览页。 |
| `GET` | `/dashboard/audit-reviews/{reviewId}` | 审查批次详情页。 |
| `GET` | `/dashboard/audit-findings/{findingId}` | 风险发现详情页。 |

授权规则：

- `POST /v1/audit-reviews/run` 始终需要 `Authorization: Bearer <token>`。
- 本机 loopback 访问且 `requireDashboardToken=false` 时，Dashboard 和审查读接口可以免 Token。
- 非 loopback 或 `requireDashboardToken=true` 时，读接口也需要 Token。

## 上游日志文件规范

上游 Agent 应输出一行一个 JSON 的 NDJSON 文件，文件名通常为：

```text
audit-YYYY-MM-DD.jsonl
```

每一行必须是完整 JSON 对象，不允许多行 JSON。

### 必填字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ts` | string | ISO 8601 时间戳。必须能被 `Date.parse()` 解析。 |
| `agent_id` | string | 产生日志的 Agent 标识，例如 `mt-agent`。 |
| `trace_id` | string | 一次任务或链路的全局 ID。相同任务内的 span 应共享同一个 `trace_id`。 |
| `span_id` | string | 当前事件所属 span ID。一次工具调用的 start/end/error 通常使用同一个 `span_id`。 |
| `event` | string | 事件类型，必须在合法枚举内。 |
| `tool_name` | string | 工具名或逻辑动作名，例如 `rental.apply`。 |
| `status` | string | 状态，必须在合法枚举内。 |
| `result_summary` | string | 简短摘要，最长 200 字符。 |

### 可选字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `parent_span_id` | string | 父 span ID，用于表达工具调用树或 agent/span 嵌套关系。 |
| `duration_ms` | number | 当前工具调用耗时毫秒，通常写在 `tool.end` 或 `tool.error`。 |
| `channel` | string | 来源渠道，例如 `cli`、`http`、`feishu`。 |
| `user_id` | string | 触发用户 ID。 |
| `product_id` | string | 业务对象 ID，例如商品、产品、订单等。 |
| `error` | object | 错误对象。若存在，必须是对象。 |
| `error.code` | string | 归一化错误码。 |
| `error.message` | string | 错误消息。 |
| `error.stack` | string | 可选堆栈。建议仅本地保留，避免含敏感信息。 |
| `tags` | string[] | 标签数组，例如 `['batch', 'e2e-audit']`。 |

### 合法 `event` 枚举

| event | 用途 |
| --- | --- |
| `tool.start` | 工具调用开始。 |
| `tool.end` | 工具调用正常结束。 |
| `tool.error` | 工具调用失败。 |
| `agent.start` | Agent 级任务开始。 |
| `agent.end` | Agent 级任务正常结束。 |
| `agent.error` | Agent 级任务失败。 |
| `run.start` | Runtime run 开始。 |
| `run.resume` | Runtime run 从用户决策恢复。 |
| `run.waiting_user` | Runtime run 等待用户输入。 |
| `run.final_result` | Runtime run 产出最终结果。 |
| `run.failed` | Runtime run 失败。 |

### 合法 `status` 枚举

| status | 用途 |
| --- | --- |
| `ok` | 成功或正常状态。 |
| `error` | 失败。 |
| `timeout` | 超时。 |
| `cancelled` | 被取消。 |

### 字段入库映射

解析后会写入 `audit_events`：

| 源字段 | 数据库字段 | 说明 |
| --- | --- | --- |
| 原始 JSON 行 | `row_hash` | SHA-256 截断到 16 位，用于去重。 |
| `ts` | `ts` | 事件时间。 |
| `agent_id` | `agent_id` | Agent 标识。 |
| `trace_id` | `trace_id` | 链路 ID。 |
| `span_id` | `span_id` | Span ID。 |
| `parent_span_id` | `parent_span_id` | 父 Span。 |
| `event` | `event` | 事件类型。 |
| `tool_name` | `tool_name` | 工具名。 |
| `status` | `status` | 状态。 |
| `result_summary` | `result_summary` | 摘要。 |
| `duration_ms` | `duration_ms` | 耗时。 |
| `channel` | `channel` | 渠道。 |
| `user_id` | `user_id` | 用户。 |
| `product_id` | `product_id` | 业务对象。 |
| `error.code` | `error_code` | 错误码。 |
| `error.message` | `error_message` | 错误消息。 |
| `tags` | `tags` | JSON 字符串。 |
| 原始对象 | `raw_json` | 原始 JSON 字符串。 |

### 推荐写法：一次工具调用

```json
{"ts":"2026-07-06T07:33:08.199Z","agent_id":"mt-agent","trace_id":"trace-001","span_id":"span-tool-001","event":"tool.start","tool_name":"publicTraffic.reportQuery","status":"ok","result_summary":"Starting publicTraffic.reportQuery","channel":"cli","product_id":"mt-e2e-001"}
{"ts":"2026-07-06T07:33:08.200Z","agent_id":"mt-agent","trace_id":"trace-001","span_id":"span-tool-001","event":"tool.end","tool_name":"publicTraffic.reportQuery","status":"ok","result_summary":"Read public traffic summary for mt-e2e-001","duration_ms":1,"channel":"cli","product_id":"mt-e2e-001"}
```

### 推荐写法：带父子 span 的任务

```json
{"ts":"2026-07-06T07:33:08.199Z","agent_id":"mt-agent","trace_id":"trace-002","span_id":"span-agent-001","event":"agent.start","tool_name":"agent.runtime.auditProbe","status":"ok","result_summary":"Audit probe started","channel":"cli"}
{"ts":"2026-07-06T07:33:08.200Z","agent_id":"mt-agent","trace_id":"trace-002","span_id":"span-tool-002","parent_span_id":"span-agent-001","event":"tool.error","tool_name":"activityAutomation.updateDiscount","status":"error","result_summary":"Write action blocked because confirmation was not supplied","duration_ms":0,"channel":"cli","product_id":"mt-e2e-002","error":{"code":"CONFIRMATION_REQUIRED","message":"Write action blocked because confirmation was not supplied"}}
{"ts":"2026-07-06T07:33:08.201Z","agent_id":"mt-agent","trace_id":"trace-002","span_id":"span-agent-001","event":"agent.error","tool_name":"agent.runtime.auditProbe","status":"error","result_summary":"Audit probe completed with one blocked write action","duration_ms":3,"channel":"cli"}
```

### 字段建议

- `trace_id` 应覆盖一次完整用户请求或自动任务。
- `span_id` 应覆盖一次工具调用的开始和结束。
- `parent_span_id` 用于表达嵌套关系；Dashboard 会基于 `trace_id` 和时间顺序展示链路。
- `result_summary` 应短而可读，不要放完整响应体。
- `error.message` 不要包含密钥、Cookie、Token、完整用户隐私数据。
- `tags` 适合放 `batch`、`manual`、`e2e-audit` 这类便于后续筛选的标签。

## 审查规则和 Finding

本地规则会先筛出候选事件，再交给 LLM 审查。主要类别：

| 类别 | 说明 |
| --- | --- |
| `high_risk_permission` | 命中高风险工具模式，例如 `*delete*`、`*update*`、`shell.*`。 |
| `anomalous_call` | Agent 调用了未在 allowlist 中声明的工具。 |
| `repeated_call` | 短时间内重复调用达到阈值。 |
| `failed_call` | 工具或 Agent 失败。 |
| `trace_integrity` | 有 start 但缺少 end/error 等链路完整性问题。 |
| `ingest_parse_error` | 日志文件解析失败。 |

Finding 严重程度：

```text
critical, high, medium, low
```

Finding 状态：

```text
open, acknowledged, snoozed, resolved
```

## 通知和 Outbox

周期性审查会向 `auditReview.notification.callbackUrl` 投递：

| 事件 | 说明 |
| --- | --- |
| `audit_review_summary` | 一轮审查完成后的摘要。 |
| `audit_review_finding` | 高风险或严重风险发现的单条通知。 |

LLM Runtime 会向请求里的 `delivery.target_url` 投递：

| 事件 | 说明 |
| --- | --- |
| `progress_update` | 任务步骤进展。 |
| `decision_request` | 需要用户选择或补充信息。 |
| `final_result` | 最终结果。 |

投递失败会进入 Outbox 重试：

- 最多重试 8 次。
- 指数退避。
- 最终进入 `dead_letter`。

## 安全注意事项

- 服务当前固定监听 `127.0.0.1`。
- 不建议直接暴露公网。
- `/query`、`/report/*`、`/v1/runs` 当前没有内置鉴权，若需外部访问，应放在受控网关后面。
- `POST /v1/audit-reviews/run` 始终需要 Bearer Token。
- `.config`、`data/`、运行日志和过程文件不应进入 Git。
- 上游日志不要写入 API Key、Cookie、Token、完整页面 HTML 或大块用户隐私数据。

## 故障排查

### 启动时报缺少 LLM 配置

检查：

- `.config` 是否存在。
- 是否配置了 `AUDIT_AGENT_LLM_API_KEY`。
- 是否配置了 `AUDIT_AGENT_LLM_MODEL`。
- `.config` 是否是合法 JSON。

### 手动触发审查返回 401

检查：

- 服务进程是否设置了 `AUDIT_AGENT_DASHBOARD_TOKEN`。
- 请求头是否是 `Authorization: Bearer <token>`。
- Token 是否与启动服务时的环境变量一致。

### 手动触发审查返回 403

说明服务读取到了 Token，但请求里的 Token 不匹配。

### 有日志文件但没有采集到

检查：

- `config.json` 里的 `logDir` 是否指向真实目录。
- 文件名是否匹配 `pattern`。
- `--since` 是否把文件名日期过滤掉。
- NDJSON 是否一行一个 JSON。
- 是否缺少必填字段。
- `event` / `status` 是否使用合法枚举。
- `result_summary` 是否超过 200 字符。

### Dashboard 没有看到新 Finding

检查：

- 是否已经执行 `npm run ingest` 或触发审查。
- 审查批次 `inserted_events` 是否大于 0。
- 审查批次 `candidate_event_count` 是否大于 0。
- LLM 是否返回成功；失败时批次状态会是 `completed_degraded`。
- 是否因为 finding 去重，更新了旧 finding 而不是新增一条。

### 端口被占用

Windows：

```powershell
Get-NetTCPConnection -LocalPort 9320 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, State, OwningProcess
```

如果确认是旧服务进程：

```powershell
Stop-Process -Id <OwningProcess>
```

macOS / Linux：

```bash
lsof -i :9320
kill <PID>
```

## 最小启动清单

1. 安装依赖：`npm install`
2. 检查 `config.json` 的日志目录是否正确。
3. 创建 `.config`，填入 LLM 凭证。
4. 设置 `AUDIT_AGENT_DASHBOARD_TOKEN`。
5. 启动：`npm run server -- --port 9320`
6. 检查：`GET http://127.0.0.1:9320/health`
7. 打开 Dashboard：`http://127.0.0.1:9320/dashboard`
8. 关闭：前台 `Ctrl+C`，或按端口找到进程后 `Stop-Process` / `kill`。
