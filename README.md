# Audit Logger Agent

跨 Agent 的审计日志服务。它接收其他 Agent 主动上报的审计事件，保存原始证据并写入 SQLite，提供查询、报表、周期审查、风险 Finding 和 Dashboard。

服务面向需要追踪 Agent 行为、排查任务链路和查看异常操作的人。它不会扫描其他容器的日志目录；上游 Agent 通过 HTTP 主动发送事件。

## 能力

- 接收 JSON 或 NDJSON 审计事件，并保存到 SQLite 与服务端 spool。
- 按 Agent、链路、工具、状态、时间和业务实体查询事件。
- 生成日报、错误报表和工具使用统计。
- 周期审查异常、慢调用、高风险工具和不完整链路，生成 Finding。
- 通过 Dashboard 查看审查批次、Finding 与关联证据。

## 本地启动

需要 Node.js 20+、可写的项目目录和 OpenAI-compatible LLM 配置。创建未纳入 Git 的 `.config`：

```json
{
  "AUDIT_AGENT_LLM_API_KEY": "<api-key>",
  "AUDIT_AGENT_LLM_MODEL": "<model-name>"
}
```

`AUDIT_AGENT_DASHBOARD_TOKEN` 只从进程环境变量读取，用于登录 `http://127.0.0.1:9320/dashboard/login`；请使用高熵随机值，不要复用 LLM API Key。

然后执行：

```powershell
npm install
$env:AUDIT_AGENT_DASHBOARD_TOKEN = '<使用高熵随机值>'
npm run server -- --port 9320
Invoke-RestMethod -Uri 'http://127.0.0.1:9320/health'
```

默认监听 `127.0.0.1:9320`。`/health` 返回正常状态且数据库可写，即表示服务可用。

## 使用入口

| 入口 | 用途 |
| --- | --- |
| `GET /health` | 查看服务与数据库健康状态 |
| `GET /query` | 查询审计事件 |
| `GET /report/daily` | 查看日报 |
| `GET /report/errors` | 查看错误报表 |
| `GET /report/tools` | 查看工具使用统计 |
| `GET /dashboard/login` | 登录 Dashboard |
| `POST /v1/ingest` | 接收其他 Agent 的审计事件 |

## 文档

- [Dokploy 部署说明](docs/dokploy-deployment.md)：生产部署、变量、域名、网络边界、Dashboard 和备份恢复。
- [其他 Agent 接入日志审计服务指南](docs/agent-audit-log-integration-guide.md)：供编码 Agent 改造上游 Agent 的事件契约、可靠投递和验收要求。

## 运行边界

`/v1/ingest` 当前没有内建认证。生产环境必须仅允许受控上游 Agent 或可信网关访问，不能直接暴露到公网。Dashboard 使用 `AUDIT_AGENT_DASHBOARD_TOKEN` 登录；部署细节见 Dokploy 说明。
