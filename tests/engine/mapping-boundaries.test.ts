import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { assertObjectPayloadSchema } from "../../packages/workflow-core/src/validate.js";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { previewRetention, commitRetention } from "../../packages/persistence/src/retention.js";
import { HubError, hash, set, type Json, type Workflow, type Node } from "../../packages/contracts/src/domain.js";

const object = (properties: Json, required = Object.keys(properties)) =>
  ({ type: "object", properties, required, additionalProperties: false });

export function fixture(call?: (...args: any[]) => Promise<Json>) {
  const db = new Database(":memory:"), repo = new Repository(db), vault = new Vault(repo);
  vault.initialize("Synthetic-mapping-password-2026");
  repo.insert("connections", "c", { id: "c", revision: 1, synthetic: true,
    disabled: false, verifiedSdk: "synthetic-fixture", verifiedAt: new Date().toISOString(), tools: [] });
  repo.insert("bindings", "b", { id: "b", revision: 1, connectionId: "c", connectionRevision: 1,
    environment: "test", simulationOnly: true, validationStatus: "MOCK_VERIFIED", allowedTools: ["read"],
    allowedQueryTemplates: [], lockedArguments: { "/environment": "test" }, maxRows: 100, timeoutSeconds: 5 });
  const engine = new Engine(repo, vault, { call: call ?? (async (_b, _n, _a, _t, dispatch) => {
    dispatch(); return { environment: "test", synthetic: true };
  }) } as any);
  const workflow: Workflow = { schemaVersion: "flowhub.workflow/v1", workflowId: "mapping-fixture",
    name: "合成映射回归", description: "In-process synthetic contract regression", version: "1.0.0",
    environment: "test", mode: "auto", tags: [], inputSchema: object({ value: { type: "string" } }),
    bindings: { probe: "b" },
    nodes: [{ id: "start", title: "Input", type: "input", config: {} },
      { id: "read", title: "Read", type: "mcp_tool", config: { bindingKey: "probe", toolName: "read",
        toolSchemaHash: "placeholder:pending", argumentsMappings: {} } },
      { id: "end", title: "End", type: "end", config: { resultRef: { ref: { source: "input", pointer: "" } } } }],
    edges: [{ source: "start", target: "read", port: "next" }, { source: "read", target: "end", port: "next" }],
    budgets: { maxRunSeconds: 30, maxToolCalls: 8, maxNodeExecutions: 32, maxAgentCheckpoints: 5,
      maxOutputBytes: 262144, maxRows: 100, maxToolSeconds: 5, maxRetries: 0 } };
  function tool(properties: Json, extra: Json = {}) {
    const inputSchema = { ...object({ environment: { type: "string", const: "test" }, ...properties }), ...extra };
    const outputSchema = object({ environment: { type: "string" }, synthetic: { type: "boolean" } });
    const item = { name: "read", inputSchema, outputSchema,
      schemaHash: "sha256:" + hash({ inputSchema, outputSchema }) };
    repo.put("connections", "c", { ...repo.get("connections", "c"), tools: [item] });
    workflow.nodes[1]!.config.toolSchemaHash = item.schemaHash;
    return item;
  }
  tool({});
  return { db, repo, vault, engine, workflow, tool,
    start(inputs: Json = { value: "synthetic" }) {
      engine.saveDraft(workflow, undefined, {}); engine.publish(workflow.workflowId);
      return engine.start({ workflowId: workflow.workflowId, version: workflow.version,
        mode: workflow.mode, inputs, idempotencyKey: crypto.randomUUID() });
    },
    async close() { await engine.close(); db.close(); } };
}

export async function settled(engine: Engine, runId: string) {
  for (let index = 0; index < 200; index++) {
    const state = engine.status(runId);
    if (!["QUEUED", "RUNNING"].includes(state.state)) return state;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Synthetic engine did not settle.");
}

test("whole object literals/references, nullable targets and local definitions retain schema context", async (t) => {
  for (const kind of ["literal-object", "reference-object", "nullable", "definition"]) {
    await t.test(kind, async () => {
      let args: Json;
      const f = fixture(async (_b, _n, input, _t, dispatch) => { dispatch(); args = input; return {}; });
      try {
        const nested = object({ orderNo: { type: "string" } });
        f.tool({ value: kind === "definition" ? { $ref: "#/$defs/approved" } :
          kind.includes("object") ? nested : { type: ["string", "null"] } },
          kind === "definition" ? { $defs: { approved: { type: "string", maxLength: 30 } } } : {});
        const input = kind.includes("object") ? { orderNo: "DEMO-1001" } : "valid-string";
        f.workflow.inputSchema = object({ value: kind.includes("object") ? nested : { type: "string" } });
        f.workflow.nodes[1]!.config.argumentsMappings = { "/value": kind.startsWith("literal") || kind === "definition"
          ? { value: input } : { ref: { source: "input", pointer: "/value" } } };
        const run = f.start({ value: input });
        assert.equal((await settled(f.engine, run.runId)).state, "SUCCEEDED");
        assert.deepEqual(args.value, input);
      } finally { await f.close(); }
    });
  }
});

test("mapped literals enforce a decoded local reference and its sibling constraints", async t => {
  const f = fixture();
  t.after(f.close);
  f.tool({ value: { $ref: "#/$defs/Trace%20Id", minLength: 1 } }, {
    $defs: { "Trace Id": { type: "string", minLength: 5, maxLength: 10 } },
  });
  const node = f.workflow.nodes[1]!;
  node.config.argumentsMappings = { "/value": { value: "X" } };
  assert.throws(() => f.engine.validateDraft(f.workflow), (error: Json) =>
    error.code === "INPUT_INVALID" && error.details.issues[0].path === "/nodes/1/config/argumentsMappings/~1value" &&
    error.message.includes("fewer than 5 characters"));
  node.config.argumentsMappings["/value"].value = "DEMO-0042";
  assert.equal(f.engine.validateDraft(f.workflow).ok, true);
  assert.equal((await settled(f.engine, f.start().runId)).state, "SUCCEEDED");
});

test("unevaluated properties beside a local reference use properties evaluated by that reference", async t => {
  const f = fixture();
  t.after(f.close);
  f.tool({ value: { $ref: "#/$defs/Scope", unevaluatedProperties: false } }, {
    $defs: { Scope: { type: "object", properties: { orderNo: { type: "string" } }, required: ["orderNo"] } },
  });
  const mapping = { value: { orderNo: "DEMO-0042" } };
  f.workflow.nodes[1]!.config.argumentsMappings = { "/value": mapping };
  assert.equal(f.engine.validateDraft(f.workflow).ok, true);
  f.workflow.nodes[1]!.config.argumentsMappings["/value"].value = { ...mapping.value, extra: true };
  assert.throws(() => f.engine.validateDraft(f.workflow), { code: "INPUT_INVALID" });
});

test("array item mappings create arrays and dispatch valid parameters", async () => {
  let args: Json;
  const f = fixture(async (_b, _n, input, _t, dispatch) => { dispatch(); args = input; return {}; });
  try {
    f.tool({ ids: { type: "array", items: { type: "string" } } });
    f.workflow.nodes[1]!.config.argumentsMappings = { "/ids/0": { value: "DEMO-1001" } };
    const run = f.start();
    assert.equal((await settled(f.engine, run.runId)).state, "SUCCEEDED");
    assert.deepEqual(args.ids, ["DEMO-1001"]);
    const value = {}; set(value, "/groups/0/ids/0", "nested");
    assert.deepEqual(value, { groups: [{ ids: ["nested"] }] });
  } finally { await f.close(); }
});

test("partial array object mappings must provide required fields at every mapped item", async () => {
  const f = fixture();
  try {
    f.tool({ groups: { type: "array", items: object({
      entries: { type: "array", items: object({ name: { type: "string" }, code: { type: "string" } }) },
    }) } });
    f.workflow.nodes[1]!.config.argumentsMappings = { "/groups/0/entries/0/name": { value: "synthetic" } };
    assert.throws(() => f.engine.validateDraft(f.workflow), (error: any) =>
      error.code === "MAPPING_INVALID" && error.message.includes("/groups/0/entries/0/code"));
    f.workflow.nodes[1]!.config.argumentsMappings["/groups/0/entries/0/code"] = { value: "SAFE" };
    assert.equal(f.engine.validateDraft(f.workflow).ok, true);
    const run = f.start(); assert.equal((await settled(f.engine, run.runId)).state, "SUCCEEDED");
    f.workflow.nodes[1]!.config.argumentsMappings["/groups/0/entries/1/name"] = { value: "second" };
    assert.throws(() => f.engine.validateDraft(f.workflow), (error: any) =>
      error.code === "MAPPING_INVALID" && error.message.includes("/groups/0/entries/1/code"));
  } finally { await f.close(); }
});

test("recovery atomically finishes interrupted dispatch attempts without retrying or overwriting known outcomes", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return {}; });
  try {
    const run = f.start(); await settled(f.engine, run.runId);
    const record = f.repo.get("runs", run.runId);
    record.state = "RUNNING"; record.current = "read"; record.steps.read = "RUNNING";
    record.dispatch = "interrupted-attempt";
    f.repo.put("runs", record.id, record);
    f.repo.insert("attempts", record.dispatch, { id: record.dispatch, runId: record.id, nodeId: "read",
      state: "DISPATCHED", createdAt: new Date().toISOString(), attempt: 1 });
    const beforeCalls = calls;
    f.engine.recover();
    assert.equal(f.engine.status(run.runId).state, "OUTCOME_UNKNOWN");
    const attempt = f.repo.get("attempts", record.dispatch);
    assert.equal(attempt.state, "OUTCOME_UNKNOWN"); assert.equal(attempt.errorCode, "OUTCOME_UNKNOWN");
    assert.ok(attempt.finishedAt); assert.equal(calls, beforeCalls);
    const recovered = f.repo.get("runs", record.id), events = f.repo.events(record.id);
    f.engine.recover();
    assert.deepEqual(f.repo.get("runs", record.id), recovered);
    assert.deepEqual(f.repo.get("attempts", record.dispatch), attempt);
    assert.deepEqual(f.repo.events(record.id), events);
  } finally { await f.close(); }
});

test("optional source references and all missing declared bindings fail publication", async () => {
  const f = fixture();
  try {
    f.tool({ value: { type: "string" } });
    f.workflow.inputSchema.required = [];
    f.workflow.nodes[1]!.config.argumentsMappings = { "/value": { ref: { source: "input", pointer: "/value" } } };
    assert.throws(() => f.engine.validateDraft(f.workflow), (error: any) => error.code === "REFERENCE_OPTIONAL");
    f.workflow.inputSchema.required = ["value"];
    f.workflow.bindings.unused = "not-registered";
    assert.throws(() => f.engine.validateDraft(f.workflow), (error: any) => error.code === "ENVIRONMENT_OVERRIDE_DENIED");
    assert.throws(() => f.engine.saveDraft({ ...f.workflow, workflowId: "renamed" }, 1, {}),
      (error: any) => error.code === "REVISION_CONFLICT");
  } finally { await f.close(); }
});

test("known tool failure finishes the attempt and cancellation reports no in-flight call", async () => {
  const f = fixture(async (_b, _n, _a, _t, dispatch) => {
    dispatch(); throw new HubError("TOOL_FAILED", "Synthetic definitive failure");
  });
  try {
    const run = f.start(), state = await settled(f.engine, run.runId);
    assert.equal(state.state, "FAILED");
    assert.equal(f.repo.get("runs", run.runId).dispatch, undefined);
    const attempt = f.repo.all("attempts")[0];
    assert.equal(attempt.state, "FAILED"); assert.equal(attempt.errorCode, "TOOL_FAILED");
    assert.ok(attempt.finishedAt);
    assert.equal(f.engine.cancel({ runId: run.runId, expectedRevision: state.revision,
      idempotencyKey: crypto.randomUUID(), reason: "synthetic" }).inFlight, false);
  } finally { await f.close(); }
});

function agentNode(inputMappings: Json, properties: Json): Node {
  return { id: "agent", title: "Synthetic Agent", type: "agent_task", config: {
    kind: "analysis", instructions: "Return synthetic structured output", inputMappings,
    outputSchema: object(properties),
  } };
}
function advance(f: ReturnType<typeof fixture>, state: Json, payload: Json) {
  return f.engine.advance({ runId: state.runId, checkpointId: state.checkpoint.id,
    checkpointToken: state.checkpoint.token, expectedRevision: state.revision,
    idempotencyKey: crypto.randomUUID(), submission: { type: "agent_result", payload } });
}
function queryWorkflow(f: ReturnType<typeof fixture>) {
  f.workflow.mode = "guided";
  f.repo.put("bindings", "b", { ...f.repo.get("bindings", "b"), allowedQueryTemplates: ["by-id-v1"],
    verification: { serverEnforcedReadOnly: true, scope: "Synthetic fixture only" } });
  f.tool({ parameters: object({ accountId: { type: "string" } }), templateId: { type: "string" } });
  f.workflow.nodes[1]!.config.argumentsMappings = {
    "/parameters/accountId": { ref: { source: "node", nodeId: "agent", pointer: "/accountId" } },
    "/templateId": { value: "by-id-v1" },
  };
  f.workflow.nodes.splice(1, 0, agentNode({ "/accountId": { ref: { source: "input", pointer: "/value" } } },
    { accountId: { type: "string", pattern: "^1[3-9]\\d{9}$" } }));
  f.workflow.edges = [{ source: "start", target: "agent", port: "next" },
    { source: "agent", target: "read", port: "next" },
    { source: "read", target: "end", port: "next" }];
}

test("ordinary Agent outputs can use arbitrary business field names and transform mapped inputs", async () => {
  const f = fixture();
  try {
    f.workflow.mode = "guided";
    f.workflow.nodes = [f.workflow.nodes[0]!, agentNode({
      "/allowedOrderNo": { ref: { source: "input", pointer: "/value" } },
      "/summary": { value: "initial draft" },
    }, { orderNo: { type: "string" }, summary: { type: "string" } }), f.workflow.nodes[2]!];
    f.workflow.edges = [{ source: "start", target: "agent", port: "next" }, { source: "agent", target: "end", port: "next" }];
    const run = f.start({ value: "CUSTOMER-1001" }), state = await settled(f.engine, run.runId);
    advance(f, state, { orderNo: "CUSTOMER-1001", summary: "rewritten analysis" });
    assert.equal((await settled(f.engine, run.runId)).state, "SUCCEEDED");
  } finally { await f.close(); }
});

test("ordinary from/to strings follow their schema without acquiring date range semantics", async () => {
  const f = fixture();
  try {
    f.workflow.inputSchema = object({ from: { type: "string" }, to: { type: "string" } });
    const run = f.start({ from: "warehouse-A", to: "warehouse-B" });
    assert.equal((await settled(f.engine, run.runId)).state, "SUCCEEDED");
  } finally { await f.close(); }
});

test("declared date-time ranges retain ordering, format and 24-hour limits", async () => {
  const f = fixture();
  try {
    f.workflow.inputSchema = object({ from: { type: "string", format: "date-time" },
      to: { type: "string", format: "date-time" } });
    const run = f.start({ from: "2026-10-29T00:00:00Z", to: "2026-10-30T00:00:00Z" });
    assert.equal((await settled(f.engine, run.runId)).state, "SUCCEEDED");
    for (const inputs of [
      { from: "2026-10-29T01:00:00Z", to: "2026-10-29T00:00:00Z" },
      { from: "2026-10-29T00:00:00Z", to: "2026-10-30T00:00:01Z" },
      { from: "warehouse-A", to: "warehouse-B" },
    ]) assert.throws(() => f.engine.start({ workflowId: f.workflow.workflowId, version: f.workflow.version,
      mode: "auto", inputs, idempotencyKey: crypto.randomUUID() }), (error: any) => error.code === "INPUT_INVALID");
    assert.equal(f.repo.all("runs").length, 1);
  } finally { await f.close(); }
});

test("non-object Agent payload schemas fail publication and object payloads retain nested scalar types", async (t) => {
  for (const type of ["string", "array", "integer", "number", "boolean", "null"]) await t.test(type, async () => {
    const f = fixture();
    try {
      f.workflow.mode = "guided";
      const agent = agentNode({}, {}); agent.config.outputSchema = type === "array" ? { type, items: { type: "string" } } : { type };
      f.workflow.nodes = [f.workflow.nodes[0]!, agent, f.workflow.nodes[2]!];
      f.workflow.edges = [{ source: "start", target: "agent", port: "next" }, { source: "agent", target: "end", port: "next" }];
      f.engine.saveDraft(f.workflow, undefined, {});
      assert.throws(() => f.engine.publish(f.workflow.workflowId), (error: any) => error.code === "SCHEMA_INVALID" &&
        error.details.issues.some((issue: Json) => issue.nodeId === "agent" && issue.path.endsWith("/outputSchema")));
      assert.equal(f.repo.all("versions").length, 0); assert.equal(f.repo.all("runs").length, 0);
    } finally { await f.close(); }
  });
  await t.test("object", async () => {
    const f = fixture();
    try {
      f.workflow.mode = "guided";
      f.workflow.nodes = [f.workflow.nodes[0]!, agentNode({}, { text: { type: "string" }, count: { type: "integer" },
        values: { type: "array", items: { type: "boolean" } } }), f.workflow.nodes[2]!];
      f.workflow.edges = [{ source: "start", target: "agent", port: "next" }, { source: "agent", target: "end", port: "next" }];
      const run = f.start(), waiting = await settled(f.engine, run.runId);
      advance(f, waiting, { text: "synthetic", count: 1, values: [true, false] });
      assert.equal((await settled(f.engine, run.runId)).state, "SUCCEEDED");
    } finally { await f.close(); }
  });
});

test("object payload compatibility resolves local definitions and schema combinations without accepting scalar-only roots", () => {
  for (const schema of [
    { $defs: { payload: { type: "object" } }, $ref: "#/$defs/payload" },
    { allOf: [{ type: "object" }, { properties: { title: { type: "string" } } }] },
    { anyOf: [{ type: "object" }, { type: "null" }] },
  ]) assert.doesNotThrow(() => assertObjectPayloadSchema(schema));
  for (const schema of [
    { $defs: { payload: { type: "string" } }, $ref: "#/$defs/payload" },
    { anyOf: [{ type: "string" }, { type: "array" }] },
    { allOf: [{ type: "object" }, { type: "string" }] },
    { $ref: "https://invalid.example/schema" },
  ]) assert.throws(() => assertObjectPayloadSchema(schema), (error: any) => error.code === "SCHEMA_INVALID");
});

test("node validation aggregates safe structured issues with exact mapping and schema paths", async () => {
  const f = fixture();
  try {
    f.tool({ value: { type: "string" } });
    const second = structuredClone(f.workflow.nodes[1]!); second.id = "second";
    second.config.toolSchemaHash = "sha256:" + "0".repeat(64);
    f.workflow.nodes.splice(2, 0, second);
    f.workflow.edges = [{ source: "start", target: "read", port: "next" },
      { source: "read", target: "second", port: "next" }, { source: "second", target: "end", port: "next" }];
    assert.throws(() => f.engine.validateDraft(f.workflow), (error: any) => {
      assert.equal(error.code, "MAPPING_INVALID");
      assert.deepEqual(error.details.issues.map((issue: Json) => ({ code: issue.code, nodeId: issue.nodeId, path: issue.path })), [
        { code: "MAPPING_INVALID", nodeId: "read", path: "/nodes/1/config/argumentsMappings/~1value" },
        { code: "TOOL_SCHEMA_DRIFT", nodeId: "second", path: "/nodes/2/config/toolSchemaHash" },
      ]);
      assert.ok(error.details.issues.every((issue: Json) => typeof issue.message === "string"));
      return true;
    });
    f.workflow.nodes[1]!.config.argumentsMappings = { "/environment": { value: "Bearer SYNTHETIC_PRIVATE_VALUE" } };
    assert.throws(() => f.engine.validateDraft(f.workflow), (error: any) => {
      assert.equal(error.code, "ENVIRONMENT_OVERRIDE_DENIED");
      assert.equal(JSON.stringify(error.details).includes("SYNTHETIC_PRIVATE_VALUE"), false);
      return true;
    });
  } finally { await f.close(); }
});

test("missing query template mappings expose nodeId and a machine-readable field path", async () => {
  const f = fixture();
  try {
    queryWorkflow(f); delete f.workflow.nodes.find((node) => node.id === "read")!.config.argumentsMappings["/templateId"];
    assert.throws(() => f.engine.validateDraft(f.workflow), (error: any) => {
      const issue = error.details.issues.find((item: Json) => item.nodeId === "read");
      assert.equal(issue.code, "MAPPING_INVALID"); assert.ok(issue.path.endsWith("/argumentsMappings/~1templateId"));
      return true;
    });
  } finally { await f.close(); }
});

test("schema keyword property names and inert const data do not become executable schema keywords", async () => {
  const f = fixture();
  try {
    const inert = { pattern: "^(a+)+$", $ref: "https://invalid.example/inert-value" };
    f.workflow.mode = "guided";
    f.workflow.inputSchema = object({ pattern: { type: "string" } });
    const literal = { ...object({ pattern: { type: "string" }, $ref: { type: "string" } }), const: inert };
    f.workflow.nodes = [f.workflow.nodes[0]!, agentNode({}, { pattern: { type: "string" }, literal }), f.workflow.nodes[2]!];
    f.workflow.edges = [{ source: "start", target: "agent", port: "next" }, { source: "agent", target: "end", port: "next" }];
    const run = f.start({ pattern: "warehouse" }), waiting = await settled(f.engine, run.runId);
    advance(f, waiting, { pattern: "safe-data-property", literal: inert });
    assert.equal((await settled(f.engine, run.runId)).state, "SUCCEEDED");
    f.workflow.nodes[1]!.config.outputSchema.properties.pattern.pattern = "^(a+)+$";
    assert.throws(() => f.engine.validateDraft(f.workflow), (error: any) => error.code === "SCHEMA_INVALID");
  } finally { await f.close(); }
});

test("original outputs preserve branch semantics and remain available after vault lock", async () => {
  let calls = 0;
  const f = fixture(async (_b, _n, _a, _t, dispatch) => { dispatch(); calls++; return {}; });
  try {
    const value = "13900000001";
    f.workflow.mode = "guided";
    f.workflow.nodes.splice(1, 0, agentNode({ "/accountId": { ref: { source: "input", pointer: "/value" } } },
      { accountId: { type: "string" } }),
      { id: "same", title: "Compare exact values", type: "condition", config: { expression: { op: "eq",
        left: { ref: { source: "node", nodeId: "agent", pointer: "/accountId" } },
        right: { ref: { source: "input", pointer: "/value" } } } } });
    f.workflow.edges = [{ source: "start", target: "agent", port: "next" },
      { source: "agent", target: "same", port: "next" }, { source: "same", target: "read", port: "true" },
      { source: "same", target: "end", port: "false" }, { source: "read", target: "end", port: "next" }];
    const run = f.start({ value }), state = await settled(f.engine, run.runId);
    assert.equal(state.checkpoint.inputs.accountId, value);
    advance(f, state, { accountId: value }); f.vault.lock();
    f.vault.unlock("Synthetic-mapping-password-2026");
    assert.equal((await settled(f.engine, run.runId)).state, "SUCCEEDED"); assert.equal(calls, 1);
    const record = f.repo.get("runs", run.runId);
    assert.equal(record.outputs.agent.accountId, value); assert.equal(record.outputs.same, true);
    assert.equal(JSON.stringify(record.outputs).includes(value), true);
    assert.equal(record.operationalOutputs, undefined);
    assert.equal(f.engine.status(run.runId).outputs.agent.accountId, value);
    assert.ok(record.outputBytes > 0);
  } finally { await f.close(); }
});

test("declared query scope preserves original handoff, password rotation and retention without broadening scope", async () => {
  let args: Json;
  const f = fixture(async (_b, _n, input, _t, dispatch) => { dispatch(); args = input; return {}; });
  try {
    const value = "13900000001"; queryWorkflow(f);
    const run = f.start({ value }), state = await settled(f.engine, run.runId);
    assert.equal(state.checkpoint.inputs.accountId, value);
    assert.throws(() => advance(f, state, { accountId: "13900000002" }),
      (error: any) => error.code === "SCOPE_OVERRIDE_DENIED");
    assert.equal(f.engine.status(run.runId).revision, state.revision);
    f.vault.changePassword("Synthetic-mapping-password-2026", "Rotated-synthetic-password-2026");
    f.vault.lock(); f.vault.unlock("Rotated-synthetic-password-2026");
    assert.equal(f.engine.status(run.runId).checkpoint.token, state.checkpoint.token);
    advance(f, state, { accountId: value });
    assert.equal((await settled(f.engine, run.runId)).state, "SUCCEEDED");
    assert.equal(args.parameters.accountId, value);
    const record = f.repo.get("runs", run.runId);
    record.updatedAt = new Date(Date.now() - 8 * 86400000).toISOString(); f.repo.put("runs", record.id, record);
    const preview = previewRetention(f.repo); assert.ok(preview.resultRuns.includes(run.runId));
    commitRetention(f.repo, preview.hash);
    assert.equal(f.repo.get("runs", run.runId).operationalOutputs, undefined);
    assert.deepEqual(f.repo.get("runs", run.runId).outputs, {});
    // Expired results have no ciphertext that can break a later rewrap.
    f.vault.changePassword("Rotated-synthetic-password-2026", "Second-rotated-password-2026");
  } finally { await f.close(); }
});

test("query parameters from undeclared Agent scope are rejected before publishing", async () => {
  const f = fixture();
  try {
    queryWorkflow(f);
    f.workflow.nodes.find((node) => node.id === "agent")!.config.inputMappings = {
      "/unrelated": { ref: { source: "input", pointer: "/value" } },
    };
    assert.throws(() => f.engine.validateDraft(f.workflow), (error: any) => error.code === "SCOPE_UNDECLARED");
  } finally { await f.close(); }
});

test("safe read retries honor 0/2 limits and finish every dispatched attempt", async (t) => {
  for (const limit of [0, 2]) await t.test("maxRetries=" + limit, async () => {
    let calls = 0;
    const f = fixture(async (_b, _n, _a, _t, dispatch) => {
      dispatch(); calls++; if (calls < 3) throw new HubError("TOOL_FAILED", "Synthetic transient failure"); return {};
    });
    try {
      f.workflow.budgets.maxRetries = limit;
      const run = f.start(), state = await settled(f.engine, run.runId);
      assert.equal(state.state, limit ? "SUCCEEDED" : "FAILED"); assert.equal(calls, limit ? 3 : 1);
      const attempts = f.repo.all("attempts");
      assert.deepEqual(attempts.map((attempt) => attempt.attempt), limit ? [1, 2, 3] : [1]);
      assert.ok(attempts.every((attempt) => attempt.finishedAt && attempt.state !== "DISPATCHED"));
      assert.equal(f.repo.events(run.runId).filter((event) => event.type === "TOOL_RETRY_SCHEDULED").length, limit);
    } finally { await f.close(); }
  });
});

test("unknown outcomes and policy failures never retry even when configured", async (t) => {
  for (const code of ["OUTCOME_UNKNOWN", "AUTH_REQUIRED", "BINDING_REVOKED", "TOOL_SCHEMA_DRIFT", "INPUT_INVALID", "TOOL_TIMEOUT"])
    await t.test(code, async () => {
      let calls = 0;
      const f = fixture(async (_b, _n, _a, _t, dispatch) => { dispatch(); calls++; throw new HubError(code, "Synthetic failure"); });
      try {
        f.workflow.budgets.maxRetries = 2;
        const run = f.start(); await settled(f.engine, run.runId);
        assert.equal(calls, 1);
        assert.equal(f.repo.events(run.runId).some((event) => event.type === "TOOL_RETRY_SCHEDULED"), false);
      } finally { await f.close(); }
    });
});

test("retry backoff observes cancellation and revocation before the next dispatch", async (t) => {
  for (const action of ["cancel", "revoke"]) await t.test(action, async () => {
    let calls = 0;
    const f = fixture(async (_b, _n, _a, _t, dispatch) => { dispatch(); calls++; throw new HubError("TOOL_FAILED", "Synthetic transient failure"); });
    try {
      f.workflow.budgets.maxRetries = 2;
      const run = f.start();
      for (let index = 0; index < 100 && !f.repo.events(run.runId).some((event) => event.type === "TOOL_RETRY_SCHEDULED"); index++)
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      assert.ok(f.repo.events(run.runId).some((event) => event.type === "TOOL_RETRY_SCHEDULED"));
      if (action === "cancel") {
        const state = f.engine.status(run.runId);
        assert.equal(f.engine.cancel({ runId: run.runId, expectedRevision: state.revision,
          idempotencyKey: crypto.randomUUID(), reason: "Synthetic cancellation" }).inFlight, false);
      } else f.repo.put("bindings", "b", { ...f.repo.get("bindings", "b"), validationStatus: "REVOKED" });
      const state = await settled(f.engine, run.runId);
      assert.equal(state.state, action === "cancel" ? "CANCELLED" : "BLOCKED"); assert.equal(calls, 1);
      await f.engine.close(); assert.equal(calls, 1);
    } finally { await f.close(); }
  });
});

test("nested business JSON keeps types, exact mapping and artifact bytes without a parallel encrypted display value", async () => {
  const business = { email: "dev@example.com", phone: "13900000001", orderNo: "订单-017",
    url: "https://example.com/order?token=ordinary-business-text", password: "业务字段", token: 42,
    nested: { flag: true, empty: null, count: 3, items: ["中文日志 password=wrong token=expired"] } };
  let dispatched: Json;
  const f = fixture(async (_b, _n, args, _t, dispatch) => { dispatch(); dispatched = args.value; return business; });
  try {
    const schema = object({ email: { type: "string" }, phone: { type: "string" }, orderNo: { type: "string" },
      url: { type: "string" }, password: { type: "string" }, token: { type: "number" },
      nested: object({ flag: { type: "boolean" }, empty: { type: "null" }, count: { type: "number" },
        items: { type: "array", items: { type: "string" } } }) });
    f.workflow.inputSchema = object({ value: schema });
    f.tool({ value: schema });
    f.workflow.nodes[1]!.config.argumentsMappings = { "/value": { ref: { source: "input", pointer: "/value" } } };
    const run = f.start({ value: business });
    const state = await settled(f.engine, run.runId);
    assert.equal(state.state, "SUCCEEDED");
    assert.deepEqual(dispatched, business);
    assert.deepEqual(state.outputs.read, business);
    assert.deepEqual(f.repo.get("runs", run.runId).outputs.read, business);
    assert.equal(f.repo.get("runs", run.runId).operationalOutputs, undefined);
    const artifact = f.engine.readArtifact({ runId: run.runId, artifactId: state.artifacts[0].id });
    assert.deepEqual(JSON.parse(artifact.content), business);
    assert.equal(state.events.some(e => e.type === "WAITING_APPROVAL"), false);
  } finally { await f.close(); }
});

test("old encrypted business outputs hydrate the checkpoint and remain readable without rewriting history", async () => {
  const f = fixture();
  try {
    queryWorkflow(f);
    const run = f.start({ value: "13900000001" }), waiting = await settled(f.engine, run.runId);
    const record = f.repo.get("runs", run.runId), original = record.outputs.start;
    record.operationalOutputs = { start: f.vault.encrypt(JSON.stringify(original), run.runId + ":output:start") };
    record.outputs.start = { value: "[PHONE]" };
    record.checkpoint.inputs.accountId = "[PHONE]";
    f.repo.put("runs", run.runId, record);
    const before = hash(f.repo.get("runs", run.runId));
    const hydrated = f.engine.status(run.runId);
    assert.equal(hydrated.checkpoint.inputs.accountId, "13900000001");
    assert.deepEqual(hydrated.outputs.start, original);
    assert.equal(hash(f.repo.get("runs", run.runId)), before);
    f.vault.lock();
    assert.equal(f.engine.status(run.runId).outputAvailability, "VAULT_LOCKED");
    f.vault.unlock("Synthetic-mapping-password-2026");
    advance(f, hydrated, { accountId: "13900000001" });
    assert.equal((await settled(f.engine, run.runId)).state, "SUCCEEDED");
  } finally { await f.close(); }
});
