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

最终本机结果：npm run check 退出 0；npm test 418/418、0 失败、0 跳过；npm run test:ui 77/77；删除后端专项 6/6、删除浏览器专项 3/3。新增实际等待宿主用例第一次因合成 Vault 未初始化返回 CREDENTIAL_LOCKED；补齐夹具初始化后，专项及完整回归均已通过，未放宽产品凭据校验。

固定运行时的 npm run package:local、npm run test:package、npm run verify:release 均退出 0，实际执行包内程序、现代/legacy 协议与篡改拒绝。候选包在该提交的干净临时 checkout 构建，build-info.gitSha 与构建提交一致，dirty=false。验证记录提交后重建最终候选，包及源码快照按最终提交再次核对；最终 SHA、归档哈希和清理记录见本机 artifacts/workflow-delete/package-verification.json。macOS 成功不代表本次 Windows 已验证。

命令：npm run check；npm test；npm run test:ui；node --test dist/tests/engine/workflow-deletion.test.js；npm run test:ui -- tests/ui/editor-regressions.spec.ts --grep 'workflow library deletion|stale deletion|external deletion'。离线候选包按 npm run package:local、npm run test:package、npm run verify:release 单独记录。

原始日志、截图及当前提交的包/正式服务保护证明保存在本机 artifacts/workflow-delete/。所有删除测试均使用隔离临时库；没有对正式工作流执行删除。正式服务从 PID77711 平滑重启至 PID3006、端口18473；前后无活动任务，API 一致性备份及恢复预检均成功，24 张受保护业务表数量和哈希完全一致，Vault 保持原解锁状态。实际提供的 HTML/JS 与新构建字节一致，SSE 断开后健康检查通过。新 DELETE 路由用不存在 ID 且缺少 If-Match 的请求验证返回428，在工作流查找和写入前拒绝。

## 边界

未在此增量执行 Windows 原生 UI/安装验证或真实企业 MCP/模型接入；先前 PR #4 的 Windows 成功不能代替本次验收。没有恢复人工审批或业务自动脱敏，没有 push、merge 或发布 Release。删除不会物理释放历史数据空间，历史仍按既有保留策略管理；当前不提供已删除 ID 的直接恢复入口。
