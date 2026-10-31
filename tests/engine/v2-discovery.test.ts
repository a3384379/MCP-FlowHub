import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { scanHost, createContext } from "../../packages/host-discovery/src/index.js";
import { CapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";

async function setup(t:any) {
  const root=await realpath(await mkdtemp(join(tmpdir(),"flowhub discovery 合成 "))),home=join(root,"codex"),cwd=join(root,"project");
  await mkdir(home);await mkdir(cwd);t.after(()=>rm(root,{recursive:true,force:true}));
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo),engine=new Engine(repo,vault,new Connectors(repo,vault)),registry=new CapabilityRegistry(engine);
  t.after(async()=>{await registry.close();await engine.close();db.close();});
  const cli=join(root,"fake-codex");
  await writeFile(cli,`#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2);if(a.includes('--version'))console.log('codex-cli 0.164.0-alpha.11.1');else if(a.includes('--help'))console.log('--json');else console.log(fs.readFileSync(${JSON.stringify(join(home,"cli.json"))},'utf8'));`);
  await chmod(cli,0o700);await writeFile(join(home,"cli.json"),"[]");
  return {root,home,cwd,repo,registry,context:()=>registry.context({codexHome:home,cwd,codexPath:cli})};
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
  const c=await f.context(),accepted=f.registry.scan({contextId:c.id,depth:"catalog",idempotencyKey:"catalog"});await f.registry.close();
  const status=f.registry.status(accepted.scanId);assert.equal(status.status,"SUCCEEDED");
  const caps=f.registry.search({contextId:c.id}).items;assert.equal(caps.length,2);assert.notEqual(caps[0].id,caps[1].id);assert.ok(!("inputSchema" in caps[0]));
  f.registry.scan({contextId:c.id,depth:"catalog",idempotencyKey:"again"});await f.registry.close();
  assert.deepEqual(f.registry.search({contextId:c.id}).items.map(c=>c.revision),[1,1]);
  assert.equal(status.sources.find((s:any)=>s.name==="flowhub").self,true);
  const cap=caps[0];const imported=await f.registry.import({capabilityId:cap.id,expectedSourceRevision:1,target:"hub_direct",environment:"test",lockedArguments:{},idempotencyKey:"import"});
  const replay=await f.registry.import({capabilityId:cap.id,expectedSourceRevision:1,target:"hub_direct",environment:"test",lockedArguments:{},idempotencyKey:"import"});assert.deepEqual(replay,imported);
  assert.equal(f.repo.all("connections").length,1);assert.equal(f.repo.get("bindings",imported.bindingId).validationStatus,"UNVERIFIED");
  await writeFile(join(f.home,"cli.json"),"[]");
  f.registry.scan({contextId:c.id,depth:"metadata",idempotencyKey:"missing"});await f.registry.close();
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
  const c=await f.context(),job=f.registry.scan({contextId:c.id,depth:"metadata",idempotencyKey:"read"});await f.registry.close();
  const status=f.registry.status(job.scanId);assert.equal(status.status,"PARTIAL");
  assert.ok(!JSON.stringify(status).includes("DO_NOT_STORE_KEY"));assert.ok(!JSON.stringify(status).includes("SYNTHETIC_TOKEN"));
  assert.equal(status.sources[0].availability,"credentials_required");
  assert.equal(f.repo.all("connections").length,0);
});
