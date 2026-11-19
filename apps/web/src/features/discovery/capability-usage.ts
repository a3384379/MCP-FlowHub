export function capabilityUsage(capability: {
  executor?: string;
  kind?: string;
  hasToolContract?: boolean;
}) {
  if (capability.executor === "hub_direct")
    return "FlowHub 直连 · 使用固定环境绑定";
  if (capability.executor === "codex_host" && capability.kind === "mcp_tool")
    return capability.hasToolContract === false
      ? "Codex 按任务说明执行 · 缺工具输入或输出 Schema"
      : "Codex 具名工具 · 需要当前会话能调用此工具";
  if (capability.executor === "codex_host")
    return "Codex 按任务说明执行 · 需要当前会话可用";
  return "能力说明 · 可在 Codex 任务中引用";
}
