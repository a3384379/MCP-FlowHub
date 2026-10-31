import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { Application } from "../../packages/application/src/index.js";
import { ScriptedModelProvider, type ModelTurn } from "../../packages/llm-providers/src/index.js";
import { requestedActions, affirmativeVerbs } from "../../packages/contracts/src/assistant-intent.js";
import { CONTEXT_BYTE_LIMIT } from "../../packages/assistant-core/src/context-budget.js";
import { hash, HubError, type Json } from "../../packages/contracts/src/domain.js";

const done: ModelTurn = { text: "已处理合成数据。", calls: [], usage: null };
const call = (name: string, args: Json, id = crypto.randomUUID()): ModelTurn => ({
  text: "", calls: [{ name, id, arguments: JSON.stringify(args) }], usage: null,
});
async function fixture(t: TestContext) {
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo);
  vault.initialize("Synthetic-max-assistant-password");
  const engine=new Engine(repo,vault,new Connectors(repo,vault)),provider=new ScriptedModelProvider([]);
  const app=new Application(engine,{providerFactory:()=>provider});
  t.after(async()=>{await app.close();await engine.close();db.close();});
  const profile=app.assistant.saveProfile({name:"合成测试",providerKind:"openai_compatible_chat",baseUrl:"https://example.invalid/v1",model:"synthetic"});
  const session=app.assistant.session();
  const body=(text:string,context:Json={},extra:Json={})=>({text,context,modelProfileId:profile.id,mode:requestedActions(text).length?"compose":"help",requestedActions:requestedActions(text),idempotencyKey:crypto.randomUUID(),...extra});
  const send=async(text:string,context:Json={},extra:Json={})=>{
    const accepted=app.assistant.submit(session.id,body(text,context,extra));await app.assistant.settled();return app.assistant.task(accepted.taskId);
  };
  return {app,engine,repo,vault,provider,profile,session,body,send};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function workflow(f: Fixture, workflowId: string, guided = false) {
  f.app.authoring.create({workflowId,name:"合成流程",environment:"test",mode:guided?"guided":"auto",template:"blank",idempotencyKey:workflowId+":create"});
  let revision=1;
  if(guided)revision=f.app.authoring.patch({workflowId,expectedRevision:1,idempotencyKey:workflowId+":patch",operations:[
    {op:"add_node",nodeId:"analysis",nodeType:"agent_task",title:"选中的分析节点",config:{kind:"analysis",executorRef:"assistant_local",instructions:"只处理合成输入",inputMappings:{"/token":{value:"business-token@example.invalid"}},outputSchema:{type:"object",properties:{answer:{type:"string"}},required:["answer"],additionalProperties:false}}},
    {op:"disconnect",source:"input",target:"end",port:"next"},{op:"connect",source:"input",target:"analysis",port:"next"},{op:"connect",source:"analysis",target:"end",port:"next"},
  ]}).revision;
  f.app.authoring.publish({workflowId,expectedRevision:revision,version:"1.0.0",expectedBindingRevisions:{},expectedCapabilityRevisions:{},idempotencyKey:workflowId+":publish"});
  return revision;
}
async function waiting(f:Fixture,workflowId:string) {
  workflow(f,workflowId,true);
  const accepted=f.engine.start({workflowId,version:"1.0.0",mode:"guided",inputs:{},idempotencyKey:workflowId+":start"});
  for(let i=0;i<200;i++){const status=f.engine.status(accepted.runId);if(status.state==="WAITING_AGENT")return status;await new Promise(r=>setTimeout(r,5));}
  assert.fail("The synthetic run did not reach its checkpoint.");
}
function context(request:Json) {
  const value=request.messages.find((message:Json)=>typeof message.content==="string"&&message.content.startsWith("Selected context (data): "));
  return {text:value.content.slice("Selected context (data): ".length),data:JSON.parse(value.content.slice("Selected context (data): ".length))};
}
const informational=[
  "运行当前流程需要满足哪些条件","运行当前流程需要什么","运行当前流程要多久",
  "创建当前流程的条件","发布当前流程所需条件","讲讲运行当前流程","说说扫描工具目录",
  "取消当前运行会产生什么影响","导入工具需要几个步骤","测试当前流程需要几次调用",
  "运行当前流程有何风险","运行当前流程为何需要权限","运行当前流程何时完成",
  "运行当前流程哪一步耗时","运行当前流程需要啥权限","运行当前流程咋配置",
  "运行当前流程需要多大权限","运行当前流程需要多高权限","运行当前流程需要管理员权限",
  "运行当前流程需要前置条件","运行当前流程的前置条件","运行当前流程需要配置环境",
  "运行当前流程需要先确认",
  "例子‘运行当前流程’","示例‘发布当前流程’","示例‘扫描当前MCP’","示例『导入工具』",
];
test("max intent: information questions without question marks and Chinese single-quoted examples grant no actions",()=>{
  for(const text of informational)assert.deepEqual(requestedActions(text),[],text);
  for(const text of ["运行当前流程","帮我启动当前流程","执行当前流程","run this workflow"])assert.deepEqual(requestedActions(text),["run"],text);
  assert.deepEqual(requestedActions("创建一个带有条件的流程并保存"),["edit_draft"]);
  assert.deepEqual(requestedActions("创建、测试、发布并运行"),["edit_draft","test","publish","run"]);
  assert.deepEqual(affirmativeVerbs("运行当前流程，但不要取消当前运行"),["start_run"]);
  assert.deepEqual(affirmativeVerbs("取消当前运行，但不要启动当前流程"),["cancel_run"]);
  assert.deepEqual(affirmativeVerbs("扫描并导入当前工具，都不要"),[]);
  assert.deepEqual(affirmativeVerbs("cancel current run"),["cancel_run"]);
  assert.deepEqual(affirmativeVerbs("同步工具目录"),["scan"]);
  for(const text of ["请运行当前流程，然后告诉我需要多久","请运行当前流程，然后告诉我是否成功","请运行当前流程然后告诉我运行当前流程需要多久"])assert.deepEqual(requestedActions(text),["run"],text);
  assert.deepEqual(requestedActions("请创建并保存草稿，之后告诉我有什么变化"),["edit_draft"]);
  assert.deepEqual(requestedActions("运行当前流程，是否可行"),[]);
});
const futureOnly=[
  "请先不要运行当前流程，等我确认后再运行当前流程",
  "等我确认后再运行当前流程","等我确认后，再运行当前流程",
  "先不要运行当前流程。等我确认。然后再运行当前流程",
  "如果我确认了，再运行当前流程","只有得到我的确认才能运行当前流程",
  "待权限配置完成后运行当前流程","验证通过后再运行当前流程",
  "等权限开通，再运行当前流程","当我确认时，再运行当前流程",
  "在我确认之前不要运行当前流程，之后再运行当前流程",
  "等管理员确认后，再运行当前流程","待所有检查完成，再运行当前流程",
  "若条件满足，再运行当前流程","等一下再运行当前流程",
  "run the current workflow after I confirm","when I confirm, run the current workflow",
  "after the checks pass, run the current workflow","only after I confirm, run the current workflow",
  "do not run the current workflow until I confirm","wait for confirmation, then run the current workflow",
  "if the checks pass, run the current workflow","once I confirm, run the current workflow",
  "do not run the current workflow; run the current workflow after I confirm",
  "run the current workflow once permission is granted","await my confirmation, then run the current workflow",
];
test("max intent: unmet future conditions never grant present execution; independent draft creation and current commands remain allowed",()=>{
  for(const text of futureOnly)assert.deepEqual(requestedActions(text),[],text);
  for(const text of ["先创建草稿，等我确认后再运行当前流程","先创建草稿等我确认后再运行当前流程","先创建草稿，等权限开通，再运行当前流程"])assert.deepEqual(requestedActions(text),["edit_draft"],text);
  for(const text of ["现在运行当前流程","请现在运行当前流程","请运行当前流程，然后告诉我需要多久","请运行当前流程，然后告诉我是否成功"])assert.deepEqual(requestedActions(text),["run"],text);
  for(const text of ["Run the current workflow now","Now run the current workflow","Please run the current workflow and tell me the result","Please run the current workflow now and tell me whether it succeeded","run the current workflow once"])assert.deepEqual(requestedActions(text),["run"],text);
  for(const text of ["Create a draft now, then run the workflow after I confirm","create a draft now and run the workflow after I confirm"])assert.deepEqual(requestedActions(text),["edit_draft"],text);
  assert.deepEqual(requestedActions("add a report node after input"),["edit_draft"]);
  assert.deepEqual(requestedActions("创建一个需要管理员权限的流程并保存"),["edit_draft"]);
});
test("max intent: hostile model proposals for information questions never dispatch or create actual runs",async t=>{
  const f=await fixture(t);workflow(f,"selected");
  for(const text of informational) {
    f.provider.script.push(call("workflow_start",{workflowId:"selected",version:"1.0.0",mode:"auto",inputs:{},idempotencyKey:crypto.randomUUID()}));
    const task=await f.send(text,{workflowId:"selected"});
    assert.equal(task.errorCode,"INTENT_NOT_ALLOWED",text);assert.equal(task.tools.length,0,text);
    assert.ok(!f.provider.requests.at(-1)!.tools.some(tool=>tool.name==="workflow_start"),text);
    assert.equal(f.repo.all("runs").length,0,text);
    assert.throws(()=>f.app.assistant.submit(f.session.id,f.body(text,{workflowId:"selected"},{requestedActions:["run"],mode:"compose"})),{code:"INTENT_NOT_ALLOWED"},text);
  }
});
test("max intent: provider-proposed starts after future conditions create zero real runs and a requested draft can still be saved",async t=>{
  const f=await fixture(t);workflow(f,"selected");
  for(const text of [...futureOnly,"先创建草稿，等我确认后再运行当前流程","Create a draft now, then run the workflow after I confirm","create a draft now and run the workflow after I confirm"]) {
    f.provider.script.push(call("workflow_start",{workflowId:"selected",version:"1.0.0",mode:"auto",inputs:{},idempotencyKey:crypto.randomUUID()}));
    const task=await f.send(text,{workflowId:"selected"});
    assert.equal(task.errorCode,"INTENT_NOT_ALLOWED",text);assert.equal(task.tools.length,0,text);
    assert.ok(!f.provider.requests.at(-1)!.tools.some(tool=>tool.name==="workflow_start"),text);
    assert.equal(f.repo.all("runs").length,0,text);
  }
  f.provider.script.push(call("workflow_draft_create",{workflowId:"before-condition",name:"明确的当前草稿",environment:"test",mode:"auto",template:"blank",idempotencyKey:"before-condition"}),done);
  const draft=await f.send("先创建草稿，等我确认后再运行");
  assert.equal(draft.status,"COMPLETED");assert.equal(f.repo.get("workflows","before-condition").draft.name,"明确的当前草稿");assert.equal(f.repo.all("runs").length,0);
  f.provider.script.push(call("workflow_draft_create",{workflowId:"english-before-condition",name:"Explicit current draft",environment:"test",mode:"auto",template:"blank",idempotencyKey:"english-before-condition"}),done);
  const englishDraft=await f.send("Create a draft now, then run the workflow after I confirm");
  assert.equal(englishDraft.status,"COMPLETED");assert.equal(f.repo.get("workflows","english-before-condition").draft.name,"Explicit current draft");assert.equal(f.repo.all("runs").length,0);
  for(const text of ["现在运行当前流程","请运行当前流程，然后告诉我需要多久","请运行当前流程，然后告诉我是否成功","Run the current workflow now","Now run the current workflow","Please run the current workflow and tell me the result","Please run the current workflow now and tell me whether it succeeded"]) {
    const before=f.repo.all("runs").length;
    f.provider.script.push(call("workflow_start",{workflowId:"selected",version:"1.0.0",mode:"auto",inputs:{},idempotencyKey:crypto.randomUUID()}),done);
    const task=await f.send(text,{workflowId:"selected"});
    assert.equal(task.status,"COMPLETED",text);assert.equal(f.repo.all("runs").length,before+1,text);
  }
});
test("max verbs: run and cancel are isolated in both directions and their allowed paths change real engine state",async t=>{
  const f=await fixture(t),run=await waiting(f,"selected");
  const initialRuns=f.repo.all("runs").length;
  f.provider.script.push(call("workflow_cancel",{runId:run.runId,expectedRevision:run.revision,reason:"wrong verb",idempotencyKey:"forbidden-cancel"}));
  let task=await f.send("运行当前流程",{runId:run.runId});
  assert.equal(task.errorCode,"INTENT_NOT_ALLOWED");assert.equal(task.tools.length,0);assert.equal(f.engine.status(run.runId).state,"WAITING_AGENT");
  assert.ok(f.provider.requests.at(-1)!.tools.some(tool=>tool.name==="workflow_start"));assert.ok(!f.provider.requests.at(-1)!.tools.some(tool=>tool.name==="workflow_cancel"));
  f.provider.script.push(call("workflow_start",{workflowId:"selected",version:"1.0.0",mode:"guided",inputs:{},idempotencyKey:"forbidden-start"}));
  task=await f.send("取消当前运行",{runId:run.runId});
  assert.equal(task.errorCode,"INTENT_NOT_ALLOWED");assert.equal(task.tools.length,0);assert.equal(f.repo.all("runs").length,initialRuns);
  assert.ok(f.provider.requests.at(-1)!.tools.some(tool=>tool.name==="workflow_cancel"));assert.ok(!f.provider.requests.at(-1)!.tools.some(tool=>["workflow_start","workflow_advance"].includes(tool.name)));
  f.provider.script.push(call("workflow_cancel",{runId:run.runId,expectedRevision:run.revision,reason:"explicit cancellation",idempotencyKey:"allowed-cancel"}),done);
  task=await f.send("取消当前运行",{runId:run.runId});
  assert.equal(task.status,"COMPLETED");assert.equal(f.engine.status(run.runId).state,"CANCELLED");
  f.provider.script.push(call("workflow_start",{workflowId:"selected",version:"1.0.0",mode:"guided",inputs:{},idempotencyKey:"allowed-start"}),done);
  task=await f.send("请运行当前流程，然后告诉我需要多久",{workflowId:"selected"});
  assert.equal(task.status,"COMPLETED");assert.equal(f.repo.all("runs").length,initialRuns+1);
});
async function catalog(f:Fixture,t:TestContext) {
  const root=await mkdtemp(join(tmpdir(),"flowhub-assistant-verbs-")),home=join(root,"home"),cwd=join(root,"project");
  await mkdir(home);await mkdir(cwd);
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(home,"config.toml"),'[mcp_servers.synthetic]\nurl = "https://synthetic.invalid/mcp"\n');
  const inputSchema={type:"object",properties:{},additionalProperties:false},tool={name:"synthetic_read",description:"合成工具",inputSchema,schemaHash:"sha256:"+hash({inputSchema,outputSchema:null})};
  let catalogCalls=0;
  f.engine.connectors.discover=async connection=>{catalogCalls++;return {...connection,tools:[tool]};};
  const host=await f.app.registry.context({codexHome:home,cwd,codexPath:null,discoveryMode:"config_only"});
  const scan=f.app.registry.scan({contextId:host.id,depth:"catalog",idempotencyKey:"seed-scan"});
  await f.app.registry.idle();
  assert.ok(["SUCCEEDED","PARTIAL"].includes(f.app.registry.status(scan.scanId).status));
  const capability=f.app.registry.search({contextId:host.id}).items[0];assert.ok(capability);
  return {host,capability,calls:()=>catalogCalls};
}
test("max verbs: scan and import are isolated in both directions, while each explicit action succeeds",async t=>{
  const f=await fixture(t),c=await catalog(f,t);
  const importArgs={capabilityId:c.capability.id,expectedSourceRevision:c.capability.revision,target:"hub_direct",environment:"test",lockedArguments:{},idempotencyKey:"import-from-scan"};
  for(const text of ["扫描当前MCP","同步工具目录"]) {
    const beforeCalls=c.calls();f.provider.script.push(call("capability_import",importArgs));
    const task=await f.send(text);
    assert.equal(task.errorCode,"INTENT_NOT_ALLOWED");assert.equal(task.tools.length,0);
    assert.equal(f.repo.all("connections").length,0);assert.equal(f.repo.all("bindings").length,0);assert.equal(c.calls(),beforeCalls);
    assert.ok(f.provider.requests.at(-1)!.tools.some(tool=>tool.name==="host_scan"));assert.ok(!f.provider.requests.at(-1)!.tools.some(tool=>tool.name==="capability_import"));
  }
  const scans=f.repo.all("discovery_jobs").length;
  f.provider.script.push(call("host_scan",{contextId:c.host.id,depth:"metadata",idempotencyKey:"scan-from-import"}));
  let task=await f.send("导入当前工具");
  assert.equal(task.errorCode,"INTENT_NOT_ALLOWED");assert.equal(f.repo.all("discovery_jobs").length,scans);
  assert.ok(!f.provider.requests.at(-1)!.tools.some(tool=>tool.name==="host_scan"));assert.ok(f.provider.requests.at(-1)!.tools.some(tool=>tool.name==="capability_import"));
  f.provider.script.push(call("host_scan",{contextId:c.host.id,depth:"metadata",idempotencyKey:"explicit-scan"}),done);
  task=await f.send("同步工具目录");await f.app.registry.idle();
  assert.equal(task.status,"COMPLETED");assert.equal(f.repo.all("discovery_jobs").length,scans+1);assert.equal(f.repo.all("connections").length,0);
  f.provider.script.push(call("capability_import",{...importArgs,idempotencyKey:"explicit-import"}),done);
  task=await f.send("导入当前工具");
  assert.equal(task.status,"COMPLETED");assert.equal(task.tools[0].isError,undefined);assert.equal(f.repo.all("connections").length,1);assert.equal(f.repo.all("bindings").length,1);
});
for(const count of [200,1000])test("max context: "+count+" multibyte tools cannot evict selected workflow, run, revision or node",async t=>{
  const f=await fixture(t),run=await waiting(f,"selected");
  for(let i=0;i<Math.ceil(count/50);i++)f.repo.put("connections","connection-"+i,{
    id:"connection-"+i,name:"合成连接-"+i,revision:1,verifiedRevision:1,
    tools:Array.from({length:Math.min(50,count-i*50)},(_,j)=>({name:"工具"+(i*50+j)+"中文能力".repeat(35)})),
  });
  for(let i=0;i<count;i++)f.repo.put("capabilities","capability-"+i,{id:"capability-"+i,name:"合成能力".repeat(24)+i,contextId:"synthetic",contextRevision:1,kind:"mcp_tool",executor:"hub_direct"});
  f.provider.script.push(call("workflow_draft_get",{workflowId:"selected"}),done);
  const revision=f.repo.get("workflows","selected").revision;
  const task=await f.send("解释选中的流程与运行",{workflowId:"selected",revision,runId:run.runId,selectedNodeIds:["analysis"]});
  assert.equal(task.status,"COMPLETED");
  const selected=context(f.provider.requests.at(-2)!),budget=selected.data.contextBudget;
  assert.ok(Buffer.byteLength(selected.text,"utf8")<=CONTEXT_BYTE_LIMIT);assert.equal(task.contextSummary.includedBytes,Buffer.byteLength(selected.text,"utf8"));
  assert.equal(selected.data.workflow.workflowId,"selected");assert.equal(selected.data.workflow.revision,revision);
  assert.ok(selected.data.workflow.draft.nodes.some((node:Json)=>node.id==="analysis"&&node.type==="agent_task"));
  assert.equal(selected.data.run.runId,run.runId);assert.equal(selected.data.run.revision,run.revision);assert.deepEqual(selected.data.selectedNodeIds,["analysis"]);
  assert.equal(budget.encoding,"UTF-8");assert.equal(budget.sections.projectState.truncated,true);
  assert.ok(budget.sections.projectState.totalBytes>budget.sections.projectState.includedBytes);
  assert.ok(budget.sections.projectState.includedBytes<=16000);assert.ok(budget.sections.knowledge.includedBytes<=8000);
  assert.match(budget.sections.projectState.retrieve,/capability_search/);
  assert.equal(task.tools[0].result.draft.nodes.find((node:Json)=>node.id==="analysis").config.inputMappings["/token"].value,"business-token@example.invalid");
  assert.match(context(f.provider.requests.at(-1)!).text,/business-token@example.invalid/);
});
test("max context: small selected data and directory retain complete values",async t=>{
  const f=await fixture(t);workflow(f,"small");
  f.repo.put("connections","one",{id:"one",name:"小目录",revision:1,verifiedRevision:1,tools:[{name:"完整工具"}]});
  f.provider.script.push(done);const task=await f.send("解释当前流程",{workflowId:"small",revision:1,selectedNodeIds:["input"]});
  const selected=context(f.provider.requests.at(-1)!);
  assert.equal(task.status,"COMPLETED");assert.equal(task.contextSummary.sections.workflow.truncated,false);assert.equal(task.contextSummary.sections.projectState.truncated,false);assert.equal(selected.data.workflow.draft.nodes.length,2);
  assert.deepEqual(selected.data.projectState.registeredConnections.items[0].cachedTools,["完整工具"]);
});
test("max context: 100 selected nodes and heavily escaped partial text fit the final JSON byte budget",async t=>{
  const f=await fixture(t);workflow(f,"large-selection");
  const record=f.repo.get("workflows","large-selection"),draft=structuredClone(record.draft);
  const ids=["input",...Array.from({length:98},(_,i)=>"analysis_"+i),"end"];
  draft.nodes=[draft.nodes[0],...ids.slice(1,-1).map(nodeId=>({
    id:nodeId,type:"agent_task",title:"中文".repeat(80),config:{kind:"analysis",executorRef:"assistant_local",
      instructions:'带有转义内容\n"中文"'.repeat(500),inputMappings:{},outputSchema:{type:"object",properties:{},additionalProperties:false}},
  })),draft.nodes[1]];
  draft.edges=ids.slice(0,-1).map((source,i)=>({source,target:ids[i+1],port:"next"}));
  f.app.authoring.saveRaw(draft,record.revision,{});
  const revision=f.repo.get("workflows","large-selection").revision,selection={workflowId:"large-selection",revision,selectedNodeIds:ids};
  const partial=('\n"\t中文\\').repeat(10000);
  f.provider.script.push(call("workflow_draft_get",{workflowId:"large-selection"}),(request:Json)=>{
    request.onDelta(partial);throw new HubError("MODEL_STREAM_INTERRUPTED","Synthetic escaped response.");
  });
  const a=await f.send("解释当前流程",selection);assert.equal(a.status,"FAILED");assert.equal(a.tools.length,1);
  f.provider.script.push(done);
  const continued=await f.send("继续这条回复，只解释",selection,{continueTaskId:a.id,mode:"help",requestedActions:[]});
  assert.equal(continued.status,"COMPLETED");
  const selected=context(f.provider.requests.at(-1)!);
  assert.ok(Buffer.byteLength(selected.text,"utf8")<=64000);assert.equal(continued.contextSummary.includedBytes,Buffer.byteLength(selected.text,"utf8"));
  assert.deepEqual(selected.data.selectedNodeIds,ids);assert.equal(selected.data.workflow.revision,revision);
  assert.equal(selected.data.workflow.draft.nodes.length,100);assert.equal(selected.data.workflow.definitionTruncated,true);
  assert.equal(selected.data.previousTurnResults[0].taskId,a.id);
  const prior=selected.data.previousTurnResults[0],range=prior.partialTextRange;
  assert.equal(range.totalBytes,Buffer.byteLength(partial));assert.ok(range.nextOffset>0);assert.equal(Buffer.byteLength(prior.partialText),range.nextOffset);
  assert.equal(range.content,undefined);assert.equal(prior.partialText,Buffer.from(partial).subarray(0,range.nextOffset).toString("utf8"));
  assert.equal(prior.tools[0].receiptRef,a.tools[0].id);assert.equal(prior.tools[0].resultOmitted,true);
});
test("max continuation: selecting failed/cancelled A after B/C only injects A and cannot replay its writes",async t=>{
  const f=await fixture(t);
  f.provider.script.push(call("workflow_draft_create",{workflowId:"created-a",name:"A",environment:"test",mode:"auto",template:"blank",idempotencyKey:"a-write"}),(request:Json)=>{
    request.onDelta("早期A的部分正文");throw new HubError("MODEL_STREAM_INTERRUPTED","Synthetic interrupted A.");
  });
  const a=await f.send("创建一个流程并保存");assert.equal(a.status,"FAILED");assert.equal(a.tools.length,1);
  for(const text of ["后续B的问题","后续C的问题"]){f.provider.script.push({...done,text:"回答"+text});await f.send(text);}
  f.provider.script.push(done);
  const continued=await f.send("根据这条回复的工具回执继续回复，只解释结果，不要重复执行操作",{}, {continueTaskId:a.id,mode:"help",requestedActions:[]});
  assert.equal(continued.status,"COMPLETED");
  const request=f.provider.requests.at(-1)!,selected=context(request).data;
  assert.equal(selected.previousTurnResults.length,1);assert.equal(selected.previousTurnResults[0].taskId,a.id);
  assert.equal(selected.previousTurnResults[0].partialText,"早期A的部分正文");
  assert.equal(selected.previousTurnResults[0].tools[0].result.workflowId,"created-a");
  assert.ok(!JSON.stringify(request.messages).includes("后续B的问题"));assert.ok(!JSON.stringify(request.messages).includes("后续C的问题"));
  assert.ok(request.tools.every((tool:Json)=>!["workflow_draft_create","workflow_draft_patch","workflow_start","workflow_cancel","capability_import","host_scan"].includes(tool.name)));
  assert.equal(f.repo.all("workflows").length,1);assert.equal(f.repo.all("runs").length,0);
  f.provider.script.push(call("workflow_draft_create",{workflowId:"must-not-replay",name:"wrong",environment:"test",mode:"auto",template:"blank",idempotencyKey:"forbidden"}));
  const refused=await f.send("继续这条回复",{}, {continueTaskId:a.id,mode:"help",requestedActions:[]});
  assert.equal(refused.errorCode,"INTENT_NOT_ALLOWED");assert.equal(refused.tools.length,0);assert.equal(f.repo.all("workflows").length,1);
  f.provider.script.push(done);await f.send("请根据上一轮已保存的工具回执继续回复");
  assert.equal(context(f.provider.requests.at(-1)!).data.previousTurnResults,undefined);
});
test("max continuation: source task owner/session/provider/scope/terminal/expiry are checked before any model request",async t=>{
  const f=await fixture(t);workflow(f,"one");workflow(f,"two");
  f.provider.script.push(done);const a=await f.send("解释当前流程",{workflowId:"one",selectedNodeIds:["input"]});
  const original=f.repo.get("assistant_tasks",a.id),before=f.provider.requests.length;
  const submit=(context:Json={workflowId:"one",selectedNodeIds:["input"]},extra:Json={})=>f.app.assistant.submit(f.session.id,f.body("继续这条回复",context,{continueTaskId:a.id,mode:"help",requestedActions:[],...extra}));
  assert.throws(()=>submit({workflowId:"two",selectedNodeIds:["input"]}),{code:"INTENT_NOT_ALLOWED"});
  assert.throws(()=>submit({workflowId:"one",selectedNodeIds:["end"]}),{code:"INTENT_NOT_ALLOWED"});
  const other=f.app.assistant.session();
  assert.throws(()=>f.app.assistant.submit(other.id,f.body("继续这条回复",{workflowId:"one",selectedNodeIds:["input"]},{continueTaskId:a.id})),{code:"NOT_FOUND"});
  f.repo.put("assistant_tasks",a.id,{...original,owner:"other-owner"});assert.throws(()=>submit(),{code:"NOT_FOUND"});f.repo.put("assistant_tasks",a.id,original);
  f.repo.put("assistant_tasks",a.id,{...original,status:"GENERATING"});assert.throws(()=>submit(),{code:"TASK_ACTIVE"});f.repo.put("assistant_tasks",a.id,original);
  f.repo.put("assistant_tasks",a.id,{...original,resultsExpiredAt:new Date().toISOString()});assert.throws(()=>submit(),{code:"RESULT_EXPIRED"});f.repo.put("assistant_tasks",a.id,original);
  const profile=f.app.assistant.saveProfile({name:"其他模型",providerKind:"openai_compatible_chat",baseUrl:"https://example.invalid/v1",model:"synthetic"});
  assert.throws(()=>submit(undefined,{modelProfileId:profile.id}),{code:"INTENT_NOT_ALLOWED"});
  assert.throws(()=>submit(undefined,{text:"创建并保存",mode:"compose",requestedActions:["edit_draft"]}),{code:"INTENT_NOT_ALLOWED"});
  f.app.assistant.saveProfile({name:"相同ID改变身份",providerKind:"openai_compatible_chat",baseUrl:"https://example.invalid/v1",model:"changed",expectedRevision:f.profile.revision},f.profile.id);
  assert.throws(()=>submit(),{code:"INTENT_NOT_ALLOWED"});assert.equal(f.provider.requests.length,before);
});
test("max continuation: run scope and expired source messages, tool receipts and business results cannot be reused",async t=>{
  const f=await fixture(t),run=await waiting(f,"run-a"),other=await waiting(f,"run-b");
  f.provider.script.push(call("workflow_status",{runId:run.runId}),done);
  const a=await f.send("解释当前运行",{runId:run.runId});
  assert.equal(a.status,"COMPLETED");assert.equal(a.tools.length,1);
  const before=f.provider.requests.length;
  const submit=(context:Json={runId:run.runId})=>f.app.assistant.submit(f.session.id,f.body("继续这条回复",context,{continueTaskId:a.id,mode:"help",requestedActions:[]}));
  assert.throws(()=>submit({runId:other.runId}),{code:"INTENT_NOT_ALLOWED"});
  assert.throws(()=>submit({runId:run.runId,artifactRefs:["different-artifact"]}),{code:"INTENT_NOT_ALLOWED"});
  const message=f.repo.all("assistant_messages").find(message=>message.taskId===a.id)!;
  f.repo.put("assistant_messages",message.id,{...message,resultsExpiredAt:new Date().toISOString()});
  assert.throws(()=>submit(),{code:"RESULT_EXPIRED"});f.repo.put("assistant_messages",message.id,message);
  const receipt=f.repo.get("assistant_tool_calls",a.tools[0].id);
  f.repo.put("assistant_tool_calls",receipt.id,{...receipt,resultsExpiredAt:new Date().toISOString()});
  assert.throws(()=>submit(),{code:"RESULT_EXPIRED"});f.repo.put("assistant_tool_calls",receipt.id,receipt);
  const stored=f.repo.get("runs",run.runId);f.repo.put("runs",run.runId,{...stored,resultsExpiredAt:new Date().toISOString()});
  assert.throws(()=>submit(),{code:"RESULT_EXPIRED"});assert.equal(f.provider.requests.length,before);
});
