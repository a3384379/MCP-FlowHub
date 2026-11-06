import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoot } from "../../contracts/src/index.js";
import { clone, ensure, hash, HubError, id, now, type Json } from "../../contracts/src/domain.js";
import type { AuthoringService } from "../../workflow-authoring/src/index.js";
import { capabilityDefinition, connectionDefinition } from "./execution-baseline.js";

const suiteSchema=JSON.parse(readFileSync(resolve(projectRoot,"contracts/test-suite.schema.json"),"utf8"));
export const AI_TEST_CASES_SCHEMA={type:"object",properties:{cases:clone(suiteSchema.properties.cases)},required:["cases"],additionalProperties:false};
export type TestCaseProposer=(request:Json,signal:AbortSignal,owner:string)=>Promise<{cases:Json[];usage:Json}>;
export type GeneratedSuiteCommit=(request:Json,cases:Json[],owner:string,generationId:string)=>Json;
const active=new Set(["QUEUED","RUNNING"]);
export const generationCatalog=(context:Json)=>context.capabilities.map((contract:Json)=>{
  const {lockedArguments,...metadata}=contract;return metadata;
});

/** A bounded model job; publication and tool execution are never part of generation. */
export class AiTestGenerator {
  private jobs=new Map<string,Promise<void>>();
  private controls=new Map<string,AbortController>();
  private closing=false;
  private closingPromise:Promise<void>|undefined;
  constructor(readonly authoring:AuthoringService,private propose:TestCaseProposer,private commit:GeneratedSuiteCommit) {}
  private get repo(){return this.authoring.repo;}
  private profileBaseline(modelProfileId:string) {
    const profile=this.repo.get("model_profiles",modelProfileId);
    ensure(profile&&!profile.disabled,"MODEL_NOT_CONFIGURED","Choose an enabled model profile.");
    return {revision:profile.revision,identity:hash({id:profile.id,revision:profile.revision,providerKind:profile.providerKind,baseUrl:profile.baseUrl,model:profile.model,secretRef:profile.secretRef??null,disabled:!!profile.disabled})};
  }
  private source(workflowId:string,owner:string) {
    const record=this.authoring.get(workflowId,owner),capabilities:Json[]=[],bindings:Json[]=[],connections:Json[]=[],contracts:Json[]=[];
    for(const ref of record.capabilityRefs) {
      const cap=this.repo.get("capabilities",ref.capabilityId);
      ensure(cap&&!cap.stale&&cap.revision===ref.revision,"CAPABILITY_STALE","Review the current capability before generating cases.",409);
      if(!capabilities.some(c=>c.id===cap.id)) {
        capabilities.push({id:cap.id,hash:hash(capabilityDefinition(cap))});
        contracts.push(Object.fromEntries(["id","kind","name","description","executor","revision","inputSchema","outputSchema","tool","contentHash"].filter(k=>Object.hasOwn(cap,k)).map(k=>[k,clone(cap[k])])));
      }
    }
    for(const bindingId of new Set(Object.values(record.draft.bindings) as string[])) {
      const binding=this.repo.get("bindings",bindingId);ensure(binding,"BINDING_UNVERIFIED","Test binding is unavailable.");
      const connection=this.repo.get("connections",binding.connectionId);ensure(connection,"BINDING_UNVERIFIED","Test connection is unavailable.");
      bindings.push({id:binding.id,hash:hash(binding)});
      if(!connections.some(c=>c.id===connection.id))connections.push({id:connection.id,hash:hash(connectionDefinition(connection))});
      // Model context contains schema and fixed resources, never endpoint/launch/auth configuration.
      contracts.push({bindingId:binding.id,environment:binding.environment,allowedTools:clone(binding.allowedTools??[]),lockedArguments:clone(binding.lockedArguments??{}),
        tools:clone(connection.tools??[])});
    }
    return {baseline:{draftRevision:record.revision,draftHash:hash(record.draft),capabilities,bindings,connections},context:{workflow:clone(record.draft),capabilities:contracts}};
  }
  private unchanged(run:Json) {
    const source=this.source(run.workflowId,run.owner);
    ensure(hash(source.baseline)===hash(run.sourceBaseline),"TEST_BASELINE_STALE","Draft, capability or binding changed while generating cases.",409);
    ensure(hash(this.profileBaseline(run.modelProfileId))===hash(run.modelBaseline),"REVISION_CONFLICT","The model profile changed while generating cases.",409);
  }
  accept(request:Json,owner="admin") {
    ensure(!this.closing,"SERVICE_CLOSING","Test generation is shutting down.",503);
    this.authoring.authorize(owner,request.workflowId);
    ensure(typeof request.modelProfileId==="string"&&request.modelProfileId.length>0,"MODEL_NOT_CONFIGURED","Select a model profile for AI-assisted generation.");
    const receipt=this.repo.command(owner,"test.generate",request.idempotencyKey,request,()=>{
      const source=this.source(request.workflowId,owner),model=this.profileBaseline(request.modelProfileId);
      ensure(source.baseline.draftRevision===request.expectedRevision,"REVISION_CONFLICT","Draft changed.",409);
      ensure(request.expectedModelRevision===undefined||request.expectedModelRevision===model.revision,"REVISION_CONFLICT","Model profile changed.",409);
      if(request.baseSuiteId) {
        const suite=this.repo.get("workflow_test_suites",request.baseSuiteId);
        ensure(suite&&suite.owner===owner&&suite.workflowId===request.workflowId&&suite.suiteRevision===request.expectedSuiteRevision,"REVISION_CONFLICT","Test suite changed.",409);
      }
      const context={...source.context,scenarioHints:clone(request.scenarioHints??[])};
      ensure(Buffer.byteLength(JSON.stringify(context))<=65536,"BUDGET_EXCEEDED","Generation context exceeds 64 KiB; narrow the workflow or hints.");
      const vault=this.authoring.engine.vault;
      const catalog=generationCatalog(context);if(catalog.length)vault.assertCatalogSafe(catalog,vault.catalogContext());
      const generationId=id("generation");
      this.repo.insert("workflow_test_runs",generationId,{id:generationId,kind:"generation",mode:"generation",owner,workflowId:request.workflowId,modelProfileId:request.modelProfileId,
        modelBaseline:model,sourceBaseline:source.baseline,sourceSnapshot:context,request:clone(request),status:"QUEUED",cases:[],gaps:[],createdAt:now(),draftRevision:request.expectedRevision,
        requestHash:hash(request),modelCalls:0,usage:null,usageAccounting:"unknown",businessServiceCalls:0,simulationOnly:false});
      this.repo.changed("test.generation.queued",{testRunId:generationId,workflowId:request.workflowId});
      return {testRunId:generationId,generationId,status:"QUEUED"};
    });
    const run=this.repo.get("workflow_test_runs",receipt.testRunId);
    ensure(run?.kind==="generation"&&!run.resultsExpiredAt,"RESULT_EXPIRED","The original generation has expired; use a new idempotency key.",410);
    if(run.status==="QUEUED"&&!this.jobs.has(run.id)) {
      const controller=new AbortController();this.controls.set(run.id,controller);
      const work=Promise.resolve().then(()=>this.perform(run.id,controller)).finally(()=>{this.jobs.delete(run.id);this.controls.delete(run.id);});
      this.jobs.set(run.id,work);
    }
    return receipt;
  }
  status(generationId:string,owner="admin") {
    const run=this.repo.get("workflow_test_runs",generationId);
    ensure(run?.kind==="generation"&&(owner==="admin"||run.owner===owner),"NOT_FOUND","Generation task missing.",404);
    this.authoring.authorize(owner,run.workflowId);
    let stale=!!run.resultsExpiredAt;
    try{this.unchanged(run);}catch{stale=true;}
    const {sourceBaseline,sourceSnapshot,modelBaseline,request,...publicRun}=run;
    return {...publicRun,stale};
  }
  cancel(generationId:string,owner="admin") {
    this.status(generationId,owner);
    this.repo.tx(()=>{
      const run=this.repo.get("workflow_test_runs",generationId);
      if(active.has(run.status)) {
        this.repo.put("workflow_test_runs",generationId,{...run,status:"CANCELLED",errorCode:"TASK_CANCELLED",completedAt:now()});
        this.repo.changed("test.generation.completed",{testRunId:generationId,workflowId:run.workflowId,status:"CANCELLED"});
      }
    });
    this.controls.get(generationId)?.abort(new HubError("TASK_CANCELLED","Generation cancelled."));
    return this.status(generationId,owner);
  }
  private async perform(generationId:string,controller:AbortController) {
    let run=this.repo.get("workflow_test_runs",generationId);
    if(!run||!active.has(run.status))return;
    try {
      ensure(!this.closing&&!controller.signal.aborted,"TASK_INTERRUPTED","Test generation interrupted.");
      this.unchanged(run);
      this.repo.put("workflow_test_runs",run.id,{...run,status:"RUNNING",startedAt:now()});
      const profile=this.repo.get("model_profiles",run.modelProfileId),timeout=AbortSignal.timeout(Math.min(300000,profile.limits?.taskTimeoutMs??profile.timeoutMs??180000)),signal=AbortSignal.any([controller.signal,timeout]);
      let abort!:()=>void;
      const aborted=new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason instanceof HubError?signal.reason:new HubError(timeout.aborted?"MODEL_TIMEOUT":"TASK_CANCELLED","Test generation stopped before completion."));signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();});
      let result:{cases:Json[];usage:Json};
      const onModelRequest=()=>{
        const current=this.repo.get("workflow_test_runs",generationId);
        ensure(!signal.aborted&&!this.closing&&current?.status==="RUNNING","TASK_CANCELLED","Generation stopped before its model request.");
        ensure(current.modelCalls===0,"BUDGET_EXCEEDED","AI generation permits one model request.");
        this.repo.put("workflow_test_runs",generationId,{...current,modelCalls:1});
        this.repo.changed("test.generation.model_requested",{testRunId:generationId,workflowId:current.workflowId});
      };
      try{result=await Promise.race([this.propose({modelProfileId:run.modelProfileId,expectedModelRevision:run.modelBaseline.revision,context:clone(run.sourceSnapshot),onModelRequest},signal,run.owner),aborted]);}
      finally{signal.removeEventListener("abort",abort);}
      ensure(!signal.aborted&&!this.closing,"TASK_INTERRUPTED","Generation stopped before saving its suite.");
      this.repo.tx(()=>{
        run=this.repo.get("workflow_test_runs",generationId);
        ensure(run?.status==="RUNNING","TASK_CANCELLED","Generation is no longer active.");
        this.unchanged(run);
        const suite=this.commit(clone(run.request),result.cases,run.owner,generationId);
        this.repo.put("workflow_test_runs",generationId,{...run,status:"SUCCEEDED",suiteId:suite.suiteId,suiteRevision:suite.suiteRevision,caseCount:suite.caseCount,gaps:suite.gaps??[],
          usage:result.usage??null,usageAccounting:result.usage?"reported":"unknown",completedAt:now()});
        this.repo.changed("test.generation.completed",{testRunId:generationId,workflowId:run.workflowId,status:"SUCCEEDED",suiteId:suite.suiteId});
      });
    }catch(error) {
      run=this.repo.get("workflow_test_runs",generationId);
      if(run&&active.has(run.status)) {
        const status=this.closing?"INTERRUPTED":controller.signal.aborted?"CANCELLED":"FAILED",errorCode=this.closing?"TASK_INTERRUPTED":error instanceof HubError?error.code:"MODEL_OUTPUT_INVALID";
        this.repo.put("workflow_test_runs",generationId,{...run,status,errorCode,completedAt:now()});
        this.repo.changed("test.generation.completed",{testRunId:generationId,workflowId:run.workflowId,status,errorCode});
      }
    }
  }
  async idle(){await Promise.allSettled(this.jobs.values());}
  close(){
    if(this.closingPromise)return this.closingPromise;
    this.closing=true;for(const controller of this.controls.values())controller.abort(new HubError("TASK_INTERRUPTED","Test generation interrupted by shutdown."));
    this.closingPromise=this.idle();return this.closingPromise;
  }
}
