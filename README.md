# MCP FlowHub

面向 Codex 等 AI Harness 的轻量级、可视化 MCP 能力编排与管理工具，优先服务个人开发者。配置一次工作流，之后由 Codex 选择并执行。

当前版本 **2.0.0-alpha.10**。统一管理多个 MCP Server，发现工具及参数，在画布编排执行链路，保存草稿并发布为不可变版本。对宿主始终只暴露一个 FlowHub MCP Server：个人编排入口固定21工具，原有受限 execution 身份保持七个执行工具兼容。

## 安装 Codex 插件

先准备 Codex 桌面端，以及支持 `codex plugin marketplace add` 和 `codex plugin add` 的 Codex CLI。离线包自带 FlowHub 的 Node 运行时和依赖。

### 获取离线安装包

- **Windows 10/11 x64**。登录 GitHub，进入 [main 分支的 Actions 构建记录](https://github.com/a3384379/MCP-FlowHub/actions/workflows/ci.yml?query=branch%3Amain)，打开一次成功的构建，在页面底部下载 **flowhub-rc-Windows**。解开 Actions 的下载压缩包，可选择里面的 `*-setup.exe` 或便携 `flowhub-*-win32-x64-*.zip`。
- **Linux x64**。在同一个构建页下载 **flowhub-rc-Linux**，解开外层压缩包和里面的 `.tar.gz`。
- **macOS 或其他受支持架构**。在目标平台使用 Node **24.19.0**、npm **11.9.0**，在仓库运行 `npm ci` 和 `npm run package:plugin`。输出位置见 `artifacts/latest-package.json`。Windows 如需重建便携包，在 Windows 上运行 `npm ci` 和 `npm run package:windows`。

Actions 构建包保留 14 天。构建包过期或缺失时，可以按上面的命令在目标平台重新打包。下载或转交安装包时可用同包的 `.sha256` 校验。Windows EXE 的说明见 [Windows 安装包指南](docs/WINDOWS_INSTALLER.md)。

### 登记到 Codex

1. 完整解压便携包并保留隐藏目录。插件目录是包含 `.agents/plugins/marketplace.json` 的那一级。如果使用 Windows EXE，先运行安装器，插件目录是所选安装位置下的 `app`，默认是 `%LOCALAPPDATA%\Programs\MCP-FlowHub\app`。
2. 在终端执行以下命令，将路径替换为该插件目录的绝对路径。带空格的路径保留双引号。

   ```text
   codex plugin marketplace add "<插件目录的绝对路径>"
   codex plugin add flowhub@flowhub-local
   ```

3. 重开 Codex 桌面端。支持全屏 MCP App 的版本可从左侧打开 **FlowHub**，再点 **打开完整管理页** 进入工作流画布。Codex 连接个人插件时会按需启动本机后台。
4. 在插件目录运行 `./flowhub-plugin status`（Windows PowerShell 用 `.\flowhub-plugin.cmd status`），可以查看插件登记、后台状态和 MCP 握手结果。在同一目录运行 `./flowhub-plugin open` 或 `.\flowhub-plugin.cmd open` 可以用浏览器打开管理页。

升级前创建一致性备份、退出 Codex 并停止现有 FlowHub 后台。若新包换了目录，先运行 `codex plugin marketplace remove flowhub-local`，再用新目录重复登记步骤。业务数据和连接引用保存在插件目录之外。详细步骤见 [插件包指南](docs/PLUGIN_PACKAGE.md)。

## 从源码启动

Node **24.19.0**、npm **11.9.0**：

    npm ci
    npm run build
    npm start

打开 [本机 FlowHub](http://127.0.0.1:18473/) 即可进入工作区。模型 Key 在「模型设置」填写，MCP 直连的令牌或环境变量在对应连接填写。服务重启后自动复用。带有旧版凭据的工作区升级时，用原口令迁移一次。另一个终端运行 `npm run mcp`，或按系统设置生成受限宿主配置。

    npm start -- --data-dir /tmp/flowhub-dev --port 18474
    npm run mcp -- --data-dir /tmp/flowhub-dev

Linux 数据目录默认为 $XDG_DATA_HOME/mcp-flowhub（未设置时 ~/.local/share/mcp-flowhub），Windows 为 %LOCALAPPDATA%\MCP-FlowHub。程序与数据分离。

## 能力

- MCP 连接、工具发现、Schema 指纹、固定环境绑定、资源与工具白名单。
- React Flow 画布，拖拽、连接、参数映射、Schema 编辑、保存、校验及不可变发布。
- 画布适配窗口大小，支持查看全图、定位起点和预览后导出 SVG。
- 串行与互斥分支；确定性 auto 与 Codex guided；预算、取消、幂等和明确的不确定结果。
- Agent 分析与宿主 Skill 交接，Markdown/安全 HTML 报告，执行步骤、参数、实际输出、耗时与证据索引。
- 业务输入、MCP 结果、Agent 输出和报告按原值保存及传递，不做业务内容自动替换。
- 模型 Key 与 MCP 凭据在各自页面配置，连接列表和配置导出只显示引用。管理会话与受限宿主身份独立。
- SQLite 一致性备份、停止服务恢复、结果保留与清理、仅含版本/计数/状态/错误码的诊断导出。
- 只读发现 Codex MCP、已安装插件和 Skills；能力来源、Schema、修订与 hub_direct/codex_host 边界清晰显示，凭据通过专用本地入口配置。
- Codex MCP 与网页助手共用草稿服务，原子改图、CAS、幂等、局部布局、撤销和持久化回执。网页 BYOK 明确选择 Responses 或兼容 Chat Completions。
- 无 Key 可生成确定性用例，Codex 可补充 Fixture 与断言；隔离 Mock 调用同一引擎，缺 Fixture 显示未覆盖，测试随草稿变更失效。
- 当前文档的中文 FTS5 帮助检索与引用；助手只按所选流程/运行读取上下文，不默认附加全部历史。

标准链路：日志 MCP → Agent 分析 → 条件 → 数据库 MCP（可跳过）→ 结果分析 → 报告 Skill。工具满足发布版本、有效配置、可用连接、正确绑定、有效参数及工具白名单后直接执行。没有人工审批节点、审批接口或业务脱敏开关。

Web 启动 guided 运行时选择接入设置中创建的受限宿主身份。只有所选 owner 可以通过 MCP 继续该运行，其他宿主不能接管；管理员仍可查看或取消。不要使用默认全权限令牌规避归属限制。

## 升级与验证

升级前创建一致性备份；旧流程处理见 [迁移指南](docs/MIGRATION_AUTOMATION.md)。不删除数据库，不改变旧发布快照。旧审批流程复制为新草稿后需校验并明确发布。旧活跃审批运行先自动备份再停止；已派发而结果不明的调用标为 OUTCOME_UNKNOWN，不自动重放。

    npm run check
    npm test
    npm run build
    npm run test:ui
    npm run package:local
    npm run test:package
    npm run verify:release

Windows 包必须由原生 Windows 构建和测试；macOS 结果不能替代。测试仅使用合成 MCP 与数据。当前本机 Codex App Server 的隔离MCP闭环已通过，真实模型30场景、实际公司服务、Windows仍待验收，不自动发布。详见 [2.0验收](docs/V2_ACCEPTANCE.md) 与 [升级回滚](docs/V2_MIGRATION.md)。

`npm run test:codex-local` 使用临时 Codex Home 进行真实宿主协议验收，不调用模型、不复制登录；`npm run test:upgrade-local` 在临时目录用实际旧版程序演练升级回滚。均不操作正式库。

[产品架构](docs/01_产品与架构设计.md) · [协议数据](docs/02_协议接口与数据设计.md) · [UI](docs/03_UI原型与交互规格.md) · [测试验收](docs/04_测试验收与云端交付.md) · [宿主接入](docs/HOST_INTEGRATION.md) · [安装核验](docs/LOCAL_VALIDATION.md) · [实施记录](docs/PLAN.md)
