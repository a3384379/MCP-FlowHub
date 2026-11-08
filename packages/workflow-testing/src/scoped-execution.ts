import {clone,ensure,hash,HubError,id,now,type Json} from "../../contracts/src/domain.js";
import type {AuthoringService} from "../../workflow-authoring/src/index.js";
import {connectionBaseline} from "./execution-baseline.js";

/** An explicit, immutable test scope. It grants no new connection or workflow permissions. */
export class ScopedExecution {
  readonly deadline:number;
  constructor(readonly authoring:AuthoringService,readonly testRunId:string,readonly accepted:Json,readonly snapshot:Json,readonly signal:AbortSignal) {
    this.deadline=Date.parse(accepted.createdAt)+accepted.scope.budgets.timeoutMs;
  }
  get repo(){return this.authoring.repo;}
  guard(bindingId?:string) {
    ensure(!this.signal.aborted,"TASK_CANCELLED","Test cancellation requested.");
    ensure(Date.now()<this.deadline,"TEST_TIMEOUT","The explicit test deadline expired.");
    this.authoring.authorize(this.accepted.owner,this.accepted.workflowId);
    const workflow=this.repo.get("workflows",this.accepted.workflowId);
    ensure(workflow&&!workflow.deletedAt&&workflow.revision===this.accepted.draftRevision,"TEST_BASELINE_STALE","The tested workflow changed.",409);
    for(const ref of this.snapshot.capabilities) {
      const cap=this.repo.get("capabilities",ref.capabilityId);
      ensure(cap&&!cap.stale&&cap.revision===(ref.capabilityRevision??ref.revision),"CAPABILITY_STALE","Test capability changed.",409);
    }
    for(const [key,value] of Object.entries(this.snapshot.authorization.bindings)) {const binding=this.repo.get("bindings",key);ensure(binding&&hash(binding)===value,"TEST_BASELINE_STALE","Test binding changed.",409);}
    for(const [key,value] of Object.entries(this.snapshot.authorization.connections))ensure(connectionBaseline(this.repo.get("connections",key))===value,"TEST_BASELINE_STALE","Test connection changed.",409);
    const current=this.repo.get("workflow_test_runs",this.testRunId);
    ensure(current&&!current.cancelRequested&&!current.resultsExpiredAt,"TASK_CANCELLED","The test stopped or expired.");
    ensure(!current.outcomeUnknown,"OUTCOME_UNKNOWN","A dispatched test call has an unknown outcome; no later call may be dispatched.");
    if(bindingId)ensure(this.accepted.scope.allowedBindingIds.includes(bindingId),"TEST_SCOPE_VIOLATION","This binding is outside the selected test scope.");
  }
  private usage(key:"toolCalls"|"catalogChecks") {
    this.guard();
    const current=this.repo.get("workflow_test_runs",this.testRunId),count=current[key]??0;
    ensure(count<this.accepted.scope.budgets.maxCalls,"BUDGET_EXCEEDED","The explicit test call budget is exhausted.");
    this.repo.put("workflow_test_runs",this.testRunId,{...current,[key]:count+1});
  }
  async catalogs() {
    const schemaChecks:Json[]=[];const visited=new Set<string>();
    for(const bindingId of this.accepted.scope.allowedBindingIds) {
      this.guard(bindingId);
      const binding=this.snapshot.bindings.find((b:Json)=>b.id===bindingId),connection=this.repo.get("connections",binding.connectionId);
      ensure(connection&&!connection.disabled&&binding.validationStatus!=="REVOKED","BINDING_REVOKED","Selected connection or binding revoked.");
      let catalog:Json;
      if(visited.has(connection.id))catalog=schemaChecks.find(c=>c.connectionId===connection.id)?.catalog;
      else {
        this.usage("catalogChecks");
        const discovered=await this.authoring.engine.connectors.discover(connection,{signal:this.signal,deadline:this.deadline,timeoutMs:Math.max(1,this.deadline-Date.now())});
        this.guard(bindingId);catalog=discovered.tools;visited.add(connection.id);
      }
      for(const node of this.snapshot.draft.nodes.filter((n:Json)=>n.type==="mcp_tool"&&this.snapshot.draft.bindings[n.config.bindingKey]===bindingId)) {
        const actual=catalog.find((t:Json)=>t.name===node.config.toolName);
        ensure(binding.allowedTools.includes(node.config.toolName),"TOOL_NOT_ALLOWED","The binding does not allow this tool.");
        schemaChecks.push({bindingId,connectionId:connection.id,nodeId:node.id,toolName:node.config.toolName,expectedSchemaHash:node.config.toolSchemaHash,actualSchemaHash:actual?.schemaHash??null,
          passed:!!actual&&actual.schemaHash===node.config.toolSchemaHash,catalog});
      }
    }
    this.guard();
    // Catalog schemas are evidence, not a binding verification or an execution result.
    return schemaChecks.map(({catalog,...check})=>check);
  }
  async call(binding:Json,node:Json,args:Json,timeout:number,beforeDispatch:()=>void) {
    this.guard(binding.id);
    ensure(!this.authoring.engine.vault.locked,"CREDENTIAL_LOCKED","Unlock the vault before live execution.",423);
    const frozen=this.snapshot.bindings.find((b:Json)=>b.id===binding.id);
    ensure(frozen&&hash(frozen)===hash(binding),"TEST_SCOPE_VIOLATION","The executed binding differs from the accepted scope.");
    ensure((this.repo.get("workflow_test_runs",this.testRunId).toolCalls??0)<this.accepted.scope.budgets.maxCalls,"BUDGET_EXCEEDED","The explicit test call budget is exhausted before connection preparation.");
    const effective=Math.min(timeout,Math.max(1,this.deadline-Date.now()));
    const dispatchId=id("test_dispatch");let dispatched=false,outcomeKnown=false;
    try{return await this.authoring.engine.connectors.call(binding,node,args,effective,()=>{
      this.repo.tx(()=>{this.guard(binding.id);ensure(!this.authoring.engine.vault.locked,"CREDENTIAL_LOCKED","Vault locked before dispatch.",423);this.usage("toolCalls");beforeDispatch();
        const current=this.repo.get("workflow_test_runs",this.testRunId);
        this.repo.put("workflow_test_runs",this.testRunId,{...current,pendingDispatches:[...new Set([...(current.pendingDispatches??[]),dispatchId])]});dispatched=true;
        this.repo.changed("test.tool.dispatched",{testRunId:this.testRunId,nodeId:node.id,bindingId:binding.id,at:now()});});
    },{signal:this.signal}).then(value=>{outcomeKnown=true;return value;});}
    catch(error){if(error instanceof HubError&&(error.details?.outcomeKnown===true||error.details?.dispatched===false))outcomeKnown=true;throw error;}
    finally{if(dispatched){const current=this.repo.get("workflow_test_runs",this.testRunId);
      this.repo.put("workflow_test_runs",this.testRunId,{...current,pendingDispatches:(current.pendingDispatches??[]).filter((value:string)=>value!==dispatchId),outcomeUnknown:current.outcomeUnknown||!outcomeKnown});}}
  }
}

export function validateScope(request:Json,suite:Json,snapshot:Json) {
  if(request.mode==="mock") {
    ensure(request.allowedBindingIds===undefined&&request.inputScope===undefined&&request.budgets===undefined,"INPUT_INVALID","Mock does not accept live or contract scope fields.");
    return null;
  }
  const bindingIds=new Set(snapshot.draft.nodes.filter((n:Json)=>n.type==="mcp_tool").map((n:Json)=>snapshot.draft.bindings[n.config.bindingKey]));
  ensure(request.allowedBindingIds?.length&&request.allowedBindingIds.every((value:string)=>bindingIds.has(value)),"TEST_SCOPE_VIOLATION","Select bindings used by MCP nodes in this draft.");
  ensure(request.budgets&&Number.isSafeInteger(request.budgets.maxCalls)&&Number.isSafeInteger(request.budgets.timeoutMs),"INPUT_INVALID","Explicit test budgets are required.");
  if(request.mode==="live") {
    const chosen=suite.cases.filter((c:Json)=>!request.caseIds||request.caseIds.includes(c.id)),scope=request.inputScope;
    ensure(scope&&scope.fixtureHash===suite.fixtureHash&&scope.caseInputs.length===chosen.length&&new Set(scope.caseInputs.map((c:Json)=>c.caseId)).size===chosen.length,
      "TEST_SCOPE_VIOLATION","Live input scope must match the selected suite baseline.");
    ensure(chosen.every((c:Json)=>scope.caseInputs.some((input:Json)=>input.caseId===c.id&&hash(input.inputs)===hash(c.inputs))),"TEST_SCOPE_VIOLATION","Live input values must match the reviewed cases exactly.");
  } else ensure(request.inputScope===undefined,"INPUT_INVALID","Contract checks do not consume business inputs.");
  return {allowedBindingIds:clone(request.allowedBindingIds),budgets:clone(request.budgets),...(request.mode==="live"?{inputScope:clone(request.inputScope)}:{})};
}
