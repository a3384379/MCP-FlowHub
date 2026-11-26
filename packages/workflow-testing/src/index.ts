import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoot, inputContract } from "../../contracts/src/index.js";
import { clone, hash, id, now, ensure, validate, get, set, condition, HubError, type Json } from "../../contracts/src/domain.js";
import { Repository } from "../../persistence/src/repository.js";
import { Vault } from "../../security/src/index.js";
import { Engine } from "../../workflow-core/src/engine.js";
import type { Connectors } from "../../mcp-connectors/src/registry.js";
import type { AuthoringService } from "../../workflow-authoring/src/index.js";
import { adaptMcpResult, MCP_RAW_RESULT } from "../../mcp-connectors/src/results.js";
import { schemaAt } from "../../workflow-core/src/mapping-schema.js";
import { AiTestGenerator,type TestCaseProposer } from "./ai-generation.js";
import { ScopedExecution,validateScope } from "./scoped-execution.js";
import {connectionBaseline} from "./execution-baseline.js";
const suiteSchema=JSON.parse(readFileSync(resolve(projectRoot,"contracts/test-suite.schema.json"),"utf8"));
const terminal=new Set(["SUCCEEDED","FAILED","CANCELLED","OUTCOME_UNKNOWN","BLOCKED"]);
function sample(schema:Json,depth=0,budget={remaining:16384}):Json {
  if(depth>15||--budget.remaining<0)return null;
  if(schema.examples?.length)return clone(schema.examples[0]);
  if(schema.default!==undefined)return clone(schema.default);
  if(schema.const!==undefined)return clone(schema.const);
  if(schema.enum?.length)return clone(schema.enum[0]);
  if(schema.type==="object")return Object.fromEntries(Object.entries(schema.properties??{}).filter(([k])=>(schema.required??[]).includes(k)).map(([k,v])=>[k,sample(v,depth+1,budget)]));
  if(schema.type==="array")return Array.from({length:Math.min(100,schema.minItems??0)},()=>sample(schema.items??{},depth+1,budget));
  if(schema.type==="string"){const text=schema.format==="date-time"?"2026-10-31T00:00:00Z":"s".repeat(Math.min(4096,Math.max(0,budget.remaining),schema.minLength??1));budget.remaining-=text.length;return text;}
  if(schema.type==="boolean")return false;
  if(schema.type==="number"||schema.type==="integer")return schema.minimum??(schema.exclusiveMinimum!==undefined?schema.exclusiveMinimum+1:Math.min(0,schema.maximum??0));
  return null;
}
export class WorkflowTesting {
  private jobs=new Map<string,Promise<void>>();
  private controls=new Map<string,AbortController>();
  private activeEngines=new Set<Engine>();
  private closing=false;
  private closingPromise:Promise<void>|undefined;
  private ai:AiTestGenerator|undefined;
  constructor(readonly authoring:AuthoringService) {
    for(const run of this.repo.all("workflow_test_runs"))if(!["SUCCEEDED","FAILED","PARTIAL","INTERRUPTED","CANCELLED"].includes(run.status))
      this.repo.put("workflow_test_runs",run.id,{...run,status:"INTERRUPTED",outcomeUnknown:run.outcomeUnknown||!!run.pendingDispatches?.length,gaps:[...(run.gaps??[]),"TASK_INTERRUPTED"]});
  }
  get repo(){return this.authoring.repo;}
  configureAi(propose:TestCaseProposer) {
    this.ai=new AiTestGenerator(this.authoring,propose,(request,cases,owner,generationId)=>{
      const {modelProfileId,expectedModelRevision,...base}=request;
      const result=this.generate({...base,strategy:"agent_proposed",proposedCases:cases,idempotencyKey:"generated:"+generationId},owner);
      const suite=this.repo.get("workflow_test_suites",result.suiteId);
      const source={generatedBy:"ai_assisted",generationRef:generationId};
      this.repo.put("workflow_test_suites",suite.id,{...suite,generatedBy:"ai_assisted",generationRef:generationId,
        generationSource:suite.suiteRevision===1?source:suite.generationSource,
        revisionSources:suite.revisionSources.map((revision:Json)=>revision.suiteRevision===suite.suiteRevision?{...revision,...source}:revision)});
      return result;
    });
  }
  private ensureOpen(){ensure(!this.closing,"SERVICE_CLOSING","Workflow testing is shutting down.",503);}
  private ensureRunning(signal:AbortSignal){
    ensure(!this.closing,"TASK_INTERRUPTED","Self-test stopped during shutdown.",503);
    if(signal.aborted)throw signal.reason instanceof HubError?signal.reason:new HubError(signal.reason?.name==="TimeoutError"?"TEST_TIMEOUT":"TASK_CANCELLED","Self-test stopped before completion.");
  }
  generate(a:Json,owner="admin") {
    this.ensureOpen();
    validate(inputContract.$defs.workflow_test_generate,a);
    this.authoring.authorize(owner,a.workflowId);
    ensure(Buffer.byteLength(JSON.stringify(a))<=1048576,"BUDGET_EXCEEDED","Test generation request exceeds 1 MiB.");
    if(a.strategy==="ai_assisted") {
      ensure(this.ai,"MODEL_NOT_CONFIGURED","AI test generation is unavailable in this service.");
      ensure(a.proposedCases===undefined,"INPUT_INVALID","AI generation does not accept supplied cases; use agent_proposed.");
      return this.ai.accept(a,owner);
    }
    ensure(a.modelProfileId===undefined&&a.expectedModelRevision===undefined,"INPUT_INVALID","Only AI generation accepts model configuration.");
    return this.repo.command(owner,"test.generate",a.idempotencyKey,a,()=>{
      const record=this.authoring.get(a.workflowId,owner);
      ensure(record.revision===a.expectedRevision,"REVISION_CONFLICT","Draft changed.",409);
      let cases:Json[]=a.proposedCases;const generationGaps:Json[]=[];
      if(a.strategy==="agent_proposed")ensure(Array.isArray(cases)&&cases.length,"INPUT_INVALID","Proposed test cases required.");
      else {
        const inputSchema=record.draft.inputSchema,inputs=sample(inputSchema);
        cases=[{id:"normal",name:"正常数据流",inputs,mockResults:[],agentSubmissions:[],assertions:[{kind:"terminal_state",expected:"SUCCEEDED"}],expectedValidationErrors:[]}];
        try{validate(inputSchema,inputs);}catch{generationGaps.push({caseId:"normal",code:"INPUT_SAMPLE_REQUIRED",message:"Provide a valid schema example for constraints the deterministic sampler cannot satisfy."});}
        if((inputSchema.required?.length??0)>199)generationGaps.push({code:"GENERATION_LIMIT"});
        for(const key of (inputSchema.required??[]).slice(0,199)) {
          const missing=clone(inputs);delete missing[key];
          cases.push({id:"missing-"+key,name:"缺少必填 "+key,inputs:missing,mockResults:[],agentSubmissions:[],assertions:[{kind:"error_code",expected:"INPUT_INVALID"}],expectedValidationErrors:["INPUT_INVALID"]});
        }
        const add=(key:string,label:string,value:Json)=>{
          if(cases.length>=200){if(!generationGaps.some(g=>g.code==="GENERATION_LIMIT"))generationGaps.push({code:"GENERATION_LIMIT",message:"Select fields or propose additional cases; the suite limit is 200."});return;}
          const candidate={...clone(inputs),[key]:value};let invalid=false;try{validate(inputSchema,candidate);}catch{invalid=true;}
          cases.push({id:label+"-"+key,name:label+" "+key,inputs:candidate,mockResults:[],agentSubmissions:[],assertions:[invalid?{kind:"error_code",expected:"INPUT_INVALID"}:{kind:"terminal_state",expected:"SUCCEEDED"}],expectedValidationErrors:invalid?["INPUT_INVALID"]:[]});
        };
        for(const [key,definition] of Object.entries(inputSchema.properties??{}) as [string,Json][]) {
          if(definition.type)add(key,"type",definition.type==="string"?42:"wrong-type");
          for(const [label,value] of [["min",definition.minimum],["max",definition.maximum],["exclusive-min",definition.exclusiveMinimum],["exclusive-max",definition.exclusiveMaximum]] as [string,Json][])if(typeof value==="number"){
            add(key,label,value);add(key,label+"-outside",value+(label.includes("min")?-1:1));
          }
          for(const [constraint,label] of [["minLength","length-min"],["maxLength","length-max"]])if(typeof definition[constraint!]==="number") {
            const length=definition[constraint!];if(length<=4096){add(key,label!,"s".repeat(length));add(key,label+"-outside","s".repeat(Math.max(0,length+(constraint==="minLength"?-1:1))));}
            else generationGaps.push({field:key,code:"GENERATION_LIMIT",message:"Large string boundary requires an explicit fixture."});
          }
          for(const [constraint,label] of [["minItems","items-min"],["maxItems","items-max"]])if(typeof definition[constraint!]==="number") {
            const length=definition[constraint!];if(length<=100){add(key,label!,Array.from({length},()=>sample(definition.items??{})));add(key,label+"-outside",Array.from({length:Math.max(0,length+(constraint==="minItems"?-1:1))},()=>sample(definition.items??{})));}
            else generationGaps.push({field:key,code:"GENERATION_LIMIT",message:"Large array boundary requires an explicit fixture."});
          }
          if(definition.type==="boolean"){add(key,"true",true);add(key,"false",false);}
          for(const [index,value] of (definition.enum??[]).slice(0,10).entries())add(key,"enum-"+index,value);
        }
        this.branchCases(record.draft,inputs,cases,generationGaps);
      }
      const base=a.baseSuiteId?this.repo.get("workflow_test_suites",a.baseSuiteId):null;
      ensure(!a.baseSuiteId||(base&&base.owner===owner&&base.suiteRevision===a.expectedSuiteRevision&&base.workflowId===a.workflowId),"REVISION_CONFLICT","Test suite changed.",409);
      const previousSource=base?{generatedBy:base.generatedBy,...(base.generationRef?{generationRef:base.generationRef}:{})}:null;
      const suiteId=base?.id??id("suite"),suiteRevision=(base?.suiteRevision??0)+1,suite={id:suiteId,workflowId:a.workflowId,draftRevision:a.expectedRevision,suiteRevision,
        capabilityRevisions:Object.fromEntries(record.capabilityRefs.map((c:Json)=>[c.capabilityId,c.revision])),fixtureHash:"sha256:"+hash(cases),generatedBy:a.strategy,mode:"mock",cases,
        ...(base?.generationRef?{generationRef:base.generationRef}:{}),generationSource:clone(base?.generationSource??previousSource??{generatedBy:a.strategy}),
        revisionSources:[...clone(base?.revisionSources??(base?[{suiteRevision:base.suiteRevision,...previousSource}]:[])),{suiteRevision,generatedBy:a.strategy}]};
      validate(suiteSchema,suite);
      ensure(new Set(cases.map(c=>c.id)).size===cases.length,"INPUT_INVALID","Duplicate test case IDs.");
      this.validateTargets(record.draft,cases);
      this.repo.put("workflow_test_suites",suiteId,{...suite,owner,revision:suite.suiteRevision,createdAt:base?.createdAt??now(),updatedAt:now()});
      return {suiteId,suiteRevision:suite.suiteRevision,caseCount:cases.length,gaps:[...this.gaps(record.draft,cases),...generationGaps]};
    });
  }
  private validateTargets(workflow:Json,cases:Json[]) {
    const nodes=new Map<string,Json>(workflow.nodes.map((node:Json)=>[node.id,node]));
    for(const c of cases) {
      for(const fixture of c.mockResults)ensure(nodes.get(fixture.nodeId)?.type==="mcp_tool","INPUT_INVALID","Mock fixture must target an existing MCP node: "+fixture.nodeId);
      for(const submission of c.agentSubmissions)ensure(nodes.get(submission.nodeId)?.type==="agent_task","INPUT_INVALID","Agent fixture must target an existing Agent node: "+submission.nodeId);
      for(const assertion of c.assertions)if(assertion.nodeId!==undefined) {
        const node=nodes.get(assertion.nodeId);
        ensure(node,"INPUT_INVALID","Assertion must target an existing node: "+assertion.nodeId);
        if(["tool_called","tool_not_called","tool_call_count","argument_equals"].includes(assertion.kind))
          ensure(node.type==="mcp_tool"||node.config.kind==="host_tool","INPUT_INVALID","Tool assertions must target an MCP node: "+assertion.nodeId);
        if(assertion.kind==="artifact_contains")ensure(["mcp_tool","report_template","agent_task"].includes(node.type),"INPUT_INVALID","Artifact assertions must target an artifact-producing node: "+assertion.nodeId);
      }
    }
  }
  private gaps(workflow:Json,cases:Json[]) {
    return workflow.nodes.filter((n:Json)=>n.type==="mcp_tool"||n.type==="agent_task").flatMap((n:Json)=>cases.filter(c=>!c.expectedValidationErrors.length&&
      !(n.type==="mcp_tool"?c.mockResults:c.agentSubmissions).some((r:Json)=>r.nodeId===n.id)).map(c=>({caseId:c.id,nodeId:n.id,code:"FIXTURE_MISSING"})));
  }
  private branchCases(workflow:Json,inputs:Json,cases:Json[],gaps:Json[]) {
    for(const node of workflow.nodes.filter((n:Json)=>n.type==="condition")) {
      const choices=new Map<string,Json[]>();
      const add=(pointer:string,values:Json[])=>choices.set(pointer,[...(choices.get(pointer)??[]),...values]);
      const visit=(expression:Json)=>{
        if(["and","or"].includes(expression.op)){expression.args.forEach(visit);return;}
        if(expression.op==="not"){visit(expression.arg);return;}
        const pair=expression.left?.ref?.source==="input"&&Object.hasOwn(expression.right??{},"value")?[expression.left,expression.right]:
          expression.right?.ref?.source==="input"&&Object.hasOwn(expression.left??{},"value")?[expression.right,expression.left]:null;
        const ref=pair?.[0]?.ref??(expression.op==="exists"?expression.value?.ref:null);
        if(ref?.source!=="input")return;
        try {
          const definition=schemaAt(workflow.inputSchema,ref.pointer),value=pair?.[1]?.value;
          const alternatives=[...(definition.enum??[]),...(Object.hasOwn(definition,"const")?[definition.const]:[]),sample(definition),
            ...(typeof value==="string"?[value+"_other",""]:typeof value==="boolean"?[!value]:typeof value==="number"?[value+1,value-1]:[])];
          add(ref.pointer,[...(pair?[value]:[]),...alternatives]);
        }catch{/* A referenced output or unresolved schema needs an explicit fixture. */}
      };
      visit(node.config.expression);
      let candidates=[clone(inputs)];
      for(const [pointer,values] of choices) {
        const next:Json[]=[],seen=new Set<string>();
        for(const candidate of candidates)for(const value of values.slice(0,16)) {
          const changed=clone(candidate);
          try { if(pointer==="")continue;set(changed,pointer,value);validate(workflow.inputSchema,changed); }
          catch { continue; }
          const fingerprint=hash(changed);if(!seen.has(fingerprint)){next.push(changed);seen.add(fingerprint);}
          if(next.length>=256)break;
        }
        if(next.length)candidates=next.slice(0,256);
      }
      for(const selected of [true,false]) {
        const matches=(candidate:Json)=>{try{validate(workflow.inputSchema,candidate);return condition(node.config.expression,candidate,{})===selected;}catch{return false;}};
        if(cases.some(c=>!c.expectedValidationErrors.length&&matches(c.inputs)))continue;
        const candidate=candidates.find(matches);
        if(candidate&&cases.length<200)cases.push({id:"branch-"+node.id+"-"+selected,name:"条件 "+node.id+" = "+selected,inputs:candidate,mockResults:[],agentSubmissions:[],assertions:[{kind:"terminal_state",expected:"SUCCEEDED"}],expectedValidationErrors:[]});
        else gaps.push({nodeId:node.id,branch:String(selected),code:"BRANCH_FIXTURE_REQUIRED",reason:choices.size?"NO_SCHEMA_VALID_INPUT_FOUND_WITHIN_GENERATION_BUDGET":"CONDITION_REQUIRES_UPSTREAM_FIXTURE"});
      }
    }
  }
  getSuite(suiteId:string,owner="admin") {
    const suite=this.repo.get("workflow_test_suites",suiteId);ensure(suite&&(owner==="admin"||suite.owner===owner),"NOT_FOUND","Test suite missing.",404);
    this.authoring.authorize(owner,suite.workflowId);return suite;
  }
  run(a:Json,owner="admin") {
    this.ensureOpen();
    validate(inputContract.$defs.workflow_test_run,a);
    ensure(Buffer.byteLength(JSON.stringify(a))<=1048576,"BUDGET_EXCEEDED","Test scope exceeds 1 MiB.");
    this.getSuite(a.suiteId,owner); // Current authorization is checked even for a replay.
    const accepted=this.repo.command(owner,"test.run",a.idempotencyKey,a,()=>{
      const suite=this.getSuite(a.suiteId,owner);
      ensure(suite.suiteRevision===a.expectedSuiteRevision,"REVISION_CONFLICT","Suite changed.",409);

      ensure(!a.caseIds || (a.caseIds.length>0&&new Set(a.caseIds).size===a.caseIds.length&&a.caseIds.every((key:string)=>suite.cases.some((c:Json)=>c.id===key))),"INPUT_INVALID","Select existing, unique test case IDs.");
      this.assertBaseline(suite);
      // The same contract and target checks protect edited/legacy suites as newly generated ones.
      validate(suiteSchema,{...Object.fromEntries(Object.keys(suiteSchema.properties).filter(key=>Object.hasOwn(suite,key)).map(key=>[key,suite[key]]))});
      this.validateTargets(this.repo.get("workflows",suite.workflowId).draft,suite.cases);
      const executionSnapshot=this.executionSnapshot(suite,a.mode!=="mock"),scope=validateScope(a,suite,executionSnapshot),testRunId=id("test");
      if(a.mode==="live")ensure(!this.authoring.engine.vault.locked,"CREDENTIAL_LOCKED","Unlock the vault before live execution.",423);
      this.repo.insert("workflow_test_runs",testRunId,{id:testRunId,suiteId:suite.id,workflowId:suite.workflowId,owner,mode:a.mode,scope,scopeHash:scope?hash(scope):null,snapshotHash:"sha256:"+hash(executionSnapshot),validationLevel:a.mode,toolCalls:0,catalogChecks:0,credentialReadAccounting:a.mode==="mock"?"none":"not_instrumented",syntheticBindings:executionSnapshot.bindings.filter((b:Json)=>b.simulationOnly||b.fixtureRequiresSynthetic).map((b:Json)=>b.id),status:"QUEUED",cases:[],gaps:[],createdAt:now(),draftRevision:suite.draftRevision,capabilityRevisions:clone(suite.capabilityRevisions),fixtureHash:suite.fixtureHash,suiteRevision:suite.suiteRevision,
        acceptedSuite:clone(suite),selectedCaseIds:a.caseIds??suite.cases.map((c:Json)=>c.id),executionSnapshot});return {testRunId,status:"QUEUED"};
    });
    const run=this.repo.get("workflow_test_runs",accepted.testRunId);
    ensure(run&&!run.resultsExpiredAt,"RESULT_EXPIRED","The accepted test run has expired; use a new idempotency key for a new run.",410);
    if(run.status==="QUEUED"&&!this.jobs.has(accepted.testRunId)) {
      const controller=new AbortController();this.controls.set(accepted.testRunId,controller);
      const timeout=run.scope?AbortSignal.timeout(run.scope.budgets.timeoutMs):null;
      const signal=timeout?AbortSignal.any([controller.signal,timeout]):controller.signal;
      const work=this.perform(accepted.testRunId,clone(run.acceptedSuite),clone(run.executionSnapshot),signal,run.selectedCaseIds)
        .finally(()=>{this.jobs.delete(accepted.testRunId);this.controls.delete(accepted.testRunId);});this.jobs.set(accepted.testRunId,work);
    }
    return accepted;
  }
  private assertBaseline(suite:Json) {
    ensure(this.repo.get("workflows",suite.workflowId)?.revision===suite.draftRevision&&Object.entries(suite.capabilityRevisions).every(([key,rev])=>{
      const cap=this.repo.get("capabilities",key);return cap&&!cap.stale&&cap.revision===rev;
    }),"TEST_BASELINE_STALE","Draft or capabilities changed; regenerate tests.",409);
  }
  listRuns(workflowId:string,owner="admin") {
    this.authoring.get(workflowId,owner);
    // Resume pointers only. Do not decode historic inputs, results or model prompts.
    return this.repo.db.prepare(`SELECT id,json_extract(body,'$.kind') AS kind,json_extract(body,'$.mode') AS mode,
      json_extract(body,'$.status') AS status,json_extract(body,'$.suiteId') AS suiteId,json_extract(body,'$.createdAt') AS createdAt,
      json_extract(body,'$.draftRevision') AS draftRevision,json_extract(body,'$.suiteRevision') AS suiteRevision
      FROM workflow_test_runs WHERE json_extract(body,'$.workflowId')=@workflowId
      AND (@owner='admin' OR json_extract(body,'$.owner')=@owner) AND json_extract(body,'$.resultsExpiredAt') IS NULL
      ORDER BY CASE WHEN json_extract(body,'$.status') IN ('QUEUED','RUNNING') THEN 0 ELSE 1 END,
      json_extract(body,'$.createdAt') DESC,id DESC LIMIT 50`).all({workflowId,owner});
  }
  status(testRunId:string,owner="admin") {
    const run=this.repo.get("workflow_test_runs",testRunId);ensure(run&&(owner==="admin"||run.owner===owner),"NOT_FOUND","Test run missing.",404);
    if(run.kind==="generation") {ensure(this.ai,"NOT_FOUND","Generation service unavailable.",404);return this.ai.status(testRunId,owner);}
    const suite=this.getSuite(run.suiteId,owner),accepted=run.acceptedSuite;
    // A newer suite can never renew evidence produced from an older accepted baseline.
    let stale=!!run.resultsExpiredAt||suite.suiteRevision!==run.suiteRevision||suite.fixtureHash!==run.fixtureHash;
    const capabilities=run.capabilityRevisions??accepted?.capabilityRevisions??(run.executionSnapshot?.capabilities?
      Object.fromEntries(run.executionSnapshot.capabilities.map((cap:Json)=>[cap.capabilityId,cap.capabilityRevision??cap.revision])):null);
    if(!capabilities)stale=true; // Legacy rows without frozen capability metadata are conservatively stale.
    else try{
      this.assertBaseline({workflowId:run.workflowId??accepted?.workflowId??suite.workflowId,draftRevision:run.draftRevision,capabilityRevisions:capabilities});
      if(accepted&&(accepted.draftRevision!==run.draftRevision||accepted.suiteRevision!==run.suiteRevision||accepted.fixtureHash!==run.fixtureHash||hash(accepted.capabilityRevisions)!==hash(capabilities)))stale=true;
    }catch{stale=true;}
    if(run.executionSnapshot?.authorization) {
      try { for(const [key,value] of Object.entries(run.executionSnapshot.authorization.bindings))if(hash(this.repo.get("bindings",key))!==value)stale=true;
        for(const [key,value] of Object.entries(run.executionSnapshot.authorization.connections))if(connectionBaseline(this.repo.get("connections",key))!==value)stale=true; }catch{stale=true;}
    }
    const {acceptedSuite,executionSnapshot,selectedCaseIds,...publicRun}=run;
    return {...publicRun,stale};
  }
  publicationEvidence(workflowId: string, draftRevision: number) {
    const tests = this.repo.db.prepare(`SELECT id, json_extract(body,'$.createdAt') AS createdAt
      FROM workflow_test_runs WHERE json_extract(body,'$.workflowId')=@workflowId
      AND json_extract(body,'$.draftRevision')=@draftRevision AND json_extract(body,'$.mode')=@mode
      ORDER BY createdAt DESC, id DESC LIMIT 1`);
    return Object.fromEntries(["mock", "contract", "live"].map(mode => {
      const latest = tests.get({ workflowId, draftRevision, mode }) as { id: string } | undefined;
      if (!latest) return [mode, { status: "NOT_RUN" }];
      try {
        const run = this.status(latest.id);
        return [mode, { id: latest.id, status: run.stale ? "STALE" : run.status }];
      } catch {
        return [mode, { id: latest.id, status: "STALE" }];
      }
    }));
  }
  private executionSnapshot(suite:Json,scoped=false) {
    const draft=clone(this.repo.get("workflows",suite.workflowId).draft),connections:Json[]=[],bindings:Json[]=[],capabilities:Json[]=[];
    // Whitelist simulation contracts. Never copy transport, endpoints, source configuration or credential references.
    for(const bindingId of new Set(Object.values(draft.bindings) as string[])) {
      const original=this.repo.get("bindings",bindingId);ensure(original,"BINDING_UNVERIFIED","Test binding missing.");
      const conn=this.repo.get("connections",original.connectionId);ensure(conn,"BINDING_UNVERIFIED","Test connection missing.");
      if(!connections.some(c=>c.id===conn.id))connections.push({id:conn.id,revision:conn.revision,tools:clone(conn.tools)});
      bindings.push({id:original.id,revision:original.revision,connectionId:conn.id,connectionRevision:conn.revision,environment:original.environment,
        allowedTools:clone(original.allowedTools),lockedArguments:clone(original.lockedArguments),allowedQueryTemplates:clone(original.allowedQueryTemplates),maxRows:original.maxRows,timeoutSeconds:original.timeoutSeconds,
        fixtureRequiresSynthetic:original.simulationOnly===true});
    }
    for(const n of draft.nodes) if(n.config.capabilityRef) {
      const ref=n.config.capabilityRef,cap=this.repo.get("capability_revisions",ref.capabilityId+"@"+ref.revision);
      ensure(cap&&cap.capabilityId===ref.capabilityId&&(cap.capabilityRevision??cap.revision)===ref.revision,"CAPABILITY_STALE","The exact capability revision is unavailable for simulation.",409);
      if(!capabilities.some(c=>c.id===cap.id))capabilities.push(Object.fromEntries(["id","capabilityId","revision","capabilityRevision","kind","name","description","executor","inputSchema","outputSchema","tool","serverName","contentHash","skillContent"].filter(key=>Object.hasOwn(cap,key)).map(key=>[key,clone(cap[key])])));
    }
    if(scoped) {
      const scopedBindings=bindings.map(b=>clone(this.repo.get("bindings",b.id)));
      const scopedConnections=connections.map(c=>{const original=this.repo.get("connections",c.id);return Object.fromEntries(["id","revision","tools","disabled","synthetic","syntheticEvidence","protocolEra","verifiedAt","verifiedSdk","verifiedRevision","catalogSafetyVersion"].filter(k=>Object.hasOwn(original,k)).map(k=>[k,clone(original[k])]));});
      return {draft,connections:scopedConnections,bindings:scopedBindings,capabilities,authorization:{bindings:Object.fromEntries(scopedBindings.map(b=>[b.id,hash(this.repo.get("bindings",b.id))])),connections:Object.fromEntries(connections.map(c=>[c.id,connectionBaseline(this.repo.get("connections",c.id))]))}};
    }
    return {draft,connections,bindings,capabilities};
  }
  private async perform(testRunId:string,suite:Json,snapshot:Json,signal:AbortSignal,caseIds?:string[]) {
    const results:Json[]=[],selectedCases=suite.cases.filter((item:Json)=>!caseIds||caseIds.includes(item.id));
    try {
      const accepted=this.repo.get("workflow_test_runs",testRunId),draft=snapshot.draft;
      const scoped=accepted.mode!=="mock"?new ScopedExecution(this.authoring,testRunId,accepted,snapshot,signal):undefined;
      this.repo.put("workflow_test_runs",testRunId,{...accepted,status:"RUNNING",startedAt:now()});
      if(accepted.mode==="contract") {
        const schemaChecks=await scoped!.catalogs();this.ensureRunning(signal);
        const failed=schemaChecks.filter((c:Json)=>!c.passed).length;
        this.repo.put("workflow_test_runs",testRunId,{...this.repo.get("workflow_test_runs",testRunId),status:failed?"FAILED":"SUCCEEDED",schemaChecks,cases:[],
          summary:{checked:schemaChecks.length,failed},gaps:[],completedAt:now(),simulationOnly:false,validationLevel:"contract",provenance:"mcp_catalog_only",toolCalls:0,networkCalls:null,realSecretReads:null});
        this.repo.changed("test.completed",{testRunId,status:failed?"FAILED":"SUCCEEDED",mode:"contract"});return;
      }
      for(const c of selectedCases) {
        this.ensureRunning(signal);
        const result:Json=await this.case(snapshot,c,signal,scoped);results.push(result);
        if(scoped&&(result.executionState==="OUTCOME_UNKNOWN"||this.repo.get("workflow_test_runs",testRunId).outcomeUnknown)) {
          // Matching a negative assertion never authorizes continuing after an uncertain dispatch.
          result.status="FAILED";result.outcomeUnknown=true;
          this.repo.put("workflow_test_runs",testRunId,{...this.repo.get("workflow_test_runs",testRunId),outcomeUnknown:true});
          throw new HubError("OUTCOME_UNKNOWN","A live tool outcome is unknown; remaining cases were not executed.");
        }
        this.ensureRunning(signal);
        this.repo.put("workflow_test_runs",testRunId,{...this.repo.get("workflow_test_runs",testRunId),status:"RUNNING",cases:results});
        this.repo.changed("test.progress",{testRunId,caseId:c.id,status:result.status});
      }
      const fixtureGaps=results.filter(c=>c.status==="UNCOVERED").map(c=>({caseId:c.id,code:c.errorCode??"FIXTURE_MISSING"}));
      const branchCoverage=draft.nodes.filter((n:Json)=>n.type==="condition").map((n:Json)=>({nodeId:n.id,true:results.some(r=>r.outputs?.[n.id]===true),false:results.some(r=>r.outputs?.[n.id]===false)}));
      const gaps=[...(scoped?results.flatMap(c=>c.gaps??[]):[]),...fixtureGaps,...branchCoverage.flatMap((branch:Json)=>[true,false].filter(value=>!branch[String(value)]).map(value=>({nodeId:branch.nodeId,branch:String(value),code:"BRANCH_NOT_COVERED",reason:results.some(r=>r.errorCode==="FIXTURE_MISSING")?"MISSING_UPSTREAM_FIXTURE":"NO_SELECTED_CASE_REACHED_BRANCH"})))];
      const summary={passed:results.filter(c=>c.status==="PASSED").length,failed:results.filter(c=>c.status==="FAILED").length,uncovered:fixtureGaps.length,total:results.length};
      this.repo.put("workflow_test_runs",testRunId,{...this.repo.get("workflow_test_runs",testRunId),status:summary.failed?"FAILED":gaps.length?"PARTIAL":"SUCCEEDED",summary,gaps,completedAt:now(),simulationOnly:!scoped,networkCalls:scoped?null:0,realSecretReads:scoped?null:0,
        toolCalls:scoped?this.repo.get("workflow_test_runs",testRunId).toolCalls:results.reduce((sum,c)=>sum+c.trace.length,0),provenance:scoped?"scoped_live_mcp":"synthetic_fixture",branchCoverage});
      this.repo.changed("test.completed",{testRunId,status:this.repo.get("workflow_test_runs",testRunId).status,mode:accepted.mode});
    }catch(e){const current=this.repo.get("workflow_test_runs",testRunId),cancelled=current.cancelRequested===true;
      const errorCode=this.closing?"TASK_INTERRUPTED":cancelled?"TASK_CANCELLED":signal.reason?.name==="TimeoutError"?"TEST_TIMEOUT":e instanceof HubError?e.code:"TEST_FAILED";
      if(current.outcomeUnknown)for(const c of selectedCases.filter((c:Json)=>!results.some(result=>result.id===c.id)))results.push({id:c.id,name:c.name,status:"NOT_RUN",errorCode:"OUTCOME_UNKNOWN",reason:"A prior dispatched live call has an unknown outcome; automatic continuation is prohibited.",assertions:c.assertions.map((assertion:Json)=>({...assertion,actual:null,passed:false,evaluated:false,errorCode:"ASSERTION_NOT_EVALUATED"})),trace:[],outputs:{},artifacts:[],events:[],executionState:null,gaps:[{code:"TEST_STOPPED_OUTCOME_UNKNOWN"}],validationLevel:current.mode,provenance:"not_executed"});
      this.repo.put("workflow_test_runs",testRunId,{...current,status:this.closing?"INTERRUPTED":cancelled?"CANCELLED":"FAILED",errorCode,cases:results,
        summary:{passed:results.filter(c=>c.status==="PASSED").length,failed:results.filter(c=>c.status==="FAILED").length,uncovered:results.filter(c=>c.status==="UNCOVERED").length,notRun:results.filter(c=>c.status==="NOT_RUN").length,total:results.length},
        gaps:[{code:errorCode}],completedAt:now(),simulationOnly:current.mode==="mock",networkCalls:current.mode==="mock"?0:null,realSecretReads:current.mode==="mock"?0:null,toolCalls:current.mode==="mock"?results.reduce((sum,c)=>sum+c.trace.length,0):current.toolCalls});
      this.repo.changed("test.completed",{testRunId,status:this.repo.get("workflow_test_runs",testRunId).status,mode:current.mode});
    }
  }
  private async case(snapshot:Json,c:Json,signal:AbortSignal,scoped?:ScopedExecution) {
    this.ensureRunning(signal);
    const draft=snapshot.draft;
    const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo);vault.initialize("Synthetic-selftest-only-password");
    const trace:Json[]=[],caseGaps:Json[]=[];let errorCode:string|null=null;let run:Json;
    const mocks={call:async(_binding:Json,node:Json,args:Json,_timeout:number,beforeDispatch:()=>void)=>{
      this.ensureRunning(signal);
      const fixture=c.mockResults.find((r:Json)=>r.nodeId===node.id);ensure(fixture,"FIXTURE_MISSING","Provide a synthetic fixture for node "+node.id);
      const tool=repo.get("connections",_binding.connectionId)?.tools?.find((item:Json)=>item.name===node.config.toolName);ensure(tool,"TOOL_NOT_ALLOWED","Fixture tool schema missing.");validate(tool.inputSchema,args);
      if(node.config.capabilityRef)ensure(fixture.capabilityId===node.config.capabilityRef.capabilityId,"FIXTURE_MISSING","Fixture capability does not match node.");
      this.ensureRunning(signal);beforeDispatch();trace.push({nodeId:node.id,arguments:clone(args),responseMode:fixture.responseMode});
      if(fixture.responseMode==="error"||fixture.responseMode==="timeout")throw new HubError(fixture.responseMode==="error"?"TOOL_FAILED":"TOOL_TIMEOUT","Synthetic failure.",422,{dispatched:true,outcomeKnown:true});
      const raw=fixture.result?.content||fixture.result?.structuredContent?fixture.result:{structuredContent:fixture.result,content:[]};
      const out=adaptMcpResult(raw,node.config.resultAdapterRef??"structured",tool.outputSchema).value;
      ensure(out.environment===undefined||out.environment===_binding.environment,"ENVIRONMENT_MISMATCH","Downstream environment evidence differs from binding.");
      if(_binding.fixtureRequiresSynthetic)ensure(out.synthetic===true,"ENVIRONMENT_MISMATCH","Synthetic binding returned non-synthetic data.");
      if(Array.isArray(out.rows))ensure(out.rowCount===out.rows.length,"OUTPUT_INVALID","Row count does not match actual rows.");
      if(node.config.resultAdapterRef||node.config.capabilityRef)Object.defineProperty(out,MCP_RAW_RESULT,{value:raw,enumerable:false});
      return out;
    }} as unknown as Connectors;
    const connectors=scoped?{call:async(binding:Json,node:Json,args:Json,timeout:number,beforeDispatch:()=>void)=>{
      const value=await scoped.call(binding,node,args,timeout,()=>{beforeDispatch();trace.push({nodeId:node.id,arguments:clone(args),provenance:"live_mcp"});});return value;
    }} as unknown as Connectors:mocks;
    const engine=new Engine(repo,vault,connectors,!scoped);
    this.activeEngines.add(engine);
    try {
      const pluginTasks = draft.nodes.filter((node: Json) => node.config.kind === "host_plugin");
      if (pluginTasks.length) {
        caseGaps.push(...pluginTasks.map((node: Json) => ({nodeId: node.id, code: "HOST_EXECUTION_UNVERIFIED"})));
        throw new HubError("FIXTURE_MISSING", "Run plugin tasks through the authorized Codex host.");
      }
      // Only contract metadata is copied; transport, endpoint and all credential references are absent.
      for(const original of snapshot.bindings) {
        const conn=snapshot.connections.find((item:Json)=>item.id===original.connectionId);
        if(scoped){repo.put("connections",conn.id,clone(conn));repo.put("bindings",original.id,clone(original));}
        else {repo.put("connections",conn.id,{id:conn.id,revision:conn.revision,synthetic:true,syntheticEvidence:true,disabled:false,tools:clone(conn.tools),verifiedSdk:"isolated-test",verifiedAt:now()});
          repo.put("bindings",original.id,{...clone(original),simulationOnly:true,validationStatus:"MOCK_VERIFIED",verification:{mode:"isolated_fixture"},connectionRevision:conn.revision});}
      }
      for(const cap of snapshot.capabilities) {
        repo.put("capability_revisions",cap.id,clone(cap));
        repo.put("capabilities",cap.capabilityId,{...clone(cap),id:cap.capabilityId});
      }
      this.ensureRunning(signal);engine.saveDraft(draft,undefined,{});engine.publish(draft.workflowId);
      const accepted=engine.start({workflowId:draft.workflowId,version:draft.version,mode:draft.mode,inputs:c.inputs,idempotencyKey:"case"});
      const deadline=scoped?scoped.deadline:Date.now()+10000;
      while(Date.now()<deadline) {
        this.ensureRunning(signal);
        run=repo.get("runs",accepted.runId);if(terminal.has(run.state))break;
        if(run.state==="WAITING_AGENT") {
          const status=engine.status(run.id),submission=c.agentSubmissions.find((s:Json)=>s.nodeId===run.checkpoint.nodeId);
          this.ensureRunning(signal);
          if(scoped){
            const node=draft.nodes.find((n:Json)=>n.id===run.checkpoint.nodeId);
            if(node.config.executorRef==="codex_host"||["host_tool","host_skill"].includes(node.config.kind)){
              errorCode="HOST_CAPABILITY_UNAVAILABLE";caseGaps.push({nodeId:node.id,code:"HOST_EXECUTION_UNVERIFIED"});break;
            }
            caseGaps.push({nodeId:node.id,code:"AGENT_EXECUTION_UNVERIFIED",provenance:"provided_agent_fixture"});
          }
          if(!submission){errorCode="FIXTURE_MISSING";break;}
          const checkpoint = status.checkpoint;
          const handoff = { runId: run.id, checkpointId: checkpoint.id, checkpointToken: checkpoint.token, expectedRevision: run.revision };
          let result: Json = { type: "agent_result", payload: submission.payload };
          if (checkpoint.requireHostReceipt) {
            const claim = engine.advance({ ...handoff, idempotencyKey: "claim-" + checkpoint.id, submission: { type: "host_tool_claim" } });
            handoff.expectedRevision = claim.acceptedRevision;
            result = { type: "host_tool_result", claimId: claim.claimId, argumentsHash: checkpoint.argumentsHash,
              capabilityId: checkpoint.capabilityRef.capabilityId, capabilityRevision: checkpoint.capabilityRef.revision,
              payload: submission.payload };
          }
          if (checkpoint.kind === "host_tool") {
            trace.push({ nodeId: checkpoint.nodeId, arguments: clone(checkpoint.resolvedArguments),
              provenance: "synthetic_host_fixture" });
          }
          engine.advance({ ...handoff, idempotencyKey: "advance-" + checkpoint.id, submission: result });
        }
        await new Promise(r=>setTimeout(r,2));
      }
      if(run&&!terminal.has(run.state)&&!errorCode)errorCode="TEST_TIMEOUT";
      errorCode??=run?.errorCode??null;
    }catch(e){errorCode=e instanceof HubError?e.code:"TEST_FAILED";}
    finally{await engine.close();this.activeEngines.delete(engine);if(run)run=repo.get("runs",run.id);}
    try {
      const outputs=run?.outputs??{},artifacts=repo.all("artifacts");
      const assertions=c.assertions.map((assertion:Json)=>{
        let actual:Json;
        const calls=trace.filter(x=>!assertion.nodeId||x.nodeId===assertion.nodeId);
        try {switch(assertion.kind){
          case "terminal_state":actual=run?.state??"VALIDATION_FAILED";break;
          case "node_state":ensure(run?.steps&&Object.hasOwn(run.steps,assertion.nodeId),"ASSERTION_VALUE_MISSING","Node state is unavailable.");actual=run.steps[assertion.nodeId];break;
          case "tool_called":actual=calls.length>0;break;
          case "tool_not_called":actual=calls.length===0;break;
          case "tool_call_count":actual=calls.length;break;
          case "argument_equals":ensure(calls.length,"ASSERTION_VALUE_MISSING","The target tool was not called.");actual=get(calls[0].arguments,assertion.pointer??"");break;
          case "output_equals":ensure(Object.hasOwn(outputs,assertion.nodeId),"ASSERTION_VALUE_MISSING","Node output is unavailable.");actual=get(outputs[assertion.nodeId],assertion.pointer??"");break;
          case "artifact_contains":actual=artifacts.some(a=>(!assertion.nodeId||a.nodeId===assertion.nodeId)&&String(a.content??"").includes(String(assertion.expected)));return {...assertion,actual,passed:actual===true};
          case "error_code":actual=errorCode;break;
          default:throw new HubError("ASSERTION_INVALID","Unknown assertion kind.");
        }
        ensure(actual!==undefined,"ASSERTION_VALUE_MISSING","Assertion value is unavailable.");
        }catch(error){return {...assertion,actual:null,passed:false,evaluated:false,errorCode:error instanceof HubError?error.code:"ASSERTION_EVALUATION_FAILED"};}
        return {...assertion,actual,passed:hash([actual])===hash([assertion.expected])};
      });
      const expectedValidation=c.expectedValidationErrors.length?c.expectedValidationErrors.includes(errorCode):!errorCode||c.assertions.some((a:Json)=>a.kind==="error_code"&&a.expected===errorCode);
      return {id:c.id,name:c.name,status:errorCode==="TASK_INTERRUPTED"?"INTERRUPTED":errorCode==="FIXTURE_MISSING"?"UNCOVERED":assertions.every((a:Json)=>a.passed)&&expectedValidation?"PASSED":"FAILED",assertions,errorCode,trace,outputs,artifacts,events:run?repo.events(run.id,0,200):[],provenance:scoped?"scoped_live_mcp":"synthetic_fixture",validationLevel:scoped?"live":"mock",gaps:caseGaps,executionState:run?.state??null};
    }finally{db.close();}
  }
  cancel(testRunId:string,owner="admin") {
    const status=this.status(testRunId,owner);if(status.kind==="generation")return this.ai!.cancel(testRunId,owner);
    const run=this.repo.get("workflow_test_runs",testRunId);
    if(["QUEUED","RUNNING"].includes(run.status)) {
      this.repo.put("workflow_test_runs",run.id,{...run,cancelRequested:true});
      this.controls.get(run.id)?.abort(new HubError("TASK_CANCELLED","Test cancellation requested; dispatched remote outcomes may be unknown."));
    }
    return this.status(testRunId,owner);
  }
  async idle(){await Promise.allSettled([...this.jobs.values(),...(this.ai?[this.ai.idle()]:[])]);}
  close(){
    if(this.closingPromise)return this.closingPromise;
    this.closing=true;
    for(const controller of this.controls.values())controller.abort();
    const aiClose=this.ai?.close();
    this.closingPromise=(async()=>{await Promise.allSettled([...this.activeEngines].map(engine=>engine.close()));await aiClose;await this.idle();})();
    return this.closingPromise;
  }
}
