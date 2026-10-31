import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoot } from "../../contracts/src/index.js";
import { clone, ensure, hash, id, now, validate, workflowSchema, HubError, type Json, type Workflow } from "../../contracts/src/domain.js";
import type { Engine } from "../../workflow-core/src/engine.js";

const batchSchema = JSON.parse(readFileSync(resolve(projectRoot,"contracts/authoring-batch.schema.json"),"utf8"));
const refs = (w: Workflow): Json[] => w.nodes.flatMap(n => n.config.capabilityRef ? [n.config.capabilityRef] : []);
const mentions = (value: Json, nodeId: string): boolean => !!value && typeof value === "object" &&
  (value.ref?.nodeId === nodeId || (!Object.hasOwn(value,"value") && Object.values(value).some(v => mentions(v,nodeId))));

/** All entry points share this application service; only the daemon owns its repository. */
export class AuthoringService {
  constructor(readonly engine: Engine) {}
  get repo() { return this.engine.repo; }
  authorize(owner: string, workflowId?: string) {
    if (owner === "admin" || owner === "execution") return;
    const c = this.repo.get("clients",owner);
    ensure(c && !c.revoked && c.scopes?.includes("workflow:author") && (!workflowId || c.workflowAllowlist.includes(workflowId)),
      "AUTH_REQUIRED","This identity cannot author the requested workflow.",403);
  }
  get(workflowId: string, owner = "admin") {
    this.authorize(owner, workflowId);
    const record = this.repo.get("workflows",workflowId);
    ensure(record,"NOT_FOUND","Workflow missing.",404);
    return {...record, workflow:record.draft, layoutRevision:record.layoutRevision ?? 1,
      capabilityRefs:refs(record.draft), issues:this.issues(record.draft)};
  }
  issues(w: Workflow) {
    const issues:Json[]=[];
    try { this.engine.validateDraft(w); }
    catch (error) { const e = error as HubError; issues.push(...(e.details?.issues ?? [{code:e.code ?? "INPUT_INVALID",message:e.message}])); }
    for(const n of w.nodes) if(n.config.capabilityRef) {
      const ref=n.config.capabilityRef,cap=this.repo.get("capabilities",ref.capabilityId);
      if(!cap || cap.stale || cap.revision!==ref.revision ||
        (n.type==="mcp_tool" && (cap.name!==n.config.toolName || cap.tool?.schemaHash!==n.config.toolSchemaHash)))
        issues.push({code:"CAPABILITY_STALE",message:"Capability and node definition differ.",nodeId:n.id});
      if(n.config.kind==="host_tool"&&(!cap||cap.kind!=="mcp_tool"||cap.executor!=="codex_host"||!cap.inputSchema||!cap.outputSchema))
        issues.push({code:"HOST_CAPABILITY_UNAVAILABLE",message:"Host tool requires a discovered input/output contract.",nodeId:n.id});
    }
    return issues;
  }
  create(a: Json, owner = "admin") {
    this.authorize(owner);
    validate({type:"object",required:["name","environment","mode","template","idempotencyKey"],properties:{
      workflowId:{type:"string",pattern:"^[a-z][a-z0-9_-]{0,63}$"},name:{type:"string",minLength:1,maxLength:160},
      environment:{enum:["production","staging","test"]},mode:{enum:["guided","auto"]},template:{enum:["blank","incident"]},
      contextId:{type:"string"},idempotencyKey:{type:"string",minLength:1,maxLength:256}},additionalProperties:false},a);
    return this.repo.command(owner,"draft.create",a.idempotencyKey,a,() => {
      const workflowId = a.workflowId ?? id("workflow");
      ensure(!this.repo.get("workflows",workflowId),"VERSION_MISMATCH","Workflow already exists.",409);
      let w: Workflow;
      if (a.template === "incident") {
        w=clone(this.repo.get("workflows","incident-staging").draft);
        w.bindings={}; // Never silently bind production to a staging template.
      } else w={schemaVersion:"flowhub.workflow/v2",workflowId,name:a.name,description:"FlowHub workflow",version:"1.0.0",
        environment:a.environment,mode:a.mode,tags:[],inputSchema:{type:"object",properties:{},additionalProperties:false},bindings:{},
        nodes:[{id:"input",title:"输入",type:"input",config:{}},{id:"end",title:"结束",type:"end",config:{resultRef:{ref:{source:"input",pointer:""}}}}],
        edges:[{source:"input",target:"end",port:"next"}],budgets:{maxRunSeconds:60,maxToolCalls:20,maxNodeExecutions:100,maxAgentCheckpoints:10,maxOutputBytes:262144,maxRows:100,maxToolSeconds:10,maxRetries:0}};
      Object.assign(w,{schemaVersion:"flowhub.workflow/v2",workflowId,name:a.name,environment:a.environment,mode:a.mode});
      this.saveRaw(w,undefined,{});
      const record=this.repo.get("workflows",workflowId);
      this.repo.put("workflows",workflowId,{...record,createdBy:owner,layoutRevision:1});
      if (!["admin","execution"].includes(owner)) {
        const c=this.repo.get("clients",owner);
        this.repo.put("clients",owner,{...c,workflowAllowlist:[...c.workflowAllowlist,workflowId],revision:c.revision+1},c.revision);
      }
      this.repo.changed("draft.changed",{workflowId,revision:1,changedNodes:w.nodes.map(n=>n.id)});
      return {workflowId,revision:1,layoutRevision:1,issues:this.issues(w)};
    });
  }
  saveRaw(w: Workflow, expected: number | undefined, layout: Json) {
    return this.repo.tx(() => {
      const before=this.repo.get("workflows",w.workflowId);
      const saved=this.engine.saveDraft(w,expected,layout);
      const next={...saved,createdBy:before?.createdBy ?? "admin",layoutRevision:(before?.layoutRevision ?? 1)+(before && hash(before.layout)!==hash(layout) ? 1:0)};
      this.repo.put("workflows",w.workflowId,next,saved.revision);
      this.repo.changed("draft.changed",{workflowId:w.workflowId,revision:next.revision});
      return next;
    });
  }
  patch(a: Json, owner = "admin") {
    validate(batchSchema,a);
    this.authorize(owner,a.workflowId);
    return this.repo.command(owner,"draft.patch",a.idempotencyKey,a,()=> {
      const before=this.get(a.workflowId,owner), w=clone(before.draft) as Workflow, layout=clone(before.layout);
      const layoutOnly=a.operations.every((o:Json)=>o.op==="move_nodes");
      ensure(layoutOnly || a.expectedRevision===before.revision,"REVISION_CONFLICT","Draft changed. Reload before patching.",409);
      let layoutRevision=before.layoutRevision;
      const changed=new Set<string>();
      for (const op of a.operations) {
        const node=w.nodes.find(n=>n.id===op.nodeId);
        if (["remove_node","update_node","set_mapping","set_output_schema","set_condition"].includes(op.op))
          ensure(node,"NOT_FOUND","Node does not exist: "+op.nodeId,404);
        switch(op.op) {
          case "add_node": {
            ensure(!node,"GRAPH_INVALID","Duplicate node ID.");
            const config=clone(op.config);
            if (op.capabilityRef) {
              const cap=this.repo.get("capabilities",op.capabilityRef.capabilityId);
              ensure(cap && cap.revision===op.capabilityRef.revision && !cap.stale,"CAPABILITY_STALE","Capability changed.",409);
              config.capabilityRef=clone(op.capabilityRef);
              if(op.nodeType==="mcp_tool") {
                ensure(cap.executor==="hub_direct" && cap.tool,"HOST_ONLY","An independently connected tool is required.");
                config.toolName=cap.name; config.toolSchemaHash=cap.tool.schemaHash;
              }
            }
            w.nodes.push({id:op.nodeId,type:op.nodeType,title:op.title,config});
            layout[op.nodeId]={x:400,y:w.nodes.length*140}; changed.add(op.nodeId); break;
          }
          case "remove_node": {
            ensure(!["input","end"].includes(node!.type),"GRAPH_INVALID","Input and end are protected.");
            const remove=new Set<string>([op.nodeId]);
            let added=true;
            while(added) { added=false; for(const n of w.nodes) if(!remove.has(n.id) && [...remove].some(key=>mentions(n.config,key))) {
              ensure(op.cascade,"REFERENCE_IN_USE","A remaining node references this node.",409);
              ensure(!["input","end"].includes(n.type),"REFERENCE_IN_USE","Update the protected end reference before removal.",409);
              remove.add(n.id); added=true;
            } }
            w.nodes=w.nodes.filter(n=>!remove.has(n.id)); w.edges=w.edges.filter(e=>!remove.has(e.source)&&!remove.has(e.target));
            for(const key of remove){delete layout[key];changed.add(key);} break;
          }
          case "update_node": Object.assign(node!,clone(op.changes)); changed.add(node!.id); break;
          case "connect": ensure(w.nodes.some(n=>n.id===op.source)&&w.nodes.some(n=>n.id===op.target),"GRAPH_INVALID","Unknown edge endpoint.");
            ensure(!w.edges.some(e=>e.source===op.source&&e.target===op.target&&e.port===op.port),"GRAPH_INVALID","Duplicate edge.");
            w.edges.push({source:op.source,target:op.target,port:op.port}); changed.add(op.source); break;
          case "disconnect": w.edges=w.edges.filter(e=>!(e.source===op.source&&e.target===op.target&&e.port===op.port)); changed.add(op.source); break;
          case "set_mapping": node!.config[op.section] ??= {}; node!.config[op.section][op.destination]=clone(op.expression);changed.add(node!.id);break;
          case "set_binding": {
            const binding=this.repo.get("bindings",op.bindingId);
            ensure(binding && binding.environment===w.environment,"ENVIRONMENT_OVERRIDE_DENIED","Binding must belong to the fixed environment.");
            w.bindings[op.key]=op.bindingId; break;
          }
          case "set_input_schema": w.inputSchema=clone(op.schema);break;
          case "set_output_schema": node!.config.outputSchema=clone(op.schema);changed.add(node!.id);break;
          case "set_condition": ensure(node!.type==="condition","INPUT_INVALID","Condition node required.");node!.config.expression=clone(op.expression);changed.add(node!.id);break;
          case "set_metadata": Object.assign(w,clone(op.changes));break;
          case "move_nodes": ensure(op.expectedLayoutRevision===layoutRevision,"REVISION_CONFLICT","Layout changed.",409);
            for(const pos of op.positions) {ensure(w.nodes.some(n=>n.id===pos.nodeId),"NOT_FOUND","Layout node missing.");layout[pos.nodeId]={x:pos.x,y:pos.y};}layoutRevision++;break;
          default: throw new HubError("INPUT_INVALID","Unknown operation.");
        }
      }
      if(w.schemaVersion==="flowhub.workflow/v2") w.executionRequirements={
        requiresCodex:w.nodes.some(n=>n.type==="agent_task" && (n.config.executorRef==="codex_host" || ["host_tool","host_skill"].includes(n.config.kind))),
        executors:[...new Set(w.nodes.map(n=>n.type==="mcp_tool"?"hub_direct":n.type==="agent_task"?(n.config.executorRef??"codex_host"):null).filter(Boolean))],
        capabilityRefs:refs(w),
      };
      validate(workflowSchema,w); // Incomplete graphs may persist; illegal DSL/config never does.
      const revision=before.revision+(layoutOnly?0:1);
      const record={...before,draft:w,workflow:undefined,issues:undefined,capabilityRefs:undefined,name:w.name,description:w.description,tags:w.tags,layout,layoutRevision,revision,updatedAt:now()};
      delete record.workflow;delete record.issues;delete record.capabilityRefs;
      this.repo.put("workflows",a.workflowId,record,before.revision);
      const commandId=id("authoring");
      this.repo.insert("authoring_commands",commandId,{id:commandId,owner,operation:"patch",idempotencyKey:a.idempotencyKey,workflowId:a.workflowId,
        beforeRevision:before.revision,afterRevision:revision,beforeDraft:before.draft,afterDraft:w,beforeLayout:before.layout,afterLayout:layout,createdAt:now()});
      const event=this.repo.changed("draft.changed",{workflowId:a.workflowId,revision,layoutRevision,changedNodes:[...changed],commandId});
      return {workflowId:a.workflowId,newRevision:revision,revision,layoutRevision,changedNodes:[...changed],issues:this.issues(w),commandId,event};
    });
  }
  validate(a: Json, owner="admin") {
    const record=this.get(a.workflowId,owner);
    ensure(record.revision===a.expectedRevision,"REVISION_CONFLICT","Draft changed.",409);
    const issues=this.issues(record.draft);
    const capabilitySnapshot=refs(record.draft).map(ref=>({capabilityId:ref.capabilityId,revision:this.repo.get("capabilities",ref.capabilityId)?.revision ?? null}));
    for(const ref of refs(record.draft)) if(!capabilitySnapshot.some(c=>c.capabilityId===ref.capabilityId&&c.revision===ref.revision)) issues.push({code:"CAPABILITY_STALE",message:"Capability changed.",capabilityId:ref.capabilityId});
    const blocking=a.level==="structure" ? issues.filter((i:Json)=>!["BINDING_UNVERIFIED","TOOL_SCHEMA_DRIFT","ENVIRONMENT_OVERRIDE_DENIED"].includes(i.code)) : issues;
    return {valid:blocking.length===0,issues:blocking,warnings:issues.filter((i:Json)=>!blocking.includes(i)),capabilitySnapshot};
  }
  publishLegacy(workflowId: string, expectedRevision?: number, changeNote = "", expectedBindingRevisions?: Record<string,number>) {
    return this.repo.tx(() => {
      ensure(this.repo.get("workflows",workflowId)?.draft.schemaVersion!=="flowhub.workflow/v2","CAPABILITY_STALE","Publish v2 drafts through the reviewed capability revision contract.",409);
      const result=this.engine.publish(workflowId,expectedRevision,changeNote,expectedBindingRevisions);
      this.repo.changed("draft.changed",{workflowId,revision:this.repo.get("workflows",workflowId).revision});
      return result;
    });
  }
  undo(a:Json,owner="admin") {
    this.authorize(owner,a.workflowId);
    return this.repo.command(owner,"draft.undo",a.idempotencyKey,a,()=>{
      const command=this.repo.get("authoring_commands",a.commandId),current=this.get(a.workflowId,owner);
      ensure(command&&command.workflowId===a.workflowId,"NOT_FOUND","Authoring action missing.",404);
      ensure(current.revision===a.expectedRevision,"REVISION_CONFLICT","Draft changed before undo.",409);
      const draft=clone(current.draft),layout=clone(current.layout),inverse:Json[]=[];
      const same=(left:Json,right:Json)=>hash([left])===hash([right]);
      const revert=(target:Json,before:Json,after:Json,path:string)=>{
        for(const key of new Set([...Object.keys(before??{}),...Object.keys(after??{})])) {
          if(same(before?.[key],after?.[key]))continue;
          ensure(same(target[key],after?.[key]),"REVISION_CONFLICT","Cannot undo a field changed later: "+path+key,409);
          inverse.push({path:path+key,before:after?.[key]??null,after:before?.[key]??null});
          if(Object.hasOwn(before??{},key))target[key]=clone(before[key]);else delete target[key];
        }
      };
      const oldNodes=Object.fromEntries(command.beforeDraft.nodes.map((n:Json)=>[n.id,n])),newNodes=Object.fromEntries(command.afterDraft.nodes.map((n:Json)=>[n.id,n])),liveNodes=Object.fromEntries(draft.nodes.map((n:Json)=>[n.id,n]));
      for(const key of new Set([...Object.keys(oldNodes),...Object.keys(newNodes)])) {
        if(same(oldNodes[key],newNodes[key]))continue;
        if(oldNodes[key]&&newNodes[key]&&liveNodes[key])revert(liveNodes[key],oldNodes[key],newNodes[key],"/nodes/"+key+"/");
        else {ensure(same(liveNodes[key],newNodes[key]),"REVISION_CONFLICT","Node was modified after the action.",409);if(oldNodes[key])liveNodes[key]=clone(oldNodes[key]);else delete liveNodes[key];}
      }
      draft.nodes=Object.values(liveNodes);
      const edgeKey=(edge:Json)=>JSON.stringify([edge.source,edge.target,edge.port]);
      const oldEdges=new Map(command.beforeDraft.edges.map((e:Json)=>[edgeKey(e),e])),newEdges=new Map(command.afterDraft.edges.map((e:Json)=>[edgeKey(e),e]));
      for(const key of new Set([...oldEdges.keys(),...newEdges.keys()]))if(oldEdges.has(key)!==newEdges.has(key)) {
        const exists=draft.edges.some((e:Json)=>edgeKey(e)===key);ensure(exists===newEdges.has(key),"REVISION_CONFLICT","Edge changed after the action.",409);
        draft.edges=draft.edges.filter((e:Json)=>edgeKey(e)!==key);if(oldEdges.has(key))draft.edges.push(clone(oldEdges.get(key)));
      }
      const metadata=(value:Json)=>Object.fromEntries(Object.entries(value).filter(([k])=>!["nodes","edges","bindings"].includes(k)));
      revert(draft,metadata(command.beforeDraft),metadata(command.afterDraft),"/");revert(draft.bindings,command.beforeDraft.bindings,command.afterDraft.bindings,"/bindings/");revert(layout,command.beforeLayout,command.afterLayout,"/layout/");
      validate(workflowSchema,draft);
      const saved={...current,draft,layout,revision:current.revision+1,layoutRevision:current.layoutRevision+(same(layout,current.layout)?0:1),name:draft.name,updatedAt:now()};
      delete saved.workflow;delete saved.issues;delete saved.capabilityRefs;
      this.repo.put("workflows",a.workflowId,saved,current.revision);
      const undoId=id("authoring");this.repo.insert("authoring_commands",undoId,{id:undoId,owner,operation:"undo",idempotencyKey:a.idempotencyKey,workflowId:a.workflowId,
        beforeDraft:current.draft,afterDraft:draft,beforeLayout:current.layout,afterLayout:layout,beforeRevision:current.revision,afterRevision:saved.revision,createdAt:now()});
      this.repo.changed("draft.changed",{workflowId:a.workflowId,revision:saved.revision,changedNodes:draft.nodes.map((n:Json)=>n.id)});
      return {workflowId:a.workflowId,revision:saved.revision,commandId:undoId,inverse,issues:this.issues(draft)};
    });
  }
  publish(a: Json, owner="admin") {
    this.authorize(owner,a.workflowId);
    return this.repo.command(owner,"draft.publish",a.idempotencyKey,a,()=> {
      const record=this.get(a.workflowId,owner);
      ensure(record.revision===a.expectedRevision,"REVISION_CONFLICT","Draft changed.",409);
      const expected=a.expectedCapabilityRevisions ?? {};
      const current=Object.fromEntries(refs(record.draft).map(ref=>[ref.capabilityId,this.repo.get("capabilities",ref.capabilityId)?.revision]));
      ensure(hash(current)===hash(expected),"CAPABILITY_STALE","Capability revisions must match the reviewed draft.",409);
      const check=this.validate({...a,level:"publish"},owner);
      ensure(check.valid,"WORKFLOW_INVALID",JSON.stringify(check.issues));
      const draft={...record.draft,version:a.version};validate(workflowSchema,draft);
      this.repo.put("workflows",a.workflowId,{...record,draft});
      const result=this.engine.publish(a.workflowId,a.expectedRevision,"v2 authoring",a.expectedBindingRevisions);
      this.repo.changed("draft.changed",{workflowId:a.workflowId,revision:this.repo.get("workflows",a.workflowId).revision});
      return result;
    });
  }
}
