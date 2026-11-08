import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { Application } from "../../packages/application/src/index.js";
import { registerAdmin } from "../../packages/admin-api/src/index.js";
import { hash, type Json } from "../../packages/contracts/src/domain.js";
import { TOOL_NAMES } from "../../packages/contracts/src/index.js";
import type { ProviderFactory } from "../../packages/llm-providers/src/index.js";

function fixture(t: any, providerFactory?:ProviderFactory) {
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo),
    engine=new Engine(repo,vault,new Connectors(repo,vault)),app=new Application(engine,providerFactory?{providerFactory}:{});
  const create=(workflowId="delete-demo")=>app.authoring.create({workflowId,name:"可删除合成流程",environment:"test",mode:"auto",template:"blank",idempotencyKey:"create-"+workflowId});
  const deletion=(workflowId="delete-demo",key=crypto.randomUUID())=>{
    const w=repo.get("workflows",workflowId);
    return {workflowId,expectedRevision:w.revision,expectedLayoutRevision:w.layoutRevision??1,idempotencyKey:key};
  };
  t.after(async()=>{await app.close();await engine.close();db.close();});
  return {db,repo,vault,engine,app,create,deletion};
}

test("workflow deletion keeps snapshots, completed runs and readable reports; all new execution and authoring stay blocked",async t=>{
  const f=fixture(t);f.create();f.create("retained-other");
  f.app.authoring.publish({workflowId:"delete-demo",expectedRevision:1,version:"1.0.0",expectedBindingRevisions:{},expectedCapabilityRevisions:{},idempotencyKey:"publish"});
  const start={workflowId:"delete-demo",version:"1.0.0",mode:"auto",inputs:{},idempotencyKey:"original-start"};
  const {runId}=f.engine.start(start);
  for(let i=0;i<100 && f.repo.get("runs",runId).state!=="SUCCEEDED";i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(f.engine.status(runId).state,"SUCCEEDED");
  const content="合成历史报告：保留原值 token=password@example.test";
  f.repo.insert("artifacts","retained-report",{id:"retained-report",runId,nodeId:"end",content,mimeType:"text/plain",sha256:hash(content),byteLength:Buffer.byteLength(content),expiresAt:Date.now()+60000});
  const history=hash([f.repo.all("versions"),f.repo.all("runs"),f.repo.all("artifacts"),f.repo.events(runId)]),
    request=f.deletion();
  assert.equal(f.engine.search({query:"delete-demo"}).items.some((w:Json)=>w.workflowId==="delete-demo"),true);
  const result=f.app.authoring.delete(request);
  assert.equal(result.historyPreserved,true);
  assert.deepEqual(f.app.authoring.delete(request),result);
  assert.equal(f.repo.changes().filter(e=>e.type==="workflow.deleted").length,1);
  assert.equal(hash([f.repo.all("versions"),f.repo.all("runs"),f.repo.all("artifacts"),f.repo.events(runId)]),history);
  assert.equal(f.engine.status(runId).state,"SUCCEEDED");
  assert.match(JSON.stringify(f.engine.handle("artifact_read",{runId,artifactId:"retained-report"})),/合成历史报告/);
  assert.equal(f.engine.search({query:"delete-demo"}).items.some((w:Json)=>w.workflowId==="delete-demo"),false);
  assert.throws(()=>f.engine.start({...start,idempotencyKey:"new-start"}),{code:"WORKFLOW_NOT_AVAILABLE"});
  assert.throws(()=>f.engine.handle("workflow_get",{workflowId:"delete-demo",version:"1.0.0"}),{code:"WORKFLOW_NOT_AVAILABLE"});
  assert.throws(()=>f.app.authoring.get("delete-demo"),{code:"NOT_FOUND"});
  assert.throws(()=>f.app.authoring.saveRaw(f.repo.get("workflows","delete-demo").draft,result.revision,{},1),{code:"NOT_FOUND"});
  assert.throws(()=>f.engine.saveDraft(f.repo.get("workflows","delete-demo").draft,result.revision,{}),{code:"WORKFLOW_NOT_AVAILABLE"});
  assert.throws(()=>f.engine.publish("delete-demo"),{code:"NOT_FOUND"});
  assert.throws(()=>f.app.authoring.patch({workflowId:"delete-demo",expectedRevision:result.revision,idempotencyKey:"late-patch",operations:[{op:"set_metadata",changes:{name:"revive"}}]}),{code:"NOT_FOUND"});
  assert.equal(f.app.authoring.get("retained-other").draft.name,"可删除合成流程");
  assert.equal(TOOL_NAMES.length,21);
});

test("deletion checks both revisions, administrator identity and exact idempotent replay without partial changes",async t=>{
  const f=fixture(t);f.create();const old=f.deletion();
  f.app.authoring.patch({workflowId:"delete-demo",expectedRevision:1,idempotencyKey:"move",operations:[{op:"move_nodes",expectedLayoutRevision:1,positions:[{nodeId:"input",x:40,y:55}]}]});
  const before=f.repo.get("workflows","delete-demo"),events=f.repo.changes().length;
  assert.throws(()=>f.app.authoring.delete(old),{code:"REVISION_CONFLICT"});
  assert.throws(()=>f.app.authoring.delete(f.deletion(),"execution"),{code:"AUTH_REQUIRED"});
  assert.throws(()=>f.app.authoring.delete(f.deletion(),"restricted-author"),{code:"AUTH_REQUIRED"});
  assert.throws(()=>f.app.authoring.delete({...f.deletion(),expectedLayoutRevision:undefined}),{code:"INPUT_INVALID"});
  assert.deepEqual(f.repo.get("workflows","delete-demo"),before);assert.equal(f.repo.changes().length,events);
  f.app.authoring.patch({workflowId:"delete-demo",expectedRevision:1,idempotencyKey:"rename",operations:[{op:"set_metadata",changes:{name:"新名称"}}]});
  assert.throws(()=>f.app.authoring.delete({...f.deletion(),expectedRevision:1}),{code:"REVISION_CONFLICT"});
  const request=f.deletion(),result=f.app.authoring.delete(request);
  assert.deepEqual(f.app.authoring.delete(request),result);
  assert.throws(()=>f.app.authoring.delete({...request,expectedRevision:result.revision}),{code:"IDEMPOTENCY_CONFLICT"});
  assert.throws(()=>f.app.authoring.delete(f.deletion()),{code:"NOT_FOUND"});
});

test("active runs, isolated selftests and selected or dispatched assistant work prevent deletion atomically",async t=>{
  const f=fixture(t);f.create();
  const cases:[any,string,Json][]=[
    ...["QUEUED","RUNNING","WAITING_AGENT","BLOCKED","CANCEL_REQUESTED","UNRECOGNIZED"].map(state=>["runs","active",{workflowId:"delete-demo",state}] as [any,string,Json]),
    ...["QUEUED","RUNNING","UNRECOGNIZED",null,undefined].map(status=>["workflow_test_runs","active",{workflowId:"delete-demo",status}] as [any,string,Json]),
    ["assistant_tasks","active",{status:"GENERATING",context:{workflowId:"delete-demo"}}],
    ["assistant_tasks","active",{status:"CALLING_TOOL",contextRefs:{workflowId:"delete-demo"}}],
    ["assistant_tasks","active",{status:"UNRECOGNIZED",context:{workflowId:"delete-demo"}}],
    ["assistant_tasks","active",{context:{workflowId:"delete-demo"}}],
  ];
  for(const [table,id,value] of cases){
    f.repo.put(table,id,{...value,id});const before=f.repo.get("workflows","delete-demo"),events=f.repo.changes().length;
    assert.throws(()=>f.app.authoring.delete(f.deletion()),{code:"WORKFLOW_IN_USE"});
    assert.deepEqual(f.repo.get("workflows","delete-demo"),before);assert.equal(f.repo.changes().length,events);f.repo.remove(table,id);
  }
  f.repo.put("assistant_tasks","dispatched",{id:"dispatched",status:"CALLING_TOOL",context:{}});
  f.repo.put("assistant_tool_calls","call",{id:"call",taskId:"dispatched",arguments:{workflowId:"delete-demo"}});
  assert.throws(()=>f.app.authoring.delete(f.deletion()),{code:"WORKFLOW_IN_USE"});
  f.repo.put("assistant_tasks","dispatched",{id:"dispatched",status:"COMPLETED",context:{}});
  assert.equal(f.app.authoring.delete(f.deletion()).historyPreserved,true);
});

test("incident templates never disclose another owner's modified or deleted draft and remain available without seeded workflows",async t=>{
  const f=fixture(t),marker="PRIVATE_SYNTHETIC_EXISTING_FLOW_INSTRUCTIONS";
  f.repo.put("clients","restricted",{id:"restricted",revision:1,scopes:["workflow:execute","workflow:author"],workflowAllowlist:[],revoked:false});
  const create=(workflowId:string)=>f.app.authoring.create({workflowId,name:"合成排查新流程",environment:"test",mode:"guided",template:"incident",idempotencyKey:"template-"+workflowId},"restricted");
  create("without-seed");assert.equal(f.repo.get("workflows","incident-staging"),undefined);
  await f.engine.seed();
  const source=f.app.authoring.get("incident-staging"),node=source.draft.nodes.find((n:Json)=>n.type==="agent_task");
  f.app.authoring.patch({workflowId:source.id,expectedRevision:source.revision,idempotencyKey:"private-source-edit",operations:[
    {op:"update_node",nodeId:node.id,changes:{config:{...node.config,instructions:marker}}},
  ]});
  assert.throws(()=>f.app.authoring.get(source.id,"restricted"),{code:"AUTH_REQUIRED"});
  for(const state of ["modified","deleted"]) {
    if(state==="deleted")f.app.authoring.delete(f.deletion(source.id));
    const workflowId="isolated-"+state;create(workflowId);
    const own=f.app.authoring.get(workflowId,"restricted");
    assert.equal(JSON.stringify(own.draft).includes(marker),false);
    assert.deepEqual(own.draft.bindings,{});assert.equal(own.draft.environment,"test");
    assert.ok(own.draft.nodes.some((n:Json)=>n.type==="agent_task"));
    assert.ok(own.draft.nodes.filter((n:Json)=>n.type==="mcp_tool").every((n:Json)=>n.config.toolName==="unconfigured"&&n.config.toolSchemaHash==="placeholder:unconfigured"));
    assert.throws(()=>f.app.authoring.get(source.id,"restricted"),{code:"AUTH_REQUIRED"});
  }
  assert.deepEqual(f.repo.get("clients","restricted").workflowAllowlist,["without-seed","isolated-modified","isolated-deleted"]);
  assert.ok(JSON.stringify(f.repo.get("workflows",source.id).draft).includes(marker));
});

test("auto-generated and inherited assistant workflow IDs block deletion through real pending model turns",async t=>{
  let firstRelease!:()=>void,secondRelease!:()=>void,turns=0;
  const firstGate=new Promise<void>(resolve=>{firstRelease=resolve;}),secondGate=new Promise<void>(resolve=>{secondRelease=resolve;});
  const f=fixture(t,()=>({complete:async()=>{
    const turn=++turns;
    if(turn===1)return {text:"",calls:[{id:"auto-create",name:"workflow_draft_create",arguments:JSON.stringify({name:"合成自动编号流程",environment:"test",mode:"auto",template:"blank",idempotencyKey:"model-create"})}],usage:null};
    await (turn===2?firstGate:secondGate);return {text:"合成回复已完成。",calls:[],usage:null};
  }}));
  f.vault.initialize("Synthetic-pending-creation-password");
  const profile=f.app.assistant.saveProfile({name:"Synthetic",providerKind:"openai_compatible_chat",baseUrl:"https://synthetic.invalid/v1",model:"synthetic"}),session=f.app.assistant.session();
  try {
    const created=f.app.assistant.submit(session.id,{text:"现在创建一个新的工作流草稿",mode:"compose",context:{},modelProfileId:profile.id,requestedActions:["edit_draft"],idempotencyKey:"create-turn"});
    for(let i=0;i<200&&turns<2;i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(turns,2);const task=f.repo.get("assistant_tasks",created.taskId),workflowId=task.createdWorkflowIds[0];
    assert.equal(task.status,"GENERATING");assert.deepEqual(task.context,{});
    assert.throws(()=>f.app.authoring.delete(f.deletion(workflowId)),{code:"WORKFLOW_IN_USE"});
    firstRelease();await f.app.assistant.settled();
    const continuation=f.app.assistant.submit(session.id,{text:"继续解释这个流程",mode:"help",context:{},modelProfileId:profile.id,requestedActions:[],idempotencyKey:"inherited-turn"});
    for(let i=0;i<200&&turns<3;i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(turns,3);assert.ok(f.repo.get("assistant_tasks",continuation.taskId).inheritedWorkflowIds.includes(workflowId));
    assert.throws(()=>f.app.authoring.delete(f.deletion(workflowId)),{code:"WORKFLOW_IN_USE"});
    f.app.assistant.cancel(continuation.taskId);secondRelease();await f.app.assistant.settled();
    assert.equal(f.app.authoring.delete(f.deletion(workflowId)).historyPreserved,true);
  } finally {firstRelease();secondRelease();await f.app.assistant.settled();}
});

test("legacy task, receipt and selftest metadata preserve activity references without decoding historical payloads",async t=>{
  const f=fixture(t);f.create();
  f.repo.insert("workflow_test_suites","legacy-suite",{id:"legacy-suite",workflowId:"delete-demo"});
  f.repo.insert("runs","past-run",{id:"past-run",workflowId:"delete-demo",state:"SUCCEEDED"});
  const activeTests=[{acceptedSuite:{workflowId:"delete-demo"},status:"RUNNING"},{suiteId:"legacy-suite",status:"RUNNING"}];
  for(const record of activeTests){f.repo.put("workflow_test_runs","legacy-test",{id:"legacy-test",...record});assert.throws(()=>f.app.authoring.delete(f.deletion()),{code:"WORKFLOW_IN_USE"});f.repo.remove("workflow_test_runs","legacy-test");}
  f.repo.put("workflow_test_runs","past-test",{id:"past-test",suiteId:"legacy-suite",status:"SUCCEEDED",acceptedSuite:{workflowId:"delete-demo"}});
  const contexts=[{context:{runId:"past-run"}},{contextRefs:{runId:"past-run"}}];
  for(const context of contexts){f.repo.put("assistant_tasks","legacy-task",{id:"legacy-task",status:"GENERATING",...context});assert.throws(()=>f.app.authoring.delete(f.deletion()),{code:"WORKFLOW_IN_USE"});f.repo.remove("assistant_tasks","legacy-task");}
  f.repo.put("assistant_tasks","receipt-task",{id:"receipt-task",status:"GENERATING",context:{}});
  for(const receipt of [{result:{workflowId:"delete-demo"}},{arguments:{runId:"past-run"}},{result:{runId:"past-run"}},{arguments:{suiteId:"legacy-suite"}},{arguments:{testRunId:"past-test"}},{result:{testRunId:"past-test"}}]){
    f.repo.put("assistant_tool_calls","receipt",{id:"receipt",taskId:"receipt-task",status:"COMPLETED",...receipt});
    assert.throws(()=>f.app.authoring.delete(f.deletion()),{code:"WORKFLOW_IN_USE"});f.repo.remove("assistant_tool_calls","receipt");
  }
  f.repo.put("assistant_tasks","receipt-task",{id:"receipt-task",status:"COMPLETED"});
  f.repo.put("assistant_tasks","unrelated-active",{id:"unrelated-active",status:"GENERATING",context:{workflowId:"another-workflow"}});
  const readAll=f.repo.all.bind(f.repo);
  f.repo.all=(table)=>{assert.ok(!["runs","workflow_test_runs","assistant_tasks","assistant_tool_calls","bindings","connections"].includes(table),"Deletion must not load full history or validate the graph");return readAll(table);};
  assert.equal(f.app.authoring.delete(f.deletion()).historyPreserved,true);
});

test("deleted built-in samples stay deleted when seed recovery runs again",async t=>{
  const f=fixture(t);await f.engine.seed();
  const request=f.deletion("incident-staging"),versions=hash(f.repo.all("versions"));
  f.app.authoring.delete(request);const record=f.repo.get("workflows","incident-staging");
  f.repo.remove("settings","seeded");await f.engine.seed();
  assert.deepEqual(f.repo.get("workflows","incident-staging"),record);
  assert.equal(hash(f.repo.all("versions")),versions);
});

test("a real Mock run awaiting its host prevents deletion until cancellation finishes",async t=>{
  const f=fixture(t);f.vault.initialize("Synthetic-workflow-cancellation-password");await f.engine.seed();
  const workflow=f.repo.get("versions","incident-staging@1.0.0").snapshot.workflow;
  const {runId}=f.engine.start({workflowId:workflow.workflowId,version:workflow.version,mode:workflow.mode,
    inputs:workflow.inputSchema.examples[0],idempotencyKey:"actual-waiting-run"});
  for(let i=0;i<200 && f.engine.status(runId).state!=="WAITING_AGENT";i++)await new Promise(r=>setTimeout(r,10));
  const waiting=f.engine.status(runId);assert.equal(waiting.state,"WAITING_AGENT");
  assert.throws(()=>f.app.authoring.delete(f.deletion(workflow.workflowId)),{code:"WORKFLOW_IN_USE"});
  f.engine.cancel({runId,expectedRevision:waiting.revision,idempotencyKey:"cancel-before-deletion"});
  for(let i=0;i<100 && f.engine.status(runId).state!=="CANCELLED";i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(f.engine.status(runId).state,"CANCELLED");
  f.app.authoring.delete(f.deletion(workflow.workflowId));
  assert.equal(f.engine.status(runId).state,"CANCELLED");
});

test("administrator DELETE enforces authentication, CSRF, revision contracts and tombstones across legacy and v2 routes",async t=>{
  const f=fixture(t);f.create();
  const root=await mkdtemp(join(tmpdir(),"flowhub-delete-http-")),http=Fastify();
  t.after(async()=>{await http.close();await rm(root,{recursive:true,force:true});});
  const {auth}=await registerAdmin(http,f.engine,root,f.app.authoring,f.app.registry,f.app);
  auth.setup("Synthetic-workflow-delete-password");const session=auth.session();
  const request=f.deletion(),{workflowId,...payload}=request,url="/api/v2/workflows/"+workflowId,
    headers={cookie:"flowhub_session="+session.token,"x-csrf-token":session.csrf,"if-match":"1"};
  assert.equal((await http.inject({method:"DELETE",url,payload})).statusCode,401);
  assert.equal((await http.inject({method:"DELETE",url,payload,headers:{cookie:headers.cookie}})).statusCode,403);
  assert.equal((await http.inject({method:"DELETE",url,payload,headers:{cookie:headers.cookie,"x-csrf-token":session.csrf}})).statusCode,428);
  assert.equal((await http.inject({method:"DELETE",url,payload,headers:{...headers,"if-match":"1.0"}})).statusCode,428);
  assert.equal((await http.inject({method:"DELETE",url,payload:{...payload,expectedLayoutRevision:undefined},headers})).statusCode,422);
  assert.equal((await http.inject({method:"DELETE",url,payload:{...payload,extra:true},headers})).statusCode,422);
  assert.equal((await http.inject({method:"DELETE",url,payload:{...payload,workflowId:"another"},headers})).statusCode,422);
  const deleted=await http.inject({method:"DELETE",url,payload,headers});assert.equal(deleted.statusCode,200,deleted.body);
  assert.equal((await http.inject({method:"DELETE",url,payload,headers})).statusCode,200);
  const list=await http.inject({method:"GET",url:"/api/v1/workflows",headers});assert.deepEqual(list.json().data,[]);
  for(const path of ["/api/v1/workflows/delete-demo/draft","/api/v2/workflows/delete-demo/draft"])
    assert.equal((await http.inject({method:"GET",url:path,headers})).statusCode,404);
  for(const [path,body] of [["disable",{disabled:false}],["select-version",{version:"1.0.0"}]] as [string,Json][])
    assert.equal((await http.inject({method:"POST",url:"/api/v1/workflows/delete-demo/"+path,payload:body,headers})).statusCode,404);
  assert.equal((await http.inject({method:"POST",url:"/api/v1/workflows",payload:{workflow:f.repo.get("workflows","delete-demo").draft},headers})).statusCode,404);
  assert.equal(f.repo.get("workflows","delete-demo").enabled,false);
});
