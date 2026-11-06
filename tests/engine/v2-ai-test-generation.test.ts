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
import { previewRetention, commitRetention } from "../../packages/persistence/src/retention.js";

const normal={id:"normal",name:"合成正常分支",inputs:{},mockResults:[],agentSubmissions:[],assertions:[{kind:"terminal_state",expected:"SUCCEEDED"}],expectedValidationErrors:[]};
const proposal=(cases:Json[]=[normal]):ModelTurn=>({text:"",calls:[{id:"proposal",name:"submit_test_cases",arguments:JSON.stringify({cases})}],usage:{input_tokens:10,output_tokens:20,total_tokens:30}});
function fixture(t:TestContext,script:ConstructorParameters<typeof ScriptedModelProvider>[0]=[proposal()],injected=true) {
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo);vault.initialize("Synthetic-generation-password");
  const engine=new Engine(repo,vault,new Connectors(repo,vault)),provider=new ScriptedModelProvider(script),app=new Application(engine,injected?{providerFactory:()=>provider}:{});
  t.after(async()=>{await app.close();await engine.close();if(db.open)db.close();});
  app.authoring.create({workflowId:"generate",name:"生成用例",environment:"test",mode:"auto",template:"blank",idempotencyKey:"create"});
  const profile=app.assistant.saveProfile({name:"合成生成模型",providerKind:"openai_responses",baseUrl:"https://example.invalid/v1",model:"synthetic",stream:true});
  const request=(extra:Json={})=>({workflowId:"generate",expectedRevision:repo.get("workflows","generate").revision,strategy:"ai_assisted",modelProfileId:profile.id,expectedModelRevision:profile.revision,idempotencyKey:"ai-generate",...extra});
  return {db,repo,vault,engine,provider,app,profile,request};
}
async function started(provider:ScriptedModelProvider) {
  for(let i=0;i<100&&!provider.requests.length;i++)await new Promise(r=>setImmediate(r));
  assert.equal(provider.requests.length,1);
}
function connected(f:ReturnType<typeof fixture>) {
  const schema={type:"object",properties:{},additionalProperties:false},tool={name:"read",inputSchema:schema,outputSchema:schema,schemaHash:"sha256:"+hash({inputSchema:schema,outputSchema:schema})};
  f.repo.put("connections","connection",{id:"connection",revision:1,catalogSafetyVersion:1,tools:[tool],endpoint:"https://never-contact.invalid",secretRef:"DO-NOT-SEND-THIS-REF",envRefs:{AUTH:"DO-NOT-SEND-ENV"}});
  f.repo.put("bindings","binding",{id:"binding",revision:1,connectionId:"connection",connectionRevision:1,environment:"test",allowedTools:[tool.name],lockedArguments:{},allowedQueryTemplates:[],maxRows:10,timeoutSeconds:5,simulationOnly:true,validationStatus:"MOCK_VERIFIED"});
  const cap={id:"cap",capabilityId:"cap",revision:1,kind:"mcp_tool",name:"read",executor:"hub_direct",inputSchema:schema,outputSchema:schema,tool};
  f.repo.put("capabilities","cap",cap);f.repo.put("capability_revisions","cap@1",{...cap,id:"cap@1",capabilityRevision:1});
  f.app.authoring.patch({workflowId:"generate",expectedRevision:1,idempotencyKey:"connect",operations:[{op:"set_binding",key:"data",bindingId:"binding"},{op:"add_node",nodeId:"read",nodeType:"mcp_tool",title:"读取",capabilityRef:{capabilityId:"cap",revision:1},config:{bindingKey:"data",argumentsMappings:{}}},{op:"disconnect",source:"input",target:"end",port:"next"},{op:"connect",source:"input",target:"read",port:"next"},{op:"connect",source:"read",target:"end",port:"next"}]});
}

test("AI-assisted generation is one durable idempotent model proposal, then the shared suite validator and isolated engine run",async t=>{
  const f=fixture(t),request=f.request(),accepted=f.app.testing.generate(request),duplicate=f.app.testing.generate(request);
  assert.deepEqual(duplicate,accepted);assert.equal(accepted.generationId,accepted.testRunId);
  await f.app.testing.idle();const result=f.app.testing.status(accepted.testRunId);
  assert.equal(result.kind,"generation");assert.equal(result.status,"SUCCEEDED",JSON.stringify(result));assert.equal(result.caseCount,1);
  assert.equal(result.modelCalls,1);assert.deepEqual(result.usage,{input_tokens:10,output_tokens:20,total_tokens:30});assert.equal(result.usageAccounting,"reported");
  assert.equal(f.provider.requests.length,1);assert.deepEqual(f.provider.requests[0]!.tools.map(x=>x.name),["submit_test_cases"]);
  for(const key of ["sourceSnapshot","sourceBaseline","modelBaseline","request"])assert.equal(Object.hasOwn(result,key),false);
  assert.equal(f.app.testing.getSuite(result.suiteId).generatedBy,"ai_assisted");assert.equal(f.repo.all("workflow_test_suites").length,1);
  assert.deepEqual(f.app.testing.generate(request),accepted);assert.equal(f.provider.requests.length,1);
  assert.throws(()=>f.app.testing.generate({...request,scenarioHints:["different"]}),{code:"IDEMPOTENCY_CONFLICT"});
  assert.throws(()=>f.app.testing.generate({workflowId:"generate",expectedRevision:1,strategy:"deterministic",idempotencyKey:request.idempotencyKey}),{code:"IDEMPOTENCY_CONFLICT"});
  const run=f.app.testing.run({suiteId:result.suiteId,expectedSuiteRevision:result.suiteRevision,mode:"mock",idempotencyKey:"run"});await f.app.testing.idle();
  assert.equal(f.app.testing.status(run.testRunId).status,"SUCCEEDED");assert.equal(f.app.testing.status(run.testRunId).networkCalls,0);assert.equal(f.repo.all("versions").length,0);assert.equal(f.repo.all("runs").length,0);
});

for(const [label,turn,code] of [
  ["arbitrary tool",{text:"",calls:[{id:"bad",name:"workflow_draft_create",arguments:'{"workflowId":"forbidden"}'}],usage:null},"MODEL_OUTPUT_INVALID"],
  ["half JSON",{text:"",calls:[{id:"bad",name:"submit_test_cases",arguments:'{"cases":'}],usage:null},"TOOL_ARGUMENTS_INCOMPLETE"],
  ["invalid cases",{text:'{"cases":[{"id":"bad"}]}',calls:[],usage:null},"INPUT_INVALID"],
] as [string,ModelTurn,string][])test("AI-assisted generation rejects "+label+" without suite, workflow or publication writes",async t=>{
  const f=fixture(t,[turn]),before=hash(f.repo.all("workflows")),accepted=f.app.testing.generate(f.request());await f.app.testing.idle();
  const result=f.app.testing.status(accepted.testRunId);assert.equal(result.status,"FAILED");assert.equal(result.errorCode,code);assert.equal(f.repo.all("workflow_test_suites").length,0);
  assert.equal(hash(f.repo.all("workflows")),before);assert.equal(f.repo.all("versions").length,0);assert.equal(f.repo.all("assistant_tool_calls").length,0);
});

for(const drift of ["draft","capability","binding","connection","model","owner"])test("AI-assisted pending proposal rechecks "+drift+" before committing a suite",async t=>{
  let finish!:(value:ModelTurn)=>void;
  const f=fixture(t,[()=>new Promise(resolve=>finish=resolve)]);connected(f);
  f.repo.put("clients","owner",{id:"owner",revision:1,revoked:false,scopes:["workflow:author"],workflowAllowlist:["generate"]});
  const accepted=f.app.testing.generate(f.request(),"owner");await started(f.provider);
  const context=f.provider.requests[0]!.messages.map(m=>m.content).join("\n");
  for(const privateValue of ["never-contact.invalid","DO-NOT-SEND-THIS-REF","DO-NOT-SEND-ENV"])assert.ok(!context.includes(privateValue));
  if(drift==="draft")f.app.authoring.patch({workflowId:"generate",expectedRevision:2,idempotencyKey:"edit",operations:[{op:"set_metadata",changes:{name:"Changed draft"}}]});
  else if(drift==="model")f.app.assistant.saveProfile({name:"Changed model",providerKind:"openai_responses",baseUrl:"https://example.invalid/v1",model:"changed",expectedRevision:1},f.profile.id);
  else if(drift==="owner")f.repo.put("clients","owner",{...f.repo.get("clients","owner"),revision:2,revoked:true});
  else {const table=drift==="capability"?"capabilities":drift==="binding"?"bindings":"connections",key=drift==="capability"?"cap":drift;
    f.repo.put(table,key,{...f.repo.get(table,key),revision:2});}
  finish(proposal());await f.app.testing.idle();
  const result=f.repo.get("workflow_test_runs",accepted.testRunId);assert.equal(result.status,"FAILED");assert.equal(result.errorCode,drift==="owner"?"AUTH_REQUIRED":drift==="model"?"REVISION_CONFLICT":drift==="capability"?"CAPABILITY_STALE":"TEST_BASELINE_STALE");
  assert.equal(f.repo.all("workflow_test_suites").length,0);
});

test("AI generation tolerates timestamp-only catalog refreshes with unchanged revisions and contracts",async t=>{
  let finish!:(value:ModelTurn)=>void;
  const f=fixture(t,[()=>new Promise(resolve=>finish=resolve)]);connected(f);
  const accepted=f.app.testing.generate(f.request());await started(f.provider);
  const at=new Date().toISOString();f.repo.put("capabilities","cap",{...f.repo.get("capabilities","cap"),discoveredAt:at,updatedAt:at,lastSeenAt:at});
  f.repo.put("connections","connection",{...f.repo.get("connections","connection"),verifiedAt:at,updatedAt:at,history:[{observedAt:at}]});
  finish(proposal());await f.app.testing.idle();const status=f.app.testing.status(accepted.testRunId);
  assert.equal(status.status,"SUCCEEDED",JSON.stringify(status));assert.equal(status.stale,false);assert.equal(f.repo.all("workflow_test_suites").length,1);
});

test("AI generation cancellation wins over late model output and close/restart never replays a proposal",async t=>{
  let finish!:(value:ModelTurn)=>void;
  const f=fixture(t,[()=>new Promise(resolve=>finish=resolve),()=>new Promise(()=>{})]),request=f.request(),accepted=f.app.testing.generate(request);
  await started(f.provider);assert.throws(()=>f.app.assistant.deleteProfile(f.profile.id),{code:"PROFILE_IN_USE"});
  assert.equal(f.app.testing.cancel(accepted.testRunId).status,"CANCELLED");await f.app.testing.idle();finish(proposal());await new Promise(r=>setImmediate(r));
  assert.equal(f.app.testing.status(accepted.testRunId).status,"CANCELLED");assert.equal(f.repo.all("workflow_test_suites").length,0);
  const second=f.app.testing.generate(f.request({idempotencyKey:"close"}));
  for(let i=0;i<100&&f.provider.requests.length<2;i++)await new Promise(r=>setImmediate(r));
  assert.equal(f.provider.requests.length,2);
  // Widen only the shutdown ordering window; this disposal substitute does not
  // represent a real MCP execution or an additional model request.
  const otherDisposal={close:async()=>{await new Promise(resolve=>setTimeout(resolve,25));}},activeEngines=(f.app.testing as unknown as {activeEngines:Set<typeof otherDisposal>}).activeEngines;
  activeEngines.add(otherDisposal);
  try{await f.app.close();}finally{activeEngines.delete(otherDisposal);}
  assert.equal(f.repo.get("workflow_test_runs",second.testRunId).status,"INTERRUPTED");
  const restarted=new Application(f.engine,{providerFactory:()=>f.provider});
  try{assert.deepEqual(restarted.testing.generate(request),accepted);await restarted.testing.idle();assert.equal(f.provider.requests.length,2);assert.equal(f.repo.all("workflow_test_suites").length,0);}finally{await restarted.close();}
});

test("AI generation missing model credentials is explicit while deterministic generation remains available",async t=>{
  const f=fixture(t,[],false),accepted=f.app.testing.generate(f.request());await f.app.testing.idle();
  assert.equal(f.app.testing.status(accepted.testRunId).errorCode,"MODEL_NOT_CONFIGURED");assert.equal(f.app.testing.status(accepted.testRunId).modelCalls,0);assert.equal(f.repo.all("workflow_test_suites").length,0);
  const deterministic=f.app.testing.generate({workflowId:"generate",expectedRevision:1,strategy:"deterministic",idempotencyKey:"no-key"});
  assert.equal(f.app.testing.getSuite(deterministic.suiteId).cases.length,1);
});

test("AI generation locked Vault and failed Provider do not leak credential material or create partial suites",async t=>{
  const f=fixture(t,[]),key="SYNTHETIC-PRIVATE-API-KEY";
  f.app.assistant.saveProfile({name:"Encrypted synthetic",providerKind:"openai_responses",baseUrl:"https://example.invalid/v1",model:"synthetic",apiKey:key,expectedRevision:1},f.profile.id);f.vault.lock();
  const accepted=f.app.testing.generate(f.request({expectedModelRevision:2}));await f.app.testing.idle();const result=f.app.testing.status(accepted.testRunId);
  assert.equal(result.status,"FAILED");assert.equal(result.errorCode,"CREDENTIAL_LOCKED");assert.equal(result.modelCalls,0);assert.equal(f.provider.requests.length,0);assert.equal(f.repo.all("workflow_test_suites").length,0);
  assert.ok(!JSON.stringify(result).includes(key));assert.ok(!JSON.stringify(f.repo.all("workflow_test_runs")).includes(key));
});

test("AI generation bounds context before acceptance and response before suite creation",async t=>{
  const f=fixture(t,[{text:" ".repeat(524289),calls:[],usage:null}]);
  const accepted=f.app.testing.generate(f.request());await f.app.testing.idle();assert.equal(f.app.testing.status(accepted.testRunId).errorCode,"BUDGET_EXCEEDED");
  f.app.authoring.patch({workflowId:"generate",expectedRevision:1,idempotencyKey:"large-input",operations:[{op:"set_input_schema",schema:{type:"object",properties:{large:{type:"string",enum:["x".repeat(65536)]}},additionalProperties:false}}]});
  assert.throws(()=>f.app.testing.generate(f.request({idempotencyKey:"too-large"})),{code:"BUDGET_EXCEEDED"});assert.equal(f.repo.all("workflow_test_runs").length,1);assert.equal(f.repo.all("workflow_test_suites").length,0);
});

test("generation and contract/live result expiry retains truthful mode metadata and never repeats accepted model work",async t=>{
  const f=fixture(t),request=f.request(),accepted=f.app.testing.generate(request);await f.app.testing.idle();
  const timestamp=Date.now(),old=new Date(timestamp-8*86400000).toISOString(),marker="SYNTHETIC_EXPIRED_TEST_INPUT";
  const generation=f.repo.get("workflow_test_runs",accepted.testRunId);
  f.repo.put("workflow_test_runs",generation.id,{...generation,createdAt:old,completedAt:old,updatedAt:old});
  for(const mode of ["contract","live"])f.repo.put("workflow_test_runs",mode,{id:mode,owner:"admin",mode,status:"SUCCEEDED",createdAt:old,completedAt:old,validationLevel:mode,provenance:mode==="contract"?"mcp_catalog_only":"scoped_live_mcp",toolCalls:mode==="live"?1:0,catalogChecks:1,networkCalls:null,realSecretReads:null,credentialReadAccounting:"not_instrumented",scopeHash:hash(marker),scope:{inputs:marker},outputs:{value:marker},sourceSnapshot:{marker},request:{marker}});
  f.repo.put("workflow_test_runs","active-generation",{id:"active-generation",kind:"generation",mode:"generation",owner:"admin",status:"RUNNING",createdAt:old,sourceSnapshot:{marker}});
  const preview=previewRetention(f.repo,timestamp);assert.ok(preview.workflowTestResultRuns.includes(generation.id));assert.ok(!preview.workflowTestResultRuns.includes("active-generation"));
  commitRetention(f.repo,preview.hash,timestamp);
  for(const mode of ["contract","live"]) {
    const record=f.repo.get("workflow_test_runs",mode);assert.equal(record.mode,mode);assert.equal(record.validationLevel,mode);assert.equal(record.toolCalls,mode==="live"?1:0);assert.equal(record.realSecretReads,null);assert.equal(record.networkCalls,null);assert.ok(record.resultsExpiredAt);assert.ok(!JSON.stringify(record).includes(marker));
    for(const key of ["scope","outputs","sourceSnapshot","request"])assert.equal(Object.hasOwn(record,key),false);
  }
  const expired=f.app.testing.status(generation.id);assert.equal(expired.kind,"generation");assert.equal(expired.mode,"generation");assert.equal(expired.status,"SUCCEEDED");assert.ok(expired.resultsExpiredAt);assert.equal(expired.stale,true);assert.equal(expired.modelCalls,1);
  assert.throws(()=>f.app.testing.generate(request),{code:"RESULT_EXPIRED"});assert.equal(f.provider.requests.length,1);assert.equal(f.repo.all("workflow_test_suites").length,1);
  assert.equal(f.repo.get("workflow_test_runs","active-generation").sourceSnapshot.marker,marker);
});

test("generation rejects credential-bearing catalog descriptions before persistence while preserving business text",async t=>{
  const f=fixture(t);connected(f);const secret="SYNTHETIC-AUTH-CREDENTIAL";
  f.vault.addSecret("Synthetic connection authentication",secret,{purpose:"mcp_auth"});
  const connection=f.repo.get("connections","connection");connection.tools[0].description="Private credential "+secret;f.repo.put("connections","connection",connection);
  assert.throws(()=>f.app.testing.generate(f.request()),{code:"CATALOG_SENSITIVE"});assert.equal(f.repo.all("workflow_test_runs").length,0);assert.equal(f.provider.requests.length,0);
  connection.tools[0].description="合成工具说明";f.repo.put("connections","connection",connection);
  f.app.authoring.patch({workflowId:"generate",expectedRevision:2,idempotencyKey:"business-text",operations:[{op:"update_node",nodeId:"read",changes:{title:"业务 token=business-value 保持原文"}}]});
  const accepted=f.app.testing.generate(f.request());await f.app.testing.idle();assert.equal(f.app.testing.status(accepted.testRunId).status,"SUCCEEDED");
  assert.ok(f.provider.requests[0]!.messages.some(message=>String(message.content).includes("token=business-value")));assert.ok(!JSON.stringify(f.repo.get("workflow_test_runs",accepted.testRunId)).includes(secret));
});

for(const mode of ["contract","live"])test("the chat assistant cannot authorize "+mode+" merely by inventing an explicit test scope",async t=>{
  const f=fixture(t,[]);connected(f);
  const generated=f.app.testing.generate({workflowId:"generate",expectedRevision:2,strategy:"agent_proposed",proposedCases:[normal],idempotencyKey:"suite"}),suite=f.app.testing.getSuite(generated.suiteId);
  const args={suiteId:suite.id,expectedSuiteRevision:suite.suiteRevision,mode,caseIds:[normal.id],allowedBindingIds:["binding"],budgets:{maxCalls:1,timeoutMs:1000},inputScope:{fixtureHash:suite.fixtureHash,caseInputs:[{caseId:normal.id,inputs:{}}]},idempotencyKey:"model-created-scope"};
  f.provider.script.push({text:"",calls:[{id:"invented",name:"workflow_test_run",arguments:JSON.stringify(args)}],usage:null});
  let dispatched=0;t.mock.method(f.app.testing,"run",()=>{dispatched++;throw new Error("must never dispatch");});
  const session=f.app.assistant.session(),accepted=f.app.assistant.submit(session.id,{text:"生成用例并自测当前流程",mode:"compose",modelProfileId:f.profile.id,context:{workflowId:"generate"},requestedActions:["test"],idempotencyKey:"chat-test"});
  await f.app.assistant.settled();assert.equal(f.app.assistant.task(accepted.taskId).errorCode,"INTENT_NOT_ALLOWED");assert.equal(dispatched,0);assert.equal(f.repo.all("workflow_test_runs").length,0);assert.equal(f.repo.all("assistant_tool_calls").length,0);
});

test("the chat assistant submits cases itself instead of spawning nested AI-generation model tasks",async t=>{
  const f=fixture(t,[]);f.provider.script.push({text:"",calls:[{id:"nested",name:"workflow_test_generate",arguments:JSON.stringify(f.request())}],usage:null});
  const session=f.app.assistant.session(),accepted=f.app.assistant.submit(session.id,{text:"生成用例并自测当前流程",mode:"compose",modelProfileId:f.profile.id,context:{workflowId:"generate"},requestedActions:["test"],idempotencyKey:"nested-test"});
  await f.app.assistant.settled();assert.equal(f.app.assistant.task(accepted.taskId).errorCode,"INTENT_NOT_ALLOWED");assert.equal(f.provider.requests.length,1);assert.equal(f.repo.all("workflow_test_runs").length,0);assert.equal(f.repo.all("workflow_test_suites").length,0);
});
