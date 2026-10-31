import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Repository} from '../../packages/persistence/src/repository.js';
import {openStore} from '../../packages/persistence/src/index.js';
import {validateMigrations} from '../../packages/persistence/src/migrations.js';
import {inspectBackup} from '../../packages/persistence/src/maintenance.js';
import {previewRetention,commitRetention} from '../../packages/persistence/src/retention.js';
import {Vault} from '../../packages/security/src/index.js';
import {startDaemon} from '../../apps/daemon/src/index.js';
import {hash} from '../../packages/contracts/src/domain.js';

for(const [name,ddl] of [
  ['FTS replaced by ordinary table','DROP TABLE knowledge_fts; CREATE TABLE knowledge_fts(chunk_id,tokens)'],
  ['managed table constraints changed','DROP TABLE host_contexts; CREATE TABLE host_contexts(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)))'],
] as const)test('audit: migration and backup reject '+name+' before boot writes',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'flowhub-audit-schema-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,'flowhub.sqlite'),store=openStore(path);new Repository(store.db);store.db.exec(ddl);
  assert.throws(()=>validateMigrations(store.db),{code:'MIGRATION_MISMATCH'});store.close();
  const before=await readFile(path);assert.equal(inspectBackup(path).compatible,false);
  await assert.rejects(startDaemon({dataDir:directory,port:0}),{code:'MIGRATION_MISMATCH'});assert.deepEqual(await readFile(path),before);
});

test('audit: Vault rotation preserves v2 continuation and legacy encrypted tool receipts without changing business values',()=>{
  const db=new Database(':memory:'),repo=new Repository(db),vault=new Vault(repo);try{
    vault.initialize('Synthetic-old-vault-password-124');const secret=vault.addSecret('fixture','SYNTHETIC_CONNECTION_SECRET');
    const continuation='[{"type":"reasoning","id":"opaque-synthetic-item"}]',credential='SYNTHETIC_CHECKPOINT_CREDENTIAL';
    repo.put('assistant_tasks','task',{id:'task',status:'INTERRUPTED',providerContinuation:vault.encrypt(continuation,'task:provider')});
    repo.put('assistant_tool_calls','task:call',{id:'task:call',taskId:'task',result:{checkpoint:{tokenDelivery:vault.encrypt(credential,'task:call')},business:{token:'business original',password:'business original',nested:{ciphertext:'inert'}}}});
    const business=repo.get('assistant_tool_calls','task:call').result.business;
    vault.changePassword('Synthetic-old-vault-password-124','Synthetic-new-vault-password-124');vault.lock();vault.unlock('Synthetic-new-vault-password-124');
    assert.equal(vault.secret(secret.id),'SYNTHETIC_CONNECTION_SECRET');assert.equal(vault.decrypt(repo.get('assistant_tasks','task').providerContinuation,'task:provider'),continuation);
    assert.equal(vault.decrypt(repo.get('assistant_tool_calls','task:call').result.checkpoint.tokenDelivery,'task:call'),credential);assert.deepEqual(repo.get('assistant_tool_calls','task:call').result.business,business);
  }finally{db.close();}
});

test('audit: corrupt v2 ciphertext aborts Vault rotation without partially changing keys or records',()=>{
  const db=new Database(':memory:'),repo=new Repository(db),vault=new Vault(repo);try{
    vault.initialize('Synthetic-old-vault-password-124');const secret=vault.addSecret('fixture','SYNTHETIC_CONNECTION_SECRET'),sealed=vault.encrypt('opaque','task:provider');sealed.tag='00'.repeat(16);
    repo.put('assistant_tasks','task',{id:'task',status:'INTERRUPTED',providerContinuation:sealed});const before=hash(repo.all('secrets'));
    assert.throws(()=>vault.changePassword('Synthetic-old-vault-password-124','Synthetic-new-vault-password-124'));
    vault.unlock('Synthetic-old-vault-password-124');assert.equal(vault.secret(secret.id),'SYNTHETIC_CONNECTION_SECRET');assert.equal(hash(repo.all('secrets')),before);
  }finally{db.close();}
});

function retentionFixture(){
  const db=new Database(':memory:'),repo=new Repository(db),at=Date.now(),old=new Date(at-8*86400000).toISOString(),activeDate=new Date(at-40*86400000).toISOString(),marker='SYNTHETIC_EXPIRED_AUDIT_BUSINESS';
  repo.put('runs','expired',{id:'expired',state:'SUCCEEDED',revision:1,updatedAt:old,outputs:{analysis:marker}});
  repo.put('assistant_sessions','session',{id:'session',owner:'execution',createdAt:old});
  repo.put('assistant_tasks','done',{id:'done',sessionId:'session',status:'COMPLETED',context:{runId:'expired'},createdAt:old,updatedAt:old,text:marker,answer:marker});
  repo.put('assistant_messages','message',{id:'message',sessionId:'session',taskId:'done',role:'assistant',createdAt:old,text:marker});
  repo.put('assistant_tool_calls','done:one',{id:'done:one',taskId:'done',sessionId:'session',name:'workflow_status',createdAt:old,result:{runId:'expired',outputs:{analysis:marker}}});
  repo.changed('tool.completed',{taskId:'done',timestamp:old,data:{result:{runId:'expired',outputs:{analysis:marker}}}});
  repo.put('workflow_test_suites','suite',{id:'suite',workflowId:'saved',draftRevision:1,suiteRevision:1,owner:'admin',createdAt:old,cases:[{inputs:{text:'KEEP_SAVED_FIXTURE'},mockResults:[{result:{text:'KEEP_SAVED_FIXTURE'}}]}]});
  repo.put('workflow_test_runs','test-run',{id:'test-run',suiteId:'suite',status:'SUCCEEDED',createdAt:old,completedAt:old,cases:[{outputs:{value:marker},trace:[{arguments:{value:marker}}]}]});
  repo.put('assistant_tasks','active',{id:'active',sessionId:'active-session',status:'GENERATING',createdAt:activeDate,updatedAt:activeDate,text:'KEEP_ACTIVE_BUSINESS',context:{}});
  repo.put('assistant_messages','active-message',{id:'active-message',sessionId:'active-session',role:'user',createdAt:activeDate,text:'KEEP_ACTIVE_BUSINESS'});
  repo.put('assistant_sessions','active-session',{id:'active-session',createdAt:activeDate,owner:'execution'});
  repo.put('versions','published@1.0.0',{id:'published@1.0.0',snapshot:{workflow:{instructions:'KEEP_IMMUTABLE_VERSION'}}});
  repo.put('capability_revisions','cap@1',{id:'cap@1',capabilityId:'cap',capabilityRevision:1,tool:{description:'KEEP_PUBLISHED_CAPABILITY'}});
  return {db,repo,at,marker};
}
test('audit: explicit retention removes expired v2 business copies and preserves active tasks and immutable publications',()=>{
  const f=retentionFixture();try{
    const active=hash(f.repo.get('assistant_tasks','active')),publication=hash(f.repo.get('versions','published@1.0.0')),capability=hash(f.repo.get('capability_revisions','cap@1'));
    const preview=previewRetention(f.repo,f.at);commitRetention(f.repo,preview.hash,f.at);
    assert.deepEqual(f.repo.get('runs','expired').outputs,{});
    for(const table of ['assistant_tasks','assistant_messages','assistant_tool_calls','workflow_test_runs'] as const)assert.ok(!JSON.stringify(f.repo.all(table)).includes(f.marker),table+' retained an expired business copy');
    assert.ok(!JSON.stringify(f.repo.changes(0,1000)).includes(f.marker),'application_events retained an expired business copy');
    assert.equal(hash(f.repo.get('assistant_tasks','active')),active);assert.equal(f.repo.get('assistant_messages','active-message').text,'KEEP_ACTIVE_BUSINESS');
    assert.equal(hash(f.repo.get('versions','published@1.0.0')),publication);assert.equal(hash(f.repo.get('capability_revisions','cap@1')),capability);assert.ok(JSON.stringify(f.repo.get('workflow_test_suites','suite')).includes('KEEP_SAVED_FIXTURE'));
  }finally{f.db.close();}
});
test('audit: retention preview detects changed v2 payloads before deleting anything',()=>{
  const f=retentionFixture();try{
    const preview=previewRetention(f.repo,f.at),call=f.repo.get('assistant_tool_calls','done:one');call.result.outputs.analysis='CHANGED_AFTER_PREVIEW';f.repo.put('assistant_tool_calls',call.id,call);
    assert.throws(()=>commitRetention(f.repo,preview.hash,f.at),{code:'REVISION_CONFLICT'});assert.ok(f.repo.get('runs','expired').outputs.analysis);
  }finally{f.db.close();}
});
