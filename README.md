# Audit Logger Agent

## Long-running operations notes

### Secrets and local files

Prefer setting `AUDIT_AGENT_LLM_API_KEY` in the process environment managed by PM2, systemd, or the shell that starts the service. `.config` is supported for local development and private hosts, but it must remain local-only, must not be committed, and should be permission restricted on Unix-like hosts:

```bash
chmod 600 .config
```

The repository ignores normalized app-owned runtime storage under `data/` and `logs/`. Repo-root `tmp/` stays ignored as local scratch only, and root `.server*` / `.callback-*` files such as `.server.log` stay ignored for legacy migration compatibility. Keep SQLite databases, WAL files, spool files, captures, temp files, local credentials, and process logs out of Git.

### Process supervision

PM2 example with restart policy and boot start:

```bash
pm2 start npm --name audit-logger-agent -- run server -- --port 9320
pm2 save
pm2 startup
```

For systemd, run the service from the repository root and let systemd restart it:

```ini
[Unit]
Description=Audit Logger Agent
After=network.target

[Service]
WorkingDirectory=/opt/audit-logger-agent
ExecStart=/usr/bin/node scripts/server.js --port 9320
Environment=AUDIT_AGENT_LLM_API_KEY=replace-with-secret
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable boot start with:

```bash
systemctl enable --now audit-logger-agent
```

### Intranet bind host

By default the HTTP server binds to `127.0.0.1`. For intranet collection from other machines, set `auditReview.http.bindHost` in `config.json` to a reachable interface such as `0.0.0.0` or the server's intranet IP address:

```json
{
  "auditReview": {
    "http": {
      "bindHost": "0.0.0.0",
      "requireDashboardToken": true
    }
  }
}
```

When `bindHost` is non-loopback, set `AUDIT_AGENT_DASHBOARD_TOKEN` in the service environment before starting the server. The server refuses to boot with a non-loopback bind and no token.

### Log rotation

Rotate the normalized files under `logs/` such as `server.log`, `server.err.log`, and callback receiver logs. Root `.server.log`, `.server.err.log`, `.callback-*.log`, and `.callback-*.err.log` are legacy migration-compatibility leftovers only; when present, startup migrates/appends them into normalized paths instead of treating them as steady-state write targets. A simple `logrotate` rule:

```text
/opt/audit-logger-agent/logs/*.log {
  daily
  rotate 14
  compress
  missingok
  copytruncate
}
```

If PM2 also stores supervisor stdout/stderr logs, rotate the PM2 log directory separately.

### SQLite backups

Do not directly copy the active SQLite database, `-wal`, or `-shm` files while the service is running. Use SQLite online backup so WAL-active databases are copied consistently:

```bash
sqlite3 data/db/audit.db ".backup 'backups/audit-$(date +%F).db'"
```

Keep backups outside `data/` if they need separate retention or off-host sync.

### Workspace-owned runtime storage

The normalized app-owned runtime layout is:

```text
data/db/audit.db
data/db/audit.db-wal
data/db/audit.db-shm
data/spool/incoming/
data/tmp/
data/captures/
logs/
```

Repo-root `tmp/` is not part of the normalized runtime layout. Root `.server*` / `.callback-*` files are legacy migration-compatibility artifacts only, not normal runtime targets. When present at startup, the service migrates or appends them into normalized paths.

Built-in retention and `node scripts/prune.js` only touch retention-managed SQLite rows and app-owned directories resolved from `config.json` under the repository root. They do not scan or delete workspace-local directories/files such as `.agents/`, `.claude/`, `.superpowers/`, `record.json`, or `Typora_Hook_Log.txt`. Those paths are outside app self-cleanup scope even if they contain log-like files.

### Built-in prune and retention

Dry-run:

```bash
node scripts/prune.js --dry-run
```

Apply cleanup:

```bash
node scripts/prune.js
```

Use a different repository root:

```bash
AUDIT_LOGGER_ROOT=/opt/audit-logger-agent node scripts/prune.js --dry-run
```

Default retention windows:

| Target | Default behavior |
| --- | --- |
| `audit_events` | Delete rows older than 90 days. |
| `agent_runs` | Delete only terminal (`completed` / `failed` / `cancelled`) runs older than 30 days. |
| `agent_run_steps` | Delete steps that belong to terminal runs older than 30 days. |
| `agent_waiting_states` | Delete resolved states older than 30 days, plus states attached to terminal runs older than 30 days. |
| `audit_review_runs` | Delete rows older than 60 days. |
| `audit_review_findings` | Delete only `resolved` rows with `resolved_at` older than 30 days. |
| `audit_llm_usage` | Delete day buckets older than 90 days. |
| `agent_outbox_events` | Delete only `delivered` / `dead_letter` rows older than 14 days. |
| `data/spool/incoming/<agent>/audit-*.jsonl` | Delete files older than 90 days only when the ingest cursor proves the whole file was consumed. |
| `logs/` | Delete files older than 14 days. |
| `data/tmp/` | Delete files older than 7 days. |
| `data/captures/` | Delete files older than 30 days. |

Notes:

- Prune walks only these retention-managed SQLite tables: `audit_events`, `agent_runs`, `agent_run_steps`, `agent_waiting_states`, `audit_review_runs`, `audit_review_findings` (`resolved` only), `audit_llm_usage`, and `agent_outbox_events`; plus app-owned directories resolved from config: `ingest.spoolDir`, `logDir`, `tmpDir`, and `capturesDir`.
- Cleanup targets must stay inside the repository root. Paths that resolve outside the root are skipped rather than deleted.
- It does not scan or delete `.agents/`, `.claude/`, `.superpowers/`, `record.json`, or `Typora_Hook_Log.txt`.
- Root `.server*` / `.callback-*` files are Git-ignored only for runtime path migration compatibility. They are not part of app self-cleanup, not the normal runtime layout, and not pruned as standalone steady-state targets.

`audit-logger-agent` 是一个 Agent 审计日志中台。它负责采集多个 Agent 输出的 NDJSON 审计日志，写入本地 SQLite，提供命令行查询、HTTP API、周期性 LLM 审查、风险发现 Dashboard 和回调通知。

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
scripts/ingest.js         已停用的旧 ingest CLI（提示改用 /v1/ingest）
scripts/query.js          命令行查询审计事件
scripts/report.js         命令行报表
scripts/server.js         HTTP 服务入口
scripts/lib/              解析、spool 扫描、数据库基础能力
src/                      服务端运行源码
data/db/audit.db          本地 SQLite 数据库，本地生成，不进入 Git
.config                   本地 LLM 凭证，本地创建，不进入 Git
```

## 环境要求

- Node.js 20 或更高版本。
- 项目目录可写，用于创建 `data/db/audit.db` 及其父目录。
- 启动 `server` 模式时必须提供 OpenAI 兼容 LLM 凭证。
- 如果启用回调通知，需要准备一个可访问的 HTTP 回调接收端。

安装依赖：

```bash
npm install
```

Windows PowerShell 下也可以使用同一命令。

## 配置文件

### `config.json`

`config.json` 是主配置文件。当前部署只保留 HTTP ingest -> 本机 spool -> 审计/查询 链路：

```json
{
  "dbPath": "data/db/audit.db",
  "agents": {}
}
```

关键字段：

| 字段 | 说明 |
| --- | --- |
| `dbPath` | SQLite 数据库路径。父目录不存在时会自动创建。 |
| `agents` | 预留字段。当前不再使用 `config.agents[].logDir/pattern` 做本地扫描。 |
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
| `auditReview.toolMapping.taxonomy` | LLM 工具语义映射允许输出的稳定类型清单，失败时降级为 `unknown`。 |
| `auditReview.visualization.baseUrl` | 通知中生成 Dashboard 链接的地址前缀。 |
| `auditReview.visualization.dashboardPath` | Dashboard 路由前缀，默认 `/dashboard`。 |

SQLite 适用于当前低并发内网部署；当 `audit_events` 超过约 2000 万行，或查询/写入 QPS 明显上升时，应重新评估迁移到 Postgres 或增加只读副本。

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
  "dbPath": "e:\\工作空间\\audit-logger-agent\\data\\db\\audit.db"
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

说明：

- `npm run ingest` 已停用，会直接提示改用 `POST /v1/ingest`。
- 所有上游 Agent 必须主动把审计事件 POST 到服务端。
- 去重依据是原始 JSON 行的哈希 `row_hash`。
- 同一 span 的 `tool.start` 和 `tool.end` 是两条独立事件。
- 解析失败的行会打印错误，不会写入 `audit_events`。

### 查询日志

```bash
npm run query -- --status INTERNAL --limit 20
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
| `--entity-type` / `--entity-id` | Filter by business entity type and ID. |
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
| `POST` | `/v1/ingest` | 上游 Agent 主动推送审计日志。 |

`/query` 支持的查询参数与 CLI `query` 基本一致：

```text
agent_id, tool_name, mapped_tool_type, mapping_status, status, event, from, to, trace_id, entity_type, entity_id, channel, limit, offset
```

示例：

```text
http://127.0.0.1:9320/query?status=INTERNAL&limit=20
```

### 上游推送采集

所有上游 Agent 都必须把审计事件主动推送到服务端；不再支持被动扫描其他机器上的本地日志目录：

```bash
curl -X POST http://127.0.0.1:9320/v1/ingest \
  -H "Content-Type: application/x-ndjson" \
  --data-binary @audit-2026-07-06.jsonl
```

`POST /v1/ingest` 支持两种请求体：

- `Content-Type: application/x-ndjson`：每行一个 JSON 事件。
- `Content-Type: application/json`：单个事件对象，或 `{ "events": [...] }` 批量事件。

统一 HTTP ingest 接口会先校验基础字段并规范化 `event`，再写入 `audit_events`。支持的 alias 规则是：保留同一组小写 segment，只在 segment 之间替换分隔符 `.`、`/`、`_`、`-`。例如 `tool.end`、`tool/end`、`tool_end`、`tool-end` 都会归一为 `tool.end`。未知生命周期 `event` 不再丢弃日志，会以 canonical `event="unknown"` 入库，同时在 `raw_json` 保留上游原始值。

JSON 批量示例：

```json
{
  "events": [
    {
      "ts": "2026-07-06T07:33:08.200Z",
      "agent_id": "mt-agent",
      "trace_id": "trace-001",
      "span_id": "span-tool-001",
      "event": "tool.end",
      "tool_name": "publicTraffic.reportQuery",
      "status": "ok",
      "result_summary": "Read public traffic summary"
    }
  ]
}
```

成功接收后返回 `202`：

```json
{
  "accepted": 1,
  "rejected": 0,
  "errors": []
}
```

已接收的行会追加写入 `data/spool/incoming/<agent_id>/audit-YYYY-MM-DD.jsonl`，
随后由现有增量采集流程入库，并继续复用 `row_hash` 去重。`agent_id` 只允许
字母、数字、`.`、`_`、`-`，空值、`..`、`/`、`` 会被拒绝。请求体大小由
`ingest.http.maxBodyBytes` 控制，单行或单事件大小由 `ingest.http.maxLineBytes`
控制。设置 `ingest.http.enabled=false` 可以关闭该 HTTP 推送端点；关闭后将没有日志进入本机 spool。

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

## Upstream Audit Log Spec

Upstream agents write one complete JSON object per line in NDJSON files, normally named:

```text
audit-YYYY-MM-DD.jsonl
```

This spec is not backward compatible with old audit events. New ingestion rejects events that still send `product_id`, `error.code`, or non-canonical `status` values. Unknown lifecycle `event` ids are accepted as canonical `unknown` while preserving the original value in `raw_json`.

### Required Fields

| Field | Type | Notes |
| --- | --- | --- |
| `ts` | string | ISO 8601 timestamp. |
| `agent_id` | string | Producing agent id. |
| `trace_id` | string | Request/task trace id. |
| `span_id` | string | Current span id. |
| `event` | string | Must be a canonical event below, or a supported separator alias that normalizes to one. |
| `tool_name` | string | Tool or runtime component name. |
| `status` | string | Google/gRPC canonical code. Success is `OK`. |
| `result_summary` | string | Short summary, max 200 chars. |

### Optional Fields

| Field | Type | Notes |
| --- | --- | --- |
| `parent_span_id` | string | Parent span for nested calls; empty or omitted when absent. |
| `duration_ms` | number | Tool duration in milliseconds. |
| `channel` | string | Source channel such as `cli`, `http`, or `feishu`. |
| `user_id` | string | Required for user-triggered events; empty or omitted for autonomous agent events. |
| `entity` | object | Business object with string `type` and string `id`. |
| `llm_intent` | object | Tool LLM intent with string `input` and string `output`. |
| `error` | object | Only `error.message` is allowed. `error.code` is rejected. |
| `tags` | string[] | Optional tags for filtering. |

### Event Mapping

| event | process/stage |
| --- | --- |
| `tool.start` | `tool/start` |
| `tool.end` | `tool/end` |
| `tool.error` | `tool/error` |
| `agent.start` | `agent/start` |
| `agent.end` | `agent/end` |
| `agent.error` | `agent/error` |
| `run.start` | `run/start` |
| `run.resume` | `run/resume` |
| `run.waiting_user` | `run/waiting_user` |
| `run.final_result` | `run/final_result` |
| `run.failed` | `run/failed` |

Runtime review logs also use `review.*` events such as `review.start`, `review.llm.completed`, and `review.completed`.

### Event Normalization

Ingestion canonicalizes `event` before writing to `audit_events`:

- Canonical ids use dot-separated lowercase segments, for example `tool.end` and `review.llm.completed`.
- Accepted aliases may swap only the separators between the same lowercase segments: `.`, `/`, `_`, and `-` are treated as equivalent. Examples: `tool/end`, `tool_end`, and `tool-end` all normalize to `tool.end`.
- Multi-segment events follow the same rule, for example `review/llm/completed` and `review_llm_completed` both normalize to `review.llm.completed`.
- Unknown ids such as `tool.finish` are accepted as canonical `unknown`, preserving the original upstream value in `raw_json` so audit evidence is not dropped.
- LLM audit review uses only canonical `event` values read from `audit_events`; the original upstream payload is still retained in `raw_json`.

### 工具语义映射

所有已接收日志都会进入工具语义映射流程。系统优先用本地规则识别明显工具名；无法判断时，LLM 会结合 `tool_name`、`result_summary`、`llm_intent`、错误信息、实体和调用链上下文，把工具归类到 `auditReview.toolMapping.taxonomy` 中的类型。默认类型包括 `read`、`write`、`update`、`delete`、`deploy`、`permission`、`credential`、`shell`、`browser`、`network`、`database`、`file`、`notification`、`llm` 和 `unknown`。LLM 无法可靠分类时降级为 `unknown`，不会拒收日志。

### Status Values

`status` uses Google/gRPC canonical codes. Common values:

| status | Meaning |
| --- | --- |
| `OK` | Success. |
| `PERMISSION_DENIED` | Permission denied. |
| `DEADLINE_EXCEEDED` | Timeout. |
| `INVALID_ARGUMENT` | Invalid input. |
| `NOT_FOUND` | Missing resource. |
| `RESOURCE_EXHAUSTED` | Quota/resource exhausted. |
| `FAILED_PRECONDITION` | Failed precondition. |
| `INTERNAL` | Internal error. |
| `UNAVAILABLE` | Upstream unavailable. |
| `UNAUTHENTICATED` | Missing/invalid auth. |

The full canonical set also includes `CANCELLED`, `UNKNOWN`, `ALREADY_EXISTS`, `ABORTED`, `OUT_OF_RANGE`, `UNIMPLEMENTED`, and `DATA_LOSS`.

### Database Mapping

| Upstream field | audit_events column |
| --- | --- |
| `entity.type` | `entity_type` |
| `entity.id` | `entity_id` |
| `llm_intent` | `llm_intent_json` |
| `error.message` | `error_message` |
| source object | `raw_json` |

`product_id` and `error_code` are no longer used for new writes.

### Examples

```json
{"ts":"2026-07-06T07:33:08.199Z","agent_id":"mt-agent","trace_id":"trace-001","span_id":"span-tool-001","event":"tool.start","tool_name":"publicTraffic.reportQuery","status":"OK","result_summary":"Starting report query","channel":"cli","entity":{"type":"product","id":"mt-e2e-001"},"llm_intent":{"input":"Read public traffic report","output":"Return summarized metrics"}}
{"ts":"2026-07-06T07:33:08.200Z","agent_id":"mt-agent","trace_id":"trace-001","span_id":"span-tool-001","event":"tool.end","tool_name":"publicTraffic.reportQuery","status":"OK","result_summary":"Read public traffic summary","duration_ms":1,"channel":"cli","entity":{"type":"product","id":"mt-e2e-001"}}
{"ts":"2026-07-06T07:34:00.000Z","agent_id":"mt-agent","trace_id":"trace-002","span_id":"span-tool-002","event":"tool.error","tool_name":"activityAutomation.updateDiscount","status":"PERMISSION_DENIED","result_summary":"Write action blocked","duration_ms":0,"channel":"cli","entity":{"type":"product","id":"mt-e2e-002"},"error":{"message":"Write action blocked because confirmation was not supplied"}}
```

### Field Guidance

- `trace_id` should cover one complete user request or autonomous task.
- `span_id` should cover one tool call start/end/error sequence.
- `parent_span_id` must be a string; empty or omit it when there is no parent.
- `user_id` must be a string; user-triggered events should include it.
- Keep `result_summary` short and avoid full response bodies.
- Do not put secrets, cookies, tokens, or private user data in `error.message`.

## 审查规则和 Finding

本地规则会先筛出候选事件，再交给 LLM 审查。detector 和 LLM 审查读取的是 `audit_events` 里的 canonical `event`，并同时使用 `mapped_tool_type`、`mapping_status` 和 `mapping_reason` 理解上游工具语义。主要类别：

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

### HTTP ingest 没有采集到事件

检查：

- 上游 Agent 是否已经实际发送 `POST /v1/ingest`。
- NDJSON 是否一行一个 JSON。
- 是否缺少必填字段。
- `event` / `status` 是否使用合法枚举。
- `result_summary` 是否超过 200 字符。

### Dashboard 没有看到新 Finding

检查：

- 是否已经发送 `POST /v1/ingest` 或触发审查。
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
