# FlowHub alpha.6 桌面内嵌拦截验证

2026-11-18 在 ChatGPT 桌面版 26.1111.21308 实际点开 alpha.5 侧栏。日志显示 Codex 调用了 FlowHub 启动工具并加载了全屏 MCP App。随后宿主 `frame-src` 拒绝了 `http://127.0.0.1:18473/codex`，并记录 `ERR_BLOCKED_BY_CSP`。同一后台健康检查成功，Codex 内置浏览器顶层页面打开了完整工作流库，显示原有 3 条工作流。

alpha.6 在遇到宿主拦截时显示明确原因、浏览器打开入口和本机地址。在宿主支持 MCP Apps 链接请求时，通过 `ui/open-link` 请求打开该页面。使用的本机地址只包含环回地址及端口。侧栏直接内嵌仍取决于 Codex 的宿主策略。

| 验证 | 结果 |
| --- | --- |
| `npm run check`、`npm test` | 检查通过，545 项后端测试通过。 |
| `npm run test:ui -- tests/ui/codex-sidebar.spec.ts` | 实测允许嵌入时保存并读取草稿，阻止嵌入时显示备选入口并发送预期的环回 URL。链接请求由隔离宿主接收。 |
| `npm run package:plugin`、`npm run test:package`、`npm run verify:release` | 离线包、源码快照、篡改负例和权限范围通过。 |
| `npm run test:plugin:e2e` | 9 个阶段通过，真实 Codex App Server 可以读取新版侧栏资源。 |
| 本机安装 | 升级前一致性备份通过预检。alpha.6 已运行，3 条工作流及凭据、连接、模型配置、发布版本和其他 Codex 配置的摘要一致。 |

包源码提交为 `57dc73198dd7f8dc57b058b4ce73cdcc69882cf3`，归档 SHA-256 为 `399306515a5aca2d1cd202572234caadf881b4cd98bab6a9da8941e374d94760`。日志与验证回执保存在 `artifacts/alpha6-verification/`。真实桌面上的新版备选链接未点按验证。
