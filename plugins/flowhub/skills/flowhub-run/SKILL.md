---
name: flowhub-run
description: 启动已发布的 FlowHub 工作流或按 runId 接力原运行，完成当前宿主检查点并读回报告。
---

# 执行 FlowHub 工作流

用户提供 runId 或粘贴「Codex 续跑指令」时，用当前 FlowHub 身份调用 `workflow_status` 读取原运行。核对返回的版本、环境和业务范围。身份无权读取时，说明需要原运行身份。

用户要求启动新运行时，通过 `workflow_search` 找候选，再用 `workflow_get` 读取精确发布版本、环境、输入 Schema 和执行要求。有多个候选或缺少必填范围时先确认。生产调用需得到用户明确授权。调用 `workflow_start` 后，以返回的 runId 继续。

1. 只在 `WAITING_AGENT` 处理当前检查点。用状态返回的 checkpoint ID、token、revision、输入和输出 Schema。Vault 锁定或无法取得 token 时暂停，等待用户在 FlowHub 解锁。
2. 具名宿主节点仅调用检查点冻结的工具和参数。说明型分析或 Skill 在用户已授权的只读业务范围内取证。结果缺失时按输出契约如实提交。Skill 不可用时，仅使用用户已选择且发布快照声明的模板降级。
3. 用实际证据和 `workflow_advance` 提交结构化结果。同一检查点同一次提交遇到传输不明时复用原请求和幂等键。遇到修订冲突重新读取状态，由新状态判断当前节点。跳过已经被另一会话推进的检查点。
4. 轮询同一 runId，直到终态或出现需用户处理的阻塞。`OUTCOME_UNKNOWN`、失败、取消或权限不足时停止自动推进，保留已知回执。等待期间避免另建运行。
5. 终态后按 `artifact_read` 的 `nextOffset` 读完报告并给出 runId、执行状态、业务核验结论和证据缺口。报表成功归档时仍须核对业务核验摘要。检查点 token 只用于本次工具参数。
