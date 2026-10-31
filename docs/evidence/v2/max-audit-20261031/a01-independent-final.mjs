import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {writeFile,mkdir} from 'node:fs/promises';
const root=process.cwd(),require=createRequire(root+'/package.json'),Database=require('better-sqlite3');
const {Repository}=await import(root+'/dist/packages/persistence/src/repository.js');
const {Vault}=await import(root+'/dist/packages/security/src/index.js');
const {Connectors}=await import(root+'/dist/packages/mcp-connectors/src/registry.js');
const {Engine}=await import(root+'/dist/packages/workflow-core/src/engine.js');
const {Application}=await import(root+'/dist/packages/application/src/index.js');
const {ScriptedModelProvider}=await import(root+'/dist/packages/llm-providers/src/index.js');
const {requestedActions}=await import(root+'/dist/packages/contracts/src/assistant-intent.js');
const out=[];
async function fixture(script,work){const db=new Database(':memory:'),repo=new Repository(db),vault=new Vault(repo);vault.initialize('Synthetic-audit-password');const engine=new Engine(repo,vault,new Connectors(repo,vault)),provider=new ScriptedModelProvider(script),app=new Application(engine,{providerFactory:()=>provider});const profile=app.assistant.saveProfile({name:'审计合成模型',providerKind:'openai_compatible_chat',baseUrl:'https://example.invalid/v1',model:'synthetic'}),session=app.assistant.session();try{await work({repo,engine,provider,app,profile,session});}finally{await app.close();await engine.close();db.close();}}
const done={text:'合成审计完成',calls:[],usage:null};

const workflowId='audit-question';
const baseWorkflow=f=>{f.app.authoring.create({workflowId,name:'A01独立复审合成流程',environment:'test',mode:'auto',template:'blank',idempotencyKey:'create'});f.app.authoring.publish({workflowId,expectedRevision:1,version:'1.0.0',expectedBindingRevisions:{},expectedCapabilityRevisions:{},idempotencyKey:'publish'});};
const start=()=>({text:'',calls:[{id:'proposed-start',name:'workflow_start',arguments:JSON.stringify({workflowId,version:'1.0.0',mode:'auto',inputs:{},idempotencyKey:'proposed-start'})}],usage:null});
async function probe(text,expectedActions,expectedRuns=0){
 await fixture([start(),done],async f=>{
  baseWorkflow(f);const actions=requestedActions(text),mode=actions.length?'compose':'help';
  let accepted,error;
  try{accepted=f.app.assistant.submit(f.session.id,{text,mode,requestedActions:actions,context:{workflowId},modelProfileId:f.profile.id,idempotencyKey:'request'});await f.app.assistant.settled();}catch(e){error={code:e.code,message:e.message};}
  const task=accepted?f.app.assistant.task(accepted.taskId):null;
  const row={text,expectedActions,inferredActions:actions,mode,offeredWorkflowStart:f.provider.requests[0]?.tools.some(t=>t.name==='workflow_start')??false,taskStatus:task?.status??null,errorCode:task?.errorCode??error?.code??null,actualRunsCreated:f.repo.all('runs').length,toolReceipts:task?.tools.map(t=>({name:t.name,isError:!!t.isError,status:t.status}))??[]};
  row.passed=JSON.stringify(actions)===JSON.stringify(expectedActions)&&row.actualRunsCreated===expectedRuns&&(expectedRuns?row.taskStatus==='COMPLETED'&&row.offeredWorkflowStart:row.taskStatus==='FAILED'&&row.errorCode==='INTENT_NOT_ALLOWED'&&!row.offeredWorkflowStart&&row.toolReceipts.length===0);
  out.push(row);
 });
}
for(const text of [
 '运行当前流程需要满足哪些条件','运行当前流程有何风险','运行当前流程需要多大权限','运行当前流程需要啥权限','运行当前流程需要管理员权限','他刚才说‘运行当前流程’',
 '请先不要运行当前流程，等我确认后再运行当前流程','先不要运行当前流程。等我确认。然后再运行当前流程','等权限开通，再运行当前流程','当我确认时，再运行当前流程','在我确认之前不要运行当前流程，之后再运行当前流程'
])await probe(text,[]);
for(const text of ['先创建草稿，等我确认后再运行当前流程','先创建草稿等我确认后再运行当前流程','先创建草稿，等权限开通，再运行当前流程'])await probe(text,['edit_draft']);
for(const text of ['现在运行当前流程','请现在运行当前流程','请运行当前流程，告诉我结果','请运行当前流程，然后告诉我需要多久','请运行当前流程，然后告诉我是否成功'])await probe(text,['run'],1);
await fixture([{text:'',calls:[{id:'current-edit',name:'workflow_draft_create',arguments:JSON.stringify({workflowId:'before-condition',name:'当前允许保存的草稿',environment:'test',mode:'auto',template:'blank',idempotencyKey:'current-edit'})}],usage:null},done],async f=>{
 const text='先创建草稿，等我确认后再运行',actions=requestedActions(text),accepted=f.app.assistant.submit(f.session.id,{text,mode:actions.length?'compose':'help',requestedActions:actions,context:{},modelProfileId:f.profile.id,idempotencyKey:'edit-now'});await f.app.assistant.settled();const task=f.app.assistant.task(accepted.taskId);
 const row={text,inferredActions:actions,offeredWorkflowStart:f.provider.requests[0].tools.some(t=>t.name==='workflow_start'),taskStatus:task.status,actualDraftsCreated:f.repo.all('workflows').length,actualRunsCreated:f.repo.all('runs').length,toolReceipts:task.tools.map(t=>({name:t.name,isError:!!t.isError,status:t.status}))};row.passed=JSON.stringify(actions)===JSON.stringify(['edit_draft'])&&!row.offeredWorkflowStart&&row.taskStatus==='COMPLETED'&&row.actualDraftsCreated===1&&row.actualRunsCreated===0;out.push(row);
});
const result={baselineHead:'61e19eeca0146c2e8247c3f16720570c63115ca6',scope:'Independent A01 re-audit of latest source and current built dist; memory databases and ScriptedModelProvider only',cases:out,passed:out.filter(r=>r.passed).length,failed:out.filter(r=>!r.passed).length};
await writeFile('/tmp/flowhub-max-reaudit-a01-final.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));if(result.failed)process.exitCode=1;
