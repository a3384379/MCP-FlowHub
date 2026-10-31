# 05｜本地 Codex 升级提示词

## 使用方式

把整个设计包放在现有仓库的 `docs/upgrade-v2/`。不要覆盖现有根 `AGENTS.md`；先让 Codex 阅读，再把本次明确的新需求合并为增量约束。下面“总提示词”可直接复制到**本地 Codex**，不是云端任务。

本文件授权的是本地代码开发与合成测试；不意味着允许删除本地数据、推送发布、修改公司安全软件或查询生产业务。遇到真实 Key/真实 MCP 缺失，完成其余模块，用合成 Fixture 验证，并将实机项目标记待验证。

---

## A. 总提示词（直接复制）

```text
请在我当前打开的 MCP-FlowHub 本地仓库中完成 2.0 增量升级。不要另建一个替代产品，不要只给方案或生成静态演示。

仓库标识：a3384379/MCP-FlowHub。
请先查找并阅读 docs/upgrade-v2/ 下本设计包；如果目录不同，在当前仓库内查找“02_完整开发方案.md”和“03_接口与数据契约.md”，不要扫描整个用户盘。

一、目标
1. 自动发现本机 Codex 已配置的 MCP、已安装插件及 Skills，显示来源、Schema、启用/可用状态，能将适用能力导入 FlowHub。
2. Codex 通过同一个 FlowHub MCP 直接创建、修改、校验、生成测试、自测和发布可视化工作流。
3. 网页内置 BYOK 智能助手，能回答本项目问题并引用资料，能真正创建和修改流程，变更同步画布并持久化。

二、已经确定的产品边界
- 个人开发者优先，仍只有一个 FlowHub MCP Server，不按工作流生成 Server 或专属 Tool。
- 原七个执行工具保持兼容；增加设计中的十四工具，总集合二十一个。更新旧 AGENTS.md/README 中“只能七工具”的过时约束，这是此次正式需求变更。
- 不恢复人工审批节点、WAITING_APPROVAL、审批开关或逐步人工确认。
- 不恢复业务数据自动脱敏；业务日志、查询结果、Agent输入输出和报告保持原内容。
- 保留真实的连接凭据存储/secretRef、固定环境/资源、Schema、owner、幂等与取消机制。
- 明确“创建草稿”“发布”“执行”的用户意图；用户明确要求连续完成时可连续执行，不新增人工审批门槛。
- 没有模型 API Key 不影响 Codex 路径、手工画布、能力发现和确定性 Mock。

三、基线核查
设计核查基线是 main@45eed03ee9f6f513a5c67e854d3d42e16afee636，已经移除审批/业务脱敏。
这不是要求你强制 checkout 该 SHA：以我的本地最新工作区为准，记录差异。
先执行只读检查：pwd、git status --short、git branch --show-current、git log -1、git remote -v、node/npm版本、操作系统。
保留未提交修改；禁止 git reset --hard、git clean、强制覆盖、自动 stash、清空数据库。
确认仓库后建立适当开发分支；如有无关修改，避开它们或使用明确隔离的 worktree，不丢弃内容。
阅读现有 AGENTS.md 和源码，再记录本方案与实际代码的差异到 docs/V2_IMPLEMENTATION.md。

四、执行顺序
S0 基线与迁移准备。
S1 统一 Authoring Service 和契约。
S2 Codex 自动发现、能力目录与导入。
S3 固定 MCP 编排工具与生成测试/自测。
S4 Provider、知识问答和助手工具循环。
S5 AI画布同步与执行器衔接。
S6 回归、真实本机Codex集成和帮助文档。
S7 打包、原生Windows验收、升级与回滚。
按阶段独立提交本地代码。完成一阶段后继续后续可执行阶段，不反复让我确认相同需求。
若上下文不足，保存当前阶段、提交、测试与下一步到 docs/V2_IMPLEMENTATION.md，不能假装完成。

五、关键实现要求
1. 只有 daemon 写 SQLite；bridge继续只转发。
2. Web、MCP、内置助手共用同一 authoring/application service、DTO、revision和幂等实现。
3. 发现器不修改Codex源配置、不自动安装插件、不执行hooks。版本不支持的CLI选项不能硬调用。
4. Codex App Server适配从本机版本导出的Schema生成类型。生产路径不要依赖官方标为开发中的plugin/list、plugin/read。
5. 本地插件安装索引与manifest解析为基础；不能把marketplace里所有条目列成已安装。
6. 严格区分hub_direct、codex_host、informational。Key不能复用Codex OAuth，扫描结果不代表已取得所有宿主会话工具。
7. 扫描识别FlowHub自己并排除递归导入。
8. 原生MCP结果支持structuredContent与合法text内容；保留原始结果，不强迫所有下游提供私有environment字段。
9. 所有AI改图使用原子operations，处理revision冲突、幂等、撤销与局部布局；不能让模型直接写数据库。
10. 保留v1 DSL读取，为新增host_tool/执行器语义定义v2 DSL；不在旧additionalProperties:false下偷偷加字段。
11. Provider至少实现OpenAI Responses与OpenAI-compatible Chat Completions两个明确适配器，不能混淆协议。
12. 参数流式片段完成前不执行工具；按taskId+callId防止重复执行；取消和网络断线不能重复提交写操作。
13. 项目问答引用当前版本文档/错误定义；中文FTS检索必须有真实测试，不能只用默认分词宣称完成。
14. 生成测试是产品功能：通过MCP创建suite、注入Mock、调用同一引擎、独立断言、报告覆盖缺口；不是LLM自报通过。
15. 所有默认自测不访问真实MCP、不使用真实业务数据。缺fixture必须显示未覆盖，不能用空结果伪造成功。
16. 冻结SQLite旧v1 DDL/checksum，先构建可扩展顺序迁移；不能直接向旧TABLES数组加表后重算v1校验和。
17. 同步备份preflight/恢复校验、打包source快照、OpenAPI、测试fixture及版本文档。
18. 不把2.0新增代码全部塞进现有main.tsx，渐进拆出discovery、assistant、models、testing和workflow模块。

六、本地测试与环境
- 使用当前仓库锁定的Node/npm；不无故升级全局运行时或依赖。
- 使用独立 FLOWHUB_DATA_DIR 或明确 --data-dir，禁止开发测试指向我现有正式库。
- 端口冲突先报告并换独立开发端口，不杀其他进程。
- 本机没有真实MCP时使用设计包的合成配置和协议Mock，不阻止实现。
- 对当前Windows CI失败读取实际日志并定位，不能假定还是前轮错误，不能删测试绕过。
- 不改公司加密/DLP/VPN/代理安全策略；不使用关闭TLS或强制跳过策略的办法解决环境问题。
- 真正需要我输入Key或登录时保留功能并说明待验证项，不索要我把Key粘贴到聊天或提交仓库。

七、完成检查
运行现有 npm run check、npm test、npm run build、npm run test:ui。
新增测试脚本请明确在package.json中实现后再使用，如test:discovery、test:authoring、test:assistant、test:selftest。
通过官方MCP Client而不只调用内部类完成：发现→导入→创建→修改→校验→生成用例→Mock自测→发布→启动→推进→读取报告。
验证100条工作流不改变单Server及固定工具集合。
测试Key缺失/失效、模型不支持工具、半截JSON、429、取消、会话重启、Schema漂移、Web和AI同时编辑。
完成v1真实结构的合成库升级和回滚演练，旧发布快照hash不变。
本机不是Windows时不能宣称Windows通过；原生Windows结果单独记录。

八、交付
提供实际提交SHA、每阶段改动、实现路径、真实命令和退出码、测试证据、未验证项。
维护 docs/V2_IMPLEMENTATION.md、docs/V2_ACCEPTANCE.md、docs/V2_MIGRATION.md、docs/V2_USER_GUIDE.md。
最终不能只说“编译通过”：三条目标链路必须有真实持久化结果和工具回执。没有实际调用模型/真实宿主的部分明确写未验证。
不要自动push、merge或发布Release；先完成本地交付。

请从S0开始，先给出精确影响范围和实施顺序，然后直接开始修改与验证。
```

## B. 分阶段提示词

阶段执行时仍要阅读总提示词与当前实施记录。以下用于单独续做，不替代完整契约。

### S0｜稳定基线与数据迁移准备

```text
继续MCP FlowHub 2.0，执行S0。
核对当前HEAD与设计基线的差异，确认审批/业务脱敏已移除，不把旧缺陷直接当作现存。
读取当前Windows CI失败日志并给出真实原因；本地可复现则修复，无法原生验证则保留待验证标签。
冻结SQLite v1迁移DDL/checksum，将validateMigrations改为顺序迁移注册表，先不改变用户数据语义。
补新库、旧库、损坏checksum、缺表、未来版本、备份preflight、恢复与失败回滚测试。
合并AGENTS的2.0约束：原七工具兼容+新十四工具；更新当前计划。
不要访问我的正式数据库。输出基线测试和迁移测试证据并本地提交。
```

### S1｜统一编排服务

```text
执行S1：从现有管理API和引擎提取统一Authoring Service。
实现draft create/get、语义operation batch、CAS、幂等、局部布局、validate、immutable publish。
所有修改经同一服务，不能为AI复制一套规则。保留现有Web操作。
重点覆盖删除有引用节点、批次失败全回滚、同幂等key重复调用、修订冲突、发布前能力/绑定漂移。
结构无效的中间草稿可保存并有issues，但不能发布；不能恢复approval或redaction字段。
按03落实v2 DTO及Schema，示例自检不是产品测试，必须补真实代码测试。
```

### S2｜Codex发现与能力目录

```text
执行S2：实现HostContext、CLI机器可读发现、TOML兼容回退、本地已装插件manifest/skills扫描、能力目录和导入。
通过本机codex --help/版本验证支持选项；不要硬写不可用的plugin RPC。
Windows/WSL/macOS/Linux上下文分开。记录partial覆盖、错误项和宿主专用executor。
同名不同服务器不合并，扫描源缺失不自动删发布依赖，FlowHub自身不可递归导入。
连接认证只以引用进入目录；缺认证明确标记，不改变Codex源配置。
提供发现页面和真实schema详情，使用合成home/project/cache夹具覆盖完整用例。
```

### S3｜Codex自主编排与MCP自测

```text
执行S3：在唯一FlowHub MCP注册设计中新增十四工具；原七工具兼容。
更新instructions与tools/list协议测试。新个人编排身份支持完整工具，既有execution身份仍兼容。
实现MCP路径创建/修改/校验/发布，生成test suite、Mock运行、独立assertions和test status。Codex通过agent_proposed模式提交proposedCases及fixture，不能因FlowHub未配Key而阻断这条路径。
用官方MCP Client贯穿全流程，不能只内部调用Engine。
模拟必须隔离真实网络和secret，fixture缺失报告未覆盖。测试通过绑定草稿和能力修订，修改后标stale。
验证创建新workflow后当前编排身份能继续使用，但不能扩大到其他现有workflow。
```

### S4｜模型适配、问答、工具循环

```text
执行S4：实现Responses与兼容Chat Completions适配、ModelProfile、加密Key引用、连接/工具/流式能力探测。
实现ScriptedModelProvider，让无Key的自动测试可确定性运行。
项目帮助索引只用当前实现文档，中文分词/错误码/英文标识符混合检索，回答附引用。
构建持久化assistant task/tool ledger，完整参数后执行，多轮call结果回送，取消、超时、429、断流和重启可解释。
聊天上下文按选中工作流/运行传递，不把所有历史数据和凭据塞给模型，不恢复业务脱敏。
需要运行analysis节点时复用同一checkpoint/advance；host-only能力不由API Key伪造调用。
```

### S5｜AI画布与界面联动

```text
执行S5：参考07和离线UI演示实现正式React界面，不复制演示里的硬编码数据充当后端。
实现助手侧栏/工作台、来源和工具操作卡片、当前节点上下文、真实draft.changed同步、局部布局、撤销与冲突。
AI创建或修改后刷新页面仍存在；已有用户未保存修改不被AI回包覆盖。
实现能力发现、模型设置、自测面板的loading/empty/error/partial/离线状态。
保持冰蓝白色方向，1440/1366桌面与窄屏可用；没有审批按钮或业务脱敏开关。
补Playwright关键链路和截图，截图不是功能验证的替代。
```

### S6/S7｜验收与本地交付

```text
执行S6/S7：对照04的全部验收项逐项记录，未执行写未验证。
补30个自然语言场景的真实目标模型评测记录，不用Mock模型通过率冒充真实模型效果。
在可用本机Codex完成扫描、MCP编排、自测和报告最小闭环；没有真实企业MCP时只使用合成服务。
完成版本化打包、内置帮助索引、无Key模式、旧库升级、停机恢复和回滚文档。
Windows需原生验证，不用Linux结果代替；不运行安装器smoke覆盖我的现有安装/数据。
输出RC候选和证据，不自动push/merge/release。最终明确功能已实现与实机已验证的差别。
```

## C. 独立审计提示词

```text
对本地MCP FlowHub 2.0改动做独立审计。不要相信实施记录中的完成声明，逐项核实实际代码和测试。
重点检查：发现是否真实、marketplace/installed是否混淆、插件私有凭据是否错误复用、AI是否真正调用authoring服务、tool结果是否持久化、CAS与幂等是否覆盖断流、Mock是否可能接真实服务、中文问答引用是否存在、旧DDL校验和是否保持、打包是否包含新增模块、原七工具是否兼容。
给出可定位的问题清单：级别、文件/函数/行号、触发条件、影响、最小合成复现、修复建议与验收测试。
不要因为测试全部绿就默认没有问题，也不要为了安全治理重新建议加回人工审批和业务自动脱敏。
审计期间不修改代码，除非我另行要求；可创建独立合成复现脚本，不能访问真实企业数据。
```
