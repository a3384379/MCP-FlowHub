# Windows 安装包

目标为 Windows 10/11 x64 的当前用户离线安装器。安装不需要另外安装 Node 或运行 npm；Node 和 Windows 原生 SQLite 模块随包交付。安装器属于未签名候选版本，企业准入和真实 MCP 联调仍需单独验收。

安装与使用：

1. 下载与校验 `flowhub-<版本>-windows-x64-setup.exe` 及对应 `.sha256`。
2. 运行安装器，默认程序目录为 `%LOCALAPPDATA%\Programs\MCP-FlowHub`。
3. 开始菜单选择 **Start FlowHub**，保留服务控制台窗口；再选择 **Open management** 打开本机管理页面。
4. 打开页面即进入本机工作区。模型 Key 和 MCP 直连凭据分别在模型和连接页面直接填写。旧版已有凭据时按提示用原口令迁移一次。数据保存在独立的 `%LOCALAPPDATA%\MCP-FlowHub`。
5. 停止服务时在控制台按 Ctrl+C；先退出使用该安装目录的 MCP 桥接，再执行升级或卸载。安装器遇到运行中的应用会拒绝操作，不强杀进程，也不删除锁。

卸载通过系统“已安装的应用”或开始菜单的卸载入口完成。卸载保留数据库、凭据、备份和额外用户文件；需要清理数据时，应在确认服务停止并检查备份/保留要求后单独操作。不要将数据目录放进程序目录。

如需登录自启，在安装目录的 `app` 下运行 `.\flowhub-plugin.cmd autostart enable`。任务使用当前 Windows 用户和包内 Node，数据默认取本机 FlowHub 目录。默认目录的任务随同路径重装保留，卸载会移除归属本安装的任务。为自定义数据目录登记的任务使用原命令和对应 `--data-dir` 取消。

原生构建：

也可在配置好下述固定 Node/npm 的干净 Windows 构建账户中运行根目录 `Build-Windows.cmd`。它按顺序执行同一套检查和构建，打印失败阶段与产物路径；不会修改全局工具、TLS 或 PowerShell 执行策略。PowerShell 脚本能否执行需符合组织策略。该入口和源码包本身不代表已通过 Windows 安装验收。

```powershell
npm ci
npm run check
npm test
npm run package:windows
npm run test:package
npm run verify:release
node --use-env-proxy scripts/fetch-nsis.mjs --output .\artifacts\toolchain\nsis-3.11.zip --diagnostics .\artifacts\nsis-download-diagnostics.json --pin .\installer\windows\toolchain.json
npm run installer:windows -- --nsis-archive .\artifacts\toolchain\nsis-3.11.zip
npm run test:installer:windows
```

使用锁定的 Node 24.19.0、npm 11.9.0。NSIS 3.11 的官方 URL 和 SHA256 固定在 `installer/windows/toolchain.json`；构建器校验归档后在临时目录解压，不使用系统中未经核验的编译器。Linux 不运行 Windows 安装器构建，也不复用 Linux 原生依赖。

下载器依次尝试固定的 SourceForge 规范地址与官方镜像，每次验证 HTTPS 地址、下载限额、ZIP 文件头和同一个固定 SHA256；HTTP 200 返回的 HTML 页面也会被拒绝。缓存同样必须重验。实际下载的状态、内容类型、字节数和哈希写入 `artifacts/nsis-download-diagnostics.json`；所有来源失败便停止，不执行未知文件。`--use-env-proxy` 让 Node 保留当前环境的代理配置，不关闭 TLS 校验。

仓库 CI 的 Windows job 执行上述原生门禁，并在 Actions artifact 中保留 `.exe`、Windows ZIP、SHA256 和安装测试结果。安装测试包含中文/空格路径、包内运行时和 SQLite、命令入口、运行中拒绝重装/卸载、同版本重装保留数据、卸载保留数据和额外文件。同版本重装不代表未来数据库版本迁移或回滚已通过。测试使用隔离生成的数据；若当前机器已有默认用户数据，安装冒烟会拒绝运行以保护已有数据。

Windows CI 成功记录仅证明其实际执行的自动化范围。不得以 Linux 检查或文件哈希代替 Windows 原生运行、代码签名或企业授权。
