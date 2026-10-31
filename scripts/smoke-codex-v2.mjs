import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { startDaemon } from "../dist/apps/daemon/src/index.js";
import { locateCodex } from "../dist/packages/host-discovery/src/index.js";
import { tomlString } from "../dist/packages/admin-api/src/settings-integration.js";
const root=await mkdtemp(join(tmpdir(),"flowhub-real-codex-v2-")),home=join(root,"codex"),dataDir=join(root,"data");
await mkdir(home);const daemon=await startDaemon({dataDir,port:0}),pending=new Map();let seq=0;
const codex=process.env.FLOWHUB_CODEX_PATH??await locateCodex();assert.ok(codex,"Install Codex or specify FLOWHUB_CODEX_PATH.");
await writeFile(join(home,"config.toml"),[
  '[features]','apps = false','[mcp_servers.flowhub_v2]',
  'command = '+tomlString(process.execPath),
  'args = ['+[resolve("dist/apps/daemon/src/cli.js"),"mcp","--stdio","--data-dir",dataDir].map(tomlString).join(",")+']',
].join("\n"));
const child=spawn(codex,["app-server","--stdio"],{cwd:resolve("."),env:{...process.env,CODEX_HOME:home},stdio:["pipe","pipe","pipe"]});
child.stderr.resume();let closed=false;
const lines=createInterface({input:child.stdout});
const rpc=(method,params,timeoutMs=15000)=>new Promise((resolve,reject)=>{
  const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error("Codex RPC timeout: "+method));},timeoutMs);
  pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+"\n");
});
lines.on("line",line=>{try{const message=JSON.parse(line);if(message.id!==undefined&&pending.has(message.id)) {
  const wait=pending.get(message.id);pending.delete(message.id);clearTimeout(wait.timer);
  message.error?wait.reject(new Error("Codex RPC rejected: "+JSON.stringify(message.error))):wait.resolve(message.result);
}else if(message.id!==undefined&&message.method)child.stdin.write(JSON.stringify({id:message.id,error:{code:-32601,message:"No interactive approval handler in this synthetic smoke test."}})+"\n");}catch{}});
child.on("error",error=>{for(const wait of pending.values()){clearTimeout(wait.timer);wait.reject(error);}pending.clear();});
const stages=[];
try {
  const initialized=await rpc("initialize",{clientInfo:{name:"flowhub-local-acceptance",version:"2.0.0-alpha.1"},capabilities:{experimentalApi:false}});
  child.stdin.write(JSON.stringify({method:"initialized",params:{}})+"\n");stages.push({stage:"actual_codex_initialize",status:"PASS"});
  const started=await rpc("thread/start",{cwd:resolve("."),ephemeral:true,approvalPolicy:"never",sandbox:"read-only"});const threadId=started.thread.id;
  let inventory;
  for(let attempt=0;attempt<40;attempt++) {
    inventory=await rpc("mcpServerStatus/list",{threadId,serverName:"flowhub_v2",detail:"toolsAndAuthOnly",limit:10});
    if(Object.keys(inventory.data?.[0]?.tools??{}).length===21)break;
    await new Promise(r=>setTimeout(r,100));
  }
  assert.equal(Object.keys(inventory.data?.[0]?.tools??{}).length,21);stages.push({stage:"codex_discovers_21_mcp_tools",status:"PASS"});
  const tool=async(name,args)=>{
    const result=await rpc("mcpServer/tool/call",{threadId,server:"flowhub_v2",tool:name,arguments:args});
    assert.notEqual(result.isError,true,JSON.stringify(result.structuredContent));return result.structuredContent??JSON.parse(result.content[0].text);
  };
  const context=await daemon.application.registry.context({codexHome:home,cwd:resolve("."),codexPath:codex});
  const scan=await tool("host_scan",{contextId:context.id,depth:"metadata",idempotencyKey:"host-scan"});await daemon.application.registry.close();
  assert.ok(["SUCCEEDED","PARTIAL"].includes((await tool("host_scan_status",{scanId:scan.scanId})).status));
  const created=await tool("workflow_draft_create",{workflowId:"codex-local-smoke",name:"真实宿主合成闭环",environment:"test",mode:"auto",template:"blank",idempotencyKey:"create"});
  const reportSchema={type:"object",properties:{reportMarkdown:{type:"string"},evidenceRefs:{type:"array",items:{type:"string"}}},required:["reportMarkdown","evidenceRefs"],additionalProperties:false};
  const changed=await tool("workflow_draft_patch",{workflowId:created.workflowId,expectedRevision:created.revision,idempotencyKey:"patch",operations:[{op:"add_node",nodeId:"report",nodeType:"report_template",title:"真实模板报告",config:{templateRef:"incident-markdown/v1",inputMappings:{},outputSchema:reportSchema}},{op:"disconnect",source:"input",target:"end",port:"next"},{op:"connect",source:"input",target:"report",port:"next"},{op:"connect",source:"report",target:"end",port:"next"}]});
  assert.equal((await tool("workflow_draft_validate",{workflowId:created.workflowId,expectedRevision:changed.revision,level:"publish"})).valid,true);
  const suite=await tool("workflow_test_generate",{workflowId:created.workflowId,expectedRevision:changed.revision,strategy:"deterministic",idempotencyKey:"generate"});
  const testing=await tool("workflow_test_run",{suiteId:suite.suiteId,expectedSuiteRevision:1,mode:"mock",idempotencyKey:"test"});await daemon.application.testing.close();assert.equal((await tool("workflow_test_status",{testRunId:testing.testRunId})).status,"SUCCEEDED");
  await tool("workflow_draft_publish",{workflowId:created.workflowId,expectedRevision:changed.revision,version:"1.0.0",expectedBindingRevisions:{},expectedCapabilityRevisions:{},idempotencyKey:"publish"});
  const run=await tool("workflow_start",{workflowId:created.workflowId,version:"1.0.0",mode:"auto",inputs:{},idempotencyKey:"run"});
  let status;for(let i=0;i<100;i++){status=await tool("workflow_status",{runId:run.runId});if(status.state==="SUCCEEDED")break;await new Promise(r=>setTimeout(r,10));}assert.equal(status.state,"SUCCEEDED");
  const report=status.artifacts.find(a=>a.mimeType==="text/markdown");assert.ok(report);const content=await tool("artifact_read",{runId:run.runId,artifactId:report.id,offset:0,maxBytes:262144});assert.ok(JSON.stringify(content).includes("证据索引"));
  stages.push({stage:"codex_mcp_author_test_publish_execute_report",status:"PASS",workflowId:created.workflowId,draftRevision:changed.revision,suiteId:suite.suiteId,testRunId:testing.testRunId,runId:run.runId,reportBytes:report.byteLength});
  console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.versions.node,codexUserAgent:initialized.userAgent??null,stages,modelTurns:0,businessServiceCalls:0,persistentCodexConfigModified:false,privateCredentialsCopied:false,naturalLanguageModelAcceptance:"UNVERIFIED"},null,2));
}finally{
  if(!closed){closed=true;lines.close();child.stdin.end();child.kill();}
  for(const wait of pending.values())clearTimeout(wait.timer);pending.clear();
  await daemon.close();await rm(root,{recursive:true,force:true});
}
