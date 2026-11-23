# FlowHub 本地 Codex 插件

插件包含 FlowHub 程序、管理页面、本平台 Node 运行时、一个 MCP 入口和四个中文 Skill。无需登记官方目录；通过本地 marketplace 安装。业务数据与本机连接引用保存在包外，插件升级或移除不会删除它们。

## 构建与安装

开发机使用仓库固定的 Node 24.19.0、npm 11.9.0：

```sh
npm ci
npm run check
npm test
npm run package:plugin
npm run test:package
npm run test:plugin
```

`artifacts/latest-package.json` 指向本机系统和架构的候选目录与压缩包。把压缩包传到同系统、同架构电脑并完整解压，保留隐藏文件。包内有原始源码快照与校验清单；不包含本机数据库、Key、OAuth 或连接引用。其他系统或架构需要对应平台原生构建；不能把 macOS 包直接当 Windows 包使用。

在解压目录执行（路径含空格时保留引号）：

```sh
codex plugin marketplace add "/完整路径/解压后的FlowHub目录"
codex plugin add flowhub@flowhub-local
```

从 alpha.9 起，Codex 首次连接个人 FlowHub 插件时按需启动后台。打开侧栏即可使用，Codex 也可能在侧栏打开前预加载 MCP。启动器优先复用同一数据目录中健康的同版本后台。新进程使用默认环回端口 18473，关闭侧栏后继续运行。其他本机入口仍可在独立终端用 `./flowhub-plugin start` 前台运行。连接后检查：

```sh
./flowhub-plugin doctor
```

从 alpha.7 起，支持 MCP App 全局入口的 Codex 桌面端可在左侧导航打开 **FlowHub**。全屏应用通过官方 MCP Apps SDK 调用本机 FlowHub 工具，可以浏览工作流和草稿节点、查询能力目录、校验草稿结构、生成确定性用例和运行隔离 Mock 自测。左栏列出最近 100 条工作流，也可以按 ID 打开草稿。画布编排、连接和凭据管理通过顶部的 **打开完整管理页** 进入浏览器。

全屏应用直接使用 MCP UI 资源。其交互通过 Codex 的 MCP 桥接完成，无需访问本机 HTTP、嵌入子页面或获取管理会话。可打开完整管理页的本机地址随资源生成。

在 Codex 的 FlowHub 插件卡片也可选择 **打开 FlowHub 管理页面**。终端中可运行 `./flowhub-plugin open` 打开默认浏览器，或运行 `./flowhub-plugin url` 获取地址。命令使用连接配置中的数据目录与后台的实际端口，先检查后台是否健康。默认本机地址为 [http://127.0.0.1:18473](http://127.0.0.1:18473)。

alpha.4 起管理页打开后直接进入工作区。添加或调用受保护凭据时按页面提示设置或解锁凭据库。

Windows 使用原生 Windows 包，将 `./flowhub-plugin` 替换为 `.\flowhub-plugin.cmd`。Codex CLI 需支持 `plugin marketplace add`、`plugin add`；桌面端重开对话后检查插件和 MCP 是否加载。仓库证据记录实际测试的 Codex 版本，旧版兼容性以实际安装结果为准。

Windows EXE 安装器在详情中显示解压、写入文件数量和快捷方式登记，失败信息包含当前阶段。安装日志保存在 `%LOCALAPPDATA%\MCP-FlowHub-Installer.log`。构建时校验离线包的 SHA-256，安装时校验 EXE 和解压后的文件清单。同盘首次安装移动整个程序目录，升级会保留程序目录中的额外文件和独立数据目录。

升级前退出 Codex，并停止 FlowHub 后台。安装器会核查旧锁记录和 Windows 进程状态。确认锁记录中的 PID 已退出且没有相关进程运行时，可以保留旧锁完成升级。新版后台下次启动时会处理它。仍在运行的进程、无法核实的锁和预检期间出现的新锁会阻止安装。

升级或继续安装时，安装器保留已确认内容相同的文件。遇到短暂文件占用会重试，持续失败时弹窗和日志会显示受影响的程序文件路径。安装中断后可重新运行同一安装包，继续使用原程序和数据目录。

Windows 登录自启默认关闭。在稳定的包目录执行 `.\flowhub-plugin.cmd autostart enable`，可用 `--data-dir` 和 `--port` 明确指定实例。用 `autostart status` 查看计划任务，用 `autostart disable` 取消后续登录启动。通过安装器安装时，命令位于程序目录的 `app` 下。移动便携目录前从原路径取消自启，迁移后重新登记。PowerShell 或计划任务被企业策略拒绝时，可继续用前台 `start`。

`flowhub-plugin status` 分别显示 Codex 插件登记、所选 CLI 位置、daemon 健康、登录计划任务和实际 MCP 握手与工具列表。MCP 握手采用本机连接配置，桌面 Codex 的当前聊天加载情况仍以客户端为准。

也可在支持本地目录的 Codex 插件设置中添加这个目录内的 marketplace。正式目录上架不是本机安装的前置条件。若当前 Codex 还保留手工添加的旧 FlowHub MCP 入口，请自行选择一个入口使用，避免重复显示；安装命令不会删除现有配置。

## 本机连接与身份

首次默认复用 FlowHub 的本机数据目录：macOS/Linux 为 `$XDG_DATA_HOME/mcp-flowhub` 或 `~/.local/share/mcp-flowhub`；Windows 为 `%LOCALAPPDATA%\MCP-FlowHub`。自定义目录时先配置，再启动：

```sh
./flowhub-plugin configure --data-dir "/本机/FlowHub数据目录"
./flowhub-plugin start --port 18473
```

设置保存在 `${CODEX_HOME:-~/.codex}/flowhub/connection.json`，只保存绝对路径引用，不保存令牌。命令和 Codex 必须使用同一个 `CODEX_HOME`，否则各自读取自己的配置。

使用管理页面为受限客户端生成的令牌文件：

```sh
./flowhub-plugin configure --token-file "/本机数据目录/管理页面生成的令牌文件"
./flowhub-plugin doctor
```

个人身份有 21 个工具；受限身份保持原有 7 个执行工具。`doctor` 和插件连接使用同一身份。重复配置目录会保留已选身份；更换实例时必须指定新令牌，或显式 `--personal` 使用该实例的个人身份。失效的令牌或损坏配置会报错，不切换为个人身份。

STDIO 薄桥继续只转发，个人 Codex 插件清单使用单独的启动入口。受限身份和普通 STDIO 连接既有后台。个人模式由原 `project_help_search` 工具的空参数分支提供侧栏入口，带查询的帮助检索保持原行为。插件安装不运行 hooks，不安装其他插件。所有后台启动方式都使用同一份数据目录锁。系统确认旧锁记录的 PID 已退出时，启动器会通过 daemon 自动回收旧锁。看到版本冲突时，先退出运行中的旧版后台，再重开 FlowHub。停止终端中的服务可按 Ctrl+C。

## 四个技能

| Skill | 用途 |
| --- | --- |
| `flowhub-setup` | 安装、检查连接、配置数据路径和身份、迁移说明 |
| `flowhub-author` | 发现可用能力，创建/修改/校验真实工作流草稿 |
| `flowhub-run` | 启动已发布流程，按原 runId 接力并读取报告 |
| `flowhub-test-report` | 生成用例、运行隔离自测、读取报告并说明证据范围 |

例如请求 Codex：“使用 FlowHub 创建一个测试环境的工作流，先发现可用能力，生成确定性用例并运行 Mock 自测，列出实际证据和未验证项。”发布版本或启动真实运行依照用户任务范围进行。Skill 是操作指引，真实操作仍通过同一个 FlowHub MCP 和后台校验完成。

可以用 `flowhub:flowhub-setup`、`flowhub:flowhub-author`、`flowhub:flowhub-run` 或 `flowhub:flowhub-test-report` 明确选择技能。运行等待宿主时，从运行详情复制「Codex 续跑指令」并粘贴到具备原运行权限的 Codex 会话。

无需模型 Key 即可通过 Codex 编排和运行确定性 Mock。FlowHub 的 `ai_assisted` 使用原有 Vault 模型配置；插件不会复制 Codex 登录态或 OAuth。

## 迁移、更新、卸载

1. 仅搬程序：复制对应平台压缩包，在新电脑解压、添加 marketplace、安装插件并启动。新电脑会使用自己的本机数据；路径无需修改到 manifest 里。
2. 同时搬业务数据：在原实例通过管理页面生成一致性备份，把备份单独传到目标电脑；停止目标后台，使用包内 `flowhub restore --backup PATH --data-dir PATH`。恢复说明和口令要求见 [V2_MIGRATION.md](V2_MIGRATION.md)。保留备份时的管理员与 Vault 口令，重新核对本机绑定路径和客户端身份。不要复制运行中的 SQLite 文件。
3. 更新：参照 [迁移指南](V2_MIGRATION.md) 备份并确认当前运行已结束。保留外部数据目录与连接引用，使用新包重新添加来源、安装，再以同一数据目录启动新版后台。安装后用 `doctor` 核对工具范围。桌面侧栏仍提示「未能显示 FlowHub」时，完全退出并重新打开 Codex，让桌面端重新启动与后台版本匹配的 MCP 进程。
4. 卸载：`codex plugin remove flowhub@flowhub-local`。它移除插件登记，不删除后台数据或 `flowhub/connection.json`；停止后台另行按 Ctrl+C。不要将业务数据放进插件缓存。

## 交付边界与参考

每个包的 `build-info.json` 标识系统、架构、Node、源码身份；校验清单用于完整性检查，不代替安全认证。真实模型、企业权限和其他平台验收与本机合成测试分开记录。Windows 必须在 Windows 原生构建和测试。

- [OpenAI 插件包结构](https://developers.openai.com/plugins/build/plugins)
- [本地 MCP 与 PLUGIN_ROOT](https://developers.openai.com/plugins/deploy/desktop-only)

本轮验证记录见 [插件交付证据](evidence/plugins/20261118/VALIDATION.md)。

已安装插件的完整链路可执行 `npm run test:plugin:e2e`，使用固定 Node/npm。它从当前 Codex 的实际 FlowHub MCP 配置解析安装目录，校验安装文件，再在独立 Codex Home 和数据目录中通过真实宿主调用插件。用户本机仅进行静态元数据读取，真实工具调用只进入本地合成服务。结果写入 `artifacts/latest-plugin-e2e.json` 指向的目录；后台在结束时停止，隔离数据保留在该目录的 `private/` 便于排查，不进入 Git 或程序包。当前完整实测结果及限制见 [端到端测试](evidence/plugins/20261118/END_TO_END.md)。
