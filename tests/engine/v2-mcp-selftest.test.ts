import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { startDaemon } from "../../apps/daemon/src/index.js";
import { readEndpoint } from "../../apps/daemon/src/local-config.js";
import { createClient,localHttpTransport } from "../../packages/mcp-connectors/src/index.js";
import type { Json } from "../../packages/contracts/src/domain.js";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("official MCP 21-tool discovery/import/author/generate/mock/publish/start/advance/report loop persists real state",{timeout:30000},async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),"flowhub v2 MCP "))),home=join(root,"codex"),dataDir=join(root,"data");await mkdir(home);
  const daemon=await startDaemon({dataDir,port:0});const endpoint=await readEndpoint(dataDir),client=createClient("modern");
  t.after(async()=>{await client.close();await daemon.close();await rm(root,{recursive:true,force:true});});
  await client.connect(localHttpTransport(new URL(endpoint.url),endpoint.token));
  const names=(await client.listTools()).tools.map(t=>t.name);assert.equal(names.length,21);assert.equal(new Set(names).size,21);
  const tool=async(name:string,args:Json)=>{const response=await client.callTool({name,arguments:args});assert.notEqual(response.isError,true,JSON.stringify(response.structuredContent));return response.structuredContent as Json;};
  const entry=join(root,"mock.mjs");await writeFile(entry,`import {serveStdio} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))};import {createMockServer} from ${JSON.stringify(pathToFileURL(resolve("dist/packages/mock-mcps/src/index.js")).href)};serveStdio(createMockServer,{legacy:'serve'});`);
  await writeFile(join(home,"config.toml"),'[mcp_servers.synthetic]\ncommand = '+JSON.stringify(process.execPath)+'\nargs = ['+JSON.stringify(entry)+']\n');
  const context=await daemon.application.registry.context({codexHome:home,cwd:root,codexPath:join(root,"missing-codex")});
  const scan=await tool("host_scan",{contextId:context.id,depth:"catalog",idempotencyKey:"scan"});await daemon.application.registry.close();
  const scanned=await tool("host_scan_status",{scanId:scan.scanId});assert.ok(["PARTIAL","SUCCEEDED"].includes(scanned.status));
  const caps=await tool("capability_search",{contextId:context.id,query:"Synthetic S0"}),cap=caps.items.find((c:Json)=>c.name==="synthetic_order_lookup");assert.ok(cap);
  const detail=await tool("capability_get",{capabilityId:cap.id,includeSchemas:true});assert.ok(detail.inputSchema);
  const imported=await tool("capability_import",{capabilityId:cap.id,expectedSourceRevision:cap.revision,target:"hub_direct",environment:"test",lockedArguments:{},idempotencyKey:"import"});
  assert.equal(imported.status,"configuration_required");
  // Independent local management probe uses only the registered synthetic MCP.
  const base="http://127.0.0.1:"+daemon.port;
  const bootstrap=await fetch(base+"/api/v1/auth/bootstrap",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({setupToken:await readFile(join(dataDir,"admin-setup-token"),"utf8"),password:"Synthetic-v2-MCP-password-42"})});
  const cookie=bootstrap.headers.get("set-cookie")!.split(";")[0]!,csrf=((await bootstrap.json())as Json).data.csrf;
  const probe=await fetch(base+"/api/v1/bindings/"+imported.bindingId+"/verify",{method:"POST",headers:{Cookie:cookie,"X-CSRF-Token":csrf,"Content-Type":"application/json"},body:JSON.stringify({probe:{toolName:cap.name,arguments:{orderNo:"DEMO-V2"}},serverEnforcedReadOnly:true,scope:"isolated protocol fixture",expectedEnvironmentPointer:"/environment"})});
  assert.equal(probe.status,200,await probe.text());
  const created=await tool("workflow_draft_create",{workflowId:"mcp-v2-loop",name:"真实 MCP 闭环",environment:"test",mode:"guided",template:"blank",idempotencyKey:"create"});
  const object={type:"object",properties:{summary:{type:"string"}},required:["summary"],additionalProperties:false};
  const reportSchema={type:"object",properties:{reportMarkdown:{type:"string"},evidenceRefs:{type:"array",items:{type:"string"}}},required:["reportMarkdown","evidenceRefs"],additionalProperties:false};
  const patch=await tool("workflow_draft_patch",{workflowId:"mcp-v2-loop",expectedRevision:created.revision,idempotencyKey:"patch",operations:[
    {op:"set_input_schema",schema:{type:"object",properties:{orderNo:{type:"string",pattern:"^DEMO-[A-Za-z0-9-]{1,64}$"}},required:["orderNo"],additionalProperties:false,examples:[{orderNo:"DEMO-V2"}]}},
    {op:"set_binding",key:"lookup",bindingId:imported.bindingId},
    {op:"add_node",nodeId:"lookup",nodeType:"mcp_tool",title:"合成查询",capabilityRef:{capabilityId:cap.id,revision:cap.revision},config:{bindingKey:"lookup",argumentsMappings:{"/orderNo":{ref:{source:"input",pointer:"/orderNo"}}}}},
    {op:"add_node",nodeId:"analysis",nodeType:"agent_task",title:"分析",config:{kind:"analysis",instructions:"Only summarize the synthetic lookup.",inputMappings:{"/lookup":{ref:{source:"node",nodeId:"lookup",pointer:""}}},outputSchema:object,executorRef:"codex_host"}},
    {op:"add_node",nodeId:"report",nodeType:"report_template",title:"报告",config:{templateRef:"incident-markdown/v1",inputMappings:{"/analysis":{ref:{source:"node",nodeId:"analysis",pointer:""}}},outputSchema:reportSchema}},
    {op:"disconnect",source:"input",target:"end",port:"next"},...[["input","lookup"],["lookup","analysis"],["analysis","report"],["report","end"]].map(([source,target])=>({op:"connect",source,target,port:"next"}))]});
  assert.deepEqual(patch.issues,[]);
  const validation=await tool("workflow_draft_validate",{workflowId:"mcp-v2-loop",expectedRevision:patch.revision,level:"publish"});assert.equal(validation.valid,true);
  const fixture={synthetic:true,environment:"test",sentinel:"FLOWHUB_S0_TEST_ONLY_041",orderNo:"DEMO-V2",message:"邮箱 demo@example.invalid token 原值"};
  const proposed={id:"normal",name:"完整闭环",inputs:{orderNo:"DEMO-V2"},mockResults:[{nodeId:"lookup",capabilityId:cap.id,responseMode:"structured",result:{content:[],structuredContent:fixture}}],agentSubmissions:[{nodeId:"analysis",payload:{summary:"合成结果"}}],assertions:[{kind:"terminal_state",expected:"SUCCEEDED"},{kind:"argument_equals",nodeId:"lookup",pointer:"/orderNo",expected:"DEMO-V2"},{kind:"output_equals",nodeId:"lookup",pointer:"/message",expected:fixture.message}],expectedValidationErrors:[]};
  const generated=await tool("workflow_test_generate",{workflowId:"mcp-v2-loop",expectedRevision:patch.revision,strategy:"agent_proposed",proposedCases:[proposed],idempotencyKey:"generate"});
  const testing=await tool("workflow_test_run",{suiteId:generated.suiteId,expectedSuiteRevision:1,mode:"mock",idempotencyKey:"mock"});await daemon.application.testing.close();
  const tested=await tool("workflow_test_status",{testRunId:testing.testRunId});assert.equal(tested.status,"SUCCEEDED",JSON.stringify(tested));assert.equal(tested.networkCalls,0);assert.equal(tested.realSecretReads,0);
  const binding=daemon.engine.repo.get("bindings",imported.bindingId);
  const publication=await tool("workflow_draft_publish",{workflowId:"mcp-v2-loop",expectedRevision:patch.revision,version:"1.0.0",expectedBindingRevisions:{[binding.id]:binding.revision},expectedCapabilityRevisions:{[cap.id]:cap.revision},idempotencyKey:"publish"});assert.ok(publication.contentHash);
  const started=await tool("workflow_start",{workflowId:"mcp-v2-loop",version:"1.0.0",mode:"guided",inputs:{orderNo:"DEMO-V2"},idempotencyKey:"start"});
  let status:Json;
  for(let i=0;i<200;i++){status=await tool("workflow_status",{runId:started.runId});if(status.state==="WAITING_AGENT")break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(status!.state,"WAITING_AGENT");
  await tool("workflow_advance",{runId:started.runId,checkpointId:status!.checkpoint.id,checkpointToken:status!.checkpoint.token,expectedRevision:status!.revision,submission:{type:"agent_result",payload:{summary:"由实际 MCP 回执继续"}},idempotencyKey:"continue"});
  for(let i=0;i<200;i++){status=await tool("workflow_status",{runId:started.runId});if(status.state==="SUCCEEDED")break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(status!.state,"SUCCEEDED");
  const markdown=status!.artifacts.find((a:Json)=>a.mimeType==="text/markdown");assert.ok(markdown);
  const report=await tool("artifact_read",{runId:started.runId,artifactId:markdown.id,offset:0,maxBytes:262144});assert.ok(JSON.stringify(report).includes("证据索引"));
  const missing=await tool("workflow_test_generate",{workflowId:"mcp-v2-loop",expectedRevision:daemon.engine.repo.get("workflows","mcp-v2-loop").revision,strategy:"agent_proposed",proposedCases:[{...proposed,id:"missing",mockResults:[]}],idempotencyKey:"missing-gen"});
  const uncovered=await tool("workflow_test_run",{suiteId:missing.suiteId,expectedSuiteRevision:1,mode:"mock",idempotencyKey:"missing-run"});await daemon.application.testing.close();assert.equal((await tool("workflow_test_status",{testRunId:uncovered.testRunId})).status,"PARTIAL");
  for(let i=0;i<100;i++)await tool("workflow_draft_create",{workflowId:"v2-many-"+i,name:"合成 "+i,environment:"test",mode:"auto",template:"blank",idempotencyKey:"many-"+i});
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name),names);
  const scopedResponse=await fetch(base+"/api/v1/clients",{method:"POST",headers:{Cookie:cookie,"X-CSRF-Token":csrf,"Content-Type":"application/json"},body:JSON.stringify({label:"Legacy execution",workflowAllowlist:["mcp-v2-loop"]})});
  const scoped=(await scopedResponse.json() as Json).data,legacy=createClient("modern");
  try {await legacy.connect(localHttpTransport(new URL(endpoint.url),(await readFile(scoped.absoluteTokenFile,"utf8")).trim()));
    assert.equal((await legacy.listTools()).tools.length,7);
  }finally{await legacy.close();}
  const bridged=createClient("modern");
  try {
    await bridged.connect(new StdioClientTransport({command:process.execPath,args:[resolve("dist/apps/daemon/src/cli.js"),"mcp","--stdio","--data-dir",dataDir,"--token-file",scoped.absoluteTokenFile],stderr:"pipe"}));
    assert.deepEqual((await bridged.listTools()).tools.map(t=>t.name),["workflow_search","workflow_get","workflow_start","workflow_advance","workflow_status","workflow_cancel","artifact_read"]);
  }finally{await bridged.close();}
});
