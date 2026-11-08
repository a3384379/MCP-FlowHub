import {test,type TestContext} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import Database from "better-sqlite3";
import {McpServer,fromJsonSchema} from "@modelcontextprotocol/server";
import {createLocalHttp} from "../../apps/daemon/src/http.js";
import {Repository} from "../../packages/persistence/src/repository.js";
import {Vault} from "../../packages/security/src/index.js";
import {Connectors} from "../../packages/mcp-connectors/src/registry.js";
import {Engine} from "../../packages/workflow-core/src/engine.js";
import {Application} from "../../packages/application/src/index.js";
import {WorkflowTesting} from "../../packages/workflow-testing/src/index.js";
import {inputContract,projectRoot,validArguments} from "../../packages/contracts/src/index.js";
import {hash,validate,type Json} from "../../packages/contracts/src/domain.js";

async function fixture(t:TestContext) {
  const state={calls:[] as Json[],delay:(_args:Json)=>0,isError:(_args:Json,_count:number)=>false};
  const server=createLocalHttp(()=>{
    const mcp=new McpServer({name:"synthetic-max-scoped",version:"1"},{capabilities:{tools:{}}});
    mcp.registerTool("read",{inputSchema:fromJsonSchema({type:"object",properties:{value:{type:"string"},environment:{const:"test"}},required:["value","environment"],additionalProperties:false}),
      outputSchema:fromJsonSchema({type:"object",properties:{value:{type:"string"},environment:{const:"test"},nullable:{type:"null"}},required:["value","nullable"],additionalProperties:false}),annotations:{readOnlyHint:true}},async(args:Json)=>{
      state.calls.push(args);const count=state.calls.length,delay=state.delay(args);if(delay)await new Promise(r=>setTimeout(r,delay));
      if(state.isError(args,count))return {isError:true,content:[{type:"text",text:"Synthetic acknowledged failure"}]};
      const result={environment:"test",value:args.value,nullable:null};return {structuredContent:result,content:[{type:"text",text:JSON.stringify(result)}]};
    });return mcp;
  },"Synthetic-scoped-max-token");
  await server.listen({host:"127.0.0.1",port:0});
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo);vault.initialize("Synthetic-scoped-max-password");
  const connectors=new Connectors(repo,vault),engine=new Engine(repo,vault,connectors),app=new Application(engine);
  t.after(async()=>{await app.close();await engine.close();await server.close();db.close();});
  const secret=vault.addSecret("Synthetic MCP token","Synthetic-scoped-max-token",{purpose:"mcp_auth"});
  const connection=await connectors.discover({id:"scoped-max",revision:1,transport:"streamable_http",endpoint:"http://127.0.0.1:"+(server.server.address() as any).port+"/mcp",allowedHosts:["127.0.0.1"],protocolEra:"modern",disabled:false,secretRef:secret.id});
  repo.put("connections",connection.id,connection);
  const binding={id:"scoped-max-binding",revision:1,connectionId:connection.id,connectionRevision:1,environment:"test",allowedTools:["read"],lockedArguments:{"/environment":"test"},allowedQueryTemplates:[],maxRows:10,timeoutSeconds:1,simulationOnly:false,validationStatus:"BINDING_VERIFIED",verification:{serverEnforcedReadOnly:true,scope:"Synthetic disposable loopback only"}};
  repo.put("bindings",binding.id,binding);
  app.authoring.create({workflowId:"scoped-max",name:"Synthetic max scoped regression",environment:"test",mode:"auto",template:"blank",idempotencyKey:"create"});
  const tool=connection.tools[0];
  app.authoring.patch({workflowId:"scoped-max",expectedRevision:1,idempotencyKey:"patch",operations:[
    {op:"set_input_schema",schema:{type:"object",properties:{value:{type:"string"}},required:["value"],additionalProperties:false}},
    {op:"set_binding",key:"read",bindingId:binding.id},{op:"add_node",nodeId:"read",nodeType:"mcp_tool",title:"Synthetic read",config:{bindingKey:"read",toolName:tool.name,toolSchemaHash:tool.schemaHash,argumentsMappings:{"/value":{ref:{source:"input",pointer:"/value"}}}}},
    {op:"disconnect",source:"input",target:"end",port:"next"},{op:"connect",source:"input",target:"read",port:"next"},{op:"connect",source:"read",target:"end",port:"next"}]});
  const makeCase=(id:string,assertions:Json[]=[{kind:"terminal_state",expected:"SUCCEEDED"}])=>({id,name:id,inputs:{value:id},mockResults:[{nodeId:"read",capabilityId:"read",responseMode:"structured",result:{environment:"test",value:id,nullable:null}}],agentSubmissions:[],assertions,expectedValidationErrors:[]});
  const suiteRequest=(cases:Json[],extra:Json={})=>({workflowId:"scoped-max",expectedRevision:2,strategy:"agent_proposed",proposedCases:cases,idempotencyKey:crypto.randomUUID(),...extra});
  const suite=(cases:Json[])=>app.testing.getSuite(app.testing.generate(suiteRequest(cases)).suiteId);
  const request=(suite:Json,extra:Json={})=>({suiteId:suite.id,expectedSuiteRevision:suite.suiteRevision,mode:"live",idempotencyKey:crypto.randomUUID(),allowedBindingIds:[binding.id],budgets:{maxCalls:5,timeoutMs:5000},inputScope:{fixtureHash:suite.fixtureHash,caseInputs:suite.cases.map((c:Json)=>({caseId:c.id,inputs:c.inputs}))},...extra});
  const execute=async(suite:Json,extra:Json={})=>{const args=request(suite,extra),receipt=app.testing.run(args);await app.testing.idle();return {args,receipt,run:app.testing.status(receipt.testRunId)};};
  return {state,app,repo,engine,makeCase,suiteRequest,suite,request,execute};
}

test("an expected OUTCOME_UNKNOWN cannot pass a live case, dispatch another case or replay after reconstruction",async t=>{
  const f=await fixture(t);f.state.delay=args=>args.value==="first"?1700:0;
  const workflow=f.repo.get("workflows","scoped-max");workflow.draft.budgets.maxRetries=2;f.repo.put("workflows",workflow.id,workflow);
  const suite=f.suite([f.makeCase("first",[{kind:"error_code",expected:"OUTCOME_UNKNOWN"},{kind:"terminal_state",expected:"OUTCOME_UNKNOWN"}]),f.makeCase("second")]);
  const {run,args,receipt}=await f.execute(suite);
  assert.equal(run.status,"FAILED",JSON.stringify(run));assert.equal(run.errorCode,"OUTCOME_UNKNOWN");assert.equal(run.outcomeUnknown,true);
  assert.equal(run.toolCalls,1);assert.equal(f.state.calls.length,1);assert.equal(run.cases[0].status,"FAILED");assert.equal(run.cases[0].executionState,"OUTCOME_UNKNOWN");
  assert.ok(!run.cases[0].events.some((e:Json)=>e.type==="TOOL_RETRY_SCHEDULED"));
  assert.ok(run.cases[0].assertions.every((a:Json)=>a.passed));assert.equal(run.cases[0].trace.length,1);assert.ok(run.cases[0].events.some((e:Json)=>e.type==="RUN_OUTCOME_UNKNOWN"));
  assert.equal(run.cases[1].status,"NOT_RUN");assert.equal(run.cases[1].errorCode,"OUTCOME_UNKNOWN");assert.equal(run.cases[1].trace.length,0);assert.equal(run.cases[1].assertions[0].evaluated,false);assert.equal(run.summary.notRun,1);
  assert.deepEqual(f.app.testing.run(args),receipt);await f.app.testing.idle();await f.app.testing.close();
  const recovered=new WorkflowTesting(f.app.authoring);assert.deepEqual(recovered.run(args),receipt);await recovered.idle();
  assert.equal(recovered.status(run.id).outcomeUnknown,true);assert.equal(f.state.calls.length,1);await recovered.close();
});

test("acknowledged MCP errors remain valid expected negatives and leave budget for the next case",async t=>{
  const f=await fixture(t);f.state.isError=args=>args.value==="known";
  const suite=f.suite([f.makeCase("known",[{kind:"error_code",expected:"TOOL_FAILED"},{kind:"terminal_state",expected:"FAILED"}]),f.makeCase("next")]);
  const {run}=await f.execute(suite,{budgets:{maxCalls:2,timeoutMs:5000}});
  assert.equal(run.status,"SUCCEEDED",JSON.stringify(run));assert.equal(run.outcomeUnknown,false);assert.equal(run.toolCalls,2);assert.equal(f.state.calls.length,2);
  assert.deepEqual(run.cases.map((c:Json)=>[c.status,c.executionState]),[["PASSED","FAILED"],["PASSED","SUCCEEDED"]]);
});

test("safe acknowledged read retries use the shared live call budget instead of being mistaken for unknown outcomes",async t=>{
  const f=await fixture(t);f.state.isError=(_args,count)=>count===1;
  const workflow=f.repo.get("workflows","scoped-max");workflow.draft.budgets.maxRetries=1;f.repo.put("workflows",workflow.id,workflow);
  const {run}=await f.execute(f.suite([f.makeCase("retry")]),{budgets:{maxCalls:2,timeoutMs:5000}});
  assert.equal(run.status,"SUCCEEDED",JSON.stringify(run));assert.equal(run.outcomeUnknown,false);assert.equal(run.toolCalls,2);assert.equal(f.state.calls.length,2);
  assert.equal(run.cases[0].events.filter((e:Json)=>e.type==="TOOL_RETRY_SCHEDULED").length,1);
});

test("shared assertion contracts reject missing targets, invalid expected types and ghost or wrong-kind draft references",async t=>{
  const f=await fixture(t),suiteSchema=JSON.parse(readFileSync(resolve(projectRoot,"contracts/test-suite.schema.json"),"utf8"));
  assert.deepEqual(suiteSchema.properties.cases.items.properties.assertions,inputContract.$defs.workflow_test_generate.properties.proposedCases.items.properties.assertions);
  for(const assertion of [{kind:"output_equals",expected:null},{kind:"argument_equals",expected:null},{kind:"node_state",expected:"SKIPPED"},{kind:"tool_called",expected:"true"},{kind:"tool_call_count",expected:-1},{kind:"tool_call_count",expected:"0"},{kind:"artifact_contains",expected:null},{kind:"terminal_state",expected:null},{kind:"node_state",nodeId:"read",expected:null}]) {
    const request=f.suiteRequest([f.makeCase("invalid",[assertion])]);
    assert.equal(validArguments("workflow_test_generate",request),false,JSON.stringify(assertion));assert.throws(()=>f.app.testing.generate(request),{code:"INPUT_INVALID"});
    assert.throws(()=>validate(suiteSchema,{id:"invalid",workflowId:"scoped-max",draftRevision:2,suiteRevision:1,capabilityRevisions:{},fixtureHash:"sha256:"+hash(request.proposedCases),generatedBy:"agent_proposed",mode:"mock",cases:request.proposedCases}),{code:"INPUT_INVALID"});
  }
  for(const assertion of [{kind:"tool_not_called",nodeId:"ghost",expected:true},{kind:"tool_call_count",nodeId:"ghost",expected:0},{kind:"node_state",nodeId:"ghost",expected:"SKIPPED"},{kind:"output_equals",nodeId:"ghost",pointer:"/missing",expected:null},{kind:"tool_called",nodeId:"input",expected:false},{kind:"argument_equals",nodeId:"input",expected:{}}])
    assert.throws(()=>f.app.testing.generate(f.suiteRequest([f.makeCase("invalid-target",[assertion])])),{code:"INPUT_INVALID"});
  const wrongMock=f.makeCase("wrong-mock");wrongMock.mockResults[0]!.nodeId="input";
  assert.throws(()=>f.app.testing.generate(f.suiteRequest([wrongMock])),{code:"INPUT_INVALID"});
  const wrongAgent:Json=f.makeCase("wrong-agent");wrongAgent.agentSubmissions=[{nodeId:"read",payload:{}}];
  assert.throws(()=>f.app.testing.generate(f.suiteRequest([wrongAgent])),{code:"INPUT_INVALID"});
  assert.equal(f.repo.all("workflow_test_suites").length,0);assert.equal(f.state.calls.length,0);
  const edited=f.suite([f.makeCase("old-suite")]);edited.cases[0].assertions=[{kind:"tool_not_called",nodeId:"ghost",expected:true}];f.repo.put("workflow_test_suites",edited.id,edited);
  assert.throws(()=>f.app.testing.run(f.request(edited)),{code:"INPUT_INVALID"});assert.equal(f.repo.all("workflow_test_runs").length,0);
});

test("missing assertion values fail independently while real null, default root and global trace assertions stay valid",async t=>{
  const f=await fixture(t),c=f.makeCase("read",[{kind:"output_equals",nodeId:"read",pointer:"/missing",expected:null},{kind:"argument_equals",nodeId:"read",pointer:"/missing",expected:null},{kind:"output_equals",nodeId:"read",pointer:"/nullable",expected:null},{kind:"argument_equals",nodeId:"read",expected:{value:"read",environment:"test"}},{kind:"output_equals",nodeId:"input",expected:{value:"read"}},{kind:"tool_called",expected:true},{kind:"tool_not_called",expected:false},{kind:"tool_call_count",expected:1}]);
  const suite=f.suite([c]),receipt=f.app.testing.run({suiteId:suite.id,expectedSuiteRevision:1,mode:"mock",idempotencyKey:"missing-value"});await f.app.testing.idle();
  const run=f.app.testing.status(receipt.testRunId);assert.equal(run.status,"FAILED");assert.deepEqual(run.cases[0].assertions.map((a:Json)=>a.passed),[false,false,true,true,true,true,true,true]);
  assert.ok(run.cases[0].assertions.slice(0,2).every((a:Json)=>a.evaluated===false&&a.errorCode==="REFERENCE_MISSING"));
  const invalid=f.makeCase("validation",[{kind:"error_code",expected:"INPUT_INVALID"},{kind:"output_equals",nodeId:"read",expected:null},{kind:"argument_equals",nodeId:"read",expected:null}]);invalid.inputs={} as Json;invalid.expectedValidationErrors=["INPUT_INVALID"] as Json;
  const invalidSuite=f.suite([invalid]),other=f.app.testing.run({suiteId:invalidSuite.id,expectedSuiteRevision:1,mode:"mock",idempotencyKey:"missing-output"});await f.app.testing.idle();
  const missing=f.app.testing.status(other.testRunId);assert.equal(missing.cases[0].assertions[1].passed,false);assert.equal(missing.cases[0].assertions[1].errorCode,"ASSERTION_VALUE_MISSING");
  assert.equal(missing.cases[0].assertions[2].passed,false);assert.equal(missing.cases[0].assertions[2].errorCode,"ASSERTION_VALUE_MISSING");
  assert.equal(f.state.calls.length,0);
});

test("resume keeps an older active generation visible before 51 newer terminal runs and applies owner, expiry and limit",async t=>{
  const f=await fixture(t),profile=f.app.assistant.saveProfile({name:"Synthetic pending",providerKind:"openai_responses",baseUrl:"https://example.invalid/v1",model:"synthetic"});
  let modelRequests=0;f.app.testing.configureAi(async request=>{request.onModelRequest();modelRequests++;return new Promise(()=>{});});
  const generation=f.app.testing.generate({workflowId:"scoped-max",expectedRevision:2,strategy:"ai_assisted",modelProfileId:profile.id,idempotencyKey:"pending"});
  for(let i=0;i<100&&modelRequests===0;i++)await new Promise(r=>setImmediate(r));assert.equal(modelRequests,1);
  const suite = f.suite([f.makeCase("normal")]);
  const generationCreatedAt = Date.parse(f.repo.get("workflow_test_runs", generation.testRunId).createdAt);
  // Seed completed history so list ordering is independent of Mock execution speed.
  for (let i = 1; i <= 51; i++) {
    const id = `newer-${i}`;
    f.repo.insert("workflow_test_runs", id, {
      id,
      suiteId: suite.id,
      workflowId: "scoped-max",
      owner: "admin",
      mode: "mock",
      status: "SUCCEEDED",
      createdAt: new Date(generationCreatedAt + i).toISOString(),
    });
  }
  f.repo.put("clients","other",{id:"other",revoked:false,scopes:["workflow:author"],workflowAllowlist:["scoped-max"]});
  f.repo.insert("workflow_test_runs","expired",{id:"expired",workflowId:"scoped-max",owner:"admin",status:"RUNNING",createdAt:"2099",resultsExpiredAt:"2099"});
  f.repo.insert("workflow_test_runs","other-active",{id:"other-active",workflowId:"scoped-max",owner:"other",status:"QUEUED",createdAt:"2000",PRIVATE:"Synthetic-private"});
  const admin=f.app.testing.listRuns("scoped-max"),other=f.app.testing.listRuns("scoped-max","other");
  assert.equal(admin.length,50);assert.ok(admin.slice(0,2).some((r:any)=>r.id===generation.testRunId));assert.ok(!admin.some((r:any)=>r.id==="expired"));
  assert.deepEqual(other.map((r:any)=>r.id),["other-active"]);assert.ok(!JSON.stringify(admin).includes("PRIVATE"));assert.ok(!Object.hasOwn(admin[0]!,"owner"));
  f.app.testing.cancel(generation.testRunId);await f.app.testing.idle();assert.equal(f.app.testing.status(generation.testRunId).status,"CANCELLED");assert.equal(f.state.calls.length,0);
});

test("manual suite revisions preserve initial AI origin and distinct revision sources without retaining replaced cases",async t=>{
  const f=await fixture(t),profile=f.app.assistant.saveProfile({name:"Synthetic proposal",providerKind:"openai_responses",baseUrl:"https://example.invalid/v1",model:"synthetic"});
  f.app.testing.configureAi(async request=>{request.onModelRequest();return {cases:[f.makeCase("original-ai")],usage:null};});
  const generation=f.app.testing.generate({workflowId:"scoped-max",expectedRevision:2,strategy:"ai_assisted",modelProfileId:profile.id,idempotencyKey:"ai-source"});await f.app.testing.idle();
  const generated=f.app.testing.status(generation.testRunId);assert.equal(generated.status,"SUCCEEDED",JSON.stringify(generated));
  const changed=f.app.testing.generate(f.suiteRequest([f.makeCase("manual-replacement")],{baseSuiteId:generated.suiteId,expectedSuiteRevision:1})),suite=f.app.testing.getSuite(changed.suiteId);
  assert.equal(suite.generatedBy,"agent_proposed");assert.equal(suite.generationRef,generation.testRunId);assert.deepEqual(suite.generationSource,{generatedBy:"ai_assisted",generationRef:generation.testRunId});
  assert.deepEqual(suite.revisionSources,[{suiteRevision:1,generatedBy:"ai_assisted",generationRef:generation.testRunId},{suiteRevision:2,generatedBy:"agent_proposed"}]);
  assert.deepEqual(suite.cases.map((c:Json)=>c.id),["manual-replacement"]);assert.ok(!JSON.stringify(suite).includes("original-ai"));assert.equal(suite.fixtureHash,"sha256:"+hash(suite.cases));
});
