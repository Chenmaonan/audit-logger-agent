# 使用 Dokploy 部署 Audit Logger Agent

本文面向部署人员。项目已提供 `compose.dokploy.yaml`、`Dockerfile` 和容器配置 `config.container.json`；Dokploy 从仓库构建镜像并通过反向代理对外提供服务。

## 1. 在 Dokploy 创建 Compose 应用

1. 在 Dokploy 新建 Compose 应用，连接本仓库和要部署的分支。
2. 将 Compose 文件指定为 `compose.dokploy.yaml`。它会使用根目录的 `Dockerfile` 构建服务 `audit-logger-agent`。
3. 不要自行把容器端口 `9320` 发布到主机或公网。Compose 仅 `expose` 该端口，后续由 Dokploy Proxy 转发。
4. 部署后确认容器健康状态为 healthy；Compose 内置健康检查会访问 `http://127.0.0.1:9320/health`。

容器固定读取 `/app/config.container.json`，并监听 `0.0.0.0:9320`。这些值已在 Compose 环境变量中配置，通常不需要在 Dokploy 覆盖。

审查调度会在每个 `/v1/ingest` 成功接收至少一条事件后立即触发一次；该次审查完成后，下一次定时审查会重新按 `auditReview.intervalMinutes`（默认 30 分钟）计时。

## 2. 配置环境变量和 Secret

在 Dokploy 的 Environment/Secret 中设置以下变量，不要把真实值提交到仓库：

| 变量 | 是否必填 | 说明 |
| --- | --- | --- |
| `AUDIT_AGENT_LLM_API_KEY` | 是 | OpenAI-compatible LLM 的 API Key |
| `AUDIT_AGENT_LLM_MODEL` | 是 | 审查与语义映射使用的模型名 |
| `AUDIT_AGENT_LLM_BASE_URL` | 是 | OpenAI-compatible LLM API 地址，例如 `https://api.openai.com/v1` 或实际模型服务地址 |
| `AUDIT_AGENT_LLM_TIMEOUT_MS` | 否 | LLM 请求超时毫秒数；未设置时为 `30000` |
| `AUDIT_AGENT_DASHBOARD_TOKEN` | 否 | `/v1/audit-*` Bearer 鉴权密钥；Dashboard 页面不使用它 |
| `AUDIT_AGENT_FEISHU_MODE` | 否 | `disabled`、`dry-run` 或 `live`，默认 `disabled` |
| `AUDIT_AGENT_FEISHU_WEBHOOK_URL` | live 时是 | 飞书自定义机器人 Webhook；只通过 Dokploy Secret 注入 |
| `AUDIT_AGENT_FEISHU_WEBHOOK_FILE` | 否 | Webhook secret 文件路径；配置后优先于 URL 环境变量 |
| `AUDIT_AGENT_FEISHU_LIVE_CONFIRM` | live 时是 | 必须为 `CONFIRM_FEISHU_LIVE`，用于防止误开启真实发送 |

如需调用 `/v1/audit-*` API，`AUDIT_AGENT_DASHBOARD_TOKEN` 应是独立的高强度随机值。未配置时 Dashboard 仍可访问，但审查 API 的 Bearer 鉴权不会放行请求。

飞书通知默认关闭。建议先使用 `dry-run` 验证卡片构建，再切换 `live`。Webhook 不应写入配置文件、Git、日志或命令历史；生产启用前应在飞书侧配置 IP 白名单或关键词安全策略。当前发送器未生成飞书签名字段，如需启用签名校验，应先扩展并验证签名支持。日报固定按 `Asia/Shanghai` 每天 10:00、17:00 运行。

## 3. 持久化与健康检查

Compose 已声明命名卷 `audit-logger-data` 并挂载到 `/app/data`。该卷保存 SQLite 数据库、WAL/SHM 文件、接收 spool、captures 和临时运行数据；删除容器不会保留数据，删除该卷才会。

在 Dokploy 中保留该 Volume，不要改为容器临时文件系统。部署完成后，通过 Dokploy 健康检查或受控网络请求确认：

```text
GET /health -> 200
```

响应中的 `status` 应为 `ok`，且 `db.writable` 为 `true`。

## 4. 域名、TLS 与网络边界

在 Dokploy 为该应用绑定正式域名，并由 Dokploy Proxy 终止 TLS、将 HTTPS 请求转发到容器端口 `9320`。生产访问应始终使用 `https://<域名>`。

严禁绕过 Dokploy Proxy 直接暴露服务端口、Docker host port 或容器 IP 到公网。这样会绕过 TLS、Dashboard Cookie 的代理 HTTPS 标识及网关访问控制。

`POST /v1/ingest` 没有内建认证。必须限制未认证 `/v1/ingest` 的来源，至少选择一种方式：

- 在 Dokploy Proxy 或上游反向代理/网关按来源 IP、VPN 网段、mTLS 或专用认证策略限制该路径；或
- 将 ingest 仅置于私有网络，让上游 Agent 通过内网访问，并且不要为该路径绑定公网路由。

不要依赖 Dashboard Token 保护 ingest：它不用于 `/v1/ingest`。同时应限制 Dashboard、`/query` 和 `/report/*` 的公开访问范围，避免暴露审计数据。

## 5. Dashboard 访问

部署和域名生效后，使用：

```text
https://<域名>/dashboard
```

Dashboard 页面不要求登录，能访问该域名和路径的用户可以直接查看审计数据。生产环境应在 Dokploy Proxy、上游网关、VPN 或 IP allowlist 中限制访问范围。审查 API `/v1/audit-*` 不接受 Dashboard 页面访问权限，只接受 `AUDIT_AGENT_DASHBOARD_TOKEN` 对应的 Bearer 请求。

## 6. 飞书通知

容器配置使用 `auditReview.notification.enabled=true` 和 `mode=feishu_bot`，但 `AUDIT_AGENT_FEISHU_MODE` 默认是 `disabled`，因此新部署不会真实发送。不要通过 `callbackUrl` 配置飞书 Webhook；发送器只在进程内从 Secret 环境变量或 secret 文件读取它，避免写入 outbox 数据库。

上线顺序应为 `disabled -> dry-run -> live`。进入 `live` 前必须配置 Webhook 和 `AUDIT_AGENT_FEISHU_LIVE_CONFIRM=CONFIRM_FEISHU_LIVE`。即时消息只发送 high/critical，并按 `agent_id + trace_id` 隔离；日报按北京时间 10:00、17:00 发送。发送器将持续速率限制在低于 100 次/分钟，同时满足 5 次/秒限制。

从 `live` 切换到 `dry-run` 或 `disabled` 时，已有 pending 飞书消息会保留原状态，不发送、不增加尝试次数；恢复 `live` 后继续投递。

外部通知中的 Dashboard 链接由 `auditReview.visualization.baseUrl` 与 `auditReview.visualization.dashboardPath` 生成。将 `auditReview.visualization.baseUrl` 设置为实际的 `https://<域名>`，否则回调会包含错误的容器内或本地地址。

## 7. 升级、备份与恢复

升级前先确认当前服务健康、部署变量仍存在，再触发 Dokploy 拉取新提交并重建。`/app/data` 挂载的 `audit-logger-data` 必须复用，不能在升级时新建空卷。

备份步骤：

1. 在 Dokploy 停止应用，确保 SQLite 不再写入。
2. 备份整个 `audit-logger-data` Volume（包括数据库、`-wal` 和 `-shm` 文件以及 spool），而不是只复制 `audit.db`。
3. 将备份保存到受控、加密的位置，并记录对应部署版本与时间。

恢复步骤：

1. 停止应用。
2. 使用备份恢复 `audit-logger-data` Volume 到 `/app/data`，保留目录结构和文件权限。
3. 启动应用，检查 `/health` 的 `db.writable`，再通过 Dashboard 或 `/query` 抽查数据。

恢复或迁移时不要同时运行两个挂载同一 SQLite Volume 的应用实例。
