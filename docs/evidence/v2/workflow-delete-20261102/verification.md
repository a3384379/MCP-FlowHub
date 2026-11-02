# 工作流删除功能验证（2026-11-02）

基线 df51c7b，原 checkout，分支 feat/workflow-delete。原有未跟踪审计资料 8/8 哈希保持不变，不纳入提交。使用固定 Node24.19.0/npm11.9.0；系统默认 Node22.22.0 未替换，所有构建/测试命令显式使用固定运行时 PATH。

## 实现

- 工作流卡片左下角“删除”，确认名称和 ID；取消不写数据，待请求期间禁用重复提交，失败在确认框显示。桌面和 390px 手机截图已经查看；修复了首次手机确认框右沿超出窗口的问题。
- 管理员 DELETE /api/v2/workflows/:id，由 Authoring Service 在同一事务完成语义/布局双 CAS、幂等回执、审计和 workflow.deleted 事件。会话、CSRF、If-Match 和删除 DTO 均校验；不扩展固定 21 MCP 工具，不给助手增加删除权限。
- 在 workflows 原 JSON 中记录 deletedAt/deletedBy，置 enabled=false 并推进 revision；不改 DDL/checksum，不清除不可变版本、运行、报告、授权、连接或凭据。删除状态进入原有备份和 source snapshot。
- 有活跃运行、自测或选中/已调用该流程的助手任务时拒绝删除。真实 Mock → WAITING_AGENT → 拒绝删除 → 取消 → 允许删除的链路已执行。这里是真实引擎和合成 Mock，不是公司系统验证。
- 工作流库及 MCP 搜索不再返回该流程；旧 Web/MCP 保存、发布、启动、启用、选择默认版本或同 ID 导入均不能复活它。种子恢复也不能复活已删样例。已有运行状态和 artifact_read 继续按原 owner 权限读取。
- 跨窗口删除事件移除列表项；当前画布未保存内容仍保留，可查看 DSL 复制，保存/发布停止。旧列表 HTTP 回包也不能把已删除项重新放回列表。

## 验证结果

最终结果将在本地交付完成后补齐。专项：后端删除 6/6、浏览器删除 3/3 已通过；首轮完整后端 417/417、完整 UI 77/77 已通过。新增实际等待宿主用例第一次因合成 Vault 未初始化返回 CREDENTIAL_LOCKED；补齐夹具初始化后，该真实取消链路已通过，未放宽产品凭据校验。最终 418 项全量后端和 77 项 UI 复验中。

命令：npm run check；npm test；npm run test:ui；node --test dist/tests/engine/workflow-deletion.test.js；npm run test:ui -- tests/ui/editor-regressions.spec.ts --grep 'workflow library deletion|stale deletion|external deletion'。离线候选包按 npm run package:local、npm run test:package、npm run verify:release 单独记录。

原始日志、截图及当前提交的包/正式服务保护证明保存在本机 artifacts/workflow-delete/。所有删除测试均使用隔离临时库；没有对正式工作流执行删除。正式服务更新前须核验无活动任务、API 一致性备份和恢复预检，更新后核对受保护业务表。

## 边界

未在此增量执行 Windows 原生 UI/安装验证或真实企业 MCP/模型接入；先前 PR #4 的 Windows 成功不能代替本次验收。没有恢复人工审批或业务自动脱敏，没有 push、merge 或发布 Release。删除不会物理释放历史数据空间，历史仍按既有保留策略管理；当前不提供已删除 ID 的直接恢复入口。
