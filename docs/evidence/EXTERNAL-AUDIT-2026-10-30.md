# 外部审计 F01–F08 整改与验证记录

日期：2026-10-30（北京时间）。基线：`95dfea1f6ea335387c7624e6b41cc29d8a0c9917`，版本 `1.0.0-rc.1`，修复分支 `fix/external-audit-f01-f08`。提交 SHA 以本记录所属 Git 提交及 PR 为准，不在文件中写自身提交哈希。

用户提交的可读审计报告与基线一致。原 `.md` 附件有 E-Safe 加密头，没有尝试解密；随后上传的 `.sql` 文本版本用于核对正文。附件内的公司安装和正式发布提示未被当作额外授权执行。未收到 repros 目录，未声称重跑其六个脚本；发现已转换成仓库正式回归，并保留修复前失败及修复后正对照。

## 逐项结果

| ID | 实际问题与整改 | 主要位置和回归 | 验证边界 |
|---|---|---|---|
| F01 | 原 CI 两处确为 `RUNNER~1` 与长路径严格比较；夹具保留原请求路径并以 realpath 核对结果。安装预检同时按真实祖先路径检查目录包含和所有权，防止别名绕过；保留链接、进程和数据保护。 | `tests/engine/settings-integration.test.ts`、`installer/windows/install-helper.mjs`、`tests/poc/windows-installer.test.ts`、安装冒烟临时路径。 | Linux helper 正负例通过；新增原生别名用例在 Linux 明确跳过。Windows 完整打包及安装结论以本分支原生 CI 为准，不能由本表推出已通过。 |
| F02 | 明确的 toolAdapters v1 支持 structured、普通业务 structured 和单块文本 JSON；先核对实际输出契约，拒绝猜选内容与脚本。环境来源与业务对象分离，缺证明不放行、不补造 environment。配置冻结在绑定快照并参与重新验证。 | `packages/contracts/src/tool-adapter.ts`、connector、管理验证、Schema/映射校验器；`external-audit.test.ts` 官方 SDK 回环三种形状及错误 JSON、混合块、超限、环境冲突和工具错误。 | 本机合成契约通过；未接入真实阿里云、华为云或企业 DB。管理员来源声明不是自动权限认证。 |
| F03 | 显式参数路径或独立核验的服务端固定上限；同一规则用于发布、解析、审批/哈希、每次派发。100 对有效上限 10 的常量、输入和 Agent 输出在派发前拒绝；10 正对照成功。Mock 实际执行限额。 | adapter、引擎、Mock；动态预算、审批精确参数、批准后参数变化零派发和缺限额生产拒绝回归。保留原重试、撤销、并发与未知结果用例。 | 真实服务端限额/只读能力仍需现场核验。旧非生产未声明适配器的后置检查不构成读取硬上限。 |
| F04 | inputs 落库前生成安全副本，精确原值按需独立加密；运行受控解密，锁库和重启不退回原文。轮换、备份和保留清理覆盖密文。旧运行锁库时隐藏输入，解锁后事务迁移；旧清理记录新产生的密文也进入下一次明确确认的清理。 | Vault、引擎、retention；随机无 token 前缀假凭据、磁盘备份字节、备份解密、精确出站参数、锁库/轮换/历史迁移与清理负例。 | 新记录和本轮新备份验证通过；历史备份、WAL、磁盘历史副本仍需按敏感数据管理。不作安全擦除或未知秘密万能识别承诺。 |
| F05 | Web guided 仅生成冻结版本/输入的宿主交接指令，由实际受限 MCP 身份创建 owner；Web 不再创建不可接管的默认 owner 引导运行。auto 保留 Web 启动。 | 管理 API、前端、接入说明；`scoped-guided-handoff.test.ts` 实际受限 A → Agent → 独立审批 → DB → 报告 → artifact_read；B、无权限及撤销身份负例；浏览器也用真实受限 SDK 身份启动。 | 未删 owner 检查、token-file 或管理/执行隔离。未运行真实 Codex 私有 Skill。 |
| F06 | 所有提交和降级统一校验 outputSchema、证据和报告，再事务写入/消费检查点。发布拒绝模板无法产生的自定义必需字段；运行不兼容则保留检查点供合法重交。 | validate、Engine.advance；reportFlavor 发布负例、maxLength=500 自定义契约的降级拒绝与合法宿主报告重交、原报告/证据负例和默认模板成功链路。 | host_reported 不等于独立证明 Skill 执行；模板降级明确为 not_used，事实复核仍未执行。 |
| F07 | 显式删除、改来源或替换配置时只清理对应 literal 文本、版本和 validity；切换节点保留尚未放弃的文本。 | main.tsx；四类真实 Chromium 回归：删除恢复、改引用恢复、另一节点仍阻止保存、切节点保留并可修正。 | 未全局清空缓存掩盖问题，原异步保存、重认证和原始 JSON 用例保留。 |
| F08 | 创建与 PATCH 拒绝明显认证 query/args、userinfo 与伪凭据引用；只接受真实 Vault 引用。旧配置在锁库时隐藏，解锁后保存完整加密隔离副本并停用、失效绑定；修正后再验证。 | `connection-config.ts`、API、Vault；大小写/编码 URL、stdio 参数、正常查询参数、PATCH、锁库和可恢复隔离副本回归，全部 `.invalid` 域名仅 inject。 | 不新增 query-token 注入功能；只支持明确的认证方式。未修改代理、TLS、公司安全软件或组织权限。 |

## 本地完整门禁

工具链：Linux x64，Node 24.19.0，npm 11.9.0，锁文件依赖未更换。仅使用内存/隔离 SQLite、合成数据、本机 HTTP/STDIO 和真实 Chromium。

| 命令 | 实际结果 |
|---|---|
| `npm run check` | 退出 0；类型检查与设计约束通过。 |
| `npm test` | 退出 0；总计 214，213 passed、0 failed、1 skipped。跳过项明确要求 Windows 文件系统别名。 |
| `npm run test:ui -- --reporter=line,json` | 退出 0；25 passed，0 skipped/unexpected/flaky。 |
| `npm audit --omit=dev --audit-level=moderate --json` | 退出 0；0 项漏洞。 |
| `npm run package:local` | 退出 0；Linux 候选包含可恢复源码、运行时、原生依赖、SBOM、许可证及清单。 |
| `npm run test:package` | 退出 0；真实解包、独立包内运行时/SQLite、STDIO/HTTP 合成冒烟。 |
| `npm run verify:release` | 退出 0；完整性验证通过，不等于签名或企业认证。 |

该轮被执行和打包的 136 文件源码聚合 SHA-256 为 `ee22c7a79d542080c4db64124a8de7ddade4222aa6b8dabc7f38983d37db87b1`。本记录、README 和 PLAN 的交付说明在门禁后补写，生产代码与测试未再变化。原始退出码、源码清单和日志保留在本机 `artifacts/external-audit-2026-10-30/`，不随源码提交。CI 应核对自己的实际源码 SHA 和构建信息。

Linux 验证候选：`flowhub-1.0.0-rc.1-linux-x64-2026-10-30T08-45-08-099Z.tar.gz`，SHA-256 `764d7f93bb744e11ad83102559347f354b23471d65b8ea0e3c4543c691129cf9`。该本地候选在提交前构建，build-info 如实记录基线 gitSha 和 dirty=true，并以完整源码摘要定位；不是 Windows 包，不作为正式发布。

## Windows 与交付

原失败运行：[41015567487](https://github.com/a3384379/MCP-FlowHub/actions/runs/41015567487)，Windows job `123931010058`；日志确认两个短路径断言，不能把该失败运行的 artifact 当成合格安装器。修复分支的原生结果、ZIP/EXE 精确名称、SHA-256、源码摘要及安装升级卸载记录应以本次 PR 的 Checks、job 日志和候选元数据为准。本记录写入时尚未执行新分支的原生 CI，不编造 Windows 产物和下载链接，不声称 Windows 已通过。

CI 必须实际跑到 `package:windows → test:package → verify:release → 固定 NSIS 验证 → installer:windows → test:installer:windows`。build-info 的构建时布尔状态与后续 smoke 记录分别核对；artifact 名称、上传成功或 Linux 通过不能替代这些步骤。当前不创建 Release；候选没有代码签名。

## 迁移、剩余范围与公司下一步

升级前停止 daemon、保留受限本机备份。旧连接的原始配置加密保留，不自动恢复执行；更正为凭据引用，按真实工具契约配置适配器/限额，重新核验并发布新版本。已有发布快照不重写。历史清理须重新预览确认；精确输入过期后拒绝直接复用安全展示副本查询，应新开运行并重新确认输入。恢复旧备份须使用备份时期口令；旧程序回退使用升级前备份，不支持旧二进制处理新记录。

本次未增加 SQL 表结构迁移，保护标记与密文属于可前向读取的 JSON 记录变更。事务失败不得把错误报告为认证成功或默默回退明文；迁移失败会锁库并明确提示修复/恢复。没有删除真实业务记录或既存备份。

工作流标签/工具/状态筛选、工具分组搜索、自动保存、复杂 Schema 全可视化、报告全文一键下载尚未补齐；已在 PLAN、README 和 UI 说明范围，不将“保存草稿”“历史协议验证”“下载当前块”冒充这些能力。

公司安装下一步：仅在原生 Windows 全链路通过并获得组织批准后，校验对应提交、包哈希和签名状态，再在批准目录做合成验收。真实 Codex 版本、私有 Skill、云桌面透明加密、真实 MCP 契约、DB 只读及限额、数据处理授权和业务结论均未在本轮核验，需分别申请和记录；不直接接生产测试修复。
