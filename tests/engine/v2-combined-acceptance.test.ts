import {test} from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import Fastify from "fastify";
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Repository} from "../../packages/persistence/src/repository.js";
import {Vault} from "../../packages/security/src/index.js";
import {Connectors} from "../../packages/mcp-connectors/src/registry.js";
import {Engine} from "../../packages/workflow-core/src/engine.js";
import {CapabilityRegistry} from "../../packages/capability-registry/src/index.js";
import {AuthoringService} from "../../packages/workflow-authoring/src/index.js";
import {registerAdmin} from "../../packages/admin-api/src/index.js";
import {resolveSource,scanHost} from "../../packages/host-discovery/src/index.js";
import {get,hash,type Json} from "../../packages/contracts/src/domain.js";
import {nodeScriptRuntime} from "../helpers/discovery-runtime.js";

async function fixture(t:any) {
  const root=await realpath(await mkdtemp(join(tmpdir(),"flowhub-combined-acceptance-"))),home=join(root,"home"),cwd=join(root,"project");
  await mkdir(home);await mkdir(join(cwd,".codex"),{recursive:true});
  const userPath=join(home,"config.toml"),projectPath=join(cwd,".codex/config.toml"),cli=join(root,"codex-fixture.mjs"),calls=join(root,"cli-calls.jsonl");
  await writeFile(userPath,"");await writeFile(join(home,"servers.json"),JSON.stringify({default:[]}));
  await writeFile(cli,`import fs from 'node:fs';const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');if(a.includes('--version'))console.log('codex-cli 0.164.0-alpha.11.1');else if(a.includes('--help'))console.log(a.includes('mcp')?'--json':fs.existsSync(${JSON.stringify(join(root,"legacy-profile"))})?'usage':'--profile <PROFILE>');else if(a.includes('--json')){const data=JSON.parse(fs.readFileSync(${JSON.stringify(join(home,"servers.json"))},'utf8')),i=a.indexOf('--profile');console.log(JSON.stringify(data[i<0?'default':a[i+1]]??[]));}else process.exit(3);`);
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo);vault.initialize("Synthetic-combined-acceptance-password");
  const engine=new Engine(repo,vault,new Connectors(repo,vault)),registry=new CapabilityRegistry(engine,{hostRuntime:nodeScriptRuntime}),authoring=new AuthoringService(engine);
  const http=Fastify(),admin=await registerAdmin(http,engine,root,authoring,registry);admin.auth.setup("Synthetic-combined-admin-password");const session=admin.auth.session();
  t.after(async()=>{await http.close();await registry.close();await engine.close();db.close();await rm(root,{recursive:true,force:true});});
  const context=(extra:Json={})=>registry.context({codexHome:home,cwd,codexPath:cli,...extra});
  const scan=async(c:Json,key:string,depth="metadata")=>{const accepted=registry.scan({contextId:c.id,depth,idempotencyKey:key});await registry.idle();const status=registry.status(accepted.scanId);assert.ok(["SUCCEEDED","PARTIAL"].includes(status.status),JSON.stringify(status));return status;};
  const api=(url:string,payload:Json)=>http.inject({method:"POST",url,payload,headers:{cookie:"flowhub_session="+session.token,"x-csrf-token":session.csrf}});
  return {root,home,cwd,userPath,projectPath,cli,calls,db,repo,vault,engine,registry,authoring,context,scan,api};
}

test("DISC-03 combined: user/project/Profile conflicts retain host-effective results, persisted declaration evidence and conservative untrusted/legacy candidates",async t=>{
  const f=await fixture(t),profilePath=f.userPath+"#profile:review";
  await writeFile(f.userPath,'[mcp_servers.same]\nurl="https://user.invalid/mcp"\n[profiles.review.mcp_servers.same]\nurl="https://profile.invalid/mcp"\n');
  await writeFile(f.projectPath,'[mcp_servers.same]\nurl="https://project.invalid/mcp"\n');
  const original=await Promise.all([readFile(f.userPath),readFile(f.projectPath)]);
  const server=(url:string)=>({name:"same",enabled:true,transport:{type:"http",url}});
  await writeFile(join(f.home,"servers.json"),JSON.stringify({default:[server("https://project.invalid/mcp")],review:[server("https://profile.invalid/mcp")]}));
  for(const profile of [null,"review"]) {
    const c=await f.context({projectTrusted:true,profile}),direct=await scanHost(c,"metadata",{}, {},nodeScriptRuntime);
    assert.equal(direct.resolutionQuality,"host_effective");assert.equal(direct.sources.length,1);
    assert.equal(direct.sources[0].config.url,profile?"https://profile.invalid/mcp":"https://project.invalid/mcp");
    const paths=[f.userPath,f.projectPath,...(profile?[profilePath]:[])];
    assert.deepEqual(direct.sources[0].sourceChain,["host CLI effective configuration",...paths]);
    assert.deepEqual(direct.sources[0].resolutionEvidence,{kind:"host_effective",profile,declarations:paths.map((path,index)=>({path,layer:["user","trusted_project","profile"][index]})),declarationOrder:"read_order_not_precedence"});
    await f.scan(c,"effective-"+(profile??"default"));
    const stored=f.repo.all("capability_sources").find(s=>s.contextId===c.id&&s.name==="same");
    assert.deepEqual(stored.sourceChain,direct.sources[0].sourceChain);assert.deepEqual(stored.resolutionEvidence,direct.sources[0].resolutionEvidence);
    assert.deepEqual(await resolveSource(c,stored.locator,{},nodeScriptRuntime),direct.sources[0].config);
  }
  // Existing project config may not enter indirectly through the host's trust setting.
  const previous=f.repo.all("host_contexts").find(c=>c.profile==="review");
  const untrusted=await f.registry.context({contextId:previous.id,expectedRevision:previous.revision,projectTrusted:false}),conservative=await scanHost(untrusted,"metadata",{}, {},nodeScriptRuntime);
  assert.equal(conservative.resolutionQuality,"partial");assert.ok(conservative.issues.some(i=>i.code==="PROJECT_CONFIGURATION_NOT_TRUSTED"));
  assert.deepEqual(conservative.sources.map(s=>s.sourceChain),[[f.userPath],[profilePath]]);
  assert.deepEqual(conservative.sources.map(s=>s.config.url),["https://user.invalid/mcp","https://profile.invalid/mcp"]);
  assert.ok(conservative.sources.every(s=>s.resolutionEvidence.kind==="static_candidate"&&!JSON.stringify(s).includes(f.projectPath)));
  const beforeLegacy=(await readFile(f.calls,"utf8")).trim().split("\n").length;
  await writeFile(join(f.root,"legacy-profile"),"help has no Profile option");
  const fallback=await scanHost({...untrusted,projectTrusted:true},"metadata",{}, {},nodeScriptRuntime);
  assert.equal(fallback.resolutionQuality,"partial");assert.deepEqual(fallback.sources.map(s=>s.sourceChain),[[f.userPath],[f.projectPath],[profilePath]]);
  const invoked=(await readFile(f.calls,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
  assert.ok(invoked.some(args=>args.join(" ")==="--profile review mcp list --json"));
  assert.ok(invoked.slice(beforeLegacy).every(args=>!args.includes("--profile")&&!args.includes("--json")),"A CLI without profile support must never receive the profile or effective-list request.");
  assert.deepEqual(await Promise.all([readFile(f.userPath),readFile(f.projectPath)]),original);
});

async function realCatalog(f:Awaited<ReturnType<typeof fixture>>) {
  const schemaPath=join(f.root,"tool-schema.json"),descriptionPath=join(f.root,"tool-description.txt"),marker=join(f.root,"business-calls.jsonl"),entry=join(f.root,"mcp-fixture.mjs");
  const schema=(type:string)=>({type:"object",properties:{count:{type}},required:["count"],additionalProperties:false});
  await writeFile(schemaPath,JSON.stringify(schema("string")));
  await writeFile(descriptionPath,"Initial synthetic read contract");
  await writeFile(entry,`import fs from 'node:fs';import {McpServer,fromJsonSchema} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server"))};import {serveStdio} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))};serveStdio(()=>{const s=new McpServer({name:'combined-schema-fixture',version:'1'},{capabilities:{tools:{}}});s.registerTool('read',{description:fs.readFileSync(${JSON.stringify(descriptionPath)},'utf8'),inputSchema:fromJsonSchema(JSON.parse(fs.readFileSync(${JSON.stringify(schemaPath)},'utf8'))),outputSchema:fromJsonSchema({type:'object',properties:{synthetic:{const:true},environment:{const:'test'},value:{}},required:['synthetic','environment','value'],additionalProperties:false})},async a=>{fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify(a)+'\\n');return {content:[],structuredContent:{synthetic:true,environment:'test',value:a.count}};});return s;},{legacy:'serve'});`);
  await writeFile(join(f.home,"servers.json"),JSON.stringify({default:[{name:"same",enabled:true,transport:{type:"stdio",command:process.execPath,args:[entry]}}]}));
  const c=await f.context({projectTrusted:true});
  const catalog=async(key:string)=>{await f.scan(c,key,"catalog");const cap=f.registry.search({contextId:c.id}).items.find(x=>x.name==="read");assert.ok(cap);return f.registry.get({capabilityId:cap.id,includeSchemas:true});};
  const imported=async(cap:Json,key:string,value:Json)=>{
    const receipt=await f.registry.import({capabilityId:cap.id,expectedSourceRevision:cap.revision,target:"hub_direct",environment:"test",lockedArguments:{},idempotencyKey:key});
    assert.equal(f.repo.get("bindings",receipt.bindingId).validationStatus,"UNVERIFIED");
    const verified=await f.api("/api/v1/bindings/"+receipt.bindingId+"/verify",{probe:{toolName:"read",arguments:{count:value}},serverEnforcedReadOnly:true,scope:"isolated synthetic protocol fixture only",expectedEnvironmentPointer:"/environment"});
    assert.equal(verified.statusCode,200,verified.body);assert.equal(verified.json().data.validationStatus,"MOCK_VERIFIED");assert.equal(verified.json().data.simulationOnly,true);
    return receipt;
  };
  return {schemaPath,descriptionPath,marker,schema,c,catalog,imported};
}

function wire(f:Awaited<ReturnType<typeof fixture>>,workflowId:string,cap:Json,bindingId:string) {
  f.authoring.create({workflowId,name:workflowId,environment:"test",mode:"auto",template:"blank",idempotencyKey:workflowId+"-create"});
  return f.authoring.patch({workflowId,expectedRevision:1,idempotencyKey:workflowId+"-wire",operations:[
    {op:"set_input_schema",schema:{type:"object",properties:{count:{type:"string"}},required:["count"],additionalProperties:false}},
    {op:"set_binding",key:"source",bindingId},
    {op:"add_node",nodeId:"read",nodeType:"mcp_tool",title:"Synthetic read",capabilityRef:{capabilityId:cap.id,revision:cap.revision},config:{bindingKey:"source",argumentsMappings:{"/count":{ref:{source:"input",pointer:"/count"}}}}},
    {op:"disconnect",source:"input",target:"end",port:"next"},{op:"connect",source:"input",target:"read",port:"next"},{op:"connect",source:"read",target:"end",port:"next"},
  ]});
}
function publish(f:Awaited<ReturnType<typeof fixture>>,workflowId:string,version:string,key:string,bindingId:string,cap:Json,extra:Json={}) {
  return f.authoring.publish({workflowId,expectedRevision:f.authoring.get(workflowId).revision,version,
    expectedBindingRevisions:{[bindingId]:f.repo.get("bindings",bindingId).revision},expectedCapabilityRevisions:{[cap.id]:cap.revision},idempotencyKey:key,...extra});
}

test("CAP-07 combined: real MCP parameter type drift locates an existing draft node/field, repairs through authoring and republishes without changing v1",async t=>{
  const f=await fixture(t),mcp=await realCatalog(f),first=await mcp.catalog("catalog-string");
  await assert.rejects(readFile(mcp.marker),{code:"ENOENT"}); // Discovery never invokes read.
  const oldBinding=await mcp.imported(first,"import-string","2");
  const draft=wire(f,"schema-drift",first,oldBinding.bindingId);assert.deepEqual(draft.issues,[]);
  const original=publish(f,"schema-drift","1.0.0","publish-string",oldBinding.bindingId,first),frozen=JSON.stringify(original);
  const oldConnection=JSON.stringify(f.repo.get("connections",oldBinding.connectionId));
  await writeFile(mcp.schemaPath,JSON.stringify(mcp.schema("integer")));
  const changed=await mcp.catalog("catalog-integer");assert.equal(changed.id,first.id);assert.equal(changed.revision,first.revision+1);
  const issue=f.authoring.get("schema-drift").issues.find((i:Json)=>i.code==="CAPABILITY_STALE"&&i.nodeId==="read");assert.ok(issue);
  assert.equal(issue.capabilityId,first.id);assert.equal(issue.expectedRevision,1);assert.equal(issue.currentRevision,2);
  const countChange=issue.schemaChanges.find((c:Json)=>c.section==="inputSchema"&&c.parameter==="/count");assert.ok(countChange);
  const {mappingPath,...change}=countChange;
  assert.deepEqual(change,{section:"inputSchema",parameter:"/count",schemaPath:"/properties/count",change:"type_changed",previousType:"string",currentType:"integer",previousRequired:true,currentRequired:true});
  assert.deepEqual(get(f.authoring.get("schema-drift").draft,issue.path),{capabilityId:first.id,revision:1});
  assert.deepEqual(get(f.authoring.get("schema-drift").draft,mappingPath),{ref:{source:"input",pointer:"/count"}});
  assert.equal(JSON.stringify(f.repo.get("versions",original.id)),frozen);assert.equal(JSON.stringify(f.repo.get("connections",oldBinding.connectionId)),oldConnection);
  const newBinding=await mcp.imported(changed,"import-integer",2),current=f.authoring.get("schema-drift"),node=current.draft.nodes.find((n:Json)=>n.id==="read");
  assert.notEqual(newBinding.connectionId,oldBinding.connectionId);
  const patched=f.authoring.patch({workflowId:current.id,expectedRevision:current.revision,idempotencyKey:"update-capability-and-binding",operations:[
    {op:"set_binding",key:"source",bindingId:newBinding.bindingId},
    {op:"update_node",nodeId:"read",changes:{config:{...node.config,capabilityRef:{capabilityId:changed.id,revision:changed.revision},toolName:changed.name,toolSchemaHash:changed.tool.schemaHash}}},
  ]});
  assert.ok(patched.issues.some((i:Json)=>i.code==="TYPE_MISMATCH"&&i.nodeId==="read"&&i.path.includes("count")),JSON.stringify(patched.issues));
  f.authoring.patch({workflowId:current.id,expectedRevision:patched.revision,idempotencyKey:"repair-integer-mapping",operations:[{op:"set_mapping",nodeId:"read",section:"argumentsMappings",destination:"/count",expression:{value:2}}]});
  assert.equal(f.authoring.validate({workflowId:current.id,expectedRevision:f.authoring.get(current.id).revision,level:"publish"}).valid,true);
  const next=publish(f,current.id,"1.0.1","publish-integer",newBinding.bindingId,changed);
  assert.equal(next.snapshot.workflow.nodes.find((n:Json)=>n.id==="read").config.argumentsMappings["/count"].value,2);
  assert.equal(next.snapshot.capabilities[0].capabilityRevision,2);assert.equal(JSON.stringify(f.repo.get("versions",original.id)),frozen);
  assert.equal((await readFile(mcp.marker,"utf8")).trim().split("\n").length,2,"Only two explicit synthetic verification probes may call the tool.");
});

test("AUTHOR-08 combined: simultaneous capability/binding drift rejects partial reviews atomically and exact retry preserves previous publication",async t=>{
  const f=await fixture(t),mcp=await realCatalog(f),cap=await mcp.catalog("author-catalog"),imported=await mcp.imported(cap,"author-import","2");
  wire(f,"review-drift",cap,imported.bindingId);
  const old=publish(f,"review-drift","1.0.0","author-v1",imported.bindingId,cap),oldBytes=JSON.stringify(old),reviewed=f.authoring.get("review-drift"),binding=f.repo.get("bindings",imported.bindingId);
  assert.equal(f.authoring.validate({workflowId:reviewed.id,expectedRevision:reviewed.revision,level:"publish"}).valid,true);
  await writeFile(mcp.descriptionPath,"Updated synthetic semantic description");
  const nextCap=await mcp.catalog("author-capability-drift");assert.equal(nextCap.revision,cap.revision+1);
  f.repo.put("bindings",binding.id,{...binding,revision:binding.revision+1,maxRows:3},binding.revision);
  const state=()=>hash({draft:f.repo.get("workflows",reviewed.id),versions:f.repo.all("versions"),bindings:f.repo.all("bindings"),capabilities:f.repo.all("capabilities"),capabilityRevisions:f.repo.all("capability_revisions"),authoringCommands:f.repo.all("authoring_commands"),commands:f.db.prepare("SELECT * FROM commands ORDER BY rowid").all(),events:f.repo.changes(0,1000),audit:f.db.prepare("SELECT * FROM audit_events ORDER BY seq").all()});
  const reject=(key:string,expectedCapabilityRevisions:Json,expectedBindingRevisions:Json,code:string)=>{
    const before=state();assert.throws(()=>publish(f,reviewed.id,"1.0.1",key,binding.id,nextCap,{expectedCapabilityRevisions,expectedBindingRevisions}),{code});
    assert.equal(state(),before);assert.equal(JSON.stringify(f.repo.get("versions",old.id)),oldBytes);assert.equal(f.repo.get("versions",reviewed.id+"@1.0.1"),undefined);
  };
  reject("old-both",{[cap.id]:1},{[binding.id]:binding.revision},"CAPABILITY_STALE");
  reject("only-binding",{[cap.id]:1},{[binding.id]:binding.revision+1},"CAPABILITY_STALE");
  reject("only-capability-before-reference-repair",{[cap.id]:2},{[binding.id]:binding.revision},"WORKFLOW_INVALID");
  const live=f.authoring.get(reviewed.id),node=live.draft.nodes.find((n:Json)=>n.id==="read");
  f.authoring.patch({workflowId:reviewed.id,expectedRevision:live.revision,idempotencyKey:"review-current-capability",operations:[{op:"update_node",nodeId:"read",changes:{config:{...node.config,capabilityRef:{capabilityId:cap.id,revision:2}}}}]});
  assert.equal(f.authoring.validate({workflowId:reviewed.id,expectedRevision:f.authoring.get(reviewed.id).revision,level:"publish"}).valid,true);
  reject("old-binding-after-reference-repair",{[cap.id]:2},{[binding.id]:binding.revision},"REVISION_CONFLICT");
  reject("old-capability-after-reference-repair",{[cap.id]:1},{[binding.id]:binding.revision+1},"CAPABILITY_STALE");
  const request={workflowId:reviewed.id,expectedRevision:f.authoring.get(reviewed.id).revision,version:"1.0.1",expectedBindingRevisions:{[binding.id]:binding.revision+1},expectedCapabilityRevisions:{[cap.id]:2},idempotencyKey:"review-all-current"};
  const next=f.authoring.publish(request);assert.equal(next.snapshot.bindings[0].revision,binding.revision+1);assert.equal(next.snapshot.capabilities[0].capabilityRevision,2);
  const accepted=state();assert.deepEqual(f.authoring.publish(request),next);assert.equal(state(),accepted);assert.equal(JSON.stringify(f.repo.get("versions",old.id)),oldBytes);
});
