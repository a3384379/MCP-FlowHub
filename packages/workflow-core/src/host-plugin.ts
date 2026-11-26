import { ensure, hash, stable, type Json, type Node } from "../../contracts/src/domain.js";
import type { Repository } from "../../persistence/src/repository.js";

const flowtestTools = new Set([
  "workflow_list", "workflow_get", "environment_list", "workflow_run", "workflow_run_get",
]);
const flowtestTerminal = new Set(["passed", "failed", "cancelled"]);
const flowtestNodeTerminal = new Set(["passed", "failed", "cancelled", "skipped"]);
const flowtestArguments: Record<string, string[]> = {
  workflow_list: ["query", "offset", "limit"],
  workflow_get: ["workflow_id", "include_sensitive"],
  environment_list: [],
  workflow_run: ["workflow_id", "options"],
  workflow_run_get: ["run_id", "node_id", "include_details", "include_sensitive"],
};
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** Trust the discovery relationship, not a supplied server or plugin name. */
export function freezePluginTask(repo: Repository, node: Node) {
  const { pluginRef, profile, scope } = node.config;
  const plugin = repo.get("discovery_entities", pluginRef.pluginId);
  const context = plugin && repo.get("host_contexts", plugin.contextId);
  ensure(plugin?.entityKind === "plugin" && plugin.installation === "installed" &&
    plugin.enabled === true && !plugin.stale && plugin.revision === pluginRef.revision &&
    context?.revision === plugin.contextRevision,
  "HOST_CAPABILITY_UNAVAILABLE", "Select an enabled installed plugin and synchronize its Codex tool catalog.", 409);
  const flowtest = profile === "flowtest_lite";
  ensure(!flowtest || plugin.name === "flowtest-lite", "HOST_CONTRACT_MISMATCH",
    "FlowTest-Lite test tasks require the installed flowtest-lite plugin.", 409);
  const entities = repo.db.prepare(`
    SELECT body FROM discovery_entities
    WHERE json_extract(body,'$.contextId') = ?
      AND json_extract(body,'$.entityKind') = 'mcp_tool'
      AND json_extract(body,'$.pluginId') = ?
    ORDER BY id
  `).pluck().all(plugin.contextId, plugin.id) as string[];
  const tools = entities.flatMap(body => {
    const entry = JSON.parse(body);
    const cap = repo.get("capabilities", entry.capabilityId);
    const source = entry.parentId && repo.get("discovery_entities", entry.parentId);
    if (!entry.enabled || entry.stale || entry.contextRevision !== context.revision ||
      !source || source.entityKind !== "mcp_server" || source.contextId !== plugin.contextId ||
      source.contextRevision !== context.revision || source.pluginId !== plugin.id || source.stale ||
      !source.enabled || source.self ||
      entry.executor !== "codex_host" || cap?.kind !== "mcp_tool" ||
      cap.executor !== "codex_host" || cap.stale || cap.enabled !== "enabled" ||
      cap.revision !== entry.capabilityRevision || cap.contextId !== plugin.contextId ||
      typeof cap.serverName !== "string" || typeof cap.name !== "string" ||
      !(flowtest ? flowtestTools.has(cap.name) :
        cap.tool?.annotations?.readOnlyHint === true && cap.tool.annotations.destructiveHint !== true))
      return [];
    return [{ server: cap.serverName, name: cap.name, revision: cap.revision, capabilityId: cap.capabilityId,
      contractHash: hash([cap.inputSchema, cap.outputSchema ?? null]) }];
  });
  const keys = new Set(tools.map(tool => JSON.stringify([tool.server, tool.name])));
  ensure(tools.length && tools.length <= 64 && tools.length === keys.size,
    "HOST_CAPABILITY_UNAVAILABLE", "The plugin needs an unambiguous Codex tool catalog.", 409);
  ensure(!flowtest || (new Set(tools.map(tool => tool.server)).size === 1 &&
    ["workflow_run", "workflow_run_get"].every(name => tools.some(tool => tool.name === name))),
  "HOST_CONTRACT_MISMATCH", "FlowTest-Lite must expose run and result tools from one confirmed server.", 409);
  return { pluginRef, name: plugin.name, version: plugin.version ?? null, sourceKey: plugin.sourceKey,
    manifestHash: plugin.manifestHash ?? null, profile, ...(scope ? { scope } : {}), tools };
}

type ToolReceipt = { server: string; tool: string; arguments: Json; result: Json };

export function validatePluginInputs(task: Json, inputs: Json) {
  if (task.profile !== "flowtest_lite") return;
  ensure(!Object.hasOwn(inputs, "workflowId") ||
    (typeof inputs.workflowId === "string" && uuid.test(inputs.workflowId)),
  "INPUT_INVALID", "The mapped FlowTest-Lite workflowId must be a UUID.");
  ensure(!Object.hasOwn(inputs, "runtimeVariables") ||
    (inputs.runtimeVariables && typeof inputs.runtimeVariables === "object" && !Array.isArray(inputs.runtimeVariables)),
  "INPUT_INVALID", "The mapped FlowTest-Lite runtimeVariables must be an object.");
}

export function pluginOutput(task: Json, inputs: Json, calls: ToolReceipt[]) {
  const allowed = new Set(task.tools.map((tool: Json) => JSON.stringify([tool.server, tool.name])));
  ensure(calls.every(call => call && allowed.has(JSON.stringify([call.server, call.tool])) &&
    call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments) &&
    call.result && typeof call.result === "object" && !Array.isArray(call.result)),
    "HOST_RECEIPT_MISMATCH", "The receipt contains a tool outside the published plugin task.", 409);
  if (task.profile !== "flowtest_lite") return { resultJson: JSON.stringify(calls.at(-1)!.result) };

  const { projectId, environmentId } = task.scope;
  let launched: ToolReceipt | undefined;
  let lastRunRead: ToolReceipt | undefined;
  for (const call of calls) {
    const args = call.arguments;
    const allowedArguments = flowtestArguments[call.tool];
    ensure(args.project_id === projectId &&
      (args.include_sensitive === undefined || args.include_sensitive === false) &&
      allowedArguments && Object.keys(args).every(key => key === "project_id" || allowedArguments.includes(key)),
      "SCOPE_OVERRIDE_DENIED", "FlowTest-Lite calls must use the fixed project and omit sensitive fields.", 409);
    if (call.tool === "workflow_run") {
      const options = args.options;
      ensure(!launched && options?.environment_id === environmentId &&
        Object.keys(options).every(key => key === "environment_id" || key === "runtime_variables") &&
        (Object.hasOwn(inputs, "runtimeVariables")
          ? Object.hasOwn(options, "runtime_variables") && stable(options.runtime_variables) === stable(inputs.runtimeVariables)
          : options.runtime_variables == null),
      "SCOPE_OVERRIDE_DENIED", "Start at most one test in the fixed environment with the mapped inputs.", 409);
      ensure(typeof args.workflow_id === "string" && uuid.test(args.workflow_id) &&
        (!Object.hasOwn(inputs, "workflowId") || inputs.workflowId === args.workflow_id) &&
        typeof call.result.id === "string" && uuid.test(call.result.id) &&
        call.result.workflow_id === args.workflow_id,
      "HOST_RECEIPT_MISMATCH", "FlowTest-Lite did not return the requested workflow and a run ID.", 409);
      launched = call;
    }
    if (call.tool === "workflow_run_get") {
      ensure(launched && args.run_id === launched.result.id &&
        call.result.id === launched.result.id && call.result.workflow_id === launched.result.workflow_id,
      "HOST_RECEIPT_MISMATCH", "Read results from the same FlowTest-Lite run created by this checkpoint.", 409);
      ensure(!lastRunRead || !flowtestTerminal.has(lastRunRead.result.status) ||
        lastRunRead.result.status === call.result.status, "HOST_RECEIPT_MISMATCH",
      "FlowTest-Lite reported inconsistent states after the run reached a terminal state.", 409);
      if (args.node_id == null) lastRunRead = call;
    }
  }
  ensure(launched && lastRunRead && flowtestTerminal.has(lastRunRead.result.status), "HOST_RECEIPT_SCHEMA_INVALID",
    "A FlowTest-Lite task requires the start result and a terminal run readback.", 409);
  const { id: runId, workflow_id: workflowId, status, nodes } = lastRunRead.result;
  ensure(Array.isArray(nodes) && nodes.every((node: Json) =>
    typeof node?.node_id === "string" && node.node_id.length > 0 && flowtestNodeTerminal.has(node.status)) &&
    (status !== "passed" || (nodes.length > 0 && nodes.every((node: Json) => ["passed", "skipped"].includes(node.status)))),
  "HOST_RECEIPT_SCHEMA_INVALID", "A terminal FlowTest-Lite run requires consistent node results.", 409);
  return {
    runId, workflowId, projectId, environmentId, status,
    failedNodes: nodes.filter((node: Json) => node?.status === "failed").map((node: Json) => ({
      nodeId: node.node_id,
      ...(typeof node.error_code === "string" ? { code: node.error_code } : {}),
      ...(typeof node.error_message === "string" ? { message: node.error_message } : {}),
    })),
  };
}
