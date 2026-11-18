# FlowHub alpha.5 Codex 侧栏验证

2026-11-18 在 macOS arm64 使用 Node 24.19.0、npm 11.9.0、ChatGPT 桌面端 26.1111.21308 和 Codex CLI 0.169.0-alpha.11.1。安装包源码提交为 `5627050d607a5d10fcab97a47383e7eac8c5eacb`。

本机个人插件登记 FlowHub 全局入口。入口复用原管理页，通过一次性启动凭据和分区 Cookie 访问同一 daemon。普通管理页继续拒绝嵌入。受限宿主和普通 STDIO 保留原工具接口，未增加工具数量。

| 验证 | 结果 |
| --- | --- |
| `npm run check`、`npm test` | 类型和设计检查通过，545 项后端测试通过。 |
| `npm run test:ui` | 95 项通过。隔离 Chromium 在为测试宿主授予回环访问权限后，通过真实 MCP 资源打开管理页，编辑并保存画布草稿，切换设置并重读草稿。重放启动凭据和缺少启动凭据被拒绝。 |
| `npm run package:plugin`、`npm run test:package`、`npm run verify:release` | macOS arm64 离线包、源码快照和篡改负例通过，保留 21/7 工具边界。安装归档 SHA-256 为 `0ebeb49a827c2b8efa7990f7e0b4cd646f97f20f07f30a991a04b48f4b2412a9`。 |
| `npm run test:plugin:e2e` | 候选包和正式安装字节各通过 9 个阶段。真实 Codex App Server 返回全局入口、读取 UI 资源并完成空参数启动调用。浏览器宿主渲染由上项隔离测试覆盖。 |
| 本机升级 | 确认任务空闲，创建一致性备份并通过预检。已安装 alpha.5，后台健康。3 条工作流、0 条运行的清单及凭据、连接、模型配置、发布版本和其他 Codex 配置的摘要一致。 |

桌面自动化禁止点按 Codex 自身的侧栏。本机 App Server 已验证入口协议，实际桌面图标出现及点开仍待人工确认。Windows、真实模型和企业环境未在本轮复验。

本机证据在 `artifacts/alpha5-verification/` 和 `artifacts/flowhub-alpha5-local-upgrade.json`。入口机制见 [OpenAI 侧栏应用文档](https://developers.openai.com/plugins/build/extensions#sidebar-apps)。
