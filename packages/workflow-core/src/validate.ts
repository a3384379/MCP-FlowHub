import {
  validate,
  workflowSchema,
  ensure,
  parts,
  get,
  hash,
  type Workflow,
  type Json,
} from "../../contracts/src/domain.js";
import {
  assertSafePattern,
  assertSafeSchemaPatterns,
} from "../../contracts/src/schema-safety.js";
const overlap = (a: string, b: string) =>
  a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
export function validateWorkflow(
  w: Workflow,
  bindings: Json[],
  connections: Json[],
) {
  ensure(
    Buffer.byteLength(JSON.stringify(w)) <= 524288,
    "BUDGET_EXCEEDED",
    "Workflow exceeds 512 KiB.",
  );
  validate(workflowSchema, w);
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
  const schemaAt = (schema: Json, pointer: string) => {
    for (const k of parts(pointer)) {
      ensure(schema, "REFERENCE_INVALID", "Reference schema missing.");
      schema = schema.type === "array" ? schema.items : schema.properties?.[k];
    }
    ensure(schema, "REFERENCE_INVALID", "Reference field not declared.");
    return schema;
  };
  const outputSchema = (nodeId: string) => {
    const n = byId.get(nodeId)!;
    if (n.type === "input") return w.inputSchema;
    if (n.type === "condition") return { type: "boolean" };
    if (n.type === "approval")
      return {
        type: "object",
        properties: { decision: { type: "string", const: "approved" } },
        required: ["decision"],
        additionalProperties: false,
      };
    if (n.type === "mcp_tool") {
      const b = bindings.find((b) => b.id === w.bindings[n.config.bindingKey]);
      return connections
        .find((c) => c.id === b?.connectionId)
        ?.tools?.find((t: Json) => t.name === n.config.toolName)?.outputSchema;
    }
    return n.config.outputSchema;
  };
  function references(value: Json, nodeId: string, depth = 0) {
    ensure(depth < 32, "SCHEMA_LIMIT", "Configuration nesting too deep.");
    if (!value || typeof value !== "object") return;
    if (value.ref) {
      parts(value.ref.pointer);
      if (value.ref.source === "node") {
        ensure(
          dom.get(nodeId)!.has(value.ref.nodeId) && value.ref.nodeId !== nodeId,
          "REFERENCE_DOMINANCE",
          "Reference must be from a preceding mandatory node: " + nodeId,
        );
        schemaAt(outputSchema(value.ref.nodeId), value.ref.pointer);
      } else schemaAt(w.inputSchema, value.ref.pointer);
      return;
    }
    for (const v of Object.values(value)) references(v, nodeId, depth + 1);
  }
  function safeSchema(s: Json, depth = 0) {
    ensure(depth < 16, "SCHEMA_LIMIT", "Schema nesting too deep.");
    if (!s || typeof s !== "object") return;
    ensure(
      !s.$ref && !s.$dynamicRef,
      "SCHEMA_INVALID",
      "External/recursive references are forbidden.",
    );
    if (Object.hasOwn(s, "pattern")) assertSafePattern(s.pattern);
    for (const pattern of Object.keys(s.patternProperties ?? {}))
      assertSafePattern(pattern);
    for (const v of Object.values(s))
      if (v && typeof v === "object")
        for (const x of Array.isArray(v) ? v : [v]) safeSchema(x, depth + 1);
  }
  safeSchema(w.inputSchema);
  for (const n of w.nodes) {
    for (const map of [
      n.config.argumentsMappings,
      n.config.inputMappings,
    ].filter(Boolean)) {
      const keys = Object.keys(map);
      for (const key of keys) {
        parts(key);
        ensure(
          !keys.some((other) => other !== key && overlap(key, other)),
          "MAPPING_INVALID",
          "Overlapping destination paths.",
        );
      }
    }
    // Traverse expressions and mappings only: schemas/const data are inert.
    for (const value of [
      n.config.argumentsMappings,
      n.config.inputMappings,
      n.config.expression,
      n.config.resultRef,
    ].filter(Boolean))
      references(value, n.id);
    if (n.config.outputSchema) safeSchema(n.config.outputSchema);
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
    if (n.type === "mcp_tool") {
      ensure(
        !n.config.outputSchemaRef ||
          [
            "flowhub://schemas/log-search-result/v1",
            "flowhub://schemas/query-template-result/v1",
          ].includes(n.config.outputSchemaRef),
        "SCHEMA_INVALID",
        "Unknown output registry schema at " + n.id,
      );
      const b = bindings.find((b) => b.id === w.bindings[n.config.bindingKey]),
        c = connections.find((c) => c.id === b?.connectionId);
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
      for (const key of Object.keys(n.config.argumentsMappings))
        ensure(
          !Object.keys(b.lockedArguments).some((locked) =>
            overlap(key, locked),
          ),
          "ENVIRONMENT_OVERRIDE_DENIED",
          "Mapping overrides locked fields.",
        );
      // Check source/target types and mandatory downstream parameters.
      const args: Json = {};
      for (const [key, expr] of Object.entries(n.config.argumentsMappings) as [
        string,
        Json,
      ][]) {
        let type: Json;
        const target = schemaAt(tool.inputSchema, key);
        if (expr.ref)
          type = schemaAt(
            expr.ref.source === "input"
              ? w.inputSchema
              : outputSchema(expr.ref.nodeId),
            expr.ref.pointer,
          )?.type;
        else {
          type =
            expr.value === null
              ? "null"
              : Array.isArray(expr.value)
                ? "array"
                : typeof expr.value;
          validate(target, expr.value);
        }
        ensure(
          !target.type ||
            type === target.type ||
            (type === "integer" && target.type === "number") ||
            (type === "number" && target.type === "integer"),
          "TYPE_MISMATCH",
          "Mapping type mismatch at " + n.id + key,
        );
        setShape(args, key);
      }
      for (const key of Object.keys(b.lockedArguments)) setShape(args, key);
      function required(s: Json, v: Json) {
        for (const key of s.required ?? [])
          ensure(
            v && Object.hasOwn(v, key),
            "MAPPING_INVALID",
            "Required tool parameter missing: " + n.id + "/" + key,
          );
        for (const [k, child] of Object.entries(s.properties ?? {}))
          if (v && Object.hasOwn(v, k)) required(child, v[k]);
      }
      required(tool.inputSchema, args);
      if (b.allowedQueryTemplates.length) {
        const literal = n.config.argumentsMappings["/templateId"];
        ensure(
          literal && b.allowedQueryTemplates.includes(literal.value),
          "TEMPLATE_LOCKED",
          "Query template must be a fixed approved literal.",
        );
        const approval = w.nodes.find(
          (a) =>
            a.type === "approval" &&
            a.config.actionNodeId === n.id &&
            dom.get(n.id)!.has(a.id),
        );
        ensure(
          approval,
          "APPROVAL_REQUIRED",
          "Database action must be dominated by its independent approval.",
        );
      }
    }
    if (n.type === "approval")
      ensure(
        byId.get(n.config.actionNodeId)?.type === "mcp_tool" &&
          successors(n.id)[0] === n.config.actionNodeId,
        "APPROVAL_INVALID",
        "Approval must immediately precede its action.",
      );
  }
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
function setShape(value: Json, pointer: string) {
  const keys = parts(pointer);
  for (const k of keys) {
    value[k] ??= {};
    value = value[k];
  }
}
