# Audit Logger Agent

跨 Agent 的结构化审计日志采集、查询、报表，以及基于 LLM 的审计分析 Agent 运行时。

本项目把其它 Agent（rental-price-agent、MT-agent 及未来新增 Agent）在工具调用时产出的审计日志，统一汇聚到本地 SQLite，提供查询与报表接口；并通过一个带状态机的 Agent 运行时，由 LLM 规划、本地执行工具，对审计异常进行分析与汇总。

---

## 功能概览

- **日志采集**：扫描各 Agent 配置的日志目录，解析 NDJSON（`.jsonl`）审计日志，按 `row_hash`（原始 JSON 行的 SHA-256）去重入库，保证重复采集幂等、同一 `span_id` 的 start/end/error 事件仍各自独立。
- **查询**：按 agent、tool、status、trace、product、时间范围等灵活过滤审计事件。
- **报表**：日报、错误报表、工具统计报表。
- **HTTP 服务**：本地 HTTP API，支持在线查询与报表。
- **LLM Agent 运行时**：v1.3 起，planner 由 OpenAI 兼容的 LLM 驱动，输出结构化执行计划或决策请求；工具仍在本地执行，全过程可审计。

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
  -> Bot callback_url
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
  channel = "feishu"
  conversation_id = "oc_manual"
  message_id = "om_manual_openai"
  user = @{ open_id = "ou_manual" }
  request = @{ text = "分析今天所有的审计异常并汇总风险最高的链路" }
  delivery = @{ mode = "callback"; callback_url = "http://127.0.0.1:9999/agent-events" }
  metadata = @{ tenant_key = "tenant_manual" }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Uri "http://127.0.0.1:9320/v1/runs" -Method Post -ContentType "application/json" -Body $body
```

查询运行：

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:9320/v1/runs/<run_id>" -Method Get
```

---

## 测试

```bash
npm run test:agent
```

- 离线测试（配置、schema、工具元数据、运行时状态机、报表等）无需凭证即可运行。
- 集成测试（`openaiPlanner`、`openaiResponsesClient`、`openaiRuntime`、`planner-factory`）需要真实的 LLM 凭证（`.config` 中填入 `AUDIT_AGENT_LLM_API_KEY` 与 `AUDIT_AGENT_LLM_MODEL`）；未配置时会自动跳过，不会失败。
- `node test/self-test.js` 为端到端自检脚本。

---

## 目录结构

```text
src/
  llm/              OpenAI 兼容客户端与配置加载
  agent/            运行时、planner、状态机、存储、事件发布、恢复
  tools/            工具注册表与具体工具（审计查询、错误报表）
  app/              应用配置加载
  db/               运行时 SQLite schema
  observability/    运行时审计日志
scripts/
  ingest.js         日志采集
  query.js          查询
  report.js         报表
  server.js         HTTP 服务 + Agent 运行时启动入口
  lib/              采集/解析/DB 公共库
test/               node:test 测试套件
v1.3/               v1.3 设计与使用文档
```

---

## 安全

- 对源日志文件只做只读操作，SQLite 数据库是唯一可写产物。
- 密钥只放在 git-ignored 的 `.config`，绝不写入 `config.json`、数据库、审计事件、outbox 或文档示例中的真实值。
- 模型输出永远先经本地校验，不会被直接信任并改变运行状态。

---

## 许可

本项目为内部工具，未指定开源许可。