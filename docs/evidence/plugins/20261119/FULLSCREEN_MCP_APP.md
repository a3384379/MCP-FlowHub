# FlowHub alpha.7 全屏 MCP App

2026-11-19 在 macOS arm64 构建并更新本机插件。全屏资源使用官方 MCP Apps SDK，经现有 FlowHub MCP 读取工作流、草稿和能力目录，并支持结构校验、生成确定性用例和隔离 Mock 自测。资源无子页面、联网白名单和管理会话凭据。完整画布与系统设置从顶部入口打开。

| 验证 | 结果 |
| --- | --- |
| `npm ci --no-audit --no-fund`、`npm run check` | 固定 Node 24.19.0 和 npm 11.9.0，依赖和检查通过。 |
| `npm test` | 545 项通过。 |
| `npm run test:ui -- tests/ui/codex-sidebar.spec.ts` | 隔离宿主开启 `frame-src 'none'`、`connect-src 'none'`。实际 MCP 调用读取并校验隔离草稿、生成用例、完成 Mock 自测。自测记录的业务网络调用和真实凭据读取均为 0。验证能力检索、刷新、浏览器链接和 390px 布局。 |
| `npm run package:plugin`、`npm run test:package`、`npm run verify:release` | macOS arm64 离线包及篡改负例通过。首次包目录验证发现 Finder 新增的 `.DS_Store`，移出该构建目录后验证通过。归档哈希一致。 |
| `FLOWHUB_PLUGIN_CANDIDATE=… npm run test:plugin:e2e` | 使用隔离 Codex Home 通过 9 个阶段。真实 Codex App Server 0.169.0-alpha.11.1 读取全屏资源、调用入口并收到专供 UI 的工作流索引。 |
| 本机切换 | 备份预检兼容，切换前运行、自测、助手和发现任务均空闲。alpha.7 缓存和本机后台匹配，21 个工具。工作流、发布版本、连接、绑定、密文、模型、对话及自测等表摘要一致。3 条工作流保留，Vault 状态、连接引用及其他 Codex 配置等效。 |

包源码提交为 `f31cfca1a2a79f9e68383fc9e7933a7881f4badd`，归档 SHA-256 为 `782e6519a0eeef5234355fd077ed1dc9affee311d8340b903ee661e88f301a9f`。本地日志位于 `artifacts/fullscreen-mcp-app-20261119/`。

首次桌面点击返回 `Resource not found`。桌面进程 26.1111.71025 复用了更新前启动的 alpha.6 STDIO 桥，而安装后的工具配置和 daemon 均已是 alpha.7。

2026-11-19 07:41（北京时间），用户完全退出并重新打开桌面客户端。日志记录新版 STDIO 桥启动、侧栏读取 alpha.7 UI 资源并调用 `workflow_draft_get`。用户截图确认 Codex 内已渲染全屏应用，显示 3 条本机工作流，且可打开草稿 r1 并读取两个节点。

生成用例与 Mock 自测通过隔离验收。此轮实机截图覆盖侧栏打开、工作流列表和草稿详情。真实模型、企业连接和 Windows 原生环境未验证。
