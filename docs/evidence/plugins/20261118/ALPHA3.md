# FlowHub 插件 alpha.3 修复与本机升级

2026-11-18，macOS arm64，Node 24.19.0，npm 11.9.0。安装包来自 `246e82aac822f0d98360da9dc1f77e8c3bc1026c`。归档 SHA-256 为 `32af85bb4984a22f90747e8cff8367dffe2b5977b6d914ad6135fc21329df313`。

| 问题 | 修复与验证 |
| --- | --- |
| Codex App Server 版本 | 用实际 `codex app-server generate-ts --out <临时目录>` 与仓库生成类型对照。0.169.0-alpha.11.1 与 0.164.0-alpha.11.1 的三个发现请求结构相同。新增精确支持版本、响应形状检查，并在扫描时重读 CLI 版本以支持原有上下文。未知版本继续降级。真实 0.169 上目录扫描为 SUCCEEDED，成功读取 Skill 及工具目录。 |
| Chrome 版本 | 缓存的 `latest` 指向同一个 `26.1111.21308` 目录。按实际路径去重并显示版本目录名。不同实体版本仍保留歧义，跨插件的链接不计入。实测静态扫描包含 Chrome 26.1111.21308，Chrome 歧义消失。 |
| 管理页入口 | Codex 插件提示新增“打开 FlowHub 管理页面”。设置技能通过 `flowhub-plugin url` 获取当前连接的数据目录及实际端口对应地址。实际 Codex 读取到提示，隔离实例的随机端口页面返回 HTTP 200，本机 `flowhub-plugin open` 成功调用默认浏览器。 |

升级前无活跃工作流，后台生成的一致性备份通过恢复预检。只替换 FlowHub 本地 marketplace 来源与插件，后台沿用原数据目录和端口。升级前后 3 个工作流、版本与运行记录、凭据元数据、连接和绑定快照相同。对照 Codex 配置，其他插件及连接设置相同，FlowHub 的连接引用文件字节相同。后台健康接口返回 alpha.3。Vault 恢复到升级前的解锁状态。

| 验证 | 实际结果 |
| --- | --- |
| `npm ci`、`npm run check`、`npm test` | 安装及检查完成，544 项通过。 |
| `npm run package:plugin`、`npm run test:package`、`npm run test:plugin` | 归档解压后完整性、真实宿主加载、21/7 工具权限和离线包冒烟通过。生产依赖审计 0 漏洞。开发依赖审计另报 4 项高危告警，本轮未调整依赖。 |
| `npm run test:plugin:e2e` | 从已安装缓存定位 alpha.3，9 个阶段通过。7 节点流程保存和校验，7 个确定性用例中 4 个通过、3 个缺 Fixture。补齐后两分支 18 条断言全过，错误断言失败与草稿改动后的旧测试失效均正确，最终两个发布运行成功并产出两份报告。 |
| `npm run test:ui` | Chrome for Testing 1252 全量 93 通过，桌面 2 倍缩放平移时有一次点击被主导航遮挡而超时。改用锁定的 Playwright Chromium 1248 单独复跑该用例 3 次，全部通过。 |

完整回执位于本机 `artifacts/latest-plugin-e2e.json` 指向的目录，升级回执为 `artifacts/flowhub-alpha3-local-upgrade.json`，测试日志在 `artifacts/alpha3-verification/`。个人目录的元数据读取仍标记 `STATIC_RESOLUTION_PARTIAL`。真实模型轮次、企业接入及 Windows 原生验收未执行。插件卡片提示由 Codex 宿主接口验证，实际浏览器打开由包内命令验证。
