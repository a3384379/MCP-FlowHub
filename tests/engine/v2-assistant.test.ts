import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createServer } from "node:http";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { Application } from "../../packages/application/src/index.js";
import { AssistantCore } from "../../packages/assistant-core/src/index.js";
import { ScriptedModelProvider, HttpModelProvider, providerUrl, type ModelTurn } from "../../packages/llm-providers/src/index.js";
import { HubError, type Json } from "../../packages/contracts/src/domain.js";

const done={text:"已处理",calls:[],usage:null};
const call=(name:string,args:Json,id="call-1"):ModelTurn=>({text:"",calls:[{id,name,arguments:JSON.stringify(args)}],usage:null});
const create={workflowId:"assistant-created",name:"助手创建",environment:"test",mode:"auto",template:"blank",idempotencyKey:"ai-create"};
async function fixture(t:any,script:any[]) {
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo);vault.initialize("Synthetic-assistant-password");
  const engine=new Engine(repo,vault,new Connectors(repo,vault)),provider=new ScriptedModelProvider(script),app=new Application(engine,{providerFactory:()=>provider});
  t.after(async()=>{await app.close();await engine.close();db.close();});
  const profile=app.assistant.saveProfile({name:"合成模型",providerKind:"openai_responses",baseUrl:"https://example.invalid/v1",model:"synthetic"});
  const session=app.assistant.session();
  const send=(mode="compose",context:Json={},actions=["edit_draft"],key=crypto.randomUUID())=>app.assistant.submit(session.id,{text:"保存草稿，不要发布或执行",mode,context,requestedActions:actions,modelProfileId:profile.id,idempotencyKey:key});
  return {app,repo,provider,profile,session,send};
}
test("assistant really calls shared authoring and persists receipts; duplicate call IDs do not repeat writes",async t=>{
  const f=await fixture(t,[call("workflow_draft_create",create),call("workflow_draft_create",create),done]);
  const task=f.send();await f.app.assistant.settled();
  const state=f.app.assistant.task(task.taskId);assert.equal(state.status,"COMPLETED");assert.equal(f.repo.get("workflows","assistant-created").revision,1);
  assert.equal(state.tools.length,1);assert.equal(state.tools[0].status,"COMPLETED");assert.equal(f.repo.all("versions").length,0);assert.equal(f.repo.all("runs").length,0);
  assert.equal(f.provider.requests.length,3);assert.equal(f.provider.requests[1]!.messages.at(-1)?.role,"tool");
});
test("help mode cannot mutate and half JSON never dispatches",async t=>{
  const f=await fixture(t,[call("workflow_draft_create",create)]);const task=f.send("help");await f.app.assistant.settled();
  assert.equal(f.app.assistant.task(task.taskId).errorCode,"INTENT_NOT_ALLOWED");assert.equal(f.repo.all("workflows").length,0);assert.equal(f.repo.all("assistant_tool_calls").length,0);
  assert.ok(f.provider.requests[0]!.tools.every(t=>!t.name.includes("create")&&!t.name.includes("patch")));
  const broken=new ScriptedModelProvider([{text:"",calls:[{id:"broken",name:"workflow_draft_create",arguments:'{"workflowId":'}],usage:null}]);
  await assert.rejects(broken.complete({messages:[],tools:[],signal:new AbortController().signal,stream:true}),{code:"TOOL_ARGUMENTS_INCOMPLETE"});
});
test("tool validation feedback permits bounded correction and preserves Web revision conflicts",async t=>{
  const patch=(revision:number,id:string)=>call("workflow_draft_patch",{workflowId:"assistant-created",expectedRevision:revision,idempotencyKey:id,operations:[{op:"set_metadata",changes:{name:"AI saved"}}]},id);
  const f=await fixture(t,[patch(1,"stale"),patch(2,"corrected"),done]);f.app.authoring.create(create);f.app.authoring.patch({workflowId:"assistant-created",expectedRevision:1,idempotencyKey:"web",operations:[{op:"set_metadata",changes:{description:"用户编辑"}}]});
  const task=f.send("compose",{workflowId:"assistant-created",revision:1});await f.app.assistant.settled();
  const state=f.app.assistant.task(task.taskId);assert.equal(state.status,"COMPLETED");assert.equal(state.tools[0].result.error.code,"REVISION_CONFLICT");
  assert.equal(f.repo.get("workflows","assistant-created").draft.description,"用户编辑");assert.equal(f.repo.get("workflows","assistant-created").draft.name,"AI saved");
});
test("cancellation aborts pending generation with no tool writes",async t=>{
  const f=await fixture(t,[(req:any)=>new Promise((_resolve,reject)=>req.signal.addEventListener("abort",()=>reject(new HubError("TASK_CANCELLED","cancel")),{once:true}))]);
  const accepted=f.send();await new Promise(r=>setImmediate(r));f.app.assistant.cancel(accepted.taskId);await f.app.assistant.settled();
  assert.equal(f.app.assistant.task(accepted.taskId).status,"CANCELLED");assert.equal(f.repo.all("workflows").length,0);
});
test("restart marks unfinished durable tasks interrupted and retains tool receipts",async t=>{
  const f=await fixture(t,[]);
  f.repo.put("assistant_tasks","interrupted",{id:"interrupted",owner:"execution",sessionId:f.session.id,status:"CALLING_TOOL"});
  f.repo.put("assistant_tool_calls","interrupted:one",{id:"interrupted:one",taskId:"interrupted",callId:"one",status:"COMPLETED",result:{revision:4}});
  new AssistantCore(f.app,()=>f.provider);
  assert.equal(f.app.assistant.task("interrupted").status,"INTERRUPTED");assert.equal(f.app.assistant.task("interrupted").tools[0].result.revision,4);assert.equal(f.provider.requests.length,0);
});
test("model profile Key is encrypted and never stored in command or ordinary profile bodies",async t=>{
  const f=await fixture(t,[]),secret="SYNTHETIC_PRIVATE_MODEL_KEY";
  const profile=f.app.assistant.saveProfile({name:"Encrypted",providerKind:"openai_compatible_chat",baseUrl:"http://127.0.0.1:1/v1",model:"fixture",apiKey:secret});
  assert.equal(profile.keyConfigured,true);assert.ok(!JSON.stringify(f.app.assistant.profiles()).includes(secret));assert.ok(!JSON.stringify(f.repo.all("secrets")).includes(secret));assert.ok(!JSON.stringify(f.repo.db.prepare("SELECT * FROM commands").all()).includes(secret));
  const noKey=new Application(f.app.engine);const session=noKey.assistant.session(),task=noKey.assistant.submit(session.id,{text:"解释项目",mode:"help",context:{},requestedActions:[],modelProfileId:f.profile.id,idempotencyKey:"no-key"});await noKey.assistant.settled();assert.equal(noKey.assistant.task(task.taskId).errorCode,"MODEL_NOT_CONFIGURED");await noKey.close();
});
test("Chinese help and exact error names retrieve current version sources with real citations",async t=>{
  const f=await fixture(t,[]);
  const chinese=f.app.knowledge.search({query:"试运行数据库绑定",limit:5});assert.ok(chinese.excerpts.some((e:Json)=>e.content.includes("试运行")&&e.content.includes("绑定")));
  const error=f.app.knowledge.search({query:"TYPE_MISMATCH",limit:3});assert.ok(error.excerpts.some((e:Json)=>e.content.includes("TYPE_MISMATCH")));
  assert.ok(error.citations.every((c:Json)=>!c.sourcePath.includes("upgrade-v2")&&c.lineStart>0&&c.lineEnd>=c.lineStart));
  assert.ok(f.app.knowledge.search({query:"循环",limit:5}).excerpts.some((e:Json)=>e.content.includes("不支持循环")));
});
test("text-only model probes remain useful for help and refuse composition without fake writes",async t=>{
  const f=await fixture(t,[done,done,done]);
  const probes=await f.app.assistant.testProfile(f.profile.id);assert.equal(probes.text.status,"passed");assert.equal(probes.tools.status,"unsupported");assert.equal(probes.stream.status,"passed");
  const task=f.send();await f.app.assistant.settled();assert.equal(f.app.assistant.task(task.taskId).errorCode,"MODEL_UNSUPPORTED_TOOLS");assert.equal(f.repo.all("workflows").length,0);
});
test("repeated invalid edits stop after three feedback rounds without overwriting a draft",async t=>{
  const bad=(id:string)=>call("workflow_draft_patch",{workflowId:"assistant-created",expectedRevision:99,idempotencyKey:id,operations:[{op:"set_metadata",changes:{name:"wrong"}}]},id);
  const f=await fixture(t,[bad("one"),bad("two"),bad("three"),done]);f.app.authoring.create(create);
  const task=f.send("compose",{workflowId:"assistant-created"});await f.app.assistant.settled();assert.equal(f.app.assistant.task(task.taskId).errorCode,"BUDGET_EXCEEDED");assert.equal(f.provider.requests.length,3);assert.equal(f.repo.get("workflows","assistant-created").revision,1);
});
async function mockServer(t:any,respond:(req:Json,body:Json,res:any)=>void) {
  const server=createServer(async(req,res)=>{let text="";for await(const part of req)text+=part;respond(req,JSON.parse(text||"{}"),res);});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>new Promise<void>((r,j)=>server.close(e=>e?j(e):r())));
  return "http://127.0.0.1:"+(server.address() as any).port+"/v1";
}
test("Responses and Chat Completions use separate envelopes and protocol paths",async t=>{
  const seen:Json[]=[];
  const baseUrl=await mockServer(t,(req,body,res)=>{seen.push({path:req.url,body});res.setHeader("Content-Type","application/json");res.end(JSON.stringify(req.url.endsWith("responses")?{status:"completed",output:[{type:"function_call",call_id:"r1",name:"probe",arguments:'{"value":"ok"}'}]}:{choices:[{finish_reason:"tool_calls",message:{content:null,tool_calls:[{id:"c1",type:"function",function:{name:"probe",arguments:'{"value":"ok"}'}}]}}]}));});
  for(const kind of ["openai_responses","openai_compatible_chat"]) {
    const provider=new HttpModelProvider({providerKind:kind,baseUrl,model:"synthetic"},"synthetic-key");
    const result=await provider.complete({messages:[{role:"user",content:"probe"}],tools:[{name:"probe",description:"synthetic",parameters:{type:"object",properties:{value:{type:"string"}}}}],signal:new AbortController().signal,stream:false});assert.equal(result.calls.length,1);assert.equal(result.usage,null);
  }
  assert.deepEqual(seen.map(x=>x.path),["/v1/responses","/v1/chat/completions"]);assert.ok(seen[0].body.input);assert.ok(seen[1].body.messages);assert.equal(providerUrl(baseUrl+"/responses","openai_responses"),baseUrl+"/responses");
});
test("streamed JSON waits for completed finish and interrupted arguments never become a tool call",async t=>{
  let truncated=false;
  const baseUrl=await mockServer(t,(_req,_body,res)=>{res.writeHead(200,{"Content-Type":"text/event-stream"});
    const emit=(event:Json)=>res.write("data: "+JSON.stringify(event)+"\n\n");
    emit({choices:[{delta:{tool_calls:[{index:0,id:"stream-1",function:{name:"probe",arguments:'{"value":'}}]}}]});
    if(!truncated){emit({choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"ok"}'}}]},finish_reason:"tool_calls"}]});res.write("data: [DONE]\n\n");}res.end();
  });
  const provider=new HttpModelProvider({providerKind:"openai_compatible_chat",baseUrl,model:"synthetic"},"synthetic-key"),request={messages:[],tools:[],signal:new AbortController().signal,stream:true};
  const turn=await provider.complete(request);assert.equal(turn.calls[0]?.arguments,'{"value":"ok"}');
  truncated=true;await assert.rejects(provider.complete(request),{code:"MODEL_STREAM_INTERRUPTED"});
});
test("provider authentication and 429 failures stay typed and bounded",async t=>{
  let status=401,requests=0;const baseUrl=await mockServer(t,(_req,_body,res)=>{requests++;res.writeHead(status,{"Retry-After":"2"});res.end("private diagnostic not exposed");});
  const provider=new HttpModelProvider({providerKind:"openai_responses",baseUrl,model:"synthetic"},"synthetic-key"),request={messages:[],tools:[],signal:new AbortController().signal,stream:false};
  await assert.rejects(provider.complete(request),{code:"MODEL_AUTH_FAILED"});status=429;await assert.rejects(provider.complete(request),{code:"MODEL_RATE_LIMITED"});assert.equal(requests,4);
});
