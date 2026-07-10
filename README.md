# Audit Logger Agent

`audit-logger-agent` 是一个跨 Agent 的审计日志服务。它接收业务 Agent 主动上报的审计事件，保留原始证据并写入本地 SQLite，提供查询、报表、周期审查、风险 Finding 和 Dashboard。

它面向需要了解 Agent 行为、追溯一次任务链路、查看异常操作或运行审查的人类使用者。服务不扫描其他机器或容器的日志目录，也不保存密钥、Cookie、Token、完整页面内容或未脱敏的个人数据。

## 能力

- 接收 JSON 或 NDJSON 审计事件，并同步写入数据库和服务端 spool。
- 按 Agent、链路、工具、状态、时间和业务实体查询事件。
- 生成日常汇总、错误报表和工具使用统计。
- 对异常、慢调用、高风险工具和不完整链路执行周期审查，生成 Finding。
- 提供 Dashboard 查看审查批次、Finding 与证据。

## 快速启动

前提：Node.js 20+、项目目录可写，以及可用的 OpenAI-compatible LLM 配置。

在项目根目录创建未纳入 Git 的 `.config`：

```json
{
  "AUDIT_AGENT_LLM_API_KEY": "<api-key>",
  "AUDIT_AGENT_LLM_BASE_URL": "https://api.openai.com/v1",
  "AUDIT_AGENT_LLM_MODEL": "<model-name>",
  "AUDIT_AGENT_LLM_TIMEOUT_MS": "30000"
}
```

随后启动服务：

```powershell
npm install
npm run server -- --port 9320
Invoke-RestMethod -Uri 'http://127.0.0.1:9320/health'
```

默认监听 `127.0.0.1:9320`。健康检查返回正常状态且数据库可写，即表示服务可用。

## 配置与数据

主配置文件为 `config.json`。常用配置如下：

| 配置 | 说明 | 默认值 |
| --- | --- | --- |
| `ingest.http.enabled` | 是否启用日志接收接口 | `true` |
| `ingest.http.maxBodyBytes` | 单次接收请求最大字节数 | 1 MiB |
| `ingest.http.maxLineBytes` | 单个事件或 NDJSON 单行最大字节数 | 64 KiB |
| `auditReview.enabled` | 是否启动周期审查 | `true` |
| `auditReview.intervalMinutes` | 审查间隔 | 30 分钟 |
| `auditReview.http.bindHost` | 服务监听地址 | `127.0.0.1` |
| `retention` | 数据、日志和临时文件的留存策略 | 见 `config.json` |

运行数据位于 `data/`，服务日志位于 `logs/`。其中 SQLite 数据库默认位于 `data/db/audit.db`，接收的原始事件副本位于 `data/spool/incoming/`。

## 使用入口

| 入口 | 用途 |
| --- | --- |
| `GET /health` | 查看服务和数据库健康状态 |
| `GET /query` | 查询审计事件 |
| `GET /report/daily` | 查看每日汇总 |
| `GET /report/errors` | 查看错误报表 |
| `GET /report/tools` | 查看工具使用统计 |
| `GET /dashboard` | 查看 Dashboard |
| `POST /v1/ingest` | 接收其他 Agent 的审计事件 |

例如，按链路查询：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:9320/query?trace_id=<trace-id>&limit=100'
```

工具语义映射和周期审查在事件接收后异步执行。事件已出现于查询结果时，相关分类或 Finding 可能仍在处理中。

## 接入与部署

其他 Agent 的改造、事件字段、可靠投递、重试回放、网络边界和验收步骤均在独立指南中说明：

[其他 Agent 接入日志审计服务指南](docs/agent-audit-log-integration-guide.md)

该指南面向编码 Agent 和部署实施者。人类使用者通常只需要确认审计服务已启动、网络边界受控，并通过 Dashboard、查询和报表查看结果。

## 运行边界

当前 ingest 接口没有内建认证。默认仅监听本机；跨机器部署时，应使用受控私网、VPN、mTLS 或具备 TLS、认证和来源限制的反向代理。不要将 ingest 或查询接口直接暴露到公网。

部署前应根据实际合规要求复核 `retention` 留存策略，并使用适合 SQLite WAL 模式的备份方式保护数据库及其 WAL/SHM 文件。
