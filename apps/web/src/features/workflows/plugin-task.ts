import type { Api } from "../../shared/v2";

export const scopeIdPattern = "[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const scopeId = new RegExp("^" + scopeIdPattern + "$");

export function validPluginScope(projectId: string, environmentId: string) {
  return scopeId.test(projectId) && scopeId.test(environmentId);
}

export async function addPluginTask(
  api: Api,
  plugin: { id: string; name: string; revision: number },
  draft: any,
  anchor: string,
  projectId: string,
  environmentId: string,
  instructions: string,
) {
  const flowtest = plugin.name === "flowtest-lite";
  if (flowtest && (draft.draft.environment !== "test" || !validPluginScope(projectId, environmentId)))
    throw new Error("请选择 test 环境的草稿，并填写有效的 FlowTest-Lite 项目与环境 ID。");
  const edge = draft.draft.edges.find((edge: any) => edge.source === anchor && edge.port === "next");
  if (!edge) throw new Error("请选择有下一步的串行节点作为插入位置。");
  const nodeId = "plugin-" + crypto.randomUUID().slice(0, 10);
  const string = { type: "string" };
  const properties = flowtest ? {
    runId: string, workflowId: string, projectId: string, environmentId: string,
    status: { type: "string", enum: ["passed", "failed", "cancelled"] },
    failedNodes: { type: "array", items: { type: "object",
      properties: { nodeId: string, code: string, message: string },
      required: ["nodeId"], additionalProperties: false } },
  } : { resultJson: string };
  return api("/api/v2/workflows/" + encodeURIComponent(draft.id) + "/operations", "POST", {
    workflowId: draft.id, expectedRevision: draft.revision, idempotencyKey: crypto.randomUUID(),
    operations: [
      ...(draft.draft.mode === "guided" ? [] : [{ op: "set_metadata", changes: { mode: "guided" } }]),
      { op: "add_node", nodeId, nodeType: "agent_task", title: flowtest ? "FlowTest-Lite 测试" : plugin.name,
        config: {
          kind: "host_plugin", executorRef: "codex_host",
          pluginRef: { pluginId: plugin.id, revision: plugin.revision },
          profile: flowtest ? "flowtest_lite" : "read_only",
          ...(flowtest ? { scope: { projectId, environmentId } } : {}),
          instructions: instructions.trim(), inputMappings: {},
          outputSchema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
        } },
      { op: "disconnect", source: anchor, target: edge.target, port: "next" },
      { op: "connect", source: anchor, target: nodeId, port: "next" },
      { op: "connect", source: nodeId, target: edge.target, port: "next" },
    ],
  }, draft.revision);
}
