import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {writeFileSync} from 'node:fs';
const root=process.cwd(),require=createRequire(root+'/package.json'),Database=require('better-sqlite3');
const load=p=>import(pathToFileURL(root+'/dist/packages/'+p+'/src/index.js').href);
const {Repository}=await import(pathToFileURL(root+'/dist/packages/persistence/src/repository.js').href),{Vault}=await load('security'),{Connectors}=await import(pathToFileURL(root+'/dist/packages/mcp-connectors/src/registry.js').href),{Engine}=await import(pathToFileURL(root+'/dist/packages/workflow-core/src/engine.js').href),{AuthoringService}=await load('workflow-authoring');
const db=new Database(':memory:'),repo=new Repository(db),vault=new Vault(repo),engine=new Engine(repo,vault,new Connectors(repo,vault)),authoring=new AuthoringService(engine);
const create=workflowId=>authoring.create({workflowId,name:'Synthetic',environment:'test',mode:'auto',template:'blank',idempotencyKey:'create-'+workflowId});
const remove=workflowId=>{const w=repo.get('workflows',workflowId);return authoring.delete({workflowId,expectedRevision:w.revision,expectedLayoutRevision:w.layoutRevision,idempotencyKey:'delete-'+workflowId});};
try{
 create('warmup');remove('warmup');
 const payload='x'.repeat(131072),at=new Date().toISOString();
 repo.tx(()=>{for(let i=0;i<200;i++){
  repo.insert('runs','old-run-'+i,{id:'old-run-'+i,workflowId:'unrelated',state:'SUCCEEDED',inputs:{},outputs:{n:{text:payload}},createdAt:at,updatedAt:at});
  repo.insert('workflow_test_runs','old-test-'+i,{id:'old-test-'+i,workflowId:'unrelated',status:'SUCCEEDED',cases:[{outputs:{n:{text:payload}}}],createdAt:at});
  repo.insert('assistant_tool_calls','old-call-'+i,{id:'old-call-'+i,taskId:'old-task-'+i,arguments:{workflowId:'unrelated'},status:'COMPLETED',result:{payload},createdAt:at});
  repo.insert('assistant_tasks','old-task-'+i,{id:'old-task-'+i,status:'COMPLETED',context:{workflowId:'unrelated'},answer:payload.slice(0,16384),createdAt:at});
 }});
 const tables=['runs','workflow_test_runs','assistant_tool_calls','assistant_tasks'];
 const history=tables.map(table=>({table,...db.prepare('SELECT COUNT(*) AS rows,SUM(length(CAST(body AS BLOB))) AS bodyBytes FROM '+table).get()}));
 const original=repo.all.bind(repo),samples=[];let loaded=0;
 repo.all=(table)=>{const result=original(table);if(tables.includes(table))loaded+=result.length;return result;};
 for(let i=0;i<3;i++){
  create('target-'+i);global.gc();const before=process.memoryUsage();loaded=0;
  const start=performance.now();remove('target-'+i);const elapsedMs=performance.now()-start,after=process.memoryUsage();
  samples.push({elapsedMs,historyBodiesDecoded:loaded,heapGrowthMiB:(after.heapUsed-before.heapUsed)/1048576,rssGrowthMiB:(after.rss-before.rss)/1048576});
 }
 const result={phase:process.argv[2]??'before',node:process.versions.node,history,samples};
 writeFileSync('/tmp/flowhub-delete-backend-benchmark-'+result.phase+'.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await engine.close();db.close();}
