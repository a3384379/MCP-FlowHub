基线为 71579a5288a95d7d09a66e0d43bac3088e79a79c。本轮仅修改下列 5 个分配文件；没有 build、提交、push，正式库、原 8 份用户资料、个人 Chrome、企业系统均未访问。源码 SHA-256 见 verification.json，最终全套回归由 root 统一执行。

- UI-01：幂等签名由 kind/workflowId/body 改成 method/完整目标路径/body。未确认请求仍保留原键，精确重试返回原运行；另一个 suite 即便请求体相同也使用新键。PUT 采用同样的身份绑定。
- UI-02：AI 生成任务成功后，读取实际套件期间仍保持加载锁。已有 dirty JSON 不被 acceptSuite 覆盖；新套件作为可见待切换结果，用户可暂存当前草稿后查看，再恢复原 suite 和原修订上的夹具草稿。草稿按 suite/revision 保留，恢复后的保存仍走原 CAS，不把新修订套到旧输入上。工作流 epoch、用户动作 intent、任务身份和 suite 修订共同拒绝晚回包。
- UI-03：终态 test 与当前 suite 每 1.5 秒只读刷新，窗口 focus 补读；活跃任务保留 300ms 周期。轮询串行、不自动 POST、不覆盖 dirty JSON；旧 suite GET 不得覆盖同工作流新保存。服务端真实 stale 结果可反映外部 suite、能力及绑定变化。
- CAP-01：ref 目标和合法 sibling 约束分别保存其字段与 Schema JSON Pointer，不推断合并后的有效 Schema。覆盖 sibling type/minimum/required、ref target 与组合子约束，继续限制 2048 次访问、24 层、64 条变化；无法解析/循环引用显式标诊断不完整。发布校验没有放宽。
- 新增证据展示修复：按实际 test.mode 将 Mock toolCalls 标为“模拟工具调用”，Contract/Live 标为“真实工具调用”，计数原值保留。

产品源码：apps/web/src/features/testing/TestingPanel.tsx、apps/web/src/features/testing/testing.css、packages/workflow-authoring/src/capability-drift.ts。独立测试：tests/ui/v2-testing-max-audit.spec.ts（8 项）和 tests/engine/v2-capability-drift-max-audit.test.ts（5 项）。未修改 backend/契约/依赖。

原反例保存在 ../ui-combos/audit.md、findings.json、browser-results.json、schema-drift-results.json。新增 UI 测试使用真实产品管理 API、临时 daemon/数据库、隔离 Codex home 和临时 Playwright browser；route 只丢弃/延迟真实回执。新 Schema 测试通过产品 native guard 和 validator 验证确有行为差异，并验证诊断与映射 Pointer，而非仅快照。

验证命令使用 /tmp/flowhub-v2-runtime/node-v24.19.0-darwin-arm64/bin 提前加入 PATH：

1. node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json：exit 0。
2. node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit：exit 0。
3. git diff --check：exit 0。
4. node node_modules/@playwright/test/cli.js test tests/ui/v2-testing-max-audit.spec.ts tests/ui/v2-testing-modes.spec.ts --reporter=line：exit 1，9/11 通过（19.0s）。原 3 项全部通过、新核心 6 项通过；新增两个夹具失败。Skill report 缺现有报告契约章节导致 ARTIFACT_INVALID；计数 fixture 的 lockedArguments 为空被现有管理契约拒绝。首轮失败 trace/error-context 完整保存于 first-fixture-failures/，摘要 first-run.json。
5. 仅重跑 discovered Skill changes|Mock call evidence：exit 1，1/2 通过（8.0s）。Mock 计数证明工具 trace 为 1、真实本地 SDK 服务工具调用为 0、产品 networkCalls 为 0；Skill 合成报告仍漏第 10 章“运行版本与限制”。第二轮 trace/error-context 保存在 second-fixture-failure/，摘要 second-run.json。
6. 补齐固定报告第 10 章，单跑 discovered Skill changes：exit 0，1/1 通过（4.2s）。实际发现 Skill 源变化使 capability 修订增加；draft 仍 r2、旧 run stale=true、UI 自动显示过期、没有第二次 run POST。
7. root 已报告新 engine 5 项全部通过。本分工没有独立再执行 dist engine 文件；统一完整 suite 结果由 root 记录。

以上 11 项当前都有通过证据，但分布于三轮，不能写成同轮 11/11。独立 max 原三反例与恢复原 CAS 场景通过证据见 ../ui-combos/after/browser-results.json（由独立审计分工执行）。最终产品源码从首次浏览器验收前冻结至此，后两轮只修了新增测试夹具。18479 已最终归还 root，后续不再启动或 build。
