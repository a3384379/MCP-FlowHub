import {test} from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Repository} from "../../packages/persistence/src/repository.js";
import {Vault} from "../../packages/security/src/index.js";
import {Connectors} from "../../packages/mcp-connectors/src/registry.js";
import {Engine} from "../../packages/workflow-core/src/engine.js";
import {Application} from "../../packages/application/src/index.js";
import {WorkflowTesting} from "../../packages/workflow-testing/src/index.js";
import {hash,type Json} from "../../packages/contracts/src/domain.js";

function setup(t:any,mode="auto") {
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo);vault.initialize("Synthetic-reaudit-password");
  const connectors=new Connectors(repo,vault),engine=new Engine(repo,vault,connectors),app=new Application(engine);
  t.after(async()=>{await app.close();await engine.close();db.close();});
  app.authoring.create({workflowId:"reaudit",name:"reaudit",environment:"test",mode,template:"blank",idempotencyKey:"create"});
  return {db,repo,vault,connectors,engine,app};
}
const plainCase=(id="normal")=>({id,name:id,inputs:{},mockResults:[],agentSubmissions:[],assertions:[{kind:"terminal_state",expected:"SUCCEEDED"}],expectedValidationErrors:[]});
function generate(f:ReturnType<typeof setup>,cases:Json[],extra:Json={}) {
  return f.app.testing.generate({workflowId:"reaudit",expectedRevision:f.app.authoring.get("reaudit").revision,strategy:"agent_proposed",proposedCases:cases,idempotencyKey:"generate",...extra});
}
async function run(f:ReturnType<typeof setup>,suite:Json,key="run") {
  const accepted=f.app.testing.run({suiteId:suite.suiteId,expectedSuiteRevision:suite.suiteRevision,mode:"mock",idempotencyKey:key});
  await f.app.testing.idle();return f.app.testing.status(accepted.testRunId);
}
function wire(f:ReturnType<typeof setup>,node:Json,extra:Json[]=[]) {
  return f.app.authoring.patch({workflowId:"reaudit",expectedRevision:1,idempotencyKey:"patch",operations:[...extra,node,
    {op:"disconnect",source:"input",target:"end",port:"next"},{op:"connect",source:"input",target:node.nodeId,port:"next"},{op:"connect",source:node.nodeId,target:"end",port:"next"}]});
}
const inputSchema={type:"object",properties:{},additionalProperties:false};
function host(f:ReturnType<typeof setup>,outputSchema:Json) {
  const capability={id:"host",capabilityId:"host",revision:1,kind:"mcp_tool",name:"native_read",executor:"codex_host",inputSchema,outputSchema};
  f.repo.put("capabilities","host",capability);f.repo.put("capability_revisions","host@1",{...capability,id:"host@1",capabilityRevision:1});
  const patched=wire(f,{op:"add_node",nodeId:"host",nodeType:"agent_task",title:"host",capabilityRef:{capabilityId:"host",revision:1},config:{kind:"host_tool",executorRef:"codex_host",instructions:"Synthetic host contract",inputMappings:{},outputSchema}});
  return {capability,patched};
}

test("accepted test baselines stay stale after same-fixture suite regeneration and capability drift",async t=>{
  const f=setup(t),cases=[plainCase()],suite=generate(f,cases),old=await run(f,suite);
  assert.equal(old.status,"SUCCEEDED");assert.equal(old.stale,false);
  f.app.authoring.patch({workflowId:"reaudit",expectedRevision:1,idempotencyKey:"layout",operations:[{op:"move_nodes",expectedLayoutRevision:1,positions:[{nodeId:"input",x:40,y:40}]}]});
  assert.equal(f.app.testing.status(old.id).stale,false);
  f.app.authoring.patch({workflowId:"reaudit",expectedRevision:1,idempotencyKey:"required-input",operations:[{op:"set_input_schema",schema:{type:"object",properties:{amount:{type:"integer"}},required:["amount"],additionalProperties:false}}]});
  assert.equal(f.app.testing.status(old.id).stale,true);
  const regenerated=generate(f,cases,{baseSuiteId:suite.suiteId,expectedSuiteRevision:1,idempotencyKey:"regenerate"});
  assert.equal(f.app.testing.getSuite(suite.suiteId).fixtureHash,old.fixtureHash);assert.equal(f.app.testing.status(old.id).stale,true);
  const fresh=await run(f,regenerated,"fresh");assert.equal(fresh.status,"FAILED");assert.equal(fresh.cases[0].errorCode,"INPUT_INVALID");
  generate(f,[{...plainCase(),inputs:{amount:1}}],{baseSuiteId:suite.suiteId,expectedSuiteRevision:2,idempotencyKey:"change-fixture"});
  generate(f,cases,{baseSuiteId:suite.suiteId,expectedSuiteRevision:3,idempotencyKey:"restore-fixture"});
  assert.equal(f.app.testing.getSuite(suite.suiteId).fixtureHash,old.fixtureHash);assert.equal(f.app.testing.status(old.id).stale,true);
  const legacy=f.repo.get("workflow_test_runs",old.id);delete legacy.acceptedSuite;delete legacy.executionSnapshot;delete legacy.capabilityRevisions;
  f.repo.put("workflow_test_runs",old.id,legacy);assert.equal(f.app.testing.status(old.id).stale,true);
  await t.test("changing then restoring fixture contents does not renew a run at the same draft revision",async sub=>{
    const h=setup(sub),original=[plainCase()],s=generate(h,original),r=await run(h,s);
    generate(h,[plainCase("replacement")],{baseSuiteId:s.suiteId,expectedSuiteRevision:1,idempotencyKey:"replace"});
    generate(h,original,{baseSuiteId:s.suiteId,expectedSuiteRevision:2,idempotencyKey:"restore"});
    assert.equal(h.app.authoring.get("reaudit").revision,r.draftRevision);assert.equal(h.app.testing.getSuite(s.suiteId).fixtureHash,r.fixtureHash);assert.equal(h.app.testing.status(r.id).stale,true);
  });
  await t.test("capability changes compare against the accepted run",async sub=>{
    const h=setup(sub,"guided"),schema={type:"object",properties:{count:{type:"integer"}},required:["count"],additionalProperties:false};host(h,schema);
    const fixture={...plainCase(),agentSubmissions:[{nodeId:"host",payload:{count:1}}]},s=generate(h,[fixture]),r=await run(h,s);
    assert.equal(r.stale,false);h.repo.put("capabilities","host",{...h.repo.get("capabilities","host"),revision:2});assert.equal(h.app.testing.status(r.id).stale,true);
    generate(h,[fixture],{baseSuiteId:s.suiteId,expectedSuiteRevision:1,idempotencyKey:"same-fixture"});assert.equal(h.app.testing.status(r.id).stale,true);
  });
});

test("Mock text fixtures use the same declared adapter and raw result semantics as a synthetic SDK connector",{timeout:15000},async t=>{
  const f=setup(t),root=await mkdtemp(join(tmpdir(),"flowhub-text-parity-")),entry=join(root,"server.mjs");t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(entry,`import {McpServer,fromJsonSchema} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server"))};import {serveStdio} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))};serveStdio(()=>{const s=new McpServer({name:'synthetic-adapter-parity',version:'1'},{capabilities:{tools:{}}});s.registerTool('read',{inputSchema:fromJsonSchema({type:'object',properties:{mode:{type:'string'}},required:['mode'],additionalProperties:false})},async args=>args.mode==='structured'?{content:[{type:'text',text:'raw evidence'}],structuredContent:{count:2}}:{content:[{type:'text',text:args.mode==='json'?' {"count":1} ':args.mode==='badjson'?'not-json':'Synthetic raw text result'}]});return s;},{legacy:'serve'});`);
  const connection=await f.connectors.discover({id:"text",name:"text",revision:1,transport:"stdio",command:process.execPath,args:[entry],commandApproved:true,protocolEra:"auto",disabled:false,tools:[]});f.repo.put("connections",connection.id,connection);
  const binding={id:"text-binding",revision:1,connectionId:connection.id,connectionRevision:connection.revision,environment:"test",allowedTools:["read"],lockedArguments:{},allowedQueryTemplates:[],simulationOnly:false,validationStatus:"BINDING_VERIFIED",maxRows:10,timeoutSeconds:5};f.repo.put("bindings",binding.id,binding);
  const tool=connection.tools[0],base={bindingKey:"data",toolName:"read",toolSchemaHash:tool.schemaHash,argumentsMappings:{"/mode":{value:"raw"}}};
  wire(f,{op:"add_node",nodeId:"read",nodeType:"mcp_tool",title:"read",config:base},[{op:"set_binding",key:"data",bindingId:binding.id}]);
  for(const [index,scenario] of [
    {mode:"raw",adapter:undefined,error:"OUTPUT_ADAPTER_REQUIRED"},
    {mode:"raw",adapter:"structured",error:"OUTPUT_ADAPTER_REQUIRED"},
    {mode:"raw",adapter:"text",error:null},
    {mode:"json",adapter:"json_text",error:null},
    {mode:"badjson",adapter:"json_text",error:"OUTPUT_INVALID"},
    {mode:"structured",adapter:undefined,error:null},
    {mode:"structured",adapter:"text",error:null},
  ].entries()) {
    const config={...base,argumentsMappings:{"/mode":{value:scenario.mode}},...(scenario.adapter?{resultAdapterRef:scenario.adapter}:{})};
    f.app.authoring.patch({workflowId:"reaudit",expectedRevision:f.app.authoring.get("reaudit").revision,idempotencyKey:"adapter-"+index,operations:[{op:"update_node",nodeId:"read",changes:{config}}]});
    const raw=scenario.mode==="structured"?{content:[{type:"text",text:"raw evidence"}],structuredContent:{count:2}}:{content:[{type:"text",text:scenario.mode==="json"?' {"count":1} ':scenario.mode==="badjson"?"not-json":"Synthetic raw text result"}]};
    const fixture={...plainCase(),mockResults:[{nodeId:"read",capabilityId:"read",responseMode:"text",result:raw}],assertions:[scenario.error?{kind:"error_code",expected:scenario.error}:{kind:"terminal_state",expected:"SUCCEEDED"}]};
    const s=generate(f,[fixture],{idempotencyKey:"generate-"+index}),r=await run(f,s,"run-"+index);assert.equal(r.status,"SUCCEEDED",JSON.stringify(r));assert.equal(r.cases[0].errorCode,scenario.error);
    if(scenario.error)await assert.rejects(f.connectors.call(binding,{id:"read",config},{mode:scenario.mode},5000),{code:scenario.error});
    else {
      const actual=await f.connectors.call(binding,{id:"read",config},{mode:scenario.mode},5000);assert.deepEqual(r.cases[0].outputs.read,actual);
      if(scenario.adapter==="text"){assert.equal(actual.text,raw.content.map(c=>c.text).join("\n"));assert.deepEqual(actual.content,raw.content);}
      if(scenario.adapter)assert.ok(r.cases[0].artifacts.some((a:Json)=>a.mimeType==="application/mcp+json"));
    }
  }
  await t.test("text-only MCP output can publish into end and analysis mappings and execute",async sub=>{
    const h=setup(sub,"guided");
    h.repo.put("connections",connection.id,connection);h.repo.put("bindings",binding.id,binding);
    const config={...base,resultAdapterRef:"text"};
    wire(h,{op:"add_node",nodeId:"read",nodeType:"mcp_tool",title:"read",config},[{op:"set_binding",key:"data",bindingId:binding.id}]);
    h.app.authoring.patch({workflowId:"reaudit",expectedRevision:2,idempotencyKey:"whole-result",operations:[{op:"update_node",nodeId:"end",changes:{config:{resultRef:{ref:{source:"node",nodeId:"read",pointer:""}}}}}]});
    assert.deepEqual(h.app.authoring.validate({workflowId:"reaudit",expectedRevision:3,level:"publish"}).issues,[]);
    h.app.authoring.publish({workflowId:"reaudit",expectedRevision:3,version:"1.0.0",expectedBindingRevisions:{[binding.id]:binding.revision},expectedCapabilityRevisions:{},idempotencyKey:"publish-whole"});
    const outputSchema={type:"object",properties:{summary:{type:"string"}},required:["summary"],additionalProperties:false};
    const mapped=h.app.authoring.patch({workflowId:"reaudit",expectedRevision:h.app.authoring.get("reaudit").revision,idempotencyKey:"map-text",operations:[
      {op:"add_node",nodeId:"analysis",nodeType:"agent_task",title:"analysis",config:{kind:"analysis",executorRef:"codex_host",instructions:"Read the mapped synthetic text",inputMappings:{"/message":{ref:{source:"node",nodeId:"read",pointer:"/text"}}},outputSchema}},
      {op:"disconnect",source:"read",target:"end",port:"next"},{op:"connect",source:"read",target:"analysis",port:"next"},{op:"connect",source:"analysis",target:"end",port:"next"},
      {op:"update_node",nodeId:"end",changes:{config:{resultRef:{ref:{source:"node",nodeId:"analysis",pointer:""}}}}}
    ]});
    h.app.authoring.publish({workflowId:"reaudit",expectedRevision:mapped.revision,version:"1.0.1",expectedBindingRevisions:{[binding.id]:binding.revision},expectedCapabilityRevisions:{},idempotencyKey:"publish-analysis"});
    const accepted=h.engine.start({workflowId:"reaudit",version:"1.0.1",mode:"guided",inputs:{},idempotencyKey:"live-text"});
    let checkpoint:Json;for(let i=0;i<200;i++){checkpoint=h.engine.status(accepted.runId);if(["WAITING_AGENT","FAILED"].includes(checkpoint.state))break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(checkpoint!.state,"WAITING_AGENT",JSON.stringify(checkpoint));
    assert.deepEqual(checkpoint!.checkpoint.inputs,{message:"Synthetic raw text result"});
    h.engine.advance({runId:accepted.runId,checkpointId:checkpoint!.checkpoint.id,checkpointToken:checkpoint!.checkpoint.token,expectedRevision:checkpoint!.revision,idempotencyKey:"advance-text",submission:{type:"agent_result",payload:{summary:"Synthetic mapped text was received"}}});
    for(let i=0;i<100&&h.engine.status(accepted.runId).state!=="SUCCEEDED";i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(h.engine.status(accepted.runId).state,"SUCCEEDED");
    assert.equal(h.repo.get("runs",accepted.runId).outputs.read.text,"Synthetic raw text result");
  });
  await t.test("json_text validates parsed data against the actual discovered schema",async sub=>{
    const h=setup(sub),out={type:"object",properties:{count:{type:"integer"}},required:["count"],additionalProperties:false},schemaTool={name:"read",inputSchema,outputSchema:out,schemaHash:"sha256:"+hash({inputSchema,outputSchema:out})};
    h.repo.put("connections","metadata",{id:"metadata",revision:1,tools:[schemaTool]});h.repo.put("bindings","binding",{...binding,id:"binding",connectionId:"metadata",connectionRevision:1});
    wire(h,{op:"add_node",nodeId:"read",nodeType:"mcp_tool",title:"read",config:{bindingKey:"data",toolName:"read",toolSchemaHash:schemaTool.schemaHash,argumentsMappings:{},resultAdapterRef:"json_text"}},[{op:"set_binding",key:"data",bindingId:"binding"}]);
    const fixtures=[{id:"valid",text:'{"count":1}',error:null},{id:"invalid",text:'{"count":"bad"}',error:"INPUT_INVALID"}].map(c=>({...plainCase(c.id),mockResults:[{nodeId:"read",capabilityId:"read",responseMode:"text",result:{content:[{type:"text",text:c.text}]}}],assertions:[c.error?{kind:"error_code",expected:c.error}:{kind:"terminal_state",expected:"SUCCEEDED"}]}));
    const r=await run(h,generate(h,fixtures));assert.equal(r.status,"SUCCEEDED",JSON.stringify(r));assert.deepEqual(r.cases.map((c:Json)=>c.errorCode),[null,"INPUT_INVALID"]);
  });
});

test("v2 host_tool preserves bounded native object schemas without weakening frozen result checks",async t=>{
  const definitions=[
    {name:"omitted additionalProperties",schema:{type:"object",properties:{count:{type:"integer"}},required:["count"]}},
    {name:"explicit open object",schema:{type:"object",properties:{count:{type:"integer"}},required:["count"],additionalProperties:true}},
    {name:"nonrecursive local definitions",schema:{type:"object",$defs:{Count:{type:"integer"}},properties:{count:{$ref:"#/$defs/Count"}},required:["count"]}},
    {name:"local object root reference",schema:{$ref:"#/$defs/Result",$defs:{Result:{type:"object",properties:{count:{type:"integer"}},required:["count"]}}}},
  ];
  for(const {name,schema} of definitions)await t.test(name,async sub=>{
    const f=setup(sub,"guided"),{capability,patched}=host(f,schema);assert.deepEqual(patched.issues,[]);assert.deepEqual(f.app.authoring.get("reaudit").draft.nodes.find((n:Json)=>n.id==="host").config.outputSchema,schema);
    const valid={count:1,extra:"business original"},fixture={...plainCase(),agentSubmissions:[{nodeId:"host",payload:valid}]};
    const tested=await run(f,generate(f,[fixture]));assert.equal(tested.status,"SUCCEEDED",JSON.stringify(tested));assert.deepEqual(tested.cases[0].outputs.host,valid);
    const publication=f.app.authoring.publish({workflowId:"reaudit",expectedRevision:2,version:"1.0.0",expectedBindingRevisions:{},expectedCapabilityRevisions:{host:1},idempotencyKey:"publish"});assert.deepEqual(publication.snapshot.capabilities[0].outputSchema,schema);
    f.repo.put("capabilities","host",{...capability,revision:2,outputSchema:{type:"object",properties:{},additionalProperties:false}});f.db.prepare("DELETE FROM capability_revisions WHERE id=?").run("host@1");
    const accepted=f.engine.start({workflowId:"reaudit",version:"1.0.0",mode:"guided",inputs:{},idempotencyKey:"actual-host"});
    let checkpoint:Json;for(let index=0;index<100;index++){checkpoint=f.engine.status(accepted.runId);if(checkpoint.state==="WAITING_AGENT")break;await new Promise(resolve=>setTimeout(resolve,2));}
    assert.equal(checkpoint!.state,"WAITING_AGENT");assert.deepEqual(checkpoint!.checkpoint.requiredOutputSchema,schema);
    const advance={runId:accepted.runId,checkpointId:checkpoint!.checkpoint.id,checkpointToken:checkpoint!.checkpoint.token,expectedRevision:checkpoint!.revision,idempotencyKey:"advance"};
    assert.throws(()=>f.engine.advance({...advance,submission:{type:"agent_result",payload:{count:"bad"}}}),{code:"INPUT_INVALID"});assert.equal(f.engine.status(accepted.runId).checkpoint.id,checkpoint!.checkpoint.id);
    f.engine.advance({...advance,submission:{type:"agent_result",payload:valid}});
    for(let index=0;index<100&&f.engine.status(accepted.runId).state!=="SUCCEEDED";index++)await new Promise(resolve=>setTimeout(resolve,2));
    assert.equal(f.engine.status(accepted.runId).state,"SUCCEEDED");assert.deepEqual(f.repo.get("runs",accepted.runId).outputs.host,valid);assert.equal(f.repo.get("runs",accepted.runId).hostReported.host.verification,"host_reported");
  });
  const invalid:Json[]=[
    {name:"remote ref",schema:{type:"object",properties:{count:{$ref:"https://example.invalid/schema"}}},code:"SCHEMA_INVALID"},
    {name:"dynamic ref",schema:{type:"object",properties:{count:{$dynamicRef:"#/$defs/Count"}},$defs:{Count:{type:"integer"}}},code:"SCHEMA_INVALID"},
    {name:"reference scope override",schema:{type:"object",$id:"https://example.invalid/native",properties:{}},code:"SCHEMA_INVALID"},
    {name:"recursive ref",schema:{type:"object",properties:{count:{$ref:"#/$defs/Count"}},$defs:{Count:{$ref:"#/$defs/Count"}}},code:"SCHEMA_INVALID"},
    {name:"mutually recursive refs",schema:{type:"object",properties:{count:{$ref:"#/$defs/A"}},$defs:{A:{$ref:"#/$defs/B"},B:{$ref:"#/$defs/A"}}},code:"SCHEMA_INVALID"},
    {name:"ref into inert literal",schema:{type:"object",properties:{count:{$ref:"#/examples/0"}},examples:[{type:"integer"}]},code:"SCHEMA_INVALID"},
    {name:"unsafe pattern",schema:{type:"object",properties:{text:{type:"string",pattern:"^(a+)+$"}}},code:"SCHEMA_INVALID"},
    {name:"scalar root",schema:{type:"string"},code:"SCHEMA_INVALID"},
  ];
  let deep:Json={type:"integer"};for(let index=0;index<12;index++)deep={type:"object",properties:{next:deep}};invalid.push({name:"excessive schema depth",schema:deep,code:"SCHEMA_LIMIT"});
  const refs:Json={};for(let index=0;index<30;index++)refs["N"+index]=index===29?{type:"integer"}:{$ref:"#/$defs/N"+(index+1)};
  invalid.push({name:"excessive ref expansion",schema:{type:"object",properties:{count:{$ref:"#/$defs/N0"}},$defs:refs},code:"SCHEMA_LIMIT"});
  const repeated:Json={};for(let index=0;index<14;index++)repeated["N"+index]=index===13?{type:"integer"}:{allOf:[{$ref:"#/$defs/N"+(index+1)},{$ref:"#/$defs/N"+(index+1)}]};
  invalid.push({name:"exponential acyclic ref expansion",schema:{type:"object",properties:{count:{$ref:"#/$defs/N0"}},$defs:repeated},code:"SCHEMA_LIMIT"});
  invalid.push({name:"excessive schema bytes",schema:{type:"object",properties:{},examples:["x".repeat(131073)]},code:"SCHEMA_LIMIT"});
  invalid.push({name:"excessive inert literal nodes",schema:{type:"object",properties:{},examples:[Array.from({length:2049},()=>0)]},code:"SCHEMA_LIMIT"});
  for(const {name,schema,code} of invalid)await t.test(name,sub=>{
    const f=setup(sub,"guided");assert.throws(()=>host(f,schema),{code});assert.equal(f.app.authoring.get("reaudit").revision,1);assert.ok(!f.app.authoring.get("reaudit").draft.nodes.some((n:Json)=>n.id==="host"));
  });
  await t.test("v1 and analysis keep their strict data schema",sub=>{
    const f=setup(sub,"guided"),open={type:"object",properties:{count:{type:"integer"}},required:["count"]};
    assert.throws(()=>wire(f,{op:"add_node",nodeId:"analysis",nodeType:"agent_task",title:"analysis",config:{kind:"analysis",instructions:"Synthetic analysis",inputMappings:{},outputSchema:open}}),{code:"INPUT_INVALID"});
    const v1={...f.app.authoring.get("reaudit").draft,schemaVersion:"flowhub.workflow/v1",nodes:[{id:"input",title:"input",type:"input",config:{}},{id:"analysis",title:"analysis",type:"agent_task",config:{kind:"analysis",instructions:"Synthetic analysis",inputMappings:{},outputSchema:open}},{id:"end",title:"end",type:"end",config:{resultRef:{ref:{source:"input",pointer:""}}}}],edges:[{source:"input",target:"analysis",port:"next"},{source:"analysis",target:"end",port:"next"}]};
    assert.throws(()=>f.app.authoring.saveRaw(v1,1,{}),{code:"INPUT_INVALID"});assert.equal(f.app.authoring.get("reaudit").revision,1);
  });
});

test("expired test command replays stay tombstoned and historical CANCELLED remains terminal",async t=>{
  const f=setup(t),suite=generate(f,[plainCase()]),request={suiteId:suite.suiteId,expectedSuiteRevision:1,mode:"mock",idempotencyKey:"run"};
  const accepted=f.app.testing.run(request);await f.app.testing.idle();const original=f.repo.get("workflow_test_runs",accepted.testRunId);
  f.repo.put("workflow_test_runs",original.id,{...original,resultsExpiredAt:new Date().toISOString(),acceptedSuite:undefined,executionSnapshot:undefined,cases:[]});
  assert.throws(()=>f.app.testing.run(request),{code:"RESULT_EXPIRED"});assert.equal(f.app.testing.status(original.id).resultsExpiredAt!==undefined,true);
  f.db.prepare("DELETE FROM workflow_test_runs WHERE id=?").run(original.id);assert.throws(()=>f.app.testing.run(request),{code:"RESULT_EXPIRED"});assert.equal(f.repo.all("workflow_test_runs").length,0);
  f.repo.put("workflow_test_runs","cancelled",{id:"cancelled",suiteId:suite.suiteId,status:"CANCELLED",owner:"admin",draftRevision:1,suiteRevision:1,fixtureHash:original.fixtureHash,capabilityRevisions:{},cases:[]});
  const testing=new WorkflowTesting(f.app.authoring);assert.equal(f.repo.get("workflow_test_runs","cancelled").status,"CANCELLED");await testing.close();
});
