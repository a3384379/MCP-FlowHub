import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { Application } from "../../packages/application/src/index.js";
import { ScriptedModelProvider, type ModelTurn } from "../../packages/llm-providers/src/index.js";
async function setup(t:any,kind="analysis",script:any[]=[], strict=false) {
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo);vault.initialize("Synthetic-executor-password");
  const engine=new Engine(repo,vault,new Connectors(repo,vault)),provider=new ScriptedModelProvider(script),app=new Application(engine,{providerFactory:()=>provider});
  t.after(async()=>{await app.close();await engine.close();db.close();});
  const profile=app.assistant.saveProfile({name:"fixture",providerKind:"openai_responses",baseUrl:"https://example.invalid/v1",model:"synthetic"});
  app.authoring.create({workflowId:"executor-demo",name:"执行器夹具",environment:"test",mode:"guided",template:"blank",idempotencyKey:"create"});
  const output={type:"object",properties:{summary:{type:"string"}},required:["summary"],additionalProperties:false};
  const cap={id:"host-cap",capabilityId:"host-cap",kind:"mcp_tool",name:"host_read",executor:"codex_host",revision:1,inputSchema:{type:"object",properties:{resource:{type:"string",const:"synthetic"}},required:["resource"],additionalProperties:false},outputSchema:output};
  if(kind==="host_tool"){repo.put("capabilities",cap.id,cap);repo.put("capability_revisions",cap.id+"@1",{...cap,id:cap.id+"@1",capabilityRevision:1});}
  const changed=app.authoring.patch({workflowId:"executor-demo",expectedRevision:1,idempotencyKey:"patch",operations:[{op:"add_node",nodeId:"agent",nodeType:"agent_task",title:"分析",...(kind==="host_tool"?{capabilityRef:{capabilityId:cap.id,revision:1}}:{}),config:{kind,instructions:"Synthetic analysis",executorRef:kind==="host_tool"?"codex_host":"assistant_local",inputMappings:kind==="host_tool"?{"/resource":{value:"synthetic"}}:{},outputSchema:output,...(strict?{requireHostReceipt:true,receiptScopeMappings:{"/summary":"/resource"}}:{})}},{op:"disconnect",source:"input",target:"end",port:"next"},{op:"connect",source:"input",target:"agent",port:"next"},{op:"connect",source:"agent",target:"end",port:"next"}]});
  app.authoring.publish({workflowId:"executor-demo",expectedRevision:changed.revision,version:"1.0.0",expectedBindingRevisions:{},expectedCapabilityRevisions:kind==="host_tool"?{[cap.id]:1}:{},idempotencyKey:"publish"});
  const started=engine.start({workflowId:"executor-demo",version:"1.0.0",mode:"guided",inputs:{},idempotencyKey:"run"});
  for(let i=0;i<100&&engine.status(started.runId).state!=="WAITING_AGENT";i++)await new Promise(r=>setTimeout(r,2));
  assert.equal(engine.status(started.runId).state,"WAITING_AGENT");return {app,engine,repo,vault,provider,profile,runId:started.runId};
}
test("assistant analysis uses a checkpoint lease and existing advance, retaining business originals",async t=>{
  let release!:(turn:ModelTurn)=>void;
  const f=await setup(t,"analysis",[()=>new Promise<ModelTurn>(r=>release=r)]),cp=f.engine.status(f.runId);
  const task=f.app.assistant.analyzeCheckpoint(f.runId,f.profile.id,"analysis");
  assert.throws(()=>f.app.assistant.analyzeCheckpoint(f.runId,f.profile.id,"second"),{code:"CHECKPOINT_CLAIMED"});
  assert.throws(()=>f.engine.advance({runId:f.runId,checkpointId:cp.checkpoint.id,checkpointToken:cp.checkpoint.token,expectedRevision:cp.revision,idempotencyKey:"codex",submission:{type:"agent_result",payload:{summary:"race"}}}),{code:"CHECKPOINT_CLAIMED"});
  release({text:JSON.stringify({summary:"token business@example.invalid 原值"}),calls:[],usage:null});await f.app.assistant.settled();
  assert.equal(f.app.assistant.task(task.taskId).status,"COMPLETED");
  for(let i=0;i<100&&f.engine.status(f.runId).state!=="SUCCEEDED";i++)await new Promise(r=>setTimeout(r,2));
  assert.equal(f.engine.status(f.runId).state,"SUCCEEDED");assert.equal(f.repo.get("runs",f.runId).outputs.agent.summary,"token business@example.invalid 原值");
});
test("host-only checkpoint freezes identity and arguments and cannot be consumed by a model Key",async t=>{
  const f=await setup(t,"host_tool"),status=f.engine.status(f.runId);
  assert.equal(status.checkpoint.capability.name,"host_read");assert.deepEqual(status.checkpoint.resolvedArguments,{resource:"synthetic"});
  assert.throws(()=>f.app.assistant.analyzeCheckpoint(f.runId,f.profile.id,"forbidden"),{code:"HOST_CAPABILITY_UNAVAILABLE"});assert.equal(f.provider.requests.length,0);
  f.engine.advance({runId:f.runId,checkpointId:status.checkpoint.id,checkpointToken:status.checkpoint.token,expectedRevision:status.revision,idempotencyKey:"host",submission:{type:"agent_result",payload:{summary:"Host reported result"}}});
  assert.equal(f.repo.get("runs",f.runId).hostReported.agent.verification,"host_reported");
});
test("analysis auth errors do not retry or consume the checkpoint",async t=>{
  const {HubError}=await import("../../packages/contracts/src/domain.js");
  const f=await setup(t,"analysis",[()=>{throw new HubError("MODEL_AUTH_FAILED","Synthetic denied",401);}]);
  const task=f.app.assistant.analyzeCheckpoint(f.runId,f.profile.id,"auth-denied");await f.app.assistant.settled();
  assert.equal(f.provider.requests.length,1);assert.equal(f.app.assistant.task(task.taskId).errorCode,"MODEL_AUTH_FAILED");assert.equal(f.engine.status(f.runId).state,"WAITING_AGENT");
});

test("structured Codex receipt pins the exact checkpoint envelope, scope, outcome and idempotency", async t => {
  const f = await setup(t, "host_tool", [], true);
  const { checkpoint, revision } = f.engine.handle("workflow_status", { runId: f.runId, view: "checkpoint" });
  const cp = { runId: f.runId, checkpointId: checkpoint.id, checkpointToken: checkpoint.token, expectedRevision: revision };
  assert.equal(checkpoint.inputs, undefined);
  assert.equal(f.repo.get("runs", f.runId).checkpoint.resolvedArguments, undefined);
  f.vault.changePassword("Synthetic-executor-password", "Synthetic-rotated-password");
  assert.deepEqual(f.engine.status(f.runId).checkpoint.resolvedArguments, { resource: "synthetic" });
  assert.throws(() => f.engine.advance({ ...cp, idempotencyKey: "legacy", submission: { type: "agent_result", payload: { summary: "synthetic" } } }), { code: "HOST_RECEIPT_REQUIRED" });
  const claimRequest = { ...cp, idempotencyKey: "claim", submission: { type: "host_tool_claim" } };
  const claim = f.engine.advance(claimRequest);
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
  rejected({ payload: { summary: 0 } }, "HOST_RECEIPT_SCHEMA_INVALID");
  rejected({ payload: { summary: "another scope" } }, "SCOPE_OVERRIDE_DENIED");
  const saved = f.engine.advance(resultRequest);
  assert.deepEqual(f.engine.advance(resultRequest), saved);
  rejected({ toolCallId: "another-call" }, "IDEMPOTENCY_CONFLICT");
  assert.equal(saved.receipt.toolCallId, submission.toolCallId);
  assert.equal(f.repo.get("artifacts", saved.receipt.artifactId).content, JSON.stringify(submission.payload));
  assert.equal(f.repo.events(f.runId).filter(event => event.type === "HOST_TOOL_REPORTED").length, 1);
});
test("structured Codex failure resumes known authorization denial and stops unknown dispatch", async t => {
  const f = await setup(t, "host_tool", [], true);
  const claim = (suffix: string) => {
    const status = f.engine.status(f.runId), checkpoint = status.checkpoint;
    const envelope = { runId: f.runId, checkpointId: checkpoint.id, checkpointToken: checkpoint.token, expectedRevision: status.revision };
    const accepted = f.engine.advance({ ...envelope, idempotencyKey: "claim-" + suffix, submission: { type: "host_tool_claim" } });
    return { envelope: { ...envelope, expectedRevision: accepted.acceptedRevision }, failure: { type: "host_tool_failure",
      claimId: accepted.claimId, capabilityId: "host-cap", capabilityRevision: 1, argumentsHash: checkpoint.argumentsHash } };
  };
  const first = claim("first");
  const denied = f.engine.advance({ ...first.envelope, idempotencyKey: "denied", submission: { ...first.failure, code: "AUTH_REQUIRED" } });
  assert.equal(denied.state, "BLOCKED");
  assert.equal(f.engine.status(f.runId).hostResultReceived, false);
  f.engine.resume(f.runId);
  for (let index = 0; index < 100 && f.engine.status(f.runId).state !== "WAITING_AGENT"; index++)
    await new Promise(r => setTimeout(r, 2));
  const second = claim("second");
  assert.notEqual(second.envelope.checkpointId, first.envelope.checkpointId);
  f.engine.advance({ ...second.envelope, idempotencyKey: "unknown", submission: { ...second.failure, code: "OUTCOME_UNKNOWN" } });
  assert.equal(f.engine.status(f.runId).state, "OUTCOME_UNKNOWN");
  assert.throws(() => f.engine.resume(f.runId), { code: "STATE_INVALID" });
});
