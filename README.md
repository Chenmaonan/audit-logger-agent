# Audit Logger Agent

`audit-logger-agent` 用于统一采集多个 Agent 产出的审计日志，落库到本地 SQLite，并提供查询、报表、LLM 任务运行时、周期性审查、回调通知和本地 Dashboard。

当前仓库以“当前可运行版本”为准，本文档只描述现在这套实现，不再展开历史迭代说明。

## 核心功能

- 统一采集多个 Agent 的 NDJSON 审计日志，按 `row_hash` 去重写入 SQLite。
- 提供命令行查询和报表能力，支持按 Agent、工具、状态、时间范围、Trace 等条件过滤。
- 提供本地 HTTP API，便于外部系统发起查询、生成报表和触发任务。
- 内置 LLM 驱动的任务运行时，可把自然语言请求转成结构化计划，并只在本地执行受控工具。
- 内置周期性审查流程：增量采集日志、规则预筛、LLM 结构化审查、生成 Findings、推送回调通知。
- 提供本地 Dashboard，查看审查批次、风险发现和证据明细。
- 具备重启恢复、Outbox 重试和死信统计能力，适合长期驻留运行。

## 适用场景

- 需要把多个 Agent 的工具调用日志统一归档和检索。
- 需要对高风险工具调用、失败调用、重复调用做周期性审查。
- 需要把“查询审计数据”和“自动生成风险摘要”封装成一个本地服务。
- 需要一个可被上层平台调用的 Agent 审计分析后端。

## 架构概览

```text
Agent 日志文件 (*.jsonl)
  -> 批量采集 / 增量采集
  -> audit_events (SQLite)
     -> CLI 查询 / 报表
     -> HTTP 查询 / 报表 API
     -> LLM 任务运行时
     -> 周期性审查
        -> 规则预筛
        -> LLM 审查
        -> audit_review_runs / audit_review_findings
        -> 回调通知 / 本地 Dashboard
```

### 主要数据表

- `audit_events`：原始审计事件主表。
- `agent_runs` / `agent_run_steps` / `agent_waiting_states`：LLM 任务运行时状态。
- `agent_outbox_events`：待投递事件、重试和死信。
- `audit_review_runs` / `audit_review_findings`：周期性审查批次与风险发现。
- `audit_review_locks`：审查任务租约锁，避免并发重复执行。
- `audit_ingest_cursors`：增量采集游标。

## 运行环境

- Node.js 20 或更高版本
- 可访问各 Agent 日志目录的本地文件系统权限
- SQLite 文件写入权限
- 如果启动 `server` 模式：
  - 必须提供 OpenAI 兼容接口凭证
  - 如果要接收运行结果或审查通知，必须准备回调接收端

## 部署前先明确两种运行方式

### 1. 只做采集 / 查询 / 报表

使用 `ingest`、`query`、`report` 三个 CLI 即可。

- 不需要 LLM 凭证
- 不需要启动 HTTP 服务
- 不需要回调接收端

### 2. 启动完整服务

使用 `server` 模式。

- 需要 LLM 凭证
- 会初始化 LLM planner 和审查 reviewer
- 会启动 HTTP API
- 默认会启动周期性审查调度器，除非 `auditReview.enabled` 显式设为 `false`

## 部署步骤

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 `config.json`

`config.json` 是主配置文件，至少要定义数据库路径和要采集的 Agent 日志目录。

示例：

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
  },
  "auditReview": {
    "enabled": true,
    "intervalMinutes": 30,
    "initialDelaySeconds": 30,
    "lookbackOverlapMinutes": 5,
    "maxEventsPerReview": 500,
    "notification": {
      "mode": "callback",
      "callbackUrl": "http://127.0.0.1:9999/audit-review-events",
      "minSeverity": "medium",
      "sendEmptyReview": false
    },
    "http": {
      "bindHost": "127.0.0.1",
      "requireDashboardToken": false,
      "allowedOrigins": ["http://127.0.0.1:9320"]
    },
    "riskPolicy": {
      "version": "risk-policy-v1",
      "repeatWindowMinutes": 10,
      "repeatThreshold": 5,
      "slowCallDurationMs": 30000,
      "highRiskToolPatterns": [
        "*delete*",
        "*write*",
        "*update*",
        "*deploy*",
        "*permission*",
        "*credential*",
        "shell.*",
        "browser.runScript"
      ],
      "agentToolAllowlists": {
        "rental-price-agent": [],
        "mt-agent": []
      }
    },
    "llmReview": {
      "promptVersion": "audit-review-prompt-v1",
      "reviewerVersion": "audit-reviewer-v1"
    },
    "visualization": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:9320",
      "dashboardPath": "/dashboard",
      "template": "audit-review-dashboard-v1"
    }
  }
}
```

关键说明：

- `dbPath`：SQLite 文件路径。目录不存在会自动创建。
- `agents.*.logDir`：日志目录，相对路径基准是 `dbPath` 所在目录的上一级逻辑位置；按当前默认写法，`dbPath = data/audit.db` 时等价于相对项目根目录解析。
- `agents.*.pattern`：日志文件匹配模式，通常是 `audit-*.jsonl`。
- `auditReview.notification.mode`：当前实现只真正支持 `callback`。
- `auditReview.notification.callbackUrl`：审查摘要和高风险 finding 的投递地址。
- `auditReview.notification.minSeverity`：配置中保留该字段，但当前实现没有用它裁剪摘要发送范围。
- `auditReview.visualization.baseUrl`：写入回调摘要里的 Dashboard 地址前缀。

### 3. 配置 LLM 凭证

在项目根目录新建 `.config`，内容是 JSON，不是 `.env` 格式。

可以直接复制模板：

```bash
cp .config.example .config
```

或手动创建：

```json
{
  "AUDIT_AGENT_LLM_API_KEY": "<your-api-key>",
  "AUDIT_AGENT_LLM_BASE_URL": "https://api.openai.com/v1",
  "AUDIT_AGENT_LLM_MODEL": "<your-model>",
  "AUDIT_AGENT_LLM_TIMEOUT_MS": "30000"
}
```

LLM 配置加载优先级：

`进程环境变量 > .config > config.json.planner`

说明：

- `AUDIT_AGENT_LLM_API_KEY`：必填
- `AUDIT_AGENT_LLM_MODEL`：必填
- `AUDIT_AGENT_LLM_BASE_URL`：可选，默认 `https://api.openai.com/v1`
- `AUDIT_AGENT_LLM_TIMEOUT_MS`：可选，默认 `30000`

### 4. 配置 Dashboard / 手动审查触发 Token

如果你要调用 `POST /v1/audit-reviews/run`，必须提供 `AUDIT_AGENT_DASHBOARD_TOKEN`。

推荐放在进程环境变量中，而不是写进 `config.json`。

PowerShell：

```powershell
$env:AUDIT_AGENT_DASHBOARD_TOKEN = "replace-this-token"
```

Bash：

```bash
export AUDIT_AGENT_DASHBOARD_TOKEN="replace-this-token"
```

注意：

- 这个 Token 只从进程环境变量或 `config.auditReview.http.dashboardToken` 读取。
- `.config` 不参与 Dashboard Token 加载。

### 5. 启动服务

```bash
npm run server -- --port 9320
```

等价命令：

```bash
node scripts/server.js --port 9320
```

启动时会自动完成：

- 打开 SQLite 并初始化表结构
- 初始化 LLM planner
- 恢复中断的运行任务
- 恢复过期的审查锁和 stale review
- 启动周期性审查调度器（默认启用）
- 每 1 秒尝试 flush 一次 Outbox 待投递事件

### 6. 验证部署结果

健康检查：

```bash
curl http://127.0.0.1:9320/health
```

正常返回：

```json
{
  "status": "ok",
  "dbPath": "..."
}
```

手动触发一轮审查：

```bash
curl -X POST http://127.0.0.1:9320/v1/audit-reviews/run \
  -H "Authorization: Bearer $AUDIT_AGENT_DASHBOARD_TOKEN"
```

### 7. 作为常驻进程运行

建议用进程管理器托管，例如 PM2、systemd、NSSM 或其他现有守护体系。

PM2 示例：

```bash
pm2 start npm --name audit-logger-agent -- run server -- --port 9320
```

建议同时做：

- 持久化 `data/` 目录
- 监控标准输出日志
- 定期备份 `data/audit.db`
- 为回调接收端做可用性监控

## 配置项说明

### `config.json`

| 字段 | 说明 |
| --- | --- |
| `dbPath` | SQLite 数据库路径 |
| `agents` | 需要采集的日志源列表 |
| `agents.<id>.logDir` | 日志目录 |
| `agents.<id>.pattern` | 日志文件匹配模式 |
| `auditReview.enabled` | 是否启用周期性审查 |
| `auditReview.intervalMinutes` | 审查周期，默认 30 分钟 |
| `auditReview.initialDelaySeconds` | 服务启动后第一次审查的延迟 |
| `auditReview.lookbackOverlapMinutes` | 审查窗口重叠分钟数，降低漏检风险 |
| `auditReview.maxEventsPerReview` | 单轮审查最多送入规则/LLM 的候选事件数 |
| `auditReview.notification.callbackUrl` | 审查通知回调地址 |
| `auditReview.notification.minSeverity` | 预留字段，当前实现未实际使用 |
| `auditReview.http.requireDashboardToken` | 是否要求 Dashboard 读接口也携带 Token |
| `auditReview.http.allowedOrigins` | 审查相关接口和 Dashboard 的 CORS 白名单 |
| `auditReview.riskPolicy.*` | 本地规则预筛策略 |
| `auditReview.visualization.baseUrl` | Dashboard 对外基地址 |
| `auditReview.visualization.dashboardPath` | Dashboard 路由前缀 |

### 环境变量

| 变量名 | 说明 |
| --- | --- |
| `AUDIT_AGENT_LLM_API_KEY` | LLM API Key |
| `AUDIT_AGENT_LLM_BASE_URL` | OpenAI 兼容网关地址 |
| `AUDIT_AGENT_LLM_MODEL` | 模型名称 |
| `AUDIT_AGENT_LLM_TIMEOUT_MS` | LLM 调用超时毫秒数 |
| `AUDIT_AGENT_DASHBOARD_TOKEN` | Dashboard / 手动审查写接口 Bearer Token |

## 日志输入格式

项目期望上游 Agent 输出一行一条 JSON 的 NDJSON 文件。

必填字段：

- `ts`
- `agent_id`
- `trace_id`
- `span_id`
- `event`
- `tool_name`
- `status`
- `result_summary`

允许的 `event`：

- `tool.start`
- `tool.end`
- `tool.error`
- `agent.start`
- `agent.end`
- `agent.error`
- `run.start`
- `run.resume`
- `run.waiting_user`
- `run.final_result`
- `run.failed`

允许的 `status`：

- `ok`
- `error`
- `timeout`
- `cancelled`

常见可选字段：

- `parent_span_id`
- `duration_ms`
- `channel`
- `user_id`
- `product_id`
- `error`
- `tags`

示例：

```json
{"ts":"2026-07-03T10:00:00.000+08:00","agent_id":"mt-agent","trace_id":"trace_001","span_id":"span_001","event":"tool.end","tool_name":"browser.runScript","status":"ok","result_summary":"Page scraped","duration_ms":812,"channel":"http","product_id":"product_42"}
```

## 常用命令

### 采集日志

```bash
npm run ingest
```

按文件名日期做增量过滤：

```bash
npm run ingest -- --since 2026-07-01
```

说明：

- CLI 采集是批量扫描。
- 去重依据是原始 JSON 行的 SHA-256 截断值 `row_hash`。
- 同一 `span_id` 的 `start` / `end` / `error` 会分别独立入库。

### 查询事件

```bash
npm run query -- --status error --limit 20
```

支持参数：

- `--agent-id`
- `--tool-name`
- `--status`
- `--event`
- `--from`
- `--to`
- `--trace-id`
- `--product-id`
- `--channel`
- `--limit`
- `--offset`
- `--format json|table`

### 生成报表

```bash
npm run report -- --type daily --date 2026-07-03
npm run report -- --type errors --from 2026-07-01 --to 2026-07-03
npm run report -- --type tools --from 2026-07-01 --to 2026-07-03
```

### 启动 HTTP 服务

```bash
npm run server -- --port 9320
```

### 运行测试

```bash
npm test
```

自检脚本：

```bash
node test/self-test.js
```

说明：

- 单元和集成测试默认可离线运行。
- 依赖真实 LLM 的测试在没有配置 LLM 凭证时会自动跳过。

## HTTP API

### 基础查询接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查 |
| `GET` | `/query` | 查询 `audit_events` |
| `GET` | `/report/daily` | 每日报表 |
| `GET` | `/report/errors` | 错误报表 |
| `GET` | `/report/tools` | 工具使用统计 |

### LLM 任务运行时接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/runs` | 创建任务，异步返回 ACK |
| `GET` | `/v1/runs/{runId}` | 查询任务状态 |
| `POST` | `/v1/runs/{runId}/resume` | 提交用户决策后恢复任务 |

#### 创建任务请求体

推荐使用当前通用格式：

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
  "idempotency_key": "run-20260703-001"
}
```

当前实现说明：

- `delivery.mode` 虽然是字符串字段，但实际只支持 `callback`
- `idempotency_key` 可选，也可以通过 `Idempotency-Key` 请求头传入
- 如果 planner 认为信息不足，会先返回 `decision_request`，等待 `/resume`

#### 回调事件类型

运行时会往 `delivery.target_url` 投递：

- `progress_update`
- `decision_request`
- `final_result`

### 审查与 Dashboard 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/audit-reviews` | 审查批次列表 |
| `GET` | `/v1/audit-reviews/{reviewId}` | 单个审查批次详情 |
| `GET` | `/v1/audit-findings` | 风险发现列表 |
| `GET` | `/v1/audit-findings/{findingId}` | 单条风险发现详情 |
| `POST` | `/v1/audit-reviews/run` | 手动触发一轮审查 |
| `GET` | `/dashboard` | Dashboard 总览页 |
| `GET` | `/dashboard/audit-reviews/{reviewId}` | 审查批次详情页 |
| `GET` | `/dashboard/audit-findings/{findingId}` | 风险发现证据页 |

Dashboard 总览页和审查批次详情页会在风险发现表中展示“链路 ID”。点击链路 ID 会进入对应风险发现详情页，并定位到同一 `trace_id` 下按时间排序的工具调用链路。

权限规则：

- `POST /v1/audit-reviews/run` 始终需要 `Authorization: Bearer <AUDIT_AGENT_DASHBOARD_TOKEN>`
- 在本机 loopback 访问且 `requireDashboardToken=false` 时，审查读接口和 Dashboard 可免 Token
- 如果改成非 loopback 暴露，必须配置 Token

### 审查通知回调事件类型

周期性审查会往 `auditReview.notification.callbackUrl` 投递：

- `audit_review_summary`
- `audit_review_finding`

高风险和严重级别的 finding 会单独投递一条事件。

## 运行流程

### 1. 日志采集流程

1. 扫描 `config.json` 里每个 Agent 的日志目录。
2. 按 `pattern` 找到目标文件。
3. 解析 NDJSON，每行做字段校验。
4. 规范化字段并写入 `audit_events`。
5. 以 `row_hash` 去重，重复行不会重复入库。

### 2. LLM 任务运行时流程

1. 调用方请求 `POST /v1/runs`。
2. 服务创建 `agent_runs` 记录，并异步进入 `planning`。
3. Planner 基于当前工具清单生成：
   - `plan`
   - 或 `decision_request`
4. 如果需要用户决策，运行状态进入 `waiting_user`，并回调 `decision_request`。
5. 收到 `/resume` 后，Planner 基于用户选择继续生成 `plan`。
6. Runtime 按步骤在本地执行工具。
7. 结果写入 `agent_run_steps`，并回调 `progress_update`。
8. Planner 生成最终总结，状态进入 `completed` 或 `failed`。
9. 所有回调先进入 Outbox，由后台 flush 和重试。

当前 Runtime 暴露给 LLM 的本地工具只有两个：

- `audit.queryEvents`
- `report.errorSummary`

### 3. 周期性审查流程

1. 服务启动后等待 `initialDelaySeconds`，随后按 `intervalMinutes` 定时运行。
2. 调度器先抢占数据库租约锁，避免重复审查。
3. 基于 `audit_ingest_cursors` 做增量采集：
   - 文件未变化则跳过
   - 文件追加则续读
   - 文件截断或轮转则全量重读
   - 半行 JSON 留待下一轮
4. 本地规则预筛候选事件：
   - `failed_call`
   - `high_risk_permission`
   - `anomalous_call`
   - `repeated_call`
   - `trace_integrity`
   - `ingest_parse_error`
5. LLM 对候选事件做结构化审查并输出 findings。
6. Findings 以哈希去重写入 `audit_review_findings`，重复出现会增加 `occurrence_count`。
7. 生成审查摘要和高风险 finding 通知，写入 Outbox。
8. Dashboard 直接从 SQLite 读取审查结果并渲染页面；风险发现详情页会按 `trace_id` 串联展示工具调用链路。
9. 如果 LLM 失败，系统会降级为仅基于规则结果落库，批次状态记为 `completed_degraded`。

## 安全与部署注意事项

### 1. 当前服务固定监听 `127.0.0.1`

`scripts/server.js` 当前是硬编码：

- 服务总是监听 `127.0.0.1`
- `config.auditReview.http.bindHost` 当前只参与启动校验和授权策略判断
- 它不会改变 `app.listen()` 的实际绑定地址

如果你要对外开放：

- 要么在前面加反向代理
- 要么修改 `scripts/server.js`

### 2. 不要直接裸露到公网

当前这些接口没有内建鉴权：

- `/health`
- `/query`
- `/report/*`
- `/v1/runs`
- `/v1/runs/{runId}`
- `/v1/runs/{runId}/resume`

因此推荐部署方式是：

- 服务只监听本机
- 外部访问统一走受控网关或反向代理
- 在网关层补鉴权、审计和限流

### 3. 回调模式当前只有 `callback`

无论是 Runtime 还是审查通知，当前实现都依赖 HTTP POST 回调。

如果回调地址不可用：

- 事件会先进入 Outbox
- 默认最多重试 8 次
- 采用指数退避
- 最终会进入 `dead_letter`

### 4. 启动 `server` 必须有 LLM 凭证

即使你只想用 HTTP 查询接口，只要启动 `server`：

- 就会初始化 planner
- 就会初始化审查 reviewer
- 因此仍然要求 `AUDIT_AGENT_LLM_API_KEY` 和 `AUDIT_AGENT_LLM_MODEL`

如果不想依赖 LLM，请只使用 CLI。

### 5. 敏感配置建议放环境变量

推荐放环境变量：

- `AUDIT_AGENT_DASHBOARD_TOKEN`

建议不要把真实敏感值提交进：

- `config.json`
- `.config.example`

### 6. 源日志默认只读，SQLite 是唯一写入产物

系统不会修改上游 Agent 的日志文件，主要写入目标只有：

- `data/audit.db`
- 运行时和审查相关 SQLite 表

## 故障排查

### 服务启动即报缺少 LLM 配置

原因：

- 没有提供 `.config`
- 或环境变量里缺少 `AUDIT_AGENT_LLM_API_KEY`
- 或环境变量里缺少 `AUDIT_AGENT_LLM_MODEL`

### 手动触发审查返回 401 / 403

检查：

- 是否设置了 `AUDIT_AGENT_DASHBOARD_TOKEN`
- `Authorization` 头是否是 `Bearer <token>`
- Token 是否和服务进程读取到的一致

### Dashboard 打不开或审查接口跨域失败

检查：

- 访问地址是否在 `auditReview.http.allowedOrigins` 中
- 是否通过 loopback 访问
- 是否被反向代理改写了 `Origin`

### 审查有结果但没有通知

检查：

- `auditReview.notification.callbackUrl` 是否可达
- Outbox 是否出现 `dead_letter`
- 回调接收端是否返回 2xx

### 明明有日志文件但没有采集到数据

检查：

- `logDir` 是否解析到正确路径
- 文件名是否匹配 `pattern`
- 文件名里日期是否被 `--since` 过滤掉
- 单行 JSON 是否满足必填字段和事件枚举要求

## 目录结构

```text
src/
  adapters/         HTTP 和回调投递适配层
  agent/            LLM 运行时、planner、状态机、outbox
  app/              应用配置加载
  auditReview/      周期性审查、Dashboard、通知、锁、游标
  db/               SQLite 表结构
  llm/              OpenAI 兼容客户端和配置加载
  observability/    运行时审计日志
  tools/            提供给 LLM Runtime 的本地工具
scripts/
  ingest.js         批量采集
  query.js          命令行查询
  report.js         命令行报表
  server.js         服务启动入口
  lib/              解析、扫描、数据库基础能力
test/
  auditReview/      审查系统测试
  http/             HTTP API 测试
  llm/              LLM 相关测试
  runtime/          运行时测试
```

## 总结

如果你要的是一个本机常驻的 Agent 审计中台，当前推荐落地方式是：

1. 配好 `config.json`
2. 配好 `.config`
3. 用环境变量提供 `AUDIT_AGENT_DASHBOARD_TOKEN`
4. 启动 `npm run server -- --port 9320`
5. 让上游 Agent 持续往配置目录写审计日志
6. 让回调接收端接收运行结果和审查摘要

如果你只需要离线分析，则直接使用 `ingest`、`query`、`report` 三个 CLI 即可。
