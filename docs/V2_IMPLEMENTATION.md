# FlowHub 2.0 实施记录

## 基线与边界

2026-10-31，本机 macOS arm64；checkout 位于当前仓库，起点 main@45eed03ee9f6f513a5c67e854d3d42e16afee636。
`git fetch origin` 后主干没有后续变更，工作区最初干净。开发分支 `feat/flowhub-v2`。
用户提供的设计包原位于 Downloads，仓库缺少 upgrade-v2，因此按入口说明复制至 docs/upgrade-v2/，未覆盖根约束。
默认 Node/npm 为 22.22.0/10.9.4；官方 Node 24.19.0 arm64 包下载到 /tmp/flowhub-v2-runtime 并核对 SHA256，npm 11.9.0 安装于该临时工具目录；没有更改全局运行时。
测试只使用 mkdtemp 隔离库与动态端口；18473/18474 基线未监听。不打开正式数据库，不改 Codex 配置，不 push/merge/Release。

## 范围与顺序

S0 冻结 v1 DDL、顺序迁移、基线与 Windows 失败定位；S1 统一 Authoring 与 v2 DTO；S2 本机发现/目录/导入；S3 固定 MCP 工具与产品级自测；S4 Provider/问答/可靠工具循环；S5 正式 React 联动；S6 全回归/宿主；S7 本机包/恢复/Windows边界。
保留单 daemon、旧七工具兼容、原始业务数据、环境/owner/凭据边界；正式工具集合扩展至 21。不恢复审批或业务自动脱敏。

## S0（已完成本机验证）

修改：导入设计包；更新增量约束；从旧 repository.ts 原样冻结 v1.ts，checksum `39b4d8eab1f40befe28a3c7642a8e6b2b9398e1aa6a7e3895f74d572c4c88784`；迁移注册表验证已知完整前缀并事务升级，启动/备份预检/恢复共用；增加旧库、未来历史、损坏表、失败回滚测试。

当前 Windows CI 实证：run 41160071532（同基线 SHA）Windows 的两项 settings-integration 测试失败，actual 为 `runneradmin` 长目录而 expected 为 `RUNNER~1` 短目录。夹具现在先 realpath；保留路径断言，原生 Windows 修复结果未验证。

命令：`git fetch origin`、`gh run view 41160071532 --repo a3384379/MCP-FlowHub --log-failed` 均 exit 0；项目专用 Node/npm 执行 `npm ci --no-audit --no-fund` exit 0；`npm run check` exit 0（静态设计检查 37 正向/65 负向，其边界不是产品运行验收）。全量 `npm test` 首轮 exit 1：186/191，通过外的 5 项均为 macOS 临时目录符号链接触发安装器检查。规范化测试根目录后复跑 exit 0：191/191（63.2 秒）。随后 build:server + 迁移/runtime 定向 8 项 exit 0，覆盖启动前先校验历史的最后修改。

日志临时位置：/tmp/flowhub-v2-s0-check.log、/tmp/flowhub-v2-s0-test.log、/tmp/flowhub-v2-ci-baseline.log。汇总以实际退出码为准。

未验证：原生 Windows、真实模型、真实 Codex MCP 会话、企业 MCP；没有实际模型调用。

## S3–S7

尚未实施，不计通过。后续每阶段继续补实际修改、命令、退出码、证据和本地提交。

S0 后续修复：macOS 安装器夹具使用 realpath，仍保留拒绝目录链接/路径穿越等负向测试；openStore 在 WAL 设置和 boots 计数写入前校验历史，损坏/未来数据库不产生业务写入。

## S1（已完成本机验证）

统一 AuthoringService 已接管 Web 的草稿保存与兼容发布；新增 /api/v2 草稿/operation/校验/发布接口沿用管理员会话与 CSRF。原子 operation batch、owner 范围、幂等账本、独立 layoutRevision、能力漂移检查、不可变快照与变更事件已经落库；非法中间图可存为草稿并返回 issues，发布仍严格验证。记录 before/after 用于后续局部撤销。

新增 v2 DSL，v1 schema 保持原样；新增能力引用、执行器和原生结果适配声明。旧 v1 发布保留原 hash 语义；v2 发布冻结能力快照，不能从旧发布接口绕过能力修订核对。
迁移 2 建立后续能力/会话/自测逻辑表、索引、FTS 和统一事件表；旧库升级前 startup 一致性备份。新增表和索引校验同时用于恢复预检。

验证：npm run check exit 0；build:server exit 0；Authoring/迁移/恢复/既有发布CAS 共 16 项 exit 0。早期一次测试暴露“草稿断开全部边被Schema拒绝”，已只在 v2 Schema 放宽零边中间草稿，发布图检查不放宽。先前恢复负例的未知版本改为 999，避免与正式 migration 2 冲突。
证据：docs/evidence/v2/S1-tests.txt、S1-check.txt。脚本 test:authoring 已真实加入 package.json。
未验证：原生 Windows、真实 MCP/模型；S2–S7 仍待实施。

## S2（已完成本机发现与合成协议验证）

实现 HostContext、实际 help 检测的 CLI JSON、真实 TOML 回退、可信项目/Profile 部分覆盖标记、Windows/WSL/本机执行位置隔离、本地已装标记+Manifest+Skill 扫描。只读 App Server 适配使用本机 generate-ts 的 0.164.0-alpha.11.1 请求类型，版本不符拒绝并回退；生产不调用 plugin/list/read，不执行 hooks。
CapabilityRegistry 落库扫描任务、来源、能力修订/历史及失效标记；同名工具按来源隔离、按需Schema、分页游标绑定过滤与快照；导入只建 FlowHub 连接/绑定，不改 Codex 配置，不伪造真实环境验证。缺认证/相对命令/宿主能力保持不可直接调用；连接密钥不进入目录。正式 React 发现页已接后端。

验证：npm run check exit 0；test:discovery（包含 build:server）4/4 exit 0，覆盖已装/市场、禁用、多组件、真实 SDK STDIO catalog、同名工具、重复扫描/导入、源消失、凭据不落目录、损坏来源、TOML多行/引用、Profile、可信项目及外部执行位置。最初自引用判断过宽，测试发现临时目录名误判，现已收窄。
实际本机元数据扫描：Codex 0.164.0-alpha.11.1，macOS，host_effective；11 MCP 来源、25 插件、57 Skills；PARTIAL/PLUGIN_VERSION_AMBIGUOUS。没有业务调用或模型调用；没有连接本机下游业务服务。日志 S2-local.txt、S2-tests.txt。

保留边界：多版本缓存不能唯一定位时不猜安装版本；root manifest 未通过当前适配的格式标 unsupported；托管会话私有工具不声称可共享。带认证的来源需要在本地连接设置登记 secretRef，不经 MCP 参数传Key；没有通过业务探测伪造 BINDING_VERIFIED。
S3–S7 尚未完成；Windows/真实模型仍未验证。
