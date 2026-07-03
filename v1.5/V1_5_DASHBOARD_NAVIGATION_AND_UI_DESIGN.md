# v1.5 Dashboard Navigation And UI Design

## 1. 文档信息

- 版本：v1.5
- 日期：2026-07-03
- 范围：只产出设计，不修改代码、不新增接口实现
- 默认假设：总览页同时支持两条直达路径
  - 路径 A：总览 -> 审查批次详情
  - 路径 B：总览 -> 风险发现详情
- 约束前提：
  - 保留现有三条 HTML 路由：`/dashboard`、`/dashboard/audit-reviews/{reviewId}`、`/dashboard/audit-findings/{findingId}`
  - 保持服务端直出 HTML，不引入前端框架，不恢复浏览器端 `fetch()`
  - 延续 v1.5 已建立的中文 UI、direct-data view model 和模板渲染思路

## 2. 背景与问题定位

当前 Web Dashboard 已经具备三类页面：

- 总览页：`/dashboard`
- 审查批次详情页：`/dashboard/audit-reviews/{reviewId}`
- 风险发现详情页：`/dashboard/audit-findings/{findingId}`

路由本身已经存在，见 [README.md](/E:/工作空间/audit-logger-agent/README.md:150) 与 [app.js](/E:/工作空间/audit-logger-agent/src/adapters/http/app.js:210)。

### 2.1 根因

问题不在路由缺失，而在“view model + 模板”两层都没有把详情页入口暴露出来：

- `overviewPage()` 只输出纯文本表格行，没有任何 `href` 或可点击字段，见 [visualization.js](/E:/工作空间/audit-logger-agent/src/auditReview/visualization.js:127) 与 [visualization.js](/E:/工作空间/audit-logger-agent/src/auditReview/visualization.js:143)。
- `reviewDetailPage()` 同样只输出纯文本 finding 表格，无法继续钻取到 finding detail，见 [visualization.js](/E:/工作空间/audit-logger-agent/src/auditReview/visualization.js:214)。
- `renderTableSection()` 只会把 cell 内容转成纯文本 `<td>`，不支持链接、状态标签、二级说明或行级点击，见 [dashboardTemplate.js](/E:/工作空间/audit-logger-agent/src/auditReview/dashboardTemplate.js:75)。
- 当前唯一的页面间链接，出现在 finding detail 页底部的“关联审查批次”，见 [visualization.js](/E:/工作空间/audit-logger-agent/src/auditReview/visualization.js:337)。

### 2.2 真实运行页面验证

2026-07-03 在本地运行中的页面 `http://127.0.0.1:9320/dashboard` 上，实际观察到：

- 总览页已渲染“最新风险发现”和“最近审查批次”两张主表，但所有行都不可点击。
- 最近审查批次里有 9 行，其中 5 行 `finding_count = 0`，噪音较高，真正有风险的批次没有被优先强调。
- review detail 页的 “Top 风险发现” 表同样不可点击，导致链路在第二层再次中断。
- finding detail 页只有“回到审查批次”的单条 link list，没有“回到总览”的直接路径，也没有 breadcrumb。
- 当前视觉层仍然偏通用占位模板：
  - 默认系统字体
  - 同质化卡片
  - 无页面层级导航
  - 表格无 hover / active / focus 状态
  - 宽表在移动端没有明确策略

### 2.3 真实体验问题

这会导致用户虽然“看见了数据”，但无法顺手完成最关键的两步：

1. 从总览快速进入某一批次，判断本轮审查是否值得看。
2. 从总览或批次页直接进入某条 finding，查看证据与建议处置。

因此当前问题本质上是信息架构和交互 affordance 不足，不是后端能力不足。

## 3. 设计目标

### 3.1 必须达成

- 用户在总览页 1 次点击进入任一 review detail。
- 用户在总览页 1 次点击进入任一 finding detail。
- 用户在 review detail 页 1 次点击进入任一 finding detail。
- 用户在 finding detail 页 1 次点击返回 review detail，1 次点击返回 overview。
- 总览页优先呈现“可处理对象”，而不是把零发现批次与有效风险混排。
- 保持 server-rendered、无浏览器端数据拼装。

### 3.2 UI/UX 目标

- 从“静态表格页”升级为“审查工作台”。
- 保持严肃、可信、可扫描的审计产品气质，不做大屏化炫技。
- 让高风险、待处理、降级完成等状态在 3 秒内被识别。
- 对中文主界面与英文 finding 内容的混合场景保持良好排版。

### 3.3 非目标

- 本轮不新增第四类详情页。
- 本轮不设计写操作流，如 `acknowledge`、`resolve`、`snooze`。
- 本轮不引入复杂图表或实时动画。
- 本轮不调整鉴权、API contract、审查逻辑。

## 4. 方案对比

### 方案 A：最小修补型导航

做法：

- 仅给 overview / review detail 表格第一列加链接
- 增加 breadcrumb 与返回链接
- 保持现有版式基本不变

优点：

- 范围最小
- 易落地
- 对现有模板改动最少

缺点：

- 只能“修通链路”，不能解决信息优先级和页面拥挤问题
- 零发现批次依然和高价值批次混排
- UI 仍然像通用报表页，不像审查工作台

适用性：

- 适合作为紧急热修，不适合作为 v1.5 设计目标

### 方案 B：审查工作台型重构

做法：

- 保留三页结构，但重排总览信息架构
- 同时提供“按批次钻取”和“按 finding 钻取”两条路径
- 增加 breadcrumb、页面上下文标签、可点击 KPI、可点击表格主列、快速入口条
- 把“有发现批次”与“零发现批次”拆开呈现

优点：

- 解决导航断层
- 同时提升扫描效率和视觉秩序
- 与现有 direct-data、server-rendered 架构兼容
- 不需要引入前端状态管理

缺点：

- 需要扩展 view model 和模板组件能力
- 比方案 A 更需要统一样式语言

适用性：

- 最符合 v1.5：增量合理，收益最高

### 方案 C：Master-Detail 工作区

做法：

- overview 左侧为列表，右侧为内嵌 preview panel
- 减少页面跳转，更多内容留在单页完成

优点：

- 理论上 triage 效率最高
- 页面切换最少

缺点：

- 与当前无前端状态的模板架构不匹配
- 响应式成本高
- 无法优雅处理移动端
- 容易超出 v1.5 范围

适用性：

- 适合未来 v1.6+，不建议作为 v1.5 首选

### 推荐结论

推荐 **方案 B：审查工作台型重构**。

原因：

- 它不仅修复“点不进去”的问题，也顺带解决“看不清重点”的问题。
- 它仍然建立在现有三页、现有路由、现有 server-rendered 模板之上，不会把设计文档带向一个当前架构难以承接的方向。

## 5. 推荐设计方案

## 5.1 总体导航模型

新的导航层级定义为：

`总览页` -> `审查批次详情` -> `风险发现详情`

同时保留旁路：

`总览页` -> `风险发现详情`

每一层的返回关系：

- review detail 顶部提供 `总览 / 审查批次` breadcrumb
- finding detail 顶部提供 `总览 / 审查批次 / 风险发现` breadcrumb
- finding detail 同时保留显式的“返回总览”和“返回当前批次”

这会把当前“finding -> review”的单向回链，补成完整双向导航网。

## 5.2 总览页重构

### 页面结构

总览页从上到下分为 5 个区域：

1. 页面头部
2. 风险指标带
3. 快速入口条
4. 待处理风险发现
5. 审查批次分组列表

### 1. 页面头部

保留标题与更新时间，但补足上下文：

- 标题：`审计审查总览`
- 副标题：`最近审查、待处理风险与证据入口`
- 右侧上下文标签：
  - 最近运行状态
  - 当前开放 finding 总数
  - dead letter 计数

目的：

- 让用户在进入页面第一屏时，就知道“当前系统有无异常”和“页面是否值得继续下钻”

### 2. 风险指标带

保留现有 severity KPI，但改为“可操作指标”：

- 严重
- 高风险
- 中风险
- 低风险
- 投递失败

视觉规则：

- 数值仍为主视觉
- 标签改为上小下大的双层结构，避免当前“文本和数字同级”
- 每张卡可点击

交互规则：

- 点击严重/高/中/低风险卡：跳到“待处理风险发现”区域，并携带预设过滤上下文
- 点击投递失败卡：跳到 dead letter 提示区或既有排障入口

注：

- 本轮不要求真的做前端过滤器，但设计上应为后续 `?severity=high` 或锚点跳转预留空间

### 3. 快速入口条

新增一条紧贴 KPI 的“快速入口”模块，提供三个高优先入口：

- `进入最新有发现批次`
- `查看最高风险 finding`
- `查看最近一次降级完成批次`（仅在存在 `completed_degraded` 时显示）

这是最直接补齐“总览页没有渠道”的入口层，不依赖用户先理解两张表。

### 4. 待处理风险发现

把当前“最新风险发现”升级为“待处理风险发现”，并作为 overview 的主表。

建议字段：

- 标题
- 严重程度
- 类别
- Agent
- 工具
- 状态
- 所属审查批次
- 最近出现时间

交互规则：

- 标题列可点击，进入 finding detail
- 所属审查批次列可点击，进入 review detail
- 整行 hover 高亮，但真正可点击对象仍以标题和批次列为主，避免误触

排序规则：

- `severity desc`
- `status=open` 优先
- `last_seen_at desc`

这样 overview 将优先成为“处理风险”的入口，而不是简单的“最新数据 dump”。

### 5. 审查批次分组列表

当前“最近审查批次”建议拆成两个 section：

- `最近有发现的审查批次`
- `最近完成但无发现的批次`

原因：

- 真实运行页中零发现批次占比高，会把高价值批次往下挤
- 用户真正关心的是“哪几轮值得点进去”

建议字段：

- 审查批次 ID
- 状态
- 时间窗口
- 发现数
- 触发方式
- 完成时间

交互规则：

- 批次 ID 可点击
- 发现数字段可点击，并跳到 review detail 中的 findings 区域

## 5.3 审查批次详情页重构

### 页面目标

这页的核心任务不是展示 run metadata，而是回答：

- 这轮审查到底发现了什么
- 哪几条 finding 最值得进一步打开
- 本轮运行是否可信、是否降级、是否需要人工补看

### 页面结构

1. breadcrumb + 返回总览
2. 页面标题区
3. 批次指标带
4. 本批次 findings 表
5. 审查运行元数据
6. 异常说明 callout（按需显示）

### 标题区

标题建议从长时间戳串改为更易读的双层结构：

- 主标题：`审查批次`
- 副标题：`2026-07-03 16:35 - 16:49`
- 辅助标签：
  - `已完成 / 降级完成 / 失败`
  - `5 个发现`
  - `scheduled / manual`

目的：

- 降低长 ID 对视觉的压迫
- 把 ID 降级为辅助信息，保留在元数据区和 breadcrumb 中

### Findings 表

当前 “Top 风险发现” 改名为 `本批次风险发现`。

建议字段：

- 标题
- 严重程度
- 类别
- Agent
- 工具
- 状态
- 证据数

交互规则：

- 标题列进入 finding detail
- 若 evidence 数量 > 1，可显示数量标签，帮助用户判断是否值得优先打开

### 元数据区

把当前 definition list 收紧为“次信息”：

- 审查批次 ID
- 时间窗口
- 风险策略版本
- Prompt 版本
- Reviewer 版本
- LLM 模型
- 扫描文件数
- 候选事件数

展示方式：

- 仍可使用 definition list
- 但默认放在 findings 表之后

### 异常说明 callout

以下情况需要显式 callout：

- `status = completed_degraded`
- `error_code` 非空
- `finding_count = 0` 但用户是从 overview 的“最近批次”进入

callout 文案用于说明：

- 该轮是否可信
- 是否由降级逻辑生成
- 是否建议查看原始日志或下一轮复核

## 5.4 风险发现详情页重构

### 页面目标

finding detail 应该回答 3 个问题：

1. 为什么这条 finding 被判出来
2. 它关联哪个批次、哪个 agent、哪个工具
3. 证据日志具体是什么

### 页面结构

1. breadcrumb
2. finding 标题区
3. 判定摘要区
4. 基本信息区
5. 证据日志区
6. 关联链接区

### 标题区

保留 finding 原始标题，但增加中文系统上下文：

- 主标题：finding 原始标题
- 副标题：`风险发现`
- 顶部标签：
  - 严重程度
  - 类别
  - 状态
  - Agent
  - 工具

设计说明：

- 当前真实数据中 finding 标题和 recommendation 常含英文，不建议强行翻译
- 统一做法应是“系统 chrome 中文化，finding 内容保留原始语义”

### 判定摘要区

当前页面缺少对 `summary` 的强调，导致用户一上来就掉进元数据与证据表。

建议新增一个高亮 summary block，包含：

- `判定摘要`
- `建议处置`

其中：

- `summary` 用普通正文
- `recommendation` 用 callout 或强调块承载

这样用户可以先理解“结论”，再看证据。

### 基本信息区

保留 definition list，但调整顺序：

- Finding ID
- 审查批次 ID
- Agent 名称
- Agent ID
- 工具
- Trace ID
- 产品 ID
- 最近出现时间

设计规则：

- ID、Trace、时间用等宽字体
- 长值允许换行

### 证据日志区

证据表仍是核心，但需要更易扫读。

建议字段：

- 日志 ID
- 时间
- 事件
- 状态
- Agent 名称
- 工具
- 日志摘要
- 错误详情

优化点：

- 按时间升序或按证据相关性排序，避免随机顺序
- `error` 状态做强调标签，不只显示纯文本
- 对多条 evidence 的 finding，表头上方补一个简短说明：`共 N 条证据日志`

### 关联链接区

至少提供两个链接：

- `返回审查批次`
- `返回总览`

可选第三链接：

- `查看原始 trace 查询`

但该第三链接仅在已有稳定入口时才加入 v1.5 实现，不作为本设计的必须项。

## 6. 组件与 View Model 设计约束

本设计建议尽量沿用现有四类 section：

- `table`
- `definition_list`
- `link_list`
- `callout`

不建议为了这次设计引入过多新 section type。核心是扩展已有 section 的表达力。

### 6.1 页面级新增字段

建议在 `page` 或模板输入层增加：

- `breadcrumbs`
- `context_badges`
- `page_actions`

示意：

```js
page: {
  title: '审计审查总览',
  subtitle: '最近审查、待处理风险与证据入口',
  updated_at: '2026-07-03T09:00:29.075Z',
  breadcrumbs: [
    { label: '总览', href: '/dashboard' }
  ],
  context_badges: [
    { label: '开放 finding 15', tone: 'neutral' }
  ],
  page_actions: [
    { label: '最新有发现批次', href: '/dashboard/audit-reviews/review_xxx', kind: 'primary' }
  ]
}
```

### 6.2 表格 cell 结构

当前表格只支持字符串值，不足以表达链接和状态。

建议把 cell 升级为“字符串或对象”：

```js
{
  text: 'review_2026-07-03T08-49-51-691Z_431585d8',
  href: '/dashboard/audit-reviews/review_2026-07-03T08-49-51-691Z_431585d8',
  mono: true,
  tone: 'neutral',
  secondary: '5 个发现'
}
```

用途：

- overview 表格中的标题、批次 ID、发现数都能变成真正入口
- 不需要引入 row-level JS

### 6.3 Summary metric 扩展

`summary_metrics` 建议允许可选 `href`：

```js
{ label: '高风险', value: 3, tone: 'high', href: '/dashboard?severity=high#findings' }
```

这样 KPI 才是“可操作指标”，而不是纯展示数字。

## 7. 视觉设计建议

## 7.1 视觉方向

采用 **轻量、可信、数据密集但不压迫** 的审计控制台风格，而不是深色运维大屏。

原因：

- 当前产品是“调查与复核”，不是“实时指挥中心”
- 用户需要读标题、ID、摘要、证据，不是盯动效曲线
- 本地 HTML 模板更适合高可读 light theme

### 7.2 字体

参考 `ui-ux-pro-max` 的“数据型 dashboard 字体对”，但结合中文界面做本地化调整：

- UI 正文：`"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif`
- 等宽信息：`"JetBrains Mono", "Cascadia Code", monospace`

说明：

- skill 推荐的 `Fira Sans / Fira Code` 适合数据产品气质
- 但它们对中文覆盖不足，因此 v1.5 设计采用中文可用性更强的替代组合

### 7.3 色彩

建议采用浅色中性底 + 风险语义色：

```css
--bg: #F8FAFC;
--surface: #FFFFFF;
--surface-muted: #EAEFF3;
--border: #E2E8F0;
--text: #1E293B;
--text-muted: #64748B;
--accent: #2563EB;
--critical: #B42318;
--high: #C2410C;
--medium: #B7791F;
--low: #475569;
--success: #15803D;
```

来源判断：

- `ui-ux-pro-max` 在企业/文档型浅色系统中推荐了中性灰 + 链接蓝的组合
- 这比当前纯默认色更专业，也比 dark-only 方案更适合中文长文本审阅

### 7.4 背景与质感

避免纯平灰底，建议加入非常轻的背景层次：

- 页面背景为淡灰蓝
- 头部区域有轻微线性渐变
- 卡片保持白底、细边框、极浅阴影

这能提升完成度，但不破坏审计产品的严肃感。

### 7.5 交互状态

- 行 hover：仅轻微提亮和边框变化
- 链接 hover：下划线或文字强调，不用大幅动画
- focus ring：使用蓝色外环
- motion：150ms-200ms，仅用于 hover/focus/section reveal

## 8. 响应式与可访问性

### 8.1 响应式

基于 `ui-ux-pro-max` 的 table handling 规则，v1.5 建议采用分层策略：

- overview / review detail 的主列表：
  - 桌面端使用表格
  - 小屏端转为卡片列表或至少提供清晰横向滚动容器
- finding detail 的证据表：
  - 保持技术型表格
  - 小屏端允许横向滚动

原因：

- 证据表是技术对象，允许密度更高
- overview 列表是导航对象，更需要移动端可点击性

### 8.2 可访问性

- 所有点击入口必须保留可见 focus state
- breadcrumb 需要 `aria-label`
- 不能只靠颜色表达严重程度，应同时有文字标签
- 点击区域最少满足 44px
- 详情页标题层级保持 `h1 -> h2 -> h3`

## 9. v1.5 验收标准

- `/dashboard` 上至少存在两类明确入口：
  - 进入 review detail 的入口
  - 进入 finding detail 的入口
- `/dashboard/audit-reviews/{reviewId}` 中的 finding 列表可继续进入 finding detail
- `/dashboard/audit-findings/{findingId}` 可返回 review detail 和 overview
- overview 中零发现批次不再与高价值批次等权混排
- 页面仍为 server-rendered HTML
- 页面不依赖 browser-side `fetch()`
- 375px 宽度下主导航和关键入口仍可用

## 10. 实施提示（供后续开发使用）

后续真正实现时，优先顺序建议是：

1. 扩展 `dashboardTemplate.js` 的表格 cell/link 能力
2. 扩展 `visualization.js` 的 overview / review detail view model
3. 增加 breadcrumb、快速入口和 context badges
4. 最后统一 CSS token 与页面层次

这样可以先修通链路，再完成 UI 提升，返工最少。

## 11. 结论

当前 dashboard 的核心缺陷不是“没有详情页”，而是“详情页已经存在，但 overview 和 review detail 没有把入口交给用户”。  
v1.5 最合适的方向不是做大屏，也不是加更多图表，而是把现有三页重构成一个完整的审查工作台：总览负责分流，批次页负责聚合，finding 页负责证据闭环。

本设计建议采用“方案 B：审查工作台型重构”，在不改变现有后端路由和 server-rendered 架构的前提下，同时补齐导航、信息层级和视觉质量。
