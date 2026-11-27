import {test} from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {createServer} from "node:http";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Repository} from "../../packages/persistence/src/repository.js";
import {openStore} from "../../packages/persistence/src/index.js";
import {MIGRATIONS,migrate,validateMigrations} from "../../packages/persistence/src/migrations.js";
import {inspectBackup,restoreBackup} from "../../packages/persistence/src/maintenance.js";
import {previewRetention,commitRetention} from "../../packages/persistence/src/retention.js";
import {Vault} from "../../packages/security/src/index.js";
import {Application} from "../../packages/application/src/index.js";
import {ScriptedModelProvider} from "../../packages/llm-providers/src/index.js";
import {startDaemon} from "../../apps/daemon/src/index.js";
import {HubError,hash} from "../../packages/contracts/src/domain.js";

test("frozen v1 layout stays compatible and changed FTS module or required shadow/index is rejected",()=>{
  const db=new Database(":memory:");
  try {
    migrate(db,MIGRATIONS.slice(0,1));
    const history=db.prepare("SELECT * FROM schema_migrations").all();
    assert.equal(validateMigrations(db),1);assert.deepEqual(db.prepare("SELECT * FROM schema_migrations").all(),history);
    migrate(db);assert.equal(validateMigrations(db),MIGRATIONS.length);assert.deepEqual(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),MIGRATIONS.map(({version})=>({version})));
  }finally{db.close();}
  for(const ddl of [
    "DROP TABLE knowledge_fts; CREATE VIRTUAL TABLE knowledge_fts USING fts5(chunk_id UNINDEXED,tokens,tokenize='porter')",
    "DROP TABLE knowledge_fts_data",
    "DROP INDEX assistant_call_identity",
  ]) {
    const input=new Database(":memory:");try{
      new Repository(input);
      // Native SQLite defensive mode correctly protects shadow tables during
      // ordinary use. Disable it only to manufacture this isolated corruption.
      input.unsafeMode(true);input.exec(ddl);input.unsafeMode(false);
      assert.throws(()=>validateMigrations(input),{code:"MIGRATION_MISMATCH"});
    }finally{input.close();}
  }
});

test("backup creation and offline restore both reject modified schema before changing the target",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"flowhub-v2-schema-lifecycle-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const source=join(directory,"source.sqlite"),store=openStore(source),repo=new Repository(store.db);
  store.db.exec("DROP TABLE knowledge_fts; CREATE TABLE knowledge_fts(chunk_id,tokens)");
  await assert.rejects(repo.backup(join(directory,"must-not-exist.sqlite")),{code:"MIGRATION_MISMATCH"});store.close();
  assert.equal(inspectBackup(source).compatible,false);
  const targetDir=join(directory,"target"),daemon=await startDaemon({dataDir:targetDir,port:0});await daemon.close();
  const target=join(targetDir,"flowhub.sqlite"),before=await readFile(target);
  await assert.rejects(restoreBackup(targetDir,source),{code:"BACKUP_INCOMPATIBLE"});assert.deepEqual(await readFile(target),before);
});

test("a write failure rolls the entire Vault rotation back, including v1 and historical v2 envelopes",()=>{
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo),oldPassword="Synthetic-old-vault-password-124";
  try {
    vault.initialize(oldPassword);const secret=vault.addSecret("fixture","SYNTHETIC_ROTATION_VALUE");
    repo.put("assistant_tasks","task",{id:"task",status:"INTERRUPTED",providerContinuation:vault.encrypt("continuation","task:provider")});
    repo.put("assistant_tool_calls","task:call",{id:"task:call",taskId:"task",result:{checkpoint:{tokenDelivery:vault.encrypt("credential","task:call")}}});
    const before=hash([repo.all("settings"),repo.all("secrets"),repo.all("assistant_tasks"),repo.all("assistant_tool_calls")]);
    const put=repo.put.bind(repo);repo.put=(...args:Parameters<Repository["put"]>)=>{if(args[0]==="assistant_tool_calls")throw new Error("synthetic-write-failure");return put(...args);};
    assert.throws(()=>vault.changePassword(oldPassword,"Synthetic-new-vault-password-124"),/synthetic-write-failure/);repo.put=put;
    assert.equal(hash([repo.all("settings"),repo.all("secrets"),repo.all("assistant_tasks"),repo.all("assistant_tool_calls")]),before);
    assert.equal(vault.secret(secret.id),"SYNTHETIC_ROTATION_VALUE");vault.lock();vault.unlock(oldPassword);
    assert.equal(vault.decrypt(repo.get("assistant_tasks","task").providerContinuation,"task:provider"),"continuation");
    assert.equal(vault.decrypt(repo.get("assistant_tool_calls","task:call").result.checkpoint.tokenDelivery,"task:call"),"credential");
  }finally{db.close();}
});

test("v2 cleanup expires payloads at seven days, deletes metadata at thirty, and preserves tombstones/configuration/active sessions",()=>{
  const db=new Database(":memory:"),repo=new Repository(db),at=Date.now(),ago=(days:number)=>new Date(at-days*86400000).toISOString();
  try {
    for(const [key,age] of [["expire",8],["delete",31],["recent",1],["active",40]] as const) {
      repo.put("assistant_sessions",key,{id:key,owner:"execution",createdAt:ago(age)});
      repo.put("assistant_tasks",key,{id:key,sessionId:key,owner:"execution",status:key==="active"?"CALLING_TOOL":"COMPLETED",createdAt:ago(age),text:"BUSINESS_"+key});
      repo.put("assistant_messages",key,{id:key,sessionId:key,role:"user",createdAt:ago(age),text:"BUSINESS_"+key});
      repo.put("assistant_tool_calls",key,{id:key,taskId:key,createdAt:ago(age),result:{text:"BUSINESS_"+key}});
      repo.put("workflow_test_runs",key,{id:key,suiteId:"suite",status:key==="active"?"RUNNING":"SUCCEEDED",createdAt:ago(age),acceptedSuite:{inputs:"BUSINESS_"+key},executionSnapshot:{draft:{description:"BUSINESS_"+key}},cases:[{assertions:[{actual:"BUSINESS_"+key}]}]});
      repo.changed("tool.completed",{taskId:key,timestamp:ago(age),data:{result:"BUSINESS_"+key}});
    }
    repo.put("assistant_tasks","completed-in-active-session",{id:"completed-in-active-session",sessionId:"active",status:"COMPLETED",createdAt:ago(40),text:"KEEP_ACTIVE_HISTORY"});
    repo.put("workflow_test_suites","suite",{id:"suite",createdAt:ago(40),cases:[{inputs:{text:"KEEP_SAVED_CONFIGURATION"}}]});
    repo.put("capability_revisions","cap@1",{id:"cap@1",tool:{description:"KEEP_CAPABILITY"}});
    repo.put("versions","version",{id:"version",snapshot:{text:"KEEP_IMMUTABLE"}});
    repo.command("execution","assistant.message","expired-key",{},()=>({taskId:"delete",status:"GENERATING"}));
    const configuration=hash([repo.all("workflow_test_suites"),repo.all("capability_revisions"),repo.all("versions")]);
    const preview=previewRetention(repo,at);assert.deepEqual(preview.assistantTasks,["delete"]);assert.ok(preview.assistantResultTasks.includes("expire"));
    commitRetention(repo,preview.hash,at);
    for(const table of ["assistant_tasks","assistant_messages","assistant_tool_calls","workflow_test_runs"] as const) {
      assert.equal(repo.get(table,"delete"),undefined);assert.ok(repo.get(table,"expire").resultsExpiredAt);
      assert.ok(!JSON.stringify(repo.all(table)).includes("BUSINESS_expire"));assert.ok(JSON.stringify(repo.get(table,"recent")).includes("BUSINESS_recent"));assert.ok(JSON.stringify(repo.get(table,"active")).includes("BUSINESS_active"));
    }
    assert.equal(repo.get("assistant_tasks","completed-in-active-session").text,"KEEP_ACTIVE_HISTORY");
    assert.equal(hash([repo.all("workflow_test_suites"),repo.all("capability_revisions"),repo.all("versions")]),configuration);
    assert.deepEqual(repo.command("execution","assistant.message","expired-key",{},()=>{throw new Error("must never replay");}),{taskId:"delete",status:"GENERATING"});
    assert.ok(!JSON.stringify(repo.changes(0,1000)).includes("BUSINESS_expire"));assert.ok(!JSON.stringify(repo.changes(0,1000)).includes("BUSINESS_delete"));
    assert.ok(JSON.stringify(repo.changes(0,1000)).includes("BUSINESS_active"));
  }finally{db.close();}
});

test("daemon shutdown rejects new requests, interrupts generation durably, and waits before closing SQLite",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"flowhub-v2-close-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  let providerStarted!:()=>void;const started=new Promise<void>(resolve=>providerStarted=resolve);
  const provider=new ScriptedModelProvider([(request:any)=>new Promise((_resolve,reject)=>{providerStarted();request.signal.addEventListener("abort",()=>reject(new HubError("TASK_CANCELLED","synthetic cancellation")),{once:true});})]);
  const daemon=await startDaemon({dataDir:directory,port:0,providerFactory:()=>provider});
  t.after(()=>daemon.close());
  const profile=daemon.application.assistant.saveProfile({name:"Synthetic",providerKind:"openai_responses",baseUrl:"https://example.invalid/v1",model:"synthetic"}),session=daemon.application.assistant.session();
  const task=daemon.application.assistant.submit(session.id,{text:"解释项目",mode:"help",context:{},requestedActions:[],modelProfileId:profile.id,idempotencyKey:"close-task"});await started;
  let entered!:()=>void,release!:()=>void;const during=new Promise<void>(resolve=>entered=resolve),barrier=new Promise<void>(resolve=>release=resolve);
  const close=daemon.application.close.bind(daemon.application);daemon.application.close=async()=>{assert.equal(daemon.engine.repo.db.open,true);entered();await barrier;await close();assert.equal(daemon.engine.repo.db.open,true);};
  const closing=daemon.close();await during;const duplicate=daemon.close();assert.equal(closing,duplicate);
  try {const response=await fetch(`http://127.0.0.1:${daemon.port}/api/v1/health`);assert.equal(response.status,503);}finally{release();await closing;}
  assert.equal(daemon.engine.repo.db.open,false);
  const db=new Database(join(directory,"flowhub.sqlite"),{readonly:true});try{const saved=JSON.parse((db.prepare("SELECT body FROM assistant_tasks WHERE id=?").get(task.taskId) as {body:string}).body);assert.equal(saved.status,"INTERRUPTED");}finally{db.close();}
});

test("startup listener failure closes Application workers before SQLite and releases the data-directory lock",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"flowhub-v2-start-failure-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const listener=createServer();await new Promise<void>(resolve=>listener.listen(0,"127.0.0.1",resolve));
  let closed=0;const original=Application.prototype.close;
  Application.prototype.close=async function(){assert.equal(this.engine.repo.db.open,true);closed++;await original.call(this);};
  try {await assert.rejects(startDaemon({dataDir:directory,port:(listener.address() as {port:number}).port}),/PORT_IN_USE/);assert.equal(closed,1);}
  finally{Application.prototype.close=original;await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));}
  const daemon=await startDaemon({dataDir:directory,port:0});await daemon.close();
});

test("shutdown hook failure still erases the Vault key and releases SQLite and its lock",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"flowhub-v2-close-failure-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const daemon=await startDaemon({dataDir:directory,port:0});
  daemon.engine.vault.addSecret("fixture","SYNTHETIC_CLOSE_SECRET");
  const original=daemon.application.close.bind(daemon.application);
  daemon.application.close=async()=>{await original();throw new Error("synthetic-close-failure");};
  await assert.rejects(daemon.close(),/synthetic-close-failure/);
  assert.equal(daemon.engine.repo.db.open,false);assert.equal(daemon.engine.vault.locked,true);
  await assert.rejects(fetch(`http://127.0.0.1:${daemon.port}/api/v1/health`));
  const restarted=await startDaemon({dataDir:directory,port:0});await restarted.close();
});
