# V2 飞书独立 Agent 设计方案

> 本文档与 [DESIGN.md](/E:/工作空间/audit-logger-agent/DESIGN.md) 明确区分。
> [DESIGN.md](/E:/工作空间/audit-logger-agent/DESIGN.md) 对应第一版初始化实现，主题是审计日志采集与查询能力。
> 本文档对应第二版目标形态，主题是“独立 Agent 服务 + 飞书 Bot 对接 + 用户决策回传 + 飞书卡片展示”。

## 1. 文档目标

本方案用于把当前仓库从“审计日志工具项目”升级为“可被飞书 Bot 调用的独立 Agent 服务”。

升级后的目标形态如下：

1. 飞书用户向飞书 Bot 发起请求。
2. 飞书 Bot 调用本项目提供的 Agent API。
3. Agent 独立规划、独立运行、独立维护状态。
4. Agent 在运行过程中按标准格式输出进度、决策请求、最终结果。
5. 飞书 Bot 将这些标准输出转换成飞书卡片展示给用户。
6. 用户在飞书卡片上做出的选择或输入，再由飞书 Bot 回传给 Agent。
7. Agent 从等待点恢复执行，直到产出最终结果。

本文档明确采用之前建议的“方案二：独立 Agent 服务”作为唯一落地方案，不再保留其他架构方案作为默认候选。

## 2. 当前项目现状

截至 2026-07-02，当前仓库已经有一套可运行的第一版能力，但它还不是独立 Agent。

已确认的现状如下：

- [scripts/ingest.js](/E:/工作空间/audit-logger-agent/scripts/ingest.js) 负责扫描并导入审计日志
- [scripts/query.js](/E:/工作空间/audit-logger-agent/scripts/query.js) 负责按条件查询日志
- [scripts/report.js](/E:/工作空间/audit-logger-agent/scripts/report.js) 负责生成统计报表
- [scripts/server.js](/E:/工作空间/audit-logger-agent/scripts/server.js) 提供轻量 HTTP 查询接口
- [scripts/lib/db.js](/E:/工作空间/audit-logger-agent/scripts/lib/db.js) 定义 SQLite 表结构与查询逻辑
- [LOG_SPEC.md](/E:/工作空间/audit-logger-agent/LOG_SPEC.md) 定义跨 Agent 审计日志格式

因此，当前项目本质上是“审计日志后端工具”，不是“面向飞书交互的独立执行 Agent”。

## 3. 明确采用的方案

### 3.1 方案结论

唯一采用方案：`独立 Agent 服务`.

### 3.2 为什么采用这个方案

这个方案最符合目标要求，因为它天然满足以下边界：

- 飞书 Bot 只负责飞书入口、飞书卡片发送、飞书回调接收
- 本项目负责任务理解、规划、执行、状态持久化、挂起恢复、结果产出
- 运行逻辑不嵌在 Bot 内部，后续可复用到其他消息渠道或 Web 入口
- 任务状态统一保存在 Agent 内部，不依赖 Bot 维护长流程上下文

### 3.3 不采用其他方案的原因

- 不采用“Bot 内嵌执行逻辑”方案，因为 Bot 会迅速变重，后续维护成本高，职责边界也会越来越乱。
- 不采用“先上分布式队列 Worker”方案，因为当前目标是把单体能力先跑通，高并发编排不是第一阶段重点。

## 4. 总体架构

### 4.1 角色划分

#### 飞书 Bot 负责

- 接收飞书消息
- 接收飞书卡片回调
- 调用本 Agent 的启动与恢复接口
- 将 Agent 返回的标准消息结构渲染成飞书卡片
- 把用户在飞书卡片中的选择或填写内容回传给 Agent

#### 本项目 Agent 负责

- 解析任务目标
- 生成执行计划
- 调用内部工具或外部集成
- 判断是否需要用户补充信息或做决策
- 记录每次运行的状态、步骤和结果
- 在等待用户时挂起
- 在收到用户回复后恢复执行
- 产出最终结果和展示数据

### 4.2 架构原则

- Bot 是薄适配层，Agent 是主执行体
- Agent 内部必须有显式状态机
- Agent 内部必须有持久化运行记录
- Agent 输出给 Bot 的数据必须是稳定协议，而不是临时拼装文本
- 飞书卡片是展示层，不是业务逻辑层
- 审计日志是基础能力，要沿用并扩展，而不是废弃

## 5. 端到端运行流程

### 5.1 启动流程

1. 飞书用户向 Bot 发送消息。
2. Bot 调用 Agent 的 `POST /v1/runs`。
3. Agent 创建一条新的运行记录 `run`。
4. Agent 进入 `planning` 状态。
5. Agent 产出初始计划后进入 `running` 状态。

### 5.2 执行流程

1. Agent 按计划执行步骤。
2. 每个步骤都要记录步骤状态和审计事件。
3. 如有必要，Agent 可主动产出进度消息给 Bot。
4. Bot 将进度消息转换成飞书卡片或普通消息推送给用户。

### 5.3 等待用户决策流程

1. Agent 在运行中发现信息不足或存在分支选择。
2. Agent 生成标准化的 `decision_request`。
3. Agent 把当前上下文保存到等待态。
4. Agent 将运行状态改为 `waiting_user`。
5. Bot 收到决策请求后发送飞书卡片给用户。

### 5.4 恢复流程

1. 用户在飞书卡片中点击按钮或填写表单。
2. Bot 将用户输入调用 `POST /v1/runs/{runId}/resume` 回传给 Agent。
3. Agent 校验回复是否匹配当前等待点。
4. 校验通过后，Agent 恢复运行并回到 `running` 状态。

### 5.5 结束流程

1. Agent 全部步骤执行完成，或达到失败终态。
2. Agent 生成 `final_result`。
3. Bot 根据 `final_result` 渲染最终飞书卡片。
4. Agent 将运行状态置为 `completed` 或 `failed`。

## 6. 运行状态模型

Agent 必须使用显式状态机，而不能依赖“有没有结果字段”之类的隐式判断。

### 6.1 状态定义

- `created`：运行记录刚创建
- `planning`：正在生成执行计划
- `running`：正在执行步骤
- `waiting_user`：等待用户决策或补充输入
- `completed`：已成功完成
- `failed`：已失败结束
- `cancelled`：被取消

### 6.2 状态流转

- `created -> planning`
- `planning -> running`
- `running -> waiting_user`
- `waiting_user -> running`
- `running -> completed`
- `running -> failed`
- `created|planning|running|waiting_user -> cancelled`

### 6.3 为什么必须有状态机

- Bot 可以稳定查询当前任务是否可恢复
- 重试和重复回调更容易做幂等
- 用户回传信息可以准确命中某个等待点
- Agent 进程异常退出后可以继续恢复

## 7. Bot 与 Agent 的标准协议

Agent 对 Bot 必须暴露稳定接口，Bot 不直接碰 Agent 内部实现。

### 7.1 Bot 调用 Agent 的入站接口

#### `POST /v1/runs`

用途：创建并启动一个新的运行任务。

请求示例：

```json
{
  "channel": "feishu",
  "conversation_id": "oc_xxx",
  "message_id": "om_xxx",
  "user": {
    "open_id": "ou_xxx",
    "name": "Alice"
  },
  "request": {
    "text": "帮我查询今天的异常任务并给出处理建议",
    "attachments": []
  },
  "delivery": {
    "mode": "callback",
    "callback_url": "https://bot.example.com/agent-events"
  },
  "metadata": {
    "tenant_key": "tenant_xxx"
  }
}
```

响应示例：

```json
{
  "run_id": "run_20260702_001",
  "status": "created"
}
```

#### `POST /v1/runs/{runId}/resume`

用途：把飞书卡片的用户输入回传给 Agent，并恢复运行。

请求示例：

```json
{
  "decision_id": "dec_001",
  "user": {
    "open_id": "ou_xxx"
  },
  "response": {
    "selected_option": "retry_latest_only",
    "form_data": {
      "comment": "先只处理最近 10 条"
    }
  }
}
```

#### `GET /v1/runs/{runId}`

用途：读取运行状态、摘要信息和最新结果。

### 7.2 Agent 输出给 Bot 的标准消息类型

第一阶段只定义 3 种一等消息：

- `progress_update`
- `decision_request`
- `final_result`

#### `progress_update`

用于展示任务进度。

```json
{
  "type": "progress_update",
  "run_id": "run_20260702_001",
  "title": "正在分析任务",
  "summary": "已完成 2/5 个步骤，当前正在查询异常记录",
  "progress": {
    "current_step": 2,
    "total_steps": 5
  }
}
```

#### `decision_request`

用于请求用户做决策或补充输入。

```json
{
  "type": "decision_request",
  "run_id": "run_20260702_001",
  "decision_id": "dec_001",
  "title": "需要你确认处理范围",
  "summary": "异常任务数量较多，建议先缩小范围后继续执行",
  "options": [
    {
      "id": "retry_latest_only",
      "label": "只处理最近 10 条",
      "description": "执行更快，适合先验证方案"
    },
    {
      "id": "retry_all",
      "label": "处理全部异常",
      "description": "耗时更长，但可一次性处理完成"
    }
  ],
  "form_schema": [
    {
      "type": "textarea",
      "name": "comment",
      "label": "补充说明",
      "required": false
    }
  ],
  "submit_label": "继续执行"
}
```

#### `final_result`

用于最终结果展示。

```json
{
  "type": "final_result",
  "run_id": "run_20260702_001",
  "status": "completed",
  "title": "异常任务处理建议已生成",
  "summary": "共发现 18 条异常，其中 6 条建议立即处理",
  "details_markdown": "1. 任务 A ...\n2. 任务 B ...",
  "actions": [
    {
      "id": "view_trace",
      "label": "查看执行轨迹"
    }
  ]
}
```

## 8. 消息投递模式

### 8.1 推荐模式

推荐使用：`Bot 提供 callback_url，Agent 异步回调推送`.

执行方式如下：

1. Bot 创建运行时传入 `delivery.callback_url`
2. Agent 异步执行
3. Agent 每次产出 `progress_update`、`decision_request`、`final_result` 时，都回调这个地址
4. Bot 收到后负责发飞书卡片

### 8.2 采用回调推送的原因

- 长任务不需要一直占住首个 HTTP 请求
- Agent 可以在整个执行周期内多次通知 Bot
- Bot 继续保持“唯一直接连接飞书平台的组件”
- 回调失败时可单独重试，不影响主流程状态

### 8.3 备用模式

如后续 Bot 无法提供回调地址，可增加轮询模式：

- `GET /v1/runs/{runId}/events?cursor=...`

但该模式不是第一阶段默认实现。

## 9. 规划与执行模型

### 9.1 第一阶段采用“受约束规划”

第一阶段不直接上完全开放式自主推理循环，而采用受约束规划模型。

推荐步骤模板：

1. 理解用户请求
2. 收集上下文
3. 生成执行步骤
4. 调用工具执行
5. 校验结果
6. 必要时请求用户决策
7. 汇总最终输出

### 9.2 这样做的原因

- 更容易测试
- 更容易审计
- 更容易在异常中恢复
- 比完全开放式循环更适合第一阶段落地

### 9.3 规划器抽象接口

规划器必须抽象成独立模块，避免后续切换模型供应商时影响运行时主逻辑。

建议接口：

```ts
type PlanStepStatus = "pending" | "running" | "completed" | "failed" | "waiting_user";

interface AgentPlanner {
  createInitialPlan(input: RunInput): Promise<ExecutionPlan>;
  nextAction(context: RunContext): Promise<PlannerDecision>;
  synthesizeFinalResult(context: RunContext): Promise<FinalResultPayload>;
}
```

## 10. 工具模型

Agent 内部不能把所有业务逻辑都写在 HTTP 路由里，必须通过工具注册表统一调用。

### 10.1 工具原则

- 一个工具只做一类事
- 输入输出要结构化
- 每次工具调用都要产生日志与审计事件
- 每个工具都要支持超时、失败分类和错误摘要

### 10.2 第一阶段工具分类

- 仓库内本地数据工具
- 审计日志查询工具
- 报表工具
- 外部 HTTP 集成工具
- 最终展示内容整理工具

### 10.3 当前仓库可复用能力

当前第一版能力不应丢弃，建议沉为 Agent 工具能力：

- [scripts/lib/db.js](/E:/工作空间/audit-logger-agent/scripts/lib/db.js) 中的查询能力
- [scripts/lib/indexer.js](/E:/工作空间/audit-logger-agent/scripts/lib/indexer.js) 中的导入与索引能力
- [scripts/server.js](/E:/工作空间/audit-logger-agent/scripts/server.js) 的 HTTP 服务组织方式
- [LOG_SPEC.md](/E:/工作空间/audit-logger-agent/LOG_SPEC.md) 中的审计事件规范

## 11. 持久化模型

第一阶段继续使用 SQLite 作为运行时状态存储。

### 11.1 保留现有表

- `audit_events`

### 11.2 新增运行时表

#### `agent_runs`

存储每次任务运行的主记录。

建议字段：

- `run_id`
- `channel`
- `conversation_id`
- `user_open_id`
- `status`
- `request_text`
- `plan_json`
- `current_step_index`
- `result_json`
- `error_code`
- `error_message`
- `created_at`
- `updated_at`

#### `agent_run_steps`

存储每个步骤的执行记录。

建议字段：

- `id`
- `run_id`
- `step_index`
- `step_name`
- `status`
- `tool_name`
- `input_json`
- `output_json`
- `started_at`
- `finished_at`

#### `agent_waiting_states`

存储等待用户输入时的上下文快照。

建议字段：

- `decision_id`
- `run_id`
- `schema_json`
- `context_json`
- `requested_by_step`
- `status`
- `created_at`
- `resolved_at`

#### `agent_outbox_events`

存储待投递给 Bot 的消息事件。

建议字段：

- `event_id`
- `run_id`
- `type`
- `payload_json`
- `delivery_mode`
- `delivery_status`
- `delivery_attempts`
- `last_error`
- `created_at`
- `delivered_at`

### 11.3 为什么必须有 Outbox

如果没有 `agent_outbox_events`，会出现这种风险：

- Agent 已经把任务状态写成完成
- 但在把最终结果发给 Bot 前进程异常退出
- 导致用户看不到结果，系统也无法明确补发

有 Outbox 后可以获得：

- 可重试投递
- 可见的投递失败状态
- 可追溯的消息发送记录
- 更容易做幂等

## 12. 飞书卡片策略

### 12.1 Agent 产出什么

Agent 不直接以“飞书卡片 JSON”作为主要内部格式，而是产出稳定的业务结构：

- 标题
- 摘要
- 可选项列表
- 表单结构
- 动作 ID
- Markdown 详情

### 12.2 Bot 负责什么

Bot 负责把上述结构映射成：

- `decision_request` 对应的交互卡片
- `progress_update` 对应的进度卡片或普通消息
- `final_result` 对应的结果卡片

这样做的好处是飞书渲染层变化时，不需要修改 Agent 核心逻辑。

## 13. 错误处理

### 13.1 错误分类

建议第一阶段统一错误类型：

- `validation_error`
- `tool_timeout`
- `tool_execution_error`
- `delivery_error`
- `planner_error`
- `resume_conflict`
- `user_input_invalid`

### 13.2 错误处理原则

- 参数校验错误直接失败
- 工具错误根据工具策略决定是否重试
- 回调投递错误写入 Outbox 并重试
- 非当前等待点的恢复请求不得修改运行状态
- 不可恢复错误也要生成结构化终态结果给 Bot

## 14. 审计与可观测性

这个仓库已有的审计日志体系是第二版的重要基础，必须沿用并扩展。

### 14.1 建议新增的审计事件

- `run.start`
- `run.plan.created`
- `run.step.start`
- `run.step.end`
- `run.waiting_user`
- `run.resume`
- `run.final_result`
- `run.delivery.success`
- `run.delivery.error`

### 14.2 Trace 规则

- 一个用户请求对应一个主 `trace_id`
- 每个步骤、工具调用、消息投递对应一个独立 `span_id`
- 用户回传恢复执行时沿用同一 `trace_id`

这样可以做到整条飞书交互链路的端到端审计。

## 15. 目标代码结构

建议把仓库逐步调整为如下结构：

```text
audit-logger-agent/
  src/
    agent/
      runtime.ts
      stateMachine.ts
      planner.ts
      runStore.ts
      outbox.ts
    adapters/
      http/
        routes.ts
      bot/
        callbackClient.ts
      feishu/
        payloadSchema.ts
    tools/
      registry.ts
      auditQueryTool.ts
      reportTool.ts
    observability/
      auditLogger.ts
    db/
      schema.ts
      migrations.ts
  scripts/
    server.js
    ingest.js
    query.js
    report.js
```

说明：

- `scripts/` 先继续保留，用作兼容层和运行入口
- `src/` 逐步承载真正的 Agent 运行时实现
- 第一版已有 CLI 能力在迁移过程中可以继续使用

## 16. 范围定义

### 16.1 第一阶段必须做到的事

- 具备独立运行状态管理
- 具备 `start / resume / status` 接口
- 具备 SQLite 持久化运行记录
- 具备标准化 Bot 回调输出
- 具备等待用户与恢复执行能力
- 具备基础规划器和工具注册表
- 具备最终结果结构化输出
- 具备全链路审计日志

### 16.2 第一阶段明确不做的事

- 多 Agent 协同编排
- 分布式任务队列
- 插件化动态装载
- 在本仓库内直接集成飞书 SDK 复杂逻辑
- 无边界的开放式自主循环

## 17. 分阶段实施计划

下面的实施计划按“先建立可靠运行骨架，再逐步增强自主能力”的顺序组织。

### 阶段 0：整理现状与奠定迁移边界

#### 目标

在不破坏当前第一版日志能力的前提下，为第二版 Agent 化重构腾出结构空间。

#### 范围

- 保留现有 `scripts/ingest.js`、`scripts/query.js`、`scripts/report.js`、`scripts/server.js`
- 新建 `src/` 目录作为新运行时实现区域
- 明确 `scripts/` 与 `src/` 的职责边界

#### 产出

- 新版目录结构
- 文档化的模块边界
- 不影响现有日志能力的兼容方案

#### 验收标准

1. 现有日志导入与查询命令仍可运行
2. 新代码默认写入 `src/`，旧代码暂不强行重构
3. 第二版文档与第一版文档边界清晰

### 阶段 1：建立 Agent 运行骨架

#### 目标

先把“任务运行状态机 + 运行记录 + 基础 API”搭起来，让项目真正拥有独立任务实例的概念。

#### 范围

- 新增 `agent_runs`、`agent_run_steps` 表
- 实现 `created/planning/running/waiting_user/completed/failed/cancelled` 状态机
- 实现 `POST /v1/runs`
- 实现 `GET /v1/runs/{runId}`

#### 产出

- 可创建 run
- 可查询 run 状态
- 可记录步骤状态

#### 验收标准

1. 新建 run 后数据库中能看到主记录
2. 运行状态流转受状态机约束
3. `GET /v1/runs/{runId}` 能返回当前状态和基础摘要

### 阶段 2：建立 Bot 回调输出链路

#### 目标

先让 Agent 能把结果稳定地“发出去”，而不是只在本地完成状态更新。

#### 范围

- 新增 `agent_outbox_events`
- 实现 `progress_update`、`decision_request`、`final_result` 三类标准消息结构
- 实现回调发送器
- 加入投递失败重试逻辑

#### 产出

- Agent 可向 Bot callback URL 投递消息
- 失败消息可留存在 Outbox 重试

#### 验收标准

1. 任一出站消息都会先入 Outbox
2. Bot callback 失败时不会丢消息
3. 成功投递后可标记为已送达

### 阶段 3：接入基础规划器与工具注册表

#### 目标

让 Agent 不只是“接收请求然后硬编码处理”，而是能基于统一工具接口执行一个受约束计划。

#### 范围

- 新增 `planner.ts`
- 新增 `tools/registry.ts`
- 封装当前日志查询与报表能力为内部工具
- 支持“理解请求 -> 选工具 -> 执行 -> 汇总”

#### 产出

- 第一版受约束规划器
- 第一版工具注册表
- 至少 2 个可被规划器调用的真实工具

#### 验收标准

1. 一个标准请求能够被转成多步骤计划
2. 计划步骤能调用工具并写入步骤记录
3. 无需人工参与的简单请求可直接完成到终态

### 阶段 4：实现等待用户与恢复执行

#### 目标

让 Agent 真正具备飞书场景下最关键的能力：中途向用户要决策，然后继续跑。

#### 范围

- 新增 `agent_waiting_states`
- 实现 `POST /v1/runs/{runId}/resume`
- 支持等待点上下文快照
- 支持用户选项与表单输入校验

#### 产出

- 可挂起
- 可恢复
- 可识别错误恢复请求

#### 验收标准

1. Agent 能在运行中进入 `waiting_user`
2. 合法回传可恢复执行
3. 非法回传不会破坏运行状态

### 阶段 5：完善最终结果输出与飞书展示契约

#### 目标

让最终结果输出稳定可展示，并能成为 Bot 生成飞书卡片的唯一数据源。

#### 范围

- 完善 `final_result` 结构
- 增加 `details_markdown`、`actions` 等字段
- 固化 Bot 渲染契约

#### 产出

- 稳定的终态输出结构
- 对应的飞书卡片映射说明

#### 验收标准

1. 终态成功和终态失败都能生成结构化结果
2. Bot 无需猜测字段含义即可渲染卡片
3. 结果数据中能包含摘要、详情和可选操作

### 阶段 6：补齐审计、恢复与上线准备

#### 目标

让这个 Agent 不只是“能跑”，而是“出了问题能查、重启后能恢复、具备上线基础”。

#### 范围

- 扩展运行态审计事件
- 补齐恢复逻辑
- 增加关键路径测试
- 补充部署与配置说明

#### 产出

- 运行生命周期审计完整
- 异常恢复路径可验证
- 上线前必需文档齐全

#### 验收标准

1. 每个 run 都能追踪到完整审计链路
2. 进程重启后未完成 run 可恢复
3. 关键 API 和状态流转有可重复验证方式

## 18. 阶段优先级与实施顺序说明

采用这个阶段顺序的原因是：

- 先解决“状态是否可靠”
- 再解决“消息能不能稳定送达”
- 然后再增强“规划是否足够智能”

换句话说，第二版首先要是“可靠的独立 Agent”，然后才是“更聪明的独立 Agent”。

如果顺序反过来，先做复杂规划再补状态和恢复，会导致系统非常难调试，也难以接入飞书真实用户流程。

## 19. 风险与前置假设

### 19.1 当前假设

- 飞书 Bot 可作为纯转发层
- 飞书 Bot 可以提供 Agent 回调入口
- SQLite 足够支撑第一阶段运行状态
- 当前仓库继续使用 Node.js ESM
- 第一阶段优先可靠性和可观测性，而不是吞吐量

### 19.2 主要风险

- Bot 回调接口如果不稳定，会影响用户端感知
- 如果规划器设计过于开放，第一阶段调试成本会明显上升
- 如果等待点上下文设计不完整，恢复执行容易丢上下文

## 20. 总结

本项目第二版的目标，不是简单“给现有日志系统加一个飞书入口”，而是把这个仓库升级为一个真正的独立 Agent 服务。

这个 Agent 服务的关键特征是：

- 被飞书 Bot 调用
- 自主规划执行
- 中途可请求用户决策
- 能接收飞书回传继续运行
- 最终以标准结构交给 Bot 渲染飞书卡片
- 全链路可审计、可恢复、可追踪

第二版的核心落地路径已经明确：

1. 保留第一版日志能力
2. 建立独立运行状态机
3. 建立 Bot 回调消息协议
4. 建立受约束规划器和工具体系
5. 建立等待用户与恢复执行机制
6. 完成最终结果结构化输出与飞书展示契约
