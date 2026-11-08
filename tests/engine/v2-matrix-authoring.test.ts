import {test} from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Repository} from "../../packages/persistence/src/repository.js";
import {Vault} from "../../packages/security/src/index.js";
import {Connectors} from "../../packages/mcp-connectors/src/registry.js";
import {Engine} from "../../packages/workflow-core/src/engine.js";
import {Application} from "../../packages/application/src/index.js";
import {startDaemon} from "../../apps/daemon/src/index.js";
import {readEndpoint} from "../../apps/daemon/src/local-config.js";
import {createClient,localHttpTransport} from "../../packages/mcp-connectors/src/index.js";
import {ScriptedModelProvider,type ModelTurn} from "../../packages/llm-providers/src/index.js";
import {hash,type Json} from "../../packages/contracts/src/domain.js";

function fixture(t:any) {
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo),engine=new Engine(repo,vault,new Connectors(repo,vault)),app=new Application(engine);
  t.after(async()=>{await app.close();await engine.close();db.close();});return {db,repo,vault,engine,app};
}

test("AUTHOR-01/02/03/04 matrix: two valid operations then an invalid third roll back the entire draft, command and event state",async t=>{
  const f=fixture(t),request={workflowId:"matrix-atomic",name:"矩阵原始流程",environment:"test",mode:"auto",template:"blank",idempotencyKey:"create"};
  const created=f.app.authoring.create(request);assert.equal(created.workflowId,request.workflowId);assert.equal(created.revision,1);assert.equal(f.app.authoring.get(created.workflowId).draft.environment,"test");
  const state=()=>hash({workflow:f.repo.get("workflows",created.workflowId),commands:f.repo.all("authoring_commands"),events:f.repo.changes(0,1000),journal:f.db.prepare("SELECT * FROM commands ORDER BY rowid").all()});
  const before=state();
  assert.throws(()=>f.app.authoring.patch({workflowId:created.workflowId,expectedRevision:1,idempotencyKey:"third-invalid",operations:[
    {op:"set_metadata",changes:{name:"must roll back"}},{op:"set_metadata",changes:{description:"also must roll back"}},
    {op:"update_node",nodeId:"missing",changes:{title:"invalid"}},
  ]}),{code:"NOT_FOUND"});assert.equal(state(),before);
  const change={workflowId:created.workflowId,expectedRevision:1,idempotencyKey:"exact",operations:[{op:"set_metadata",changes:{name:"唯一成功值"}}]};
  const saved=f.app.authoring.patch(change),accepted=state();assert.equal(saved.revision,2);assert.deepEqual(f.app.authoring.patch(change),saved);assert.equal(state(),accepted);
  assert.throws(()=>f.app.authoring.patch({...change,expectedRevision:2,operations:[{op:"set_metadata",changes:{name:"conflict"}}]}),{code:"IDEMPOTENCY_CONFLICT"});assert.equal(state(),accepted);
});

test("AUTHOR-05 matrix: an actual Web save wins while an in-flight assistant holds the same revision; its stale write cannot replace Web data",async t=>{
  let release!:()=>void,requested!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{requested=resolve;});
  const provider=new ScriptedModelProvider([async()=>{requested();await gate;return {text:"",calls:[{id:"stale-write",name:"workflow_draft_patch",arguments:JSON.stringify({workflowId:"web-ai-race",expectedRevision:1,idempotencyKey:"ai-stale",operations:[{op:"set_metadata",changes:{name:"must not replace Web"}}]})}],usage:null} as ModelTurn;},{text:"已收到冲突，保留网页修改。",calls:[],usage:null}]);
  const dataDir=await mkdtemp(join(tmpdir(),"flowhub-matrix-web-ai-")),daemon=await startDaemon({dataDir,port:0,providerFactory:()=>provider});
  t.after(async()=>{release();await daemon.close();await rm(dataDir,{recursive:true,force:true});});
  const app=daemon.application;app.authoring.create({workflowId:"web-ai-race",name:"original",environment:"test",mode:"auto",template:"blank",idempotencyKey:"create"});
  const profile=app.assistant.saveProfile({name:"Synthetic gated provider",providerKind:"openai_compatible_chat",baseUrl:"http://127.0.0.1:1/v1",model:"synthetic"}),session=app.assistant.session();
  const task=app.assistant.submit(session.id,{text:"将当前流程名称改为 must not replace Web，保存草稿",mode:"compose",requestedActions:["edit_draft"],context:{workflowId:"web-ai-race",revision:1},modelProfileId:profile.id,idempotencyKey:"message"});await entered;
  const base="http://127.0.0.1:"+daemon.port,password="Synthetic-matrix-password-041",auth=await fetch(base+"/api/v1/auth/bootstrap",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password,setupToken:await readFile(join(dataDir,"admin-setup-token"),"utf8")})});assert.equal(auth.status,200);
  const cookie=auth.headers.get("set-cookie")!.split(";")[0]!,csrf=((await auth.json())as Json).data.csrf;
  const web=await fetch(base+"/api/v2/workflows/web-ai-race/operations",{method:"POST",headers:{Cookie:cookie,"X-CSRF-Token":csrf,"If-Match":"1","Content-Type":"application/json"},body:JSON.stringify({expectedRevision:1,idempotencyKey:"web",operations:[{op:"set_metadata",changes:{name:"Web wins",description:"网页原值 token business@example.invalid"}}]})});assert.equal(web.status,200,await web.text());release();await app.assistant.settled();
  const state=app.assistant.task(task.taskId),draft=app.authoring.get("web-ai-race");assert.equal(state.status,"COMPLETED");assert.equal(state.tools.length,1);assert.equal(state.tools[0].result.error.code,"REVISION_CONFLICT");assert.equal(draft.revision,2);assert.equal(draft.draft.name,"Web wins");assert.equal(draft.draft.description,"网页原值 token business@example.invalid");assert.equal(daemon.engine.repo.all("versions").filter((v:Json)=>v.workflowId==="web-ai-race").length,0);
});

test("MCP-03/07/08 matrix: search omits schema bodies, get retrieves one schema and a new host session refreshes the fixed catalog after 100 drafts",async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),"flowhub-matrix-directory-")),daemon=await startDaemon({dataDir,port:0}),endpoint=await readEndpoint(dataDir),client=createClient("modern"),fresh=createClient("modern");
  t.after(async()=>{await client.close();await fresh.close();await daemon.close();await rm(dataDir,{recursive:true,force:true});});await client.connect(localHttpTransport(new URL(endpoint.url),endpoint.token));
  const invoke=async(c:typeof client,name:string,args:Json)=>{const r=await c.callTool({name,arguments:args});assert.notEqual(r.isError,true,JSON.stringify(r));return r.structuredContent as Json;};
  const inputSchema={type:"object",description:"MATRIX_SCHEMA_BODY_ONLY",properties:{value:{type:"string"}},required:["value"],additionalProperties:false};
  for(let i=0;i<2;i++)daemon.engine.repo.put("capabilities","matrix-cap-"+i,{id:"matrix-cap-"+i,capabilityId:"matrix-cap-"+i,revision:1,contextId:"matrix-context",kind:"mcp_tool",name:"matrix_read_"+i,description:"Synthetic paged capability",executor:"hub_direct",availability:"ready",enabled:"enabled",inputSchema,outputSchema:inputSchema,tool:{name:"matrix_read_"+i,inputSchema,outputSchema:inputSchema},sourceRefs:[]});
  const search=await invoke(client,"capability_search",{query:"matrix_read",limit:1});assert.equal(search.items.length,1);assert.ok(search.nextCursor);assert.ok(!JSON.stringify(search).includes("MATRIX_SCHEMA_BODY_ONLY"));
  for(const field of ["inputSchema","outputSchema","tool","skillContent"])assert.equal(Object.hasOwn(search.items[0],field),false);
  const summary=await invoke(client,"capability_get",{capabilityId:search.items[0].id});assert.equal(Object.hasOwn(summary,"inputSchema"),false);
  const detail=await invoke(client,"capability_get",{capabilityId:search.items[0].id,includeSchemas:true});assert.deepEqual(detail.inputSchema,inputSchema);assert.equal(detail.id,search.items[0].id);
  const names=(await client.listTools()).tools.map(tool=>tool.name);assert.equal(names.length,21);assert.equal(new Set(names).size,21);
  for(let i=0;i<100;i++)await invoke(client,"workflow_draft_create",{workflowId:"matrix-many-"+i,name:"Synthetic "+i,environment:"test",mode:"auto",template:"blank",idempotencyKey:"many-"+i});
  assert.deepEqual(await readEndpoint(dataDir),endpoint);assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),names);assert.equal(daemon.engine.repo.all("workflows").filter((w:Json)=>w.id.startsWith("matrix-many-")).length,100);
  await fresh.connect(localHttpTransport(new URL(endpoint.url),endpoint.token));assert.deepEqual((await fresh.listTools()).tools.map(tool=>tool.name),names);assert.match(fresh.getInstructions()??"",/refresh or start a new host session/);assert.match(fresh.getInstructions()??"",/cached seven-tool list is not evidence of an installation failure/);
});

test("TEST-03/04/05/06/07 matrix: independent branch receipts, missing fixtures and wrong expectations run with intercepted zero network and credential reads",async t=>{
  const f=fixture(t);f.vault.initialize("Synthetic-matrix-testing-password");const secret=f.vault.addSecret("Synthetic real connection credential","SYNTHETIC-MATRIX-AUTH",{purpose:"mcp_auth"});
  const inputSchema={type:"object",properties:{environment:{const:"test"}},required:["environment"],additionalProperties:false},outputSchema={type:"object",properties:{count:{type:"integer"},branch:{type:"string"}},required:["count","branch"],additionalProperties:false},tool={name:"read",inputSchema,outputSchema,schemaHash:"sha256:"+hash({inputSchema,outputSchema})};
  f.repo.put("connections","matrix-real-metadata",{id:"matrix-real-metadata",revision:1,transport:"streamable_http",protocolEra:"modern",endpoint:"https://never-contact.invalid/mcp",secretRef:secret.id,tools:[tool]});
  f.repo.put("bindings","matrix-binding",{id:"matrix-binding",revision:1,connectionId:"matrix-real-metadata",connectionRevision:1,environment:"test",allowedTools:["read"],lockedArguments:{"/environment":"test"},allowedQueryTemplates:[],maxRows:10,timeoutSeconds:5,simulationOnly:false,validationStatus:"BINDING_VERIFIED",verification:{serverEnforcedReadOnly:true,scope:"isolated metadata only"}});
  f.app.authoring.create({workflowId:"matrix-testing",name:"matrix-testing",environment:"test",mode:"auto",template:"blank",idempotencyKey:"create"});
  f.app.authoring.patch({workflowId:"matrix-testing",expectedRevision:1,idempotencyKey:"graph",operations:[
    {op:"set_input_schema",schema:{type:"object",properties:{flag:{type:"boolean"}},required:["flag"],additionalProperties:false}},
    {op:"set_binding",key:"read",bindingId:"matrix-binding"},{op:"add_node",nodeId:"choice",nodeType:"condition",title:"branch",config:{expression:{op:"eq",left:{ref:{source:"input",pointer:"/flag"}},right:{value:true}}}},
    ...["yes","no"].map(nodeId=>({op:"add_node",nodeId,nodeType:"mcp_tool",title:nodeId,config:{bindingKey:"read",toolName:"read",toolSchemaHash:tool.schemaHash,argumentsMappings:{}}})),
    {op:"disconnect",source:"input",target:"end",port:"next"},{op:"connect",source:"input",target:"choice",port:"next"},{op:"connect",source:"choice",target:"yes",port:"true"},{op:"connect",source:"choice",target:"no",port:"false"},...['yes','no'].map(source=>({op:"connect",source,target:"end",port:"next"})),
  ]});
  const make=(id:string,flag:boolean,missing=false,wrong=false)=>{const nodeId=flag?"yes":"no";return {id,name:id,inputs:{flag},mockResults:missing?[]:[{nodeId,capabilityId:"read",responseMode:"structured",result:{content:[],structuredContent:{count:1,branch:nodeId}}}],agentSubmissions:[],assertions:[{kind:"terminal_state",expected:"SUCCEEDED"},{kind:"tool_called",nodeId,expected:true},{kind:"tool_not_called",nodeId:flag?"no":"yes",expected:true},{kind:"output_equals",nodeId,pointer:"/count",expected:wrong?2:1}],expectedValidationErrors:[]};};
  const generated=f.app.testing.generate({workflowId:"matrix-testing",expectedRevision:2,strategy:"agent_proposed",proposedCases:[make("true",true),make("false",false),make("missing",true,true),make("wrong",true,false,true)],idempotencyKey:"generate"});
  assert.equal(f.repo.all("model_profiles").length,0);assert.equal(f.app.testing.getSuite(generated.suiteId).generatedBy,"agent_proposed");
  let network=0,reads=0,realCalls=0;
  t.mock.method(globalThis,"fetch",()=>{network++;throw new Error("Unexpected real fetch during Mock");});t.mock.method(f.vault,"secret",()=>{reads++;throw new Error("Unexpected real credential read during Mock");});t.mock.method(f.engine.connectors,"call",()=>{realCalls++;throw new Error("Unexpected real connector during Mock");});
  const request={suiteId:generated.suiteId,expectedSuiteRevision:1,mode:"mock",idempotencyKey:"run"},accepted=f.app.testing.run(request);await f.app.testing.idle();const result=f.app.testing.status(accepted.testRunId);
  assert.equal(result.status,"FAILED");assert.deepEqual(result.cases.map((c:Json)=>[c.id,c.status]),[["true","PASSED"],["false","PASSED"],["missing","UNCOVERED"],["wrong","FAILED"]]);assert.deepEqual(result.branchCoverage,[{nodeId:"choice",true:true,false:true}]);assert.equal(result.cases[2].errorCode,"FIXTURE_MISSING");
  const wrong=result.cases[3].assertions.find((a:Json)=>a.kind==="output_equals");assert.deepEqual({expected:wrong.expected,actual:wrong.actual,passed:wrong.passed},{expected:2,actual:1,passed:false});assert.equal(network,0);assert.equal(reads,0);assert.equal(realCalls,0);assert.equal(result.networkCalls,0);assert.equal(result.realSecretReads,0);
  f.app.authoring.patch({workflowId:"matrix-testing",expectedRevision:2,idempotencyKey:"edit",operations:[{op:"set_metadata",changes:{description:"r3"}}]});assert.equal(f.app.testing.status(accepted.testRunId).stale,true);const count=f.repo.all("workflow_test_runs").length;assert.throws(()=>f.app.testing.run({...request,idempotencyKey:"stale-run"}),{code:"TEST_BASELINE_STALE"});assert.equal(f.repo.all("workflow_test_runs").length,count);
});

test("TEST-01 matrix: no-Key deterministic normal, missing-required, wrong-type and both sides of numeric and string boundaries really execute",async t=>{
  const f=fixture(t);f.app.authoring.create({workflowId:"deterministic-matrix",name:"deterministic matrix",environment:"test",mode:"auto",template:"blank",idempotencyKey:"create"});
  f.app.authoring.patch({workflowId:"deterministic-matrix",expectedRevision:1,idempotencyKey:"schema",operations:[{op:"set_input_schema",schema:{type:"object",properties:{age:{type:"integer",minimum:1,maximum:3},name:{type:"string",minLength:1,maxLength:3}},required:["age","name"],additionalProperties:false}}]});
  const suite=f.app.testing.generate({workflowId:"deterministic-matrix",expectedRevision:2,strategy:"deterministic",idempotencyKey:"generate"}),stored=f.app.testing.getSuite(suite.suiteId);assert.equal(f.repo.all("model_profiles").length,0);assert.equal(f.vault.initialized,false);
  const ids=["normal","missing-age","missing-name","type-age","type-name","min-age","min-outside-age","max-age","max-outside-age","length-min-name","length-min-outside-name","length-max-name","length-max-outside-name"];
  assert.deepEqual(stored.cases.map((c:Json)=>c.id).sort(),ids.sort());
  const accepted=f.app.testing.run({suiteId:suite.suiteId,expectedSuiteRevision:1,mode:"mock",idempotencyKey:"run"});await f.app.testing.idle();const result=f.app.testing.status(accepted.testRunId);assert.equal(result.status,"SUCCEEDED");assert.equal(result.cases.length,ids.length);assert.ok(result.cases.every((c:Json)=>c.status==="PASSED"));
  for(const c of result.cases)assert.equal(c.errorCode,/missing-|type-|outside/.test(c.id)?"INPUT_INVALID":null,c.id);assert.equal(result.networkCalls,0);assert.equal(result.realSecretReads,0);
});

test("MCP-01 matrix: an execution-only identity completes all seven legacy request shapes through the official SDK",async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),"flowhub-matrix-legacy-")),daemon=await startDaemon({dataDir,port:0}),client=createClient("modern"),app=daemon.application;
  t.after(async()=>{await client.close();await daemon.close();await rm(dataDir,{recursive:true,force:true});});
  app.authoring.create({workflowId:"legacy-matrix",name:"Legacy matrix",environment:"test",mode:"guided",template:"blank",idempotencyKey:"create"});
  const reportSchema={type:"object",properties:{reportMarkdown:{type:"string"},evidenceRefs:{type:"array",items:{type:"string"}}},required:["reportMarkdown","evidenceRefs"],additionalProperties:false};
  app.authoring.patch({workflowId:"legacy-matrix",expectedRevision:1,idempotencyKey:"patch",operations:[
    {op:"add_node",nodeId:"analysis",nodeType:"agent_task",title:"Legacy analysis",config:{kind:"analysis",instructions:"Summarize only synthetic input",inputMappings:{},outputSchema:{type:"object",properties:{summary:{type:"string"}},required:["summary"],additionalProperties:false}}},
    {op:"add_node",nodeId:"report",nodeType:"report_template",title:"Legacy report",config:{templateRef:"incident-markdown/v1",inputMappings:{"/analysis":{ref:{source:"node",nodeId:"analysis",pointer:""}}},outputSchema:reportSchema}},
    {op:"disconnect",source:"input",target:"end",port:"next"},...[['input','analysis'],['analysis','report'],['report','end']].map(([source,target])=>({op:"connect",source,target,port:"next"})),
  ]});app.authoring.publish({workflowId:"legacy-matrix",expectedRevision:2,version:"1.0.0",expectedBindingRevisions:{},expectedCapabilityRevisions:{},idempotencyKey:"publish"});
  const base="http://127.0.0.1:"+daemon.port,auth=await fetch(base+"/api/v1/auth/bootstrap",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:"Synthetic-legacy-matrix-password",setupToken:await readFile(join(dataDir,"admin-setup-token"),"utf8")})});assert.equal(auth.status,200);
  const cookie=auth.headers.get("set-cookie")!.split(";")[0]!,csrf=((await auth.json())as Json).data.csrf,created=await fetch(base+"/api/v1/clients",{method:"POST",headers:{Cookie:cookie,"X-CSRF-Token":csrf,"Content-Type":"application/json"},body:JSON.stringify({label:"Legacy execution only",workflowAllowlist:["legacy-matrix"]})});assert.equal(created.status,200);
  const identity=((await created.json())as Json).data,endpoint=await readEndpoint(dataDir);await client.connect(localHttpTransport(new URL(endpoint.url),(await readFile(identity.absoluteTokenFile,"utf8")).trim()));
  const expected=["workflow_search","workflow_get","workflow_start","workflow_advance","workflow_status","workflow_cancel","artifact_read"],used=new Set<string>();assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),expected);
  const invoke=async(name:string,args:Json)=>{used.add(name);const result=await client.callTool({name,arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result));return result.structuredContent as Json;};
  const found=await invoke("workflow_search",{query:"Legacy matrix"});assert.ok(JSON.stringify(found).includes("legacy-matrix"));const version=await invoke("workflow_get",{workflowId:"legacy-matrix"});assert.equal(version.workflowId,"legacy-matrix");
  const wait=async(runId:string,target:string)=>{let status:Json;for(let i=0;i<200;i++){status=await invoke("workflow_status",{runId});if(status.state===target)return status;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail("Legacy run did not reach "+target);};
  const started=await invoke("workflow_start",{workflowId:"legacy-matrix",version:"1.0.0",mode:"guided",inputs:{},idempotencyKey:"start"}),checkpoint=await wait(started.runId,"WAITING_AGENT"),summary="Legacy raw token business@example.invalid";
  await invoke("workflow_advance",{runId:started.runId,checkpointId:checkpoint.checkpoint.id,checkpointToken:checkpoint.checkpoint.token,expectedRevision:checkpoint.revision,submission:{type:"agent_result",payload:{summary}},idempotencyKey:"advance"});
  const done=await wait(started.runId,"SUCCEEDED"),artifact=done.artifacts.find((value:Json)=>value.mimeType==="text/markdown");assert.ok(artifact);const report=await invoke("artifact_read",{runId:started.runId,artifactId:artifact.id,offset:0,maxBytes:262144});assert.ok(JSON.stringify(report).includes(summary));
  const pending=await invoke("workflow_start",{workflowId:"legacy-matrix",version:"1.0.0",mode:"guided",inputs:{},idempotencyKey:"cancel-run"}),waiting=await wait(pending.runId,"WAITING_AGENT");await invoke("workflow_cancel",{runId:pending.runId,expectedRevision:waiting.revision,reason:"Synthetic legacy compatibility cancellation",idempotencyKey:"cancel"});await wait(pending.runId,"CANCELLED");assert.deepEqual([...used].sort(),expected.sort());
});
