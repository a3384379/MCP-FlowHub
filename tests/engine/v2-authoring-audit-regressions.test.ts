import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { Application } from "../../packages/application/src/index.js";
import { registerAdmin } from "../../packages/admin-api/src/index.js";
import { hash, type Json } from "../../packages/contracts/src/domain.js";

function setup(t: any, mode = "auto") {
  const db = new Database(":memory:"), repo = new Repository(db), vault = new Vault(repo);
  vault.initialize("Synthetic-authoring-audit-password");
  const engine = new Engine(repo, vault, new Connectors(repo, vault)), app = new Application(engine);
  t.after(async () => { await app.close(); await engine.close(); db.close(); });
  app.authoring.create({ workflowId: "audit", name: "audit", environment: "test", mode, template: "blank", idempotencyKey: "create" });
  return { db, repo, vault, engine, app };
}
const outputSchema = { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false };
function wire(f: ReturnType<typeof setup>, operation: Json, extra: Json[] = []) {
  return f.app.authoring.patch({ workflowId: "audit", expectedRevision: 1, idempotencyKey: "patch", operations: [...extra, operation,
    { op: "disconnect", source: "input", target: "end", port: "next" },
    { op: "connect", source: "input", target: operation.nodeId, port: "next" },
    { op: "connect", source: operation.nodeId, target: "end", port: "next" }] });
}
function binding(f: ReturnType<typeof setup>, inputSchema: Json, lockedArguments: Json) {
  const tool = { name: "read", inputSchema, outputSchema, schemaHash: "sha256:" + hash({ inputSchema, outputSchema }) };
  f.repo.put("connections", "fixture", { id: "fixture", revision: 1, synthetic: true, disabled: false, tools: [tool] });
  const value = { id: "binding", revision: 1, connectionId: "fixture", connectionRevision: 1, environment: "test", allowedTools: ["read"],
    lockedArguments, allowedQueryTemplates: [], simulationOnly: true, validationStatus: "MOCK_VERIFIED", maxRows: 10, timeoutSeconds: 5 };
  f.repo.put("bindings", value.id, value); return { value, tool };
}
function publish(f: ReturnType<typeof setup>, overrides: Json = {}) {
  return f.app.authoring.publish({ workflowId: "audit", expectedRevision: 2, version: "1.0.0", expectedBindingRevisions: {}, expectedCapabilityRevisions: {}, idempotencyKey: "publish", ...overrides });
}
async function state(f: ReturnType<typeof setup>, runId: string, expected: string[]) {
  for (let i = 0; i < 200; i++) { const value = f.engine.status(runId); if (expected.includes(value.state)) return value; await new Promise(r => setTimeout(r, 2)); }
  assert.fail("Run did not reach " + expected.join(","));
}
function host(f: ReturnType<typeof setup>, nodeOutput = outputSchema) {
  const cap = { id: "host-cap", capabilityId: "host-cap", kind: "mcp_tool", name: "host_read", executor: "codex_host", revision: 1,
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputSchema };
  f.repo.put("capabilities", cap.id, cap); f.repo.put("capability_revisions", cap.id + "@1", { ...cap, id: cap.id + "@1", capabilityRevision: 1 });
  wire(f, { op: "add_node", nodeId: "host", nodeType: "agent_task", title: "host", capabilityRef: { capabilityId: cap.id, revision: 1 },
    config: { kind: "host_tool", executorRef: "codex_host", instructions: "Synthetic host fixture", inputMappings: {}, outputSchema: nodeOutput } });
  return cap;
}

test("native limit never overlaps a fixed resource, including nested parent and child paths", async t => {
  for (const [locked, pointer, schema] of [
    [{ "/tenantId": 123 }, "/tenantId", { type: "object", properties: { tenantId: { type: "integer" } }, required: ["tenantId"] }],
    [{ "/scope": { tenantId: 123 } }, "/scope/tenantId", { type: "object", properties: { scope: { type: "object", properties: { tenantId: { type: "integer" } }, required: ["tenantId"] } }, required: ["scope"] }],
    [{ "/scope/tenantId": 123 }, "/scope", { type: "object", properties: { scope: { type: "object", properties: { tenantId: { type: "integer" } }, required: ["tenantId"] } }, required: ["scope"] }],
  ] as [Json, string, Json][]) await t.test(pointer + " vs " + Object.keys(locked)[0], async sub => {
    const f = setup(sub), { tool } = binding(f, schema, locked); let calls = 0;
    f.engine.connectors.call = async () => { calls++; return { count: 1 }; };
    const patched = wire(f, { op: "add_node", nodeId: "query", nodeType: "mcp_tool", title: "query", config: { bindingKey: "data", toolName: tool.name, toolSchemaHash: tool.schemaHash, argumentsMappings: {}, rowLimitArgument: pointer } }, [{ op: "set_binding", key: "data", bindingId: "binding" }]);
    assert.ok(patched.issues.some((i: Json) => i.code === "ENVIRONMENT_OVERRIDE_DENIED"));
    assert.throws(() => publish(f, { expectedBindingRevisions: { binding: 1 } }), { code: "WORKFLOW_INVALID" });
    // Protect an already stored candidate as well as the authoring validator.
    const record = f.repo.get("workflows", "audit");
    f.repo.put("versions", "audit@unsafe", { id: "audit@unsafe", workflowId: "audit", version: "unsafe", contentHash: "sha256:" + hash(record.draft), snapshot: { workflow: record.draft, bindings: [f.repo.get("bindings", "binding")], capabilities: [] } });
    assert.throws(() => f.engine.start({ workflowId: "audit", version: "unsafe", mode: "auto", inputs: {}, idempotencyKey: "start" }), { code: "ENVIRONMENT_OVERRIDE_DENIED" });
    assert.equal(f.repo.all("runs").length, 0); assert.equal(calls, 0);
  });
});

test("v2 HTTP/service publication requires the shared DTO and reviewed binding CAS", async t => {
  const f = setup(t), { value, tool } = binding(f, { type: "object", properties: {}, additionalProperties: false }, {});
  wire(f, { op: "add_node", nodeId: "query", nodeType: "mcp_tool", title: "query", config: { bindingKey: "data", toolName: tool.name, toolSchemaHash: tool.schemaHash, argumentsMappings: {} } }, [{ op: "set_binding", key: "data", bindingId: "binding" }]);
  const root = await mkdtemp(join(tmpdir(), "flowhub-authoring-http-")), http = Fastify();
  t.after(async () => { await http.close(); await rm(root, { recursive: true, force: true }); });
  const { auth } = await registerAdmin(http, f.engine, root, f.app.authoring, f.app.registry, f.app); auth.setup("Synthetic-authoring-http-password"); const session = auth.session();
  const request = (payload: Json) => http.inject({ method: "POST", url: "/api/v2/workflows/audit/publish", payload, headers: { cookie: "flowhub_session=" + session.token, "x-csrf-token": session.csrf } });
  const good = { expectedRevision: 2, version: "1.0.0", expectedBindingRevisions: { binding: 1 }, expectedCapabilityRevisions: {}, idempotencyKey: "publish" };
  const count = () => f.db.prepare("SELECT count(*) AS n FROM commands").get() as { n: number };
  const before = count().n;
  for (const invalid of [{ ...good, expectedBindingRevisions: undefined }, { ...good, expectedCapabilityRevisions: undefined }, { ...good, extra: true }, { ...good, expectedBindingRevisions: { binding: "1" } }]) {
    const response = await request(invalid); assert.equal(response.statusCode, 422, response.body); assert.equal(response.json().error.code, "INPUT_INVALID");
    assert.throws(() => f.app.authoring.publish({ ...invalid, workflowId: "audit" }), { code: "INPUT_INVALID" });
    await assert.rejects(f.app.handle("workflow_draft_publish", { ...invalid, workflowId: "audit" }), { code: "INPUT_INVALID" });
    assert.equal(count().n, before); assert.equal(f.repo.get("workflows", "audit").revision, 2); assert.equal(f.repo.get("versions", "audit@1.0.0"), undefined);
  }
  f.repo.put("bindings", value.id, { ...value, revision: 2, maxRows: 3 }, 1);
  assert.equal((await request(good)).statusCode, 409);
  const response = await request({ ...good, expectedBindingRevisions: { binding: 2 } }); assert.equal(response.statusCode, 200, response.body);
  const original = f.repo.get("versions", "audit@1.0.0");
  f.repo.put("bindings", value.id, { ...value, revision: 3, maxRows: 1 }, 2);
  assert.deepEqual(f.repo.get("versions", original.id), original);
  assert.deepEqual((await request({ ...good, expectedBindingRevisions: { binding: 2 } })).json().data, response.json().data);
  assert.throws(() => publish(f, { expectedRevision: 2, expectedBindingRevisions: { binding: 3 } }), { code: "IDEMPOTENCY_CONFLICT" });
});

test("host output contracts cannot be weakened and published checkpoints use immutable capability schemas", async t => {
  await t.test("incompatible authored schema blocks publication", sub => {
    const f = setup(sub, "guided"); host(f, { type: "object", properties: { count: { type: "string" } }, required: ["count"], additionalProperties: false } as Json);
    assert.equal(f.app.authoring.validate({ workflowId: "audit", expectedRevision: 2, level: "publish" }).valid, false);
    assert.throws(() => publish(f, { expectedCapabilityRevisions: { "host-cap": 1 } }), { code: "WORKFLOW_INVALID" });
    assert.equal(f.repo.get("versions", "audit@1.0.0"), undefined);
  });
  await t.test("invalid submissions leave the same checkpoint available", async sub => {
    const f = setup(sub, "guided"), cap = host(f); publish(f, { expectedCapabilityRevisions: { "host-cap": 1 } });
    f.repo.put("capabilities", cap.id, { ...cap, revision: 2, outputSchema: { type: "object" } });
    f.db.prepare("DELETE FROM capability_revisions WHERE id=?").run("host-cap@1");
    const started = f.engine.start({ workflowId: "audit", version: "1.0.0", mode: "guided", inputs: {}, idempotencyKey: "start" });
    const cp = await state(f, started.runId, ["WAITING_AGENT"]); assert.deepEqual(cp.checkpoint.requiredOutputSchema, outputSchema);
    for (const payload of [{ count: "bad" }, {}, { count: 1, extra: true }]) {
      assert.throws(() => f.engine.advance({ runId: started.runId, checkpointId: cp.checkpoint.id, checkpointToken: cp.checkpoint.token, expectedRevision: cp.revision, idempotencyKey: "invalid", submission: { type: "agent_result", payload } }), { code: "INPUT_INVALID" });
      assert.equal(f.engine.status(started.runId).checkpoint.id, cp.checkpoint.id); assert.equal(f.engine.status(started.runId).revision, cp.revision);
    }
    f.engine.advance({ runId: started.runId, checkpointId: cp.checkpoint.id, checkpointToken: cp.checkpoint.token, expectedRevision: cp.revision, idempotencyKey: "valid", submission: { type: "agent_result", payload: { count: 1 } } });
    await state(f, started.runId, ["SUCCEEDED"]); assert.equal(f.repo.get("runs", started.runId).hostReported.host.verification, "host_reported");
  });
});

test("undo of layout changes keeps semantic revision and later unrelated config fields", async t => {
  const f = setup(t, "guided"); host(f);
  const moved = f.app.authoring.patch({ workflowId: "audit", expectedRevision: 2, idempotencyKey: "move", operations: [{ op: "move_nodes", expectedLayoutRevision: 1, positions: [{ nodeId: "input", x: 30, y: 50 }] }] });
  const undone = f.app.authoring.undo({ workflowId: "audit", expectedRevision: 2, commandId: moved.commandId, idempotencyKey: "undo-layout" });
  assert.equal(undone.revision, 2); assert.equal(f.app.authoring.get("audit").layoutRevision, 3);
  const first = f.app.authoring.patch({ workflowId: "audit", expectedRevision: 2, idempotencyKey: "instructions", operations: [{ op: "update_node", nodeId: "host", changes: { config: { ...f.app.authoring.get("audit").draft.nodes.find((n: Json) => n.id === "host").config, instructions: "changed" } } }] });
  f.app.authoring.patch({ workflowId: "audit", expectedRevision: 3, idempotencyKey: "mapping", operations: [{ op: "set_mapping", nodeId: "host", section: "inputMappings", destination: "/new", expression: { value: "retained" } }] });
  f.app.authoring.undo({ workflowId: "audit", expectedRevision: 4, commandId: first.commandId, idempotencyKey: "undo-instruction" });
  const config = f.app.authoring.get("audit").draft.nodes.find((n: Json) => n.id === "host").config;
  assert.equal(config.instructions, "Synthetic host fixture"); assert.deepEqual(config.inputMappings["/new"], { value: "retained" });
});
