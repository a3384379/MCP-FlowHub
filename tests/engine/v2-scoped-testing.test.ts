import {test} from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {McpServer,fromJsonSchema} from "@modelcontextprotocol/server";
import {createLocalHttp} from "../../apps/daemon/src/http.js";
import {Repository} from "../../packages/persistence/src/repository.js";
import {Vault} from "../../packages/security/src/index.js";
import {Connectors} from "../../packages/mcp-connectors/src/registry.js";
import {Engine} from "../../packages/workflow-core/src/engine.js";
import {Application} from "../../packages/application/src/index.js";
import {hash,type Json} from "../../packages/contracts/src/domain.js";

async function fixture(t:any) {
  const state={calls:[] as Json[],delay:0,kind:"string",token:"Synthetic-scoped-protocol-only"};
  const server=createLocalHttp(()=>{
    const mcp=new McpServer({name:"scoped-test-fixture",version:"1"},{capabilities:{tools:{}}});
    mcp.registerTool("read",{inputSchema:fromJsonSchema({type:"object",properties:{value:{type:state.kind},environment:{const:"test"}},required:["value","environment"],additionalProperties:false}),outputSchema:fromJsonSchema({type:"object",properties:{environment:{const:"test"},value:{type:"string"}},required:["environment","value"],additionalProperties:false}),annotations:{readOnlyHint:true}},async(args:Json)=>{
      state.calls.push(args);if(state.delay)await new Promise(r=>setTimeout(r,state.delay));const result={environment:"test",value:String(args.value)};
      return {content:[{type:"text",text:JSON.stringify(result)}],structuredContent:result};
    });return mcp;
  },state.token);
  await server.listen({host:"127.0.0.1",port:0});
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo);vault.initialize("Synthetic-scoped-test-password");
  const connectors=new Connectors(repo,vault),engine=new Engine(repo,vault,connectors),app=new Application(engine);
  t.after(async()=>{await app.close();await engine.close();await server.close();db.close();});
  const secret=vault.addSecret("Synthetic scope MCP token",state.token,{purpose:"mcp_auth"});
  const connection=await connectors.discover({id:"scoped",revision:1,transport:"streamable_http",endpoint:"http://127.0.0.1:"+(server.server.address() as any).port+"/mcp",allowedHosts:["127.0.0.1"],protocolEra:"modern",disabled:false,secretRef:secret.id});
  repo.put("connections",connection.id,connection);
  const binding={id:"scope-binding",revision:1,connectionId:connection.id,connectionRevision:1,environment:"test",allowedTools:["read"],lockedArguments:{"/environment":"test"},allowedQueryTemplates:[],maxRows:10,timeoutSeconds:5,simulationOnly:false,validationStatus:"BINDING_VERIFIED",verification:{serverEnforcedReadOnly:true,scope:"disposable read-only in-memory protocol fixture"}};
  repo.put("bindings",binding.id,binding);
  app.authoring.create({workflowId:"scoped-flow",name:"Scoped synthetic protocol test",environment:"test",mode:"auto",template:"blank",idempotencyKey:"create"});
  const tool=connection.tools[0];
  app.authoring.patch({workflowId:"scoped-flow",expectedRevision:1,idempotencyKey:"patch",operations:[{op:"set_input_schema",schema:{type:"object",properties:{value:{type:"string"}},required:["value"],additionalProperties:false}},{op:"set_binding",key:"read",bindingId:binding.id},{op:"add_node",nodeId:"read",nodeType:"mcp_tool",title:"Scoped read",config:{bindingKey:"read",toolName:tool.name,toolSchemaHash:tool.schemaHash,argumentsMappings:{"/value":{ref:{source:"input",pointer:"/value"}}}}},{op:"disconnect",source:"input",target:"end",port:"next"},{op:"connect",source:"input",target:"read",port:"next"},{op:"connect",source:"read",target:"end",port:"next"}]});
  const makeCase=(id:string,value:string)=>({id,name:id,inputs:{value},mockResults:[],agentSubmissions:[],assertions:[{kind:"terminal_state",expected:"SUCCEEDED"},{kind:"output_equals",nodeId:"read",pointer:"/value",expected:value}],expectedValidationErrors:[]});
  const generated=app.testing.generate({workflowId:"scoped-flow",expectedRevision:2,strategy:"agent_proposed",proposedCases:[makeCase("one","合成原值 token password"),makeCase("two","second")],idempotencyKey:"suite"});
  const suite=app.testing.getSuite(generated.suiteId);
  const request=(mode="live",extra:Json={})=>({suiteId:suite.id,expectedSuiteRevision:1,mode,idempotencyKey:crypto.randomUUID(),...(mode==="mock"?{}:{allowedBindingIds:[binding.id],budgets:{maxCalls:3,timeoutMs:3000}}),...(mode==="live"?{caseIds:["one"],inputScope:{fixtureHash:suite.fixtureHash,caseInputs:[{caseId:"one",inputs:suite.cases[0].inputs}]}}:{}),...extra});
  const execute=async(args:Json)=>{const accepted=app.testing.run(args);await app.testing.idle();return app.testing.status(accepted.testRunId);};
  return {app,repo,vault,state,engine,request,execute,suite,binding,connection};
}

test("contract performs real authenticated SDK catalog checks without tools/call or promoting binding validation",async t=>{
  const f=await fixture(t),before=hash(f.repo.get("bindings",f.binding.id));
  const run=await f.execute(f.request("contract"));assert.equal(run.status,"SUCCEEDED",JSON.stringify(run));assert.equal(run.validationLevel,"contract");
  assert.equal(run.toolCalls,0);assert.equal(f.state.calls.length,0);assert.equal(run.catalogChecks,1);assert.equal(run.cases.length,0);assert.equal(run.schemaChecks[0].passed,true);assert.equal(run.realSecretReads,null);
  assert.equal(hash(f.repo.get("bindings",f.binding.id)),before);
  f.state.kind="integer";const drift=await f.execute(f.request("contract"));assert.equal(drift.status,"FAILED");assert.equal(drift.schemaChecks[0].passed,false);assert.equal(f.state.calls.length,0);
});
test("resume lists bounded owner-scoped task metadata without historic inputs, prompts or expired receipts",async t=>{
  const f=await fixture(t);await f.execute(f.request("contract"));
  for(let i=0;i<60;i++)f.repo.insert("workflow_test_runs","metadata-"+i,{id:"metadata-"+i,owner:i%2?"other":"admin",workflowId:"scoped-flow",kind:"generation",mode:"generation",status:"RUNNING",createdAt:new Date(Date.now()+i).toISOString(),sourceSnapshot:{PRIVATE:"Synthetic prompt"},scope:{PRIVATE:"Synthetic input"},...(i===58?{resultsExpiredAt:new Date().toISOString()}:{})});
  f.repo.put("clients","other",{id:"other",revoked:false,scopes:["workflow:author"],workflowAllowlist:["scoped-flow"]});
  const admin=f.app.testing.listRuns("scoped-flow"),other=f.app.testing.listRuns("scoped-flow","other");
  assert.equal(admin.length,50);assert.equal(other.length,30);assert.ok(!admin.some((r:any)=>r.id==="metadata-58"));
  assert.ok(other.every((r:any)=>Number(r.id.slice(9))%2===1));assert.ok(!JSON.stringify(admin).includes("PRIVATE"));
  assert.ok(!Object.hasOwn(admin[0]!,"owner"));
  f.repo.put("clients","other",{...f.repo.get("clients","other"),revoked:true});assert.throws(()=>f.app.testing.listRuns("scoped-flow","other"),{code:"AUTH_REQUIRED"});
  for(const row of f.repo.all("workflow_test_runs"))if(row.kind==="generation")f.repo.put("workflow_test_runs",row.id,{...row,status:"CANCELLED"});
});
test("live uses the same isolated engine and original connector with exact reviewed inputs, raw evidence and idempotency",async t=>{
  const f=await fixture(t),args=f.request(),run=await f.execute(args);assert.equal(run.status,"SUCCEEDED",JSON.stringify(run));assert.equal(run.toolCalls,1);assert.equal(f.state.calls.length,1);
  assert.equal(run.cases[0].outputs.read.value,"合成原值 token password");assert.equal(run.cases[0].validationLevel,"live");assert.equal(run.provenance,"scoped_live_mcp");
  assert.equal(run.networkCalls,null);assert.equal(run.realSecretReads,null);assert.equal(f.repo.all("runs").length,0);assert.equal(f.repo.all("versions").length,0);
  assert.equal(f.app.testing.run(args).testRunId,run.id);await f.app.testing.idle();assert.equal(f.state.calls.length,1);
  assert.throws(()=>f.app.testing.run({...args,budgets:{...args.budgets,maxCalls:2}}),{code:"IDEMPOTENCY_CONFLICT"});
});
test("mode scope rejects missing fields, wrong binding, changed inputs and wrong owner before any dispatch",async t=>{
  const f=await fixture(t);
  for(const patch of [{allowedBindingIds:undefined},{budgets:undefined},{inputScope:undefined},{allowedBindingIds:["unrelated"]},{inputScope:{fixtureHash:f.suite.fixtureHash,caseInputs:[{caseId:"one",inputs:{value:"CHANGED"}}]}}]) {
    assert.throws(()=>f.app.testing.run(f.request("live",patch)));assert.equal(f.repo.all("workflow_test_runs").length,0);
  }
  f.repo.put("clients","other",{id:"other",revoked:false,scopes:["workflow:author"],workflowAllowlist:[]});
  assert.throws(()=>f.app.testing.run(f.request(),"other"),{code:"NOT_FOUND"});assert.equal(f.state.calls.length,0);
  f.vault.lock();assert.throws(()=>f.app.testing.run(f.request()),{code:"CREDENTIAL_LOCKED"});assert.equal(f.state.calls.length,0);
});
test("observational catalog refresh does not invalidate a live scope with unchanged configuration and schema revisions",async t=>{
  const f=await fixture(t),receipt=f.app.testing.run(f.request());
  const connection=f.repo.get("connections",f.connection.id);
  f.repo.put("connections",connection.id,{...connection,verifiedAt:new Date(Date.now()+1).toISOString(),updatedAt:new Date().toISOString(),history:[...(connection.history??[]),{at:new Date().toISOString(),hash:hash(connection.tools)}]});
  await f.app.testing.idle();const run=f.app.testing.status(receipt.testRunId);
  assert.equal(run.status,"SUCCEEDED",JSON.stringify(run));assert.equal(run.stale,false);assert.equal(f.state.calls.length,1);
});
test("live global call budget bounds all selected cases, and binding revocation stops dispatch without widening scope",async t=>{
  const f=await fixture(t),args=f.request("live",{caseIds:["one","two"],budgets:{maxCalls:1,timeoutMs:3000},inputScope:{fixtureHash:f.suite.fixtureHash,caseInputs:f.suite.cases.map((c:Json)=>({caseId:c.id,inputs:c.inputs}))}});
  const run=await f.execute(args);assert.equal(run.status,"FAILED");assert.equal(run.toolCalls,1);assert.equal(f.state.calls.length,1);assert.equal(run.cases[1].errorCode,"BUDGET_EXCEEDED");
  const receipt=f.app.testing.run(f.request());f.repo.put("bindings",f.binding.id,{...f.binding,revision:2,validationStatus:"REVOKED"});await f.app.testing.idle();
  const revoked=f.app.testing.status(receipt.testRunId);assert.equal(revoked.status,"FAILED");assert.equal(revoked.stale,true);assert.equal(f.state.calls.length,1);
});
test("live cancellation and timeout abort an actual pending MCP request, retain uncertain outcomes and never replay it",async t=>{
  const f=await fixture(t);f.state.delay=1400;
  const args=f.request(),receipt=f.app.testing.run(args);
  for(let i=0;i<200&&f.state.calls.length===0;i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.state.calls.length,1);
  f.app.testing.cancel(receipt.testRunId);await f.app.testing.idle();const cancelled=f.app.testing.status(receipt.testRunId);assert.equal(cancelled.status,"CANCELLED");assert.equal(cancelled.toolCalls,1);assert.equal(cancelled.outcomeUnknown,true);assert.ok(cancelled.cases[0].trace.length);assert.notEqual(cancelled.cases[0].executionState,"SUCCEEDED");
  f.app.testing.run(args);await f.app.testing.idle();assert.equal(f.state.calls.length,1);
  const timed=await f.execute(f.request("live",{budgets:{maxCalls:1,timeoutMs:1000}}));assert.equal(timed.status,"FAILED");
  assert.ok(["TEST_TIMEOUT","OUTCOME_UNKNOWN"].includes(timed.errorCode));assert.equal(timed.outcomeUnknown,true);
  assert.equal(timed.cases[0].executionState,"OUTCOME_UNKNOWN");assert.equal(timed.cases[0].trace.length,1);assert.equal(timed.toolCalls,1);
});
