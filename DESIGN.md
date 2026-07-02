# Audit Logger Agent 与跨 Agent 日志规范设计方案

## 1. 背景与目标

工作空间中有两个 Agent 项目，均缺少统一的结构化审计日志：

| 项目 | 语言 | 工具数量 | 现有日志状况 |
|------|------|----------|-------------|
| `rental-price-agent-main` | Node.js (CommonJS) + Playwright | ~20 个 daemon action | 仅 stderr 前缀日志 (`[pw]`, `[batch]`)，无结构化审计 |
| `MT-agent-master` | TypeScript (ESM) + Playwright | 47 个 tool (12 个命名空间) | 有 `runtimeLogger.ts`（bot 事件）和 `agent-learning.jsonl`（学习事件），但无统一的工具调用审计 |

**目标：**
1. 定义一套**语言无关的日志规范**，两个项目均可输出
2. 构建一个**新的 audit-logger agent**，用于摄入、索引和审计两个 agent 的日志

---

## 2. 日志规范：`agent-audit-log` v1.0

### 2.1 文件格式

- **容器**：NDJSON（newline-delimited JSON），每行一个 JSON 对象
- **扩展名**：`.jsonl`
- **编码**：UTF-8
- **文件命名**：`audit-YYYY-MM-DD.jsonl`（按天轮转）

### 2.2 必填字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `ts` | string (ISO 8601) | 带时区的时间戳，如 `"2026-07-02T14:30:00.123+08:00"` |
| `agent_id` | string | Agent 实例标识，如 `"rental-price-agent"`、`"mt-agent"` |
| `trace_id` | string (UUID v4) | 将同一逻辑操作内的所有事件串联（一次批处理、一次用户请求等） |
| `span_id` | string (UUID v4) | 每行唯一，支持父子 span 关系 |
| `event` | enum | `"tool.start"`、`"tool.end"`、`"tool.error"`、`"agent.start"`、`"agent.end"`、`"agent.error"` |
| `tool_name` | string | 完全限定工具名，如 `"rental.read"`、`"publicTraffic.runReport"` |
| `status` | enum | `"ok"`、`"error"`、`"timeout"`、`"cancelled"` |
| `result_summary` | string | 一行人类可读摘要，最长 200 字符 |

### 2.3 可选字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `parent_span_id` | string (UUID v4) | 嵌套/因果操作的父 span |
| `duration_ms` | number | 耗时毫秒（在 `tool.end` / `agent.end` 时有意义） |
| `input` | object | 工具输入参数（需脱敏，截断至 1KB） |
| `output` | object | 工具输出摘要（截断至 1KB） |
| `error` | object | `{ "code": string, "message": string, "stack?": string }` — 仅 status 为 `"error"` 时 |
| `channel` | string | 调用渠道：`"cli"`、`"http"`、`"feishu"`、`"cron"`、`"webhook"` |
| `user_id` | string | 发起者标识（飞书用户 ID、CLI 用户、`"system"`） |
| `product_id` | string | 操作相关的业务实体 ID |
| `tags` | string[] | 自由标签，如 `["batch", "price-change"]` |

### 2.4 Span 模型

每个 `tool.start` 必须有对应的 `tool.end` 或 `tool.error`，且 `span_id` 相同。嵌套操作使用 `parent_span_id` 引用父 span。`trace_id` 将同一逻辑操作的所有 span 串联。

```
agent.start (span_id=A, trace_id=T)
  tool.start (span_id=B, parent_span_id=A, trace_id=T)
  tool.end   (span_id=B, parent_span_id=A, trace_id=T)
  tool.start (span_id=C, parent_span_id=A, trace_id=T)
  tool.end   (span_id=C, parent_span_id=A, trace_id=T)
agent.end   (span_id=A, trace_id=T)
```

### 2.5 示例

```jsonl
{"ts":"2026-07-02T14:30:00.100+08:00","agent_id":"rental-price-agent","trace_id":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","span_id":"b1c2d3e4-f5a6-7890-bcde-f12345678901","event":"agent.start","tool_name":"batch.execute","status":"ok","result_summary":"Batch execution started: 3 products","channel":"cli","tags":["batch"]}
{"ts":"2026-07-02T14:30:00.200+08:00","agent_id":"rental-price-agent","trace_id":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","span_id":"c1d2e3f4-a5b6-7890-cdef-123456789012","parent_span_id":"b1c2d3e4-f5a6-7890-bcde-f12345678901","event":"tool.start","tool_name":"rental.read","status":"ok","result_summary":"Reading product 761","channel":"http","product_id":"761","tags":["read","batch"]}
{"ts":"2026-07-02T14:30:01.434+08:00","agent_id":"rental-price-agent","trace_id":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","span_id":"c1d2e3f4-a5b6-7890-cdef-123456789012","parent_span_id":"b1c2d3e4-f5a6-7890-bcde-f12345678901","event":"tool.end","tool_name":"rental.read","status":"ok","result_summary":"Read product 761: price=99.00, stock=50","duration_ms":1234,"channel":"http","product_id":"761","tags":["read","batch"]}
{"ts":"2026-07-02T14:30:05.000+08:00","agent_id":"rental-price-agent","trace_id":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","span_id":"b1c2d3e4-f5a6-7890-bcde-f12345678901","event":"agent.end","tool_name":"batch.execute","status":"ok","result_summary":"Batch complete: 3/3 products updated","duration_ms":4900,"channel":"cli","tags":["batch"]}
```

---

## 3. Audit Logger Agent 设计

### 3.1 项目结构

```
audit-logger-agent/
  package.json              # Node.js ESM, 依赖 better-sqlite3
  SKILL.md                  # 技能契约，供外部编排器读取
  config.json               # 各 agent 日志目录路径配置
  LOG_SPEC.md               # 完整日志规范参考
  scripts/
    ingest.js               # 扫描日志目录 → 解析 NDJSON → 索引到 SQLite
    query.js                # CLI 查询工具：按 agent/tool/时间范围/状态过滤
    report.js               # 生成审计报告（日报/错误报告/工具使用统计）
    server.js               # HTTP API 服务（可选）
    lib/
      db.js                 # SQLite schema + 连接管理 + 查询构建器
      parser.js             # NDJSON 解析器 + 字段校验
      indexer.js            # 去重 + 批量插入逻辑
```

### 3.2 SQLite Schema

```sql
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  span_id TEXT UNIQUE NOT NULL,
  parent_span_id TEXT,
  event TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  result_summary TEXT,
  duration_ms INTEGER,
  channel TEXT,
  user_id TEXT,
  product_id TEXT,
  error_code TEXT,
  error_message TEXT,
  tags TEXT,                  -- JSON 数组
  raw_json TEXT               -- 完整原始 JSON 行
);

CREATE INDEX idx_audit_ts ON audit_events(ts);
CREATE INDEX idx_audit_agent ON audit_events(agent_id);
CREATE INDEX idx_audit_tool ON audit_events(tool_name);
CREATE INDEX idx_audit_trace ON audit_events(trace_id);
CREATE INDEX idx_audit_status ON audit_events(status);
CREATE INDEX idx_audit_product ON audit_events(product_id);
```

### 3.3 核心能力

| 能力 | CLI 命令 | 说明 |
|------|----------|------|
| **ingest** | `node scripts/ingest.js [--since YYYY-MM-DD]` | 扫描配置的日志目录，解析 NDJSON，按 `span_id` 去重，插入 SQLite |
| **query** | `node scripts/query.js [--agent-id ...] [--tool-name ...] [--status ...] [--from ...] [--to ...] [--limit 100]` | 灵活过滤查询，支持 `--format json\|table` |
| **report** | `node scripts/report.js --type daily\|errors\|tools [--date ...] [--from ...] [--to ...]` | 日报（按 agent/tool/status 统计）、错误报告、工具使用热力图 |
| **server** | `node scripts/server.js [--port 9320]` | HTTP API：`GET /query`、`GET /report/daily`、`GET /report/errors`、`GET /report/tools`、`GET /health` |

### 3.4 技术选型

**Node.js (JavaScript ESM)** — 两个现有 agent 均基于 Node.js，保持生态一致。日志规范本身是语言无关的（NDJSON），未来非 JS agent 也可输出相同格式。

---

## 4. 现有 Agent 改造方案

### 4.1 rental-price-agent-main 改造

**新增文件：** `scripts/lib/audit-logger.js`

CommonJS 模块，导出 `createAuditLogger(agentId, logDir)`，返回：
- `logEvent(entry)` — 直接写入一条日志
- `startSpan(toolName, opts)` — 写入 `tool.start`，返回 `{ spanId, traceId, startTime }`
- `endSpan(span, status, resultSummary, extra)` — 写入 `tool.end` 或 `tool.error`
- `startAgent(toolName, opts)` — 写入 `agent.start`
- `endAgent(span, status, resultSummary, extra)` — 写入 `agent.end` 或 `agent.error`

日志输出到 `tasks/logs/audit-YYYY-MM-DD.jsonl`。

**修改文件：**

| 文件 | 改动 |
|------|------|
| `scripts/playwright-runner.js` | `handleCommand()` 中每个 action 用 `audit.startSpan()` / `audit.endSpan()` 包裹，捕获异常时写 `tool.error` |
| `scripts/batch-runner.js` | `batchExecute()` 用 `audit.startAgent()` / `audit.endAgent()` 包裹；`processProduct()` 用 `audit.startSpan()` / `audit.endSpan()` 包裹 |

### 4.2 MT-agent-master 改造

**新增文件：** `src/observability/auditLogger.ts`

TypeScript ESM 模块，API 与 JS 版一致。日志输出到 `output/logs/audit-YYYY-MM-DD.jsonl`。

**修改文件：**

| 文件 | 改动 |
|------|------|
| `src/feishuBot/agentToolExecutor.ts` | `executeAgentToolRequest()` 中所有 47 个 tool 执行用 `audit.startSpan()` / `audit.endSpan()` 包裹 |

---

## 5. 配置

`audit-logger-agent/config.json`：

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

---

## 6. 验证步骤

1. 启动 rental-price-agent daemon，发送 `read` 命令，验证 `tasks/logs/audit-YYYY-MM-DD.jsonl` 生成且为合法 NDJSON
2. 运行 MT-agent 飞书 bot，通过飞书消息触发一个 tool，验证 `output/logs/audit-YYYY-MM-DD.jsonl` 生成
3. 运行 `node scripts/ingest.js` — 验证无解析错误，所有事件已索引
4. 运行 `node scripts/query.js --agent-id rental-price-agent --tool-name rental.read` — 验证结果正确
5. 运行 `node scripts/report.js --type daily --date 2026-07-02` — 验证统计计数
6. 验证日志行符合规范：所有必填字段存在、类型正确、ISO 8601 时间戳

---

## 7. 文件清单

### 新建文件

| 文件 | 说明 |
|------|------|
| `E:\工作空间\audit-logger-agent\package.json` | 项目配置 |
| `E:\工作空间\audit-logger-agent\SKILL.md` | 技能契约 |
| `E:\工作空间\audit-logger-agent\config.json` | Agent 日志路径配置 |
| `E:\工作空间\audit-logger-agent\LOG_SPEC.md` | 日志规范全文 |
| `E:\工作空间\audit-logger-agent\scripts\lib\db.js` | SQLite 数据库层 |
| `E:\工作空间\audit-logger-agent\scripts\lib\parser.js` | NDJSON 解析与校验 |
| `E:\工作空间\audit-logger-agent\scripts\lib\indexer.js` | 日志扫描与索引 |
| `E:\工作空间\audit-logger-agent\scripts\ingest.js` | 摄入 CLI |
| `E:\工作空间\audit-logger-agent\scripts\query.js` | 查询 CLI |
| `E:\工作空间\audit-logger-agent\scripts\report.js` | 报告 CLI |
| `E:\工作空间\audit-logger-agent\scripts\server.js` | HTTP API 服务 |
| `E:\工作空间\rental-price-agent-main\scripts\lib\audit-logger.js` | rental-price-agent 日志发射模块 |
| `E:\工作空间\rental-price-agent-main\test-audit.js` | 日志输出验证脚本 |
| `E:\工作空间\MT-agent-master\src\observability\auditLogger.ts` | MT-agent 日志发射模块 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `E:\工作空间\rental-price-agent-main\scripts\playwright-runner.js` | 引入 audit logger，`handleCommand()` 全量包裹 |
| `E:\工作空间\rental-price-agent-main\scripts\batch-runner.js` | 引入 audit logger，`batchExecute()` 和 `processProduct()` 包裹 |
| `E:\工作空间\MT-agent-master\src\feishuBot\agentToolExecutor.ts` | 引入 audit logger，`executeAgentToolRequest()` 全量包裹 |
