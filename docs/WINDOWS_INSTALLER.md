# Windows 安装包

目标为 Windows 10/11 x64 的当前用户离线安装器。安装不需要另外安装 Node 或运行 npm；Node 和 Windows 原生 SQLite 模块随包交付。安装器属于未签名候选版本，企业准入和真实 MCP 联调仍需单独验收。

安装与使用：

1. 下载与校验 `flowhub-<版本>-windows-x64-setup.exe` 及对应 `.sha256`。
2. 运行安装器，默认程序目录为 `%LOCALAPPDATA%\Programs\MCP-FlowHub`。
3. 开始菜单选择 **Start FlowHub**，保留服务控制台窗口；再选择 **Open management** 打开本机管理页面。
4. 按页面提示完成首次管理员设置。用户数据保存在独立的 `%LOCALAPPDATA%\MCP-FlowHub`，其中的设置码和凭据不应外发。
5. 停止服务时在控制台按 Ctrl+C；先退出使用该安装目录的 MCP 桥接，再执行升级或卸载。安装器遇到运行中的应用会拒绝操作，不强杀进程，也不删除锁。

卸载通过系统“已安装的应用”或开始菜单的卸载入口完成。卸载保留数据库、凭据、备份和额外用户文件；需要清理数据时，应在确认服务停止并检查备份/保留要求后单独操作。不要将数据目录放进程序目录。

原生构建：

```powershell
npm ci
npm run check
npm test
npm run package:windows
npm run test:package
npm run verify:release
npm run installer:windows -- --nsis-archive C:\tools\nsis-3.11.zip
npm run test:installer:windows
```

使用锁定的 Node 24.19.0、npm 11.9.0。NSIS 3.11 的官方 URL 和 SHA256 固定在 `installer/windows/toolchain.json`；构建器校验归档后在临时目录解压，不使用系统中未经核验的编译器。Linux 不运行 Windows 安装器构建，也不复用 Linux 原生依赖。

仓库 CI 的 Windows job 执行上述原生门禁，并在 Actions artifact 中保留 `.exe`、Windows ZIP、SHA256 和安装测试结果。安装测试包含中文/空格路径、包内运行时和 SQLite、命令入口、运行中拒绝重装/卸载、同版本重装保留数据、卸载保留数据和额外文件。同版本重装不代表未来数据库版本迁移或回滚已通过。测试使用隔离生成的数据；若当前机器已有默认用户数据，安装冒烟会拒绝运行以保护已有数据。

Windows CI 成功记录仅证明其实际执行的自动化范围。不得以 Linux 检查或文件哈希代替 Windows 原生运行、代码签名或企业授权。
