---
name: flowhub-test-report
description: 通过 FlowHub MCP 生成工作流用例、运行隔离 Mock 自测并读取执行报告，解释覆盖缺口和失效证据。适用于用户要求测试或核查 FlowHub 工作流。
---

# FlowHub 用例、自测和报告

先通过 `workflow_draft_get` 或 `workflow_get` 确认用户选择的流程、修订或发布版本。查看实际 MCP 参数 Schema 后构造请求。

- `workflow_test_generate` 使用 `deterministic` 生成基础用例，或用 `agent_proposed` 提交基于真实图和 Schema 的合成输入、Fixture 与独立断言。`ai_assisted` 使用用户已有的 FlowHub 模型配置。
- 使用 `workflow_test_run` 的默认 Mock 运行合成用例，通过 `workflow_test_status` 读取终态、每项独立断言和未覆盖分支。生成成功、自测成功、生产连接验证分别记录。
- 缺 Fixture、未访问分支、基线失效或断言未执行时，保留服务端给出的限制。编辑草稿或来源变化后重新生成当前基线的用例。
- Contract 和 Live 按实际工具 Schema 的支持情况使用。Live 需要用户明确要求实际调用及具体范围，沿用既有绑定、权限和预算。
- 使用 `workflow_status` 的实际 artifactId，通过 `artifact_read` 分页读取报告。按 UTF-8 字节范围获取，保留截断和缺失说明。

交付 suiteId、testRunId 或 runId、实际验证级别、独立断言结果、覆盖缺口及报告引用。合成验证、真实模型效果、企业权限和平台验证分别说明。
