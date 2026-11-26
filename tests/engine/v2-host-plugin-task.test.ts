import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { Application } from "../../packages/application/src/index.js";
import { type Json } from "../../packages/contracts/src/domain.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { freezePluginTask } from "../../packages/workflow-core/src/host-plugin.js";

const projectId = "4f3ef660-4867-414a-89e5-9bb77b86a0a0";
const environmentId = "5f3ef660-4867-414a-89e5-9bb77b86a0a0";
const workflowId = "6f3ef660-4867-414a-89e5-9bb77b86a0a0";
const liteRunId = "7f3ef660-4867-414a-89e5-9bb77b86a0a0";
const pluginRef = { pluginId: "discovered-plugin", revision: 1 };
const inputVariables = { expected: 200 };
const resultSchema = {
  type: "object",
  required: ["projectId", "environmentId", "workflowId", "runId", "status", "failedNodes"],
  properties: {
    projectId: { type: "string" }, environmentId: { type: "string" },
    workflowId: { type: "string" }, runId: { type: "string" },
    status: { type: "string", enum: ["passed", "failed", "cancelled"] },
    failedNodes: { type: "array", items: { type: "object", properties: { nodeId: { type: "string" }, code: { type: "string" },
      message: { type: "string" } }, required: ["nodeId"], additionalProperties: false } },
  }, additionalProperties: false,
};

async function fixture(t: TestContext) {
  const db = new Database(":memory:");
  const repo = new Repository(db);
  const vault = new Vault(repo);
  vault.initialize("synthetic-host-task-password");
  const engine = new Engine(repo, vault, new Connectors(repo, vault));
  const app = new Application(engine);
  t.after(async () => { await app.close(); await engine.close(); db.close(); });
  const context = { contextId: "fixture", contextRevision: 1 };
  repo.put("host_contexts", "fixture", { id: "fixture", revision: 1 });
  repo.put("discovery_entities", pluginRef.pluginId, { ...context, id: pluginRef.pluginId,
    revision: 1, sourceKey: "flowtest-lite@local", entityKind: "plugin", installation: "installed", enabled: true, name: "flowtest-lite" });
  repo.put("discovery_entities", "lite-server", { ...context, entityKind: "mcp_server", pluginId: pluginRef.pluginId, enabled: true });
  for (const name of ["workflow_run", "workflow_run_get", "workflow_delete", "environment_list"]) {
    repo.put("capabilities", name, { ...context, id: name, capabilityId: name, revision: 1,
      kind: "mcp_tool", executor: "codex_host", enabled: "enabled", serverName: "lite", name,
      inputSchema: { type: "object" }, tool: { annotations: { readOnlyHint: name === "environment_list" } } });
    repo.put("discovery_entities", name, { ...context, id: name, entityKind: "mcp_tool", pluginId: pluginRef.pluginId,
      capabilityId: name, capabilityRevision: 1, parentId: "lite-server", enabled: true, executor: "codex_host" });
  }
  const config = {
    kind: "host_plugin", executorRef: "codex_host", pluginRef,
    profile: "flowtest_lite", scope: { projectId, environmentId }, instructions: "Run the fixed fixture.",
    inputMappings: { "/workflowId": { value: workflowId }, "/runtimeVariables": { value: inputVariables } },
    outputSchema: resultSchema,
  };
  const draft = "lite-host-task";
  app.authoring.create({ workflowId: draft, name: "FlowTest-Lite fixture", environment: "test", mode: "guided", template: "blank", idempotencyKey: "create" });
  const ref = (pointer: string) => ({ ref: { source: "node", nodeId: "test", pointer } });
  const changed = app.authoring.patch({ workflowId: draft, expectedRevision: 1, idempotencyKey: "patch", operations: [
    { op: "add_node", nodeId: "test", nodeType: "agent_task", title: "Test plugin", config },
    { op: "add_node", nodeId: "check", nodeType: "condition", title: "Result",
      config: { expression: { op: "eq", left: ref("/status"), right: { value: "passed" } } } },
    { op: "add_node", nodeId: "failed", nodeType: "report_template", title: "Test failed",
      config: { templateRef: "incident-markdown/v1", inputMappings: {}, outputSchema: { type: "object", properties: { reportMarkdown: { type: "string" },
        evidenceRefs: { type: "array", items: { type: "string" } } }, additionalProperties: false } } },
    { op: "update_node", nodeId: "end", changes: { config: { resultRef: ref("") } } },
    { op: "disconnect", source: "input", target: "end", port: "next" },
    ...[["input", "test", "next"], ["test", "check", "next"], ["check", "end", "true"], ["check", "failed", "false"], ["failed", "end", "next"]]
      .map(([source, target, port]) => ({ op: "connect", source, target, port })),
  ] });
  app.authoring.publish({ workflowId: draft, expectedRevision: changed.revision, version: "1.0.0",
    expectedBindingRevisions: {}, expectedCapabilityRevisions: {}, idempotencyKey: "publish" });
  const { runId } = engine.start({ workflowId: draft, version: "1.0.0", mode: "guided", inputs: {}, idempotencyKey: "start" });
  const waiting = await t.waitFor(() => {
    const state = engine.handle("workflow_status", { runId, view: "checkpoint" });
    assert.equal(state.state, "WAITING_AGENT");
    return state;
  }, { interval: 5 });
  const cp = waiting.checkpoint;
  const envelope = { runId, checkpointId: cp.id, checkpointToken: cp.token, expectedRevision: waiting.revision };
  const claimRequest = { ...envelope, idempotencyKey: "claim", submission: { type: "host_tool_claim" } };
  return { engine, repo, config, cp, runId, envelope, claimRequest };
}

test("a claimed plugin task verifies scope, call identity, run lineage, and sends a real failure outcome down the false branch", async t => {
  const { engine, repo, cp, runId, claimRequest, envelope } = await fixture(t);
  assert.deepEqual(cp.pluginTask.tools.map((tool: Json) => tool.name), ["environment_list", "workflow_run", "workflow_run_get"]);
  assert.throws(() => engine.advance({ ...envelope, idempotencyKey: "plain",
    submission: { type: "agent_result", payload: { status: "passed" } } }), { code: "HOST_RECEIPT_REQUIRED" });
  const claim = engine.advance(claimRequest);
  assert.deepEqual(engine.advance(claimRequest), claim);
  const start = { server: "lite", tool: "workflow_run", arguments: { project_id: projectId, workflow_id: workflowId,
    options: { environment_id: environmentId, runtime_variables: inputVariables } },
    result: { id: liteRunId, workflow_id: workflowId, status: "running", nodes: [] } };
  const done = { server: "lite", tool: "workflow_run_get", arguments: { project_id: projectId, run_id: liteRunId },
    result: { id: liteRunId, workflow_id: workflowId, status: "failed", nodes: [
      { node_id: "api", status: "failed", error_code: "HTTP_ASSERTION_FAILED", error_message: "assertion failed" },
    ] } };
  const submission = { type: "host_plugin_result", claimId: claim.claimId,
    pluginId: pluginRef.pluginId, pluginRevision: pluginRef.revision, taskHash: cp.taskHash };
  const result = { ...envelope, expectedRevision: claim.acceptedRevision, idempotencyKey: "receipt" };
  const advance = (calls: Json[]) => engine.advance({ ...result, submission: { ...submission, calls } });
  assert.throws(() => advance([{ ...start, tool: "workflow_delete" }, done]), { code: "HOST_RECEIPT_MISMATCH" });
  assert.throws(() => advance([{ ...start, arguments: { ...start.arguments, project_id: liteRunId } }, done]), { code: "SCOPE_OVERRIDE_DENIED" });
  assert.throws(() => advance([{ ...start, arguments: { ...start.arguments, options: { environment_id: projectId } } }, done]), { code: "SCOPE_OVERRIDE_DENIED" });
  assert.throws(() => advance([{ ...start, arguments: { ...start.arguments, options: { environment_id: environmentId } } }, done]), { code: "SCOPE_OVERRIDE_DENIED" });
  assert.throws(() => advance([start, { ...done, arguments: { ...done.arguments, run_id: projectId } }]), { code: "HOST_RECEIPT_MISMATCH" });
  assert.throws(() => advance([start]), { code: "HOST_RECEIPT_SCHEMA_INVALID" });
  assert.throws(() => advance([start, { ...done, result: { ...done.result, status: "running" } }]), { code: "HOST_RECEIPT_SCHEMA_INVALID" });
  assert.throws(() => advance([start, { ...done, result: { ...done.result, status: "passed" } }]), { code: "HOST_RECEIPT_SCHEMA_INVALID" });
  const accepted = advance([start, done]);
  assert.deepEqual(advance([start, done]), accepted);
  assert.equal(accepted.receipt.verification, "host_reported");
  await t.waitFor(() => assert.equal(engine.status(runId).state, "SUCCEEDED"), { interval: 5 });
  const run = repo.get("runs", runId);
  assert.equal(run.outputs.check, false);
  assert.equal(run.steps.failed, "SUCCEEDED");
  assert.equal(run.steps.end, "SUCCEEDED");
  assert.deepEqual(run.outputs.test, { runId: liteRunId, workflowId, projectId, environmentId, status: "failed",
    failedNodes: [{ nodeId: "api", code: "HTTP_ASSERTION_FAILED", message: "assertion failed" }] });
  assert.ok(repo.get("artifacts", accepted.receipt.artifactId));
  assert.equal(run.toolCalls, 2);
});

test("the installed plugin must still own the frozen tools when a Codex session claims the checkpoint", async t => {
  const { engine, repo, config, runId, claimRequest } = await fixture(t);
  const generic = freezePluginTask(repo, { id: "read", type: "agent_task", title: "Read", config: { ...config, profile: "read_only", scope: undefined } });
  assert.deepEqual(generic.tools.map(t => t.name), ["environment_list"]);
  repo.put("discovery_entities", "lite-server", { ...repo.get("discovery_entities", "lite-server"), pluginId: "different-plugin" });
  assert.throws(() => engine.advance(claimRequest), { code: "HOST_CAPABILITY_UNAVAILABLE" });
  assert.equal(engine.status(runId).state, "WAITING_AGENT");
});
