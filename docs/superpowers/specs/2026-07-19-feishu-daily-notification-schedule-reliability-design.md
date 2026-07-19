# 飞书日报定时发送可靠性修复设计

日期：2026-07-19

状态：已确认，待实施

## 1. 背景

系统规定在北京时间每天 10:00、17:00 生成并发送飞书累计日报。当前服务器和容器返回 UTC 时间，业务人员按北京时间阅读时会看到 8 小时显示差异；这不是服务器时钟偏移。线上 `/health` 实测服务器与客户端时钟差约 1.2 秒，现有调度器也已使用 `timezoneOffsetMinutes = 480` 将北京时间映射为 UTC：

- 北京时间 10:00 对应 UTC 02:00。
- 北京时间 17:00 对应 UTC 09:00。

现有问题不是时区换算，而是调度和投递状态只存在于进程内：

- 服务在 10:00 整启动时，会直接安排 17:00。
- 服务在 10:00 后重启时，不会补发已错过的 10:00 日报。
- 进程挂起跨过多个时段时，可能执行旧时段并漏掉更新的累计时段。
- 无数据时不会生成 Outbox 记录，无法证明该时段已经执行。
- 多个服务实例可能并行执行调度或同时读取同一 Outbox 事件。
- 日报与普通消息共用 FIFO Outbox，积压可能推迟日报送达。
- 公开 `/health` 无法确认飞书是否处于 live、下一次运行时间和实际送达延迟。

本设计修复上述可靠性问题，不通过修改服务器时区、容器 `TZ` 或给时间戳手工增加 8 小时处理。

## 2. 已确认决策

- 采用持久化日报时段状态和 Outbox 投递租约的完整方案。
- 业务时区继续使用固定 UTC+8，配置值为 `480` 分钟。
- 日报时段继续为北京时间 10:00、17:00。
- 默认补发窗口为 30 分钟。
- 错过多个累计时段时只处理最新时段。
- 无审计数据时记录 `empty`，不发送空卡片。
- 日报优先于普通 Outbox 消息。
- `/health` 只暴露非秘密状态，不暴露 Webhook、Token、payload 或错误原文。
- “准时”以日报入队和首张卡片送达为主要指标，不要求受飞书限流约束的所有分片在同一秒到达。

## 3. 目标与非目标

### 3.1 目标

1. 正常运行时在北京时间 10:00、17:00 执行对应日报时段。
2. 整点启动或整点后 30 分钟内恢复时能够补发，不静默漏掉。
3. 超过补发窗口时记录 `skipped_late`，不发送失去时效的旧日报。
4. 多实例共享数据库时，同一时段只由一个实例执行。
5. 多个 Publisher 共享数据库时，同一 Outbox 事件只由一个有效 claim 投递。
6. 无数据时段也有持久化执行状态。
7. 日报入队后优先投递，并立即触发一次 flush。
8. 通过 `/health` 判断生产是否真的会发送、下一次发送时间及实际延迟。
9. 旧数据库自动迁移，现有 Outbox 数据和 dedupe 语义不受破坏。

### 3.2 非目标

- 不修改风险检测、Finding 分组或飞书卡片内容。
- 不手工调整服务器时钟，不依赖容器 `TZ`。
- 不新增外部 Cron 或 Dokploy 定时调用接口。
- 不发送固定的“无数据心跳卡”。
- 不在公开接口中暴露 Webhook、Secret 文件路径、live confirmation 或 payload。
- 不承诺 Webhook 的 exactly-once。飞书已接收而进程尚未标记 delivered 时崩溃，仍可能产生极低概率重复。

## 4. 时间与发送语义

### 4.1 时间基准

- 数据库存储和内部绝对时间继续使用 UTC ISO 8601。
- 日报时段通过 UTC+8 固定偏移计算。
- 健康状态同时返回 UTC 和 `+08:00` 表示的本地时刻。
- 当前实现不是通用 IANA 时区引擎，健康状态应描述为 `UTC+08:00`，不能声称支持任意 `Asia/Shanghai` 历史规则。

### 4.2 补发规则

- 调度器启动时先执行时段协调，再安排下一个定时器。
- 定时器唤醒时按实际当前时间重新计算应执行时段，不直接执行闭包捕获的旧时段。
- 当前时间落在某时段之后 30 分钟内时，该时段可补发。
- 当前时间超过补发窗口时，将最新错过时段记录为 `skipped_late`。
- 如果同时错过 10:00 和 17:00，只处理最新的 17:00，因为 17:00 日报已累计覆盖当天 00:00 至 17:00。
- 补发日报的查询窗口上限仍为规定时刻。例如 10:10 补发时，统计结束时间仍是 10:00。

### 4.3 dry-run 与 live

- `disabled` 不执行时段、不发送。
- `dry-run` 可以显式调用渲染，但不占用 live 时段、不写正式完成状态、不消费 pending 消息。
- `live` 才能 claim 正式时段并写入 Outbox。
- 从 `disabled` 或 `dry-run` 切换到 `live` 前，部署流程必须检查历史 pending，避免集中发送旧消息。

## 5. 持久化时段状态

新增表 `audit_notification_digest_slots`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `slot_key` | TEXT PRIMARY KEY | `daily:YYYY-MM-DD:HH` |
| `report_date` | TEXT NOT NULL | UTC+8 本地日期 |
| `slot_hour` | INTEGER NOT NULL | 10 或 17 |
| `scheduled_for` | TEXT NOT NULL | 规定时刻的 UTC ISO 时间 |
| `timezone_offset_minutes` | INTEGER NOT NULL | 当前为 480 |
| `status` | TEXT NOT NULL | `running`、`enqueued`、`empty`、`skipped_late`、`failed` |
| `attempts` | INTEGER NOT NULL | 执行尝试次数 |
| `enqueued_count` | INTEGER NOT NULL | 成功新增的 Outbox 数量 |
| `owner_id` | TEXT | 当前租约持有者 |
| `lease_expires_at` | TEXT | 租约到期时间 |
| `started_at` | TEXT | 本轮开始时间 |
| `completed_at` | TEXT | 完成、空或跳过时间 |
| `last_error` | TEXT | 内部诊断使用，不进入公开健康响应 |

### 5.1 claim 规则

1. 使用数据库事务插入或 claim `slot_key`。
2. 已完成的 `enqueued`、`empty`、`skipped_late` 不重复执行。
3. `running` 且租约未过期时，其他实例跳过。
4. `running` 租约过期或 `failed` 时允许重新 claim，并增加 `attempts`。
5. 执行结果按实际情况更新为 `enqueued`、`empty`、`skipped_late` 或 `failed`。

唯一键和租约保证同一时段只有一个正常执行者。日报分片继续使用现有 dedupe key，处理入队中途崩溃后的缺失分片补齐。

## 6. 调度器结构

`notificationDigestScheduler` 新增以下职责：

```js
scheduler.reconcileDueSlot({ at })
scheduler.getHealthStatus()
```

主要流程：

```text
start
  -> reconcileDueSlot(now)
  -> scheduleNext(now)

timer wakes
  -> reconcileDueSlot(actual now)
  -> scheduleNext(actual now)

reconcileDueSlot
  -> 计算最新应执行时段
  -> 判断补发窗口
  -> claim 时段
  -> 查询规定窗口内数据
  -> 无数据：标记 empty
  -> 有数据：构建卡片并以高优先级入队
  -> 标记 enqueued
  -> 触发一次 Outbox flush
```

调度器内部继续串行执行 `runChain`，数据库租约负责跨实例互斥。

## 7. Outbox 投递租约与优先级

在 `agent_outbox_events` 增加：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `priority` | INTEGER NOT NULL DEFAULT 0 | 日报使用高于普通消息的值 |
| `claim_owner` | TEXT | Publisher 实例 ID |
| `claim_token` | TEXT | 单次 claim 随机 Token |
| `claim_expires_at` | TEXT | claim 租约到期时间 |

Outbox API 调整：

```js
outboxStore.claimPending(limit, { ownerId, leaseMs, now })
outboxStore.markDelivered(eventId, claimToken)
outboxStore.markFailed(eventId, error, claimToken)
```

规则：

- 只 claim 已到重试时间且未被 claim，或 claim 已过期的 pending 事件。
- 排序为 `priority DESC, created_at ASC`。
- `markDelivered` 和 `markFailed` 必须匹配当前 claim token。
- 旧 claim token 不能覆盖新 claim 的结果。
- Publisher 崩溃后，租约过期的消息可以恢复投递。
- 日报入队使用高优先级，普通事件保持默认优先级。

飞书自定义 Webhook 不提供业务幂等键，因此系统维持 at-least-once 语义。

## 8. 健康状态与日志

公开 `/health` 新增 `notification_digest`：

```json
{
  "feishu_mode": "live",
  "configured_enabled": true,
  "scheduler_started": true,
  "active": true,
  "timezone": "UTC+08:00",
  "timezone_offset_minutes": 480,
  "schedule_hours": [10, 17],
  "catch_up_window_minutes": 30,
  "next_run_at_utc": "2026-07-20T02:00:00.000Z",
  "next_run_at_local": "2026-07-20T10:00:00+08:00",
  "last_slot": {
    "slot_key": "daily:2026-07-19:17",
    "status": "enqueued",
    "scheduled_for": "2026-07-19T09:00:00.000Z",
    "enqueued_count": 3,
    "completed_at": "2026-07-19T09:00:00.200Z"
  },
  "last_enqueued_at": "2026-07-19T09:00:00.180Z",
  "last_delivered_at": "2026-07-19T09:00:02.150Z",
  "delivery_lag_ms": 2150
}
```

约束：

- `active = scheduler_started && configured_enabled && feishu_mode === 'live'`。
- inactive 时 `next_run_at_utc` 和 `next_run_at_local` 返回 `null`。
- `delivery_lag_ms` 表示同一日报批次最后一张卡的 `delivered_at - scheduled_for`。
- 无历史时，最后时段和投递时间字段返回 `null`。
- 数据库查询失败时相关字段返回 `null`，不把 SQL 或错误原文返回给公开接口。
- 响应不得包含 Webhook、Token、secret 文件路径、live confirmation、payload、callback URL 或 `last_error`。

启动日志输出：

- 当前 UTC。
- 当前 UTC+8 时间。
- 飞书模式和调度是否 active。
- 下一次 UTC 和 UTC+8 运行时间。
- 启动协调结果，包括正常、补发、空时段或超时跳过。

## 9. 配置

在 `auditReview.notification.dailyReport` 增加：

```json
{
  "enabled": true,
  "hours": [10, 17],
  "timezoneOffsetMinutes": 480,
  "catchUpWindowMinutes": 30
}
```

配置校验要求：

- `hours` 至少包含一个 0—23 的整数。
- `timezoneOffsetMinutes` 必须是合法分钟偏移。
- `catchUpWindowMinutes` 必须是非负有限整数。
- 生产未配置 `AUDIT_AGENT_FEISHU_MODE=live` 时，健康状态明确显示 inactive，不自动提升模式。

## 10. 错误处理

- 时段 claim 失败：不执行，下一次协调重试。
- 构建或入队失败：时段标记 `failed`，保留内部错误，租约释放。
- 部分分片入队后失败：重试时依赖分片 dedupe key 跳过已有项并补齐缺失项。
- flush 失败：Outbox 保持 pending，使用原重试和 dead-letter 机制。
- 送达失败：根据 claim token 更新重试时间；超过最大次数进入 dead letter。
- 健康状态查询失败：核心 `/health` 仍按数据库可写性决定 HTTP 200/503，通知扩展字段降级为 null。

## 11. 数据库迁移与兼容性

- 使用现有 guarded migration 模式为旧 Outbox 增加字段。
- 旧 Outbox 行的 `priority` 默认为 0，claim 字段为空。
- 保留现有 dedupe key 唯一索引。
- 新建日报时段表和必要索引，不修改既有日报 payload。
- 旧调用 `listPending` 如仍有测试或兼容需要，可以保留为只读兼容接口；正式 Publisher 切换到 `claimPending`。
- 迁移必须在单个启动流程中完成，旧数据库启动后无需人工操作。

## 12. 测试策略

### 12.1 调度器

- 09:59 启动，10:00 正常执行。
- 10:00:00 整启动，执行 10:00。
- 10:01 重启，在补发窗口内执行 10:00。
- 10:31 重启，记录 `skipped_late`，不发送。
- 进程从 09:59 挂起到 17:10，只处理 17:00。
- 两个调度实例共享数据库，只有一个取得时段租约。
- 租约过期后可恢复。
- 无数据时记录 `empty`，重启不重复执行。
- dry-run 不写正式完成状态。
- UTC、Asia/Shanghai、America/Los_Angeles 宿主时区结果一致。

### 12.2 Outbox

- 日报优先于普通 pending 消息。
- 两个 Publisher 不能同时 claim 同一事件。
- claim 过期后可恢复。
- 旧 claim token 不能标记新 claim 为 delivered/failed。
- 失败重试和 dead-letter 行为保持兼容。
- 旧数据库迁移后现有行可正常 claim。

### 12.3 健康状态

- live + started 时 active 为 true，下一次 UTC 和 UTC+8 正确。
- disabled、dry-run 或未启动时 active 为 false。
- 只统计 `audit_daily_trace_report` + `feishu_bot`。
- 最后时段、入队、整批送达及延迟准确。
- 无历史或缺表时安全降级。
- 序列化结果不包含任何秘密或 payload。

### 12.4 集成与回归

- 执行最快相关测试。
- 执行完整离线测试套件。
- 检查 `git diff --check`。
- 不执行真实飞书发送；真实客户端验收需使用私有非生产 Bot 和虚构数据，并另行获得明确确认。

## 13. Docker 与线上验收

### 13.1 Docker

1. 使用独立 Compose 项目名和独立 Volume。
2. 使用 `disabled` 或 `dry-run`，不注入真实 Webhook。
3. 验证容器 healthy、数据库可写。
4. 验证 `/health.notification_digest` 的 UTC、UTC+8 和下一次时段。
5. 复用同一 Volume 重启容器，验证时段状态保持且不重复入队。
6. 验证镜像、日志、配置和健康响应不含 Webhook。
7. 清理本次测试容器、网络、Volume 和镜像。

### 13.2 线上只读验证

1. 确认健康状态显示 `feishu_mode=live`、`active=true`。
2. 确认下一次运行同时对应 UTC 02:00/09:00 和 UTC+8 10:00/17:00。
3. 发送时点前后读取健康状态，确认时段状态、入队和送达时间更新。
4. 确认首张卡片送达 SLA、整批延迟和 dead-letter。
5. 确认 Dokploy 宿主 NTP/chrony 正常，时钟漂移小于 2 秒。

线上只读验证不能替代真实飞书客户端验收。

## 14. SLA 与验收标准

- 规定时刻：北京时间 10:00、17:00。
- 正常无积压时，日报 Outbox 应在规定时刻后 2 秒内完成入队。
- 正常无积压、网络可用时，首张卡片应在规定时刻后 10 秒内送达。
- 整批送达允许时间为 `650ms × 卡片数量 + 网络耗时 + 少量调度开销`。
- 30 分钟内恢复时补发；超过窗口记录 `skipped_late`。
- 同一时段正常情况下只存在一组幂等 Outbox 事件。
- `/health` 能解释未发送原因：disabled、dry-run、未启动、empty、skipped_late、failed、pending 或 dead letter。

## 15. 预计修改范围

主要代码：

- `src/auditReview/notificationDigestScheduler.js`
- `src/db/reviewSchema.js`
- `src/db/runtimeSchema.js`
- `src/agent/outboxStore.js`
- `src/agent/eventPublisher.js`
- `src/adapters/http/app.js`
- `scripts/server.js`

配置与文档：

- `config.json`
- `config.container.json`
- `README.md`
- `docs/feishu-bot-notification-design.md`
- `docs/dokploy-deployment.md`

测试：

- `test/auditReview/notificationDigestScheduler.test.js`
- `test/runtime/outbox.test.js`
- `test/http/health.test.js`
- `test/http/server-entrypoint.test.js`
- 必要的 schema 迁移测试。

## 16. 回滚

- 代码回滚到修复前提交并重新部署。
- 新增表和字段保持向后兼容，旧代码会忽略它们，不需要破坏性数据库回滚。
- 若新调度器异常，可先将 `AUDIT_AGENT_FEISHU_MODE` 切换为 `disabled` 停止真实发送，再回滚应用版本。
- 不删除历史时段和 Outbox 数据，避免丢失审计证据。

