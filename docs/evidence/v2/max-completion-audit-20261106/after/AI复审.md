# AI 修复独立复审

结论：原 AI-01、AI-02、AI-03 在此次冻结源码及对应 dist 上均已关闭；AI-OBS-01 的生成来源问题也已补齐。本次未发现仍开放的 AI 范围缺陷。

本次命令退出码 0，独立复现检查 **21/21 通过**：

```sh
/tmp/flowhub-v2-runtime/node-v24.19.0-darwin-arm64/bin/node artifacts/max-completion-audit-20261106/ai/after-audit-repro.mjs
```

环境为 Node v24.19.0、macOS arm64，全部 SQLite 在内存中；网络仅访问脚本自身启动的 loopback 合成 Provider。未调用真实模型、未访问正式库、未修改产品文件。root 的 `build-server.log` 显示 OpenAPI 生成及 tsc 命令正常输出；该纯文本日志不包含退出码，构建实际退出码由 root 执行结果负责。源码和对应 dist 的 SHA-256 已保存在 `after-evidence.json`，不是用旧 HEAD 单独代表未提交修复内容。

| 原问题 | 修复核查及独立实际结果 | 状态 |
|---|---|---|
| AI-01：JSON 转义绕过 Key 检查 | `AssistantCore.proposeTestCases` 先解析 JSON，再由 `Vault.assertNoCredentialLeak` 检查所有解码后的键和值。字面值、全 Unicode、混合转义分别通过 tool arguments 与 text JSON 返回，6 组均 `FAILED/MODEL_OUTPUT_INVALID`，0 套件，任务/消息/工具账本无受管凭据副本。 | 关闭 |
| AI-01：只检查当前模型 Key | 嵌套值、嵌套键、旧式实际连接 secretRef、标为 mcp_config 但实际被认证 secretRef 引用的值，均拒绝。测试凭据包含引号、反斜杠、换行。纯 mcp_config、旧式仅普通配置引用、业务 token/password/email/URL 和嵌套类型均精确保留。 | 关闭 |
| AI-01：凭据先进入生成任务上下文 | `AiTestGenerator.accept` 在创建 task/command 前校验，Assistant 在模型派发前再次校验。工作流名称、Schema 属性键、scenarioHints 分别放入受管认证值时，均 `MODEL_CONTEXT_SENSITIVE`，0 HTTP、0 task、0 test.generate command。 | 关闭 |
| AI-02：一轮生成暗含三次 HTTP | AI 请求明确设置内部 `maxAttempts:1`，HTTP 适配器在重试循环中执行约束。429 现在只发 1 次 HTTP，任务 `FAILED/MODEL_RATE_LIMITED`，modelCalls=1，同幂等请求重放不再发 HTTP。 | 关闭 |
| AI-02：保持普通助手有界重试 | 普通助手遇 429、429、成功时仍在第 3 次请求完成；默认全失败最多 3 次；非法预算未派发；等待重试时取消，只有 1 次 HTTP。内部 maxAttempts 没有进入 Provider 请求 JSON。 | 关闭 |
| AI-03：缺失目标或错误引用以 null 通过 | 原缺 nodeId 的 node_state、ghost output_equals 提案均 `FAILED/INPUT_INVALID`、0 套件。合法现存节点但缺失输出路径的 null 比较运行失败，断言 passed=false、evaluated=false、REFERENCE_MISSING。 | 关闭 |
| AI-OBS-01：编辑夹具丢生成来源 | 原 AI 套件经 agent_proposed 保存相同 Fixture 后，latest generatedBy 为 agent_proposed，同时保留初始 generationRef、generationSource=ai_assisted，以及 r1 AI / r2 agent_proposed 的 revisionSources。 | 已补齐 |

本次是修复范围内的独立源码与合成复验；不是全量后端/UI、真实模型或正式环境验收。原 `audit-repro.mjs` 和 `evidence.json` 保留旧缺陷反例，本次使用单独 after helper，不会把旧缺陷断言在修复后失败误报为回归。
