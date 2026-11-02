# FlowHub 2.0 实施记录

## 2026-11-02 工作流删除增量

基线 feat/flowhub-v2@df51c7b（PR #4 已合并主干，同一产品源码），使用原 checkout 的 feat/workflow-delete 分支，保留原有 8 项未跟踪审计资料。原页面只有“停用新启动”，没有删除工作流接口及入口。新增管理员 DELETE /api/v2/workflows/:id，语义/布局双 CAS、幂等和事务事件统一进入 Authoring Service；不新增 MCP 工具，不执行历史级联清理。工作流卡片提供确认删除，错误在确认框内显示，手机窗口适配；跨窗口删除保留未保存的本地图。

验证证据与范围见 docs/evidence/v2/workflow-delete-20261102/verification.md。只在隔离合成库验证删除，不删除正式工作流；本次不自动 push、merge 或 Release。

## GitHub PR #4 交付复核（2026-11-01）

用户已明确授权提交、推送与合并。PR #4 首次评审新增 Web 整图保存布局 CAS、无 outputSchema 的纯文本 MCP 结果不可映射两项 P2，均已真实复现并补修。Web/API/Authoring 共同检查布局修订，画布和发布校验共用适配器契约；真实 STDIO 结果可映射进 analysis 检查点。

Linux CI 的合成滚动命令未产生视觉平移，单改起点未解决，改用实际触屏拖动事件，保留可视区偏移大于零与命中断言。Windows 查询保留 200 ms 门槛，一次过滤复用后远端 1000 项 P95 约 38 ms；安装复验进一步暴露快捷方式中文传输和 8.3 路径比较问题，改用无损字符串传输与真实文件路径验证。原生门禁通过前不合并。详情、命令及后续结果见 [PR 交付记录](evidence/v2/github-pr4-20261101/交付与修复.md)。

## 导航审计与模型锁定恢复（2026-11-01）

用户报告 CREDENTIAL_LOCKED，现场确认正式库锁定，已通过既有本地管理入口解锁；模型配置 ID、secretRef 与修订不变，未调用真实模型。模型与助手补充实际凭据库状态、解锁入口和锁定时的发送/探测保护，历史失败可重新填回原问题，历史探测明确标注。保持重启默认锁定、现有加密与独立口令规则，不自动重试问题或写操作。导航审计确认三组七入口符合此前选中的分组直达方案；后来预览选择的“设置合并”尚未开发。

另外复现手机放大后关闭按钮及底部入口移出可见区域，抽出共享 visualViewport 计算供助手、启动图标与导航复用，并补 2x/3x 缩放与锁定恢复回归。实际结果见 [审计修复证据](evidence/v2/navigation-vault-recovery-20261101/审计与修复.md)。

## 分组导航增量（2026-11-01）

按用户选定的“分组直达”方案，侧栏调整为工作区、能力与连接、系统配置三组七个入口。统一线性图标与命名，缩小工作空间区域；模型设置继续直达，原 URL、编辑脏状态、发现、模型和业务执行行为保留。抽离 navigation 元数据和 AppSidebar 组件，面包屑、标题及助手当前页面名称复用同一配置；窄屏改为具备焦点约束、背景 inert、Esc/遮罩关闭及断点清理的导航抽屉。Gateway 的固定工具说明仍在系统设置内展示。

实际命令、测试、截图、正式库保护和打包证据见 [分组导航验收](evidence/v2/grouped-navigation-20261101/实施与验收.md)。无新依赖、数据库变更、自动扫描或模型调用；不 push、merge 或 Release。

## 悬浮对话助手增量（2026-10-31）

实现提交`ebbca07`：全局悬浮窗、逐轮Markdown问答、持久化流式与取消、原幂等请求恢复、真实MCP状态投影、同范围连续追问、真实改图及每轮撤销。保留现有数据、owner/CAS和21固定工具，不恢复审批或业务脱敏。

完整阶段、命令、失败修复、实模与本地重启证据见[实施记录](design/assistant-chat-v1/实施记录.md)。后端353项、UI42项通过，最后增补目录字段后的助手48项通过；实模五轮及实际浏览器两轮完成。18473已更新，19张业务表原记录哈希及数量一致。首次实模流式中断单独保留，不混入成功结果。

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

## S6–S7（以下阶段状态以末尾记录为准）

此处为S0时的阶段占位；S6实际结果及S7后续结果见文末，不以历史占位推断当前状态。

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

## S3（已完成 SDK 闭环与本机回归）

Application 统一分派固定 21 工具。个人默认身份可编排；现有仅 execution scope 的受限客户端保持七工具；authoring scope 的新建流程原子加入其自己的 allowlist。Web、MCP 复用 Authoring、目录及自测服务，bridge 未加业务逻辑。
新增生产 MCP v2 输入契约；原 v1 七工具契约保留为兼容验证。按实际 JSON Schema strictRequired 修正 operation 条件分支中的 nodeId 声明，不放宽工具外层字段验证。
WorkflowTesting 提供确定性/agent_proposed 生成、Suite CAS、Mock任务和独立断言；隔离 SQLite/Vault 与注入连接器复用 Engine，不复制连接endpoint或真实secret。缺夹具为 UNCOVERED，持久保存 expected/actual/trace/事件/覆盖缺口；草稿/能力/夹具修订失效后显示 stale。contract/live 请求明确不支持，不自动访问真实网络。
原生 MCP 支持 structuredContent 与显式 text/json_text；v2 保留原始 MCP Envelope 产物。独立绑定探测不强迫第三方存在私有 environment 字段，仍要求可核验的固定资源证据。
本地帮助初版采用真实文档分块和 FTS5，中文 bigram 与领域词，不索引设计包作为已实现功能。

验证：npm run check exit 0；npm test 200/200 exit 0（70.6 秒）；最终 test:selftest exit 0。官方 Client 贯穿发现/导入/独立合成探测/创建/修改/校验/agent_proposed/Mock/发布/启动/检查点推进/读取实际 Markdown；另验证缺Fixture、100条流程固定21工具、旧受限身份固定7工具。没有额外模型 Key。
证据：S3-check.txt、S3-full.txt、S3-selftest.txt。新脚本 test:selftest 已加入。
未验证：真实 Codex 对当前开发服务的工具会话、真实 Provider、原生 Windows、企业 MCP；S4–S7 尚未完成。

## S4（已完成合成 Provider 与助手验证）

Responses 与 OpenAI-compatible Chat Completions 两个适配器分别构建消息/工具/回执与路径，支持非流式和完整流式终态；半截参数或断流不派发写工具，401/429/超时分类，不盲重试。ScriptedModelProvider 仅通过测试依赖注入，不伪装真实模型。
模型设置使用 Vault secretRef，Key 不进入 profile、命令账本或普通输出；连接测试分别报告文本/工具/流式，文本模型可帮助但不能假执行编排。没有读取或复用 Codex OAuth。
持久化会话、任务、taskId+callId ledger、真实工具回执与 usage（缺失为 null），通过统一 Application 编辑；根据 requestedActions 限制工具，帮助模式无写工具。限制轮次/工具数/重复错误，支持取消与重启 INTERRUPTED，不重放未明确完成的调用。默认只附当前选择的上下文与有限帮助片段，原始业务内容不改写；过长上下文/工具回执明确截断，完整回执保留。
已有 SSE 生命周期基础复用为 /api/v2/events，eventId 游标重放，鉴权失效/注销/关闭会结束连接；事件只驱动读更新，不重复发 patch。
知识库仅索引当前用户文档和实际工具描述，FTS5 使用 CJK bigram/ASCII/领域词。引用带源行号/hash/版本，不把设计包当作现有功能。

验证：npm run check exit 0；build:server exit 0；test:assistant 12/12 exit 0；既有 SSE 生命周期 3/3 exit 0（首次组合 13/13，随后新增 2 项能力/修错预算）。覆盖真实共享服务改图、重复callId、帮助模式、半截JSON、CAS修错、取消、重启、Key加密、无Key、中文检索、双协议路径、断流、401/429、文本模型及三次失败停止。
证据：S4-check.txt、S4-tests.txt。官方资料核对：OpenAI function-calling 与 Responses/Chat streaming-events 文档。
按用户明确要求，缺真实 Key 不阻塞本地代码与合成测试；环境中无 OPENAI_API_KEY，无工作区 env 文件，本阶段真实模型调用 0。真实问答/编排和30场景评测未验证，不能用上述 Scripted/localhost 测试替代。
S5–S7 尚未完成。

## S5（已完成正式界面与执行器联动）

新增独立 React features：models、assistant、testing、workflows/CapabilityPicker/RunAnalysisControl 和共享 v2 事件客户端，未将新增产品全部塞进 main.tsx。模型专用 Key 输入、会话/真实工具卡片/引用、无Key检索、当前节点上下文、能力加入当前画布、Fixture编辑/Mock结果均连接实际后端。
画布使用 draft.changed 的修订只读刷新；本地脏字段/焦点JSON和发布审阅候选不会被事件覆盖，显示原有比较/另存冲突入口。新增节点保留旧布局并短暂高亮。AI action 可语义撤销和重做，检查字段是否被后来修改，保留其他字段与发布历史。
分析执行器使用持久化 checkpoint lease 和原有 advance；并发 Codex 不能同时消费，JSON不合法保留checkpoint。host_tool 冻结身份/参数/输入输出契约，进入 WAITING_AGENT，仅标 host_reported，网页Key不能假调用。原生检查点 Token 仅以加密交付字段进入助手存储；普通业务数据不自动替换。
可选版本锁定 App Server 目录读取现支持 codex_host Tool 元信息（新会话，不共享 Desktop）；默认只读CLI/静态发现不变。
接入设置显式支持编排身份（21工具）或仅执行身份（7工具）。

验证：check/build exit 0；authoring/assistant/executor 定向 19/19 exit 0；全量 Playwright 24/24 exit 0；最后分析入口与截图更新后再跑 automation+v2 UI 3/3 exit 0。早期全量 UI 23/24：SSE更新了发布审阅候选，现已保护审阅上下文并使用 REVISION_CONFLICT，未跳过测试。
浏览器首次缺少锁定版本 Chromium 1248，已安装官方隔离测试浏览器；未操作日常Chrome配置。实际 UI 验证模型由 localhost 合成HTTP提供，持久化改图/刷新/undo/redo/未保存输入保护/Mock自测均通过；截图为1440/1366/390，检查整页无水平溢出。截图已人工式视觉检查（工具查看像素），不以截图替代断言。
证据：S5-backend.txt、S5-ui-full.txt、S5-ui-final.txt、S5-check.txt 和 S5-ui-*.png。
未验证：真实模型/真实企业服务/原生Windows。S6全回归与真实宿主、S7打包恢复仍在后续。

## S6 完成：回归与真实本机宿主（2026-10-31）

新增 `scripts/smoke-codex-v2.mjs` / `test:codex-local`：当前真实 Codex 0.164.0-alpha.11.1，以临时 CODEX_HOME、无凭据登录、独立 daemon/data-dir，通过 App Server mcpServer/tool/call 完成21工具发现→host_scan→草稿创建/改图→校验→生成/Mock自测→发布→启动→读取真实1094字节报告。结果 S6-codex.txt，模型回合0、业务服务调用0；不代表30场景自然语言验收。

边界修复：显式本地凭据配置入口将来源内联环境/Bearer值加密入Vault，或选择已有secretRef；扫描/MCP不导入凭据，不复制Codex OAuth，源文件不改，仍须独立验证绑定。发现页增加自定义Home/CWD/Profile/可信项目/App Server选项与更新CAS。撤销拒绝删除后续编辑仍引用的节点；分析worker对401/429立即停止，仅JSON/Schema错误允许有限修正；模型工具探测验证实际probe名称与完整参数。v2节点可声明rowLimitArgument，派发前取用户/工作流/绑定限额最小值；无原生映射明确记unsupported，不用结果裁剪假称前置限额。

实际命令（均使用S0隔离锁定runtime）：
- `npm run check` exit 0；S6初次补丁发现TS类型约束后已修复。
- `npm run build:server && node --test dist/tests/engine/v2-authoring.test.js dist/tests/engine/v2-discovery.test.js dist/tests/engine/v2-executors.test.js dist/tests/engine/v2-results-limits.test.js` exit 0，16/16。初次新增测试夹具缺合法对象Schema/未初始化Vault，已修正后重跑；未放宽产品约束。
- `npm test` exit 0，220/220，81.5秒；包含完整build，S6-tests.txt。
- `npm run test:ui` exit 0，24/24，26.9秒；S6-ui.txt。仅隔离Playwright浏览器。
- `node scripts/smoke-codex-v2.mjs` exit 0；真实宿主最小闭环，S6-codex.txt。

104项逐项记录在 `docs/evidence/v2/acceptance-results.json`，S6评估64 PASS（限定合成/宿主证据）、30 PARTIAL（不能视为通过）、10 UNVERIFIED。30项真实模型记录在nl-evaluation-results.json，全部UNVERIFIED，不用Mock代替。原生Windows、企业权限/服务、桌面已有会话工具和真实模型未验证。S7打包/停机恢复尚待完成。

## S7 完成：本地候选、实际旧程序升级回滚（2026-10-31）

版本为 `2.0.0-alpha.1`，运行/包/doctor阶段为ALPHA，OpenAPI从package读取版本。原生Windows、真实目标模型未验，不宣称生产发布就绪。新增模块、v2契约、V2_USER_GUIDE/MIGRATION/ACCEPTANCE进入离线包；运行帮助与source snapshot字节一致，完整性清单覆盖新模块。源码快照包含全部新增源码/契约/脚本与文字证据，二进制截图不是可恢复源码的必要部分。

新增 `test:upgrade-local` 在临时目录提取并编译实际基线45eed03，使用旧程序建立真实v1结构的合成库、创建发布并执行模板报告、登记旧客户端和一致性备份。当前程序升级后workflows/versions/runs/artifacts/clients每行相等；自动pre-v2备份存在；新库备份预检成功，删除assistant_tasks的损坏备份被拒绝，活动daemon期间恢复被拒绝。停机恢复后再次启动实际旧程序，七工具可用，发布hash和报告字节保持一致。旧发布hash为 `sha256:8ad35f7232e3c1f463eba7434aa5ef1b0d949dbc21f403da9fd5d3ab10927491`。未访问正式库。此开发验收脚本依赖当前Git仓库包含45eed03对象及开发依赖，不是目标机启动步骤。

包验收发现并修复：
- CLI在macOS `/var`别名入口因import.meta真实路径不等而静默退出0；改用realpath比较，并用真实目录别名启动CLI的回归断言。
- HTTP受限身份目录正确为7，但STDIO薄桥原来无条件列21；现在从已认证daemon目录取固定契约交集，没有增加任意工具透传。真实STDIO及包内modern/legacy旧身份均断言7。
- 缺认证或宿主专用源被跳过catalog时，明确PARTIAL；命令参数中的常见认证旗标禁止复制为普通连接参数。
- 确定性用例增加数字/字符串/数组边界、布尔与枚举；复杂约束缺有效样本显示INPUT_SAMPLE_REQUIRED，过大生成显示GENERATION_LIMIT；Mock入参与输出经过发现Schema校验。新增独立断言失败、两条布尔分支、测试过期及非法输出测试。初次新增夹具缺capabilityId，按真实契约补齐后通过，没有放宽Schema。

最终实际命令（项目专用Node24.19/npm11.9；退出码全部0）：
- `npm run check`；`npm test`（包含build）：225/225，78.5秒，S7-check.txt/S7-tests.txt。
- `npm run test:ui`：24/24，25.5秒；S7-ui.txt。仅测试自有隔离浏览器。保留S5已查看的截图，未将每次随机ID产生的截图差异作为新UI实现。
- `node scripts/smoke-codex-v2.mjs`：真实Codex App Server21工具及编排/自测/报告闭环；S7-codex.txt，模型回合0。
- `node scripts/smoke-v2-upgrade.mjs`：实际旧程序升级/停机恢复/旧程序重启；S7-upgrade.txt。
- `npm run package:local`、`npm run test:package`、`npm run verify:release`：macOS arm64离线候选及包内Node启动，无外部npm/node；真实编排持久化、中文帮助、21/7目录、modern/legacy合成调用、模块篡改拒绝全部通过。S7-package*.txt/S7-verify.txt；首次CLI失败保留S7-package-first-failure.txt。候选包含可恢复源码、Node许可、SBOM/第三方NOTICE及SHA256清单，哈希不当签名或企业准入证明。

最终交付由本节所在本地提交重新打包，最终build-info.gitSha应等于HEAD、dirty=false；该次归档信息保存在未纳入Git的artifacts/latest-package.json，不再将最终二进制hash写回源码引起自引用。重建后的只读验证日志保存在/tmp/flowhub-v2-delivery-*。

104项实际验收为72 PASS / 26 PARTIAL / 6 UNVERIFIED，详见acceptance-results.json。PARTIAL不当通过。30个真实目标模型场景均UNVERIFIED；无Key不阻断当前发现/手工/Codex/Mock功能。原生Windows/WSL、安装器实机、企业MCP权限、真实模型效果及现有Desktop会话授权未验证；未push、merge、Release，未运行会影响现有安装的安装器smoke。

## 本地阶段提交索引

| 阶段 | 提交 | 主要实现 |
|---|---|---|
| S0 | 28995de | 冻结v1与顺序迁移、基线/CI定位 |
| S1 | 34da82b | 统一Authoring/CAS/operation/v2契约 |
| S2 | 7c7c16a | Codex发现/能力目录/独立导入 |
| S3 | 560366a | 固定21工具/产品级生成用例及Mock闭环 |
| S4 | 9918547 | BYOK双协议/知识检索/持久化助手账本 |
| S5 | c4fb1f2 | AI真实画布同步/撤销/执行器衔接 |
| S6 | cbdeeed | 真实本机Codex联调/凭据入口/回归矩阵 |
| S7 | 本节所在提交，见git log | 本地离线候选/升级回滚/包门禁及最终修复 |

## S7 后审计修复：alpha.2（2026-10-31）

本轮从5c68e54开始，工作区原干净，fetch后main仍45eed03。按用户要求用max独立审计、xhigh修复，继续在原仓库，不接触正式库。发现13条、编排/自测8条、助手14条原始及补修记录按原场景关闭；后续精确验收补齐引用重建stale、Skill报告合同、终态自测过期显示和数据生命周期。原35条包含同一缺陷后续补修，不能计作35个独立漏洞。逐项触发/修改/验证/限制见V2_AUDIT.md和audit/closeout.json。

实际实现提交：`5c44b68`。其后证据提交同时纳入隔离Playwright配置，最终候选以该证据提交HEAD为准。源码/契约/运行版本统一2.0.0-alpha.2，未改依赖版本。已交付v1/v2迁移DDL/checksum原字节冻结；没有清理用户数据库，没有恢复审批/自动脱敏，不push/merge/Release。

实际命令（项目隔离Node24.19.0/npm11.9.0）：
- `npm run check` exit0；37正例/65负例设计检查和两套TS通过。
- `npm test`（含完整build）exit0，338/338、0 skip，120.1秒；audit/tests.txt。
- `npm run test:ui` exit0，35/35、49.1秒；audit/ui.txt。不操作日常Chrome资料，测试CLI用Node真实子进程及空Codex Home。
- `node scripts/smoke-codex-v2.mjs` exit0，真实0.164.0-alpha.11.1宿主经21工具完成创建/自测/发布/运行/报告，真实模型回合0；audit/codex.txt。
- `node scripts/smoke-v2-upgrade.mjs` exit0，实际旧45eed03程序→alpha.2→停机恢复→旧程序重启，业务逐行/发布hash/报告字节不变；audit/upgrade.txt。
- `node scripts/benchmark-v2.mjs` exit0，100节点50样本校验P95 4.41ms；500组件10样本扫描P95 125.15ms；本机合成指标，画布事件P95未测。

修复过程中保留真实失败：原UI27/30、旧夹具选择器34/35，随后用实际测试关闭。常量条件不可覆盖的false分支正确PARTIAL，未改回假绿；真实自测成功和stale另有独立浏览器测试。

当前104项95 PASS /4 PARTIAL /5 UNVERIFIED；PARTIAL及30真实模型评测未当作通过。完整配置优先链、工具漂移到修复发布复合场景、发布复合CAS场景及真实host-only执行仍缺完整验收；Windows/WSL、企业权限、安装卸载与新机教程维持独立门禁。

本地包门禁：`npm run package:local`、`npm run test:package`、`npm run verify:release`均exit0，包内Node、中文帮助、持久化编排、现代/legacy及21/7目录、助手模块与README篡改拒绝均通过，证据audit/package*.txt。此轮预证据提交包为审计验证，最终证据提交后再构建并验证clean候选；最终build-info.gitSha=HEAD、dirty=false，归档路径与hash读取artifacts/latest-package.json，最终只读日志位于/tmp/flowhub-v2-audit-delivery-*，不再把最终包hash写回源码。

## 登录简化（2026-10-31）

按用户要求，首次使用直接以admin/admin登录，登录页添加账号字段并移除设置码/创建管理员步骤。首次有效默认登录事务初始化管理员和Vault；已有管理员与凭据库不被覆盖，旧的仅密码登录和一次性bootstrap API保留兼容。默认短口令例外只用于首次默认初始化，其他口令设置/轮换保持原规则。

`npm run check`、`npm test`（含build）均exit0，后台340/340；`npm run test:ui` exit0，36/36。新增真实临时daemon测试首次初始化、错误账号/密码、重启/加密数据保留、既有口令保护、会话及CSRF，以及真实浏览器默认登录。浏览器夹具首次从源码目录加载时项目根目录不匹配，已改用实际构建入口，未修改产品根路径逻辑。证据见evidence/default-admin/。

已使用原持久化目录/端口18473干净重启本地daemon，并实际验证admin/admin登录、认证后读取流程、退出验证会话及health=ok；未清库、未push或发布。此次为源码/本地运行更新，前轮alpha.2归档包保留为原审计提交快照，未声称重新打包。

## 模型服务与官方目录（2026-10-31）

根据用户截图复现：Responses配置填入`/v1/chat/completions`，旧providerUrl会拼接为`/v1/chat/completions/responses`。已将Base URL/完整端点统一归一化，保留Responses和Chat Completions两套请求协议。

新增模型服务选择：OpenAI（ChatGPT）自动填写官方Base URL，默认Responses；自定义兼容服务保留。新增受管理会话/CSRF保护的POST `/api/v2/model-catalog`，从当前Key获取真实可用ID/归属/创建/停用信息，前端搜索下拉、停用模型禁选、未知ID不默认为正确，Key/服务变化使目录失效，迟到回包不能替换新选择。新Key只在保存时加密入Vault，编辑可复用原Key，改变origin需提供新服务Key。

新增GET `/api/v2/model-docs?model=...`，仅查询固定官方域名和精确模型ID的公开Markdown；不发送API Key、禁止重定向、10秒/256KiB预算、1小时/128项缓存。按精确Model ID核验后提取上下文、最大输入/输出、推理强度和Chat工具限制，附sourceUrl/contentHash/fetchedAt，未提供字段保留未知。没有静态抄录模型名称或参数。官方接口依据：https://developers.openai.com/api/reference/resources/models/methods/list ，官网参数依据：https://developers.openai.com/api/docs/models/gpt-6-luna 。

错误分类增加模型不存在/Key无权限、错误端点、额度不足、参数不兼容；不回显服务端原始错误正文或Key。额度错误不作限流重试。前端探测卡片显示可操作的中文原因。

实际验证：`npm run check` exit0；`npm test`（含build）345/345、0skip、114.6秒；`npm run test:ui`38/38、49秒；新增目录/官网参数定向5/5。初始UI夹具对option使用isDisabled断言及异步input→select切换等待不当已修正，实际disabled属性和下拉行为都有回归；初次失败保留。证据在evidence/model-services/，归档文本仅去ANSI及行尾空白。

本地真实配置已以CAS将错误完整端点修正为官方Base URL，原Key引用不变，模型仍为gpt-6-luna。复用用户已配置Key的真实目录返回130个模型且包含该ID，官网参数查询成功；原文本/工具/流式三项均实际passed，结果已持久化。仅发送简短合成探测请求，不读取业务数据；这是最小连接验收，不替代30个真实自然语言业务场景评测。已重启原数据目录/18473服务，无push、merge或Release；没有重建前轮离线归档。

## 2026-10-31 发现页分类与中文同步

本地产品提交：097192d（关系/显示层/迁移/固定工具兼容）、02017ad（正式分类页/详情/关系/中文编辑）。D1-D4已完成，真实Codex中文上传与合成编排闭环通过；原数据保留及服务更新见 [实施记录](design/discovery-v2/实施记录.md)。无自动push、merge或Release。

后续D5：需处理逐条增加操作与来源指引，复用连接/凭据/发现设置；移除重复AI工作台，旧地址打开悬浮聊天。check、后端364/364、UI49/49通过；18473已更新，24张原表内容一致。详情及本轮边界见同一实施记录D5与[证据](evidence/v2/issue-actions/verification.json)。

后续悬浮入口：鼠标/触屏拖动、左右吸附、贴边收起/恢复、记住位置与窄屏限位；原会话保持。实机更新发现SSE积压关闭后心跳写入已结束响应导致daemon退出，已稳定复现并修复。最终check、后端365/365、UI50/50及SSE定向4/4通过，原24张表一致，服务18473已加载新资产。见[入口位置调整](design/assistant-chat-v1/入口位置调整.md)及[证据](evidence/v2/assistant-launcher/verification.json)。


## 发现与悬浮助手 max 审计修复（2026-10-31）

从 `61e19ee` 对近期交互及此前未关闭助手反例进行独立 max 审计、xhigh 修复与独立复审。完整清单、失败原文、命令和验证边界见 [本轮审计记录](evidence/v2/max-audit-20261031/审计与修复.md)。

助手使用共享的动作细分约束，将启动、取消、推进、扫描、导入分别绑定实际工具；问句、引用、否定与尚未满足的未来条件不授予当前执行。异步提交按请求键归属处理回执；续答携带具体 `continueTaskId`，验证 owner、session、模型来源及原上下文，仅解释已有结果。上下文预算按 UTF-8 序列化大小保留所选实体；界面依据实际 authoring 写回执展示保存状态，并以 visualViewport 约束低高度和缩放布局。

发现上下文更新要求显式目标和 CAS，不对派生的另一身份写入；空字段与省略字段语义区分。凭据的异步解析在提交事务重查来源及上下文，认证头按不区分大小写规则映射。页面登记回执受选择版本约束，中文编辑固定开始时修订，避免迟到结果和新快照覆盖用户当前选择或旧草稿。

只修改现有项目并保留原始数据、固定21工具；不恢复人工审批或业务脱敏。不自动 push、merge 或发布。合成 Provider、真实本机 Codex 协议及未执行的付费模型／企业／Windows验收分开记载。

本专项源码`153202c`：17项确认问题（4 P1、13 P2）全部经独立复审关闭；check、后台396/396、浏览器71/71、本机Codex合成闭环通过。服务数据核对与最终提交打包记录按专项报告定位；企业、真实模型、Windows和实体手机验收继续独立保留。
