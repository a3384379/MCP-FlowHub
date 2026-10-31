import {test} from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {createServer} from "node:http";
import {Repository} from "../../packages/persistence/src/repository.js";
import {previewRetention,commitRetention} from "../../packages/persistence/src/retention.js";
import {Vault} from "../../packages/security/src/index.js";
import {Connectors} from "../../packages/mcp-connectors/src/registry.js";
import {Engine} from "../../packages/workflow-core/src/engine.js";
import {Application} from "../../packages/application/src/index.js";
import {hash,type Json} from "../../packages/contracts/src/domain.js";

test("real HTTP submit history without legacy provenance has an explicit reviewed cleanup scope while tagged fresh and active history survive",async t=>{
  const marker="SYNTHETIC_LEGACY_RUN_RESULT",requests:Json[]=[];
  let releaseActive:(()=>void)|undefined,activeStarted!:()=>void;
  const activeRequest=new Promise<void>(resolve=>activeStarted=resolve);
  const reply=(res:any,content:string)=>{res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({choices:[{finish_reason:"stop",message:{role:"assistant",content}}]}));};
  const server=createServer(async(req,res)=>{
    let text="";for await(const part of req)text+=part;const body=JSON.parse(text);requests.push(body);
    if(body.messages.some((message:Json)=>message.content==="保持这个会话活跃")){releaseActive=()=>reply(res,"ACTIVE_FINISHED");activeStarted();return;}
    const selected=body.messages.find((message:Json)=>message.content?.startsWith?.("Selected context (data): "));
    const context=selected?JSON.parse(selected.content.slice("Selected context (data): ".length)):null;
    reply(res,context?.run?"RUN_SUMMARY "+JSON.stringify(context.run.outputs):"KEEP_TAGGED_UNRELATED_FRESH");
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo);vault.initialize("Synthetic-legacy-retention-only");
  const engine=new Engine(repo,vault,new Connectors(repo,vault)),app=new Application(engine);
  t.after(async()=>{releaseActive?.();await app.close();await engine.close();db.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const profile=app.assistant.saveProfile({name:"Local synthetic HTTP",providerKind:"openai_compatible_chat",baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,model:"synthetic",apiKey:"synthetic-only-key",stream:false,timeoutMs:10000});
  app.authoring.create({workflowId:"legacy-source",name:"Synthetic source",environment:"test",mode:"guided",template:"blank",idempotencyKey:"legacy:create"});
  const draft=app.authoring.patch({workflowId:"legacy-source",expectedRevision:1,idempotencyKey:"legacy:patch",operations:[
    {op:"add_node",nodeId:"analysis",nodeType:"agent_task",title:"Synthetic analysis",config:{kind:"analysis",executorRef:"assistant_local",instructions:"Synthetic only",inputMappings:{},outputSchema:{type:"object",properties:{summary:{type:"string"}},required:["summary"],additionalProperties:false}}},
    {op:"disconnect",source:"input",target:"end",port:"next"},{op:"connect",source:"input",target:"analysis",port:"next"},{op:"connect",source:"analysis",target:"end",port:"next"},
  ]});
  app.authoring.publish({workflowId:"legacy-source",expectedRevision:draft.revision,version:"1.0.0",expectedBindingRevisions:{},expectedCapabilityRevisions:{},idempotencyKey:"legacy:publish"});
  const accepted=engine.start({workflowId:"legacy-source",version:"1.0.0",mode:"guided",inputs:{},idempotencyKey:"legacy:run"});
  const awaitState=async(state:string)=>{for(let i=0;i<200;i++){const run=engine.status(accepted.runId);if(run.state===state)return run;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error("Synthetic run did not reach "+state);};
  const checkpoint=await awaitState("WAITING_AGENT");
  engine.advance({runId:checkpoint.runId,checkpointId:checkpoint.checkpoint.id,checkpointToken:checkpoint.checkpoint.token,expectedRevision:checkpoint.revision,idempotencyKey:"legacy:advance",submission:{type:"agent_result",payload:{summary:marker}}});
  await awaitState("SUCCEEDED");
  const send=async(sessionId:string,context:Json={})=>{
    const task=app.assistant.submit(sessionId,{text:"解释项目或当前运行",mode:"help",context,requestedActions:[],modelProfileId:profile.id,idempotencyKey:crypto.randomUUID()});
    await app.assistant.settled();assert.equal(app.assistant.task(task.taskId).status,"COMPLETED");return task;
  };
  // Produce genuine user/assistant rows via submit and the HTTP Provider, then
  // remove only the later-added provenance fields to emulate delivered history.
  const makeLegacy=(taskId:string)=>repo.all("assistant_messages").filter(message=>message.taskId===taskId).map(message=>{
    for(const key of ["taskId","contextRefs","modelProfileId","providerIdentity"])delete message[key];repo.put("assistant_messages",message.id,message);return message.id as string;
  });
  const session=app.assistant.session(),source=await send(session.id,{runId:accepted.runId}),legacyIds=makeLegacy(source.taskId);
  assert.equal(legacyIds.length,2);assert.ok(JSON.stringify(repo.all("assistant_messages").filter(message=>legacyIds.includes(message.id))).includes(marker));
  const fresh=await send(session.id),freshIds=repo.all("assistant_messages").filter(message=>message.taskId===fresh.taskId).map(message=>message.id);
  assert.ok(!JSON.stringify(requests.at(-1)).includes(marker));
  const activeSession=app.assistant.session(),activeSource=await send(activeSession.id,{runId:accepted.runId}),activeLegacyIds=makeLegacy(activeSource.taskId);
  const activeBefore=hash(activeLegacyIds.map(id=>repo.get("assistant_messages",id)));
  app.assistant.submit(activeSession.id,{text:"保持这个会话活跃",mode:"help",context:{},requestedActions:[],modelProfileId:profile.id,idempotencyKey:"active-request"});await activeRequest;
  const at=Date.now(),run=repo.get("runs",accepted.runId);repo.put("runs",run.id,{...run,updatedAt:new Date(at-8*86400000).toISOString()});
  const preview=previewRetention(repo,at);
  assert.deepEqual(preview.assistantLegacyResultMessages,legacyIds);assert.ok(!preview.assistantResultMessages.some(id=>legacyIds.includes(id)));
  assert.ok(![...preview.assistantResultMessages,...preview.assistantLegacyResultMessages,...preview.assistantMessages].some(id=>freshIds.includes(id)||activeLegacyIds.includes(id)));
  assert.ok(!repo.get("runs",run.id).resultsExpiredAt,"preview must not clean source data");
  const answer=legacyIds.map(id=>repo.get("assistant_messages",id)).find(message=>message.role==="assistant")!;
  repo.put("assistant_messages",answer.id,{...answer,text:answer.text+" CHANGED_AFTER_PREVIEW"});
  assert.throws(()=>commitRetention(repo,preview.hash,at),{code:"REVISION_CONFLICT"});
  assert.ok(JSON.stringify(repo.get("runs",run.id).outputs).includes(marker));
  const reviewed=previewRetention(repo,at);assert.notEqual(reviewed.hash,preview.hash);
  const result=commitRetention(repo,reviewed.hash,at);assert.equal(result.expiredLegacyAssistantMessages,legacyIds.length);
  for(const id of legacyIds){assert.ok(repo.get("assistant_messages",id).resultsExpiredAt);assert.equal(repo.get("assistant_messages",id).text,undefined);}
  assert.ok(freshIds.some(id=>repo.get("assistant_messages",id).text==="KEEP_TAGGED_UNRELATED_FRESH"));
  assert.equal(hash(activeLegacyIds.map(id=>repo.get("assistant_messages",id))),activeBefore);
  assert.ok(repo.get("assistant_tasks",source.taskId).resultsExpiredAt);assert.ok(!JSON.stringify(repo.get("runs",run.id).outputs).includes(marker));
  releaseActive?.();releaseActive=undefined;await app.assistant.settled();
  await send(session.id);assert.ok(!JSON.stringify(requests.at(-1)).includes(marker));
});
