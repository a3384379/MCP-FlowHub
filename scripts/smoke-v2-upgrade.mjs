import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,realpath,symlink,rm,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import Database from 'better-sqlite3';
import {startDaemon} from '../dist/apps/daemon/src/index.js';
import {readEndpoint} from '../dist/apps/daemon/src/local-config.js';
import {createClient,localHttpTransport} from '../dist/packages/mcp-connectors/src/index.js';
import {inspectBackup,restoreBackup} from '../dist/packages/persistence/src/maintenance.js';
import {validateMigrations,MIGRATIONS} from '../dist/packages/persistence/src/migrations.js';
const exec=promisify(execFile),baseline='45eed03ee9f6f513a5c67e854d3d42e16afee636',root=await realpath(await mkdtemp(join(tmpdir(),'flowhub-real-v1-upgrade-'))),source=join(root,'old-program'),dataDir=join(root,'isolated-data');
let old,daemon;const clients=[],stages=[];
const pause=()=>new Promise(r=>setTimeout(r,25));
async function stopOld(){if(!old)return;const child=old;old=undefined;if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),new Promise((_,reject)=>setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Old daemon shutdown timed out'));},8000).unref())]);}}
async function startOld(){
  const entry=join(source,'dist/apps/daemon/src/cli.js');let stderr='';
  old=spawn(process.execPath,[entry,'serve','--data-dir',dataDir,'--port','0'],{cwd:source,env:{...process.env,FLOWHUB_DATA_DIR:dataDir},stdio:['ignore','ignore','pipe']});old.stderr.on('data',part=>stderr=(stderr+part).slice(-8192));
  const deadline=Date.now()+12000;while(Date.now()<deadline){assert.equal(old.exitCode,null,stderr);try{const e=await readEndpoint(dataDir);if((await fetch(new URL(e.url).origin+'/api/v1/health')).ok)return e;}catch{}await pause();}throw new Error('Old daemon startup timed out: '+stderr);
}
async function clientFor(endpoint){const c=createClient('modern');clients.push(c);await c.connect(localHttpTransport(new URL(endpoint.url),endpoint.token));return c;}
async function call(c,name,args){const result=await c.callTool({name,arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result.structuredContent));return result.structuredContent;}
function rows(db){return Object.fromEntries(['workflows','versions','runs','artifacts','clients'].map(table=>[table,db.prepare('SELECT id,revision,body FROM '+table+' ORDER BY id').all()]));}
try{
  await mkdir(source);const archive=join(root,'v1-source.tar');await exec('git',['archive','--format=tar','-o',archive,baseline],{cwd:resolve('.')});await exec('tar',['-xf',archive,'-C',source]);
  await symlink(resolve('node_modules'),join(source,'node_modules'),process.platform==='win32'?'junction':'dir');
  await exec(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'-p',join(source,'tsconfig.json')],{cwd:source,timeout:60000,maxBuffer:4*1024*1024});
  const endpoint=await startOld(),oldClient=await clientFor(endpoint);assert.equal((await oldClient.listTools()).tools.length,7);
  const base=new URL(endpoint.url).origin,password='Synthetic-v1-rollback-password';
  const auth=await fetch(base+'/api/v1/auth/bootstrap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password,setupToken:await readFile(join(dataDir,'admin-setup-token'),'utf8')})});assert.equal(auth.status,200);const cookie=auth.headers.get('set-cookie').split(';')[0],csrf=(await auth.json()).data.csrf;
  const api=async(path,body)=>{const response=await fetch(base+'/api/v1'+path,{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200,await response.clone().text());return(await response.json()).data;};
  const workflow=JSON.parse(await readFile(join(source,'examples/incident-production.json'),'utf8'));
  Object.assign(workflow,{workflowId:'v1-user-flow',name:'User original token business@example.invalid',description:'Preserve user edits',environment:'test',mode:'auto',inputSchema:{type:'object',properties:{},additionalProperties:false},bindings:{},nodes:[{id:'input',type:'input',title:'input',config:{}},{id:'report',type:'report_template',title:'report',config:{templateRef:'incident-markdown/v1',inputMappings:{},outputSchema:{type:'object',properties:{reportMarkdown:{type:'string'},evidenceRefs:{type:'array',items:{type:'string'}}},required:['reportMarkdown','evidenceRefs'],additionalProperties:false}}},{id:'end',type:'end',title:'end',config:{resultRef:{ref:{source:'node',nodeId:'report',pointer:''}}}}],edges:[{source:'input',target:'report',port:'next'},{source:'report',target:'end',port:'next'}]});
  const draft=await api('/workflows',{workflow,layout:{input:{x:11,y:22}}});await api('/workflows/v1-user-flow/publish',{expectedRevision:draft.revision,expectedBindingRevisions:{}});
  await api('/clients',{label:'Retained v1 client',workflowAllowlist:['v1-user-flow']});
  const run=await call(oldClient,'workflow_start',{workflowId:'v1-user-flow',version:'1.0.0',mode:'auto',inputs:{},idempotencyKey:'old-run'});
  let status;for(let i=0;i<200;i++){status=await call(oldClient,'workflow_status',{runId:run.runId});if(status.state==='SUCCEEDED')break;await pause();}assert.equal(status.state,'SUCCEEDED');
  const report=status.artifacts.find(a=>a.mimeType==='text/markdown');assert.ok(report);const oldReport=await call(oldClient,'artifact_read',{runId:run.runId,artifactId:report.id,offset:0,maxBytes:262144});
  const backup=await api('/backups',{});assert.equal(inspectBackup(backup.path).compatible,true);await oldClient.close();await stopOld();
  let db=new Database(join(dataDir,'flowhub.sqlite'),{readonly:true});assert.equal(validateMigrations(db,false,[MIGRATIONS[0]]),1);const original=rows(db),oldHash=JSON.parse(original.versions.find(v=>v.id==='v1-user-flow@1.0.0').body).contentHash;db.close();stages.push({stage:'actual_v1_program_create_publish_run_report_backup',status:'PASS',baseline,oldSnapshotHash:oldHash});
  daemon=await startDaemon({dataDir,port:0});assert.equal(validateMigrations(daemon.engine.repo.db),MIGRATIONS.length);assert.deepEqual(rows(daemon.engine.repo.db),original);
  const backups=await readdir(join(dataDir,'backups'));assert.ok(backups.some(name=>name.startsWith('pre-v2-')));assert.ok(daemon.engine.repo.db.prepare('SELECT count(*) AS n FROM knowledge_chunks').get().n>0);
  const upgraded=await clientFor(await readEndpoint(dataDir));assert.equal((await upgraded.listTools()).tools.length,21);const sameReport=await call(upgraded,'artifact_read',{runId:run.runId,artifactId:report.id,offset:0,maxBytes:262144});assert.equal(sameReport.content,oldReport.content);
  await call(upgraded,'workflow_draft_create',{workflowId:'v2-only',name:'v2 persisted draft',environment:'test',mode:'auto',template:'blank',idempotencyKey:'v2-create'});
  const modernBackup=join(root,'v2-backup.sqlite');await daemon.engine.repo.backup(modernBackup);assert.equal(inspectBackup(modernBackup).compatible,true);const damaged=join(root,'damaged-v2.sqlite');await copyFile(modernBackup,damaged);db=new Database(damaged);db.exec('DROP TABLE assistant_tasks');db.close();assert.equal(inspectBackup(damaged).compatible,false);
  await assert.rejects(restoreBackup(dataDir,backup.path));await upgraded.close();await daemon.close();daemon=undefined;stages.push({stage:'upgrade_to_v2_preserves_every_v1_row_and_report',status:'PASS',automaticPreMigrationBackup:true,v2BackupPreflight:true,corruptNewTableRejected:true,liveRestoreDenied:true});
  const restored=await restoreBackup(dataDir,backup.path);assert.equal(restored.restored,true);db=new Database(join(dataDir,'flowhub.sqlite'),{readonly:true});assert.equal(validateMigrations(db,false,[MIGRATIONS[0]]),1);assert.deepEqual(rows(db),original);db.close();
  const restarted=await startOld(),legacy=await clientFor(restarted);assert.equal((await legacy.listTools()).tools.length,7);const recovered=await call(legacy,'artifact_read',{runId:run.runId,artifactId:report.id,offset:0,maxBytes:262144});assert.equal(recovered.content,oldReport.content);await legacy.close();await stopOld();stages.push({stage:'stopped_restore_and_actual_old_program_restart',status:'PASS',v1RowsEqual:true,publishedHashUnchanged:true,reportBytesUnchanged:true});
  console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.versions.node,stages,formalUserDataAccessed:false,externalBusinessCalls:0,nativeWindowsAcceptance:process.platform==='win32'?'THIS_DRILL_ONLY':'UNVERIFIED'},null,2));
}finally{await Promise.allSettled(clients.map(c=>c.close()));await daemon?.close();await stopOld();await rm(root,{recursive:true,force:true});}
