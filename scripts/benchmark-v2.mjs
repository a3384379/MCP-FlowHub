import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtemp,mkdir,writeFile,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {Repository} from '../dist/packages/persistence/src/repository.js';
import {Vault} from '../dist/packages/security/src/index.js';
import {Connectors} from '../dist/packages/mcp-connectors/src/registry.js';
import {Engine} from '../dist/packages/workflow-core/src/engine.js';
import {AuthoringService} from '../dist/packages/workflow-authoring/src/index.js';
import {createContext,scanHost} from '../dist/packages/host-discovery/src/index.js';
const root=await realpath(await mkdtemp(join(tmpdir(),'flowhub-v2-benchmark-'))),db=new Database(':memory:'),repo=new Repository(db),vault=new Vault(repo),engine=new Engine(repo,vault,new Connectors(repo,vault)),author=new AuthoringService(engine);
const p95=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
try{
  author.create({workflowId:'benchmark',name:'synthetic benchmark',environment:'test',mode:'auto',template:'blank',idempotencyKey:'create'});
  const workflow=structuredClone(author.get('benchmark').draft),ids=['input',...Array.from({length:98},(_,i)=>'condition-'+i),'end'];
  workflow.nodes=[workflow.nodes[0],...ids.slice(1,-1).map(id=>({id,type:'condition',title:id,config:{expression:{op:'eq',left:{value:1},right:{value:1}}}})),workflow.nodes[1]];
  workflow.edges=ids.slice(0,-1).flatMap((id,index)=>(index===0?['next']:['true','false']).map(port=>({source:id,target:ids[index+1],port})));author.saveRaw(workflow,1,{});
  const validation=[];for(let i=0;i<55;i++){const started=performance.now();const result=author.validate({workflowId:'benchmark',expectedRevision:2,level:'publish'});assert.equal(result.valid,true);if(i>=5)validation.push(performance.now()-started);}
  const home=join(root,'codex'),skills=join(home,'skills'),cli=join(root,'codex-fixture.mjs');await mkdir(skills,{recursive:true});await writeFile(join(home,'config.toml'),'');
  await writeFile(cli,'const args=process.argv.slice(2);console.log(args.includes("--version")?"codex-cli synthetic":args.includes("--help")?"--json":"[]");\n');
  for(let offset=0;offset<500;offset+=50)await Promise.all(Array.from({length:50},async(_,i)=>{const path=join(skills,'skill-'+(offset+i));await mkdir(path);await writeFile(join(path,'SKILL.md'),'---\nname: synthetic-'+(offset+i)+'\ndescription: synthetic local benchmark\n---\nInstruction only; no scripts executed.\n');}));
  const runtime={command:(context,args)=>({executable:process.execPath,args:[context.codexPath,...args]})};
  const context=await createContext({codexHome:home,cwd:root,codexPath:cli},runtime),metadata=[];assert.equal(context.codexVersion,'codex-cli synthetic','Benchmark CLI must really execute on this OS.');
  for(let i=0;i<10;i++){const started=performance.now(),result=await scanHost(context,'metadata',{}, {},runtime);assert.equal(result.resolutionQuality,'host_effective');assert.equal(result.components.filter(c=>c.kind==='skill').length,500);metadata.push(performance.now()-started);}
  const result={platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model,node:process.versions.node,measuredAt:new Date().toISOString(),businessCalls:0,validation:{nodes:100,samples:validation.length,warmups:5,p95Ms:p95(validation),targetMs:1000},metadata:{components:500,samples:metadata.length,p95Ms:p95(metadata),targetMs:5000,source:'temporary synthetic Codex CLI and Skill files'}};
  assert.ok(result.validation.p95Ms<=result.validation.targetMs);assert.ok(result.metadata.p95Ms<=result.metadata.targetMs);console.log(JSON.stringify(result,null,2));
}finally{await engine.close();db.close();await rm(root,{recursive:true,force:true});}
