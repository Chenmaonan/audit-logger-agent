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
  "AUDIT_AGENT_LLM_MODEL": "<model-name>",
  "AUDIT_AGENT_LLM_TIMEOUT_MS": "900000",
  "AUDIT_AGENT_LLM_MAX_OUTPUT_TOKENS": "1200",
  "AUDIT_AGENT_LLM_REASONING_EFFORT": "low"
}
```

Dashboard 页面可直接访问，不需要登录。`AUDIT_AGENT_DASHBOARD_TOKEN` 只从进程环境变量读取，用于 `/v1/audit-*` API 的 Bearer 鉴权；如需调用这些 API，请使用高熵随机值，不要复用 LLM API Key。

然后执行：

```powershell
npm install
npm run server -- --port 9320
Invoke-RestMethod -Uri 'http://127.0.0.1:9320/health'
```

默认监听 `127.0.0.1:9320`。`/health` 返回正常状态且数据库可写，即表示服务可用。

## 当前 Dokploy 部署

当前服务已部署在 Dokploy，公开访问基地址为：

```text
http://auditloggeragent-auditloggeragent-mue8ko-342fc3-18-141-240-9.traefik.me
```

常用入口：

| 入口 | 地址 |
| --- | --- |
| Dashboard | `http://auditloggeragent-auditloggeragent-mue8ko-342fc3-18-141-240-9.traefik.me/dashboard` |
| 健康检查 | `http://auditloggeragent-auditloggeragent-mue8ko-342fc3-18-141-240-9.traefik.me/health` |
| Agent 日志发送 | `http://auditloggeragent-auditloggeragent-mue8ko-342fc3-18-141-240-9.traefik.me/v1/ingest` |

上游 Agent 的 `AUDIT_INGEST_URL` 应配置为上述 Agent 日志发送地址。`/v1/ingest` 当前没有内建认证，生产环境应只允许可信 Agent 或受控网关访问该地址。

## 使用入口

| 入口 | 用途 |
| --- | --- |
| `GET /health` | 查看服务与数据库健康状态 |
| `GET /query` | 查询审计事件 |
| `GET /report/daily` | 查看日报 |
| `GET /report/errors` | 查看错误报表 |
| `GET /report/tools` | 查看工具使用统计 |
| `GET /dashboard` | 查看 Dashboard |
| `POST /v1/ingest` | 接收其他 Agent 的审计事件 |

## 文档

- [Dokploy 部署说明](docs/dokploy-deployment.md)：生产部署、变量、域名、网络边界、Dashboard 和备份恢复。
- [其他 Agent 接入日志审计服务指南](docs/agent-audit-log-integration-guide.md)：可直接交给编码 Agent 执行，覆盖仓库审计、日志字段契约、自动改造流程、真实发送和 Dashboard 验收。

## 运行边界

`/v1/ingest` 当前没有内建认证。生产环境必须仅允许受控上游 Agent 或可信网关访问，不能直接暴露到公网。Dashboard 页面本身不要求登录；部署时必须依赖反向代理、VPN、IP allowlist 或平台访问控制限制可见范围。部署细节见 Dokploy 说明。
