import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { Application } from "../../packages/application/src/index.js";
import { ScriptedModelProvider, type ModelTurn } from "../../packages/llm-providers/src/index.js";
import { HubError, type Json } from "../../packages/contracts/src/domain.js";

const password = "Synthetic-executor-password";
type FixtureOptions = {
  kind?: "analysis" | "host_tool";
  script?: ConstructorParameters<typeof ScriptedModelProvider>[0];
  strict?: boolean;
  resource?: Json;
  resourceSchema?: Json;
  outputFields?: Record<string, Json>;
  businessVerification?: Json;
  owner?: string;
};
async function setup(t: TestContext, {
  kind = "analysis", script = [], strict = false, resource = "synthetic",
  resourceSchema = { type: "string" }, outputFields = {}, businessVerification, owner = "execution",
}: FixtureOptions = {}) {
  const db = new Database(":memory:");
  const repo = new Repository(db);
  const vault = new Vault(repo);
  vault.initialize(password);
  const engine = new Engine(repo, vault, new Connectors(repo, vault));
  const provider = new ScriptedModelProvider(script);
  const app = new Application(engine, { providerFactory: () => provider });
  t.after(async () => { await app.close(); await engine.close(); db.close(); });
  const profile = app.assistant.saveProfile({
    name: "fixture", providerKind: "openai_responses", baseUrl: "https://example.invalid/v1", model: "synthetic",
  });
  const workflowId = "executor-demo";
  app.authoring.create({ workflowId, name: "执行器夹具", environment: "test", mode: "guided", template: "blank", idempotencyKey: "create" });
  const outputSchema = {
    type: "object", properties: { summary: resourceSchema, ...outputFields },
    required: ["summary"], additionalProperties: false,
  };
  const cap = {
    id: "host-cap", capabilityId: "host-cap", kind: "mcp_tool", name: "host_read", executor: "codex_host", revision: 1,
    inputSchema: { type: "object", properties: { resource: resourceSchema }, required: ["resource"], additionalProperties: false },
    outputSchema,
  };
  const hostTool = kind === "host_tool";
  if (hostTool) {
    repo.put("capabilities", cap.id, cap);
    repo.put("capability_revisions", cap.id + "@1", { ...cap, id: cap.id + "@1", capabilityRevision: 1 });
  }
  const changed = app.authoring.patch({ workflowId, expectedRevision: 1, idempotencyKey: "patch", operations: [
    { op: "add_node", nodeId: "agent", nodeType: "agent_task", title: "分析",
      ...(hostTool ? { capabilityRef: { capabilityId: cap.id, revision: 1 } } : {}),
      config: {
        kind, instructions: "Synthetic analysis", executorRef: hostTool ? "codex_host" : "assistant_local",
        inputMappings: hostTool ? { "/resource": { value: resource } } : {}, outputSchema,
        ...(strict ? { requireHostReceipt: true, receiptScopeMappings: { "/summary": "/resource" } } : {}),
        ...(businessVerification ? { businessVerification } : {}),
      },
    },
    { op: "disconnect", source: "input", target: "end", port: "next" },
    { op: "connect", source: "input", target: "agent", port: "next" },
    { op: "connect", source: "agent", target: "end", port: "next" },
  ] });
  app.authoring.publish({
    workflowId, expectedRevision: changed.revision, version: "1.0.0",
    expectedBindingRevisions: {}, expectedCapabilityRevisions: hostTool ? { [cap.id]: 1 } : {}, idempotencyKey: "publish",
  });
  if (owner !== "execution")
    repo.put("clients", owner, { id: owner, workflowAllowlist: [workflowId], revoked: false });
  const { runId } = engine.start({ workflowId, version: "1.0.0", mode: "guided", inputs: {}, idempotencyKey: "run" }, owner);
  for (let i = 0; i < 100 && engine.status(runId, owner).state !== "WAITING_AGENT"; i++)
    await new Promise(r => setTimeout(r, 2));
  assert.equal(engine.status(runId, owner).state, "WAITING_AGENT");
  return { app, engine, repo, vault, provider, profile, runId, owner, workflowId };
}
function claimCheckpoint(f: Awaited<ReturnType<typeof setup>>, idempotencyKey = "claim") {
  const { checkpoint, revision } = f.engine.handle(
    "workflow_status", { runId: f.runId, view: "checkpoint" }, f.owner,
  );
  const envelope = { runId: f.runId, checkpointId: checkpoint.id, checkpointToken: checkpoint.token, expectedRevision: revision };
  const claimRequest = { ...envelope, idempotencyKey, submission: { type: "host_tool_claim" } };
  const claim = f.engine.advance(claimRequest, f.owner);
  return {
    claimRequest, claim, resultEnvelope: { ...envelope, expectedRevision: claim.acceptedRevision },
    identity: { claimId: claim.claimId, capabilityId: checkpoint.capabilityRef.capabilityId,
      capabilityRevision: checkpoint.capabilityRef.revision, argumentsHash: checkpoint.argumentsHash },
  };
}
test("assistant analysis uses a checkpoint lease and existing advance, retaining business originals",async t=>{
  let release!:(turn:ModelTurn)=>void;
  const f=await setup(t,{script:[()=>new Promise<ModelTurn>(r=>release=r)]}),cp=f.engine.status(f.runId);
  const task=f.app.assistant.analyzeCheckpoint(f.runId,f.profile.id,"analysis");
  assert.throws(()=>f.app.assistant.analyzeCheckpoint(f.runId,f.profile.id,"second"),{code:"CHECKPOINT_CLAIMED"});
  assert.throws(()=>f.engine.advance({runId:f.runId,checkpointId:cp.checkpoint.id,checkpointToken:cp.checkpoint.token,expectedRevision:cp.revision,idempotencyKey:"codex",submission:{type:"agent_result",payload:{summary:"race"}}}),{code:"CHECKPOINT_CLAIMED"});
  release({text:JSON.stringify({summary:"token business@example.invalid 原值"}),calls:[],usage:null});await f.app.assistant.settled();
  assert.equal(f.app.assistant.task(task.taskId).status,"COMPLETED");
  for(let i=0;i<100&&f.engine.status(f.runId).state!=="SUCCEEDED";i++)await new Promise(r=>setTimeout(r,2));
  assert.equal(f.engine.status(f.runId).state,"SUCCEEDED");assert.equal(f.repo.get("runs",f.runId).outputs.agent.summary,"token business@example.invalid 原值");
});
test("host-only checkpoint freezes identity and arguments and cannot be consumed by a model Key",async t=>{
  const f=await setup(t,{kind:"host_tool"}),status=f.engine.status(f.runId);
  assert.equal(status.checkpoint.capability.name,"host_read");assert.deepEqual(status.checkpoint.resolvedArguments,{resource:"synthetic"});
  assert.throws(()=>f.app.assistant.analyzeCheckpoint(f.runId,f.profile.id,"forbidden"),{code:"HOST_CAPABILITY_UNAVAILABLE"});assert.equal(f.provider.requests.length,0);
  f.engine.advance({runId:f.runId,checkpointId:status.checkpoint.id,checkpointToken:status.checkpoint.token,expectedRevision:status.revision,idempotencyKey:"host",submission:{type:"agent_result",payload:{summary:"Host reported result"}}});
  assert.equal(f.repo.get("runs",f.runId).hostReported.agent.verification,"host_reported");
});
test("analysis auth errors do not retry or consume the checkpoint",async t=>{
  const f=await setup(t,{script:[()=>{throw new HubError("MODEL_AUTH_FAILED","Synthetic denied",401);}]});
  const task=f.app.assistant.analyzeCheckpoint(f.runId,f.profile.id,"auth-denied");await f.app.assistant.settled();
  assert.equal(f.provider.requests.length,1);assert.equal(f.app.assistant.task(task.taskId).errorCode,"MODEL_AUTH_FAILED");assert.equal(f.engine.status(f.runId).state,"WAITING_AGENT");
});

test("structured Codex receipt pins the exact checkpoint envelope, scope, outcome and idempotency", async t => {
  const f = await setup(t, { kind: "host_tool", strict: true });
  const { checkpoint, revision } = f.engine.handle("workflow_status", { runId: f.runId, view: "checkpoint" });
  const cp = { runId: f.runId, checkpointId: checkpoint.id, checkpointToken: checkpoint.token, expectedRevision: revision };
  assert.equal(checkpoint.inputs, undefined);
  assert.equal(f.repo.get("runs", f.runId).checkpoint.resolvedArguments, undefined);
  assert.throws(() => f.engine.advance({ ...cp, idempotencyKey: "legacy", submission: { type: "agent_result", payload: { summary: "synthetic" } } }), { code: "HOST_RECEIPT_REQUIRED" });
  const claimRequest = { ...cp, idempotencyKey: "claim", submission: { type: "host_tool_claim" } };
  const claim = f.engine.advance(claimRequest);
  assert.deepEqual(f.engine.advance(claimRequest), claim);
  const savedCommand = f.repo.db.prepare("SELECT response FROM commands WHERE operation='advance' AND key='claim'").pluck().get();
  assert.ok(typeof savedCommand === "string" && !savedCommand.includes(claim.claimId));
  assert.ok(!JSON.stringify(f.repo.get("runs", f.runId).checkpoint.hostClaim).includes(claim.claimId));
  f.vault.lock();
  assert.throws(() => f.engine.advance(claimRequest), { code: "CREDENTIAL_LOCKED" });
  assert.equal(f.engine.status(f.runId).checkpoint.resolvedArguments, undefined);
  f.vault.changePassword(password, "Synthetic-rotated-password");
  assert.deepEqual(f.engine.status(f.runId).checkpoint.resolvedArguments, { resource: "synthetic" });
  assert.deepEqual(f.engine.advance(claimRequest), claim);
  assert.throws(() => f.engine.advance(claimRequest, "other-owner"), { code: "WORKFLOW_NOT_AVAILABLE" });
  assert.throws(() => f.engine.advance({ ...claimRequest, idempotencyKey: "rival", expectedRevision: claim.acceptedRevision }), { code: "CHECKPOINT_CLAIMED" });
  const submission = { type: "host_tool_result", claimId: claim.claimId, capabilityId: "host-cap", capabilityRevision: 1, argumentsHash: checkpoint.argumentsHash, toolCallId: "codex-synthetic-call", payload: { summary: "synthetic" } };
  const resultRequest = { ...cp, expectedRevision: claim.acceptedRevision, idempotencyKey: "result", submission };
  const rejected = (changes: object, code: string) => assert.throws(
    () => f.engine.advance({ ...resultRequest, submission: { ...submission, ...changes } }), { code },
  );
  rejected({ claimId: "someone-else" }, "CHECKPOINT_CLAIMED");
  rejected({ capabilityRevision: 2 }, "HOST_RECEIPT_MISMATCH");
  rejected({ argumentsHash: "f".repeat(64) }, "HOST_RECEIPT_MISMATCH");
  assert.throws(
    () => f.engine.advance({ ...resultRequest, submission: { ...submission, payload: { summary: 0 } } }),
    { code: "HOST_RECEIPT_SCHEMA_INVALID", details: {
      issues: [{ path: "/summary", keyword: "type", actualType: "number", expectedType: "string" }],
    } },
  );
  rejected({ payload: { summary: "another scope" } }, "SCOPE_OVERRIDE_DENIED");
  const saved = f.engine.advance(resultRequest);
  assert.deepEqual(f.engine.advance(resultRequest), saved);
  assert.throws(() => f.engine.advance(claimRequest), { code: "CHECKPOINT_CLAIM_INACTIVE" });
  rejected({ toolCallId: "another-call" }, "IDEMPOTENCY_CONFLICT");
  assert.equal(saved.receipt.toolCallId, submission.toolCallId);
  assert.equal(saved.receipt.origin, "codex_host");
  assert.equal(f.repo.get("artifacts", saved.receipt.artifactId).content, JSON.stringify(submission.payload));
  assert.equal(f.repo.events(f.runId).filter(event => event.type === "HOST_TOOL_REPORTED").length, 1);
});
test("structured Codex failure resumes known authorization denial and stops unknown dispatch", async t => {
  const f = await setup(t, { kind: "host_tool", strict: true });
  const first = claimCheckpoint(f, "first");
  const authorization = "synthetic-auth-value";
  f.vault.addSecret("diagnostic fixture", authorization, { purpose: "mcp_auth" });
  const denial = { ...first.resultEnvelope, idempotencyKey: "denied", submission: {
    type: "host_tool_failure", ...first.identity, code: "AUTH_REQUIRED",
    errorMessage: "合成 MCP 权限不足\nAuthorization: Bearer " + authorization,
  } };
  const denied = await f.app.handle("workflow_advance", denial);
  assert.equal(denied.state, "BLOCKED");
  assert.deepEqual(await f.app.handle("workflow_advance", denial), denied);
  assert.equal(denied.receipt.origin, "codex_host");
  assert.equal(denied.receipt.errorCode, "AUTH_REQUIRED");
  const diagnostic = f.engine.readArtifact({ runId: f.runId, artifactId: denied.receipt.artifactId });
  assert.match(diagnostic.content, /合成 MCP 权限不足/);
  assert.doesNotMatch(diagnostic.content, new RegExp(authorization));
  assert.equal(f.engine.status(f.runId).hostResultReceived, false);
  f.engine.resume(f.runId);
  for (let index = 0; index < 100 && f.engine.status(f.runId).state !== "WAITING_AGENT"; index++)
    await new Promise(r => setTimeout(r, 2));
  const second = claimCheckpoint(f, "second");
  assert.notEqual(second.resultEnvelope.checkpointId, first.resultEnvelope.checkpointId);
  assert.throws(() => f.engine.advance(first.claimRequest), { code: "CHECKPOINT_CLAIM_INACTIVE" });
  f.engine.advance({ ...second.resultEnvelope, idempotencyKey: "unknown", submission: {
    type: "host_tool_failure", ...second.identity, code: "OUTCOME_UNKNOWN",
  } });
  assert.equal(f.engine.status(f.runId).state, "OUTCOME_UNKNOWN");
  assert.throws(() => f.engine.resume(f.runId), { code: "STATE_INVALID" });
});

test("restart preserves a live claim and expires an unresolved claim without fabricating a host receipt", async t => {
  const f = await setup(t, { kind: "host_tool", strict: true });
  const { claimRequest, claim } = claimCheckpoint(f);
  await f.engine.close();
  f.vault.lock();
  const restartedVault = new Vault(f.repo);
  const restarted = new Engine(f.repo, restartedVault, new Connectors(f.repo, restartedVault));
  try {
    restarted.recover();
    assert.equal(restarted.status(f.runId).state, "WAITING_AGENT");
    assert.throws(() => restarted.advance(claimRequest), { code: "CREDENTIAL_LOCKED" });
    restartedVault.unlock(password);
    assert.deepEqual(restarted.advance(claimRequest), claim);
    const run = f.repo.get("runs", f.runId);
    run.checkpoint.expiresAt = Date.now() - 1;
    f.repo.put("runs", f.runId, run);
    restarted.recover();
    restarted.recover();
    const status = restarted.status(f.runId);
    assert.equal(status.state, "OUTCOME_UNKNOWN");
    assert.equal(status.steps.agent, "OUTCOME_UNKNOWN");
    assert.equal(status.hostResultReceived, false);
    assert.equal(status.checkpoint, undefined);
    assert.equal(status.nodeDetails.find((node: Json) => node.nodeId === "agent")?.source?.origin, "flowhub");
    const failures = status.events.filter((event: Json) => event.type === "HOST_TOOL_FAILED");
    assert.equal(failures.length, 1);
    assert.equal(failures[0].verification, "engine_recorded");
    assert.throws(() => restarted.advance(claimRequest), { code: "CHECKPOINT_CLAIM_INACTIVE" });
  } finally {
    await restarted.close();
  }
});

test("competing claims allow one grant and a cancel retracts that grant", async t => {
  const f = await setup(t, { kind: "host_tool", strict: true });
  const { checkpoint, revision } = f.engine.status(f.runId);
  const request = { runId: f.runId, checkpointId: checkpoint.id, checkpointToken: checkpoint.token, expectedRevision: revision,
    idempotencyKey: "host-one", submission: { type: "host_tool_claim" } };
  const [first, second] = await Promise.allSettled([
    f.app.handle("workflow_advance", request),
    f.app.handle("workflow_advance", { ...request, idempotencyKey: "host-two" }),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.equal(second.reason.code, "REVISION_CONFLICT");
  const cancel = { runId: f.runId, expectedRevision: first.value.acceptedRevision,
    idempotencyKey: "cancel", reason: "Synthetic withdrawal" };
  const stopped = await f.app.handle("workflow_cancel", cancel);
  assert.equal(stopped.state, "OUTCOME_UNKNOWN");
  assert.equal(stopped.inFlight, true);
  assert.deepEqual(await f.app.handle("workflow_cancel", cancel), stopped);
  await assert.rejects(f.app.handle("workflow_advance", request), { code: "CHECKPOINT_CLAIM_INACTIVE" });
  assert.equal(f.repo.get("runs", f.runId).hostReported.agent.origin, "flowhub");
});

test("a claim replay through advance immediately settles an expired checkpoint", async t => {
  const f = await setup(t, { kind: "host_tool", strict: true });
  const { claimRequest } = claimCheckpoint(f);
  const run = f.repo.get("runs", f.runId);
  run.checkpoint.expiresAt = Date.now() - 1;
  f.repo.put("runs", f.runId, run);
  assert.throws(() => f.engine.advance(claimRequest), { code: "CHECKPOINT_EXPIRED" });
  assert.equal(f.repo.get("runs", f.runId).state, "OUTCOME_UNKNOWN");
});

test("claim and result replays recheck the current owner grants", async t => {
  const f = await setup(t, { kind: "host_tool", strict: true, owner: "synthetic-client" });
  const { claimRequest, resultEnvelope, identity } = claimCheckpoint(f);
  const payload = { summary: "synthetic" };
  const result = { ...resultEnvelope, idempotencyKey: "result", submission: { type: "host_tool_result", ...identity, payload } };
  const client = f.repo.get("clients", f.owner);
  f.repo.put("clients", f.owner, { ...client, workflowAllowlist: [] });
  await assert.rejects(f.app.handle("workflow_advance", claimRequest, f.owner), { code: "WORKFLOW_NOT_AVAILABLE" });
  await assert.rejects(f.app.handle("workflow_advance", result, f.owner), { code: "WORKFLOW_NOT_AVAILABLE" });
  f.repo.put("clients", f.owner, client);
  await f.app.handle("workflow_advance", result, f.owner);
  f.repo.put("clients", f.owner, { ...client, revoked: true });
  await assert.rejects(f.app.handle("workflow_advance", result, f.owner), { code: "WORKFLOW_NOT_AVAILABLE" });
});

test("structured receipt preserves typed scope, raw JSON and scoped evidence independently", async t => {
  const f = await setup(t, {
    kind: "host_tool", strict: true, resource: null, resourceSchema: { type: ["string", "null"] },
    outputFields: { kind: { type: "string" }, evidenceRefs: { type: "string" }, rowCount: { type: "integer" } },
    businessVerification: { pointer: "/kind", verified: ["confirmed"], rowCountPointer: "/rowCount" },
  });
  const { resultEnvelope, identity } = claimCheckpoint(f);
  const before = f.repo.get("runs", f.runId);
  f.repo.put("artifacts", "art_fixture", { id: "art_fixture", runId: f.runId, expiresAt: Date.now() + 60000 });
  f.repo.put("artifacts", "art_foreign", { id: "art_foreign", runId: "run_other", expiresAt: Date.now() + 60000 });
  f.repo.put("artifacts", "art_expired", { id: "art_expired", runId: f.runId, expiresAt: Date.now() - 1 });
  const payload = { summary: null, kind: "confirmed", evidenceRefs: "supplier-visible identifier", rowCount: 0 };
  const request = { ...resultEnvelope, idempotencyKey: "receipt",
    submission: { type: "host_tool_result", ...identity, evidenceRefs: ["art_fixture"], payload } };
  const advance = (changes: object) => f.app.handle("workflow_advance", { ...request, submission: { ...request.submission, ...changes } });
  await assert.rejects(advance({ payload: { ...payload, summary: "null" } }), { code: "SCOPE_OVERRIDE_DENIED" });
  await assert.rejects(advance({ payload: { ...payload, rowCount: 101 } }), { code: "BUDGET_EXCEEDED" });
  await assert.rejects(advance({ evidenceRefs: ["art_foreign"] }), { code: "ARTIFACT_INVALID" });
  await assert.rejects(advance({ evidenceRefs: ["art_expired"] }), { code: "ARTIFACT_INVALID" });
  assert.deepEqual(f.repo.get("runs", f.runId), before);
  const result = await advance({});
  assert.deepEqual(result.receipt.evidenceRefs, ["art_fixture"]);
  assert.deepEqual(f.repo.get("runs", f.runId).outputs.agent, payload);
  assert.equal(f.engine.status(f.runId).businessVerification.nodes[0]?.rowCount, 0);
  assert.deepEqual(JSON.parse(f.engine.readArtifact({ runId: f.runId, artifactId: result.receipt.artifactId }).content), payload);
});

test("mock host fixtures verify checkpoint arguments without claiming real host evidence", async t => {
  const f = await setup(t, { kind: "host_tool", strict: true });
  const search = f.engine.search({ query: f.workflowId });
  assert.equal(search.items[0]?.validationStatus, "UNVERIFIED");
  assert.equal(f.engine.handle("workflow_get", { workflowId: f.workflowId }).demoOnly, false);
  const suite = await f.app.handle("workflow_test_generate", {
    workflowId: f.workflowId, expectedRevision: f.repo.get("workflows", f.workflowId).revision,
    idempotencyKey: "test-generate", strategy: "agent_proposed", proposedCases: [{
      id: "fixture", name: "Synthetic Codex fixture", inputs: {}, mockResults: [],
      agentSubmissions: [{ nodeId: "agent", payload: { summary: "synthetic" } }],
      assertions: [
        { kind: "tool_called", nodeId: "agent", expected: true },
        { kind: "argument_equals", nodeId: "agent", pointer: "/resource", expected: "synthetic" },
        { kind: "artifact_contains", nodeId: "agent", expected: "synthetic" },
        { kind: "terminal_state", expected: "SUCCEEDED" },
      ],
      expectedValidationErrors: [],
    }],
  });
  const { testRunId } = await f.app.handle("workflow_test_run", {
    suiteId: suite.suiteId, expectedSuiteRevision: suite.suiteRevision, mode: "mock", idempotencyKey: "test-run",
  });
  await f.app.testing.idle();
  const report = await f.app.handle("workflow_test_status", { testRunId });
  assert.equal(report.status, "SUCCEEDED", JSON.stringify(report));
  assert.equal(report.networkCalls, 0);
  assert.equal(report.realSecretReads, 0);
  assert.deepEqual(report.cases[0].trace, [
    { nodeId: "agent", arguments: { resource: "synthetic" }, provenance: "synthetic_host_fixture" },
  ]);
  assert.ok(report.cases[0].events.some((event: Json) =>
    event.type === "HOST_TOOL_REPORTED" && event.verification === "synthetic_fixture"));
});
