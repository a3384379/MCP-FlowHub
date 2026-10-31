# FlowHub 2.0 本地使用说明

## 登录

默认账号 `admin`，默认密码 `admin`。首次打开直接登录，无需读取设置码或创建管理员；首次登录自动初始化凭据库。已有管理员口令不会被默认值覆盖，旧的仅密码登录 API 继续兼容。

## 发现与导入

Codex 发现页会首次扫描本机上下文。可选择自动查找、手动填写 Codex 绝对路径，或仅导入配置；仅配置模式不启动 CLI/App Server，来源覆盖不完整时显示 PARTIAL。页面记住当前上下文。元数据扫描不调用业务工具；“连接并同步工具”通过真实 MCP 获取目录和 Schema。
插件已安装、已启用、Schema 已发现及可执行是独立状态。多版本安装歧义、配置损坏、缺少认证都显示部分结果；不要把空清单当作已完整扫描。
导入只写 FlowHub，源 Codex 配置不变。相对命令需要在 MCP 工具库补充绝对路径。带认证的来源先点“配置连接凭据”，将变量名映射到已有 Vault ID，或明确勾选导入该来源的内联环境变量/Bearer 凭据；只有专用本地管理入口能导入。Vault 必须已解锁，其他认证头暂报 CREDENTIAL_IMPORT_UNSUPPORTED。然后同步目录、导入能力并独立验证绑定。托管插件和 Skill 使用 codex_host，由宿主执行。

## 草稿与固定环境

先创建草稿，再通过语义操作编辑、校验、生成用例和发布。创建、发布、启动是独立意图；明确请求连续完成时可依次调用，无人工审批节点。
生产 production、试运行 staging、测试 test 的绑定不能混用。试运行数据库绑定先登记实际连接、锁定资源，再通过明确的只读合成探测及独立服务权限确认；协议目录同步不等于环境已经验证。
只支持串行与互斥条件，不支持循环、并行或任意脚本。业务内容保持原值，连接认证值仅通过凭据库引用。

## Codex 编排

默认个人入口提供固定 21 工具。旧受限 execution 身份仍提供七个运行工具；显式 authoring 身份可创建并使用自己的新流程，不能取得未授权的旧流程。
发现上下文通过本机管理 API 登记，host_scan 只接受已登记 contextId；不接受任意命令或扫描全盘。
创建链路：capability_search/get → capability_import → workflow_draft_create/patch → workflow_draft_validate → workflow_test_generate/run/status → workflow_draft_publish。
运行链路仍为 workflow_search/get/start/status/advance/cancel 和 artifact_read。

## 用例生成与自测

workflow_test_generate(strategy=deterministic) 根据输入 Schema 产生基准用例；agent_proposed 接收 Codex 提供的合成 Fixture 和断言，不需要模型 Key。
确定性生成覆盖必填/类型、数字与字符串/数组边界、枚举和布尔输入；布尔分支可独立统计true/false。复杂pattern等无法由采样器满足时返回INPUT_SAMPLE_REQUIRED，需补合法Schema example；超出200例或过大边界报告GENERATION_LIMIT，不承诺自动穷尽。Mock入参和输出也校验已发现Schema。
workflow_test_run 默认 mock；在隔离库通过同一引擎与注入连接器执行，不读取真实 Secret、不连接真实业务服务。缺 Fixture 为 FIXTURE_MISSING/未覆盖；断言失败显示 expected/actual。修改草稿、能力或 Fixture 后旧基线显示 stale，需要重新生成/运行。
contract/live 请求目前明确返回 TEST_MODE_UNSUPPORTED，不静默切换真实环境。

## 常见错误

TYPE_MISMATCH：映射来源与目标 Schema 类型不一致，检查节点、目标 JSON Pointer 及来源字段。
MAPPING_INVALID：目标 Pointer 不合法、字段重叠或必填参数缺失，读取校验 issues 后局部修复。
REVISION_CONFLICT：Web 与 AI 基于旧 revision 同时编辑，保留本地改动，重新读取后合并，不能整图覆盖。
CAPABILITY_STALE：工具 Schema、来源或能力修订改变，读取新定义并修复草稿；旧发布版本不会自动更新。
CREDENTIALS_REQUIRED：连接凭据尚未配置；不要把 Key 或口令放入聊天或 MCP 工具参数。
FIXTURE_MISSING：自测尚无节点合成结果，不代表实际服务为空或正常。

## 网页助手与模型

模型设置明确选择 Responses 或兼容 Chat Completions 协议，填写服务地址与模型名，Key 只在专用输入保存至本机 Vault。无 Key 时仍可用发现、手工画布、Codex 和 Mock 自测。更换 Key 不会回显原值，不使用浏览器 localStorage 保存 Key。
帮助模式只检索和解释，附当前版本引用并可查看原文和来源是否过期；会话支持历史分页与删除。模型可配置超时、流式和轮数/用量预算，缺少 usage 显示未知。编排模式根据请求选择编辑、自测、发布或运行。明确否定运行或发布时不会授权相应动作。选中的流程、运行和产物限制工具访问及后续上下文，切换选择不会默认外发其他运行历史。工具卡片才是实际动作回执，聊天中的完成声明不是保存证据。
MODEL_AUTH_FAILED 表示认证失败，MODEL_RATE_LIMITED 表示429；保留会话，不无限重试。MODEL_UNSUPPORTED_TOOLS 表示仅文本模型，仍可问答。取消停止后续动作，已经完成的工具回执会保留。重启的未完成任务为 INTERRUPTED，不自动重放写操作。

## 当前画布与撤销

在画布右侧切换“属性 / AI 助手”，上下文显示 workflowId、revision 和选中节点。AI改图由服务端真实保存，刷新后仍存在。未保存输入和发布审阅候选保持不变；不同节点、字段和布局的并发修改自动合并，同一字段冲突分别展示双方值，可逐项选择保留本地或采用服务端版本后按新 revision 保存。
工具卡片提供撤销/重做，只逆转该动作涉及的字段；后来同字段已修改时返回 REVISION_CONFLICT，其他编辑保持不变。新节点仅局部布局，不重排整张画布。
自测面板可生成、编辑Fixture、运行Mock并查看expected/actual。通过后修改草稿会提示基线过期。
运行的 analysis 检查点可选择已配置模型继续，使用独占租约和同一推进接口；host_tool/host_skill 或明确 codex_host 节点须由Codex执行，Key不能替代宿主权限。

## 数据保留与历史消息

“接入设置 → 数据保留与清理”先显示对象与数量，再确认绑定该范围的预览哈希。终态运行、助手与自测结果正文保留 7 天，元数据保留 30 天；结果来源先到期时，关联任务、消息、工具回执和应用事件中的副本也随之到期。活跃运行、活跃助手会话、已保存的测试套件配置、发布版本与能力修订不参与这次正文清理。预览本身不修改数据；提交时范围或正文发生变化必须重新预览。

新助手消息保存 taskId 和上下文、模型来源，保留策略可区分同一会话中的不同来源。已交付旧版消息可能没有 taskId，无法证明其正文与同会话已到期任务无关。这类消息在会话存在到期或待删除任务时，单独列入“来源到期会话中的历史未归属消息正文”范围，显示数量与消息 ID，即使消息创建时间较新。只有管理员确认本次清理后才清除正文并标记 resultsExpiredAt；不会猜测内容归属、替换字段或自动执行清理。活跃会话继续受保护，具有任务归属且来源无关的较新消息保留。

该兼容策略只处理可确认的来源关联及明确列出的未归属旧消息，不声称能恢复旧版本未记录的模型派生链路。已有备份、历史 WAL 和外部复制件具有独立生命周期；清理不宣称对这些副本安全擦除。

## 上下文、限额与宿主验收

发现页可登记自定义 Codex Home、项目目录和 Profile，并明确是否读取可信项目或独立 App Server 会话；读取选项更新使用 revision CAS。独立会话目录不能代表桌面会话已有授权。
原生 host_tool 支持有边界的本地 $defs/$ref 和对象 additionalProperties 默认语义；远程引用、递归和超预算 Schema 明确拒绝。检查点仍按冻结的原始宿主契约验证，Mock 明确标记 synthetic_fixture，不能作为真实宿主已执行的证明。
v2 MCP 节点可显式配置 rowLimitArgument（例如 /limit）为下游 Schema 的数字型原生参数，执行前取用户值、工作流预算、绑定预算的最小值。未声明时 TOOL_LIMIT_ENFORCEMENT 事件记录 unsupported；返回结果行数检查不能保证远端查询成本受限。
开发者可运行 npm run test:codex-local；它使用临时 CODEX_HOME、合成库与独立 daemon，通过当前本机 Codex App Server 完成真实 MCP 编排/自测/报告闭环，不读取已有登录凭据，不调用付费模型。30 个自然语言真实模型场景需另行配置模型后验收，协议测试通过不代表模型效果已验收。
