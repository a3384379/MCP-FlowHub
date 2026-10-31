# FlowHub 2.0 审计与修复

以 `5c68e54b17a87d916782191b1e388a7510d020ea` 为审计基线，逐项对照 `upgrade-v2` 完整方案、接口契约、104 项验收和真实代码。交付版本 `2.0.0-alpha.2`；此前 S0–S7 的测试是历史基线，本报告记录本轮修复与复验。

用户要求 max 审计、极高修复。发现与导入、编排与自测、助手与 Provider 三个独立审计分支均使用 `reasoning_effort=max`；实现与补修使用 `xhigh`。审计先以合成输入复现，再交回修复并独立关闭复核。发现项编号保留原始轮次，同一问题的补修不重复统计为独立缺陷。

## 环境与边界

- 当前分支 `feat/flowhub-v2`；审计开始时工作区干净。fetch 后 `origin/main` 仍为设计基线 `45eed03ee9f6f513a5c67e854d3d42e16afee636`。
- macOS arm64、Apple M4；验证使用隔离 Node24.19.0/npm11.9.0，系统默认 Node/npm 未改动。
- 使用现有仓库、单一 daemon、固定21工具与兼容7工具。未恢复审批或业务自动脱敏；业务字段如 token/password 仍保留原值，检查点认证与连接认证按各自用途隔离。
- 所有复现使用内存库、临时目录、合成模型服务和 MCP 服务；未访问正式数据库、企业业务系统或已有 Codex OAuth。真实 Codex 验证使用临时 CODEX_HOME。
- 已交付迁移1和迁移2的 DDL/checksum 均冻结。本次未改历史表结构或增加迁移。
- 未 push、merge、Release；未操作日常安装或浏览器用户配置。

## 发现项与修复映射

原始发现及第二轮仍未关闭的复现清单保存在 [audit 证据目录](evidence/v2/audit/)。下面按原始编号列出，最终状态见本报告末尾及独立 closeout 文件。P1/P2 是实际缺陷优先级，设计文档中的 P0/P1 功能优先级与之不同。

### 发现与导入

| 编号 | 级别 | 原始问题 |
|---|---|---|
| DISC-A01 | P1 | 源连接变更后新导入仍复用旧地址和旧身份 |
| DISC-A02 | P1 | 同上下文旧扫描能覆盖新扫描并把新能力标失效 |
| DISC-A03 | P1 | 禁用来源后旧能力仍ready且导入会重新启动已禁用MCP |
| DISC-A04 | P1 | Codex工具allowlist/denylist被丢弃或未执行 |
| DISC-A05 | P1 | 不匹配有限正则的命令行凭据明文复制入connections |
| DISC-A06 | P2 | 成功导入的幂等重放仍连接下游并可因停服失败 |
| DISC-A07 | P1 | 目录扫描无总deadline与取消，daemon shutdown可被扫描长期阻塞 |
| DISC-A08 | P2 | Skill启用覆盖被忽略，显式禁用Skill仍可作为host_reference导入 |
| DISC-A09 | P2 | HTTP别名形式的FlowHub来源完全绕过self识别 |
| DISC-R01 | P1 | Schema漂移后新能力仍复用旧连接目录 |
| DISC-R02 | P2 | 元数据刷新无语义变化却失效已发现能力和修订 |
| DISC-R03 | P2 | 显式配置模式与手动Codex路径入口缺失 |
| DISC-R04 | P2 | 保守参数策略误把合法模块启动当凭据且无解除路径 |

`host-discovery`、`capability-registry`、`mcp-connectors` 与发现/能力选择页面共同修复：每上下文 generation、source/CAS 校验与总 deadline；禁用来源、Skill 和工具过滤；幂等命令先重放再联网；self 身份按实际 endpoint/协议名识别。执行连接身份冻结来源、Vault 引用、协议和完整目录指纹，Schema/description 漂移产生新连接，保留旧绑定。仅扫描时间变化不递增能力语义 revision、不使已完成自测失效。

显式 null/config_only 不启动 CLI 或 App Server；UI 可登记绝对 CLI 路径并记住上下文。Python -m/-u、Node、uvx --from、npx --package 有受限 launcher 解析；已识别认证参数拒绝普通导入，未知参数准确显示 unsupported。目录搜索使用 SQL 摘要投影与分页，不为一页加载全部 Schema。插件未知格式拒绝，索引不执行 hooks/Skill 脚本、不依赖 plugin/list/read。

证据：`v2-discovery.test.ts`、`v2-discovery-acceptance.test.ts`、`v2-discovery-reaudit.spec.ts`；独立关闭复现检查原第二轮四场景。仅代码注入的 DiscoveryRuntime 用于测试，以 Node 真正执行跨平台夹具；生产 CLI/API 无此配置入口，不绕过真实可执行路径校验。

### 编排、执行与自测

| 编号 | 级别 | 原始问题 |
|---|---|---|
| AUTH-RUN-01 | P1 | rowLimitArgument overwrites locked resource arguments before dispatch |
| AUTH-PUBLISH-02 | P1 | HTTP v2 publication omits required binding CAS when the field is absent |
| AUTH-HOST-03 | P1 | host_tool can replace the discovered output contract with an incompatible node schema |
| TEST-HOST-04 | P1 | isolated Mock runner does not copy capability revisions, so valid host_tool cases cannot run |
| TEST-IDEMPOTENCY-05 | P2 | test generation/run replays check mutable baselines before the idempotency ledger |
| REAUDIT-TEST-01 | P1 | Regenerating the same suite can revive an obsolete green run as current |
| REAUDIT-MOCK-02 | P1 | Text fixtures still change result adaptation and falsely pass a workflow the real connector rejects |
| REAUDIT-HOST-03 | P1 | Exact host schema equality plus the restricted agent schema makes ordinary native MCP output contracts unusable |

统一 AuthoringService 在所有入口校验发布 DTO 与绑定/能力 CAS；rowLimitArgument 不得与锁定资源 Pointer 重叠，发布与派发均防御。host_tool 使用发布时冻结的能力契约并在推进时校验实际宿主结果，不能弱化节点 Schema；当前目录缺失或改变不修改旧发布契约。

原生对象 Schema 支持省略/true 的 additionalProperties 及有边界的本地 $defs/$ref；远程、动态、递归、作用域重定义和超预算拒绝。严格 v1/analysis Schema 边界未放宽。Mock 从接受请求时冻结的套件、用例、草稿、绑定和能力快照运行，绝不读取凭据或业务网络；宿主夹具标 synthetic_fixture，生产宿主结果标 host_reported。文本适配与真实路径相同，不能因有 Fixture 自动切换适配器假成功。旧绿报告比较自身接受基线，重新生成相同用例不能复活旧绿状态。

用例幂等先查接受账本，清理后明确 RESULT_EXPIRED；取消/关闭覆盖套件循环、轮询、连接、advance，并等待异步任务收束，防止关库后写入。确定性生成增加嵌套输入/字符串条件分支样例及覆盖缺口。undo 仅逆转原动作字段，布局不会伪造语义修订。MCP 坏参经官方 SDK 公开请求入口返回固定结构化错误，保留工具 Schema、21/7权限和元素预算。

证据：`v2-authoring*-regressions`、`v2-authoring-reaudit`、`v2-testing-audit-regressions`、`v2-mcp-selftest`、`protocol`；独立第三轮44+4测试及3个自定义复现关闭原5项与第二轮3项。本轮完整后台回归同时覆盖后续新增官方 SDK 权限与坏参测试。

### 助手、Provider与知识引用

| 编号 | 级别 | 原始问题 |
|---|---|---|
| ASST-A01 | P1 | Negated requests and staging nouns grant execution intent |
| ASST-A02 | P1 | Selected workflow scope does not restrict workflow_start or workflow_cancel |
| ASST-A03 | P1 | Help-mode run context sends an execution credential to the model and permits cleartext persistence |
| ASST-A04 | P2 | Deleting a session leaves event copies and analysis-tool ledger orphans |
| ASST-A05 | P2 | Successful analysis submission cannot be retried with the same idempotency key |
| ASST-A06 | P2 | A usable non-streaming model is unusable through the formal UI |
| ASST-A07 | P2 | Timeout and body-read failures escape the Provider error contract |
| ASST-A08 | P2 | Analysis UI permanently disables retry and can disable the next analysis checkpoint |
| ASST-A09 | P2 | Tool knowledge citations carry hashes of invented excerpt text rather than the cited file range |
| ASST-R01 | P1 | The new server intent envelope still turns common explicit negatives into authorization |
| ASST-R02 | P2 | Clearing or switching selected run does not remove the previous run's business answer from model history |
| ASST-R03 | P2 | Fresh assistant-message copies survive cleanup of their expired source run because messages are not linked to taskId |
| ASST-R04 | P2 | Sending a new message leaves the previous COMPLETED task visible and cancellable until acceptance returns |
| ASST-R05 | P2 | Analysis ignores the newly configurable correction-attempt budget |

共享 assistant-intent 约束前后端请求，否定、解释、引用和“试运行”名词不能授权执行；流程/运行/测试/取消工具均限定当前选择。服务端注入 checkpoint credential，Provider 上下文、普通消息、SSE 和工具回执不携带执行凭据，业务原值不替换。消息记录 taskId、contextRefs、providerIdentity；历史按当前选择和模型来源筛选，切换或清空运行不外发原运行答案。

会话删除与任务事件/分析账本原子关联；终态接受幂等可重放，过期 tombstone 明确错误。非流式/stream 探测失败走兼容回退；Provider 的 headers/body/SSE 超时、非法 JSON、大小预算保持类型化错误；模型身份变更失效旧探测。analysis 的初次请求计入可配置尝试预算，整个任务共用 deadline，usage 可累加且保留未知。

网页增加会话与消息分页/删除、配置预算、来源与当前引用原文。新 POST 立即 SUBMITTING，旧任务状态/接受响应不能覆盖新会话；改图使用服务端基线三方字段合并，互不相交修改自动保留，同字段逐项选择，raw JSON 与发布审阅受到保护。analysis 的 checkpoint/run 切换与取消响应需要同一代次和任务身份验证。

证据：`v2-assistant`、`v2-assistant-audit-regressions`、`v2-retention-legacy-messages`、`v2-draft-merge`、`v2-assistant-audit.spec.ts`。独立关闭原复现并运行17/17；ASST-A08 的延迟旧响应边缘在最终浏览器补修后另记证据。

### 精确验收补充

| 编号 | 原始表现 | 修复与证据 |
|---|---|---|
| KB-R01 | rebuild复用chunkId后读取当前hash，旧citation可能被误标为最新 | 原引用hash与行范围从历史消息完整送到source API，重建后仍比较原引用；临时文档改行/改内容与真实原文UI验证 |
| UI-R01 | CapabilityPicker为host_skill缺reportContractRef，默认summary输出不满足宿主报告合同 | 填incident-report/v1及reportMarkdown/evidenceRefs契约；用真实发现、SDK目录、画布插入、刷新持久化精确验证 |
| UI-R02 | 自测终态停止轮询后，草稿修改仅提示套件过期，旧绿回执未标过期 | revision/suite变化重新取后端状态，立即由接受基线派生stale标识；真实Mock完成后编辑保存验证 |

补充 `v2-assistant-acceptance.test.ts` 对两协议单轮多call串行与callId回送、未知/部分usage持久化、类型错误修正保留同一checkpoint、派发中取消不重放、大报告上下文边界及跨owner隔离逐项断言。ASST-02实际公开类型错误码为 INPUT_INVALID，不能声称运行返回了字面 TYPE_MISMATCH。

### 根代理补充的数据生命周期缺陷

| 编号 | 触发与原始表现 | 实际修复与验证 |
|---|---|---|
| DATA-01 | FTS 虚拟表替换为同列普通表仍通过启动/备份预检，MATCH 失效 | 按冻结参考库只读核对实际 DDL、table_xinfo、模块、shadow 与自动索引；损坏统一 MIGRATION_MISMATCH，禁止重建空库 |
| DATA-02 | 运行正文清理后，助手任务、消息、tool ledger、SSE事件仍留业务副本 | 7天正文/30天元数据按来源关联清理；预览 digest 绑定内容，活跃任务与配置/发布保护；无taskId旧消息单列保守清理范围且需确认 |
| DATA-03 | 修改 Vault 口令后，v2 Provider continuation 与历史加密检查点交付无法解密 | 仅对已知认证加密路径在同一事务重包；坏密文或写失败完整回滚；不递归猜测业务密文 |

新增 `v2-audit-persistence.test.ts`、`v2-persistence-lifecycle.test.ts`、`v2-retention-legacy-messages.test.ts`。覆盖同列假 FTS、CHECK/约束漂移、shadow 损坏、备份只读、口令轮换及失败原子性、所有结果副本清理、旧hash冲突、active保护、配置不清理、历史消息后续不外发。daemon 停机先拒绝新请求、关闭所有 worker/连接/租约后锁 Vault/关库；清理异常也释放 HTTP socket 与锁，不吞掉原异常。

旧消息未知派生关系无法事后恢复，保留策略已在用户指南说明；备份/WAL/外部复制件具有独立生命周期，未声称安全擦除。未自动执行用户数据清理。

## 本轮实际命令与证据

项目隔离 PATH 为 `/tmp/flowhub-v2-runtime/npm-tool/node_modules/.bin:/tmp/flowhub-v2-runtime/node-v24.19.0-darwin-arm64/bin:$PATH`。

| 命令 | 结果 | 证据 |
|---|---|---|
| npm run check | exit0；两套TypeScript与37正例/65负例设计检查 | audit/check.txt |
| npm test（含完整build） | exit0，338/338，120.1秒；未skip | audit/tests.txt |
| npm run test:ui | exit0，35/35，49.1秒；隔离Chromium | audit/ui.txt |
| node scripts/smoke-codex-v2.mjs | exit0，真实本机Codex 0.164.0-alpha.11.1；21工具与编排/自测/报告 | audit/codex.txt |
| node scripts/smoke-v2-upgrade.mjs | exit0，实际旧程序创建、逐行保留、停机恢复、旧程序重启 | audit/upgrade.txt |
| node scripts/benchmark-v2.mjs | exit0；100节点校验P95 4.41ms；500组件扫描P95 125.15ms | audit/performance.json |
| node --test dist/tests/poc/v2-assistant-sse-replay.test.js | exit0；真实SSE断线重连，无重复patch/模型调用 | audit/sse-replay.txt |
| npm run package:local / test:package / verify:release | 均exit0；macOS arm64 alpha.2包内Node、中文帮助、modern/legacy、21/7目录、持久化与篡改负例 | audit/package*.txt |

`build` 成功包含服务器、Web、生成OpenAPI。Vite仍提示既有xyflow use-client指令和大于500kB chunk，均为非失败警告；没有关闭检查掩盖。目录分页基准另有200/1000能力、每个30KB Schema、40样本，P95为6.44/68.95ms（audit/discovery-performance.json），与完整页面端到端延迟不同。

归档文本日志仅去除ANSI终端样式和行尾空白，命令、失败内容和结果不变；原始日志仍在/tmp/flowhub-v2-audit-*。

早期失败内容留存：原三处UI错误27/30、旧选择器34/35、夹具不合法等。后续修复没有删用例：原发布冲突用例增加真实同字段编辑，纯远端修改正确自动合并；模型测试在每个面板明确选择其合成Provider；常量true分支的自测预期改为PARTIAL并断言未覆盖false缺口，真实SUCCEEDED→stale另有独立UI用例。CLI夹具在所有系统由Node启动真实子进程，且断言CLI版本防止静默配置回退。

当前104项矩阵为 **95 PASS / 4 PARTIAL / 5 UNVERIFIED**，见acceptance-results.json。4项PARTIAL为完整配置覆盖链DISC-03、精确工具漂移修复全场景CAP-07、复合发布漂移全场景AUTHOR-08、真实宿主专用能力执行RUN-07；不得计作全通过。5项UNVERIFIED为原生Windows/WSL、原生包、权限策略演练、卸载保留与新机教程。30条真实模型评测全部保持UNVERIFIED，0次真实模型调用。

离线候选包门禁在本轮证据提交前均exit0，最终交付由最终本地提交重新构建，使build-info.gitSha=HEAD且dirty=false。最终归档及SHA-256以未纳入Git的artifacts/latest-package.json为准，避免把最终包hash写回源码引起自引用。

## 关闭结论

三轮独立审计的35条原始/补修记录在各自原复现范围内关闭；原35条包含同一问题的后续补修，不当作35个互不相关漏洞。发现13项独立关闭复核、编排8项第三轮关闭复核、助手14项及A08补充复核，分别保留在discovery-closeout.json、authoring-closeout.json和assistant-closeout-addendum.json。补充KB-R01、UI-R01、UI-R02与根代理3项数据缺陷由真实回归关闭。未发现仍开放的已复现P1；这不等于所有设计/真实环境门禁通过。

实现与修复只修改现有仓库，原正式数据未访问、未清理。原始业务字段与产物保持原值；没有恢复审批，没有使用新的付费模型或复制Codex OAuth。

## 未验证与验收限制

104 项逐项矩阵继续以真实测试映射；PARTIAL 不计通过。真实目标模型30场景、Windows/WSL原生构建安装、企业MCP权限、当前 Desktop 会话已有授权保持独立门禁。本轮实际 Codex App Server 会话验证不等于真实自然语言模型评测，也不证明所有企业插件可调用。

性能为本机合成基准，非所有目标设备承诺。画布事件到渲染 P95≤500ms 尚无专用测量，不以截图或正常交互测试推定通过。
