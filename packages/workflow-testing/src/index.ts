import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoot } from "../../contracts/src/index.js";
import { clone, hash, id, now, ensure, validate, get, HubError, type Json } from "../../contracts/src/domain.js";
import { Repository } from "../../persistence/src/repository.js";
import { Vault } from "../../security/src/index.js";
import { Engine } from "../../workflow-core/src/engine.js";
import type { Connectors } from "../../mcp-connectors/src/registry.js";
import type { AuthoringService } from "../../workflow-authoring/src/index.js";
import { adaptMcpResult } from "../../mcp-connectors/src/results.js";
const suiteSchema=JSON.parse(readFileSync(resolve(projectRoot,"contracts/test-suite.schema.json"),"utf8"));
const terminal=new Set(["SUCCEEDED","FAILED","CANCELLED","OUTCOME_UNKNOWN","BLOCKED"]);
const sample=(schema:Json):Json=>schema.examples?.[0]??schema.default??schema.const??schema.enum?.[0]??
  (schema.type==="object"?Object.fromEntries(Object.entries(schema.properties??{}).filter(([k])=>(schema.required??[]).includes(k)).map(([k,v])=>[k,sample(v)])):
    schema.type==="array"?[]:schema.type==="string"?(schema.format==="date-time"?"2026-10-31T00:00:00Z":"synthetic"):
      schema.type==="boolean"?false:schema.type==="number"||schema.type==="integer"?schema.minimum??0:null);
export class WorkflowTesting {
  private jobs=new Map<string,Promise<void>>();
  constructor(readonly authoring:AuthoringService) {
    for(const run of this.repo.all("workflow_test_runs"))if(!["SUCCEEDED","FAILED","PARTIAL","INTERRUPTED"].includes(run.status))
      this.repo.put("workflow_test_runs",run.id,{...run,status:"INTERRUPTED",gaps:[...(run.gaps??[]),"TASK_INTERRUPTED"]});
  }
  get repo(){return this.authoring.repo;}
  generate(a:Json,owner="admin") {
    const record=this.authoring.get(a.workflowId,owner);
    ensure(record.revision===a.expectedRevision,"REVISION_CONFLICT","Draft changed.",409);
    ensure(a.strategy!=="ai_assisted","MODEL_NOT_CONFIGURED","Use a configured assistant to propose cases, or agent_proposed without a Key.");
    return this.repo.command(owner,"test.generate",a.idempotencyKey,a,()=>{
      let cases:Json[]=a.proposedCases;
      if(a.strategy==="agent_proposed")ensure(Array.isArray(cases)&&cases.length,"INPUT_INVALID","Proposed test cases required.");
      else {
        const inputSchema=record.draft.inputSchema,inputs=sample(inputSchema);
        cases=[{id:"normal",name:"正常数据流",inputs,mockResults:[],agentSubmissions:[],assertions:[{kind:"terminal_state",expected:"SUCCEEDED"}],expectedValidationErrors:[]}];
        for(const key of inputSchema.required??[]) {
          const missing=clone(inputs);delete missing[key];
          cases.push({id:"missing-"+key,name:"缺少必填 "+key,inputs:missing,mockResults:[],agentSubmissions:[],assertions:[{kind:"error_code",expected:"INPUT_INVALID"}],expectedValidationErrors:["INPUT_INVALID"]});
        }
        for(const key of inputSchema.required??[])if(inputSchema.properties?.[key]?.type==="string") {
          cases.push({id:"type-"+key,name:"类型错误 "+key,inputs:{...inputs,[key]:42},mockResults:[],agentSubmissions:[],assertions:[{kind:"error_code",expected:"INPUT_INVALID"}],expectedValidationErrors:["INPUT_INVALID"]});
        }
      }
      const base=a.baseSuiteId?this.repo.get("workflow_test_suites",a.baseSuiteId):null;
      ensure(!a.baseSuiteId||(base&&base.owner===owner&&base.suiteRevision===a.expectedSuiteRevision&&base.workflowId===a.workflowId),"REVISION_CONFLICT","Test suite changed.",409);
      const suiteId=base?.id??id("suite"),suite={id:suiteId,workflowId:a.workflowId,draftRevision:a.expectedRevision,suiteRevision:(base?.suiteRevision??0)+1,
        capabilityRevisions:Object.fromEntries(record.capabilityRefs.map((c:Json)=>[c.capabilityId,c.revision])),fixtureHash:"sha256:"+hash(cases),generatedBy:a.strategy,mode:"mock",cases};
      validate(suiteSchema,suite);
      ensure(new Set(cases.map(c=>c.id)).size===cases.length,"INPUT_INVALID","Duplicate test case IDs.");
      this.repo.put("workflow_test_suites",suiteId,{...suite,owner,revision:suite.suiteRevision,createdAt:base?.createdAt??now(),updatedAt:now()});
      return {suiteId,suiteRevision:suite.suiteRevision,caseCount:cases.length,gaps:this.gaps(record.draft,cases)};
    });
  }
  private gaps(workflow:Json,cases:Json[]) {
    return workflow.nodes.filter((n:Json)=>n.type==="mcp_tool"||n.type==="agent_task").flatMap((n:Json)=>cases.filter(c=>!c.expectedValidationErrors.length&&
      !(n.type==="mcp_tool"?c.mockResults:c.agentSubmissions).some((r:Json)=>r.nodeId===n.id)).map(c=>({caseId:c.id,nodeId:n.id,code:"FIXTURE_MISSING"})));
  }
  getSuite(suiteId:string,owner="admin") {
    const suite=this.repo.get("workflow_test_suites",suiteId);ensure(suite&&(owner==="admin"||suite.owner===owner),"NOT_FOUND","Test suite missing.",404);
    this.authoring.authorize(owner,suite.workflowId);return suite;
  }
  run(a:Json,owner="admin") {
    const suite=this.getSuite(a.suiteId,owner);
    ensure(suite.suiteRevision===a.expectedSuiteRevision,"REVISION_CONFLICT","Suite changed.",409);
    ensure(a.mode==="mock","TEST_MODE_UNSUPPORTED","Only isolated mock execution is supported; no implicit live fallback.");
    ensure(!a.caseIds || (Array.isArray(a.caseIds)&&a.caseIds.length>0&&new Set(a.caseIds).size===a.caseIds.length&&a.caseIds.every((key:string)=>suite.cases.some((c:Json)=>c.id===key))),"INPUT_INVALID","Select existing, unique test case IDs.");
    this.assertBaseline(suite);
    const accepted=this.repo.command(owner,"test.run",a.idempotencyKey,a,()=>{
      const testRunId=id("test");this.repo.insert("workflow_test_runs",testRunId,{id:testRunId,suiteId:suite.id,owner,mode:"mock",status:"QUEUED",cases:[],gaps:[],createdAt:now(),draftRevision:suite.draftRevision,fixtureHash:suite.fixtureHash,suiteRevision:suite.suiteRevision});return {testRunId,status:"QUEUED"};
    });
    if(this.repo.get("workflow_test_runs",accepted.testRunId).status==="QUEUED"&&!this.jobs.has(accepted.testRunId)) {
      const work=this.perform(accepted.testRunId,clone(suite),a.caseIds).finally(()=>this.jobs.delete(accepted.testRunId));this.jobs.set(accepted.testRunId,work);
    }
    return accepted;
  }
  private assertBaseline(suite:Json) {
    ensure(this.repo.get("workflows",suite.workflowId)?.revision===suite.draftRevision&&Object.entries(suite.capabilityRevisions).every(([key,rev])=>this.repo.get("capabilities",key)?.revision===rev),"TEST_BASELINE_STALE","Draft or capabilities changed; regenerate tests.",409);
  }
  status(testRunId:string,owner="admin") {
    const run=this.repo.get("workflow_test_runs",testRunId);ensure(run&&(owner==="admin"||run.owner===owner),"NOT_FOUND","Test run missing.",404);
    const suite=this.getSuite(run.suiteId,owner);let stale=false;try{this.assertBaseline(suite);stale=suite.fixtureHash!==run.fixtureHash;}catch{stale=true;}
    return {...run,stale};
  }
  private async perform(testRunId:string,suite:Json,caseIds?:string[]) {
    const results:Json[]=[];
    try {
      const draft=clone(this.repo.get("workflows",suite.workflowId).draft);
      for(const c of suite.cases.filter((item:Json)=>!caseIds||caseIds.includes(item.id))) {
        const result=await this.case(draft,c);results.push(result);
        this.repo.put("workflow_test_runs",testRunId,{...this.repo.get("workflow_test_runs",testRunId),status:"RUNNING",cases:results});
        this.repo.changed("test.progress",{testRunId,caseId:c.id,status:result.status});
      }
      const gaps=results.filter(c=>c.status==="UNCOVERED").map(c=>({caseId:c.id,code:"FIXTURE_MISSING"}));
      const summary={passed:results.filter(c=>c.status==="PASSED").length,failed:results.filter(c=>c.status==="FAILED").length,uncovered:gaps.length,total:results.length};
      this.repo.put("workflow_test_runs",testRunId,{...this.repo.get("workflow_test_runs",testRunId),status:summary.failed?"FAILED":gaps.length?"PARTIAL":"SUCCEEDED",summary,gaps,completedAt:now(),simulationOnly:true,networkCalls:0,realSecretReads:0,
        branchCoverage:draft.nodes.filter((n:Json)=>n.type==="condition").map((n:Json)=>({nodeId:n.id,true:results.some(r=>r.outputs?.[n.id]===true),false:results.some(r=>r.outputs?.[n.id]===false)}))});
    }catch(e){this.repo.put("workflow_test_runs",testRunId,{...this.repo.get("workflow_test_runs",testRunId),status:"FAILED",errorCode:e instanceof HubError?e.code:"TEST_FAILED",cases:results});}
  }
  private async case(draft:Json,c:Json) {
    const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo);vault.initialize("Synthetic-selftest-only-password");
    const trace:Json[]=[];let errorCode:string|null=null;let run:Json;
    const mocks={call:async(_binding:Json,node:Json,args:Json,_timeout:number,beforeDispatch:()=>void)=>{
      const fixture=c.mockResults.find((r:Json)=>r.nodeId===node.id);ensure(fixture,"FIXTURE_MISSING","Provide a synthetic fixture for node "+node.id);
      if(node.config.capabilityRef)ensure(fixture.capabilityId===node.config.capabilityRef.capabilityId,"FIXTURE_MISSING","Fixture capability does not match node.");
      beforeDispatch();trace.push({nodeId:node.id,arguments:clone(args),responseMode:fixture.responseMode});
      if(fixture.responseMode==="error"||fixture.responseMode==="timeout")throw new HubError(fixture.responseMode==="error"?"TOOL_FAILED":"TOOL_TIMEOUT","Synthetic failure.",422,{dispatched:true,outcomeKnown:true});
      const raw=fixture.result?.content||fixture.result?.structuredContent?fixture.result:{structuredContent:fixture.result,content:[]};
      return adaptMcpResult(raw,fixture.responseMode==="text"?node.config.resultAdapterRef??"text":"structured").value;
    }} as unknown as Connectors;
    const engine=new Engine(repo,vault,mocks);
    try {
      // Only contract metadata is copied; transport, endpoint and all credential references are absent.
      for(const bindingId of Object.values(draft.bindings) as string[]) {
        const original=this.repo.get("bindings",bindingId);ensure(original,"BINDING_UNVERIFIED","Test binding missing.");
        const conn=this.repo.get("connections",original.connectionId);ensure(conn,"BINDING_UNVERIFIED","Test connection missing.");
        repo.put("connections",conn.id,{id:conn.id,revision:conn.revision,synthetic:true,syntheticEvidence:true,disabled:false,tools:clone(conn.tools),verifiedSdk:"isolated-test",verifiedAt:now()});
        repo.put("bindings",bindingId,{...clone(original),simulationOnly:true,validationStatus:"MOCK_VERIFIED",verification:{mode:"isolated_fixture"},connectionRevision:conn.revision});
      }
      engine.saveDraft(draft,undefined,{});engine.publish(draft.workflowId);
      const accepted=engine.start({workflowId:draft.workflowId,version:draft.version,mode:draft.mode,inputs:c.inputs,idempotencyKey:"case"});
      const deadline=Date.now()+10000;
      while(Date.now()<deadline) {
        run=repo.get("runs",accepted.runId);if(terminal.has(run.state))break;
        if(run.state==="WAITING_AGENT") {
          const status=engine.status(run.id),submission=c.agentSubmissions.find((s:Json)=>s.nodeId===run.checkpoint.nodeId);
          if(!submission){errorCode="FIXTURE_MISSING";break;}
          engine.advance({runId:run.id,checkpointId:run.checkpoint.id,checkpointToken:status.checkpoint.token,expectedRevision:run.revision,idempotencyKey:"advance-"+run.checkpoint.nodeId,submission:{type:"agent_result",payload:submission.payload}});
        }
        await new Promise(r=>setTimeout(r,2));
      }
      if(run&&!terminal.has(run.state)&&!errorCode)errorCode="TEST_TIMEOUT";
      errorCode??=run?.errorCode??null;
    }catch(e){errorCode=e instanceof HubError?e.code:"TEST_FAILED";}
    finally{await engine.close();}
    try {
      const outputs=run?.outputs??{},artifacts=repo.all("artifacts");
      const assertions=c.assertions.map((assertion:Json)=>{
        let actual:Json;
        const calls=trace.filter(x=>!assertion.nodeId||x.nodeId===assertion.nodeId);
        try {switch(assertion.kind){
          case "terminal_state":actual=run?.state??"VALIDATION_FAILED";break;
          case "node_state":actual=run?.steps?.[assertion.nodeId]??null;break;
          case "tool_called":actual=calls.length>0;break;
          case "tool_not_called":actual=calls.length===0;break;
          case "tool_call_count":actual=calls.length;break;
          case "argument_equals":actual=calls.length?get(calls[0].arguments,assertion.pointer??""):null;break;
          case "output_equals":actual=get(outputs[assertion.nodeId],assertion.pointer??"");break;
          case "artifact_contains":actual=artifacts.some(a=>(!assertion.nodeId||a.nodeId===assertion.nodeId)&&String(a.content??"").includes(String(assertion.expected)));return {...assertion,actual,passed:actual===true};
          case "error_code":actual=errorCode;break;
          default:actual=null;
        }}catch{actual=null;}
        return {...assertion,actual,passed:hash([actual])===hash([assertion.expected])};
      });
      const expectedValidation=c.expectedValidationErrors.length?c.expectedValidationErrors.includes(errorCode):!errorCode||c.assertions.some((a:Json)=>a.kind==="error_code"&&a.expected===errorCode);
      return {id:c.id,name:c.name,status:errorCode==="FIXTURE_MISSING"?"UNCOVERED":assertions.every((a:Json)=>a.passed)&&expectedValidation?"PASSED":"FAILED",assertions,errorCode,trace,outputs,artifacts,events:run?repo.events(run.id,0,200):[],provenance:"synthetic_fixture"};
    }finally{db.close();}
  }
  async close(){await Promise.allSettled(this.jobs.values());}
}
