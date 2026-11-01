import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { Application } from "../../packages/application/src/index.js";
import { HttpModelProvider } from "../../packages/llm-providers/src/index.js";
import { requestedActions } from "../../packages/contracts/src/assistant-intent.js";
import { hash, HubError, type Json } from "../../packages/contracts/src/domain.js";
import { projectRoot } from "../../packages/contracts/src/index.js";

async function httpFixture(t:any,respond:(body:Json,res:any)=>void) {
  const requests:Json[]=[];
  const server=createServer(async(req,res)=>{let text="";for await(const part of req)text+=part;const body=JSON.parse(text);requests.push(body);respond(body,res);});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo);vault.initialize("Synthetic-assistant-audit-only");
  const engine=new Engine(repo,vault,new Connectors(repo,vault)),app=new Application(engine);
  t.after(async()=>{await app.close();await engine.close();db.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const baseUrl="http://127.0.0.1:"+(server.address() as any).port+"/v1";
  const profile=app.assistant.saveProfile({name:"Local synthetic",providerKind:"openai_compatible_chat",baseUrl,model:"synthetic",apiKey:"synthetic-key-only",stream:false,timeoutMs:1000});
  const send=(text:string,context:Json={},actions=requestedActions(text))=>{const session=app.assistant.session();const accepted=app.assistant.submit(session.id,{text,context,requestedActions:actions,mode:"compose",modelProfileId:profile.id,idempotencyKey:crypto.randomUUID()});return {...accepted,sessionId:session.id};};
  return {app,engine,repo,vault,profile,baseUrl,requests,send};
}
function reply(res:any,content="done",calls:Json[]=[]) {res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({choices:[{finish_reason:calls.length?"tool_calls":"stop",message:{role:"assistant",content,tool_calls:calls}}],usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7}}));}
function tool(name:string,args:Json,id="call") {return {id,type:"function",function:{name,arguments:JSON.stringify(args)}};}
function workflow(f:Json,name:string,analysis=false) {
  f.app.authoring.create({workflowId:name,name,environment:"test",mode:analysis?"guided":"auto",template:"blank",idempotencyKey:name+":create"});
  let revision=1;
  if(analysis)revision=f.app.authoring.patch({workflowId:name,expectedRevision:1,idempotencyKey:name+":patch",operations:[{op:"add_node",nodeId:"analysis",nodeType:"agent_task",title:"Synthetic analysis",config:{kind:"analysis",executorRef:"assistant_local",instructions:"Synthetic only",inputMappings:{"/token":{value:"business-token-original"}},outputSchema:{type:"object",properties:{summary:{type:"string"}},required:["summary"],additionalProperties:false}}},{op:"disconnect",source:"input",target:"end",port:"next"},{op:"connect",source:"input",target:"analysis",port:"next"},{op:"connect",source:"analysis",target:"end",port:"next"}]}).revision;
  f.app.authoring.publish({workflowId:name,expectedRevision:revision,version:"1.0.0",expectedBindingRevisions:{},expectedCapabilityRevisions:{},idempotencyKey:name+":publish"});
}
async function waiting(f:Json,name="analysis") {workflow(f,name,true);const accepted=f.engine.start({workflowId:name,version:"1.0.0",mode:"guided",inputs:{},idempotencyKey:name+":run"});for(let i=0;i<100;i++){const status=f.engine.status(accepted.runId);if(status.state==="WAITING_AGENT")return status;await new Promise(r=>setTimeout(r,5));}throw new Error("Synthetic checkpoint did not appear");}

test("shared intent excludes explanations, quoted examples, staging nouns and coordinated negatives",()=>{
  for(const text of ["保存草稿，不要发布或执行","创建试运行流程并保存草稿","保存草稿，不执行","create a dry-run workflow and save it","请解释当前流程的运行原理","请说明如何运行流程","save the draft, do not publish or run","create a staging workflow and save it","Explain how to run this workflow",'解释示例“运行当前流程”'])assert.ok(!requestedActions(text).includes("run"),text);
  assert.deepEqual(requestedActions("保存草稿，不要发布或执行"),["edit_draft"]);
  assert.deepEqual(requestedActions("创建、测试并运行"),["edit_draft","test","run"]);
  assert.deepEqual(requestedActions("create, publish and run this workflow"),["edit_draft","publish","run"]);
});

test("real HTTP task refuses a run proposed for a negative request, and API cannot forge intent",async t=>{
  const f=await httpFixture(t,(_body,res)=>reply(res,"",[tool("workflow_start",{workflowId:"selected",version:"1.0.0",mode:"auto",inputs:{},idempotencyKey:"forbidden"})]));workflow(f,"selected");
  const accepted=f.send("保存草稿，不要发布或执行",{workflowId:"selected"});await f.app.assistant.settled();
  assert.equal(f.app.assistant.task(accepted.taskId).errorCode,"INTENT_NOT_ALLOWED");assert.equal(f.repo.all("runs").length,0);assert.ok(!f.requests[0].tools.some((t:Json)=>t.function.name==="workflow_start"));
  assert.throws(()=>f.send("请解释当前流程的运行原理",{workflowId:"selected"},["run"]),{code:"INTENT_NOT_ALLOWED"});
});

test("selected workflow and run constrain reads, tests, start and cancellation before dispatch",async t=>{
  let call:Json;
  const f=await httpFixture(t,(_body,res)=>reply(res,"",[call]));workflow(f,"selected");workflow(f,"other");
  const selected=await waiting(f,"selected-run"),other=await waiting(f,"other-run");
  const cases=[{name:"workflow_start",args:{workflowId:"other",version:"1.0.0",mode:"auto",inputs:{},idempotencyKey:"wrong"},text:"运行当前流程",context:{workflowId:"selected"}},{name:"workflow_draft_get",args:{workflowId:"other"},text:"解释流程",context:{workflowId:"selected"}},{name:"workflow_draft_validate",args:{workflowId:"other",expectedRevision:1},text:"修改当前流程",context:{workflowId:"selected"}},{name:"workflow_test_generate",args:{workflowId:"other",expectedRevision:1,strategy:"deterministic",idempotencyKey:"wrong-test"},text:"测试当前流程",context:{workflowId:"selected"}},{name:"workflow_cancel",args:{runId:other.runId,expectedRevision:other.revision,reason:"wrong",idempotencyKey:"wrong-cancel"},text:"执行当前流程",context:{runId:selected.runId}},{name:"workflow_status",args:{runId:other.runId},text:"解释流程",context:{runId:selected.runId}}];
  for(const c of cases){call=tool(c.name,c.args);const accepted=f.send(c.text,c.context);await f.app.assistant.settled();const task=f.app.assistant.task(accepted.taskId);assert.equal(task.errorCode,"INTENT_NOT_ALLOWED",c.name);assert.equal(task.tools.length,0,c.name);}
  assert.equal(f.engine.status(other.runId).state,"WAITING_AGENT");
});

test("HTTP contexts and status receipts omit checkpoint credentials and preserve business token values; advance injects server credential",async t=>{
  let phase="echo",checkpoint:Json;
  const f=await httpFixture(t,(body,res)=>{
    if(phase==="echo"){reply(res,JSON.stringify(body.messages));return;}
    if(!body.messages.some((m:Json)=>m.role==="tool"))reply(res,"",[tool("workflow_status",{runId:checkpoint.runId},"status")]);
    else if(!body.messages.some((m:Json)=>m.tool_call_id==="advance"))reply(res,"",[tool("workflow_advance",{runId:checkpoint.runId,checkpointId:checkpoint.checkpoint.id,expectedRevision:checkpoint.revision,idempotencyKey:"advance",submission:{type:"agent_result",payload:{summary:"synthetic"}}},"advance")]);
    else reply(res,"advanced");
  });
  checkpoint=await waiting(f);const token=checkpoint.checkpoint.token;
  const first=f.send("解释当前运行",{runId:checkpoint.runId});await f.app.assistant.settled();assert.equal(f.app.assistant.task(first.taskId).status,"COMPLETED");
  phase="advance";const accepted=f.send("执行当前流程",{runId:checkpoint.runId});await f.app.assistant.settled();assert.equal(f.app.assistant.task(accepted.taskId).status,"COMPLETED");
  assert.ok(!JSON.stringify(f.requests).includes(token));assert.ok(JSON.stringify(f.requests).includes("business-token-original"));
  assert.ok(!JSON.stringify(f.repo.all("assistant_messages")).includes(token));assert.ok(!JSON.stringify(f.repo.changes(0,10000)).includes(token));assert.ok(!JSON.stringify(f.repo.all("assistant_tool_calls")).includes(token));
  const advance=f.requests.at(-2).tools.find((t:Json)=>t.function.name==="workflow_advance");assert.ok(!advance.function.parameters.properties.checkpointToken);
  assert.equal(f.app.assistant.task(accepted.taskId).usage.total_tokens,21);
});

test("analysis idempotency survives successful advance and deleted receipts never trigger another model call",async t=>{
  const f=await httpFixture(t,(_body,res)=>reply(res,'{"summary":"synthetic"}'));const run=await waiting(f);
  const accepted=f.app.assistant.analyzeCheckpoint(run.runId,f.profile.id,"analysis-once");await f.app.assistant.settled();const task=f.app.assistant.task(accepted.taskId);assert.equal(task.status,"COMPLETED");
  assert.equal(f.app.assistant.analyzeCheckpoint(run.runId,f.profile.id,"analysis-once").taskId,accepted.taskId);
  assert.throws(()=>f.app.assistant.analyzeCheckpoint(run.runId,"different-profile","analysis-once"),{code:"IDEMPOTENCY_CONFLICT"});assert.equal(f.requests.length,1);
  // Historical analysis receipts did not include a sessionId; deleting by taskId must still find them.
  const receipt=f.repo.all("assistant_tool_calls")[0];delete receipt.sessionId;f.repo.put("assistant_tool_calls",receipt.id,receipt);
  const unrelated=f.send("解释项目");await f.app.assistant.settled();f.app.assistant.deleteSession(task.sessionId);
  assert.equal(f.repo.all("assistant_tool_calls").filter(c=>c.taskId===task.id).length,0);assert.equal(f.repo.changes(0,10000).filter(e=>e.taskId===task.id).length,0);assert.ok(f.repo.get("assistant_tasks",unrelated.taskId));
  assert.throws(()=>f.app.assistant.analyzeCheckpoint(run.runId,f.profile.id,"analysis-once"),{code:"RESULT_EXPIRED"});assert.equal(f.requests.length,2);
});

test("profile stream probe fallback is honored and provider identity changes invalidate probes",async t=>{
  const f=await httpFixture(t,(body,res)=>{if(body.stream){res.writeHead(400);res.end();return;}reply(res,"nonstream",body.tools?.some((t:Json)=>t.function.name==="flowhub_probe")?[tool("flowhub_probe",{value:"ok"})]:[]);});
  const profile=f.app.assistant.saveProfile({name:"fallback",providerKind:"openai_compatible_chat",baseUrl:f.baseUrl,model:"text-tools",apiKey:"synthetic-key-only",stream:true});
  const probes=await f.app.assistant.testProfile(profile.id);assert.equal(probes.text.status,"passed");assert.equal(probes.tools.status,"passed");assert.equal(probes.stream.status,"failed");
  const session=f.app.assistant.session(),task=f.app.assistant.submit(session.id,{text:"解释项目",mode:"help",context:{},requestedActions:[],modelProfileId:profile.id,idempotencyKey:"fallback"});await f.app.assistant.settled();assert.equal(f.app.assistant.task(task.taskId).status,"COMPLETED");assert.equal(f.requests.at(-1).stream,false);
  const current=f.app.assistant.profiles().find(p=>p.id===profile.id)!;const changed=f.app.assistant.saveProfile({name:current.name,providerKind:current.providerKind,baseUrl:current.baseUrl,model:"replacement",expectedRevision:current.revision},profile.id);assert.equal(changed.capabilities.tools,"unknown");assert.equal(changed.lastTestAt,null);
});

test("body timeout after headers, SSE timeout, invalid JSON and body budget keep typed errors",async t=>{
  let mode="headers";
  const f=await httpFixture(t,(_body,res)=>{if(mode==="invalid"){res.writeHead(200);res.end('{"choices":');return;}if(mode==="oversized"){res.writeHead(200);res.end(JSON.stringify({padding:"x".repeat(4*1024*1024)}));return;}
    if(mode==="sse"){res.writeHead(200,{"Content-Type":"text/event-stream"});res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');return;}res.writeHead(200,{"Content-Type":"application/json"});res.flushHeaders();});
  const provider=new HttpModelProvider({...f.profile,timeoutMs:1000},"synthetic-key");const request={messages:[],tools:[],signal:new AbortController().signal,stream:false};
  await assert.rejects(provider.complete(request),{code:"MODEL_TIMEOUT"});mode="sse";await assert.rejects(provider.complete({...request,stream:true}),{code:"MODEL_TIMEOUT"});mode="invalid";await assert.rejects(provider.complete(request),{code:"MODEL_OUTPUT_INVALID"});mode="oversized";await assert.rejects(provider.complete(request),{code:"BUDGET_EXCEEDED"});
  mode="headers";const liveCancel=new AbortController(),pending=provider.complete({...request,signal:liveCancel.signal});setTimeout(()=>liveCancel.abort(new HubError("TASK_CANCELLED","cancel")),20);await assert.rejects(pending,{code:"TASK_CANCELLED"});
  const budget=new AbortController(),budgetPending=provider.complete({...request,signal:budget.signal});setTimeout(()=>budget.abort(new HubError("BUDGET_EXCEEDED","task deadline")),20);await assert.rejects(budgetPending,{code:"BUDGET_EXCEEDED"});
  const cancelled=new AbortController();cancelled.abort(new HubError("TASK_CANCELLED","cancel"));await assert.rejects(provider.complete({...request,signal:cancelled.signal}),{code:"TASK_CANCELLED"});
});

test("knowledge citations hash actual source ranges, expose stale sources, and history has a real cursor",async t=>{
  const f=await httpFixture(t,(_body,res)=>reply(res));
  for(const chunk of f.repo.all("knowledge_chunks")){const source=readFileSync(resolve(projectRoot,chunk.sourcePath),"utf8").split("\n").slice(chunk.lineStart-1,chunk.lineEnd).join("\n");assert.equal(chunk.content,source,chunk.id);assert.equal(chunk.contentHash,hash(source),chunk.id);}
  const hit=f.app.knowledge.search({query:"workflow_draft_create",limit:20}).citations.find((c:Json)=>c.chunkId==="tool:workflow_draft_create");assert.ok(hit);
  const old=f.repo.get("knowledge_chunks",hit.chunkId);f.repo.put("knowledge_chunks",old.id,{...old,contentHash:"older-source"});assert.equal(f.app.knowledge.source({chunkId:old.id}).stale,true);f.app.knowledge.rebuild();assert.equal(f.app.knowledge.source({chunkId:old.id}).stale,false);
  const session=f.app.assistant.session();for(let i=0;i<105;i++)f.repo.put("assistant_messages","m"+i,{id:"m"+i,sessionId:session.id,role:"user",text:String(i)});
  const page=f.app.assistant.messagePage(session.id,{limit:100});assert.equal(page.items.length,100);assert.equal(page.hasMore,true);assert.equal(f.app.assistant.messagePage(session.id,{before:page.nextCursor}).items.length,5);
});

test("Responses stateless continuation preserves encrypted reasoning items without displaying them",async t=>{
  const reasoning={type:"reasoning",id:"opaque-reasoning",summary:[],encrypted_content:"synthetic-provider-opaque-reasoning"};
  const f=await httpFixture(t,(body,res)=>{res.writeHead(200,{"Content-Type":"application/json"});if(body.input.some((item:Json)=>item.type==="function_call_output"))res.end(JSON.stringify({status:"completed",output:[{type:"message",id:"answer",role:"assistant",phase:"final_answer",content:[{type:"output_text",text:"saved"}]}]}));else res.end(JSON.stringify({status:"completed",output:[reasoning,{type:"function_call",id:"fc",call_id:"create",name:"workflow_draft_create",arguments:JSON.stringify({workflowId:"stateless",name:"stateless",environment:"test",mode:"auto",template:"blank",idempotencyKey:"stateless-create"})}]}));});
  const profile=f.app.assistant.saveProfile({name:"Stateless",providerKind:"openai_responses",baseUrl:f.baseUrl,model:"synthetic-reasoning",apiKey:"synthetic-key-only",stream:false}),session=f.app.assistant.session();
  const accepted=f.app.assistant.submit(session.id,{text:"创建流程并保存草稿",mode:"compose",context:{},requestedActions:requestedActions("创建流程并保存草稿"),modelProfileId:profile.id,idempotencyKey:"stateless"});await f.app.assistant.settled();
  const task=f.app.assistant.task(accepted.taskId);assert.equal(task.status,"COMPLETED");assert.equal(f.requests[0].store,false);assert.deepEqual(f.requests[1].input.find((item:Json)=>item.type==="reasoning"),reasoning);assert.ok(f.requests[1].input.some((item:Json)=>item.type==="function_call_output"&&item.call_id==="create"));
  assert.ok(!JSON.stringify(task).includes(reasoning.encrypted_content));assert.ok(!JSON.stringify(f.repo.all("assistant_tasks")).includes(reasoning.encrypted_content));assert.ok(!JSON.stringify(f.repo.changes(0,10000)).includes(reasoning.encrypted_content));
});

test("failed and cancelled analysis acceptance replays original task, while a fresh key can retry",async t=>{
  let fail=true;
  const f=await httpFixture(t,(_body,res)=>{if(fail){res.writeHead(401);res.end();return;}reply(res,'{"summary":"synthetic"}');});const run=await waiting(f);
  const first=f.app.assistant.analyzeCheckpoint(run.runId,f.profile.id,"failed");await f.app.assistant.settled();assert.equal(f.app.assistant.task(first.taskId).errorCode,"MODEL_AUTH_FAILED");assert.equal(f.app.assistant.analyzeCheckpoint(run.runId,f.profile.id,"failed").taskId,first.taskId);assert.equal(f.requests.length,1);
  fail=false;const second=f.app.assistant.analyzeCheckpoint(run.runId,f.profile.id,"retry");f.app.assistant.cancel(second.taskId);await f.app.assistant.settled();assert.equal(f.app.assistant.task(second.taskId).status,"CANCELLED");assert.equal(f.app.assistant.analyzeCheckpoint(run.runId,f.profile.id,"retry").taskId,second.taskId);
  const third=f.app.assistant.analyzeCheckpoint(run.runId,f.profile.id,"retry-again");await f.app.assistant.settled();assert.equal(f.app.assistant.task(third.taskId).status,"COMPLETED");
});

test("assistant shutdown cancels and drains active HTTP capability probes before returning",async t=>{
  const f=await httpFixture(t,(_body,res)=>{res.writeHead(200);res.flushHeaders();});
  const probing=f.app.assistant.testProfile(f.profile.id);const result=assert.rejects(probing,{code:"SERVICE_STOPPING"});await new Promise(r=>setTimeout(r,15));await f.app.close();await result;
  assert.throws(()=>f.app.assistant.session(),{code:"SERVICE_STOPPING"});assert.throws(()=>f.app.assistant.analyzeCheckpoint("unused",f.profile.id,"unused"),{code:"SERVICE_STOPPING"});assert.equal(f.repo.all("assistant_tasks").length,0);
});

test("session deletion waits for cancelling workers so delayed receipts cannot recreate deleted copies",async t=>{
  const f=await httpFixture(t,(_body,res)=>{res.writeHead(200);res.flushHeaders();});const accepted=f.send("解释项目");f.app.assistant.cancel(accepted.taskId);
  assert.throws(()=>f.app.assistant.deleteSession(accepted.sessionId),{code:"TASK_ACTIVE"});await f.app.assistant.settled();f.app.assistant.deleteSession(accepted.sessionId);
  assert.equal(f.repo.get("assistant_tasks",accepted.taskId),undefined);assert.equal(f.repo.changes(0,10000).some(e=>e.taskId===accepted.taskId),false);
});

test("common, coordinated, postfix and interrogative negatives deny actual run/publish proposals; affirmative combined actions remain executable",async t=>{
  let proposed="workflow_start";
  const f=await httpFixture(t,(body,res)=>{
    if(proposed==="positive") {
      const receipts=body.messages.filter((m:Json)=>m.role==="tool");
      const calls=[tool("workflow_draft_create",{workflowId:"affirmative",name:"Affirmative",environment:"test",mode:"auto",template:"blank",idempotencyKey:"positive-create"},"create"),tool("workflow_draft_publish",{workflowId:"affirmative",expectedRevision:1,version:"1.0.0",expectedBindingRevisions:{},expectedCapabilityRevisions:{},idempotencyKey:"positive-publish"},"publish"),tool("workflow_start",{workflowId:"affirmative",version:"1.0.0",mode:"auto",inputs:{},idempotencyKey:"positive-run"},"run")];
      reply(res,receipts.length<3?"":"done",receipts.length<3?[calls[receipts.length]]:[]);return;
    }
    reply(res,"",[proposed==="workflow_start"?tool(proposed,{workflowId:"selected",version:"1.0.0",mode:"auto",inputs:{},idempotencyKey:crypto.randomUUID()}):tool(proposed,{workflowId:"selected",expectedRevision:f.app.authoring.get("selected").revision,version:"2.0.0",expectedBindingRevisions:{},expectedCapabilityRevisions:{},idempotencyKey:crypto.randomUUID()})]);
  });workflow(f,"selected");
  const phrases=["请勿运行当前流程","我不想运行当前流程","我不希望运行当前流程","不需要运行当前流程","不应该运行当前流程","无需实际运行当前流程","运行当前流程先不要","运行当前流程就算了","是否运行当前流程","运行当前流程，可以吗","Do not run or publish","save the draft, don't publish or run","创建、发布、运行，都不要"];
  for(const text of phrases){proposed="workflow_start";const accepted=f.send(text,{workflowId:"selected"});await f.app.assistant.settled();assert.equal(f.app.assistant.task(accepted.taskId).errorCode,"INTENT_NOT_ALLOWED",text);assert.ok(!f.requests.at(-1).tools.some((tool:Json)=>tool.function.name==="workflow_start"),text);}
  for(const text of ["请勿发布当前流程","我不想发布当前流程","我不希望发布当前流程","不需要发布当前流程","不应发布当前流程","发布当前流程先不要","发布与运行都不要","发布当前流程可以吗"]){proposed="workflow_draft_publish";const accepted=f.send(text,{workflowId:"selected"});await f.app.assistant.settled();assert.equal(f.app.assistant.task(accepted.taskId).errorCode,"INTENT_NOT_ALLOWED",text);assert.ok(!f.requests.at(-1).tools.some((tool:Json)=>tool.function.name==="workflow_draft_publish"),text);}
  assert.equal(f.repo.all("runs").length,0);assert.equal(f.repo.all("versions").length,1);
  assert.deepEqual(requestedActions("只自测，不发布也不运行"),["test"]);assert.deepEqual(requestedActions("创建并保存不要发布或执行"),["edit_draft"]);
  proposed="positive";const positive=f.send("创建、发布并运行");await f.app.assistant.settled();assert.equal(f.app.assistant.task(positive.taskId).status,"COMPLETED");assert.equal(f.repo.all("runs").length,1);assert.equal(f.repo.all("versions").length,2);
});

test("real message provenance scopes history by selected run/artifacts and provider; clearing selection never reuses old run answers",async t=>{
  let mode="analysis";
  const f=await httpFixture(t,(body,res)=>{const selected=body.messages.find((message:Json)=>message.content?.startsWith?.("Selected context (data): "));const context=selected?JSON.parse(selected.content.slice("Selected context (data): ".length)):null;
    reply(res,mode==="analysis"?'{"summary":"RUN_A_SYNTHETIC_PRIVATE_RESULT"}':context?.run?"PROVIDER_A_RUN_SUMMARY "+JSON.stringify(context.run.outputs):"UNRELATED_FRESH_HELP");});
  const runA=await waiting(f,"scope-a"),analysis=f.app.assistant.analyzeCheckpoint(runA.runId,f.profile.id,"scope-analysis");await f.app.assistant.settled();assert.equal(f.app.assistant.task(analysis.taskId).status,"COMPLETED");
  for(let i=0;i<100&&f.engine.status(runA.runId).state==="RUNNING";i++)await new Promise(r=>setTimeout(r,5));
  const session=f.app.assistant.session(),profileB=f.app.assistant.saveProfile({name:"Other provider selection",providerKind:"openai_compatible_chat",baseUrl:f.baseUrl,model:"provider-B",apiKey:"synthetic-B-only",stream:false});
  const send=async(context:Json,profileId=f.profile.id)=>{const accepted=f.app.assistant.submit(session.id,{text:"解释项目或当前运行",mode:"help",context,requestedActions:[],modelProfileId:profileId,idempotencyKey:crypto.randomUUID()});await f.app.assistant.settled();assert.equal(f.app.assistant.task(accepted.taskId).status,"COMPLETED");return accepted;};
  mode="help";const first=await send({runId:runA.runId});assert.ok(JSON.stringify(f.requests.at(-1)).includes("RUN_A_SYNTHETIC_PRIVATE_RESULT"));
  f.repo.put("assistant_messages","legacy",{id:"legacy",sessionId:session.id,owner:"execution",role:"assistant",text:"LEGACY_UNATTRIBUTED_PRIVATE_RESULT",createdAt:new Date().toISOString()});
  const cleared=await send({},profileB.id);assert.ok(!JSON.stringify(f.requests.at(-1)).includes("RUN_A_SYNTHETIC_PRIVATE_RESULT"));assert.ok(!JSON.stringify(f.requests.at(-1)).includes("LEGACY_UNATTRIBUTED_PRIVATE_RESULT"));
  const runB=await waiting(f,"scope-b");await send({runId:runB.runId},profileB.id);assert.ok(!JSON.stringify(f.requests.at(-1)).includes("RUN_A_SYNTHETIC_PRIVATE_RESULT"));
  await send({runId:runA.runId},profileB.id);assert.ok(!f.requests.at(-1).messages.some((message:Json)=>message.role==="assistant"&&message.content.includes("PROVIDER_A_RUN_SUMMARY")));
  await send({runId:runA.runId});assert.ok(f.requests.at(-1).messages.some((message:Json)=>message.role==="assistant"&&message.content.includes("PROVIDER_A_RUN_SUMMARY")));
  for(const message of f.repo.all("assistant_messages").filter(message=>message.id!=="legacy")){assert.ok(message.taskId);assert.equal(message.contextRefs.schemaVersion,1);assert.ok(message.providerIdentity);assert.ok(message.modelProfileId);}
  const run=f.repo.get("runs",runA.runId);f.repo.put("runs",run.id,{...run,updatedAt:new Date(Date.now()-8*86400000).toISOString()});
  const {previewRetention,commitRetention}=await import("../../packages/persistence/src/retention.js");const preview=previewRetention(f.repo);commitRetention(f.repo,preview.hash);
  assert.ok(f.repo.get("assistant_tasks",first.taskId).resultsExpiredAt);assert.ok(!JSON.stringify(f.repo.all("assistant_messages")).includes("RUN_A_SYNTHETIC_PRIVATE_RESULT"));assert.ok(!JSON.stringify(f.repo.all("assistant_tasks")).includes("RUN_A_SYNTHETIC_PRIVATE_RESULT"));assert.ok(!JSON.stringify(f.repo.changes(0,10000)).includes("RUN_A_SYNTHETIC_PRIVATE_RESULT"));assert.ok(f.repo.all("assistant_messages").some(message=>message.taskId===cleared.taskId&&message.text==="UNRELATED_FRESH_HELP"));
  await send({},profileB.id);assert.ok(!JSON.stringify(f.requests.at(-1)).includes("RUN_A_SYNTHETIC_PRIVATE_RESULT"));assert.ok(!JSON.stringify(f.requests.at(-1)).includes("LEGACY_UNATTRIBUTED_PRIVATE_RESULT"));
});

test("analysis correction budgets 1/2/3 count the initial attempt, account usage and retain checkpoint on exhaustion",async t=>{
  let validAt=Infinity,calls=0;
  const f=await httpFixture(t,(_body,res)=>{calls++;reply(res,calls>=validAt?'{"summary":"valid"}':"invalid-json");});
  const defaultRun=await waiting(f,"budget-default"),defaultTask=f.app.assistant.analyzeCheckpoint(defaultRun.runId,f.profile.id,"budget-default");await f.app.assistant.settled();assert.equal(calls,3);assert.equal(f.app.assistant.task(defaultTask.taskId).rounds,3);
  for(const budget of [1,2,3]) {
    const current=f.app.assistant.profiles().find(profile=>profile.id===f.profile.id)!;
    f.app.assistant.saveProfile({name:current.name,providerKind:current.providerKind,baseUrl:current.baseUrl,model:current.model,stream:false,expectedRevision:current.revision,limits:{maxCorrectionAttempts:budget}},current.id);
    const run=await waiting(f,"budget-"+budget);calls=0;const accepted=f.app.assistant.analyzeCheckpoint(run.runId,current.id,"budget-"+budget);await f.app.assistant.settled();const task=f.app.assistant.task(accepted.taskId);assert.equal(calls,budget);assert.equal(task.usage.total_tokens,budget*7);assert.equal(task.rounds,budget);assert.equal(task.errorCode,"INPUT_INVALID");assert.equal(f.engine.status(run.runId).checkpoint.id,run.checkpoint.id);assert.equal(task.tools.length,0);
  }
  const current=f.app.assistant.profiles().find(profile=>profile.id===f.profile.id)!;f.app.assistant.saveProfile({name:current.name,providerKind:current.providerKind,baseUrl:current.baseUrl,model:current.model,stream:false,expectedRevision:current.revision,limits:{maxCorrectionAttempts:2}},current.id);const run=await waiting(f,"eventually-valid");calls=0;validAt=2;const accepted=f.app.assistant.analyzeCheckpoint(run.runId,current.id,"eventually-valid");await f.app.assistant.settled();assert.equal(calls,2);assert.equal(f.app.assistant.task(accepted.taskId).status,"COMPLETED");assert.equal(f.app.assistant.task(accepted.taskId).usage.total_tokens,14);
});

test("analysis corrections share one total deadline rather than restarting it per model request",async t=>{
  let calls=0;
  const f=await httpFixture(t,(_body,res)=>{calls++;const timer=setTimeout(()=>reply(res,"invalid-json"),650);res.once("close",()=>clearTimeout(timer));});
  const current=f.app.assistant.profiles().find(profile=>profile.id===f.profile.id)!;f.app.assistant.saveProfile({name:current.name,providerKind:current.providerKind,baseUrl:current.baseUrl,model:current.model,stream:false,timeoutMs:300000,expectedRevision:current.revision,limits:{maxCorrectionAttempts:3,taskTimeoutMs:1000}},current.id);
  const run=await waiting(f,"total-deadline"),started=Date.now(),accepted=f.app.assistant.analyzeCheckpoint(run.runId,current.id,"total-deadline");await f.app.assistant.settled();const elapsed=Date.now()-started;assert.equal(calls,2);assert.equal(f.app.assistant.task(accepted.taskId).errorCode,"BUDGET_EXCEEDED");assert.ok(elapsed>=900&&elapsed<2500,String(elapsed));assert.equal(f.engine.status(run.runId).checkpoint.id,run.checkpoint.id);
});
