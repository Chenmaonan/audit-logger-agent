# Audit Logger Agent

跨 Agent 的结构化审计日志采集、查询、报表，基于 LLM 的审计分析 Agent 运行时，以及 v1.4 的常驻式 LLM 日志审查与主动告警守护进程。

本项目把其它 Agent（rental-price-agent、MT-agent 及未来新增 Agent）在工具调用时产出的审计日志，统一汇聚到本地 SQLite，提供查询与报表接口；通过一个带状态机的 Agent 运行时，由 LLM 规划、本地执行工具，对审计异常进行分析与汇总；并自 v1.4 起，常驻周期性地采集其他 Agent 日志、用规则预筛 + LLM 结构化审查识别高危调用，主动通过通用回调投递审查摘要，并提供本地 Web Dashboard 钻取。

---

## 功能概览

- **日志采集**：扫描各 Agent 配置的日志目录，解析 NDJSON（`.jsonl`）审计日志，按 `row_hash`（原始 JSON 行的 SHA-256）去重入库，保证重复采集幂等、同一 `span_id` 的 start/end/error 事件仍各自独立。
- **查询**：按 agent、tool、status、trace、product、时间范围等灵活过滤审计事件。
- **报表**：日报、错误报表、工具统计报表。
- **HTTP 服务**：本地 HTTP API，支持在线查询与报表。
- **LLM Agent 运行时**：v1.3 起，planner 由 OpenAI 兼容的 LLM 驱动，输出结构化执行计划或决策请求；工具仍在本地执行，全过程可审计。
- **常驻式 LLM 日志审查（v1.4）**：`AuditReviewScheduler` 默认每 30 分钟运行一次审查周期——增量采集日志、规则预筛候选事件、LLM 结构化审查分级、持久化审查批次与去重 findings、生成通用回调投递摘要写入 outbox 主动投递，并提供本地 Dashboard 可视化。

---

## 运行环境

- Node.js ≥ 20（项目为 ESM）
- 依赖见 `package.json`，核心依赖：`better-sqlite3`、`openai`

---

## 安装

```bash
npm install
```

---

## 配置

### 1. 应用配置 `config.json`

设置各 Agent 的日志目录与文件名模式，以及数据库路径。

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

> `config.json` 只放非敏感配置，**不要放任何密钥**。

### 2. LLM 凭证 `.config`（项目级，git-ignored）

LLM 凭证单独存放在仓库根目录的 `.config` 文件（JSON 格式），不会提交到 git。复制示例文件后填入你的值：

```bash
cp .config.example .config
```

`.config` 字段（变量名为项目相关命名，不直接暴露供应商）：

```json
{
  "AUDIT_AGENT_LLM_API_KEY": "<your-api-key>",
  "AUDIT_AGENT_LLM_BASE_URL": "https://api.openai.com/v1",
  "AUDIT_AGENT_LLM_MODEL": "<your-model>",
  "AUDIT_AGENT_LLM_TIMEOUT_MS": "30000"
}
```

加载优先级：**进程环境变量 > `.config` 文件 > `config.json` 的 `planner` 块**（兜底非敏感项）。

- `AUDIT_AGENT_LLM_BASE_URL` 用于代理或 OpenAI 兼容网关；使用官方 OpenAI 时保持默认即可。
- 也可不使用 `.config`，改为设置同名进程环境变量，环境变量会覆盖 `.config`。
- `.config` 已在 `.gitignore` 中，模板见 `.config.example`。

---

## 可用命令

### 采集 ingest

扫描日志目录、解析 NDJSON、去重并入库。

```bash
node scripts/ingest.js [--since YYYY-MM-DD]
```

`--since` 按**文件名日期**（如 `audit-2026-07-02.jsonl`）限制扫描范围，用于增量采集。

### 查询 query

```bash
node scripts/query.js [options]
  --agent-id <id>          按 agent 过滤
  --tool-name <name>       按 tool 过滤（支持 % 通配）
  --status <status>        按状态过滤（ok, error, timeout, cancelled）
  --from <ISO timestamp>   时间范围起点
  --to <ISO timestamp>     时间范围终点
  --trace-id <id>          按 trace 过滤
  --product-id <id>        按 product 过滤
  --limit <n>              最多返回条数（默认 100）
  --format json|table      输出格式（默认 table）
```

### 报表 report

```bash
node scripts/report.js [options]
  --type daily|errors|tools   报表类型
  --date YYYY-MM-DD           日报日期
  --from <ISO>                范围报表起点
  --to <ISO>                  范围报表终点
  --agent-id <id>             按 agent 过滤
```

### 服务端 server

启动 HTTP API 服务，提供在线查询/报表，并承载 LLM Agent 运行时。

```bash
node scripts/server.js [--port 9320]
```

HTTP 接口：

- `GET /query?agent_id=...&tool_name=...&from=...&to=...&limit=100`
- `GET /report/daily?date=YYYY-MM-DD`
- `GET /report/errors?from=...&to=...`
- `GET /report/tools?from=...&to=...`
- `GET /health`
- `POST /v1/runs` —— 创建一个 Agent 运行任务（异步 ACK）
- `GET /v1/runs/{runId}` —— 查询运行状态
- `POST /v1/runs/{runId}/resume` —— 当运行暂停等待用户决策时，提交决策后恢复执行

v1.4 审查相关接口（鉴权见下文）：

- `GET /v1/audit-reviews` —— 审查批次列表（支持 `limit` / `offset`）
- `GET /v1/audit-reviews/{reviewId}` —— 某轮审查详情
- `GET /v1/audit-findings` —— findings 列表（支持 `severity` / `category` / `agent_id` / `tool_name` / `status` / `review_id` / `limit` / `offset`）
- `GET /v1/audit-findings/{findingId}` —— 单条 finding 详情
- `POST /v1/audit-reviews/run` —— 手动触发一轮审查（需 admin token；已有审查在运行时返回 `409 review_already_running`）
- `GET /dashboard` —— 审查总览页（HTML）
- `GET /dashboard/audit-reviews/{reviewId}` —— 审查详情页（HTML）
- `GET /dashboard/audit-findings/{findingId}` —— finding 证据页（HTML）

### 本地快速启动与手动派发任务

server 启动时会初始化 LLM planner，因此启动前必须通过 `.config` 或同名环境变量配置 `AUDIT_AGENT_LLM_API_KEY` 和 `AUDIT_AGENT_LLM_MODEL`。

```powershell
npm install
if (-not (Test-Path .config)) { Copy-Item .config.example .config }
```

在仓库根目录编辑 `.config`，填入真实的 LLM 网关、模型和密钥后启动：

```powershell
node scripts/server.js --port 9320
```

确认服务已经就绪：

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:9320/health" -Method Get
```

启动后，通过 `POST /v1/runs` 给 Agent 派发一个任务。`request.text` 是用户要安排的任务内容；`delivery.target_url` 是 Agent 投递进度、用户决策请求和最终结果的回调接收端地址。

```powershell
$body = @{
  source = @{
    channel = "manual"
    conversation_id = "oc_manual"
    message_id = "om_manual_001"
    user = @{ open_id = "ou_manual" }
  }
  request = @{ text = "分析今天所有审计异常，并汇总风险最高的链路" }
  delivery = @{
    mode = "callback"
    target_url = "http://127.0.0.1:9999/agent-events"
  }
  metadata = @{ tenant_key = "tenant_manual" }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Uri "http://127.0.0.1:9320/v1/runs" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

接口会先返回异步 ACK：

```json
{
  "run_id": "run_...",
  "status": "created"
}
```

随后可以查询运行状态：

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:9320/v1/runs/<run_id>" -Method Get
```

如果 Agent 认为任务范围不明确，它会向 `delivery.target_url` 投递 `decision_request`，其中包含 `run_id`、`decision_id`、`options` 和可选的 `form_schema`。调用方收集用户选择后，用 `/resume` 恢复任务：

```powershell
$resumeBody = @{
  decision_id = "<decision_id>"
  response = @{
    selected_option = "<option_id>"
    form_data = @{}
  }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Uri "http://127.0.0.1:9320/v1/runs/<run_id>/resume" `
  -Method Post `
  -ContentType "application/json" `
  -Body $resumeBody
```

`selected_option` 必须来自 `decision_request.options[].id`；如果 `form_schema` 里有必填字段，需要放入 `response.form_data`。

---

## LLM Agent 运行时（v1.3）

### 数据流

```text
调用方 -> POST /v1/runs -> Runtime.startRun
  -> LLM planner（OpenAI 兼容 Responses API）
  -> 结构化计划（plan）或决策请求（decision_request）
  -> 本地 plan 校验
  -> ToolRegistry 本地执行工具
  -> agent_run_steps
  -> LLM 合成最终结果
  -> agent_outbox_events
  -> delivery target (callback receiver)
```

### 工作方式

- LLM **只负责规划**，不直接执行工具；它输出符合结构化 schema 的决策对象，经本地校验后才交给运行时。
- 工具执行完全在本地、可审计：`audit.queryEvents` 查询审计事件、`report.errorSummary` 汇总错误。
- 当请求范围不明确时，planner 会返回 `decision_request`，运行时暂停为 `waiting_user` 状态，等待用户通过 `/v1/runs/{runId}/resume` 提交选择后再继续。
- 模型输出始终先经本地校验（`src/agent/plannerSchema.js`），不合规的输出会被拒绝，不会直接改变运行状态。
- 进程崩溃重启后，孤儿运行会被恢复机制标记为失败（`recoverInflightRuns`），避免任务卡死。

### 创建一个运行

```powershell
$body = @{
  source = @{
    channel = "manual"
    conversation_id = "oc_manual"
    message_id = "om_manual_openai"
    user = @{ open_id = "ou_manual" }
  }
  request = @{ text = "分析今天所有的审计异常并汇总风险最高的链路" }
  delivery = @{ mode = "callback"; target_url = "http://127.0.0.1:9999/agent-events" }
  metadata = @{ tenant_key = "tenant_manual" }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Uri "http://127.0.0.1:9320/v1/runs" -Method Post -ContentType "application/json" -Body $body
```

查询运行：

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:9320/v1/runs/<run_id>" -Method Get
```

---

## 常驻式 LLM 日志审查（v1.4）

v1.4 把 audit-logger-agent 从“被动查询、按需分析”升级为“常驻运行、周期采集、主动审核、主动通知、可视化追踪”的审计守护进程。完整设计见 `v1.4/PERIODIC_LLM_AUDIT_REVIEW_DESIGN.md`。

### 工作流程

每个审查周期（默认每 30 分钟，启动 30 秒后先跑一次）：

1. **增量采集**：按文件游标（`audit_ingest_cursors`）增量读取新增 NDJSON，文件未变跳过、变大续读、变小从头读、半行 JSON 留待下一轮；`row_hash` 仍是最终幂等保障。
2. **规则预筛**：`candidateDetector` 确定性识别失败调用、连续重复调用、高危工具名、超长耗时、未知工具、span 不完整、日志解析错误等候选事件，保证 LLM 不可用时也能发现基础风险。
3. **LLM 结构化审查**：`llmReviewer` 把候选摘要交由 LLM 合并同类、判断严重程度、给出解释与建议，输出经本地 schema 校验后入库；LLM 异常时降级为 `completed_degraded`，仍持久化规则层 findings 并标注“本轮仅包含规则检测结果”。
4. **持久化**：写入 `audit_review_runs`（含 `risk_policy_version` / `prompt_version` / `reviewer_version` / `llm_model`）与 `audit_review_findings`。`finding_hash`（不含 severity）跨重叠窗口去重，同一问题升级/降级时更新原 finding 的 severity 与 `occurrence_count`。
5. **主动通知**：生成 `audit_review_summary`（及对 high/critical 的单条 `audit_review_finding`）写入 `agent_outbox_events`，由现有 outbox flush 机制投递到通用回调接收端；摘要必带 `dashboard_url`。
6. **可视化**：本地 Dashboard 提供总览、审查详情、finding 证据钻取，复用通用模板布局。

### 并发与恢复

- 以数据库租约表 `audit_review_locks` 为准（默认 10 分钟租约，长任务定期刷新），同一进程内、定时与手动触发、甚至误启动多进程都不会重复审查。
- 租约已过期时可被抢占，旧 `running` 审查标记为 `failed`（`error_code = 'review_interrupted'`）。
- server 启动时 `recoverStaleRuns` 恢复异常中断的审查并释放过期租约。

### 鉴权与 CORS

- server 默认监听 `127.0.0.1`；Dashboard 只读页可本机无 token 访问（除非显式开启 `requireDashboardToken`）。
- `POST /v1/audit-reviews/run` 属主动执行入口，**始终要求 admin token**（`Authorization: Bearer <AUDIT_AGENT_DASHBOARD_TOKEN>`，缺失返回 401、错误返回 403）。
- 若 `bindHost` 改为非 loopback，Dashboard 与所有 `/v1/audit-*` API 都必须启用 bearer token，且未配置 token 时 server 启动失败。
- CORS 默认只允许同源；仅 `allowedOrigins` 明确配置的来源才放行跨源。

### 审查系统自身的审计事件

审查生命周期会写入 `audit_events`（`agent_id = audit-logger-agent`）：`review.start`、`review.lock.skipped`、`review.ingest.completed`、`review.detector.completed`、`review.llm.completed`、`review.notification.enqueued`、`review.completed`、`review.recovered`，便于周期任务失败后排查。

### 手动触发一轮审查

```bash
curl -X POST http://127.0.0.1:9320/v1/audit-reviews/run \
  -H "Authorization: Bearer $AUDIT_AGENT_DASHBOARD_TOKEN"
```

返回 `{ "review_id": "...", "status": "completed" }`（或 `completed_degraded` / `skipped`）。随后可查询：

```bash
curl -H "Authorization: Bearer $AUDIT_AGENT_DASHBOARD_TOKEN" \
  "http://127.0.0.1:9320/v1/audit-reviews?limit=10"
curl -H "Authorization: Bearer $AUDIT_AGENT_DASHBOARD_TOKEN" \
  "http://127.0.0.1:9320/v1/audit-findings?severity=high&limit=20"
```

### 风险类别与严重程度

首批类别：`high_risk_permission`、`anomalous_call`、`repeated_call`、`failed_call`、`trace_integrity`、`ingest_parse_error`。

四级严重程度：`critical` / `high`（必推送）、`medium`（默认进摘要）、`low`（默认不单独推送）。通知节流：已通知 finding 在 `last_notified_at` 后继续出现只更新 `occurrence_count`；severity 升级允许再次通知；`snoozed` finding 在 `snoozed_until` 前不重复推送。

### v1.4 配置块

在 `config.json` 中新增 `auditReview`（非敏感项；含 token 的 `callbackUrl` / `baseUrl` 应改放 `.config` 或环境变量）：

```json
{
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
        "*delete*", "*write*", "*update*", "*deploy*",
        "*permission*", "*credential*", "shell.*", "browser.runScript"
      ],
      "agentToolAllowlists": { "rental-price-agent": [], "mt-agent": [] }
    },
    "llmReview": {
      "promptVersion": "audit-review-prompt-v1",
      "reviewerVersion": "audit-reviewer-v1"
    },
    "visualization": {
      "enabled": true,
      "baseUrl": "http://127.0.0.1:9320",
      "dashboardPath": "/dashboard",
      "template": "audit-review-dashboard-v1",
      "attachDashboardUrlToCallback": true
    }
  }
}
```

敏感项可改用环境变量覆盖：`AUDIT_AGENT_REVIEW_CALLBACK_URL`、`AUDIT_AGENT_REVIEW_BASE_URL`、`AUDIT_AGENT_DASHBOARD_TOKEN`。

---

## 测试

```bash
# v1.4 审查系统单元/集成测试
node --test "test/auditReview/**/*.test.js"

# v1.3 Agent 运行时与基础设施测试
npm run test:agent
```

- 离线测试（配置、schema、工具元数据、运行时状态机、报表、审查存储/调度/检测器/通知/仪表板/鉴权/HTTP 集成等）无需凭证即可运行。
- 集成测试（`openaiPlanner`、`openaiResponsesClient`、`openaiRuntime`、`planner-factory`）需要真实的 LLM 凭证（`.config` 中填入 `AUDIT_AGENT_LLM_API_KEY` 与 `AUDIT_AGENT_LLM_MODEL`）；未配置时会自动跳过，不会失败。`planner-factory` 因依赖真实 LLM 非确定性输出偶有抖动，属已知项。
- `test/evals/auditReview/` 为 LLM 审查 eval 数据集（高危权限、连续失败、良性重试误报抑制、解析错误、降级回退共 28 个 case）；每次调整 `risk_policy_version` 或 `prompt_version` 都应跑 `test/auditReview/eval.test.js`。
- `node test/self-test.js` 为端到端自检脚本。

---

## 目录结构

```text
src/
  llm/              OpenAI 兼容客户端与配置加载
  agent/            运行时、planner、状态机、存储、事件发布、恢复
  tools/            工具注册表与具体工具（审计查询、错误报表）
  app/              应用配置加载
  db/               运行时 SQLite schema（含 v1.4 审查相关表 reviewSchema）
  observability/    运行时审计日志
  auditReview/      v1.4 审查守护进程模块
    scheduler.js          周期调度、租约并发、启动恢复
    ingestService.js      常驻模式复用日志采集（带文件游标）
    ingestCursorStore.js  文件游标与增量读取状态
    candidateDetector.js  本地规则预筛
    llmReviewer.js        LLM 结构化审查（带降级）
    reviewSchema.js       LLM 输出 JSON schema 与本地校验
    reviewStore.js        audit_review_runs/findings 持久化与去重
    lockStore.js          审查租约锁
    notification.js       审查结果转 outbox 通用投递 payload
    visualization.js      dashboard/API 数据聚合
    dashboardTemplate.js  通用 Dashboard 模板渲染
    dashboardAuth.js      Dashboard 与审查 API 鉴权/CORS
scripts/
  ingest.js         日志采集
  query.js          查询
  report.js         报表
  server.js         HTTP 服务 + Agent 运行时 + v1.4 审查调度器启动入口
  lib/              采集/解析/DB 公共库
test/
  runtime/          v1.3 运行时测试
  http/             HTTP API 测试
  llm/              LLM 配置/客户端测试
  auditReview/      v1.4 审查系统测试（含 httpIntegration）
  evals/auditReview LLM 审查 eval 数据集
v1.3/               v1.3 设计与使用文档
v1.4/               v1.4 设计文档
```

---

## 安全

- 对源日志文件只做只读操作，SQLite 数据库是唯一可写产物。
- 密钥只放在 git-ignored 的 `.config` 或环境变量，绝不写入 `config.json`、数据库、审计事件、outbox 或文档示例中的真实值。
- 模型输出永远先经本地校验，不会被直接信任并改变运行状态。
- v1.4：发给 LLM 的 evidence 只含摘要字段，默认不含原始 input/output；回调摘要不展示敏感参数，只展示 tool/agent/trace/错误摘要与建议。
- v1.4：Dashboard 与 `/v1/audit-*` API 默认只面向本机；对外监听时必须启用 token 鉴权与受限 CORS；手动触发审查 API 始终需鉴权，避免任何能访问端口者触发 LLM 调用与回调通知。
- v1.4：若 `callbackUrl` / `baseUrl` 实际包含 token，应迁移到 `.config` 或环境变量，不写入 `config.json`。

---

## 许可

本项目为内部工具，未指定开源许可。
