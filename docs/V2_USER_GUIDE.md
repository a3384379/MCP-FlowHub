# FlowHub 2.0 本地使用说明

## 发现与导入

Codex 发现页会首次扫描本机上下文。元数据扫描不调用业务工具；“连接并同步工具”通过真实 MCP 获取目录和 Schema。
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
帮助模式只检索和解释，附当前版本引用；编排模式根据请求选择编辑、自测、发布或运行。工具卡片才是实际动作回执，聊天中的完成声明不是保存证据。
MODEL_AUTH_FAILED 表示认证失败，MODEL_RATE_LIMITED 表示429；保留会话，不无限重试。MODEL_UNSUPPORTED_TOOLS 表示仅文本模型，仍可问答。取消停止后续动作，已经完成的工具回执会保留。重启的未完成任务为 INTERRUPTED，不自动重放写操作。

## 当前画布与撤销

在画布右侧切换“属性 / AI 助手”，上下文显示 workflowId、revision 和选中节点。AI改图由服务端真实保存，刷新后仍存在。未保存输入和发布审阅候选保持不变；冲突时可以比较、另存或明确丢弃本地修改。
工具卡片提供撤销/重做，只逆转该动作涉及的字段；后来同字段已修改时返回 REVISION_CONFLICT，其他编辑保持不变。新节点仅局部布局，不重排整张画布。
自测面板可生成、编辑Fixture、运行Mock并查看expected/actual。通过后修改草稿会提示基线过期。
运行的 analysis 检查点可选择已配置模型继续，使用独占租约和同一推进接口；host_tool/host_skill 或明确 codex_host 节点须由Codex执行，Key不能替代宿主权限。

## 上下文、限额与宿主验收

发现页可登记自定义 Codex Home、项目目录和 Profile，并明确是否读取可信项目或独立 App Server 会话；读取选项更新使用 revision CAS。独立会话目录不能代表桌面会话已有授权。
v2 MCP 节点可显式配置 rowLimitArgument（例如 /limit）为下游 Schema 的数字型原生参数，执行前取用户值、工作流预算、绑定预算的最小值。未声明时 TOOL_LIMIT_ENFORCEMENT 事件记录 unsupported；返回结果行数检查不能保证远端查询成本受限。
开发者可运行 npm run test:codex-local；它使用临时 CODEX_HOME、合成库与独立 daemon，通过当前本机 Codex App Server 完成真实 MCP 编排/自测/报告闭环，不读取已有登录凭据，不调用付费模型。30 个自然语言真实模型场景需另行配置模型后验收，协议测试通过不代表模型效果已验收。
