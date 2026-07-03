# TODOs

## v1.4 实现前必须确认

- [ ] 确认飞书 Bot 是否提供固定 `callbackUrl` 接收 `audit_review_summary`。
- [ ] 确认第一版 high-risk tool allowlist/denylist，至少覆盖写入、删除、权限、批量变更、shell/browser script 类工具。
- [ ] 确认 Dashboard 访问方式：仅本机、内网代理、固定机器 IP，或其他部署地址。
- [ ] 确认飞书卡片 MVP 是否只展示摘要 + Dashboard 链接，还是同步支持确认/忽略 finding。

## P1 实现任务

- [ ] 为审查调度实现数据库租约锁 `audit_review_locks`，覆盖定时任务、手动触发和多进程误启动。
- [ ] 实现 server 启动恢复：将 stale `audit_review_runs.status = 'running'` 标记为失败或恢复态，并释放过期租约。
- [ ] 为 Dashboard 和 `/v1/audit-*` API 增加访问控制：loopback 默认、本机外监听强制 token、手动触发 API 强制鉴权、CORS 默认同源。
- [ ] 新增 LLM 审查 eval 数据集，覆盖高危权限、连续失败、重复调用、良性重试误报抑制、LLM 降级结果。
- [ ] 审查系统自身写入 runtime audit events：`review.start`、`review.ingest.completed`、`review.llm.completed/error`、`review.notification.enqueued`、`review.completed`、`review.recovered`。

## P2 实现任务

- [ ] 新增 `audit_ingest_cursors`，按文件 path/mtime/size/offset 增量读取日志，避免大文件每轮完整扫描。
- [ ] 完善 `audit_review_findings` 生命周期：`last_seen_at`、`occurrence_count`、`last_notified_at`、`resolved_at`、`snoozed_until`。
- [ ] 调整 `finding_hash`，不要包含 severity；同一问题升级/降级时更新原 finding。
- [ ] 为风险策略、LLM prompt、reviewer 流程记录版本：`risk_policy_version`、`prompt_version`、`reviewer_version`。
- [ ] 实现数据保留与清理任务：review runs、resolved findings、delivered/dead_letter outbox、失效 ingest cursors。
- [ ] Dashboard 通用模板落地：总览页、审查详情页、finding 详情页复用同一布局、组件和视觉规范。

## 测试与验收

- [ ] 单元测试：租约获取/刷新/过期抢占、stale review recovery、文件游标、finding 生命周期、Dashboard/API 鉴权。
- [ ] 集成测试：临时日志目录采集、mock LLM 审查入库、outbox payload/retry、Dashboard 模板渲染。
- [ ] Eval 测试：每次修改 `risk_policy_version` 或 `prompt_version` 都运行 `test/evals/auditReview/*`。
- [ ] 手动烟测：写入失败/重复日志，手动触发审查，确认 finding 入库、飞书摘要包含 `dashboard_url`、Dashboard 详情可打开。

