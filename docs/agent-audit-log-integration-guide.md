# 将任意 Agent 改造成可发送审计日志的 Agent

本文是一份可以直接交给编码 Agent 执行的改造手册。目标不是只增加一个 HTTP 请求，而是让目标 Agent 在真实运行时持续生成符合规范的审计事件，并能在 Audit Logger Dashboard 中看到该 Agent 的日志。

## 1. 用户如何使用本文

1. 将本文交给负责修改目标仓库的编码 Agent。
2. 同时告诉编码 Agent 目标 Agent 的仓库位置；如果目标仓库已经是其当前工作目录，可以省略。
3. 编码 Agent 应自行检查项目结构、配置方式、启动命令、测试体系和工具调用入口，然后直接开始改造。
4. 改造完成后，编码 Agent 必须运行一次真实且无破坏性的 Agent 任务，将验证用 `trace_id`、查询结果和 Dashboard 地址交付给用户。
5. 用户或编码 Agent 必须在 Dashboard 中看到目标 `agent_id`、接收日志数和最新日志时间。看不到就不算完成。

默认审计服务地址：

```text
服务基地址：http://auditloggeragent-auditloggeragent-mue8ko-342fc3-18-141-240-9.traefik.me
日志接收地址：http://auditloggeragent-auditloggeragent-mue8ko-342fc3-18-141-240-9.traefik.me/v1/ingest
Agent 日志入口：http://auditloggeragent-auditloggeragent-mue8ko-342fc3-18-141-240-9.traefik.me/
审计 Dashboard：http://auditloggeragent-auditloggeragent-mue8ko-342fc3-18-141-240-9.traefik.me/dashboard
```

如用户提供了其他环境的地址，以用户提供的 `AUDIT_INGEST_URL` 和 Dashboard 基地址为准。

## 2. 编码 Agent 的执行指令

收到本文后，按第 4 节的流程自动完成改造。不要停留在方案说明，也不要让用户逐项指导代码位置。

开始前先读取目标仓库的现有文件、Git 状态、项目说明、配置、启动脚本和测试命令。优先复用现有日志、配置、HTTP 客户端、生命周期钩子和工具执行封装；没有合适实现时再新增独立的 `auditLogger` 模块。

只有以下信息无法从目标仓库或运行环境得到时才询问用户：

- 目标仓库无法访问；
- 不知道应使用哪个稳定的 `agent_id`，且无法从项目名称或部署配置确定；
- 用户要求使用非默认审计服务，但没有提供地址；
- 目标 Agent 必须依赖用户凭证、人工确认或外部环境才能运行真实验收任务。

不得以单元测试通过、日志文件已生成、HTTP 返回 `202` 或 `/query` 能查到数据中的任意一项单独作为完成依据。最终必须完成 Dashboard 验收。

## 3. 完成定义

以下条件必须全部满足：

1. 目标 Agent 有稳定且统一的 `agent_id`。
2. 每个事件符合第 5 节的字段契约。
3. 一次真实请求或任务使用同一个 `trace_id`。
4. Agent 生命周期至少记录 `agent.start` 和 `agent.end`/`agent.error`。
5. 实际工具调用记录成对的 `tool.start` 和 `tool.end`/`tool.error`，开始和结束复用同一个 `span_id`。
6. 事件先追加到目标 Agent 自己的本地 NDJSON 文件，再异步发送相同 payload 到 `/v1/ingest`。
7. 发送端解析 `accepted`、`rejected` 和 `errors`；没有被服务端确认的事件进入本地重试队列。
8. 审计发送失败不会改变目标 Agent 原有业务结果，也不会长时间阻塞用户请求。
9. 自动化测试覆盖事件构造、成功发送、拒收处理、网络失败和重试回放。
10. 使用真实目标 Agent 完成一次无破坏性的调用，并通过 `/query?trace_id=...` 查到完整事件链。
11. Dashboard 的 Agent 日志入口已经显示目标 `agent_id`、接收日志数和最新日志时间。
12. 编码 Agent 能直接查看 Dashboard 时，由编码 Agent 完成可见性检查；无法查看时，必须把具体网址和验证信息交给用户，并等待用户确认后才能宣称完成。

## 4. 自动改造流程

### 阶段一：审计目标 Agent

检查并记录：

- 稳定的项目或服务标识，用作 `agent_id`；
- HTTP、消息、CLI、定时任务等请求或任务入口；
- Agent 主循环、规划器或任务执行器的开始、成功和异常出口；
- 所有工具执行的统一封装点，以及绕过统一封装的特殊调用；
- 配置加载方式、持久化目录、现有 HTTP 客户端和进程退出钩子；
- 项目已有测试命令和可安全执行的真实验证任务。

优先在统一入口埋点，不要在大量业务函数中重复拼装日志。如果目标 Agent 没有统一工具执行层，先建立最小封装，再让工具调用经过该封装。

阶段产物：一份简短的改造映射，明确“请求入口 → Agent 生命周期 → 工具调用 → 结束出口”分别位于哪些文件。

### 阶段二：实现审计日志模块

新增或统一一个职责集中的 `auditLogger`。名称可以遵循目标项目现有风格，但至少提供以下能力：

| 能力 | 必须行为 |
| --- | --- |
| 配置读取 | 读取 ingest URL、超时、本地日志目录、是否启用重试和单次回放上限 |
| 事件构造 | 生成必填字段，规范化状态码、事件名和可选字段 |
| 本地记录 | 追加写入 `audit-YYYY-MM-DD.jsonl`，每行一个完整 JSON 对象 |
| 异步发送 | 将刚落盘的同一 payload 非阻塞地 `POST` 到 `/v1/ingest` |
| 响应确认 | 解析 `accepted`、`rejected`、`errors`，不能把任意 2xx 直接视为全部成功 |
| 失败队列 | 保存网络错误、超时、非 2xx 和服务端拒收的未确认事件 |
| 有限回放 | 每次只处理有限数量，成功后移除，失败时保留原始 payload |
| `flush` | 在任务收尾或进程退出阶段等待已经发起的发送任务，不改变业务结果 |

建议配置语义：

| 配置 | 推荐默认值 | 说明 |
| --- | --- | --- |
| `AUDIT_INGEST_URL` | 当前部署的 `/v1/ingest` 地址 | 必须是完整接收地址，不是服务基地址 |
| `AUDIT_INGEST_TIMEOUT_MS` | `1500` | 解析为有限正整数 |
| `AUDIT_RETRY_ENABLED` | `true` | 控制失败队列回放 |
| `AUDIT_RETRY_MAX_BATCH` | `50` | 单次最多回放的事件数 |
| `<AGENT>_AUDIT_LOG_DIR` | Agent 自己的持久目录 | 保存原始 NDJSON 和重试队列 |

已有项目可以保留自己的配置名，但语义必须一致。URL 为空时可以关闭远程发送，本地审计日志仍应保留。

默认按单事件发送，响应归属最清楚。只有目标项目已经有可靠批处理基础设施时才使用批量发送。

正确顺序：

```text
构造并校验事件
  → 追加写入本地 NDJSON
  → 异步发送同一 payload
  → 解析服务端确认结果
  → 未确认则写入重试队列
```

### 阶段三：接入 Agent 生命周期

一次用户请求、消息处理或自治任务只生成一个 `trace_id`。在整个调用链中显式传递它，不要让每个工具自行生成新的 Trace。

建议链路：

```text
run.start                 trace_id = req-100
  agent.start             trace_id = req-100, span_id = agent-1
    tool.start             trace_id = req-100, span_id = tool-1, parent_span_id = agent-1
    tool.end               trace_id = req-100, span_id = tool-1, parent_span_id = agent-1
  agent.end               trace_id = req-100, span_id = agent-1
run.final_result          trace_id = req-100
```

最低要求是 Agent 和实际工具调用链完整。目标 Agent 已有明确 Run 生命周期时，同时记录 `run.start`、`run.final_result` 或 `run.failed`。

异常路径必须使用 `try/catch/finally` 或目标语言的等价机制补齐结束事件：

- 成功：`tool.start` → `tool.end`，状态为 `OK`；
- 失败：`tool.start` → `tool.error`，状态使用最接近的 canonical code；
- Agent 成功：`agent.start` → `agent.end`；
- Agent 失败：`agent.start` → `agent.error`。

结束事件填写非负的 `duration_ms`。同一个调用的开始和结束必须复用同一个 `span_id`。

### 阶段四：接入工具调用

优先修改工具注册器、调度器、执行器或统一 middleware，使所有工具自动获得审计日志。只有无法经过统一层的调用才单独埋点。

工具名必须稳定，并能表达真实操作语义。推荐使用 `domain.resource.action`：

```text
catalog.product.get
order.note.create
rental.price.update
inventory.item.delete
service.deploy
shell.exec
browser.page.click
db.query
file.write
notification.send
llm.responses.create
```

不要使用随机值、自然语言、动态 URL、用户输入或 `run`、`handler`、`process`、`doTask` 之类无法判断行为的名称。

写入、删除、部署、权限、凭证等需要确认或结果核验的操作，应根据目标 Agent 的真实流程拆成稳定步骤，例如：

```text
catalog.update.preview
run.waiting_user
catalog.update.execute
catalog.update.verify
```

不要为了日志而虚构目标 Agent 实际不存在的阶段。

### 阶段五：补充测试

遵循目标项目现有测试体系，至少验证：

1. 最小事件包含全部必填字段并通过本地校验。
2. 同一工具调用的开始和结束复用 `trace_id`、`span_id`。
3. 成功响应必须满足 `accepted === 1` 且 `rejected === 0`；不能只检查 HTTP 状态。
4. `202` 但 `rejected > 0` 时，事件进入失败队列或隔离区。
5. 网络错误、超时和非 2xx 不影响原业务调用结果。
6. 重试使用原始 payload，不重新生成时间和链路 ID。
7. 回放成功后队列记录被移除；重复发送不会在服务端形成重复数据库事件。
8. 目标 Agent 原有测试继续通过。

### 阶段六：真实发送与 Dashboard 验收

先检查服务：

```powershell
$auditBaseUrl = 'http://auditloggeragent-auditloggeragent-mue8ko-342fc3-18-141-240-9.traefik.me'
$agentId = '<目标 Agent 的实际 agent_id>'
$env:AUDIT_INGEST_URL = "$auditBaseUrl/v1/ingest"

Invoke-RestMethod -Uri "$auditBaseUrl/health"
```

然后运行目标 Agent 自己的真实启动或测试入口，执行一次无破坏性的工具调用，例如读取、查询、列表或 dry-run。不得只用手写 HTTP 示例代替目标 Agent 的真实调用。

记录本次调用生成的 `trace_id`，查询完整链路：

```powershell
$traceId = '<真实调用生成的 trace_id>'
$queryUrl = "$auditBaseUrl/query?trace_id=$([uri]::EscapeDataString($traceId))&limit=100"
$result = Invoke-RestMethod -Uri $queryUrl
$result.results | Format-Table ts, agent_id, event, tool_name, status, trace_id, span_id, duration_ms
```

查询结果必须满足：

- `count` 大于 0；
- 所有记录的 `agent_id` 都是目标 Agent 的稳定 ID；
- 同一工具存在 `tool.start` 和 `tool.end`/`tool.error`；
- 配对事件使用相同的 `trace_id` 和 `span_id`；
- 结束事件有合理的 `duration_ms`；
- `event` 不是 `unknown`；
- 等待异步映射完成后，`mapping_status` 不应为 `unknown`；如果为 `unknown`，修改 `tool_name` 后重新验证。

最后打开 Dashboard：

```text
Agent 日志入口：http://auditloggeragent-auditloggeragent-mue8ko-342fc3-18-141-240-9.traefik.me/
目标 Agent 审计视图：http://auditloggeragent-auditloggeragent-mue8ko-342fc3-18-141-240-9.traefik.me/dashboard?agent_id=<URL 编码后的 agent_id>
```

在 Agent 日志入口确认：

- 页面出现目标 `agent_id`；
- “接收日志数”已经增加；
- “最新日志时间”与刚才的真实调用一致。

编码 Agent 有浏览器能力时必须自行打开并检查页面。没有浏览器能力时，在交付说明中给出以上两个可点击地址、实际 `agent_id`、验证 `trace_id` 和查询结果摘要，并明确要求用户打开确认。用户尚未确认时，状态应写成“代码改造与接口验证完成，等待 Dashboard 人工确认”，不能写“改造全部完成”。

如果 Dashboard 看不到目标 Agent，依次检查：

1. `AUDIT_INGEST_URL` 是否为完整的 `/v1/ingest` 地址；
2. ingest 响应是否真的满足 `accepted > 0` 且 `rejected === 0`；
3. `/query?trace_id=...` 是否能查到事件；
4. 查询结果中的 `agent_id` 是否与预期完全一致；
5. Dashboard 是否打开了同一个审计服务环境；
6. 修复后重新运行真实调用，直到 Dashboard 可见。

## 5. 日志字段契约

### 5.1 最小可接收事件

```json
{
  "ts": "2026-07-17T08:30:00.000Z",
  "agent_id": "catalog-agent",
  "trace_id": "request-8ecb",
  "span_id": "tool-27aa",
  "event": "tool.end",
  "tool_name": "catalog.product.get",
  "status": "OK",
  "result_summary": "已读取商品摘要"
}
```

以下八个字段是服务端必填字段，缺少或为空会拒收该事件：

| 字段 | 规范 | 改造要求 |
| --- | --- | --- |
| `ts` | 可解析的 ISO 8601 时间 | 首次构造后固定；重试不得改写 |
| `agent_id` | 稳定字符串；只使用字母、数字、`.`, `_`, `-` | 不能是 `.`、`..`，不能包含 `..`、斜杠或路径片段 |
| `trace_id` | 非空字符串 | 同一次请求或任务全链路保持一致 |
| `span_id` | 非空字符串 | 同一调用的开始和结束复用；不同调用应唯一 |
| `event` | 字符串 | 使用第 5.3 节的 canonical 事件名 |
| `tool_name` | 稳定工具或运行组件名 | 使用能表达语义的点号命名，不包含动态数据 |
| `status` | canonical 状态码 | 必须使用第 5.4 节列出的全大写值 |
| `result_summary` | 不超过 200 字符的短文本 | 只写结果摘要，不复制完整请求或响应 |

### 5.2 可选字段

```json
{
  "parent_span_id": "agent-5fd2",
  "duration_ms": 86,
  "channel": "http",
  "user_id": "u_123",
  "entity": { "type": "product", "id": "761" },
  "llm_intent": {
    "input": "查询商品 761 的当前状态",
    "output": "返回商品状态与库存摘要"
  },
  "error": {
    "message": "当前用户没有商品编辑权限"
  },
  "tags": ["read", "confirmed"]
}
```

| 字段 | 规范 |
| --- | --- |
| `parent_span_id` | 字符串；用于关联父调用，没有父级时省略 |
| `duration_ms` | 非负毫秒数；填写在 `.end` 或 `.error` 事件 |
| `channel` | 来源渠道，例如 `http`、`cli`、`feishu` |
| `user_id` | 稳定且已脱敏的用户标识；自治任务可省略 |
| `entity` | 对象；必须同时包含非空字符串 `type` 和 `id` |
| `llm_intent` | 对象；必须同时包含字符串 `input` 和 `output` |
| `error.message` | 失败原因的简短文本；失败类别由 `status` 表示 |
| `tags` | 字符串数组；只使用稳定、可查询的标签 |

字段迁移规则：

- 旧 `product_id` 改为 `entity: { "type": "product", "id": "..." }`；服务端会拒收带 `product_id` 的事件。
- 不发送 `error.code`；服务端会拒收。错误类别放在 `status`，详细原因放在 `error.message`。
- 顶层 `error_code` 不属于当前规范。当前服务端未将它列为显式拒收字段，但新改造不得继续使用。
- 不发送 API Key、Cookie、Token、Authorization、密码、完整请求体、完整响应体、HTML、截图原文或未脱敏个人信息。

服务端默认限制单请求最大 1 MiB，单事件或 NDJSON 单行最大 64 KiB。事件过大时应缩短摘要或只保留稳定实体 ID，不能截断 JSON。

### 5.3 canonical 事件名

目标 Agent 使用以下事件：

```text
tool.start   tool.end   tool.error
agent.start  agent.end  agent.error
run.start    run.resume run.waiting_user run.final_result run.failed
```

服务端兼容部分使用 `/`、`_`、`-` 分隔的历史别名，但新改造必须发送上面的点号形式。无法识别的事件虽然可能被接收，但数据库中的 `event` 会变成 `unknown`，验收不通过。

### 5.4 canonical 状态码

`status` 必须是以下值之一：

```text
OK CANCELLED UNKNOWN INVALID_ARGUMENT DEADLINE_EXCEEDED NOT_FOUND
ALREADY_EXISTS PERMISSION_DENIED RESOURCE_EXHAUSTED FAILED_PRECONDITION
ABORTED OUT_OF_RANGE UNIMPLEMENTED INTERNAL UNAVAILABLE DATA_LOSS UNAUTHENTICATED
```

常用映射：

| 场景 | 状态 |
| --- | --- |
| 成功完成 | `OK` |
| 用户取消或拒绝确认 | `CANCELLED` |
| 参数错误 | `INVALID_ARGUMENT` |
| 目标不存在 | `NOT_FOUND` |
| 前置条件不成立 | `FAILED_PRECONDITION` |
| 权限不足 | `PERMISSION_DENIED` |
| 远端服务不可达 | `UNAVAILABLE` |
| 调用超时 | `DEADLINE_EXCEEDED` |
| 未分类内部异常 | `INTERNAL` |

不要直接发送 `ok`、`success`、`failed`、`error` 等业务状态。应在事件构造器中统一映射为 canonical code。

### 5.5 `tool_name` 语义要求

审计服务会异步生成 `mapped_tool_type` 和 `mapping_status`。工具名应能稳定映射到以下语义之一：

```text
read write update delete deploy permission credential shell browser
network database file notification llm
```

常用动词：

| 语义 | 推荐词 |
| --- | --- |
| 读取 | `read`、`query`、`search`、`get`、`list`、`fetch` |
| 创建/写入 | `write`、`create`、`insert`、`save`、`append` |
| 更新 | `update`、`patch`、`modify`、`edit`、`set` |
| 删除 | `delete`、`remove`、`destroy`、`drop`、`truncate` |
| 部署 | `deploy`、`release`、`publish`、`rollout` |
| 权限 | `permission`、`role`、`policy`、`grant`、`revoke` |
| 凭证 | `credential`、`secret`、`token`、`api_key`、`password` |

如果 `mapping_status` 最终为 `unknown`，修改 `tool_name` 使其表达真实动作，然后重新运行真实验收。不要通过修改 `result_summary` 规避。

## 6. HTTP 发送与重试契约

### 6.1 请求形式

| 形式 | `Content-Type` | 请求体 |
| --- | --- | --- |
| 单事件 | `application/json` | 一个事件对象 |
| 批量事件 | `application/json` | `{ "events": [ ... ] }` |
| NDJSON | `application/x-ndjson` | 每行一个事件对象 |

### 6.2 响应处理

成功接收单事件的响应：

```json
{
  "accepted": 1,
  "rejected": 0,
  "errors": []
}
```

`202` 只表示请求已处理，不表示批次全部成功：

1. 网络错误、超时或非 2xx：本次事件未确认，进入重试队列。
2. 单事件收到 2xx：只有 `accepted === 1` 且 `rejected === 0` 才算确认。
3. 批量请求收到 `202` 且 `rejected > 0`：根据 `errors[].index` 保留对应的拒收事件，只移除已确认事件。
4. `400` 表示请求 JSON 结构错误，`413` 表示请求过大，`415` 表示 `Content-Type` 错误。这类问题需要修复 payload 或配置，不能无限快速重试。

### 6.3 回放与去重

- 重试必须使用首次生成并保存的原始 payload，不重新生成 `ts`、`trace_id`、`span_id` 或业务字段。
- 每轮最多回放配置的 `AUDIT_RETRY_MAX_BATCH` 条。
- 服务端按原始事件 JSON 的哈希去重。相同 payload 重发不会重复入库；重试时改变字段会被视为新事件。
- 本地 `audit-YYYY-MM-DD.jsonl` 是原始审计记录，失败队列只保存尚未确认的待发送事件。

## 7. 编码 Agent 的交付报告

完成后按以下格式交付：

```text
改造文件：<实际文件列表>
agent_id：<实际稳定 ID>
ingest URL：<实际地址>
本地日志目录：<实际目录>
埋点范围：<请求/任务入口、Agent 生命周期、工具执行层>
测试命令与结果：<命令、通过数量或失败说明>
真实验证任务：<执行了什么无破坏性调用>
验证 trace_id：<实际 trace_id>
查询结果：<事件数量、完整的 start/end 或 error 链路>
Agent 日志入口：<可点击 URL>
目标 Agent Dashboard：<带 agent_id 的可点击 URL>
Dashboard 结果：<已由编码 Agent 确认 / 等待用户确认>
未完成项：<没有则写“无”>
```

只有 `Dashboard 结果` 已确认且“未完成项”为“无”时，才能声明目标 Agent 已完成日志接入改造。
