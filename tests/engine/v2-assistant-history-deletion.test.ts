import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { Application } from "../../packages/application/src/index.js";
import { ScriptedModelProvider, type ModelTurn } from "../../packages/llm-providers/src/index.js";
import { hash, type Json } from "../../packages/contracts/src/domain.js";

const done: ModelTurn={text:"合成历史运行解释。",calls:[],usage:null};
async function fixture(t: TestContext, owner="execution") {
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo);
  vault.initialize("Synthetic-history-deletion-password");
  const engine=new Engine(repo,vault,new Connectors(repo,vault)),provider=new ScriptedModelProvider([]),
    app=new Application(engine,{providerFactory:()=>provider});
  t.after(async()=>{await app.close();await engine.close();db.close();});
  const workflowId="historical-run";
  for(const id of ["owner-a","owner-b"])repo.put("clients",id,{id,revoked:false,revision:1,scopes:["workflow:execute","workflow:author"],workflowAllowlist:[workflowId]});
  app.authoring.create({workflowId,name:"运行时发布名称",environment:"test",mode:"auto",template:"blank",idempotencyKey:"create"});
  app.authoring.publish({workflowId,expectedRevision:1,version:"1.0.0",expectedBindingRevisions:{},expectedCapabilityRevisions:{},idempotencyKey:"publish"});
  const {runId}=engine.start({workflowId,version:"1.0.0",mode:"auto",inputs:{},idempotencyKey:"start"},owner);
  for(let i=0;i<200 && engine.status(runId,owner).state!=="SUCCEEDED";i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(engine.status(runId,owner).state,"SUCCEEDED");
  const profile=app.assistant.saveProfile({name:"合成历史问答",providerKind:"openai_compatible_chat",baseUrl:"https://example.invalid/v1",model:"synthetic"}),
    session=app.assistant.session(owner);
  const send=async(context:Json,turn:ModelTurn=done)=>{
    provider.script.push(turn);
    const accepted=app.assistant.submit(session.id,{text:"解释所选运行",mode:"help",modelProfileId:profile.id,context,requestedActions:[],idempotencyKey:crypto.randomUUID()},owner);
    await app.assistant.settled();return app.assistant.task(accepted.taskId,owner);
  };
  const remove=()=>{
    const before=repo.get("workflows",workflowId);
    return app.authoring.delete({workflowId,expectedRevision:before.revision,expectedLayoutRevision:before.layoutRevision,idempotencyKey:"delete"});
  };
  return {db,repo,vault,engine,app,provider,profile,session,send,remove,workflowId,runId,owner};
}
function selectedContext(request:Json) {
  const message=request.messages.find((m:Json)=>typeof m.content==="string"&&m.content.startsWith("Selected context (data): "));
  return JSON.parse(message.content.slice("Selected context (data): ".length));
}

test("deleted workflow history remains explainable with the run-page context and with runId alone",async t=>{
  const f=await fixture(t);f.remove();
  const snapshot=structuredClone(f.repo.get("runs",f.runId).snapshot.workflow),before=hash([f.repo.get("workflows",f.workflowId),f.repo.get("runs",f.runId)]);
  for(const context of [{workflowId:f.workflowId,runId:f.runId},{runId:f.runId}]){
    const task=await f.send(context);assert.equal(task.status,"COMPLETED");assert.equal(task.answer,done.text);
    assert.equal(task.tools.length,0);
    const modelContext=selectedContext(f.provider.requests.at(-1));
    assert.deepEqual(modelContext.workflow,{workflowId:f.workflowId,version:"1.0.0",source:"selected_run_snapshot",draft:snapshot});
    assert.equal(modelContext.run.runId,f.runId);assert.equal(modelContext.run.state,"SUCCEEDED");
  }
  assert.equal(f.provider.requests.length,2);
  assert.equal(hash([f.repo.get("workflows",f.workflowId),f.repo.get("runs",f.runId)]),before);
  assert.throws(()=>f.app.authoring.get(f.workflowId),{code:"NOT_FOUND"});
});

test("selected historical runs use the original snapshot rather than a later editable draft",async t=>{
  const f=await fixture(t),before=f.repo.get("workflows",f.workflowId);
  f.app.authoring.patch({workflowId:f.workflowId,expectedRevision:before.revision,idempotencyKey:"rename-live",operations:[{op:"set_metadata",changes:{name:"后来编辑的名称",description:"该值不能被当作历史运行定义"}}]});
  const current=f.repo.get("workflows",f.workflowId),snapshotHash=f.repo.get("runs",f.runId).snapshotHash;
  for(const context of [{workflowId:f.workflowId,runId:f.runId},{runId:f.runId}]){
    assert.equal((await f.send(context)).status,"COMPLETED");
    const modelContext=selectedContext(f.provider.requests.at(-1));
    assert.equal(modelContext.workflow.draft.name,"运行时发布名称");assert.equal(modelContext.workflow.source,"selected_run_snapshot");
    assert.notEqual(modelContext.workflow.draft.description,current.draft.description);
  }
  assert.deepEqual(f.repo.get("workflows",f.workflowId),current);
  assert.equal(f.repo.get("runs",f.runId).snapshotHash,snapshotHash);
});

test("history fallback still rejects another run owner, mismatched workflow and deleted draft-only context",async t=>{
  const f=await fixture(t,"owner-a");f.remove();
  const other=f.app.assistant.session("owner-b"),body={text:"解释所选运行",mode:"help",modelProfileId:f.profile.id,
    context:{workflowId:f.workflowId,runId:f.runId},requestedActions:[],idempotencyKey:"foreign"},tasks=f.repo.all("assistant_tasks").length;
  assert.throws(()=>f.app.assistant.submit(other.id,body,"owner-b"),{code:"WORKFLOW_NOT_AVAILABLE"});
  assert.throws(()=>f.app.assistant.submit(f.session.id,{...body,context:{workflowId:"mismatched",runId:f.runId},idempotencyKey:"mismatch"},"owner-a"),{code:"INTENT_NOT_ALLOWED"});
  assert.equal(f.repo.all("assistant_tasks").length,tasks);assert.equal(f.provider.requests.length,0);
  const task=await f.send({workflowId:f.workflowId});assert.equal(task.status,"FAILED");assert.equal(task.errorCode,"NOT_FOUND");
  assert.equal(f.provider.requests.length,0);
});

test("explaining deleted history does not grant authoring tools or allow the deleted workflow to be revived",async t=>{
  const f=await fixture(t);f.remove();
  const before=f.repo.get("workflows",f.workflowId),events=f.repo.changes().filter(e=>e.type==="draft.changed").length;
  const task=await f.send({workflowId:f.workflowId,runId:f.runId},{text:"",usage:null,calls:[{id:"forbidden-write",name:"workflow_draft_patch",arguments:JSON.stringify({workflowId:f.workflowId,expectedRevision:before.revision,idempotencyKey:"revive",operations:[{op:"set_metadata",changes:{name:"must-not-save"}}]})}]});
  assert.equal(task.status,"FAILED");assert.equal(task.errorCode,"INTENT_NOT_ALLOWED");assert.equal(task.tools.length,0);
  assert.deepEqual(f.repo.get("workflows",f.workflowId),before);
  assert.equal(f.repo.changes().filter(e=>e.type==="draft.changed").length,events);
  assert.throws(()=>f.engine.start({workflowId:f.workflowId,version:"1.0.0",mode:"auto",inputs:{},idempotencyKey:"new-start"}),{code:"WORKFLOW_NOT_AVAILABLE"});
});
