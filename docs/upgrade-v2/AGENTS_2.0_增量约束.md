# 建议合并到现有 AGENTS.md 的 2.0 增量

不要用本文件覆盖现有AGENTS.md。阅读原文件后合并以下新需求，解决旧约束冲突，并保留与本轮无关的有效开发规则。

1. 继续在当前仓库增量开发，保留本地未提交修改和正式数据；分阶段本地提交，不默认push/merge/release。
2. 单一FlowHub MCP Server；原七执行工具保持兼容。2.0正式新增十四固定发现/编排/自测工具，工具总集合二十一个，不按工作流数量增长。
3. 不恢复人工审批或业务数据自动脱敏。环境绑定、凭据引用、owner、Schema和幂等继续保留。
4. 仅daemon写数据库；bridge只转发。Web/MCP/Assistant共用同一编排服务。
5. 发现Codex配置是只读行为；不自动安装插件或执行hooks，不把未知宿主能力标为可直接调用。
6. API Key与Codex登录态分开。无Key不能阻止手工功能、Codex编排和确定性Mock。
7. AI改图通过语义operations和CAS，禁止直接写SQLite、重写全部草稿或绕过发布校验。
8. 原生MCP结果保留content及structuredContent，不强制第三方输出FlowHub私有环境字段。
9. 测试生成与自测属于产品功能，必须经MCP暴露并通过真实SDK路径验证；Mock不能访问真实生产服务。
10. 冻结SQLite v1 DDL/checksum，采用顺序迁移；升级恢复、备份预检与打包同时更新。
11. 官方标为开发中的插件RPC不是生产前置依赖；适配以实际安装版本Schema/help为准。
12. 不将设计样例验证、Scripted模型、Linux测试称为真实产品、真实模型或Windows验证。
13. 所有结果区分已实现/已验证/未验证/阻塞，留存命令、退出码、版本、证据路径。
