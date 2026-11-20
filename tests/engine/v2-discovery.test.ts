import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { scanHost as defaultScanHost, createContext } from "../../packages/host-discovery/src/index.js";
import { CapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import {nodeScriptRuntime} from "../helpers/discovery-runtime.js";
import {hash} from "../../packages/contracts/src/domain.js";
const scanHost=(context:any,depth="metadata")=>defaultScanHost(context,depth,{}, {},nodeScriptRuntime);

async function setup(t:any) {
  const root=await realpath(await mkdtemp(join(tmpdir(),"flowhub discovery 合成 "))),home=join(root,"codex"),cwd=join(root,"project");
  await mkdir(home);await mkdir(cwd);
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo),engine=new Engine(repo,vault,new Connectors(repo,vault)),registry=new CapabilityRegistry(engine,{hostRuntime:nodeScriptRuntime});
  t.after(async()=>{await registry.close();await engine.close();db.close();await rm(root,{recursive:true,force:true});});
  const cli=join(root,"fake-codex.mjs");
  const hostCatalog=join(home,"host-catalog.json");
  await writeFile(cli,`import fs from 'node:fs';import readline from 'node:readline';
const a=process.argv.slice(2);
if(a.includes('--version'))console.log('codex-cli 0.164.0-alpha.11.1');
else if(a.includes('--help'))console.log('--json');
else if(a.includes('app-server'))readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(!m.id)return;
  const fixture=JSON.parse(fs.readFileSync(${JSON.stringify(hostCatalog)},'utf8'));
  if(m.method==='skills/list'&&fixture.skillsError)console.log(JSON.stringify({id:m.id,error:{code:-32601,message:'Synthetic skill listing unavailable'}}));
  else console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:m.method==='mcpServerStatus/list'?fixture:{data:[]}}));
});
else console.log(fs.readFileSync(${JSON.stringify(join(home,"cli.json"))},'utf8'));`);
  await writeFile(join(home,"cli.json"),"[]");
  await writeFile(hostCatalog,'{"data":[]}');
  return {root,home,cwd,repo,registry,hostCatalog,context:async()=>{const context=await registry.context({codexHome:home,cwd,codexPath:cli});assert.equal(context.codexVersion,"codex-cli 0.164.0-alpha.11.1","Synthetic CLI must execute; fallback cannot satisfy this fixture.");return context;}};
}
test("read-only discovery distinguishes installed plugins, disabled components and marketplace entries",async t=>{
  const f=await setup(t);
  await writeFile(join(f.home,"config.toml"),'[plugins."installed@market"]\nenabled = false\n');
  const installed=join(f.home,"plugins/cache/market/installed/1.0"),available=join(f.home,"plugins/cache/market/available/1.0");
  for(const root of [installed,available]){await mkdir(join(root,".codex-plugin"),{recursive:true});await writeFile(join(root,".codex-plugin/plugin.json"),JSON.stringify({name:root===installed?"installed":"available",version:"1.0",mcpServers:"./.mcp.json"}));}
  await writeFile(join(installed,".mcp.json"),JSON.stringify({mcpServers:{one:{command:process.execPath,args:[]},two:{url:"https://example.invalid/mcp"}}}));
  await mkdir(join(installed,"skills/report"),{recursive:true});await writeFile(join(installed,"skills/report/SKILL.md"),"---\nname: 合成报告\ndescription: 合成技能\n---\nDo not execute hooks.");
  const context=await f.context(),before=await readFile(join(f.home,"config.toml"));
  const scan=await scanHost(context);
  assert.equal(scan.components.filter(c=>c.kind==="plugin").length,1);assert.equal(scan.components[0].enabled,false);
  assert.equal(scan.sources.length,2);assert.ok(scan.sources.every(s=>!s.enabled));
  assert.equal(scan.components.find(c=>c.kind==="skill")?.enabled,false);
  assert.deepEqual(await readFile(join(f.home,"config.toml")),before);
});
test("real MCP catalog discovery keeps duplicate tool names separate, revisions stable and credentials absent",async t=>{
  const f=await setup(t),entry=join(f.root,"synthetic-mcp.mjs");
  const server=import.meta.resolve("@modelcontextprotocol/server"),stdio=import.meta.resolve("@modelcontextprotocol/server/stdio");
  await writeFile(entry,`import {McpServer,fromJsonSchema} from ${JSON.stringify(server)};import {serveStdio} from ${JSON.stringify(stdio)};serveStdio(()=>{const s=new McpServer({name:'synthetic',version:'1'},{capabilities:{tools:{}}});s.registerTool('read',{inputSchema:fromJsonSchema({type:'object',properties:{},additionalProperties:false})},async()=>({content:[{type:'text',text:'合成原值'}]}));return s;},{legacy:'serve'});`);
  const servers=["a","b"].map(name=>({name,enabled:true,transport:{type:"stdio",command:process.execPath,args:[entry]}}));
  servers.push({name:"flowhub",enabled:true,transport:{type:"stdio",command:process.execPath,args:[entry]}});
  await writeFile(join(f.home,"cli.json"),JSON.stringify(servers));
  const c=await f.context(),accepted=f.registry.scan({contextId:c.id,depth:"catalog",idempotencyKey:"catalog"});await f.registry.idle();
  const status=f.registry.status(accepted.scanId);assert.equal(status.status,"SUCCEEDED");
  const caps=f.registry.search({contextId:c.id}).items;assert.equal(caps.length,2);assert.notEqual(caps[0].id,caps[1].id);assert.ok(!("inputSchema" in caps[0]));
  f.registry.scan({contextId:c.id,depth:"catalog",idempotencyKey:"again"});await f.registry.idle();
  assert.deepEqual(f.registry.search({contextId:c.id}).items.map(c=>c.revision),[1,1]);
  assert.equal(status.sources.find((s:any)=>s.name==="flowhub").self,true);
  const cap=caps[0];const imported=await f.registry.import({capabilityId:cap.id,expectedSourceRevision:1,target:"hub_direct",environment:"test",lockedArguments:{},idempotencyKey:"import"});
  const replay=await f.registry.import({capabilityId:cap.id,expectedSourceRevision:1,target:"hub_direct",environment:"test",lockedArguments:{},idempotencyKey:"import"});assert.deepEqual(replay,imported);
  assert.equal(f.repo.all("connections").length,1);assert.equal(f.repo.get("bindings",imported.bindingId).validationStatus,"UNVERIFIED");
  await writeFile(join(f.home,"cli.json"),"[]");
  f.registry.scan({contextId:c.id,depth:"metadata",idempotencyKey:"missing"});await f.registry.idle();
  assert.equal(f.registry.search({contextId:c.id}).items[0].stale,true);
  assert.equal(f.repo.all("connections").length,1);assert.equal(f.repo.all("bindings").length,1);
});
test("TOML fallback parses quoted names and multiline arrays; untrusted projects and foreign locations stay separate",async t=>{
  const f=await setup(t);
  await writeFile(join(f.home,"config.toml"),'[mcp_servers."quoted.name"]\ncommand = '+JSON.stringify(process.execPath)+'\nargs = [\n"one",\n"two"\n]\n[profiles.demo.mcp_servers.extra]\nurl = "https://example.invalid/mcp"\n');
  await mkdir(join(f.cwd,".codex"));await writeFile(join(f.cwd,".codex/config.toml"),'[mcp_servers.project]\nurl = "https://project.invalid/mcp"\n');
  const c={...await f.context(),codexPath:null,profile:"demo"};
  const staticScan=await scanHost(c);
  assert.equal(staticScan.resolutionQuality,"partial");assert.equal(staticScan.sources.length,2);assert.deepEqual(staticScan.sources[0].config.args,["one","two"]);
  assert.ok(staticScan.issues.some(i=>i.code==="CODEX_NOT_FOUND"));
  const trusted=await scanHost({...c,projectTrusted:true});assert.equal(trusted.sources.length,3);
  const foreign=await scanHost({...c,executionLocation:"unsupported-other-host"});assert.ok(foreign.issues.some(i=>i.code==="EXECUTION_LOCATION_UNSUPPORTED"));
});
test("metadata scans report broken sources and never store inline credential values",async t=>{
  const f=await setup(t);await writeFile(join(f.home,"config.toml"),'broken = [');
  await writeFile(join(f.home,"cli.json"),JSON.stringify([{name:"private",enabled:true,transport:{type:"stdio",command:process.execPath,args:["--private-value=SYNTHETIC_TOKEN"],env:{ACCESS_TOKEN:"DO_NOT_STORE_KEY"}}}]));
  const c=await f.context(),job=f.registry.scan({contextId:c.id,depth:"metadata",idempotencyKey:"read"});await f.registry.idle();
  const status=f.registry.status(job.scanId);assert.equal(status.status,"PARTIAL");
  assert.ok(!JSON.stringify(status).includes("DO_NOT_STORE_KEY"));assert.ok(!JSON.stringify(status).includes("SYNTHETIC_TOKEN"));
  assert.equal(status.sources[0].availability,"unsupported");
  assert.equal(f.repo.all("connections").length,0);
});
test("explicit local credential import seals inline env, preserves source, and enables independent catalog",async t=>{
  const f=await setup(t),entry=join(f.root,"authenticated-mcp.mjs");
  f.registry.engine.vault.initialize("Synthetic-credential-password");
  await writeFile(entry,`import {McpServer,fromJsonSchema} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server"))};import {serveStdio} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))};if(process.env.ACCESS_TOKEN!=='SYNTHETIC_PRIVATE_VALUE')process.exit(2);serveStdio(()=>{const s=new McpServer({name:'credential-fixture',version:'1'},{capabilities:{tools:{}}});s.registerTool('read',{inputSchema:fromJsonSchema({type:'object',additionalProperties:false})},async()=>({content:[{type:'text',text:'ok'}]}));return s;},{legacy:'serve'});`);
  const original=JSON.stringify([{name:"private",enabled:true,transport:{type:"stdio",command:process.execPath,args:[entry],env:{ACCESS_TOKEN:"SYNTHETIC_PRIVATE_VALUE"}}}]);
  await writeFile(join(f.home,"cli.json"),original);
  const context=await f.context();const before=f.registry.scan({contextId:context.id,depth:"catalog",idempotencyKey:"before"});await f.registry.idle();assert.equal(f.registry.search().items.length,0);assert.equal(f.registry.status(before.scanId).status,"PARTIAL");assert.ok(f.registry.status(before.scanId).issues.some((i:any)=>i.code==="CREDENTIALS_REQUIRED"));
  const source=f.repo.all("capability_sources")[0],args={sourceId:source.id,expectedRevision:source.revision,idempotencyKey:"configure",importInlineCredentials:true};
  await assert.rejects(f.registry.configureSource(args,"some-mcp-owner"),{code:"AUTH_REQUIRED"});
  const imported=await f.registry.configureSource(args);assert.deepEqual(await f.registry.configureSource(args),imported);
  const connection=f.repo.get("connections",imported.connectionId);assert.equal(f.registry.engine.vault.secret(connection.envRefs.ACCESS_TOKEN),"SYNTHETIC_PRIVATE_VALUE");
  for(const table of ["capability_sources","connections","secrets","discovery_jobs"] as const)assert.ok(!JSON.stringify(f.repo.all(table)).includes("SYNTHETIC_PRIVATE_VALUE"));
  assert.equal(await readFile(join(f.home,"cli.json"),"utf8"),original);
  f.registry.scan({contextId:context.id,depth:"catalog",idempotencyKey:"after"});await f.registry.idle();assert.equal(f.registry.search().items.length,1);
  const cap=f.registry.search().items[0],binding=await f.registry.import({capabilityId:cap.id,expectedSourceRevision:cap.revision,target:"hub_direct",environment:"test",idempotencyKey:"binding"});
  assert.equal(f.repo.get("bindings",binding.bindingId).validationStatus,"UNVERIFIED");
});
test("context trust options use CAS and do not silently mutate an existing registration",async t=>{
  const f=await setup(t),context=await f.context();
  await assert.rejects(f.registry.context({codexHome:f.home,cwd:f.cwd,codexPath:context.codexPath,projectTrusted:true}),{code:"CONTEXT_REGISTRATION_CONFLICT"});
  assert.equal(f.repo.get("host_contexts",context.id).projectTrusted,false);
  const updated=await f.registry.context({contextId:context.id,codexHome:f.home,cwd:f.cwd,codexPath:context.codexPath,projectTrusted:true,expectedRevision:1});assert.equal(updated.projectTrusted,true);assert.equal(updated.revision,2);
  await assert.rejects(f.registry.context({contextId:context.id,codexHome:f.home,cwd:f.cwd,codexPath:context.codexPath,expectedRevision:1}),{code:"REVISION_CONFLICT"});
});
test("credential command arguments remain metadata-only and are never copied into connection rows",async t=>{
  const f=await setup(t);await writeFile(join(f.home,"cli.json"),JSON.stringify([{name:"argv-auth",enabled:true,transport:{type:"stdio",command:process.execPath,args:["--api-key=SYNTHETIC_ARG_SECRET"]}}]));
  const context=await f.context(),job=f.registry.scan({contextId:context.id,depth:"catalog",idempotencyKey:"argv"});await f.registry.idle();const source=f.registry.status(job.scanId).sources[0];assert.equal(source.availability,"credentials_required");
  await assert.rejects(f.registry.configureSource({sourceId:source.id,expectedRevision:source.revision,idempotencyKey:"deny-argv",importInlineCredentials:true}),{code:"CREDENTIAL_IMPORT_UNSUPPORTED"});
  assert.equal(f.repo.all("connections").length,0);assert.ok(!JSON.stringify(f.repo.all("capability_sources")).includes("SYNTHETIC_ARG_SECRET"));
});

const fixtureTool=(name="read")=>{
  const inputSchema={type:"object",properties:{},additionalProperties:false};
  return {name,description:"合成目录工具",inputSchema,schemaHash:"sha256:"+hash({inputSchema,outputSchema:null})};
};
async function synthetic(f:Awaited<ReturnType<typeof setup>>,config:any={}) {
  await writeFile(join(f.home,"config.toml"),"");
  await writeFile(join(f.home,"cli.json"),JSON.stringify([{name:"one",enabled:true,transport:{type:"http",url:"https://old.invalid/mcp"},...config}]));
}
async function scanned(f:Awaited<ReturnType<typeof setup>>,context:any,key:string,depth="catalog") {
  const scan=f.registry.scan({contextId:context.id,depth,idempotencyKey:key});await f.registry.idle();return f.registry.status(scan.scanId);
}
const request=(cap:any,key:string,environment="test")=>({capabilityId:cap.id,expectedSourceRevision:cap.revision,target:"hub_direct",environment,lockedArguments:{},idempotencyKey:key});

test("Codex-only sync keeps per-server coverage, blocks cached tools on explicit auth or omission, and preserves the diagnosis on metadata scans",async t=>{
  const f=await setup(t),names=["protected","unreachable","empty","healthy","omitted"];
  await writeFile(join(f.home,"cli.json"),JSON.stringify(names.map(name=>({
    name,enabled:true,transport:{type:"http",url:"https://"+name+".invalid/mcp",bearer_token_env_var:"FIXTURE_TOKEN"},
  }))));
  let directProbes=0;
  f.registry.engine.connectors.discover=async c=>{directProbes++;return {...c,tools:[]};};
  const definitions=Object.fromEntries(names.map(name=>[name,{...fixtureTool(name+"-read"),outputSchema:{type:"object"}}]));
  const server=(name:string,tools:Record<string,unknown>,extra={})=>({name,tools,authStatus:"unknown",...extra});
  await writeFile(f.hostCatalog,JSON.stringify({data:names.map(name=>server(name,{read:definitions[name]}))}));
  const context=await f.context();
  assert.equal((await scanned(f,context,"host-only","host_catalog")).status,"SUCCEEDED");
  const find=(name:string)=>f.registry.search({contextId:context.id,executor:"codex_host",query:name+"-read"}).items[0];
  const original=find("protected");
  assert.equal(original.stale,false);
  await f.registry.import({...request(original,"known-auth-first"),target:"codex_host"});
  await writeFile(f.hostCatalog,JSON.stringify({nextCursor:"more",data:[
    server("protected",{read:definitions.protected},{authStatus:"notLoggedIn"}),
    server("unreachable",{},{toolsError:"401 SYNTHETIC_DO_NOT_EXPOSE"}),
    server("empty",{}),
    server("healthy",{read:definitions.healthy}),
  ]}));
  assert.equal((await scanned(f,context,"partial-host","host_catalog")).status,"PARTIAL");
  for(const name of ["protected","unreachable","empty","omitted"]) {
    const cap=find(name);assert.equal(cap.stale,true,name);
    await assert.rejects(f.registry.import({...request(cap,"cannot-add-"+name),target:"codex_host"}),{code:"CAPABILITY_STALE"});
  }
  assert.equal(find("healthy").stale,false);
  const list=()=>f.registry.catalog.search({contextId:context.id,kind:"mcp_server"});
  assert.deepEqual(list().items.find((entity:any)=>entity.name==="empty")?.toolCount,0);
  assert.deepEqual(list().items.find((entity:any)=>entity.name==="protected")?.hostAuthRequired,true);
  assert.deepEqual(list().items.find((entity:any)=>entity.name==="unreachable")?.hostAuthRequired,false);
  assert.ok(!JSON.stringify(list()).includes("SYNTHETIC_DO_NOT_EXPOSE"));
  const old=f.registry.get({capabilityId:original.id,includeSchemas:true});assert.equal(old.stale,true);assert.ok(old.outputSchema);
  await scanned(f,context,"metadata-after-host","metadata");
  assert.deepEqual(list().items.find((entity:any)=>entity.name==="protected")?.hostAuthRequired,true);
  assert.equal(directProbes,0);
  assert.equal(f.repo.all("connections").length,0);
  assert.equal(f.repo.all("bindings").length,0);
});

test("an explicitly selected direct connection retains its actionable failure without changing the ready host path",async t=>{
  const f=await setup(t);await synthetic(f);
  await writeFile(f.hostCatalog,JSON.stringify({data:[
    {name:"one",tools:{read:{...fixtureTool(),outputSchema:{type:"object"}}}},
  ]}));
  const context=await f.context();
  await scanned(f,context,"before-direct","host_catalog");
  const [source]=f.registry.catalog.search({contextId:context.id,kind:"mcp_server"}).items;
  const host=f.registry.search({contextId:context.id,sourceId:source.id,executor:"codex_host"}).items[0];
  assert.ok(host);
  assert.equal(f.registry.catalog.overview(context.id).issues.length,0);
  const prepared=await f.registry.configureSource({sourceId:source.id,expectedRevision:source.configurationRevision,idempotencyKey:"explicit-opt-in"});
  f.registry.engine.connectors.discover=async()=>{throw new Error("synthetic connector error");};
  await assert.rejects(f.registry.detectSource(source.id,prepared.revision),/synthetic connector error/);
  const current=f.registry.catalog.get(source.id);
  assert.equal(current.hostCatalogReady,true);
  assert.equal(current.availability,"unreachable");
  assert.equal(f.registry.get({capabilityId:host.id}).stale,false);
  assert.ok(f.registry.catalog.overview(context.id).issues.some((issue:any)=>issue.code==="DIRECT_CATALOG_NOT_SYNCED"&&issue.entityId===source.id));
  f.registry.engine.connectors.discover=async c=>({...c,tools:[fixtureTool("direct-read")]});
  await f.registry.detectSource(source.id,prepared.revision);
  const sameHost=f.registry.get({capabilityId:host.id});
  assert.equal(sameHost.revision,host.revision);
  assert.equal(sameHost.stale,false);
  assert.equal(f.registry.catalog.get(source.id).availability,"ready");
  assert.equal(f.registry.catalog.overview(context.id).issues.length,0);
  await f.registry.import({...request(sameHost,"still-host"),target:"codex_host"});
});

test("a failed Skill request does not block an independently available Codex tool catalog",async t=>{
  const f=await setup(t);await synthetic(f);
  await writeFile(f.hostCatalog,JSON.stringify({skillsError:true,data:[
    {name:"one",tools:{read:{...fixtureTool(),outputSchema:{type:"object"}}}},
  ]}));
  const context=await f.context(),result=await scanned(f,context,"host-skill-optional","host_catalog");
  assert.equal(result.status,"PARTIAL");
  const cap=f.registry.search({contextId:context.id,executor:"codex_host"}).items[0];
  assert.ok(cap);assert.equal(cap.stale,false);assert.equal(cap.hasToolContract,true);
});

test("static same-name sources cannot reuse a cached host identity and exact plugin evidence resolves the selected source",async t=>{
  const f=await setup(t);
  await synthetic(f,{name:"shared"});
  const tool={...fixtureTool(),outputSchema:{type:"object"}};
  const report=(extra={})=>writeFile(f.hostCatalog,JSON.stringify({data:[{name:"shared",tools:{read:tool},...extra}]}));
  const context=await f.context();
  await report();await scanned(f,context,"original-host","host_catalog");
  const prior=f.registry.search({contextId:context.id,executor:"codex_host"}).items[0];
  const plugin=join(f.home,"plugins/cache/market/independent/1.0");
  await mkdir(join(plugin,".codex-plugin"),{recursive:true});
  await writeFile(join(plugin,".codex-plugin/plugin.json"),JSON.stringify({name:"independent",mcpServers:"./.mcp.json"}));
  await writeFile(join(plugin,".mcp.json"),JSON.stringify({mcpServers:{shared:{url:"https://plugin.invalid/mcp"}}}));
  await writeFile(join(f.home,"config.toml"),'[plugins."independent@market"]\nenabled = true\n');
  await scanned(f,context,"ambiguous","host_catalog");
  const sources=()=>f.registry.catalog.search({contextId:context.id,kind:"mcp_server"}).items;
  assert.equal(sources().length,2);
  assert.ok(sources().every((entity:any)=>entity.hostCatalogStatus==="ambiguous"));
  assert.equal(f.registry.get({capabilityId:prior.id}).stale,true);
  await report({pluginId:"independent@market",httpOrigin:"https://plugin.invalid"});
  await scanned(f,context,"verified-plugin","host_catalog");
  const current=f.registry.search({contextId:context.id,executor:"codex_host"}).items.find((cap:any)=>!cap.stale);
  assert.ok(current);
  assert.notEqual(current.id,prior.id);
  assert.equal(current.provenance.serverSourceId,sources().find((entity:any)=>!!entity.pluginId).id);
  assert.notEqual(current.provenance.serverSourceId,prior.provenance.serverSourceId);
});

test("source and tool disables invalidate old catalog and never reconnect during import",async t=>{
  const f=await setup(t);let calls=0;f.registry.engine.connectors.discover=async c=>{calls++;return {...c,tools:[fixtureTool("read"),fixtureTool("delete")]};};
  await synthetic(f);const context=await f.context();await scanned(f,context,"before");
  await synthetic(f,{disabled_tools:["delete"]});await scanned(f,context,"deny");
  const denied=f.registry.search().items.find((c:any)=>c.name==="delete");assert.equal(denied.enabled,"disabled");
  const before=calls;await assert.rejects(f.registry.import(request(denied,"deny-import")),{code:"CAPABILITY_STALE"});assert.equal(calls,before);
  await synthetic(f,{enabled:false});await scanned(f,context,"disabled","metadata");
  for(const cap of f.registry.search().items){assert.equal(cap.enabled,"disabled");assert.notEqual(cap.availability,"ready");await assert.rejects(f.registry.import(request(cap,"disabled-"+cap.id)),{code:"CAPABILITY_STALE"});}
  assert.equal(calls,before);
});

test("current source revision gets a new connection; successful replay is independent of source and network",async t=>{
  const f=await setup(t);let calls=0,offline=false;f.registry.engine.connectors.discover=async c=>{calls++;if(offline)throw new Error("offline");return {...c,tools:[fixtureTool()]};};
  await synthetic(f);const context=await f.context();await scanned(f,context,"old");let cap=f.registry.search().items[0];const oldRequest=request(cap,"old-import"),old=await f.registry.import(oldRequest);
  const oldConnection=f.repo.get("connections",old.connectionId);await synthetic(f,{transport:{type:"http",url:"https://new.invalid/mcp"}});await scanned(f,context,"new");cap=f.registry.search().items[0];assert.equal(cap.revision,2);
  const current=await f.registry.import(request(cap,"new-import","staging"));assert.notEqual(current.connectionId,old.connectionId);assert.equal(f.repo.get("connections",current.connectionId).endpoint,"https://new.invalid/mcp");assert.deepEqual(f.repo.get("connections",old.connectionId),oldConnection);
  offline=true;const before=calls;assert.deepEqual(await f.registry.import(oldRequest),old);assert.equal(calls,before);
  await assert.rejects(f.registry.import({...oldRequest,environment:"production"}),{code:"IDEMPOTENCY_CONFLICT"});
});

test("older scans and context drift cannot overwrite newer current catalog",async t=>{
  const f=await setup(t);let start!:()=>void,release!:()=>void;const started=new Promise<void>(r=>start=r),blocked=new Promise<void>(r=>release=r);
  f.registry.engine.connectors.discover=async c=>{if(c.endpoint.includes("old.invalid")){start();await blocked;}return {...c,tools:[fixtureTool(c.endpoint.includes("old.invalid")?"oldTool":"newTool")]};};
  await synthetic(f);const context=await f.context(),old=f.registry.scan({contextId:context.id,depth:"catalog",idempotencyKey:"slow-old"});await started;
  await synthetic(f,{transport:{type:"http",url:"https://new.invalid/mcp"}});const newer=f.registry.scan({contextId:context.id,depth:"catalog",idempotencyKey:"fast-new"});
  while(!["SUCCEEDED","PARTIAL","FAILED"].includes(f.registry.status(newer.scanId).status))await new Promise(r=>setTimeout(r,2));release();await f.registry.idle();
  assert.equal(f.registry.status(old.scanId).status,"PARTIAL");assert.equal(f.registry.status(old.scanId).issues[0].code,"SCAN_SUPERSEDED");assert.deepEqual(f.registry.search().items.map((c:any)=>[c.name,c.stale]),[["newTool",false]]);
  let releaseAgain!:()=>void,startAgain!:()=>void;const beganAgain=new Promise<void>(r=>startAgain=r);f.registry.engine.connectors.discover=async c=>{startAgain();await new Promise<void>(r=>releaseAgain=r);return {...c,tools:[fixtureTool("trustDrift")]};};
  const drift=f.registry.scan({contextId:context.id,depth:"catalog",idempotencyKey:"drift"});await beganAgain;await f.registry.context({contextId:context.id,codexHome:f.home,cwd:f.cwd,codexPath:context.codexPath,projectTrusted:true,expectedRevision:context.revision});releaseAgain();await f.registry.idle();assert.equal(f.registry.status(drift.scanId).issues[0].code,"CONTEXT_CHANGED");assert.equal(f.registry.search().items[0].name,"newTool");
});

test("command credentials and URL/header forms stay metadata only without plaintext in ordinary records",async t=>{
  const f=await setup(t);let calls=0;f.registry.engine.connectors.discover=async c=>{calls++;return {...c,tools:[fixtureTool()]};};
  const variants=[["--client-secret=SYNTHETIC_ARG_SECRET"],["--client_secret","SYNTHETIC_ARG_SECRET"],["--access-token=SYNTHETIC_ARG_SECRET"],["--token=SYNTHETIC_ARG_SECRET"],["-H","Authorization: Bearer SYNTHETIC_ARG_SECRET"],["--endpoint=https://user:SYNTHETIC_ARG_SECRET@example.invalid/mcp"]];
  await writeFile(join(f.home,"config.toml"),"");await writeFile(join(f.home,"cli.json"),JSON.stringify(variants.map((args,i)=>({name:"credential-"+i,enabled:true,transport:{type:"stdio",command:process.execPath,args}}))));
  const context=await f.context();const scan=await scanned(f,context,"all-credentials");assert.equal(calls,0);assert.equal(scan.sources.length,variants.length);
  for(const source of scan.sources){assert.equal(source.availability,"credentials_required");await assert.rejects(f.registry.configureSource({sourceId:source.id,expectedRevision:source.revision,idempotencyKey:source.id,importInlineCredentials:true}),{code:"CREDENTIAL_IMPORT_UNSUPPORTED"});}
  for(const table of ["connections","capability_sources","capabilities","capability_revisions","discovery_jobs"] as const)assert.ok(!JSON.stringify(f.repo.all(table)).includes("SYNTHETIC_ARG_SECRET"));
});

test("skill enablement, plugin server overrides and CLI allow/deny policy are effective",async t=>{
  const f=await setup(t);await mkdir(join(f.home,"skills/report"),{recursive:true});await writeFile(join(f.home,"skills/report/SKILL.md"),"---\nname: report\ndescription: synthetic\n---\nfixture");
  await writeFile(join(f.home,"config.toml"),'[[skills.config]]\npath = '+JSON.stringify(join(f.home,"skills/report"))+'\nenabled = false\n');
  await writeFile(join(f.home,"cli.json"),JSON.stringify([{name:"one",enabled:true,enabled_tools:["read","delete"],disabled_tools:["delete"],transport:{type:"http",url:"https://fixture.invalid/mcp"}}]));
  f.registry.engine.connectors.discover=async c=>({...c,tools:[fixtureTool("read"),fixtureTool("delete"),fixtureTool("other")]});const context=await f.context();await scanned(f,context,"skill-policy");
  const caps=f.registry.search().items;assert.equal(caps.find((c:any)=>c.name==="report").enabled,"disabled");assert.equal(caps.find((c:any)=>c.name==="delete").enabled,"disabled");assert.equal(caps.find((c:any)=>c.name==="other").enabled,"disabled");
  const skill=caps.find((c:any)=>c.name==="report");await assert.rejects(f.registry.import({...request(skill,"disabled-skill"),target:"codex_host"}),{code:"CAPABILITY_STALE"});
});

test("HTTP self aliases normalize independently of server label and protocol identity blocks recursion",async t=>{
  const f=await setup(t);f.registry.setSelfIdentity({endpoints:["http://127.0.0.1:3792/mcp"],instanceId:"synthetic-self"});
  await synthetic(f,{name:"innocent-alias",transport:{type:"http",url:"http://localhost:3792/mcp/"}});const context=await f.context();const scan=await scanned(f,context,"self","metadata");assert.equal(scan.sources[0].self,true);assert.equal(scan.sources[0].executor,"informational");
  await synthetic(f,{name:"remote-alias"});f.registry.engine.connectors.discover=async c=>({...c,tools:[fixtureTool()],serverInfo:{name:"flowhub",version:"2"}});const remote=await scanned(f,context,"protocol-self");assert.equal(remote.sources[0].self,true);assert.equal(f.registry.search().items.length,0);
});

test("close aborts a pending catalog, persists terminal state and rejects subsequent work",async t=>{
  const f=await setup(t);let started!:()=>void;const begin=new Promise<void>(r=>started=r);f.registry.engine.connectors.discover=async()=>{started();return new Promise(()=>{});};
  await synthetic(f);const context=await f.context(),scan=f.registry.scan({contextId:context.id,depth:"catalog",idempotencyKey:"pending-close"});await begin;
  const before=performance.now();await f.registry.close();assert.ok(performance.now()-before<500);assert.equal(f.registry.status(scan.scanId).status,"CANCELLED");assert.throws(()=>f.registry.scan({contextId:context.id,depth:"catalog",idempotencyKey:"after-close"}),{code:"SERVICE_CLOSING"});
});

test("catalog deadline covers real SDK tools/list and closes the child transport",async t=>{
  const f=await setup(t),entry=join(f.root,"slow-catalog.mjs"),exitMarker=join(f.root,"exited"),listedMarker=join(f.root,"listed");
  await writeFile(entry,`import {Server} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server"))};import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))};import fs from 'node:fs';process.on('exit',()=>fs.writeFileSync(${JSON.stringify(exitMarker)},'done'));process.on('SIGTERM',()=>process.exit(0));const s=new Server({name:'slow-fixture',version:'1'},{capabilities:{tools:{}}});s.setRequestHandler('tools/list',async()=>{fs.writeFileSync(${JSON.stringify(listedMarker)},'listed');return new Promise(()=>{});});await s.connect(new StdioServerTransport());`);
  const connectors=f.registry.engine.connectors,before=performance.now();await assert.rejects(connectors.discover({id:"slow",revision:1,transport:"stdio",protocolEra:"legacy",command:process.execPath,args:[entry],envRefs:{},commandApproved:true,tools:[]},{timeoutMs:500}));assert.ok(performance.now()-before<2000);assert.equal(await readFile(listedMarker,"utf8"),"listed");assert.equal(await readFile(exitMarker,"utf8"),"done");
});

test("SQL capability pages exclude schemas, filter sources/environment and reject stale cursors; benchmark 200/1000",async t=>{
  const f=await setup(t),measurements:any[]=[];
  for(const count of [200,1000]) {
    for(let i=f.repo.all("capabilities").length;i<count;i++)f.repo.put("capabilities","perf-"+String(i).padStart(4,"0"),{id:"perf-"+String(i).padStart(4,"0"),capabilityId:"perf-"+String(i).padStart(4,"0"),revision:1,contextId:"perf",kind:"mcp_tool",executor:"hub_direct",name:"合成能力 "+i,description:"performance synthetic",sourceRefs:[{sourceId:i%2?"odd":"even",revision:1}],inputSchema:{type:"object",description:"x".repeat(10000)},tool:{schema:"x".repeat(10000)},skillContent:"x".repeat(10000),stale:false});
    const timings:number[]=[];for(let j=0;j<40;j++){const start=performance.now();const page=f.registry.search({query:"合成能力",contextId:"perf",limit:20});timings.push(performance.now()-start);assert.equal(page.items.length,20);assert.ok(!JSON.stringify(page).includes("xxxxxxxxxx"));}timings.sort((a,b)=>a-b);const p95=timings[Math.floor(timings.length*.95)]!;measurements.push({capabilities:count,schemaBytesPerCapability:30000,samples:40,p95Ms:p95});assert.ok(p95<200,"search P95 below 200 ms on this synthetic fixture");
  }
  const page=f.registry.search({query:"",sourceId:"odd",limit:20});assert.equal(page.items.length,20);assert.ok(page.nextCursor);assert.ok(f.registry.search({query:"",sourceId:"odd",cursor:page.nextCursor}).items.every((c:any)=>!page.items.some((p:any)=>p.id===c.id)));
  f.repo.put("bindings","perf-binding",{id:"perf-binding",revision:1,sourceCapabilityId:"perf-0001",environment:"test"});assert.equal(f.registry.search({environment:"test"}).items.length,1);
  f.repo.put("capabilities","perf-0001",{...f.repo.get("capabilities","perf-0001"),revision:2});assert.throws(()=>f.registry.search({query:"",sourceId:"odd",cursor:page.nextCursor}),{code:"CAPABILITY_STALE"});
  t.diagnostic(JSON.stringify({discoveryPerformance:measurements}));await writeFile(join(tmpdir(),"flowhub-discovery-performance.json"),JSON.stringify({fixture:"isolated in-memory SQLite; synthetic capabilities; no real Codex/MCP",measurements},null,2));
});

test("plugin per-server deny rules and custom Skill/app components preserve installed provenance",async t=>{
  const f=await setup(t),root=join(f.home,"plugins/cache/market/custom/1.0");await mkdir(join(root,".codex-plugin"),{recursive:true});await mkdir(join(root,"custom-skill"));
  await writeFile(join(f.home,"config.toml"),'[plugins."custom@market"]\nenabled = true\n[plugins."custom@market".mcp_servers.hidden]\nenabled = false\n[plugins."custom@market".mcp_servers.visible]\nenabled_tools = ["read"]\ndisabled_tools = ["delete"]\n');
  await writeFile(join(root,".codex-plugin/plugin.json"),JSON.stringify({name:"custom",mcpServers:"./.mcp.json",skills:["./custom-skill"],apps:"./.app.json"}));
  await writeFile(join(root,".mcp.json"),JSON.stringify({mcpServers:{hidden:{url:"https://hidden.invalid/mcp"},visible:{url:"https://visible.invalid/mcp"}}}));await writeFile(join(root,"custom-skill/SKILL.md"),"---\nname: custom-report\n---\nsynthetic");await writeFile(join(root,".app.json"),JSON.stringify({apps:{calendar:{id:"synthetic-app"}}}));
  const context=await f.context(),scan=await scanHost(context);assert.equal(scan.sources.find((s:any)=>s.name==="hidden").enabled,false);assert.deepEqual(scan.sources.find((s:any)=>s.name==="visible").config.disabled_tools,["delete"]);assert.equal(scan.components.find((c:any)=>c.name==="custom-report").parent,"custom@market");assert.equal(scan.components.find((c:any)=>c.kind==="app").executor,"informational");
});

test("App Server effective disabled Skill corrects an already indexed path",async t=>{
  const f=await setup(t),skill=join(f.home,"skills/report/SKILL.md"),cli=join(f.root,"app-codex.mjs");await mkdir(join(f.home,"skills/report"),{recursive:true});await writeFile(skill,"---\nname: report\n---\nsynthetic");await writeFile(join(f.home,"config.toml"),"");
  await writeFile(cli,`import readline from 'node:readline';const a=process.argv.slice(2);if(a.includes('--version'))console.log('codex-cli 0.164.0-alpha.11.1');else if(a.includes('--help'))console.log('--json');else if(a.includes('app-server')){readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{}:{data:[{skills:[{name:'report',description:'effective disabled',path:${JSON.stringify(skill)},enabled:false}]}]}}));});}else console.log('[]');`);
  const context=await f.registry.context({codexHome:f.home,cwd:f.cwd,codexPath:cli,useAppServer:true}),scan=await scanHost(context);assert.equal(scan.components.filter((c:any)=>c.kind==="skill").length,1);assert.equal(scan.components[0].enabled,false);assert.equal(scan.components[0].hostReported,true);
  const oldBinary = await readFile(cli,"utf8");
  await writeFile(cli,oldBinary.replace("0.164.0-alpha.11.1","0.169.0-alpha.11.1"));
  const upgraded = await scanHost(context);
  assert.ok(upgraded.components.some((entry:any)=>entry.kind==="skill"&&entry.hostReported&&entry.enabled===false));
  await writeFile(cli,oldBinary.replace("0.164.0-alpha.11.1","9.0.0"));
  const unsupported = await scanHost(context);
  assert.ok(unsupported.issues.some((issue:any)=>issue.code==="HOST_VERSION_UNSUPPORTED"));
  assert.ok(!unsupported.components.some((entry:any)=>entry.hostReported));
});

test("concurrent source discovery exposes successful sources before a slow one and scan cancel is durable",async t=>{
  const f=await setup(t);await writeFile(join(f.home,"config.toml"),"");await writeFile(join(f.home,"cli.json"),JSON.stringify(["slow","fast-a","fast-b","fast-c","fast-d"].map(name=>({name,enabled:true,transport:{type:"http",url:"https://"+name+".invalid/mcp"}}))));
  let slowStarted!:()=>void;const begin=new Promise<void>(r=>slowStarted=r);f.registry.engine.connectors.discover=async c=>{if(c.endpoint.includes("slow")){slowStarted();await new Promise(()=>{});}return {...c,tools:[fixtureTool(c.endpoint)]};};
  const context=await f.context(),scan=f.registry.scan({contextId:context.id,depth:"catalog",idempotencyKey:"concurrent"});await begin;
  for(let i=0;i<100&&f.registry.search().items.length<4;i++)await new Promise(r=>setTimeout(r,2));assert.equal(f.registry.search().items.length,4);assert.equal(f.registry.status(scan.scanId).status,"DISCOVERING_CATALOG");f.registry.cancel(scan.scanId);await f.registry.idle();assert.equal(f.registry.status(scan.scanId).status,"CANCELLED");
});

test("HTTP discovery validates the same DTO and decodes false query flags",async t=>{
  const f=await setup(t),{default:Fastify}=await import("fastify"),{registerV2}=await import("../../packages/admin-api/src/v2.js"),{AuthoringService}=await import("../../packages/workflow-authoring/src/index.js"),app=Fastify();registerV2(app,new AuthoringService(f.registry.engine),f.registry);
  f.repo.put("capabilities","http-cap",{id:"http-cap",capabilityId:"http-cap",revision:1,contextId:"http",kind:"mcp_tool",name:"read",description:"",inputSchema:{type:"object"},skillContent:"secret instructional fixture"});
  try {
    const summary=await app.inject({method:"GET",url:"/api/v2/capabilities/http-cap?includeSchemas=false&includeSkillContent=false"});assert.equal(summary.statusCode,200);assert.ok(!("inputSchema" in summary.json().data));assert.ok(!("skillContent" in summary.json().data));
    for(const url of ["/api/v2/capabilities?limit=NaN","/api/v2/capabilities/http-cap?includeSchemas=no","/api/v2/capabilities?executor=unknown","/api/v2/capabilities/http-cap?revision=-1"])assert.ok((await app.inject({method:"GET",url})).statusCode>=400);
    assert.ok((await app.inject({method:"POST",url:"/api/v2/capabilities/http-cap/import",payload:{expectedSourceRevision:1,target:"wrong",environment:"test",lockedArguments:{},idempotencyKey:"invalid"}})).statusCode>=400);
    assert.ok((await app.inject({method:"POST",url:"/api/v2/host-scans",payload:{depth:"catalog",idempotencyKey:"invalid"}})).statusCode>=400);
    assert.ok((await app.inject({method:"POST",url:"/api/v2/host-contexts",payload:{codexHome:f.home,cwd:f.cwd,hostRuntime:{command:"shell"}}})).statusCode>=400,"Subprocess runtime injection is not an HTTP/context DTO field.");
  }finally{await app.close();}
});

test("schema-only and description-only catalog drift create immutable connections with matching contracts",async t=>{
  const f=await setup(t),{hash}=await import("../../packages/contracts/src/domain.js");let tool=fixtureTool();f.registry.engine.connectors.discover=async c=>({...c,tools:[structuredClone(tool)]});await synthetic(f);const context=await f.context();await scanned(f,context,"schema-old");let cap=f.registry.search().items[0],receipt=await f.registry.import(request(cap,"schema-old-import")),prior=f.repo.get("connections",receipt.connectionId);
  const saved=[structuredClone(prior)];
  for(const [index,patch] of [
    {inputSchema:{type:"object",properties:{requiredField:{type:"string"}},required:["requiredField"],additionalProperties:false}},
    {outputSchema:{type:"object",properties:{result:{type:"string"}},required:["result"],additionalProperties:false}},
    {description:"新的真实目录说明"}
  ].entries()) {
    tool={...tool,...patch};tool.schemaHash="sha256:"+hash({inputSchema:tool.inputSchema,outputSchema:(tool as any).outputSchema??null});await scanned(f,context,"schema-change-"+index);cap=f.registry.search().items[0];const next=await f.registry.import(request(cap,"schema-import-"+index,"staging")),connection=f.repo.get("connections",next.connectionId),binding=f.repo.get("bindings",next.bindingId);
    assert.notEqual(next.connectionId,receipt.connectionId);assert.equal(binding.sourceCapabilityRevision,cap.revision);assert.equal(binding.connectionRevision,connection.revision);assert.deepEqual(connection.tools[0].inputSchema,tool.inputSchema);assert.deepEqual(connection.tools[0].outputSchema??null,(tool as any).outputSchema??null);assert.equal(connection.tools[0].schemaHash,cap.tool?.schemaHash??f.registry.get({capabilityId:cap.id,includeSchemas:true}).tool.schemaHash);
    assert.deepEqual(f.repo.get("connections",prior.id),prior);assert.deepEqual(f.repo.get("bindings",receipt.bindingId).connectionId,prior.id);saved.push(structuredClone(connection));prior=connection;receipt=next;
  }
  await scanned(f,context,"schema-identical");const stable=await f.registry.import(request(f.registry.search().items[0],"schema-identical-import","production"));assert.equal(stable.connectionId,receipt.connectionId);for(const connection of saved)assert.deepEqual(f.repo.get("connections",connection.id),connection);
});

test("unchanged metadata preserves catalog semantics, real draft capability refs and accepted self-test baseline",async t=>{
  const f=await setup(t),{AuthoringService}=await import("../../packages/workflow-authoring/src/index.js"),{WorkflowTesting}=await import("../../packages/workflow-testing/src/index.js");f.registry.engine.connectors.discover=async c=>({...c,tools:[fixtureTool()]});await synthetic(f);const context=await f.context();await scanned(f,context,"metadata-baseline");const cap=f.registry.search().items[0],definition=f.registry.get({capabilityId:cap.id,includeSchemas:true}),imported=await f.registry.import(request(cap,"metadata-binding"));
  const authoring=new AuthoringService(f.registry.engine),testing=new WorkflowTesting(authoring);t.after(()=>testing.close());authoring.create({workflowId:"metadata-stable",name:"元数据刷新基线",environment:"test",mode:"auto",template:"blank",idempotencyKey:"metadata-create"});
  const draft=authoring.patch({workflowId:"metadata-stable",expectedRevision:1,idempotencyKey:"metadata-patch",operations:[{op:"set_binding",key:"read",bindingId:imported.bindingId},{op:"add_node",nodeId:"read",nodeType:"mcp_tool",title:"合成读取",capabilityRef:{capabilityId:cap.id,revision:cap.revision},config:{bindingKey:"read",argumentsMappings:{}}},{op:"disconnect",source:"input",target:"end",port:"next"},{op:"connect",source:"input",target:"read",port:"next"},{op:"connect",source:"read",target:"end",port:"next"}]});
  const suite=testing.generate({workflowId:draft.workflowId,expectedRevision:draft.revision,strategy:"agent_proposed",idempotencyKey:"metadata-suite",proposedCases:[{id:"normal",name:"metadata baseline",inputs:{},mockResults:[{nodeId:"read",capabilityId:cap.id,responseMode:"structured",result:{content:[],structuredContent:{result:"合成原值"}}}],agentSubmissions:[],assertions:[{kind:"terminal_state",expected:"SUCCEEDED"}],expectedValidationErrors:[]}]});
  await scanned(f,context,"metadata-observe","metadata");const after=f.registry.search().items[0],source=f.repo.get("capability_sources",after.sourceRefs[0].sourceId);assert.deepEqual(f.registry.get({capabilityId:cap.id,includeSchemas:true}),definition);assert.equal(after.revision,cap.revision);assert.equal(after.availability,"ready");assert.equal(after.sourceRefs[0].revision,source.revision);assert.equal(source.lastObservation.depth,"metadata");assert.equal(source.lastObservation.connectionChecked,false);assert.ok(!authoring.get(draft.workflowId).issues.some((issue:any)=>issue.code==="CAPABILITY_STALE"));
  const accepted=testing.run({suiteId:suite.suiteId,expectedSuiteRevision:suite.suiteRevision,mode:"mock",idempotencyKey:"metadata-run"});await testing.idle();assert.equal(testing.status(accepted.testRunId).stale,false);
  await scanned(f,context,"metadata-same-catalog");assert.equal(f.registry.search().items[0].revision,cap.revision);assert.equal(testing.status(accepted.testRunId).stale,false);
  await synthetic(f,{enabled:false});await scanned(f,context,"metadata-disabled","metadata");assert.equal(f.registry.search().items[0].enabled,"disabled");assert.equal(testing.status(accepted.testRunId).stale,true);
});

test("explicit null and config_only never run PATH Codex or App Server and remain persisted",async t=>{
  const f=await setup(t),bin=join(f.root,"bin"),marker=join(f.root,"codex-invoked");await mkdir(bin);await writeFile(join(f.home,"config.toml"),"");const cli=join(bin,process.platform==="win32"?"codex.exe":"codex"),script=join(bin,"codex-fixture.mjs");await writeFile(script,`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},process.argv.slice(2).join(' ')+'\\n');console.log('codex-cli fixture-config-only');`);await writeFile(cli,"Synthetic executable locator marker; executed only through the code-injected Node runner.");f.registry.options.hostRuntime={command:(_context,args)=>({executable:process.execPath,args:[script,...args]})};
  const oldPath=process.env.PATH;process.env.PATH=bin;
  try {
    for(const args of [{codexPath:null,useAppServer:true},{discoveryMode:"config_only",codexPath:cli,useAppServer:true}]) {
      const context=await f.registry.context({codexHome:f.home,cwd:f.cwd,...args});assert.equal(context.codexPath,null);assert.equal(context.codexVersion,null);assert.equal(context.discoveryMode,"config_only");assert.equal(context.useAppServer,false);await scanHost(context,"catalog");assert.deepEqual(f.repo.get("host_contexts",context.id).discoveryMode,"config_only");
    }
    await assert.rejects(readFile(marker),{code:"ENOENT"});
    const manual=await f.registry.context({codexHome:f.home,cwd:f.cwd,codexPath:cli,discoveryMode:"auto"});assert.equal(manual.codexPath,cli);assert.match(await readFile(marker,"utf8"),/--version/);await assert.rejects(f.registry.context({codexHome:f.home,cwd:f.cwd,codexPath:"relative-codex"}),{code:"INPUT_INVALID"});
  }finally{if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;}
});

test("launcher adapters support Python, Node, uvx and npx while unknown options are unsupported and secrets stay rejected",async t=>{
  const f=await setup(t),{sourcePolicy}=await import("../../packages/host-discovery/src/index.js");
  const launchers=[{command:"/synthetic/python3",args:["-u","-m","synthetic_mcp","--stdio"]},{command:"/synthetic/python3.12",args:["-m","synthetic_mcp"]},{command:"/synthetic/node",args:["--enable-source-maps","/synthetic/server.mjs","--stdio"]},{command:"/synthetic/uvx",args:["--from","synthetic-mcp","synthetic-server","--stdio"]},{command:"/synthetic/npx",args:["--yes","--package=synthetic-mcp","synthetic-server","--stdio"]}];
  for(const config of launchers){const policy=sourcePolicy(config);assert.equal(policy.credentialArgs,false,JSON.stringify(config));assert.equal(policy.unsupportedArgs,false);assert.equal(policy.unsupported,false);assert.equal(policy.requiresCredentials,false);}
  await writeFile(join(f.home,"config.toml"),"");await writeFile(join(f.home,"cli.json"),JSON.stringify(launchers.map((transport,index)=>({name:"launcher-"+index,enabled:true,transport:{type:"stdio",...transport}}))));let calls=0;f.registry.engine.connectors.discover=async c=>{calls++;return {...c,tools:[fixtureTool()]};};const context=await f.context(),scan=await scanned(f,context,"supported-launchers");assert.equal(calls,launchers.length);assert.ok(scan.sources.every((source:any)=>source.availability==="ready"));for(const cap of f.registry.search().items)assert.ok((await f.registry.import(request(cap,"launcher-import-"+cap.id))).bindingId);
  const unknown={command:"/synthetic/python3",args:["--opaque-option","SYNTHETIC_OPAQUE_VALUE"]},policy=sourcePolicy(unknown);assert.equal(policy.credentialArgs,false);assert.equal(policy.requiresCredentials,false);assert.equal(policy.unsupportedArgs,true);assert.equal(policy.unsupported,true);
  await synthetic(f,{name:"unknown-launcher",transport:{type:"stdio",...unknown}});const observed=await scanned(f,context,"unsupported-launcher");const source=observed.sources.find((item:any)=>item.name==="unknown-launcher");assert.equal(source.availability,"unsupported");assert.equal(source.unsupportedReason,"LAUNCHER_ARGUMENTS_UNSUPPORTED");await assert.rejects(f.registry.configureSource({sourceId:source.id,expectedRevision:source.revision,idempotencyKey:"unsupported-config"}),{code:"SOURCE_CONFIGURATION_UNSUPPORTED"});assert.ok(!JSON.stringify(f.repo.all("connections")).includes("SYNTHETIC_OPAQUE_VALUE"));
  for(const args of [["--client-secret=DO_NOT_COPY"],["--client_secret","DO_NOT_COPY"],["-H","Authorization: Bearer DO_NOT_COPY"],["--from=https://user:DO_NOT_COPY@example.invalid/package"]]) {const blocked=sourcePolicy({command:"/synthetic/uvx",args});assert.equal(blocked.credentialArgs,true);assert.equal(blocked.requiresCredentials,true);}
});

test("Skill and host component capabilities have persisted current source refs after metadata refresh",async t=>{
  const f=await setup(t);await writeFile(join(f.home,"config.toml"),"");await mkdir(join(f.home,"skills/report"),{recursive:true});await writeFile(join(f.home,"skills/report/SKILL.md"),"---\nname: report\n---\nsynthetic");const context=await f.context();await scanned(f,context,"component-source","metadata");const cap=f.registry.search().items[0];assert.equal(cap.kind,"skill");const source=f.repo.get("capability_sources",cap.sourceRefs[0].sourceId);assert.ok(source);assert.equal(source.revision,cap.sourceRefs[0].revision);await scanned(f,context,"component-source-again","metadata");const refreshed=f.registry.search().items[0];assert.equal(refreshed.revision,cap.revision);assert.equal(f.repo.get("capability_sources",refreshed.sourceRefs[0].sourceId).revision,refreshed.sourceRefs[0].revision);
});
