# 本地候选设备核验清单

这份清单**不是通过记录**。只用合成数据，无需额外模型 API Key 或企业地址。

## 开发机

1. Node 24.19.0、npm 11.9.0：`npm ci`、`npm run check`、`npm test`。
2. `npm run package:local`（原生 Windows 用 `npm run package:windows`），然后 `npm run test:package`、`npm run verify:release`。
3. artifacts 包含候选包、SHA-256。包内 build-info 记录基线 SHA、dirty 和源码摘要，不把未提交修改冒充已提交结果。
4. Windows CI 真实成功后才记录 Windows 通过；Linux 不交叉制作 Windows 包。

## 公司批准 Windows 设备（待核验）

1. 确认运行时、目录、端口、子进程、持久化与 Codex 合成接入获准。若不允许，记录 BLOCKED，采用 IT 批准替代路径，不绕过。
2. 获取经审查 Windows CI ZIP，`Get-FileHash -Algorithm SHA256` 对照独立可信渠道的 SHA-256；哈希不是签名。
3. 在批准的中文/空格路径解压，另设批准数据目录。不要覆盖已有用户数据。Windows ACL 必须限制到当前用户，不能以 chmod 代替核验。
4. 在无 npm 下载条件下执行（替换为批准路径）：

   ```powershell
   .\flowhub.cmd serve --data-dir 'D:\批准数据目录\FlowHub'
   # 另一个终端
   .\flowhub.cmd doctor --data-dir 'D:\批准数据目录\FlowHub'
   .\flowhub.cmd mcp --stdio --data-dir 'D:\批准数据目录\FlowHub'
   ```

5. 宿主 command 设置为包内 runtime/node.exe；args 数组为包内 dist/apps/daemon/src/cli.js、mcp、--stdio、--data-dir、批准目录。不拼接 shell，不把 token 放宿主参数，不提交企业路径。
6. 真实 Codex 个人/编排身份发现21工具，旧execution身份仍为七工具；调用 workflow_search(query="排查") 和 workflow_get，编排身份继续验证草稿/自测链路。样例明确标为合成；真实环境不使用这些绑定。guided运行应停在 WAITING_AGENT，宿主回传后继续。记录 Codex/Windows 版本、era/协议及原始业务值完整性，模拟宿主不能替代。
7. 独立 MCP 客户端连接 `flowhub mock --stdio`，调用 synthetic_order_lookup，传 `{"orderNo":"DEMO-1001"}`，应得到 synthetic=true、test 哨兵与中文 emoji。
8. 重启 daemon，确认 instance ID 持续、启动计数增加；同目录重复 daemon 被拒，多桥共享同一实例。验证加密策略开启时配置/SQLite/子进程可用，不关闭安全软件。

## 故障与保护

- DAEMON_UNAVAILABLE：先启动 serve，两端 --data-dir 相同。
- PORT_IN_USE：选明确空闲 --port，不杀其他程序或改绑公网。
- DAEMON_ALREADY_RUNNING：不能并发启动。崩溃遗留 daemon.lock 时，读记录 PID，在本机确认进程已退出且无其他 daemon 使用该目录，再手动移除**该锁文件**。不自动抢锁/杀进程，不删数据库/token；PID 复用无法判断则由管理员处理。
- RESTORE_INCOMPLETE：恢复中断的 `restore-pending.json` 会阻止普通启动，包括当前库缺失或标记损坏时。保留标记、`replaced-*.sqlite` 和 `backups/`，不要删标记后启动空库。确认 daemon 已停止并按上条处理失效锁后，显式重跑 `flowhub restore --data-dir <目录> --backup <已验证备份>`；恢复成功才清标记，旧标记归档到备份目录。一致性 `pre-restore-*.sqlite` 包含恢复前已提交的 WAL 数据，应优先用于回退。
- RC token 是本机随机执行身份，无企业凭据；不要分享数据目录。可在接入设置创建独立宿主身份并即时撤销。
- 仅回传版本/错误码/合成复现/无业务内容的结论，不回传企业凭据、日志、路径、表结构或诊断全文。

## 待填记录

候选包 SHA-256/build-info 源码摘要：待填  
部署许可：待确认  
Windows/加密策略/批准目录/离线运行：UNVERIFIED  
实际 Codex 版本/发现/合成调用：UNVERIFIED  
准入：BLOCKED，等待有效设备核验；不进入真实生产接入。
