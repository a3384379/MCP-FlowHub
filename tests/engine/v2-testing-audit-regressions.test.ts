import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { Application } from "../../packages/application/src/index.js";
import { hash, type Json } from "../../packages/contracts/src/domain.js";

function setup(t: any, mode = "auto") {
  const db = new Database(":memory:"), repo = new Repository(db), vault = new Vault(repo), engine = new Engine(repo, vault, new Connectors(repo, vault)), app = new Application(engine);
  t.after(async () => { await app.close(); await engine.close(); if(db.open)db.close(); });
  app.authoring.create({ workflowId: "testing", name: "testing", environment: "test", mode, template: "blank", idempotencyKey: "create" });
  return { db, repo, app, engine };
}
const outputSchema = { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false };
function host(f: ReturnType<typeof setup>) {
  const capability = { id: "host", capabilityId: "host", revision: 1, kind: "mcp_tool", name: "host_read", executor: "codex_host", inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputSchema };
  f.repo.put("capabilities", "host", capability); f.repo.put("capability_revisions", "host@1", { ...capability, id: "host@1", capabilityRevision: 1 });
  f.app.authoring.patch({ workflowId: "testing", expectedRevision: 1, idempotencyKey: "patch", operations: [
    { op: "add_node", nodeId: "host", nodeType: "agent_task", title: "host", capabilityRef: { capabilityId: "host", revision: 1 }, config: { kind: "host_tool", executorRef: "codex_host", instructions: "Synthetic host result", inputMappings: {}, outputSchema } },
    { op: "disconnect", source: "input", target: "end", port: "next" }, { op: "connect", source: "input", target: "host", port: "next" }, { op: "connect", source: "host", target: "end", port: "next" }] });
}
function proposed(id: string, payload?: Json) {
  return { id, name: id, inputs: {}, mockResults: [], agentSubmissions: payload ? [{ nodeId: "host", payload }] : [], assertions: [{ kind: "terminal_state", expected: "SUCCEEDED" }], expectedValidationErrors: [] };
}
function generate(f: ReturnType<typeof setup>, cases: Json[]) {
  return f.app.testing.generate({ workflowId: "testing", expectedRevision: 2, strategy: "agent_proposed", proposedCases: cases, idempotencyKey: "generate" });
}

test("isolated host fixtures freeze capability contracts and distinguish missing/invalid fixtures", async t => {
  const f = setup(t, "guided"); host(f);
  const suite = generate(f, [proposed("valid", { count: 1 }), proposed("missing"), proposed("invalid", { count: "wrong" })]);
  const run = f.app.testing.run({ suiteId: suite.suiteId, expectedSuiteRevision: 1, mode: "mock", idempotencyKey: "run" });
  // Mutating the live registry while the accepted run is executing cannot affect its contract.
  f.repo.put("capabilities", "host", { ...f.repo.get("capabilities", "host"), revision: 2, outputSchema: { type: "object" } });
  await f.app.testing.idle(); const result = f.app.testing.status(run.testRunId);
  assert.deepEqual(result.cases.map((c: Json) => [c.id, c.status, c.errorCode]), [["valid", "PASSED", null], ["missing", "UNCOVERED", "FIXTURE_MISSING"], ["invalid", "FAILED", "INPUT_INVALID"]]);
  assert.equal(result.cases[0].provenance, "synthetic_fixture"); assert.deepEqual(result.cases[0].outputs.host, { count: 1 });
  assert.equal(result.networkCalls, 0); assert.equal(result.realSecretReads, 0); assert.equal(result.stale, true);
  assert.ok(result.cases[0].events.some((e: Json) => e.type === "HOST_TOOL_REPORTED" && e.verification === "synthetic_fixture"));
});

test("missing capability revision is a typed acceptance error before a test run is persisted", t => {
  const f = setup(t, "guided"); host(f); const suite = generate(f, [proposed("normal", { count: 1 })]);
  f.db.prepare("DELETE FROM capability_revisions WHERE id=?").run("host@1");
  assert.throws(() => f.app.testing.run({ suiteId: suite.suiteId, expectedSuiteRevision: 1, mode: "mock", idempotencyKey: "run" }), { code: "CAPABILITY_STALE" });
  assert.equal(f.repo.all("workflow_test_runs").length, 0);
});

test("generation and run replay recover accepted immutable IDs after draft and suite edits", async t => {
  const f = setup(t), request = { workflowId: "testing", expectedRevision: 1, strategy: "deterministic", idempotencyKey: "generate" };
  const suite = f.app.testing.generate(request), runRequest = { suiteId: suite.suiteId, expectedSuiteRevision: 1, mode: "mock", idempotencyKey: "run", caseIds: ["normal"] };
  const run = f.app.testing.run(runRequest); await f.app.testing.idle(); const original = f.app.testing.status(run.testRunId);
  f.app.testing.generate({ workflowId: "testing", expectedRevision: 1, strategy: "agent_proposed", proposedCases: [{ ...proposed("replacement"), agentSubmissions: [] }], baseSuiteId: suite.suiteId, expectedSuiteRevision: 1, idempotencyKey: "update-suite" });
  f.app.authoring.patch({ workflowId: "testing", expectedRevision: 1, idempotencyKey: "edit", operations: [{ op: "set_metadata", changes: { name: "Later" } }] });
  assert.deepEqual(f.app.testing.generate(request), suite); assert.deepEqual(f.app.testing.run(runRequest), run);
  assert.equal(f.repo.all("workflow_test_suites").length, 1); assert.equal(f.repo.all("workflow_test_runs").length, 1);
  assert.deepEqual(f.app.testing.status(run.testRunId).cases, original.cases);
  assert.throws(() => f.app.testing.generate({ ...request, expectedRevision: 2 }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.throws(() => f.app.testing.run({ ...runRequest, caseIds: ["replacement"] }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.throws(() => f.app.testing.run({ ...runRequest, expectedSuiteRevision: 2, caseIds: ["replacement"], idempotencyKey: "fresh" }), { code: "TEST_BASELINE_STALE" });
  assert.equal(f.app.testing.status(run.testRunId).stale, true);
});

test("revoked owners cannot replay accepted test commands", async t => {
  const f = setup(t); f.repo.put("clients", "owner", { id: "owner", revision: 1, revoked: false, scopes: ["workflow:author"], workflowAllowlist: ["testing"] });
  const request = { workflowId: "testing", expectedRevision: 1, strategy: "deterministic", idempotencyKey: "generate" }, suite = f.app.testing.generate(request, "owner");
  const run = { suiteId: suite.suiteId, expectedSuiteRevision: 1, mode: "mock", idempotencyKey: "run" }; f.app.testing.run(run, "owner"); await f.app.testing.idle();
  f.repo.put("clients", "owner", { ...f.repo.get("clients", "owner"), revoked: true, revision: 2 });
  assert.throws(() => f.app.testing.generate(request, "owner"), { code: "AUTH_REQUIRED" }); assert.throws(() => f.app.testing.run(run, "owner"), { code: "AUTH_REQUIRED" });
});

test("mock connector enforces runtime environment/row contracts and retains raw evidence", async t => {
  const f = setup(t), inputSchema = { type: "object", properties: {}, additionalProperties: false }, output = { type: "object", properties: { environment: { type: "string" }, rows: { type: "array" }, rowCount: { type: "integer" } }, required: ["rows", "rowCount"], additionalProperties: false };
  const tool = { name: "read", inputSchema, outputSchema: output, schemaHash: "sha256:" + hash({ inputSchema, outputSchema: output }) };
  f.repo.put("connections", "real-metadata-only", { id: "real-metadata-only", revision: 1, tools: [tool], endpoint: "https://never-contact.invalid", secretRef: "never-read" });
  f.repo.put("bindings", "binding", { id: "binding", revision: 1, connectionId: "real-metadata-only", connectionRevision: 1, environment: "test", allowedTools: ["read"], lockedArguments: {}, allowedQueryTemplates: [], simulationOnly: false, validationStatus: "BINDING_VERIFIED", maxRows: 10, timeoutSeconds: 5 });
  f.app.authoring.patch({ workflowId: "testing", expectedRevision: 1, idempotencyKey: "patch", operations: [{ op: "set_binding", key: "data", bindingId: "binding" },
    { op: "add_node", nodeId: "query", nodeType: "mcp_tool", title: "query", config: { bindingKey: "data", toolName: tool.name, toolSchemaHash: tool.schemaHash, argumentsMappings: {}, resultAdapterRef: "structured" } },
    { op: "disconnect", source: "input", target: "end", port: "next" }, { op: "connect", source: "input", target: "query", port: "next" }, { op: "connect", source: "query", target: "end", port: "next" }] });
  const cases = [{ id: "valid", result: { rows: [], rowCount: 0 }, code: null }, { id: "environment", result: { rows: [], rowCount: 0, environment: "production" }, code: "ENVIRONMENT_MISMATCH" }, { id: "row-count", result: { rows: [{}], rowCount: 0 }, code: "OUTPUT_INVALID" }].map(c => ({ ...proposed(c.id), mockResults: [{ nodeId: "query", capabilityId: "read", responseMode: "structured", result: c.result }], assertions: [c.code ? { kind: "error_code", expected: c.code } : { kind: "terminal_state", expected: "SUCCEEDED" }] }));
  const suite = generate(f, cases), run = f.app.testing.run({ suiteId: suite.suiteId, expectedSuiteRevision: 1, mode: "mock", idempotencyKey: "run" }); await f.app.testing.idle();
  const result = f.app.testing.status(run.testRunId); assert.equal(result.status, "SUCCEEDED", JSON.stringify(result));
  assert.deepEqual(result.cases.map((c: Json) => c.errorCode), [null, "ENVIRONMENT_MISMATCH", "OUTPUT_INVALID"]);
  assert.ok(result.cases[0].artifacts.some((a: Json) => a.mimeType === "application/mcp+json")); assert.equal(result.networkCalls, 0); assert.equal(result.realSecretReads, 0);
  assert.ok(!JSON.stringify(f.repo.get("workflow_test_runs", run.testRunId)).includes("never-contact.invalid"));
});

test("deterministic generation drives nested string conditions and reports unvisited branch reasons", async t => {
  const f = setup(t), schema = { type: "object", properties: { order: { type: "object", properties: { status: { type: "string", enum: ["open", "closed"] } }, required: ["status"], additionalProperties: false } }, required: ["order"], additionalProperties: false };
  f.app.authoring.patch({ workflowId: "testing", expectedRevision: 1, idempotencyKey: "patch", operations: [{ op: "set_input_schema", schema },
    { op: "add_node", nodeId: "branch", nodeType: "condition", title: "branch", config: { expression: { op: "eq", left: { ref: { source: "input", pointer: "/order/status" } }, right: { value: "open" } } } },
    { op: "disconnect", source: "input", target: "end", port: "next" }, { op: "connect", source: "input", target: "branch", port: "next" }, { op: "connect", source: "branch", target: "end", port: "true" }, { op: "connect", source: "branch", target: "end", port: "false" }] });
  const suite = f.app.testing.generate({ workflowId: "testing", expectedRevision: 2, strategy: "deterministic", idempotencyKey: "generate" });
  const run = f.app.testing.run({ suiteId: suite.suiteId, expectedSuiteRevision: 1, mode: "mock", idempotencyKey: "run" }); await f.app.testing.idle();
  assert.deepEqual(f.app.testing.status(run.testRunId).branchCoverage, [{ nodeId: "branch", true: true, false: true }]);
  const single = f.app.testing.run({ suiteId: suite.suiteId, expectedSuiteRevision: 1, mode: "mock", idempotencyKey: "single", caseIds: ["normal"] }); await f.app.testing.idle();
  const result = f.app.testing.status(single.testRunId); assert.ok(result.gaps.some((g: Json) => g.nodeId === "branch" && g.branch === "false" && g.code === "BRANCH_NOT_COVERED" && g.reason));
});

test("terminal testing close interrupts an agent checkpoint, stops later cases and finishes all writes before database close", {timeout:3000}, async t => {
  const f = setup(t, "guided"); host(f);
  const suite = generate(f, Array.from({length:20}, (_,index) => proposed("case-"+index, {count:1})));
  const originalStatus=Engine.prototype.status,originalStart=Engine.prototype.start,originalAdvance=Engine.prototype.advance;
  const isolated:Engine[]=[];let advances=0,closing:Promise<void>|undefined,atCheckpoint!:()=>void;
  const reachedCheckpoint=new Promise<void>(resolve=>atCheckpoint=resolve);
  t.mock.method(Engine.prototype,"start",function(this:Engine,...args:Parameters<Engine["start"]>){
    if(this!==f.engine)isolated.push(this);return originalStart.apply(this,args);
  });
  t.mock.method(Engine.prototype,"advance",function(this:Engine,...args:Parameters<Engine["advance"]>){
    if(this!==f.engine)advances++;return originalAdvance.apply(this,args);
  });
  t.mock.method(Engine.prototype,"status",function(this:Engine,...args:Parameters<Engine["status"]>){
    const status=originalStatus.apply(this,args);
    if(this!==f.engine&&status.state==="WAITING_AGENT"&&!closing){closing=f.app.testing.close();atCheckpoint();}
    return status;
  });
  const request={suiteId:suite.suiteId,expectedSuiteRevision:1,mode:"mock",idempotencyKey:"run"};
  const run=f.app.testing.run(request);await reachedCheckpoint;await closing;
  const result=f.app.testing.status(run.testRunId);
  assert.equal(result.status,"INTERRUPTED");assert.equal(result.errorCode,"TASK_INTERRUPTED");
  assert.deepEqual(result.cases.map((c:Json)=>[c.id,c.status,c.errorCode]),[["case-0","INTERRUPTED","TASK_INTERRUPTED"]]);
  assert.equal(isolated.length,1);assert.equal(advances,0);assert.equal(isolated[0]!.repo.db.open,false);
  assert.equal(f.app.testing.close(),closing);
  assert.throws(()=>f.app.testing.run(request),{code:"SERVICE_CLOSING"});
  assert.throws(()=>f.app.testing.generate({workflowId:"testing",expectedRevision:2,strategy:"deterministic",idempotencyKey:"later"}),{code:"SERVICE_CLOSING"});
  const stable=hash(f.repo.get("workflow_test_runs",run.testRunId));await f.app.testing.idle();assert.equal(hash(f.repo.get("workflow_test_runs",run.testRunId)),stable);
  f.db.close();await f.app.testing.close();await f.app.testing.idle();
});
