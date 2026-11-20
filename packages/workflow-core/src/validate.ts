import {
  validate,
  workflowSchema,
  ensure,
  parts,
  pointersOverlap,
  hash,
  get,
  HubError,
  type Workflow,
  type Json,
} from "../../contracts/src/domain.js";
import {
  assertSafeSchemaPatterns,
  assertSafeNativeObjectSchema,
  walkSchema,
} from "../../contracts/src/schema-safety.js";
import { schemaAt, assertAssignable, validateMappedLiteral } from "./mapping-schema.js";
import { protectDiagnostic } from "../../security/src/diagnostics.js";
import { queryScopes } from "./query-scope.js";
import { mcpOutputSchema } from "../../contracts/src/mcp-output-schema.js";
import { validateBusinessRule } from "./business-verification.js";
const overlap = pointersOverlap;
const encodePointer = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
type WorkflowIssue = { code: string; message: string; nodeId: string; path: string };

// Match the fixed workflow_advance object envelope without guessing from a
// single `type` property. Local references and combinations retain root scope.
export function assertObjectPayloadSchema(root: Json) {
  let visits = 0;
  const allTypes = ["object", "array", "string", "boolean", "integer", "number", "null"];
  const valueType = (value: Json) => value === null ? "null" : Array.isArray(value) ? "array" :
    typeof value === "number" ? "number" : typeof value;
  function possible(schema: Json, refs: string[] = [], depth = 0): Set<string> {
    ensure(++visits <= 2048 && depth < 24, "SCHEMA_LIMIT", "Payload schema exceeds structural limits.");
    if (schema === false) return new Set();
    if (schema === true) return new Set(allTypes);
    ensure(schema && typeof schema === "object" && !Array.isArray(schema), "SCHEMA_INVALID", "Invalid payload schema.");
    let result = new Set<string>(schema.type ? Array.isArray(schema.type) ? schema.type : [schema.type] : allTypes);
    const intersect = (other: Set<string>) => { result = new Set([...result].filter((type) => other.has(type))); };
    if (Object.hasOwn(schema, "const")) intersect(new Set([valueType(schema.const)]));
    if (Array.isArray(schema.enum)) intersect(new Set(schema.enum.map(valueType)));
    if (schema.$ref) {
      ensure(typeof schema.$ref === "string" && schema.$ref.startsWith("#/") && !refs.includes(schema.$ref),
        "SCHEMA_INVALID", "Payload schema requires a non-recursive local reference.");
      let referenced: Json;
      try { referenced = get(root, schema.$ref.slice(1)); }
      catch { throw new HubError("SCHEMA_INVALID", "Payload schema reference is missing."); }
      intersect(possible(referenced, [...refs, schema.$ref], depth + 1));
    }
    for (const schemaPart of schema.allOf ?? []) intersect(possible(schemaPart, refs, depth + 1));
    for (const keyword of ["anyOf", "oneOf"])
      if (schema[keyword]) {
        const combined = new Set<string>();
        for (const schemaPart of schema[keyword]) for (const type of possible(schemaPart, refs, depth + 1)) combined.add(type);
        intersect(combined);
      }
    return result;
  }
  ensure(possible(root).has("object"), "SCHEMA_INVALID",
    "Workflow data schema must support a structured object payload.");
}
export function validateWorkflowDocument(w: Workflow) {
  if(w?.schemaVersion==="flowhub.workflow/v2"&&Array.isArray(w.nodes))for(const node of w.nodes)
    if(node?.type==="agent_task"&&node.config?.kind==="host_tool")assertSafeNativeObjectSchema(node.config.outputSchema);
  validate(workflowSchema,w);
  for (const [index, node] of w.nodes.entries()) {
    if (node.config.kind === "host_tool" && Object.keys(node.config.receiptScopeMappings ?? {}).length &&
        node.config.requireHostReceipt !== true) {
      const issue = {
        code: "HOST_RECEIPT_REQUIRED",
        message: "Receipt scope mappings require structured host receipts.",
        nodeId: node.id,
        path: "/nodes/" + index + "/config/receiptScopeMappings",
      };
      throw new HubError(issue.code, issue.message, 422, { issues: [issue] });
    }
    if (node.config.businessVerification)
      validateBusinessRule(node.config.businessVerification,
        node.type === "agent_task" ? node.config.outputSchema : undefined);
  }
}
export function validateWorkflow(
  w: Workflow,
  bindings: Json[],
  connections: Json[],
  hostInputs: ReadonlyMap<string, Json> = new Map(),
) {
  ensure(
    Buffer.byteLength(JSON.stringify(w)) <= 524288,
    "BUDGET_EXCEEDED",
    "Workflow exceeds 512 KiB.",
  );
  validateWorkflowDocument(w);
  for (const [key, bindingId] of Object.entries(w.bindings)) {
    const binding = bindings.find((item) => item.id === bindingId);
    if (!(binding && binding.environment === w.environment &&
      connections.some((connection) => connection.id === binding.connectionId))) {
      const message = "Missing or cross-environment binding: " + key;
      const issues = w.nodes.flatMap((node, index) => node.type === "mcp_tool" && node.config.bindingKey === key
        ? [{ code: "ENVIRONMENT_OVERRIDE_DENIED", message, nodeId: node.id, path: "/nodes/" + index + "/config/bindingKey" }] : []);
      throw new HubError("ENVIRONMENT_OVERRIDE_DENIED", message, 422,
        { issues: issues.length ? issues : [{ code: "ENVIRONMENT_OVERRIDE_DENIED", message, path: "/bindings/" + encodePointer(key) }] });
    }
  }
  ensure(w.nodes.length <= 100, "GRAPH_INVALID", "Maximum 100 nodes.");
  const byId = new Map(w.nodes.map((n) => [n.id, n]));
  ensure(byId.size === w.nodes.length, "GRAPH_INVALID", "Duplicate node IDs.");
  const starts = w.nodes.filter((n) => n.type === "input"),
    ends = w.nodes.filter((n) => n.type === "end");
  ensure(
    starts.length === 1 && ends.length === 1,
    "GRAPH_INVALID",
    "Exactly one input and one end required.",
  );
  const successors = (n: string) =>
    w.edges.filter((e) => e.source === n).map((e) => e.target);
  const predecessors = (n: string) =>
    w.edges.filter((e) => e.target === n).map((e) => e.source);
  for (const e of w.edges)
    ensure(
      byId.has(e.source) && byId.has(e.target),
      "GRAPH_INVALID",
      "Unknown edge endpoint.",
    );
  for (const n of w.nodes) {
    const edges = w.edges.filter((e) => e.source === n.id);
    ensure(
      n.type === "condition"
        ? edges.length === 2 &&
            new Set(edges.map((e) => e.port)).size === 2 &&
            edges.every((e) => ["true", "false"].includes(e.port))
        : n.type === "end"
          ? edges.length === 0
          : edges.length === 1 && edges[0]!.port === "next",
      "GRAPH_INVALID",
      "Parallel or invalid exits at " + n.id,
    );
    ensure(
      n.type === "input"
        ? predecessors(n.id).length === 0
        : predecessors(n.id).length > 0,
      "GRAPH_INVALID",
      "Unreachable input at " + n.id,
    );
  }
  const seen = new Set<string>(),
    active = new Set<string>(),
    order: string[] = [];
  function visit(n: string) {
    ensure(
      !active.has(n),
      "GRAPH_CYCLE",
      "Cycles and back edges are unsupported.",
    );
    if (seen.has(n)) return;
    active.add(n);
    for (const next of successors(n)) visit(next);
    active.delete(n);
    seen.add(n);
    order.unshift(n);
  }
  visit(starts[0]!.id);
  ensure(seen.size === w.nodes.length, "GRAPH_INVALID", "Disconnected nodes.");
  const dom = new Map<string, Set<string>>();
  for (const n of order) {
    const parents = predecessors(n);
    const d = parents.length
      ? new Set(
          [...dom.get(parents[0]!)!].filter((v) =>
            parents.every((p) => dom.get(p)!.has(v)),
          ),
        )
      : new Set<string>();
    d.add(n);
    dom.set(n, d);
  }
  const outputSchema = (nodeId: string) => {
    const n = byId.get(nodeId)!;
    if (n.type === "input") return w.inputSchema;
    if (n.type === "condition") return { type: "boolean" };
    if (n.type === "mcp_tool") {
      const b = bindings.find((b) => b.id === w.bindings[n.config.bindingKey]);
      return mcpOutputSchema(connections
        .find((c) => c.id === b?.connectionId)
        ?.tools?.find((t: Json) => t.name === n.config.toolName)?.outputSchema, n.config.resultAdapterRef);
    }
    return n.config.outputSchema;
  };
  function references(value: Json, nodeId: string, depth = 0, optional = false) {
    ensure(depth < 32, "SCHEMA_LIMIT", "Configuration nesting too deep.");
    if (!value || typeof value !== "object") return;
    if (value.op === "exists") {
      references(value.value, nodeId, depth + 1, true);
      return;
    }
    if (Object.hasOwn(value, "value")) return;
    if (value.ref) {
      parts(value.ref.pointer);
      if (value.ref.source === "node") {
        ensure(
          dom.get(nodeId)!.has(value.ref.nodeId) && value.ref.nodeId !== nodeId,
          "REFERENCE_DOMINANCE",
          "Reference must be from a preceding mandatory node: " + nodeId,
        );
        schemaAt(outputSchema(value.ref.nodeId), value.ref.pointer, !optional);
      } else schemaAt(w.inputSchema, value.ref.pointer, !optional);
      return;
    }
    for (const v of Object.values(value)) references(v, nodeId, depth + 1, optional);
  }
  function safeSchema(s: Json) {
    walkSchema(s, (schema) => {
      if (!schema || typeof schema !== "object") return;
      ensure(!schema.$ref && !schema.$dynamicRef, "SCHEMA_INVALID",
        "External/recursive references are forbidden.");
    }, { maxDepth: 15 });
    assertSafeSchemaPatterns(s);
  }
  safeSchema(w.inputSchema);
  const issues: WorkflowIssue[] = [];
  for (const [index, n] of w.nodes.entries()) {
    const nodePath = "/nodes/" + index + "/config";
    let issuePath = nodePath;
    try {
    if (n.type === "input") {
      issuePath = "/inputSchema";
      assertObjectPayloadSchema(w.inputSchema);
      issuePath = nodePath;
    }
    for (const field of ["argumentsMappings", "inputMappings"]) {
      const map = n.config[field];
      if (!map) continue;
      const keys = Object.keys(map);
      for (const key of keys) {
        issuePath = nodePath + "/" + field + "/" + encodePointer(key);
        parts(key);
        ensure(
          !keys.some((other) => other !== key && overlap(key, other)),
          "MAPPING_INVALID",
          "Overlapping destination paths.",
        );
        references(map[key], n.id);
      }
    }
    // Traverse expressions only. Schemas and literal values are inert.
    for (const key of ["expression", "resultRef"])
      if (n.config[key]) {
        issuePath = nodePath + "/" + key;
        references(n.config[key], n.id);
      }
    if (n.config.outputSchema) {
      issuePath = nodePath + "/outputSchema";
      if(w.schemaVersion==="flowhub.workflow/v2"&&n.type==="agent_task"&&n.config.kind==="host_tool")assertSafeNativeObjectSchema(n.config.outputSchema);
      else safeSchema(n.config.outputSchema);
      if (n.type === "agent_task") assertObjectPayloadSchema(n.config.outputSchema);
    }
    if (n.type === "report_template")
      ensure(
        n.config.templateRef === "incident-markdown/v1",
        "TEMPLATE_INVALID",
        "Unknown fixed template.",
      );
    if (n.type === "agent_task" && n.config.kind === "host_skill")
      ensure(
        n.config.reportContractRef === "incident-report/v1" &&
          (!n.config.fallbackTemplateRef ||
            n.config.fallbackTemplateRef === "incident-markdown/v1"),
        "TEMPLATE_INVALID",
        "Unknown report contract/fallback.",
      );
    function validateInputs(targetSchema: Json, map: Json, field: string, lockedArguments: Json = {}, extra: string[] = []) {
      // Check source/target types and mandatory downstream parameters.
      const supplied = [...Object.keys(map), ...Object.keys(lockedArguments), ...extra];
      for (const [key, expr] of Object.entries(map) as [
        string,
        Json,
      ][]) {
        issuePath = nodePath + "/" + field + "/" + encodePointer(key);
        const target = schemaAt(targetSchema, key);
        if (expr.ref) {
          const sourceRoot = expr.ref.source === "input" ? w.inputSchema : outputSchema(expr.ref.nodeId);
          assertAssignable(schemaAt(sourceRoot, expr.ref.pointer, true), sourceRoot,
            target, targetSchema, n.id + key);
        } else validateMappedLiteral(targetSchema, key, expr.value);
      }
      for (const [key, value] of Object.entries(lockedArguments)) {
        issuePath = nodePath + "/bindingKey";
        validateMappedLiteral(targetSchema, key, value);
      }
      const arrayPaths = new Set<string>();
      for (const path of supplied) {
        const keys = parts(path);
        for (let index = 1; index < keys.length; index++) {
          const parent = "/" + keys.slice(0, index).map((key) => key.replaceAll("~", "~0").replaceAll("/", "~1")).join("/");
          const type = schemaAt(targetSchema, parent).type;
          if (type === "array" || (Array.isArray(type) && type.includes("array"))) arrayPaths.add(parent);
        }
      }
      for (const parent of arrayPaths) {
        if (supplied.some((path) => path === parent || parent.startsWith(path + "/"))) continue;
        const depth = parts(parent).length;
        const indices = [...new Set(supplied.filter((path) => path.startsWith(parent + "/"))
          .map((path) => Number(parts(path)[depth])))].sort((a, b) => a - b);
        const target = schemaAt(targetSchema, parent);
        issuePath = nodePath + "/" + field + "/" + encodePointer(parent);
        ensure(indices.every((value, index) => value === index) &&
          indices.length >= (target.minItems ?? 0) && indices.length <= (target.maxItems ?? 10000),
          "MAPPING_INVALID", "Array mappings must provide contiguous items within schema bounds at " + n.id + parent);
      }
      function required(pointer: string) {
        if (supplied.some((key) => key === pointer || pointer.startsWith(key + "/"))) return;
        const s = schemaAt(targetSchema, pointer);
        for (const key of s.required ?? []) {
          const child = pointer + "/" + key.replaceAll("~", "~0").replaceAll("/", "~1");
          issuePath = nodePath + "/" + field + "/" + encodePointer(child);
          ensure(supplied.some((path) => path === child || path.startsWith(child + "/")),
            "MAPPING_INVALID", "Required tool parameter missing: " + n.id + child);
          required(child);
        }
        for (const key of Object.keys(s.properties ?? {})) {
          const child = pointer + "/" + key.replaceAll("~", "~0").replaceAll("/", "~1");
          if (!(s.required ?? []).includes(key) && supplied.some((path) => path.startsWith(child + "/"))) required(child);
        }
        if (s.type === "array" || (Array.isArray(s.type) && s.type.includes("array"))) {
          const depth = parts(pointer).length;
          const indices = new Set(supplied.filter((path) => path.startsWith(pointer + "/"))
            .map((path) => parts(path)[depth]!));
          for (const index of indices) required(pointer + "/" + index);
        }
      }
      required("");
    }
    const hostInput = hostInputs.get(n.id);
    if (hostInput) {
      issuePath = nodePath + "/inputMappings";
      ensure(n.config.executorRef === "codex_host", "HOST_CAPABILITY_UNAVAILABLE",
        "A structured host receipt requires the Codex executor.");
      assertSafeNativeObjectSchema(hostInput);
      validateInputs(hostInput, n.config.inputMappings, "inputMappings");
      for (const [outputPointer, inputPointer] of Object.entries(n.config.receiptScopeMappings ?? {})) {
        issuePath = nodePath + "/receiptScopeMappings/" + encodePointer(outputPointer);
        assertAssignable(schemaAt(hostInput, String(inputPointer), true), hostInput,
          schemaAt(n.config.outputSchema, outputPointer, true), n.config.outputSchema, n.id + outputPointer);
      }
    }
    if (n.type === "mcp_tool") {
      issuePath = nodePath + "/outputSchemaRef";
      ensure(
        !n.config.outputSchemaRef ||
          [
            "flowhub://schemas/log-search-result/v1",
            "flowhub://schemas/query-template-result/v1",
          ].includes(n.config.outputSchemaRef),
        "SCHEMA_INVALID",
        "Unknown output registry schema at " + n.id,
      );
      if (n.config.businessVerification) {
        issuePath = nodePath + "/businessVerification";
        validateBusinessRule(n.config.businessVerification, outputSchema(n.id));
      }
      const b = bindings.find((b) => b.id === w.bindings[n.config.bindingKey]),
        c = connections.find((c) => c.id === b?.connectionId);
      issuePath = nodePath + "/bindingKey";
      ensure(
        b && c && b.environment === w.environment,
        "ENVIRONMENT_OVERRIDE_DENIED",
        "Missing or cross-environment binding at " + n.id,
      );
      ensure(
        !c.disabled && b.validationStatus !== "REVOKED",
        "BINDING_UNVERIFIED",
        "Binding revoked/connection disabled.",
      );
      ensure(
        ["MOCK_VERIFIED", "BINDING_VERIFIED"].includes(b.validationStatus),
        "BINDING_UNVERIFIED",
        "Verify binding before publishing.",
      );
      ensure(
        b.simulationOnly
          ? c.synthetic === true || c.syntheticEvidence === true
          : b.validationStatus === "BINDING_VERIFIED" &&
              !c.synthetic &&
              !c.syntheticEvidence,
        "BINDING_UNVERIFIED",
        "Simulation cannot authorize real execution.",
      );
      ensure(
        b.allowedTools.includes(n.config.toolName),
        "TOOL_NOT_ALLOWED",
        "Tool is outside binding allowlist.",
      );
      const tool = c.tools?.find((t: Json) => t.name === n.config.toolName);
      issuePath = nodePath + "/toolSchemaHash";
      ensure(
        tool && tool.schemaHash === n.config.toolSchemaHash,
        "TOOL_SCHEMA_DRIFT",
        "Tool schema hash changed at " + n.id,
      );
      assertSafeSchemaPatterns(tool.inputSchema);
      if (tool.outputSchema) assertSafeSchemaPatterns(tool.outputSchema);
      if (
        n.config.outputSchemaRef &&
        tool.outputSchema?.properties?.synthetic
      ) {
        const provenance = tool.outputSchema.properties.synthetic,
          expectedSynthetic = b.simulationOnly === true;
        ensure(
          (!Object.hasOwn(provenance, "const") ||
            provenance.const === expectedSynthetic) &&
            (!provenance.enum || provenance.enum.includes(expectedSynthetic)),
          "SCHEMA_INVALID",
          "Tool result provenance conflicts with its binding at " + n.id,
        );
      }
      for (const key of Object.keys(n.config.argumentsMappings)) {
        issuePath = nodePath + "/argumentsMappings/" + encodePointer(key);
        ensure(
          !Object.keys(b.lockedArguments).some((locked) =>
            overlap(key, locked),
          ),
          "ENVIRONMENT_OVERRIDE_DENIED",
          "Mapping overrides locked fields.",
        );
      }
      if (n.config.rowLimitArgument) {
        issuePath = nodePath + "/rowLimitArgument";
        ensure(!Object.keys(b.lockedArguments).some(locked => overlap(n.config.rowLimitArgument, locked)),
          "ENVIRONMENT_OVERRIDE_DENIED", "Native row limit overlaps locked resource arguments.");
        const definition = schemaAt(tool.inputSchema, n.config.rowLimitArgument);
        ensure(["integer", "number"].includes(definition.type), "LIMIT_UNSUPPORTED", "The declared native row-limit argument is not numeric.");
      }
      validateInputs(tool.inputSchema, n.config.argumentsMappings, "argumentsMappings", b.lockedArguments,
        n.config.rowLimitArgument ? [n.config.rowLimitArgument] : []);
      if (b.allowedQueryTemplates.length) {
        issuePath = nodePath + "/argumentsMappings/~1templateId";
        const literal = n.config.argumentsMappings["/templateId"];
        ensure(
          literal && b.allowedQueryTemplates.includes(literal.value),
          "TEMPLATE_LOCKED",
          "Query template must be a fixed approved literal.",
        );
        issuePath = nodePath + "/argumentsMappings";
        queryScopes({ ...w, nodes: w.nodes.filter((node) => node.type !== "mcp_tool" || node.id === n.id) }, bindings);
      }
    }
    } catch (error) {
      const failure = error instanceof HubError ? error : new HubError("SCHEMA_INVALID", "Node schema could not be validated.");
      issues.push({ code: failure.code, message: protectDiagnostic(failure.message), nodeId: n.id, path: issuePath });
    }
  }
  if (issues.length) throw new HubError(issues[0]!.code, issues[0]!.message, 422, { issues });
  if (w.mode === "auto")
    ensure(
      !w.nodes.some((n) => n.type === "agent_task"),
      "MODE_NOT_SUPPORTED",
      "Auto cannot contain Agent/Skill tasks.",
    );
  ensure(
    w.budgets.maxOutputBytes <= 262144 &&
      w.budgets.maxRunSeconds <= 1800 &&
      w.budgets.maxToolCalls <= 200 &&
      w.budgets.maxNodeExecutions <= 200 &&
      w.budgets.maxAgentCheckpoints <= 20,
    "BUDGET_EXCEEDED",
    "Budget exceeds system policy.",
  );
  return {
    ok: true,
    nodeCount: w.nodes.length,
    contentHash: "sha256:" + hash(w),
    order,
  };
}
