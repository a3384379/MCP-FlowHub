type RequirementNode = {
  id: string;
  title: string;
  type: string;
  config: {
    executorRef?: string;
    kind?: string;
    skillRef?: string;
    capabilityRef?: { capabilityId: string; revision: number };
  };
};

export function workflowRequirements(workflow: { nodes: RequirementNode[] }) {
  const tasks = workflow.nodes.filter((node) => node.type === "agent_task");
  const executors = new Set<string>();
  if (workflow.nodes.some((node) => node.type === "mcp_tool"))
    executors.add("hub_direct");
  const hostNodes = [];
  for (const node of tasks) {
    // Host tools and Skills always need a host even if legacy metadata disagrees.
    const executor = node.config.kind === "analysis" && node.config.executorRef === "assistant_local"
      ? "assistant_local" : "codex_host";
    executors.add(executor);
    if (executor === "codex_host") hostNodes.push({ id: node.id, title: node.title });
  }
  return {
    requiresCodex: executors.has("codex_host"),
    executors: [...executors],
    capabilityRefs: workflow.nodes.flatMap((node) =>
      node.config.capabilityRef ? [node.config.capabilityRef] : [],
    ),
    hostNodes,
    hostSkills: [
      ...new Set<string>(
        tasks
          .filter((node) => node.config.kind === "host_skill")
          .flatMap((node) =>
            node.config.skillRef ? [node.config.skillRef] : [],
          ),
      ),
    ],
  };
}
