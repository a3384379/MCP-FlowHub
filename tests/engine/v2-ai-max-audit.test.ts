import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import Database from "better-sqlite3";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { Application } from "../../packages/application/src/index.js";
import { HttpModelProvider } from "../../packages/llm-providers/src/index.js";
import { hash, HubError, type Json } from "../../packages/contracts/src/domain.js";

const modelKey="SYNTHETIC-MODEL-AUDIT-KEY";
const normal=(extra:Json={})=>({id:"normal",name:"合成正常用例",inputs:{},mockResults:[],agentSubmissions:[],assertions:[{kind:"terminal_state",expected:"SUCCEEDED"}],expectedValidationErrors:[],...extra});
function fixture(t:TestContext,baseUrl:string) {
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo);
  vault.initialize("Synthetic-max-ai-audit-password");
  const engine=new Engine(repo,vault,new Connectors(repo,vault)),app=new Application(engine);
  t.after(async()=>{await app.close();await engine.close();db.close();});
  app.authoring.create({workflowId:"ai-audit",name:"合成审计",environment:"test",mode:"auto",template:"blank",idempotencyKey:"create"});
  const profile=app.assistant.saveProfile({name:"Synthetic loopback model",providerKind:"openai_responses",baseUrl,model:"synthetic",stream:false,apiKey:modelKey});
  const request=()=>({workflowId:"ai-audit",expectedRevision:repo.get("workflows","ai-audit").revision,strategy:"ai_assisted",modelProfileId:profile.id,expectedModelRevision:profile.revision,idempotencyKey:"generate"});
  return {db,repo,vault,engine,app,profile,request};
}
async function providerServer(t:TestContext,handler:(res:ServerResponse,body:Json,attempt:number)=>void) {
  const stats={requests:0,bodies:[] as Json[]};
  const server=createServer(async(req,res)=>{
    let body="";for await(const part of req)body+=part;
    stats.requests++;const parsed=JSON.parse(body);stats.bodies.push(parsed);
    handler(res,parsed,stats.requests);
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
  return {baseUrl:"http://127.0.0.1:"+(server.address() as {port:number}).port+"/v1",stats};
}
function respond(res:ServerResponse,argumentsText:string,asText=false) {
  res.writeHead(200,{"Content-Type":"application/json"});
  res.end(JSON.stringify({status:"completed",output:asText?[{type:"message",content:[{type:"output_text",text:argumentsText}]}]:[{type:"function_call",call_id:"proposal",name:"submit_test_cases",arguments:argumentsText}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}));
}
function encodedProposal(cases:Json[],encoding:"literal"|"unicode"|"mixed") {
  const text=JSON.stringify({cases});
  if(encoding==="literal")return text;
  // Transform inner JSON string tokens while preserving their decoded values.
  return text.replace(/"(?:[^"\\]|\\.)*"/g,quoted=>'"'+(JSON.parse(quoted) as string).split("").map((character,index)=>
    encoding==="unicode"||index%2===0?"\\u"+character.charCodeAt(0).toString(16).padStart(4,"0"):JSON.stringify(character).slice(1,-1)).join("")+'"');
}
async function generated(f:ReturnType<typeof fixture>) {
  const accepted=f.app.testing.generate(f.request());await f.app.testing.idle();
  return f.app.testing.status(accepted.testRunId);
}
function noGeneratedWrites(f:ReturnType<typeof fixture>,workflowHash:string) {
  assert.equal(f.repo.all("workflow_test_suites").length,0);
  assert.equal(f.db.prepare<[],{count:number}>("SELECT count(*) AS count FROM commands WHERE key LIKE 'generated:%'").get()?.count,0);
  assert.equal(hash(f.repo.all("workflows")),workflowHash);
  assert.equal(f.repo.all("versions").length,0);
}

for(const encoding of ["literal","unicode","mixed"] as const)for(const asText of [false,true])test("AI rejects the decoded model credential in "+encoding+" "+(asText?"text JSON":"tool arguments"),async t=>{
  const server=await providerServer(t,res=>respond(res,encodedProposal([normal({name:modelKey})],encoding),asText));
  const f=fixture(t,server.baseUrl),before=hash(f.repo.all("workflows")),status=await generated(f);
  assert.equal(status.status,"FAILED");assert.equal(status.errorCode,"MODEL_OUTPUT_INVALID");assert.equal(status.modelCalls,1);
  assert.equal(server.stats.requests,1);assert.ok(!JSON.stringify(server.stats.bodies).includes(modelKey));
  assert.ok(!JSON.stringify(f.repo.all("workflow_test_runs")).includes(modelKey));
  noGeneratedWrites(f,before);
});

for(const placement of ["nested value","nested key"] as const)test("AI rejects a decoded connection credential containing quotes, backslash and newline in a "+placement,async t=>{
  const secret='SYNTHETIC-connection-"quoted"-\\path\nsecond-line';
  const inputs=placement==="nested key"?{nested:[{[secret]:"ordinary value"}]}:{nested:[{value:["ordinary",secret]}]};
  const server=await providerServer(t,res=>respond(res,encodedProposal([normal({inputs})],"mixed")));
  const f=fixture(t,server.baseUrl);f.vault.addSecret("Synthetic connection authentication",secret,{purpose:"mcp_auth"});
  const before=hash(f.repo.all("workflows")),status=await generated(f);
  assert.equal(status.status,"FAILED");assert.equal(status.errorCode,"MODEL_OUTPUT_INVALID");assert.equal(server.stats.requests,1);
  noGeneratedWrites(f,before);
});

test("AI rejects legacy connection authentication identified through actual secret references",async t=>{
  const secret="SYNTHETIC-LEGACY-CONNECTION-CREDENTIAL";
  const server=await providerServer(t,res=>respond(res,encodedProposal([normal({inputs:{nested:[secret]}})],"unicode")));
  const f=fixture(t,server.baseUrl),ref=f.vault.addSecret("Synthetic old secret",secret);
  f.repo.put("connections","legacy",{id:"legacy",revision:1,secretRef:ref.id});
  const before=hash(f.repo.all("workflows")),status=await generated(f);
  assert.equal(status.errorCode,"MODEL_OUTPUT_INVALID");noGeneratedWrites(f,before);
});

test("AI preserves ordinary token/password/email/URL values and Vault mcp_config bytes unchanged",async t=>{
  const config="ordinary-config-token@example.test",legacyConfig="legacy-ordinary-config";
  const business={password:"business-password",token:"business-token",email:"person@example.test",url:"https://example.test/?token=business-token",nested:[null,false,0,{config,legacyConfig,note:'password="business value"\n保留原文'}]};
  const cases=[normal({name:"业务 token/password 原值",inputs:business})];
  const server=await providerServer(t,res=>respond(res,encodedProposal(cases,"unicode"))),f=fixture(t,server.baseUrl);
  f.vault.addSecret("Synthetic ordinary configuration",config,{purpose:"mcp_config"});
  const legacy=f.vault.addSecret("Synthetic legacy configuration",legacyConfig);
  f.repo.put("connections","config",{id:"config",revision:1,envRefs:{REPORT_PATH:legacy.id},configurationKinds:{REPORT_PATH:"config"}});
  const contextText="业务 password=business-password token=business-token "+config+" "+legacyConfig;
  f.app.authoring.patch({workflowId:"ai-audit",expectedRevision:1,idempotencyKey:"business-context",operations:[{op:"set_metadata",changes:{name:contextText}}]});
  const status=await generated(f);assert.equal(status.status,"SUCCEEDED");
  assert.deepEqual(f.app.testing.getSuite(status.suiteId).cases,cases);assert.equal(server.stats.requests,1);
  assert.ok(server.stats.bodies[0].input.some((message:Json)=>String(message.content).includes(contextText)));
  assert.equal(Object.hasOwn(server.stats.bodies[0],"maxAttempts"),false);
});

for(const source of ["workflow","scenario hint"])test("AI context rejects an actual managed credential in "+source+" before copying it into task storage",async t=>{
  const server=await providerServer(t,res=>respond(res,JSON.stringify({cases:[normal()]}))),f=fixture(t,server.baseUrl);
  const secret="SYNTHETIC-MANAGED-CONTEXT-CREDENTIAL";f.vault.addSecret("Synthetic connection authentication",secret,{purpose:"mcp_auth"});
  if(source==="workflow")f.app.authoring.patch({workflowId:"ai-audit",expectedRevision:1,idempotencyKey:"context-secret",operations:[{op:"set_metadata",changes:{name:"合成工作流 "+secret}}]});
  const before=hash(f.repo.all("workflows"));
  assert.throws(()=>f.app.testing.generate({...f.request(),...(source==="scenario hint"?{scenarioHints:[secret]}:{})}),{code:"MODEL_CONTEXT_SENSITIVE"});
  assert.equal(server.stats.requests,0);assert.equal(f.repo.all("workflow_test_runs").length,0);
  assert.equal(f.db.prepare<[],{count:number}>("SELECT count(*) AS count FROM commands WHERE operation='test.generate'").get()?.count,0);
  noGeneratedWrites(f,before);
});

test("AI 429 dispatches one HTTP request and records failure instead of consuming hidden retries",async t=>{
  const server=await providerServer(t,(res,_body,attempt)=>{
    if(attempt<3){res.writeHead(429,{"Content-Type":"application/json","Retry-After":"0"});res.end(JSON.stringify({error:{code:"rate_limit",message:"synthetic private provider diagnostic"}}));}
    else respond(res,JSON.stringify({cases:[normal()]}));
  });
  const f=fixture(t,server.baseUrl),before=hash(f.repo.all("workflows")),request=f.request(),accepted=f.app.testing.generate(request);
  await f.app.testing.idle();const status=f.app.testing.status(accepted.testRunId);
  assert.equal(status.status,"FAILED");assert.equal(status.errorCode,"MODEL_RATE_LIMITED");assert.equal(status.modelCalls,1);assert.equal(server.stats.requests,1);
  assert.equal(f.repo.changes(0,100).filter(e=>e.type==="test.generation.model_requested").length,1);
  assert.deepEqual(f.app.testing.generate(request),accepted);await f.app.testing.idle();assert.equal(server.stats.requests,1);
  assert.ok(!JSON.stringify(status).includes("synthetic private provider diagnostic"));noGeneratedWrites(f,before);
});

test("ordinary assistant retains the default bounded 429 retry behavior",async t=>{
  const server=await providerServer(t,(res,_body,attempt)=>{
    if(attempt<3){res.writeHead(429,{"Retry-After":"0"});res.end("synthetic rate limit");}
    else respond(res,"合成回答",true);
  });
  const f=fixture(t,server.baseUrl),session=f.app.assistant.session();
  const accepted=f.app.assistant.submit(session.id,{text:"解释这个项目",mode:"help",modelProfileId:f.profile.id,context:{},requestedActions:[],idempotencyKey:"ordinary"});
  await f.app.assistant.settled();assert.equal(f.app.assistant.task(accepted.taskId).status,"COMPLETED");assert.equal(server.stats.requests,3);
});

test("HTTP attempt diagnostics honor the internal budget and cannot exceed three attempts",async t=>{
  const server=await providerServer(t,res=>{res.writeHead(429,{"Retry-After":"0"});res.end(JSON.stringify({error:{code:"rate_limit",message:modelKey}}));});
  const provider=new HttpModelProvider({providerKind:"openai_responses",baseUrl:server.baseUrl,model:"synthetic"},modelKey);
  const request={messages:[],tools:[],signal:new AbortController().signal,stream:false};
  for(const maxAttempts of [1,2,3]) {
    const before=server.stats.requests;
    await assert.rejects(provider.complete({...request,maxAttempts}),(error:unknown)=>{
      assert.ok(error instanceof HubError);assert.equal(error.code,"MODEL_RATE_LIMITED");assert.equal(error.details.attempts,maxAttempts);
      assert.ok(!JSON.stringify(error.details).includes(modelKey));return true;
    });
    assert.equal(server.stats.requests-before,maxAttempts);
  }
  const before=server.stats.requests;
  for(const maxAttempts of [0,4,1.5,NaN])await assert.rejects(provider.complete({...request,maxAttempts}),{code:"INPUT_INVALID"});
  assert.equal(server.stats.requests,before);
});

test("cancellation during the ordinary provider retry delay sends no later request",async t=>{
  let responded!:()=>void;const firstResponse=new Promise<void>(resolve=>responded=resolve);
  const server=await providerServer(t,res=>{res.writeHead(429,{"Retry-After":"1"});res.end("synthetic rate limit",responded);});
  const provider=new HttpModelProvider({providerKind:"openai_responses",baseUrl:server.baseUrl,model:"synthetic"},modelKey),controller=new AbortController();
  const pending=provider.complete({messages:[],tools:[],signal:controller.signal,stream:false});
  const rejected=assert.rejects(pending,{code:"TASK_CANCELLED"});
  await firstResponse;await new Promise(resolve=>setTimeout(resolve,25));controller.abort(new HubError("TASK_CANCELLED","Synthetic cancellation."));
  await rejected;assert.equal(server.stats.requests,1);
});
