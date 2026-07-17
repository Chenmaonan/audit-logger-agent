# 飞书 Bot 审计通知方案

## 目标

- 即时消息只发送 `high` 和 `critical` 风险，以 `review_id` 作为审查批次。
- 仅在相同且非空的 `agent_id + trace_id` 内聚合，不同组合绝不合并；任一身份字段缺失时按 Finding 单独隔离。
- 每组包含本批次全部高风险发现的名称和摘要。
- 长内容使用飞书 JSON 2.0 `collapsible_panel`；超过自定义机器人 20 KB 限制时，在同组内分片。
- 北京时间每天 10:00、17:00 发送当天 00:00 至当前时刻的累计日报，每个 `agent_id + trace_id` 独立成卡。
- Webhook 不进入源码、卡片、日志或 SQLite outbox。

## 架构

```text
审查批次 / 日报查询
        │
        ▼
按 agent_id + trace_id 分组
        │
        ▼
确定性 Feishu Card Renderer
  - JSON 2.0
  - 高风险筛选
  - 文本中和与脱敏
  - 折叠 / 20 KB 分片
        │
        ▼
Outbox（只存 delivery_mode + payload + dedupe_key）
        │
        ▼
EventPublisher 按 delivery_mode 路由
        │
        ▼
FeishuBotClient（内存读取 Webhook）
```

`Lark-card-designer` 仅用于设计期确定信息层级、折叠规则和视觉语义。它不是 SDK，也不生成生产 JSON；运行期由项目内纯函数确定性渲染，保证可测试和可复现。

## 卡片设计

高风险告警采用 `alert_card`：首屏显示 Agent ID、Trace ID、风险数量、严重数量、首要风险和批次窗口；名称与摘要完整保留，超过 2 项或内容阈值时默认折叠。卡片不发送 evidence、raw_json、error_message、result_summary 等原始日志字段。

日报采用 `ops_dashboard_card`：首屏显示事件数、异常事件数、工具数和高风险发现数；工具调用统计及高风险名称/摘要放入明细区。统计窗口为北京时间当天 00:00 至 10:00 或 17:00，17:00 日报是当天累计版本。

## 安全门

发送模式为三态：

- `disabled`：不生成待发送 outbox 数据，不联网。
- `dry-run`：生成和校验卡片，但不写 pending outbox、不联网。
- `live`：必须同时提供 Webhook 和 `AUDIT_AGENT_FEISHU_LIVE_CONFIRM=CONFIRM_FEISHU_LIVE`。

Webhook 优先从 `AUDIT_AGENT_FEISHU_WEBHOOK_FILE` 读取，也可使用 `AUDIT_AGENT_FEISHU_WEBHOOK_URL`。生产 URL 必须是 `https://open.feishu.cn/open-apis/bot/v2/hook/<id>`，禁止重定向。发送器同时校验 HTTP 状态和飞书响应 `code === 0`。

用户提供的 Webhook 已出现在对话文本中，应在正式部署前轮换，并在飞书侧启用 IP 白名单或关键词安全策略。当前发送器未生成飞书签名字段，签名校验需在实现并验证签名支持后再启用。

## 幂等、重试和限流

- outbox 使用 `dedupe_key` 防止相同批次或日报时段重复入队。
- 失败沿用现有指数退避和 dead-letter。
- Feishu client 串行发送并控制在约 92 次/分钟，同时满足 5 次/秒限制。
- 日报由独立日历调度器计算北京时间下一次 10:00/17:00，不依赖容器宿主时区。
- `dry-run` 或 `disabled` 不消费既有 pending 飞书消息；恢复 `live` 后继续投递。

投递语义为 at-least-once：如果飞书已接收消息，但进程在 outbox 标记 delivered 前退出，重试可能产生重复卡片。自定义 Webhook 不提供客户端幂等键；卡片中的批次、Agent、Trace、统计时间可用于识别重复消息。

## 验证门

1. 单元测试：分组、风险门槛、折叠、分片、20 KB、文本中和、业务码、幂等、北京时间边界。
2. 本地全量非 external 测试。
3. Docker 断网测试和 mock transport 测试，确认无真实请求。
4. 检查镜像环境、历史层、日志和 SQLite，不得出现真实 Webhook。
5. 仅在以上全部通过后，执行一次不含业务数据的真实连通性 canary。

回滚只需将 `AUDIT_AGENT_FEISHU_MODE` 设为 `disabled`；数据库迁移仅新增可空幂等字段，不影响原 callback 消息。
