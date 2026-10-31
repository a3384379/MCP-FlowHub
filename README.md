# MCP FlowHub

面向 Codex 等 AI Harness 的轻量级、可视化 MCP 能力编排与管理工具，优先服务个人开发者。配置一次工作流，之后由 Codex 选择并执行。

统一管理多个 MCP Server，发现工具及参数，在画布编排执行链路，保存草稿并发布为不可变版本。对宿主始终只暴露一个 FlowHub MCP Server 和固定七工具：workflow_search、workflow_get、workflow_start、workflow_advance、workflow_status、workflow_cancel、artifact_read。

## 启动

Node **24.19.0**、npm **11.9.0**：

    npm ci
    npm run build
    npm start

默认 http://127.0.0.1:18473。首次使用数据目录内 admin-setup-token 设置码创建管理员口令并初始化凭据库；重启后单独解锁。另一个终端运行 `npm run mcp`，或按接入设置生成受限宿主配置。

    npm start -- --data-dir /tmp/flowhub-dev --port 18474
    npm run mcp -- --data-dir /tmp/flowhub-dev

Linux 数据目录默认为 $XDG_DATA_HOME/mcp-flowhub（未设置时 ~/.local/share/mcp-flowhub），Windows 为 %LOCALAPPDATA%\MCP-FlowHub。程序与数据分离。

## 能力

- MCP 连接、工具发现、Schema 指纹、固定环境绑定、资源与工具白名单。
- React Flow 画布，拖拽、连接、参数映射、Schema 编辑、保存、校验及不可变发布。
- 串行与互斥分支；确定性 auto 与 Codex guided；预算、取消、幂等和明确的不确定结果。
- Agent 分析与宿主 Skill 交接，Markdown/安全 HTML 报告，执行步骤、参数、实际输出、耗时与证据索引。
- 业务输入、MCP 结果、Agent 输出和报告按原值保存及传递，不做业务内容自动替换。
- 加密凭据库、secretRef、独立管理会话及受限宿主身份，凭据不在连接列表或配置导出明文回显。
- SQLite 一致性备份、停止服务恢复、结果保留与清理、仅含版本/计数/状态/错误码的诊断导出。

标准链路：日志 MCP → Agent 分析 → 条件 → 数据库 MCP（可跳过）→ 结果分析 → 报告 Skill。工具满足发布版本、有效配置、可用连接、正确绑定、有效参数及工具白名单后直接执行。没有人工审批节点、审批接口或业务脱敏开关。

Web 启动 guided 运行时选择接入设置中创建的受限宿主身份。只有所选 owner 可以通过 MCP 继续该运行，其他宿主不能接管；管理员仍可查看或取消。不要使用默认全权限令牌规避归属限制。

## 升级与验证

升级前创建一致性备份；旧流程处理见 [迁移指南](docs/MIGRATION_AUTOMATION.md)。不删除数据库，不改变旧发布快照。旧审批流程复制为新草稿后需校验并明确发布。旧活跃审批运行先自动备份再停止；已派发而结果不明的调用标为 OUTCOME_UNKNOWN，不自动重放。

    npm run check
    npm test
    npm run build
    npm run test:ui
    npm run package:local
    npm run test:package
    npm run verify:release

Windows 包必须由原生 Windows CI 构建和测试；Linux 结果不能替代。测试仅使用合成 MCP 与数据。真实 Codex、实际公司服务与 Windows 行为需外部验收，不自动发布。

[产品架构](docs/01_产品与架构设计.md) · [协议数据](docs/02_协议接口与数据设计.md) · [UI](docs/03_UI原型与交互规格.md) · [测试验收](docs/04_测试验收与云端交付.md) · [宿主接入](docs/HOST_INTEGRATION.md) · [安装核验](docs/LOCAL_VALIDATION.md) · [实施记录](docs/PLAN.md)
