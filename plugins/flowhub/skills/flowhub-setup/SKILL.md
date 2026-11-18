---
name: flowhub-setup
description: 打开 FlowHub 管理页面，安装或迁移插件，检查后台和 MCP 连接，配置数据目录与受限身份。
---

# FlowHub 本机连接

插件使用同包 Node 和 FlowHub 程序。先从插件根目录的 `docs/PLUGIN_PACKAGE.md` 读取本平台命令。

用户点选插件提示“打开 FlowHub 管理页面”或提出同样请求时，从当前技能文件向上两级定位插件根目录，执行根目录下的 `flowhub-plugin url`（Windows 用 `flowhub-plugin.cmd url`）。如果未得到技能文件路径，用 `codex mcp get flowhub --json` 查找安装后的运行时位置。把实际返回的环回地址打开到 Codex 浏览器面板，或用包内 `flowhub-plugin open` 调用默认浏览器。回复中保留可点击地址。后台未启动时，说明当前实例离线，按用户意图显式启动。

- 使用 `flowhub-plugin doctor` 检查当前连接及实际工具目录。报 `DAEMON_UNAVAILABLE` 时，根据用户的启动请求在独立终端运行 `flowhub-plugin start`。MCP 薄桥只连接服务，后台必须单独运行。
- 当前用户的连接引用保存在 Codex Home 下 `flowhub/connection.json`。默认使用本机 FlowHub 数据目录。自定义目录或受限身份通过 `flowhub-plugin configure` 设置。
- 保留已有受限身份的 `--token-file` 引用。换数据目录时使用目标实例生成的令牌文件，明确选择个人身份时才使用 `--personal`。
- 迁移电脑时选择目标系统和架构的原生包，重新登记插件来源。业务数据按管理页一致性备份、停机恢复流程迁移，使用备份时的管理员和 Vault 口令。
- 连接失败时核对服务是否运行、数据目录是否一致、身份是否撤销。只报告错误码和文件引用，凭据原值留在本机专用入口。

完成后核对 Codex 发现了 FlowHub 工具和这三个技能。个人编排身份为 21 工具，受限执行身份为 7 工具。以实际目录为准报告可用范围，再按用户任务继续。
