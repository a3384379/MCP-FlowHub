import { ensure, get, parts, type Json, type Workflow } from "../../contracts/src/domain.js";
import { schemaAt, assertAssignable, validateMappedLiteral } from "./mapping-schema.js";

export type QueryScope = { nodeId: string; pointer: string; source: Json };
const encode = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

/** Database-template parameters derived by an Agent must retain a declared
 * input scope. inputMappings declares the protected output path; other Agent
 * fields remain free to contain new analysis, summaries and recommendations. */
export function queryScopes(workflow: Workflow, bindings: Json[]): QueryScope[] {
  const scopes: QueryScope[] = [];
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  function origin(nodeId: string, pointer: string, seen: string[] = []): Json {
    ensure(!seen.includes(nodeId) && seen.length < 100, "SCOPE_UNDECLARED", "Query scope has no input origin.");
    const node = byId.get(nodeId);
    if (node?.type === "input") return { ref: { source: "input", pointer } };
    ensure(node?.type === "agent_task", "SCOPE_UNDECLARED",
      "Query parameters must originate from workflow inputs or fixed literals.");
    const entry = Object.entries(node.config.inputMappings ?? {}).find(([path]) =>
      pointer === path || pointer.startsWith(path + "/")) as [string, Json] | undefined;
    ensure(entry, "SCOPE_UNDECLARED",
      "Declare the query output scope in Agent inputMappings at " + nodeId + pointer);
    const [path, expression] = entry, suffix = pointer.slice(path.length);
    if (Object.hasOwn(expression, "value"))
      return { value: suffix ? get(expression.value, suffix) : expression.value };
    const ref = { ...expression.ref, pointer: expression.ref.pointer + suffix };
    if (ref.source === "input") return { ref };
    const result = origin(ref.nodeId, ref.pointer, [...seen, nodeId]);
    scopes.push({ nodeId, pointer, source: result });
    return result;
  }
  function protect(nodeId: string, pointer: string) {
    const node = byId.get(nodeId);
    if (node?.type === "input") return;
    ensure(node?.type === "agent_task", "SCOPE_UNDECLARED",
      "Query parameters must retain an explicitly mapped input scope.");
    const schema = schemaAt(node.config.outputSchema, pointer);
    const covered = Object.keys(node.config.inputMappings ?? {}).some((path) =>
      pointer === path || pointer.startsWith(path + "/"));
    if (!covered && schema.type === "object" && Object.keys(schema.properties ?? {}).length) {
      for (const key of Object.keys(schema.properties)) protect(nodeId, pointer + "/" + encode(key));
      return;
    }
    scopes.push({ nodeId, pointer, source: origin(nodeId, pointer) });
  }
  for (const node of workflow.nodes) {
    if (node.type !== "mcp_tool") continue;
    const binding = bindings.find((item) => item.id === workflow.bindings[node.config.bindingKey]);
    if (!binding?.allowedQueryTemplates?.length) continue;
    for (const [path, expression] of Object.entries(node.config.argumentsMappings) as [string, Json][]) {
      const keys = parts(path);
      if (keys[0] !== "parameters" || !expression.ref || expression.ref.source === "input") continue;
      protect(expression.ref.nodeId, expression.ref.pointer);
    }
  }
  const distinct = new Map(scopes.map((scope) => [scope.nodeId + ":" + scope.pointer, scope]));
  for (const scope of distinct.values()) {
    const output = byId.get(scope.nodeId)!.config.outputSchema;
    if (scope.source.ref)
      assertAssignable(schemaAt(workflow.inputSchema, scope.source.ref.pointer, true), workflow.inputSchema,
        schemaAt(output, scope.pointer), output, scope.nodeId + scope.pointer);
    else validateMappedLiteral(output, scope.pointer, scope.source.value);
  }
  return [...distinct.values()];
}
