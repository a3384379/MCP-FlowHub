import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,realpath,symlink,rm,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {startDaemon} from '../dist/apps/daemon/src/index.js';
import {readEndpoint} from '../dist/apps/daemon/src/local-config.js';
import {createClient,localHttpTransport} from '../dist/packages/mcp-connectors/src/index.js';
import {inspectBackup,restoreBackup} from '../dist/packages/persistence/src/maintenance.js';
import {migrate,validateMigrations,MIGRATIONS} from '../dist/packages/persistence/src/migrations.js';
const exec=promisify(execFile),baseline='45eed03ee9f6f513a5c67e854d3d42e16afee636',root=await realpath(await mkdtemp(join(tmpdir(),'flowhub-real-v1-upgrade-'))),source=join(root,'old-program'),dataDir=join(root,'isolated-data');
let old,daemon;const clients=[],stages=[];
const pause=()=>new Promise(r=>setTimeout(r,25));
async function stopOld(){if(!old)return;const child=old;old=undefined;if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),new Promise((_,reject)=>setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Old daemon shutdown timed out'));},8000).unref())]);}}
async function startOld(directory=dataDir){
  const entry=join(source,'dist/apps/daemon/src/cli.js');let stderr='';
  old=spawn(process.execPath,[entry,'serve','--data-dir',directory,'--port','0'],{cwd:source,env:{...process.env,FLOWHUB_DATA_DIR:directory},stdio:['ignore','ignore','pipe']});old.stderr.on('data',part=>stderr=(stderr+part).slice(-8192));
  const deadline=Date.now()+12000;while(Date.now()<deadline){assert.equal(old.exitCode,null,stderr);try{const e=await readEndpoint(directory);if((await fetch(new URL(e.url).origin+'/api/v1/health')).ok)return e;}catch{}await pause();}throw new Error('Old daemon startup timed out: '+stderr);
}
async function clientFor(endpoint){const c=createClient('modern');clients.push(c);await c.connect(localHttpTransport(new URL(endpoint.url),endpoint.token));return c;}
async function call(c,name,args){const result=await c.callTool({name,arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result.structuredContent));return result.structuredContent;}
function rows(db){return Object.fromEntries(['workflows','versions','runs','artifacts','clients'].map(table=>[table,db.prepare('SELECT id,revision,body FROM '+table+' ORDER BY id').all()]));}
const sha256=value=>createHash('sha256').update(value).digest('hex');
async function databaseState(path){
  const bytes=await readFile(path),db=new Database(path,{readonly:true});
  try{
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'poc_meta' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const business=Object.fromEntries(tables.map(({name})=>[name,db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"').all().map(row=>JSON.stringify(row)).sort()]));
    return {fileSha256:sha256(bytes),businessSha256:sha256(JSON.stringify(business)),boots:Number(db.prepare("SELECT value FROM poc_meta WHERE key='boots'").get().value),history:db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()};
  }finally{db.close();}
}
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
  const failedMigrationDir=join(root,'failed-migration-copy');await mkdir(failedMigrationDir);const failedMigrationPath=join(failedMigrationDir,'flowhub.sqlite');await copyFile(backup.path,failedMigrationPath);
  const beforeFailure=await databaseState(failedMigrationPath);db=new Database(failedMigrationPath);
  try{const second=MIGRATIONS[1],failing=[MIGRATIONS[0],{...second,ddl:second.ddl+'; SELECT * FROM synthetic_missing_migration_table'}];assert.throws(()=>migrate(db,failing),/synthetic_missing_migration_table/);assert.equal(validateMigrations(db,false,[MIGRATIONS[0]]),1);assert.deepEqual(rows(db),original);assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='assistant_tasks'").get(),undefined);}finally{db.close();}
  assert.deepEqual(await databaseState(failedMigrationPath),beforeFailure);
  const recoveredFailure=await clientFor(await startOld(failedMigrationDir));assert.equal((await recoveredFailure.listTools()).tools.length,7);const failureReport=await call(recoveredFailure,'artifact_read',{runId:run.runId,artifactId:report.id,offset:0,maxBytes:262144});assert.equal(failureReport.content,oldReport.content);await recoveredFailure.close();await stopOld();
  stages.push({stage:'v2_migration_failure_actual_old_program_report_recovery',status:'PASS',injectedFailure:'after v2 DDL, before migration history commit',v1SchemaAndRowsUnchanged:true,fileSha256BeforeOldStartup:beforeFailure.fileSha256,reportBytesUnchanged:true});
  daemon=await startDaemon({dataDir,port:0});assert.equal(validateMigrations(daemon.engine.repo.db),MIGRATIONS.length);assert.deepEqual(rows(daemon.engine.repo.db),original);
  const backups=await readdir(join(dataDir,'backups'));assert.ok(backups.some(name=>name.startsWith('pre-v2-')));assert.ok(daemon.engine.repo.db.prepare('SELECT count(*) AS n FROM knowledge_chunks').get().n>0);
  const upgraded=await clientFor(await readEndpoint(dataDir));assert.equal((await upgraded.listTools()).tools.length,21);const sameReport=await call(upgraded,'artifact_read',{runId:run.runId,artifactId:report.id,offset:0,maxBytes:262144});assert.equal(sameReport.content,oldReport.content);
  await call(upgraded,'workflow_draft_create',{workflowId:'v2-only',name:'v2 persisted draft',environment:'test',mode:'auto',template:'blank',idempotencyKey:'v2-create'});
  const modernBackup=join(root,'v2-backup.sqlite');await daemon.engine.repo.backup(modernBackup);assert.equal(inspectBackup(modernBackup).compatible,true);const damaged=join(root,'damaged-v2.sqlite');await copyFile(modernBackup,damaged);db=new Database(damaged);db.exec('DROP TABLE assistant_tasks');db.close();assert.equal(inspectBackup(damaged).compatible,false);
  await assert.rejects(restoreBackup(dataDir,backup.path));await upgraded.close();await daemon.close();daemon=undefined;stages.push({stage:'upgrade_to_v2_preserves_every_v1_row_and_report',status:'PASS',automaticPreMigrationBackup:true,v2BackupPreflight:true,corruptNewTableRejected:true,liveRestoreDenied:true});
  // Inspect the real old Repository with a read-only handle. This verifies its
  // migration rejection, not the bootstrap behavior of the old serve command.
  const upgradedPath=join(dataDir,'flowhub.sqlite'),beforeOldInspection=await databaseState(upgradedPath);
  const oldRepositoryUrl=pathToFileURL(join(source,'dist/packages/persistence/src/repository.js')).href;
  const readonlyProbe=`import assert from 'node:assert/strict';import Database from 'better-sqlite3';import {Repository} from ${JSON.stringify(oldRepositoryUrl)};const db=new Database(process.argv[1],{readonly:true});try{assert.throws(()=>new Repository(db),{code:'MIGRATION_MISMATCH'});console.log('actual old Repository rejected current schema using readonly handle');}finally{db.close();}`;
  await exec(process.execPath,['--input-type=module','-e',readonlyProbe,upgradedPath],{cwd:source,timeout:10000});
  assert.deepEqual(await databaseState(upgradedPath),beforeOldInspection);
  stages.push({stage:'actual_old_repository_readonly_rejects_v2',status:'PASS',fileSha256:beforeOldInspection.fileSha256,businessSha256:beforeOldInspection.businessSha256,wholeFileUnchanged:true,scope:'Read-only old Repository validation only; does not claim old serve is write-free.'});
  // Deliberately mispoint the historical serve at a disposable copy. Its
  // openStore predates the validation-before-bootstrap protection in v2: it
  // increments poc_meta.boots before Repository rejects the newer history.
  // Keep this evidence separate from the correct rollback path below.
  const mistakenDir=join(root,'disposable-old-mispoint');await mkdir(mistakenDir);
  const mistakenPath=join(mistakenDir,'flowhub.sqlite');await copyFile(upgradedPath,mistakenPath);
  const beforeMistake=await databaseState(mistakenPath);let rejection;
  try{await exec(process.execPath,[join(source,'dist/apps/daemon/src/cli.js'),'serve','--data-dir',mistakenDir,'--port','0'],{cwd:source,timeout:10000,maxBuffer:1024*1024});assert.fail('Historical old serve unexpectedly accepted the newer schema.');}
  catch(error){assert.equal(error.code,1);assert.match(error.stderr,/^STARTUP_FAILED:/);rejection={exitCode:error.code,cliError:'STARTUP_FAILED',readonlyRepositoryError:'MIGRATION_MISMATCH'};}
  const afterMistake=await databaseState(mistakenPath);
  assert.equal(afterMistake.businessSha256,beforeMistake.businessSha256);assert.deepEqual(afterMistake.history,beforeMistake.history);
  assert.equal(afterMistake.boots,beforeMistake.boots+1);assert.notEqual(afterMistake.fileSha256,beforeMistake.fileSha256);
  assert.deepEqual(await databaseState(upgradedPath),beforeOldInspection);
  stages.push({stage:'historical_old_serve_mispoint_counterexample',status:'PARTIAL',...rejection,businessAndHistoryUnchanged:true,originalV2DatabaseUnchanged:true,before:beforeMistake,after:afterMistake,limitation:'The frozen historical serve increments boot metadata before rejecting v2. Always restore the version-matched v1 backup before launching the old program; readonly Repository rejection is not a startup write guard.'});
  const restored=await restoreBackup(dataDir,backup.path);assert.equal(restored.restored,true);db=new Database(join(dataDir,'flowhub.sqlite'),{readonly:true});assert.equal(validateMigrations(db,false,[MIGRATIONS[0]]),1);assert.deepEqual(rows(db),original);db.close();
  stages.push({stage:'restored_v1_history_verified_before_old_serve',status:'PASS',migrationVersions:[1],v1RowsEqual:true});
  const restarted=await startOld(),legacy=await clientFor(restarted);assert.equal((await legacy.listTools()).tools.length,7);const recovered=await call(legacy,'artifact_read',{runId:run.runId,artifactId:report.id,offset:0,maxBytes:262144});assert.equal(recovered.content,oldReport.content);
  const freshRun=await call(legacy,'workflow_start',{workflowId:'v1-user-flow',version:'1.0.0',mode:'auto',inputs:{},idempotencyKey:'post-rollback-new-run'});assert.notEqual(freshRun.runId,run.runId);
  let freshStatus;for(let i=0;i<200;i++){freshStatus=await call(legacy,'workflow_status',{runId:freshRun.runId});if(freshStatus.state==='SUCCEEDED')break;await pause();}assert.equal(freshStatus.state,'SUCCEEDED');
  const freshReport=freshStatus.artifacts.find(a=>a.mimeType==='text/markdown');assert.ok(freshReport);const freshContent=await call(legacy,'artifact_read',{runId:freshRun.runId,artifactId:freshReport.id,offset:0,maxBytes:262144});assert.ok(freshContent.content.includes('证据索引'));assert.ok(freshContent.content.includes(freshRun.runId));assert.equal(freshContent.sha256,sha256(freshContent.content));
  await legacy.close();await stopOld();stages.push({stage:'stopped_restore_and_actual_old_program_restart',status:'PASS',v1RowsEqual:true,publishedHashUnchanged:true,reportBytesUnchanged:true,newOldVersionRunId:freshRun.runId,newOldVersionRunState:freshStatus.state,newReportBytes:Buffer.byteLength(freshContent.content),newReportSha256:freshContent.sha256});
  console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.versions.node,stages,formalUserDataAccessed:false,externalBusinessCalls:0,nativeWindowsAcceptance:process.platform==='win32'?'THIS_DRILL_ONLY':'UNVERIFIED'},null,2));
}finally{await Promise.allSettled(clients.map(c=>c.close()));await daemon?.close();await stopOld();await rm(root,{recursive:true,force:true});}
