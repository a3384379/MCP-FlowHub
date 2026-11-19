type RequirementNode = {
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
  for (const node of tasks) {
    // Host tools and Skills always need a host even if legacy metadata disagrees.
    executors.add(
      node.config.kind === "analysis" &&
        node.config.executorRef === "assistant_local"
        ? "assistant_local"
        : "codex_host",
    );
  }
  return {
    requiresCodex: executors.has("codex_host"),
    executors: [...executors],
    capabilityRefs: workflow.nodes.flatMap((node) =>
      node.config.capabilityRef ? [node.config.capabilityRef] : [],
    ),
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
