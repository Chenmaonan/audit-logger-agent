# Audit Logger Agent

`audit-logger-agent` 是一个面向多 Agent 场景的审计日志服务。它接收业务 Agent 主动上报的审计事件，保留原始证据，写入本地 SQLite，并提供查询、报表、周期审查、Finding 和 Dashboard。

项目面向需要追踪 Agent 行为、复盘任务链路、查看异常操作或执行运行审查的使用者。服务不扫描其他机器或容器的日志目录，也不保存密钥、Cookie、Token、完整页面内容或未脱敏的个人数据。

## 能力

- 接收 JSON 或 NDJSON 审计事件，并写入数据库和服务端 spool。
- 按 Agent、链路、工具、状态、时间和业务实体查询事件。
- 生成日常汇总、错误报表和工具使用统计。
- 对异常、慢调用、高风险工具和不完整链路执行周期审查，生成 Finding。
- 提供 Dashboard 查看审查批次、Finding、证据和快照。
- Dashboard 安全能力包括 magic link 登录、24h session、Agent 选择、24h snapshot 和下载 HTML。

## 快速启动

前提：Node.js 20+、项目目录可写，以及可用的 OpenAI-compatible LLM 配置。

在项目根目录创建不纳入 Git 的 `.config`：

```json
{
  "AUDIT_AGENT_LLM_API_KEY": "<api-key>",
  "AUDIT_AGENT_LLM_BASE_URL": "https://api.openai.com/v1",
  "AUDIT_AGENT_LLM_MODEL": "<model-name>",
  "AUDIT_AGENT_LLM_TIMEOUT_MS": "30000"
}
```

在类 Unix 环境中，建议限制配置文件权限：

```sh
chmod 600 .config
```

本地启动示例：

```powershell
npm install
npm run server -- --port 9320
Invoke-RestMethod -Uri 'http://127.0.0.1:9320/health'
```

默认监听 `127.0.0.1:9320`。健康检查返回正常状态且数据库可写，表示服务可用。

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

运行数据默认位于 `data/`，服务日志默认位于 `logs/`。关键路径包括：

- `data/tmp/`：服务拥有的临时运行文件，可由应用自清理策略管理。
- `data/captures/`：服务拥有的证据或捕获文件，可由应用自清理策略管理。
- `logs/`：服务运行日志目录，可由应用留存策略或外部 logrotate 管理。
- `data/db/audit.db`：默认 SQLite 数据库路径。
- `data/spool/incoming/`：接收事件的原始副本。

工作区本地工具目录和文件不属于应用拥有的数据：

- `.agents/`
- `.claude/`
- `.superpowers/`
- `record.json`
- `Typora_Hook_Log.txt`

这些对象属于 outside app self-cleanup scope。应用不会主动删除它们；如需清理，应由对应工具或人工流程处理。

历史根目录回调日志仅保留迁移兼容说明：

- `.callback-*.log`
- `.callback-*.err.log`

它们属于 runtime path migration 的兼容遗留项，not part of app self-cleanup。新运行数据应优先落在配置指定的 `data/` 和 `logs/` 路径中。

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

按链路查询示例：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:9320/query?trace_id=<trace-id>&limit=100'
```

工具语义映射和周期审查在事件接收后异步执行。事件已经出现在查询结果中时，相关分类或 Finding 可能仍在处理中。

## 接入与部署

其他 Agent 的改造、事件字段、可靠投递、重试回放、网络边界和验收步骤在独立指南中说明：

[其他 Agent 接入日志审计服务指南](docs/agent-audit-log-integration-guide.md)

该指南面向编码 Agent 和部署实施者。人类使用者通常只需要确认审计服务已启动、网络边界受控，并通过 Dashboard、查询和报表查看结果。

## 长期运行

长期运行时应按环境选择进程管理方式。以下命令是示例，需要结合实际路径、用户和端口调整，不代表通用部署脚本。

使用 PM2 时，常见流程是先验证本地命令可运行，再配置守护：

```sh
pm2 start npm --name audit-logger-agent -- run server -- --port 9320
pm2 startup
```

使用 systemd 时，应在服务单元中设置明确的工作目录、用户、环境文件和重启策略，例如包含：

```ini
Restart=always
```

无论使用 PM2 还是 systemd，都应把日志输出和轮转策略纳入运维配置。可按实际环境使用 logrotate 管理 `.server.log`、`.server.err.log` 或 `logs/` 下的运行日志，避免日志无限增长。

## 备份与清理

数据库使用 SQLite。备份时应考虑 WAL 模式下的数据库文件及其 WAL/SHM 伙伴文件，或使用 `sqlite3` 的在线备份能力，例如 `.backup`。不要只复制单个主库文件就假定备份完整。

清理前先 dry run：

```sh
node scripts/prune.js --dry-run
```

确认输出符合预期后，再按项目脚本支持的正式参数执行清理。部署前应根据实际合规要求复核 `retention` 留存策略。

## 运行边界

当前 ingest 接口没有内建认证。默认仅监听本机；跨机器部署时，应使用受控私网、VPN、mTLS，或具备 TLS、认证和来源限制的反向代理。不要将 ingest 或查询接口直接暴露到公网。
