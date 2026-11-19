---
name: flowhub-run
description: 启动已发布的 FlowHub 工作流或按 runId 接力原运行，完成当前宿主检查点并读回报告。
---

# 执行 FlowHub 工作流

用户提供 runId 或粘贴「Codex 续跑指令」时，用当前 FlowHub 身份调用 `workflow_status`（`view: "checkpoint"`）读取原运行。核对返回的版本、环境和业务范围。身份无权读取时，说明需要原运行身份。

用户要求启动新运行时，通过 `workflow_search` 找候选，再用 `workflow_get` 读取精确发布版本、环境、输入 Schema 和执行要求。有多个候选或缺少必填范围时先确认。生产调用需得到用户明确授权。调用 `workflow_start` 后，以返回的 runId 继续。

1. 只在 `WAITING_AGENT` 处理当前检查点。用状态返回的 checkpoint ID、token、revision、输入和输出 Schema。Vault 锁定或无法取得 token 时暂停，等待用户在 FlowHub 解锁。
2. 具名宿主节点先核对当前 Codex 会话中的服务器、工具及冻结契约。新版检查点（`requireHostReceipt: true`）先向 `workflow_advance` 提交 `{type:"host_tool_claim"}`。成功后保存返回的 `claimId` 和 `acceptedRevision`。认领响应丢失时重放同一请求和幂等键。已有其他认领时停在本节点。
3. 只把 `resolvedArguments` 原样传给该具名工具。以认领后的修订提交 `host_tool_result`，填写 `claimId`、`capabilityId`、`capabilityRevision`、`argumentsHash` 和工具实际结构化 `payload`。宿主提供调用 ID 时带上 `toolCallId`。确定没有工具、授权被拒或契约改变时提交 `host_tool_failure`，分别填 `HOST_CAPABILITY_UNAVAILABLE`、`AUTH_REQUIRED` 或 `HOST_CONTRACT_MISMATCH`。业务调用已派发但结果无法确认时提交 `OUTCOME_UNKNOWN`，停止自动推进。回执网络异常只重放原回执和幂等键。回执校验失败时用已捕获的工具结果纠正提交。
   - 旧版检查点继续按声明提交 `agent_result`。说明型分析或 Skill 仅在用户已授权的只读范围内取证。Skill 不可用时遵照发布快照中用户明确选择的回退。
4. 轮询同一 runId，直到终态或出现需用户处理的阻塞。`OUTCOME_UNKNOWN`、失败、取消或权限不足时停止自动推进，保留已知回执。等待期间避免另建运行。
5. 终态后按 `artifact_read` 的 `nextOffset` 读完报告并给出 runId、执行状态、业务核验结论和证据缺口。报表成功归档时仍须核对业务核验摘要。检查点 token 只用于本次工具参数。
