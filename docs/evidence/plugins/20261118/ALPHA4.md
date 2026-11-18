# FlowHub alpha.4 本机免登录验收

2026-11-18 在 macOS arm64 使用 Node 24.19.0、npm 11.9.0 与 Codex CLI 0.169.0-alpha.11.1。受测代码与安装包源提交为 `bf0c919ecf3da7632bb6ad26e4df7de221d0caba`。

管理页直接进入本机工作区，保留 Cookie 会话、回环同源检查和写请求 CSRF。旧登录接口留作兼容。新库需要存入凭据时单独设置 Vault 口令，已有 Vault 使用原口令。没有新增 SQLite 迁移或 MCP 工具。

| 命令 | 实际结果 |
| --- | --- |
| `npm run check` | TypeScript 通过。设计检查 37 项正例和 65 项负例通过。 |
| `npm test` | 545 项通过。涵盖回环来源检查、CSRF、会话复用、淘汰最久未使用的会话、Vault 初始化保护及 MCP 身份隔离。 |
| `npm run test:ui` | 94 项通过。空库直接打开、单独设置和锁定凭据库、会话恢复时保留编辑内容、写请求需手动重试。 |
| `npm run package:plugin`、`npm run verify:release` | 从干净的提交构建并校验 macOS arm64 离线包、源码快照与 SBOM。归档 SHA-256 为 `8f08fdac87d94e86bda0c8f074afe24917532aeb59015f4ea334edc202804504`。 |
| `npm run test:package`、`npm run test:plugin` | 归档解压校验、篡改负例、真实 Codex 加载与 21/7 工具权限检验通过。 |
| `npm run test:plugin:e2e` | 9 个阶段通过。隔离 Codex 安装、免登录管理页、中文能力发现、编排、用例生成、Mock 正反例、发布、宿主交接和报告读取均取得回执。 |

首次全量 UI 发现旧会话上限和重连时清除编辑错误提示的问题。修复后重新运行全量后端与 UI。首次离线目录出现变化的 Finder 元数据，改为在隔离构建目录重新出包并重验新归档，安装使用上表记录的归档。

本机升级在旧 daemon 确认空闲后执行。SQLite 一致性备份通过兼容性预检。新后台通过免登录接口读出工作流、发布版本、运行、凭据引用、连接、绑定、模型配置和客户端。升级前后结果摘要一致，3 条工作流和 0 条运行的清单保持一致。插件配置未修改其他项目，本机实例继续使用同一个数据目录。服务重启后 Vault 按设计锁定。

完整日志、端到端回执与浏览器截图保存在本机 `artifacts/alpha4-verification/`。Codex 原生侧栏入口、Windows、真实模型效果和企业 MCP 环境未执行本轮验收。
