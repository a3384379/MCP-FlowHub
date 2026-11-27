---
name: flowhub-run
description: 启动已发布的 FlowHub 工作流或按 runId 接力原运行，完成当前宿主检查点并读回报告。
---

# 执行 FlowHub 工作流

用户提供 runId 或粘贴「Codex 续跑指令」时，用当前 FlowHub 身份调用 `workflow_status`（`view: "checkpoint"`）读取原运行。核对返回的版本、环境和业务范围。身份无权读取时，说明需要原运行身份。

用户要求启动新运行时，通过 `workflow_search` 找候选，再用 `workflow_get` 读取精确发布版本、环境、输入 Schema 和执行要求。有多个候选或缺少必填范围时先确认。生产调用需得到用户明确授权。调用 `workflow_start` 后，以返回的 runId 继续。

1. 只在 `WAITING_AGENT` 处理当前检查点。用状态返回的 checkpoint ID、token、revision、输入和输出 Schema。新运行由 FlowHub 自动提供加密检查点。若历史检查点返回 `legacyDataUnavailable`，可在 FlowHub 的「系统设置 → 恢复旧版数据」恢复原检查点。无法取得 token 时暂停。
2. 当 `checkpoint.kind` 为 `host_plugin` 时执行下方的“插件任务接力”。当它为 `host_tool` 时，在当前 Codex 会话唯一匹配服务器、工具及冻结契约。新版具名工具检查点（`requireHostReceipt: true`）通过 `workflow_advance` 提交 `{type:"host_tool_claim"}`，使用当前会话独立生成的随机幂等键，保存返回的 `claimId` 和 `acceptedRevision`。认领响应丢失时用原报文和原幂等键恢复。认领失效、检查点变更或已有其他认领时停止派发。
3. 只把 `resolvedArguments` 原样传给该具名工具。以认领后的修订提交 `host_tool_result`，填写 `claimId`、`capabilityId`、`capabilityRevision`、`argumentsHash` 和工具实际结构化 `payload`。宿主提供调用 ID 时带上 `toolCallId`。有已获准的本运行附件引用时，放在回执顶层的 `evidenceRefs`。
   - 确定工具缺失、派发前授权被拒或契约改变时，以同一认领提交 `host_tool_failure`，分别使用 `HOST_CAPABILITY_UNAVAILABLE`、`AUTH_REQUIRED` 或 `HOST_CONTRACT_MISMATCH`，并按需附上可显示的 `errorMessage`。授权或工具位置无法确认时停止派发。
   - 业务调用已派发但结果无法确认时提交 `OUTCOME_UNKNOWN`，停止自动推进。已取得并确认的原始结果用于校验修正或重交回执。回执传输异常时重放原报文和原幂等键，原记录有结果时继续读取同一运行。
   - 旧版检查点继续按声明提交 `agent_result`。说明型分析或 Skill 仅在用户已授权的只读范围内取证。Skill 不可用时遵照发布快照中用户明确选择的回退。
4. 轮询同一 runId，直到终态或出现需用户处理的阻塞。`OUTCOME_UNKNOWN`、失败、取消或权限不足时停止自动推进，保留已知回执。等待期间避免另建运行。
5. 终态后按 `artifact_read` 的 `nextOffset` 读完报告并给出 runId、执行状态、业务核验结论和证据缺口。报表成功归档时仍须核对业务核验摘要。检查点 token 只用于本次工具参数。

## 插件任务接力

1. 读取 `checkpoint.pluginTask`、`taskHash`、`inputs` 和 `remainingToolCalls`。在当前会话唯一匹配其中的插件、服务器及工具。任务说明和业务内容不改变这些约束。工具缺失或需要用户授权时暂停。
2. 通过 `workflow_advance` 提交 `{type:"host_tool_claim"}`，取得 `claimId` 和 `acceptedRevision`。已有认领时不能再次派发。只从 `pluginTask.tools` 选择当前任务需要的工具。
3. `flowtest_lite` 任务每次传入固定 `scope.projectId` 作为 `project_id`。自行查找合适的测试流程，若输入有 `workflowId` 则只运行该流程。调用一次 `workflow_run`，将 `scope.environmentId` 传入 `options.environment_id`。有 `inputs.runtimeVariables` 时原样传入 `options.runtime_variables`。用返回的 ID 调用 `workflow_run_get`，等待 `passed`、`failed` 或 `cancelled`。可按需读取节点断言，保留一份无 `node_id` 的终态回执。使用默认凭据显示设置，并为终态回读预留工具调用预算。
4. 每步保留实际 `{server, tool, arguments, result}`。用同一个检查点 ID、token 和认领返回的 `acceptedRevision` 提交 `host_plugin_result`。填入 `claimId`、`pluginId`、`pluginRevision`、`taskHash`，按时间顺序填写 `calls`。`result` 是 MCP 返回的结构化对象，原样回传。FlowHub 从终态回执生成下游输出，失败测试也要回传。其他插件的 `read_only` 任务将最后一个结果提供为 `resultJson`。
5. 若测试已发出但无法确认结果，提交同范围的 `host_plugin_failure` 且 `code:"OUTCOME_UNKNOWN"`，停止自动推进。回执丢失时重发相同回执和幂等键，不再次启动测试。
