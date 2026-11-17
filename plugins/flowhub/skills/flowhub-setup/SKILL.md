---
name: flowhub-setup
description: 安装或迁移 FlowHub 插件、检查本机后台和 MCP 连接，处理数据目录与受限身份配置。适用于用户要求设置 FlowHub 或报告连接失败。
---

# FlowHub 本机连接

插件使用同包 Node 和 FlowHub 程序。先从插件根目录的 `docs/PLUGIN_PACKAGE.md` 读取本平台命令。

- 使用 `flowhub-plugin doctor` 检查当前连接及实际工具目录。报 `DAEMON_UNAVAILABLE` 时，根据用户的启动请求在独立终端运行 `flowhub-plugin start`。MCP 薄桥只连接服务，后台必须单独运行。
- 当前用户的连接引用保存在 Codex Home 下 `flowhub/connection.json`。默认使用本机 FlowHub 数据目录。自定义目录或受限身份通过 `flowhub-plugin configure` 设置。
- 保留已有受限身份的 `--token-file` 引用。换数据目录时使用目标实例生成的令牌文件，明确选择个人身份时才使用 `--personal`。
- 迁移电脑时选择目标系统和架构的原生包，重新登记插件来源。业务数据按管理页一致性备份、停机恢复流程迁移，使用备份时的管理员和 Vault 口令。
- 连接失败时核对服务是否运行、数据目录是否一致、身份是否撤销。只报告错误码和文件引用，凭据原值留在本机专用入口。

完成后核对 Codex 发现了 FlowHub 工具和这三个技能。个人编排身份为 21 工具，受限执行身份为 7 工具。以实际目录为准报告可用范围，再按用户任务继续。
