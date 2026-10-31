import { isAbsolute, resolve } from "node:path";
import { hash, id, now, ensure, HubError, type Json } from "../../contracts/src/domain.js";
import { createContext, scanHost, resolveSource } from "../../host-discovery/src/index.js";
import type { Engine } from "../../workflow-core/src/engine.js";

export class CapabilityRegistry {
  private jobs=new Map<string,Promise<void>>();
  constructor(readonly engine:Engine) {
    for(const job of this.repo.all("discovery_jobs"))if(!["SUCCEEDED","PARTIAL","FAILED","CANCELLED"].includes(job.status))
      this.repo.put("discovery_jobs",job.id,{...job,status:"PARTIAL",issues:[...(job.issues??[]),{code:"TASK_INTERRUPTED"}]});
  }
  get repo(){return this.engine.repo;}
  async context(a:Json={}) {
    const context=await createContext(a);const prior=this.repo.get("host_contexts",context.id);
    if(!prior)this.repo.insert("host_contexts",context.id,{...context,createdAt:now()});
    return prior??context;
  }
  scan(a:Json,owner="admin") {
    const context=this.repo.get("host_contexts",a.contextId);ensure(context,"NOT_FOUND","Register a local context first.",404);
    ensure(["metadata","catalog"].includes(a.depth),"INPUT_INVALID","Scan depth must be metadata or catalog.");
    const accepted=this.repo.command(owner,"host.scan",a.idempotencyKey,a,()=>{
      const scanId=id("scan");this.repo.insert("discovery_jobs",scanId,{id:scanId,contextId:a.contextId,owner,depth:a.depth,status:"QUEUED",createdAt:now(),issues:[],coverage:"partial"});
      return {scanId,status:"QUEUED"};
    });
    if(this.repo.get("discovery_jobs",accepted.scanId).status==="QUEUED"&&!this.jobs.has(accepted.scanId)) {
      const work=this.perform(accepted.scanId,context,a.depth).finally(()=>this.jobs.delete(accepted.scanId));this.jobs.set(accepted.scanId,work);
    }
    return accepted;
  }
  status(scanId:string,owner="admin") {
    const job=this.repo.get("discovery_jobs",scanId);ensure(job&&(owner==="admin"||job.owner===owner),"NOT_FOUND","Scan missing.",404);return job;
  }
  private putCapability(value:Json) {
    const previous=this.repo.get("capabilities",value.id);
    const fingerprint=hash({...value,discoveredAt:undefined,revision:undefined,sourceRefs:value.sourceRefs?.map((s:Json)=>({...s,revision:undefined}))});
    const revision=previous?.sourceFingerprint===fingerprint?previous.revision:(previous?.revision??0)+1;
    const capability={...value,capabilityId:value.id,revision,sourceFingerprint:fingerprint,discoveredAt:now(),stale:false};
    this.repo.put("capabilities",value.id,capability);
    if(!this.repo.get("capability_revisions",value.id+"@"+revision))this.repo.insert("capability_revisions",value.id+"@"+revision,{...capability,id:value.id+"@"+revision,capabilityRevision:revision});
    return capability;
  }
  private async perform(scanId:string,context:Json,depth:string) {
    const update=(patch:Json)=>{
      this.repo.put("discovery_jobs",scanId,{...this.repo.get("discovery_jobs",scanId),...patch});
      this.repo.changed("scan.progress",{scanId,data:patch});
    };
    update({status:"READING_SOURCES"});
    try {
      const scan=await scanHost(context),sourceIds=new Set<string>(),capIds=new Set<string>();
      const safeComponents=scan.components.map(({content,...c}:Json)=>c);
      update({status:"DISCOVERING_CATALOG",components:safeComponents,resolutionQuality:scan.resolutionQuality,issues:scan.issues});
      for(const source of scan.sources) {
        const sourceId="src_"+hash([context.id,source.sourceKey]).slice(0,24),prior=this.repo.get("capability_sources",sourceId);
        const sourceFingerprint=hash(source.config);
        const self=/^(?:flowhub|mcp-flowhub)(?:[-_].*)?$/i.test(source.name) ||
          (source.config.args??[]).some((v:Json)=>typeof v==="string" && /(?:^|[/\\])apps[/\\]daemon[/\\]src[/\\]cli\.js$/i.test(v)) ||
          /mcp-flowhub|flowhub(?:\.exe)?$/i.test(source.config.command??"");
        const unresolved=(source.config.env_vars?.length??0)>0 || source.config.bearer_token_env_var || Object.keys(source.config.env??{}).length>0 || Object.keys(source.config.http_headers??{}).length>0;
        const direct=!self && (source.config.url || (isAbsolute(source.config.command??"")&&!/\$\{|\{\{/.test(JSON.stringify(source.config))));
        const value:Json={id:sourceId,contextId:context.id,sourceKey:source.sourceKey,name:source.name,kind:source.kind,locator:source.locator,
          enabled:source.enabled,sourceFingerprint,revision:prior?.sourceFingerprint===sourceFingerprint?prior.revision:(prior?.revision??0)+1,
          self,executor:self?"informational":direct?"hub_direct":"codex_host",discovery:"metadata_only",installation:"installed",
          availability:unresolved?"credentials_required":"not_checked",credentialVariables:[...(source.config.env_vars??[]),...Object.keys(source.config.env??{}),...(source.config.bearer_token_env_var?[source.config.bearer_token_env_var]:[])],discoveredAt:now(),stale:false};
        sourceIds.add(sourceId);
        if(depth==="catalog"&&source.enabled&&!self&&direct&&!unresolved)try {
          const connection=this.connection(source.config,sourceId,false);
          const discovered=await this.engine.connectors.discover(connection);
          value.discovery="schema_discovered";value.availability="ready";
          for(const tool of discovered.tools) {
            const cap=this.putCapability({id:"cap_"+hash([context.id,source.sourceKey,tool.name]).slice(0,24),contextId:context.id,kind:"mcp_tool",name:tool.name,description:tool.description??"",
              executor:"hub_direct",availability:"ready",enabled:"enabled",installation:"installed",inputSchema:tool.inputSchema,outputSchema:tool.outputSchema??null,tool,
              sourceRefs:[{sourceId,revision:value.revision}],provenance:{synthetic:false,discovered:true}});
            capIds.add(cap.id);
          }
        }catch(e){value.discovery="failed";value.availability="unreachable";scan.issues.push({sourceId,code:e instanceof HubError?e.code:"CONNECTION_FAILED"});}
        this.repo.put("capability_sources",sourceId,value);
      }
      for(const component of scan.components)if(component.kind==="skill") {
        const cap=this.putCapability({id:"cap_"+hash([context.id,component.sourceKey]).slice(0,24),contextId:context.id,kind:"skill",name:component.name,description:component.description,
          executor:"codex_host",availability:component.enabled?"host_only":"disabled",enabled:component.enabled?"enabled":"disabled",installation:"installed",
          sourceRefs:[{sourceId:component.sourceKey,revision:1}],contentHash:component.contentHash,skillContent:component.content??null,provenance:{hostReported:false,path:component.path}});
        capIds.add(cap.id);
      }
      this.repo.tx(()=>{
        // Only a complete pass can mark absent sources; never remove a publication dependency.
        if(scan.issues.length===0) {
          for(const old of this.repo.all("capability_sources"))if(old.contextId===context.id&&!sourceIds.has(old.id))this.repo.put("capability_sources",old.id,{...old,stale:true});
          for(const old of this.repo.all("capabilities"))if(old.contextId===context.id&&!capIds.has(old.id)&&
            (old.kind==="skill" || !sourceIds.has(old.sourceRefs[0]?.sourceId) || (depth==="catalog" && this.repo.get("capability_sources",old.sourceRefs[0]?.sourceId)?.discovery==="schema_discovered")))this.repo.put("capabilities",old.id,{...old,stale:true});
        }
        update({status:scan.issues.length?"PARTIAL":"SUCCEEDED",coverage:scan.issues.length?"partial":"complete",issues:scan.issues,completedAt:now(),sources:this.repo.all("capability_sources").filter(s=>s.contextId===context.id),components:safeComponents});
      });
    }catch(e){update({status:"FAILED",issues:[{code:e instanceof HubError?e.code:"SOURCE_UNREADABLE"}],coverage:"partial"});}
  }
  private connection(config:Json,sourceId:string,importSecrets:boolean) {
    const refs:Json={};
    if(importSecrets)for(const [name,value] of Object.entries(config.env??{}))refs[name]=this.engine.vault.addSecret("Imported MCP variable "+name,String(value)).id;
    const url=config.url?new URL(config.url):null;
    ensure(!url || (!url.username&&!url.password&&!url.search&&!url.hash),"CREDENTIALS_REQUIRED","Use an endpoint without embedded credentials.");
    return {id:"conn_"+hash(sourceId).slice(0,24),name:"Imported MCP",revision:1,transport:url?"streamable_http":"stdio",protocolEra:"auto",disabled:false,
      ...(url?{endpoint:url.href,allowedHosts:[url.hostname]}:{command:config.command,args:config.args??[],envRefs:refs,commandApproved:true}),tools:[],sourceId};
  }
  search(a:Json={}) {
    const limit=Math.min(100,Math.max(1,Number(a.limit??20))),fingerprint=hash({...a,cursor:undefined,limit:undefined});
    let offset=0;
    if(a.cursor){try{const c=JSON.parse(Buffer.from(a.cursor,"base64url").toString());ensure(c.filter===fingerprint,"INPUT_INVALID","Cursor filter changed.");offset=c.offset;}catch{throw new HubError("INPUT_INVALID","Invalid capability cursor.");}}
    const terms=String(a.query??"").toLowerCase().split(/\s+/).filter(Boolean);
    const entries=this.repo.db.prepare("SELECT body FROM capabilities WHERE (? IS NULL OR json_extract(body,'$.contextId')=?) AND (? IS NULL OR json_extract(body,'$.kind')=?) AND (? IS NULL OR json_extract(body,'$.executor')=?) ORDER BY id")
      .all(a.contextId??null,a.contextId??null,a.kind??null,a.kind??null,a.executor??null,a.executor??null) as {body:string}[];
    const filtered=entries.map(e=>JSON.parse(e.body)).filter(c=>terms.every(t=>(c.name+" "+c.description).toLowerCase().includes(t)));
    const snapshot=hash(filtered.map(c=>[c.id,c.revision,c.stale]));
    if(a.cursor){const c=JSON.parse(Buffer.from(a.cursor,"base64url").toString());ensure(c.snapshot===snapshot,"CAPABILITY_STALE","Capability cursor snapshot changed.",409);}
    return {items:filtered.slice(offset,offset+limit).map(({inputSchema,outputSchema,tool,skillContent,...summary}:Json)=>summary),
      nextCursor:offset+limit<filtered.length?Buffer.from(JSON.stringify({filter:fingerprint,snapshot,offset:offset+limit})).toString("base64url"):null};
  }
  get(a:Json) {
    const cap=a.revision?this.repo.get("capability_revisions",a.capabilityId+"@"+a.revision):this.repo.get("capabilities",a.capabilityId);
    ensure(cap,"NOT_FOUND","Capability missing.",404);
    const {inputSchema,outputSchema,tool,skillContent,...summary}=cap;
    return {...summary,...(a.includeSchemas?{inputSchema,outputSchema,tool}:{}),...(a.includeSkillContent?{skillContent:skillContent?.slice(0,32768),contentTruncated:(skillContent?.length??0)>32768}: {})};
  }
  async import(a:Json,owner="admin") {
    const cap=this.repo.get("capabilities",a.capabilityId);ensure(cap&&!cap.stale,"CAPABILITY_STALE","Capability missing or stale.",409);
    ensure(cap.revision===a.expectedSourceRevision,"CAPABILITY_STALE","Review the current capability revision.",409);
    if(a.target==="codex_host")return this.repo.command(owner,"capability.import",a.idempotencyKey,a,()=>({status:"host_reference",hostReference:{capabilityId:cap.id,revision:cap.revision,executor:"codex_host"}}));
    ensure(cap.executor==="hub_direct","HOST_ONLY","Capability requires Codex.");
    const source=this.repo.get("capability_sources",cap.sourceRefs[0].sourceId);
    ensure(source&&!source.self,"SELF_REFERENCE_DENIED","FlowHub cannot be its own downstream.");
    ensure(["production","staging","test"].includes(a.environment),"INPUT_INVALID","Explicit environment required.");
    const context=this.repo.get("host_contexts",cap.contextId),config=await resolveSource(context,source.locator);
    ensure(hash(config)===source.sourceFingerprint,"CAPABILITY_STALE","Source configuration changed.",409);
    if((config.env_vars?.length??0)>0||config.bearer_token_env_var||config.http_headers)return {status:"configuration_required",missing:source.credentialVariables};
    // Resolve network discovery outside the short transaction. No business call occurs.
    const connection=this.connection(config,source.id,false);
    if(Object.keys(config.env??{}).length)return {status:"configuration_required",missing:Object.keys(config.env),reason:"Register credential references through local connection settings."};
    const discovered=await this.engine.connectors.discover(connection);
    return this.repo.command(owner,"capability.import",a.idempotencyKey,a,()=>{
      ensure(this.repo.get("capabilities",cap.id)?.revision===cap.revision,"CAPABILITY_STALE","Capability changed while importing.",409);
      const previous=this.repo.get("connections",connection.id);
      if(!previous)this.repo.insert("connections",connection.id,discovered);
      const bindingId="binding_"+hash([source.id,a.environment,a.lockedArguments??{}]).slice(0,24);
      const binding={id:bindingId,revision:1,name:cap.name,connectionId:connection.id,connectionRevision:(previous??discovered).revision,environment:a.environment,
        allowedTools:[cap.name],lockedArguments:a.lockedArguments??{},allowedQueryTemplates:[],simulationOnly:false,validationStatus:"UNVERIFIED",maxRows:100,timeoutSeconds:10,
        sourceCapabilityId:cap.id};
      if(!this.repo.get("bindings",bindingId))this.repo.insert("bindings",bindingId,binding);
      return {connectionId:connection.id,bindingId,status:"configuration_required",reason:"Protocol catalog imported; independently verify the environment/resource binding before live publication."};
    });
  }
  async close(){await Promise.allSettled(this.jobs.values());}
}
