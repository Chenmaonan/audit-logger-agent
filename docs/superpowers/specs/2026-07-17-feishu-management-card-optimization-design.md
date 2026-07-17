# 飞书管理层审计卡片优化设计

日期：2026-07-17

状态：已确认，待实施

目标读者：管理层与业务负责人

## 1. 背景

当前飞书通知已经具备 high/critical 风险门槛、`review_id` 批次边界、`agent_id + trace_id` 隔离、折叠、分片、日报调度和安全投递能力，但卡片仍偏向技术信息罗列：Agent ID、Trace ID、原始时间和明细占据较高视觉优先级，管理层需要先理解技术上下文才能判断业务影响。

本次优化只调整卡片的信息架构、文案、颜色、折叠层级和视觉验收流程，不改变风险检测、分组、调度、outbox、重试、安全门或数据库结构。

## 2. 已确认的产品决策

- 主要读者是管理层和业务负责人。
- 卡片只提供结论和 Dashboard 跳转，不提供审批、确认或其他写操作。
- 采用“保守改良”方案：即时告警和日报继续按 `agent_id + trace_id` 独立发送。
- 日报允许存在管理统计信息，但本次不新增跨 Agent/Trace 的管理总览卡。
- 风险告警统一使用橙色标题栏。
- 日报统一使用蓝色标题栏。
- 完全取消红色标题方案。
- 严重与高风险通过文字标签、深浅橙层级和信息排序区分，不能只依赖颜色。

## 3. 目标与非目标

### 3.1 目标

1. 管理层在 3 秒内识别总体结论、严重程度和主要影响。
2. 不展开卡片即可看到关键数字、首要风险和其他 Top 风险。
3. 展开后仍能查看本批次全部风险名称与摘要。
4. 日报明确区分风险发现与工具统计。
5. 桌面端和移动端保持可读，无横向滚动或异常截断。
6. 保持现有安全、隔离、去重、重试和限流语义不变。

### 3.2 非目标

- 不新增飞书审批、确认、表单或回调动作。
- 不修改风险等级判断逻辑。
- 不合并不同 `agent_id + trace_id` 的具体风险明细。
- 不新增数据库表或迁移字段。
- 不实现飞书签名校验。
- 不在卡片中展示 evidence、raw JSON、Prompt、错误堆栈或模型内部推理。
- 不重新设计 Dashboard。

## 4. 设计原则

1. **结论优先**：先说明发生了什么和影响，再展示技术身份。
2. **首屏有界**：首屏最多展示 3 条风险，不堆叠完整明细。
3. **信息完整**：所有风险名称与摘要保留在折叠区或同组分片中。
4. **颜色克制**：橙色只表达风险提醒，蓝色只表达日报与信息汇总。
5. **文字兜底**：严重程度必须同时用“严重”“高风险”等文字表达。
6. **技术字段降级**：Agent ID、Trace ID、批次 ID 和原始时间使用辅助字号。
7. **安全不回退**：视觉优化不能引入 Webhook、原始证据或敏感上下文泄露。

## 5. 卡片模式

### 5.1 即时风险告警

模式：`alert_card`

意图：warn

主色：橙色

唯一主操作：`查看审计详情`

#### 信息顺序

1. 标题与业务链路名称。
2. 一句话结论。
3. 三个关键数字。
4. 首要风险名称与影响摘要。
5. 其他 Top 2 风险名称。
6. 全量风险折叠区。
7. 北京时间、批次和技术身份。
8. Dashboard 按钮。

#### 标题规则

- 存在 critical：`严重审计风险`
- 仅存在 high：`高风险审计告警`
- 标题栏始终为橙色，不因 critical 切换为红色。

#### 一句话结论

格式：

> `<Agent 显示名称>` 的 `<业务链路或 Trace 展示名称>` 发现 `<风险总数>` 条高风险，其中 `<严重数>` 条严重，需要查看影响范围。

如果严重数为 0：

> `<Agent 显示名称>` 的 `<业务链路或 Trace 展示名称>` 发现 `<风险总数>` 条高风险，建议查看具体影响。

#### 关键数字

- 高风险总数
- 严重风险数
- 审查窗口，例如 `30m`

#### 风险展示

- 首要风险展示等级、名称和最多两行影响摘要。
- 第二、三条风险只展示等级和名称。
- critical 排在 high 前；同等级按最新出现时间排序。
- 首屏不足 3 条时不填充空项。

#### 折叠区

标题：`全部风险名称与摘要（N 项）`

每一项包含：

- 明确的文字等级标签；
- 完整风险名称；
- 摘要；
- 必要时的分段序号。

折叠区不包含 evidence、raw JSON、错误堆栈、完整工具响应或隐藏推理。

### 5.2 Agent + Trace 日报

模式：`ops_dashboard_card`

意图：report

主色：蓝色

唯一主操作：`查看完整日报`

#### 信息顺序

1. 日报标题、Agent 显示名称与业务链路。
2. 总体判断。
3. 四个关键数字。
4. Top 3 风险名称。
5. 高风险明细折叠区。
6. 工具调用统计折叠区。
7. 统计范围与技术身份。
8. Dashboard 按钮。

#### 总体判断

- 无 high/critical：`今日未发现高风险，整体运行正常。`
- 存在 high：`存在高风险，建议关注相关业务链路。`
- 存在 critical：`存在严重风险，需要查看影响范围。`

总体判断可以补充主要异常类型，但不得生成无证据的业务影响结论。

#### 关键数字

- 事件数
- 异常事件数
- 涉及工具数
- 高风险发现数

#### 风险与工具分区

- 高风险存在时，首屏展示 Top 3 风险名称。
- 无高风险时，不显示风险列表和风险折叠区。
- `高风险名称与摘要` 与 `工具调用统计` 使用两个独立折叠区。
- 工具统计按异常次数降序，再按调用次数降序排序。

## 6. 颜色与视觉语义

| 用途 | 颜色意图 | 说明 |
| --- | --- | --- |
| 风险告警标题 | 橙色 | 表达需要关注，不使用红色标题 |
| 日报标题 | 蓝色 | 表达信息汇总，不随风险变化 |
| 严重标签 | 深橙 | 必须同时显示“严重”文字 |
| 高风险标签 | 浅黄或浅橙 | 必须同时显示“高风险”文字 |
| 元数据 | 灰色 | 时间、ID、批次等辅助信息 |
| Dashboard 按钮 | 飞书默认蓝色 | 卡片内唯一主操作 |

视觉约束：

- 一张卡片只允许一种标题主色。
- 不使用红色标题、红色大段文字或装饰性色块。
- 不使用 Emoji 表达风险。
- 不给所有数字加颜色。
- 风险等级不能只靠色差识别。

## 7. 字段与文案规则

### 7.1 Agent 与 Trace

- 优先展示配置中的 Agent 显示名称。
- Agent ID 放入辅助信息；过长时缩短展示。
- Trace 优先使用可读业务链路名称；没有名称时显示缩短的 Trace ID。
- 分组、去重和 Dashboard 查询仍使用完整原始 ID，显示缩短不改变业务键。
- 任一身份字段缺失时继续按 Finding 隔离，并显示 `身份信息缺失`。

### 7.2 时间

- 所有用户可见时间转换为 `Asia/Shanghai`。
- 告警示例：`北京时间 7 月 17 日 17:00–17:30`。
- 日报示例：`统计范围：7 月 17 日 00:00–17:00 · 北京时间`。
- 不在首屏展示原始 ISO 时间。

### 7.3 摘要

- 首要风险摘要最多两行。
- 摘要必须描述对象、行为和已知影响；没有影响证据时不得推断。
- 缺少摘要时显示：`暂无影响摘要，请进入 Dashboard 查看详情。`
- 风险名称不得因布局被静默删除。

### 7.4 技术实现文案

禁止在业务卡片中出现：

- “通过 Webhook 推送”；
- “自定义服务消息”；
- JSON、HTTP、outbox 等实现说明；
- 连通性测试或 canary 文案。

## 8. 长内容与分片

- 继续使用 19 KiB 默认安全阈值，低于飞书自定义机器人 20 KiB 上限。
- 超限时只能在同一 `agent_id + trace_id` 内分片。
- 分片标题显示 `（1/N）`。
- 每个分片重复展示 Agent、Trace、总风险数、严重数和时间范围。
- 风险名称保持完整；长摘要按自然句或合理边界拆分。
- 分片不得跨 Agent、Trace 或审查批次。

## 9. 降级与错误处理

- 无 high/critical 时不生成即时告警。
- Dashboard URL 缺失或非法时隐藏按钮，不生成不可点击控件。
- 卡片构建失败时不发送残缺卡片，outbox 保持可重试状态并记录脱敏错误。
- `disabled` 和 `dry-run` 不消费既有 pending 飞书消息。
- 不因显示名称、摘要或业务链路名称缺失而合并身份不同的风险。
- 日报无工具记录时隐藏工具折叠区。
- 所有回退文案使用简体中文。

## 10. 组件边界

### 风险告警

- Header：橙色标题、业务身份副标题。
- Conclusion：普通文本或 Markdown，一句话。
- Metrics：三项关键数字区域。
- Primary Risk：浅橙背景或橙色边界，含等级、名称和摘要。
- Other Risks：最多两行名称列表。
- Details：一个风险明细折叠区。
- Metadata：灰色小字号。
- Action：一个 Dashboard 按钮。

### 日报

- Header：蓝色标题、业务身份副标题。
- Conclusion：总体判断。
- Metrics：四项关键数字区域。
- Top Risks：最多三条风险名称。
- Risk Details：独立折叠区。
- Tool Statistics：独立折叠区。
- Metadata：灰色小字号。
- Action：一个 Dashboard 按钮。

本节是设计约束，不是可发送的飞书 JSON 或字段级实现协议。

## 11. 实施范围

### 11.1 `src/auditReview/feishuCards.js`

- 将告警标题色固定为橙色、日报固定为蓝色。
- 增加管理层结论、关键数字、Top 3 风险和独立折叠区。
- 增加北京时间和缩短 ID 的展示函数。
- 保留文本中和、折叠、分片和字节限制。

### 11.2 `src/auditReview/notification.js`

- 向 renderer 传入 Agent 显示名称。
- 保持审查批次、Agent、Trace、去重键和 outbox 行为不变。

### 11.3 `src/auditReview/notificationDigestScheduler.js`

- 生成日报总体判断所需数据。
- 工具统计按异常次数排序。
- 传递 Agent 显示名称和北京时间统计范围。
- 保持 10:00、17:00 调度不变。

### 11.4 配置与文档

- 不新增无必要的颜色配置或任意模板 DSL。
- 继续使用现有 `maxPayloadBytes` 和 `foldThresholdChars`。
- 更新飞书通知设计和部署说明中的视觉规则。

## 12. 测试矩阵

### 12.1 单元测试

- critical/high 排序。
- 首屏最多 3 条风险。
- 折叠区包含全部名称与摘要。
- 告警标题不出现红色模板。
- 日报始终使用蓝色标题。
- 日报风险与工具分别折叠。
- 无风险时隐藏风险模块。
- 缺失摘要、显示名称、Agent 或 Trace 时正确降级。
- 北京时间和跨日边界。
- 长 ID 只影响显示，不影响分组键。
- 19 KiB 分片和每片上下文。
- 敏感字段排除。

### 12.2 回归测试

- notifier 仍按 `review_id`、Agent、Trace 隔离。
- 日报 10:00、17:00 调度不变。
- outbox 去重、重试、dead-letter 和安全门不变。
- callback 发送模式不受影响。
- 完整非 external 测试通过。

### 12.3 Docker 测试

- 使用最新工作树构建镜像。
- 在 `--network none` 下运行完整测试。
- 启动生产入口并验证 `/health` 返回 200。
- 验证测试镜像、环境和文件不包含真实 Webhook。
- 测试后清理临时镜像、容器和卷。

## 13. 真实客户端预览

实现完成后，先向私有非生产测试 Bot 发送完全虚构的数据，不使用真实业务身份或日志。

必须覆盖：

1. 单条 high。
2. high 与 critical 混合。
3. 超长折叠和多分片。
4. 有风险日报。
5. 无风险日报。

需要保留以下视觉证据：

- 飞书桌面端正常宽度截图；
- 飞书移动端截图；
- 折叠状态；
- 展开状态；
- 多分片顺序；
- 无风险日报状态。

预览中不得包含真实 Webhook、用户 ID、租户 ID、生产业务 ID 或可执行回调。

## 14. 验收标准

- 3 秒内能识别总体结论和是否需要关注。
- 首屏能看到首要风险和关键数字。
- 首屏最多显示 3 条风险。
- 展开后全部名称与摘要完整可读。
- 风险告警标题为橙色，日报标题为蓝色。
- 不出现红色标题方案。
- 不依赖颜色也能区分严重与高风险。
- 风险与工具统计层级清晰。
- 手机端无横向滚动、异常截断或按钮换行。
- Dashboard 按钮是唯一主操作。
- Agent、Trace、批次和时间可追溯但不抢占首屏。
- 没有敏感字段或实现文案泄露。

真实客户端视觉验收结论必须基于截图或录屏，不能仅根据 JSON、源码或单元测试宣称通过。

## 15. 上线顺序

1. 完成 renderer 和数据传递调整。
2. 运行定向与完整测试。
3. 使用 `dry-run` 检查代表性载荷。
4. 完成断网 Docker 测试和健康检查。
5. 向私有测试 Bot 发送虚构预览。
6. 完成桌面端、移动端、折叠和展开状态验收。
7. 视觉验收通过后启用正式发送。

## 16. 回滚

- 回滚范围只包括 renderer、通知参数、文档和对应测试。
- 不需要回滚数据库或清理 outbox。
- 将 `AUDIT_AGENT_FEISHU_MODE` 切换为 `disabled` 可立即停止真实发送。
- pending 消息在非 live 模式保持原状态，恢复 live 后继续投递。

## 17. Structured Decision

```text
card_intent:
- data_type: alert/status + daily operational report
- intent: warn + report
- audience: management and business owners
- interaction: read conclusion, open Dashboard

card_pattern:
- alert: alert_card
- daily: ops_dashboard_card
- selected_approach: conservative refinement

information_architecture:
- first_screen: conclusion, key metrics, primary risk, Top risks
- details: complete risk summaries and tool statistics in separate folds
- metadata: Beijing time, shortened identity, batch reference

visual_rules:
- alert_header: orange
- daily_header: blue
- red_header: forbidden
- severity: explicit text tags plus orange/yellow hierarchy

responsive_behavior:
- bounded first screen
- no wide table
- mobile vertical stacking
- long details folded or split

preview_verdict:
- current_status: design approved, implementation pending
- visual_acceptance: requires real desktop/mobile preview after implementation
```
