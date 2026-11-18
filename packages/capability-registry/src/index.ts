import { isAbsolute } from "node:path";
import { hash, id, now, ensure, validate, HubError, type Json } from "../../contracts/src/domain.js";
import { validArguments, type ToolName } from "../../contracts/src/index.js";
import { createContext, scanHost, resolveSource, selfSource, sourcePolicy, toolEnabled,type DiscoveryRuntime } from "../../host-discovery/src/index.js";
import type { Engine } from "../../workflow-core/src/engine.js";
import { DiscoveryCatalog } from "./discovery-catalog.js";
import { configurationFields, storedConfigurationFields } from "../../host-discovery/src/connection-fields.js";
import { credentialInventory } from "../../security/src/credential-metadata.js";
const terminal=["SUCCEEDED","PARTIAL","FAILED","CANCELLED"];
function input(name:ToolName,a:Json){ensure(validArguments(name,a),"INPUT_INVALID","Arguments do not match the fixed tool contract.");}
/** HTTP field names are case insensitive; ambiguous credential choices must never win by order. */
function bearerCredentials(config:Json) {
  const envHeaders=Object.entries(config.env_http_headers??{}),headers=Object.entries(config.http_headers??{});
  const supported=envHeaders.every(([name,value])=>name.toLowerCase()==="authorization"&&typeof value==="string"&&value.length>0)&&headers.every(([name,value])=>name.toLowerCase()==="authorization"&&typeof value==="string"&&/^Bearer .+$/i.test(value));
  const variables=[...new Set([...envHeaders.map(([,value])=>value),...(config.bearer_token_env_var?[config.bearer_token_env_var]:[])])],tokens=[...new Set(headers.map(([,value])=>String(value).replace(/^Bearer /i,"")))];
  return {supported,conflict:variables.length>1||tokens.length>1||variables.length>0&&tokens.length>0,variable:variables[0],token:tokens[0]};
}
function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
  return new Promise((resolve,reject)=>{const abort=()=>reject(new HubError("DISCOVERY_CANCELLED","Discovery cancelled or timed out."));
    if(signal.aborted){abort();return;}signal.addEventListener("abort",abort,{once:true});
    work.then(resolve,reject).finally(()=>signal.removeEventListener("abort",abort));
  });
}
export class CapabilityRegistry {
  readonly catalog: DiscoveryCatalog;
  private jobs=new Map<string,Promise<unknown>>();
  private controls=new Map<string,AbortController>();
  private imports=new Map<string,{fingerprint:string;work:Promise<Json>}>();
  private closing=false;
  private identity:Json={endpoints:[]};
  constructor(readonly engine:Engine,readonly options:{scanTimeoutMs?:number;sourceTimeoutMs?:number;concurrency?:number;hostRuntime?:DiscoveryRuntime}={}) {
    this.catalog=new DiscoveryCatalog(engine.repo);
    for(const job of this.repo.all("discovery_jobs"))if(!terminal.includes(job.status))
      this.repo.put("discovery_jobs",job.id,{...job,status:"PARTIAL",issues:[...(job.issues??[]),{code:"TASK_INTERRUPTED"}]});
  }
  get repo(){return this.engine.repo;}
  /** Called by the daemon after its actual listen port is known. */
  setSelfIdentity(identity:Json){this.identity={...identity,endpoints:identity.endpoints??[]};}
  async context(a:Json={}) {
    validate({type:"object",properties:{contextId:{type:"string",minLength:1},codexHome:{type:"string"},cwd:{type:"string"},profile:{type:["string","null"]},codexPath:{type:["string","null"]},discoveryMode:{enum:["auto","config_only"]},projectTrusted:{type:"boolean"},useAppServer:{type:"boolean"},expectedRevision:{type:"integer",minimum:1}},additionalProperties:false},a);
    const update=a.expectedRevision!==undefined;
    ensure(update===!!a.contextId,"INPUT_INVALID","Context updates require the original contextId and expectedRevision.");
    const target=update?this.repo.get("host_contexts",a.contextId):undefined;
    if(update){ensure(target,"NOT_FOUND","Host context missing.",404);ensure(target.revision===a.expectedRevision,"REVISION_CONFLICT","Host context changed.",409);}
    const defaults=target?{codexHome:target.codexHome,cwd:target.canonicalCwd,profile:target.profile,codexPath:target.codexPath,discoveryMode:target.discoveryMode,projectTrusted:target.projectTrusted,useAppServer:target.useAppServer}:{};
    const selected={...defaults,...a};
    // Omission retains the target path; an explicit empty auto-mode path asks for fresh PATH lookup.
    if(a.codexPath==="")delete selected.codexPath;
    const context=await createContext(selected,this.options.hostRuntime);
    return this.repo.tx(()=>{
      if(update) {
        const prior=this.repo.get("host_contexts",a.contextId);
        ensure(prior&&prior.revision===a.expectedRevision,"REVISION_CONFLICT","Host context changed.",409);
        ensure(context.id===prior.id,"CONTEXT_IDENTITY_CHANGED","上下文身份已变化，原上下文保持不变。请使用当前填写的选项登记新上下文。",409);
        const saved={...prior,...context,revision:prior.revision+1,createdAt:prior.createdAt};
        this.repo.put("host_contexts",prior.id,saved,prior.revision);return saved;
      }
      const prior=this.repo.get("host_contexts",context.id);
      if(prior)for(const key of ["codexPath","discoveryMode","projectTrusted","useAppServer"])
        ensure(!Object.hasOwn(a,key)||context[key]===prior[key],"CONTEXT_REGISTRATION_CONFLICT","This context is already registered with different explicit options. Select it and update its reading options with its current revision.",409);
      if(!prior)this.repo.insert("host_contexts",context.id,{...context,createdAt:now()});
      return prior??context;
    });
  }
  private replay(owner:string,operation:string,a:Json) {
    const prior=this.repo.db.prepare("SELECT request_hash,response FROM commands WHERE owner=? AND operation=? AND key=?").get(owner,operation,a.idempotencyKey) as {request_hash:string;response:string}|undefined;
    if(!prior)return undefined;
    ensure(prior.request_hash===hash(a),"IDEMPOTENCY_CONFLICT","Key already used with different content.",409);return JSON.parse(prior.response);
  }
  sourceConfiguration(sourceId:string) {
    const source=this.repo.get("capability_sources",sourceId),context=source&&this.repo.get("host_contexts",source.contextId);
    ensure(source&&source.enabled&&!source.self&&!source.stale,"CAPABILITY_STALE","Source unavailable; rescan first.",409);
    ensure(context?.revision===source.contextRevision,"CONTEXT_CHANGED","Context changed; rescan first.",409);
    const connection=source.preparedConnectionId?this.repo.get("connections",source.preparedConnectionId):null;
    const prepared=connection?.sourceFingerprint===source.sourceFingerprint?connection:null;
    return {sourceId,contextId:source.contextId,revision:source.revision,vaultLocked:this.engine.vault.locked,vaultInitialized:this.engine.vault.initialized,
      fields:storedConfigurationFields(source).map(field=>({...field,declaredKind:field.kind,
        kind:field.kind==="unknown"?(prepared?.configurationKinds?.[field.name]??field.kind):field.kind,
        selectedRef:field.location==="bearer"?prepared?.secretRef??null:prepared?.envRefs?.[field.name]??null})),
    };
  }
  /** Explicit local-admin credential import; scans and MCP tools cannot invoke this. */
  async configureSource(a:Json,owner="admin") {
    ensure(owner==="admin","AUTH_REQUIRED","Use authenticated local connection settings.",403);
    validate({type:"object",properties:{sourceId:{type:"string"},expectedRevision:{type:"integer"},idempotencyKey:{type:"string",minLength:1},importInlineCredentials:{type:"boolean"},secretRefs:{type:"object",additionalProperties:{type:"string"}},entries:{type:"object",maxProperties:128,additionalProperties:{type:"object",required:["mode"],properties:{mode:{enum:["new","existing","source"]},kind:{enum:["config","credential","unknown"]},label:{type:"string",minLength:1,maxLength:128},value:{type:"string",maxLength:16383},secretRef:{type:"string",minLength:1}},additionalProperties:false}}},required:["sourceId","expectedRevision","idempotencyKey"],additionalProperties:false},a);
    const configured=(receipt:Json)=>({...receipt,status:"credentials_configured",next:"Rescan the catalog; resource bindings still require independent verification."});
    const replay=this.replay(owner,"source.configure",a);if(replay)return configured(replay);
    const source=this.repo.get("capability_sources",a.sourceId);
    ensure(source&&!source.self,"SELF_REFERENCE_DENIED","Select an independent current source.");
    ensure(source.enabled&&!source.stale&&source.revision===a.expectedRevision,"CAPABILITY_STALE","Source changed, disabled or stale.",409);
    const context=this.repo.get("host_contexts",source.contextId);
    ensure(context&&source.contextRevision===context.revision,"CONTEXT_CHANGED","Context changed; rescan before configuring credentials.",409);
    let config:Json;
    try{config=await resolveSource(context,source.locator,{},this.options.hostRuntime);}
    catch(e){const replay=this.replay(owner,"source.configure",a);if(replay)return configured(replay);throw e;}
    const resolvedReplay=this.replay(owner,"source.configure",a);if(resolvedReplay)return configured(resolvedReplay);
    ensure(hash(config)===source.sourceFingerprint,"CAPABILITY_STALE","Source configuration changed.",409);
    const policy=sourcePolicy(config);
    ensure(!policy.credentialArgs&&!policy.embeddedUrl,"CREDENTIAL_IMPORT_UNSUPPORTED","Move command-line credentials to a supported environment/Vault reference in local connection settings.");
    ensure(!policy.unsupported,"SOURCE_CONFIGURATION_UNSUPPORTED","Use the MCP tool library to register a supported connection explicitly.");
    ensure(source.executor==="hub_direct","HOST_ONLY","This source requires the Codex host.");
    const prepared=this.repo.command(owner,"source.configure",a.idempotencyKey,a,()=>{
      // resolveSource may run a subprocess. Nothing may be written using its old row snapshot.
      const current=this.repo.get("capability_sources",source.id),currentContext=this.repo.get("host_contexts",context.id);
      ensure(currentContext?.revision===context.revision,"CONTEXT_CHANGED","Context changed while resolving credentials; rescan first.",409);
      ensure(current&&current.enabled&&!current.self&&!current.stale&&current.revision===a.expectedRevision&&current.contextRevision===context.revision&&hash(current)===hash(source),"CAPABILITY_STALE","Source changed while resolving credentials; reload before saving.",409);
      ensure(config.enabled!==false&&!selfSource({name:source.name,config},this.identity),"CAPABILITY_STALE","Source is disabled or refers to FlowHub.",409);
      const bearer=bearerCredentials(config);
      ensure(bearer.supported,"CREDENTIAL_IMPORT_UNSUPPORTED","Only Bearer authentication is supported; configure other transports separately.");
      ensure(!bearer.conflict,"AUTHORIZATION_CONFLICT","Source declares conflicting Bearer authorization credentials.",409);
      const fields=configurationFields(config,source.name),declared=new Set(fields.map(field=>field.id));
      ensure(Object.keys(a.entries??{}).every(key=>declared.has(key)),"INPUT_INVALID","Only declared connection fields may be configured.");
      ensure(Object.keys(a.secretRefs??{}).every(key=>fields.some(field=>field.location==="env"&&field.name===key)),"INPUT_INVALID","Undeclared environment reference.");
      const connection=this.connection(config,source.id,false),refs:Json=Object.create(null),entryRefs:Json=Object.create(null),kinds:Json=Object.create(null);
      const inventory=credentialInventory(this.repo);
      for(const field of fields) {
        const legacy=field.location==="env"?a.secretRefs?.[field.name]:undefined;
        const entry=a.entries?.[field.id]??(legacy?{mode:"existing",secretRef:legacy}:a.importInlineCredentials===true&&field.inline?{mode:"source"}:null);
        ensure(entry,"CREDENTIALS_REQUIRED","请为 "+field.name+" 填写值、选择已有项或使用来源已有值。");
        ensure(!legacy||(entry.mode==="existing"&&entry.secretRef===legacy),"INPUT_INVALID","Conflicting field selections.");
        const kind=entry.kind??field.kind;
        ensure(field.kind!=="credential"||kind==="credential","INPUT_INVALID","Authentication fields remain credentials.");
        let ref:string;
        if(entry.mode==="existing") {
          ensure(entry.secretRef&&!Object.hasOwn(entry,"value"),"INPUT_INVALID","Choose one existing reference.");
          const selected=inventory.find(item=>item.id===entry.secretRef);
          ensure(selected?.eligibleForMcp&&!(kind==="credential"&&selected.purpose==="mcp_config")&&!(kind==="config"&&selected.purpose==="mcp_auth"),"CREDENTIAL_PURPOSE_MISMATCH","模型专用 Key 不能用于此 MCP 字段，请选择或新建对应项。",409);
          this.engine.vault.secret(entry.secretRef);ref=entry.secretRef;
        } else {
          ensure(!Object.hasOwn(entry,"secretRef"),"INPUT_INVALID","Choose one field value source.");
          const raw=entry.mode==="source"?(field.location==="bearer"?bearer.token:config.env?.[field.name]):entry.value;
          ensure(entry.mode!=="source"||!Object.hasOwn(entry,"value"),"INPUT_INVALID","Source mode does not accept a replacement value.");
          ensure(typeof raw==="string","CREDENTIALS_REQUIRED","来源未提供 "+field.name+" 的内联值，请填写或选择已有项。");
          ref=this.engine.vault.addSecret(entry.label??(source.name+" · "+field.name).slice(0,128),raw,{purpose:kind==="config"?"mcp_config":kind==="credential"?"mcp_auth":"unspecified",sourceId:source.id,variable:field.name}).id;
        }
        kinds[field.name]=kind;entryRefs[field.id]=ref;
        if(field.location==="bearer")connection.secretRef=ref;
        else {refs[field.name]=ref;if(bearer.variable===field.name)connection.secretRef=ref;}
      }
      connection.envRefs=refs;connection.configurationKinds=kinds;
      connection.sourceFingerprint=source.sourceFingerprint;
      connection.id="conn_"+hash([source.id,source.sourceFingerprint,connection.envRefs,connection.secretRef??null,connection.configurationKinds]).slice(0,24);
      const previous=this.repo.get("connections",connection.id);connection.revision=(previous?.revision??0)+1;
      if(!previous)this.repo.insert("connections",connection.id,connection);
      this.repo.put("capability_sources",source.id,{...current,preparedConnectionId:connection.id,revision:current.revision+1,discovery:"metadata_only",availability:"not_checked"},a.expectedRevision);
      for(const cap of this.contextCapabilities(context.id))if(cap.sourceRefs?.some((r:Json)=>r.sourceId===source.id))this.putCapability({...cap,stale:true,availability:"not_checked"});
      this.refreshConfigurationCatalog(context);
      return {connectionId:connection.id,entryRefs:{...entryRefs},revision:current.revision+1};
    });
    return configured(prepared);
  }
  private refreshConfigurationCatalog(context:Json) {
    const job=context.catalogScanId?this.repo.get("discovery_jobs",context.catalogScanId):null;
    if(job)this.catalog.replace(context,job,this.contextSources(context.id),this.contextCapabilities(context.id));
  }
  /** Read only this source's protocol/tool directory; never call a business tool. */
  detectSource(sourceId:string,expectedRevision:number) {
    ensure(!this.closing,"SERVICE_CLOSING","Service closing.",503);
    const key="detect:"+id("request"),work=this.performDetectSource(sourceId,expectedRevision,key).finally(()=>this.jobs.delete(key));
    this.jobs.set(key,work);return work;
  }
  private async performDetectSource(sourceId:string,expectedRevision:number,key:string) {
    ensure(!this.closing,"SERVICE_CLOSING","Service closing.",503);
    this.sourceConfiguration(sourceId);
    const source=this.repo.get("capability_sources",sourceId),context=this.repo.get("host_contexts",source.contextId);
    ensure(source.revision===expectedRevision,"CAPABILITY_STALE","Source changed; reopen connection settings.",409);
    const connection=this.repo.get("connections",source.preparedConnectionId??"");
    ensure(connection?.sourceFingerprint===source.sourceFingerprint,"CREDENTIALS_REQUIRED","Save connection configuration first.");
    const latest=()=>this.repo.db.prepare("SELECT id FROM discovery_jobs WHERE json_extract(body,'$.contextId')=? ORDER BY json_extract(body,'$.generation') DESC LIMIT 1").get(context.id) as Json;
    const jobId=latest()?.id,job=jobId&&this.repo.get("discovery_jobs",jobId);
    ensure(job&&terminal.includes(job.status),"SCAN_IN_PROGRESS","Wait for the current scan to finish.",409);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.options.sourceTimeoutMs??10000);
    this.controls.set(key,controller);
    try {
      const config=await resolveSource(context,source.locator,{signal:controller.signal},this.options.hostRuntime);
      ensure(hash(config)===source.sourceFingerprint,"CAPABILITY_STALE","Source file changed; rescan first.",409);
      const result=await this.engine.connectors.discover(connection,{signal:controller.signal,deadline:Date.now()+(this.options.sourceTimeoutMs??10000)});
      ensure(!controller.signal.aborted&&!this.closing,"DISCOVERY_CANCELLED","Connection detection cancelled or timed out.");
      ensure(!this.discoveredSelf(result),"SELF_REFERENCE_DENIED","FlowHub cannot be its own downstream.");
      return this.repo.tx(()=>{
        ensure(this.repo.get("host_contexts",context.id)?.revision===context.revision&&latest()?.id===jobId,"CONTEXT_CHANGED","Discovery changed during detection; retry with the current source.",409);
        ensure(hash(this.repo.get("capability_sources",sourceId))===hash(source)&&hash(this.repo.get("connections",connection.id))===hash(connection),"CAPABILITY_STALE","Connection changed during detection.",409);
        const seen=new Set<string>();
        for(const tool of result.tools) {
          const enabled=toolEnabled(config,tool.name),cap=this.putCapability({id:"cap_"+hash([context.id,source.sourceKey,tool.name]).slice(0,24),contextId:context.id,contextRevision:context.revision,kind:"mcp_tool",name:tool.name,description:tool.description??"",executor:"hub_direct",availability:enabled?"ready":"disabled",enabled:enabled?"enabled":"disabled",installation:"installed",inputSchema:tool.inputSchema,outputSchema:tool.outputSchema??null,tool,sourceRefs:[{sourceId,revision:source.revision}],provenance:{synthetic:false,discovered:true}});seen.add(cap.id);
        }
        for(const cap of this.contextCapabilities(context.id))if(cap.sourceRefs?.some((r:Json)=>r.sourceId===sourceId)&&!seen.has(cap.id))this.putCapability({...cap,stale:true});
        this.repo.put("capability_sources",sourceId,{...source,discovery:"schema_discovered",availability:"ready",lastCatalogAt:now(),lastObservation:{...source.lastObservation,connectionChecked:true,at:now()}});
        this.refreshConfigurationCatalog(context);
        this.repo.changed("connection.catalog.checked",{sourceId,contextId:context.id});
        return {status:"catalog_ready",toolCount:result.tools.length,sourceId,connectionId:connection.id,resourceBindingVerified:false};
      });
    } finally {
      clearTimeout(timer);this.controls.delete(key);
    }
  }
  scan(a:Json,owner="admin") {
    input("host_scan",a);ensure(!this.closing,"SERVICE_CLOSING","Discovery is shutting down.",503);
    if(a.action==="submit_descriptions")return this.catalog.submit(a,owner);
    const context=this.repo.get("host_contexts",a.contextId);ensure(context,"NOT_FOUND","Register a local context first.",404);
    const accepted=this.repo.command(owner,"host.scan",a.idempotencyKey,a,()=>{
      const prior=this.repo.db.prepare("SELECT COALESCE(MAX(json_extract(body,'$.generation')),0) AS n FROM discovery_jobs WHERE json_extract(body,'$.contextId')=?").get(a.contextId) as {n:number};
      const scanId=id("scan");this.repo.insert("discovery_jobs",scanId,{id:scanId,contextId:a.contextId,contextRevision:context.revision,generation:prior.n+1,owner,depth:a.depth,status:"QUEUED",createdAt:now(),issues:[],coverage:"partial"});
      return {scanId,status:"QUEUED"};
    });
    if(this.repo.get("discovery_jobs",accepted.scanId).status==="QUEUED"&&!this.jobs.has(accepted.scanId)) {
      const controller=new AbortController();this.controls.set(accepted.scanId,controller);
      const work=this.perform(accepted.scanId,context,a.depth,controller).finally(()=>{this.jobs.delete(accepted.scanId);this.controls.delete(accepted.scanId);});this.jobs.set(accepted.scanId,work);
    }
    return accepted;
  }
  status(scanId:string,owner="admin") {
    const job=this.repo.get("discovery_jobs",scanId);ensure(job&&(owner==="admin"||job.owner===owner),"NOT_FOUND","Scan missing.",404);
    const overview=this.catalog.overview(job.contextId);
    return {...job,catalog:overview.scanId===job.id?{...overview,entities:this.catalog.search({contextId:job.contextId,limit:100}).items,descriptionSubmission:{action:"submit_descriptions",expectedContextRevision:overview.contextRevision,locale:"zh-CN",next:"Use capability_search by kind and cursor for remaining entities; submit only source-backed Chinese descriptions."}}:null};
  }
  cancel(scanId:string,owner="admin") {
    const job=this.status(scanId,owner);this.controls.get(scanId)?.abort();return {...job,status:terminal.includes(job.status)?job.status:"CANCEL_REQUESTED"};
  }
  private current(scanId:string,context:Json) {
    const latest=this.repo.db.prepare("SELECT id FROM discovery_jobs WHERE json_extract(body,'$.contextId')=? ORDER BY json_extract(body,'$.generation') DESC LIMIT 1").get(context.id) as {id:string};
    ensure(latest.id===scanId,"SCAN_SUPERSEDED","A newer scan owns the current catalog.",409);
    ensure(this.repo.get("host_contexts",context.id)?.revision===context.revision,"CONTEXT_CHANGED","Host context changed during discovery.",409);
  }
  private putCapability(value:Json) {
    const previous=this.repo.get("capabilities",value.id);
    const fingerprint=hash({...value,discoveredAt:undefined,revision:undefined,capabilityId:undefined,sourceFingerprint:undefined});
    const revision=previous?.sourceFingerprint===fingerprint?previous.revision:(previous?.revision??0)+1;
    const capability={...value,capabilityId:value.id,revision,sourceFingerprint:fingerprint,discoveredAt:now(),stale:value.stale??false};
    this.repo.put("capabilities",value.id,capability);
    if(!this.repo.get("capability_revisions",value.id+"@"+revision))this.repo.insert("capability_revisions",value.id+"@"+revision,{...capability,id:value.id+"@"+revision,capabilityRevision:revision});
    return capability;
  }
  private async perform(scanId:string,context:Json,depth:string,controller:AbortController) {
    const deadline=Date.now()+(this.options.scanTimeoutMs??30000),timer=setTimeout(()=>controller.abort(),Math.max(1,deadline-Date.now()));
    const update=(patch:Json)=>{this.repo.put("discovery_jobs",scanId,{...this.repo.get("discovery_jobs",scanId),...patch});this.repo.changed("scan.progress",{scanId,data:patch});};
    const check=()=>{ensure(!controller.signal.aborted,"DISCOVERY_CANCELLED","Discovery cancelled or timed out.");this.current(scanId,context);};
    update({status:"READING_SOURCES"});
    try {
      const scan=await abortable(scanHost(context,depth,{signal:controller.signal,deadline},this.identity,this.options.hostRuntime),controller.signal);check();
      const sourceIds=new Set<string>(),capIds=new Set<string>(),changes:Json[]=[];
      const safeComponents=scan.components.map(({content,...c}:Json)=>c);
      update({status:"DISCOVERING_CATALOG",components:safeComponents,resolutionQuality:scan.resolutionQuality,issues:scan.issues});
      let index=0;
      const worker=async()=>{while(index<scan.sources.length){check();const source=scan.sources[index++]!;
        const sourceId="src_"+hash([context.id,source.sourceKey]).slice(0,24),prior=this.repo.get("capability_sources",sourceId),sourceFingerprint=hash(source.config),self=selfSource(source,this.identity),policy=sourcePolicy(source.config);
        const direct=!self&&!policy.unsupported&&!!(source.config.url||(isAbsolute(source.config.command??"")&&!/\$\{|\{\{/.test(JSON.stringify(source.config))));
        const bearer=bearerCredentials(source.config),referenceCredentials=bearer.supported&&!bearer.conflict;
        const value:Json={id:sourceId,contextId:context.id,contextRevision:context.revision,sourceKey:source.sourceKey,name:source.name,kind:source.kind,locator:source.locator,sourceChain:source.sourceChain,resolutionEvidence:source.resolutionEvidence,
          connectionSetup:policy.credentialArgs||policy.embeddedUrl||policy.unsupported||!referenceCredentials?"manual":direct?"references":"host",
          enabled:source.enabled,sourceFingerprint,revision:prior?.sourceFingerprint===sourceFingerprint?prior.revision:(prior?.revision??0)+1,
          self,executor:self?"informational":direct?"hub_direct":"codex_host",discovery:"metadata_only",installation:"installed",
          availability:!source.enabled?"disabled":policy.credentialArgs||policy.embeddedUrl?"credentials_required":policy.unsupported?"unsupported":policy.requiresCredentials?"credentials_required":"not_checked",credentialPolicyVersion:3,unsupportedReason:policy.unsupportedArgs?"LAUNCHER_ARGUMENTS_UNSUPPORTED":policy.unsupported?"SOURCE_CONFIGURATION_UNSUPPORTED":null,credentialVariables:policy.credentialVariables,configurationFields:configurationFields(source.config,source.name),discoveredAt:now(),stale:false};
        const sameSource=prior?.sourceFingerprint===sourceFingerprint&&prior?.contextRevision===context.revision&&!prior?.stale;
        if(depth==="metadata"&&sameSource) {
          value.discovery=prior.discovery;value.availability=prior.availability;value.self=prior.self;value.executor=prior.executor;
          value.lastCatalogAt=prior.lastCatalogAt??(prior.discovery==="schema_discovered"?prior.discoveredAt:null);
        }
        value.lastObservation={scanId,depth,at:now(),connectionChecked:false};
        sourceIds.add(sourceId);
        const prepared=prior?.preparedConnectionId?this.repo.get("connections",prior.preparedConnectionId):undefined,configured=prepared?.sourceFingerprint===sourceFingerprint;
        if(configured)value.preparedConnectionId=prepared.id;
        if(!prior||prior.sourceFingerprint!==sourceFingerprint)changes.push({sourceId,name:source.name,change:prior?"changed":"added",fromRevision:prior?.revision??null,toRevision:value.revision});
        if(depth==="catalog"&&source.enabled&&!self&&(!direct||(policy.requiresCredentials&&!configured)))scan.issues.push({sourceId,code:policy.unsupported?"SOURCE_CONFIGURATION_UNSUPPORTED":direct?"CREDENTIALS_REQUIRED":"HOST_CAPABILITY_UNAVAILABLE"});
        if(depth==="catalog"&&source.enabled&&!self&&direct&&(!policy.requiresCredentials||configured))try {
          const connection=configured?prepared:this.connection(source.config,sourceId,false,sourceFingerprint);
          const discovered=await abortable(this.engine.connectors.discover(connection,{signal:controller.signal,deadline:Math.min(deadline,Date.now()+(this.options.sourceTimeoutMs??10000))}),controller.signal);check();
          ensure(!this.discoveredSelf(discovered),"SELF_REFERENCE_DENIED","FlowHub cannot be its own downstream.");
          value.discovery="schema_discovered";value.availability="ready";value.lastCatalogAt=now();value.lastObservation.connectionChecked=true;
          for(const tool of discovered.tools) {
            const enabled=toolEnabled(source.config,tool.name);
            const cap=this.putCapability({id:"cap_"+hash([context.id,source.sourceKey,tool.name]).slice(0,24),contextId:context.id,contextRevision:context.revision,kind:"mcp_tool",name:tool.name,description:tool.description??"",
              executor:"hub_direct",availability:enabled?"ready":"disabled",enabled:enabled?"enabled":"disabled",installation:"installed",inputSchema:tool.inputSchema,outputSchema:tool.outputSchema??null,tool,
              sourceRefs:[{sourceId,revision:value.revision}],provenance:{synthetic:false,discovered:true}});capIds.add(cap.id);
          }
        }catch(e){check();value.discovery="failed";value.availability=e instanceof HubError&&e.code==="SELF_REFERENCE_DENIED"?"unsupported":"unreachable";if(e instanceof HubError&&e.code==="SELF_REFERENCE_DENIED"){value.self=true;value.executor="informational";}scan.issues.push({sourceId,code:e instanceof HubError?e.code:"CONNECTION_FAILED"});}
        check();this.repo.put("capability_sources",sourceId,value);
        for(const old of this.contextCapabilities(context.id))if(old.sourceRefs?.some((r:Json)=>r.sourceId===sourceId)&&!capIds.has(old.id)) {
          const disabled=!source.enabled||!toolEnabled(source.config,old.name)||self;
          const changed=!sameSource||old.sourceRefs.find((ref:Json)=>ref.sourceId===sourceId)?.revision!==value.revision;
          if(disabled||changed||(depth==="catalog"&&value.discovery!=="schema_discovered"))this.putCapability({...old,enabled:disabled?"disabled":old.enabled,availability:disabled?"disabled":value.availability,stale:changed||old.stale,sourceRefs:[{sourceId,revision:value.revision}]});
        }
        update({sources:this.contextSources(context.id),issues:[...scan.issues],changes:[...changes]});
      }};
      await Promise.all(Array.from({length:Math.min(this.options.concurrency??4,Math.max(1,scan.sources.length))},()=>worker()));check();
      for(const component of scan.components)if(["skill","host_tool"].includes(component.kind)) {
        const skill=component.kind==="skill",enabled=component.enabled!==false;
        const serverSource=!skill&&component.serverSourceKey?this.contextSources(context.id).find(source=>source.sourceKey===component.serverSourceKey):undefined;
        const parentIdentity=serverSource?{serverSourceId:serverSource.id,serverSourceFingerprint:serverSource.sourceFingerprint}:{};
        const sourceId="src_"+hash([context.id,component.sourceKey]).slice(0,24),prior=this.repo.get("capability_sources",sourceId),sourceFingerprint=hash({enabled,contentHash:component.contentHash??null,...(component.dependencyHash?{dependencyHash:component.dependencyHash}:{}),tool:component.tool??null,...parentIdentity});
        const componentSource={id:sourceId,contextId:context.id,contextRevision:context.revision,sourceKey:component.sourceKey,name:component.name,kind:component.kind,enabled,executor:"codex_host",self:false,stale:false,
          revision:prior?.sourceFingerprint===sourceFingerprint?prior.revision:(prior?.revision??0)+1,sourceFingerprint,availability:enabled?"host_only":"disabled",discovery:skill?"metadata_only":"schema_discovered",sourceChain:[component.path??component.serverName],discoveredAt:now()};
        this.repo.put("capability_sources",sourceId,componentSource);sourceIds.add(sourceId);
        const cap=this.putCapability({id:"cap_"+hash([context.id,component.sourceKey]).slice(0,24),contextId:context.id,contextRevision:context.revision,kind:skill?"skill":"mcp_tool",name:component.name,description:component.description,
          executor:"codex_host",availability:enabled?"host_only":"disabled",enabled:enabled?"enabled":"disabled",installation:"installed",
          ...(skill?{contentHash:component.contentHash,skillContent:component.content??null,...(component.dependencyHash?{dependencyHash:component.dependencyHash}:{})}:{inputSchema:component.tool.inputSchema,outputSchema:component.tool.outputSchema??null,tool:component.tool,serverName:component.serverName}),
          sourceRefs:[{sourceId,revision:componentSource.revision}],provenance:{hostReported:component.hostReported??!skill,path:component.path,freshAppServerSession:!skill,...parentIdentity}});capIds.add(cap.id);
      }
      if(depth==="metadata")for(const cap of this.contextCapabilities(context.id))if(cap.kind==="mcp_tool"&&cap.executor==="codex_host"&&cap.provenance?.serverSourceId&&!capIds.has(cap.id)) {
        const parent=this.repo.get("capability_sources",cap.provenance.serverSourceId);
        if(!parent||parent.stale||!parent.enabled||parent.sourceFingerprint!==cap.provenance.serverSourceFingerprint)this.putCapability({...cap,stale:true,...(!parent?.enabled?{enabled:"disabled",availability:"disabled"}:{})});
      }
      this.repo.tx(()=>{check();
        if(scan.issues.length===0) {
          for(const old of this.contextSources(context.id))if(!sourceIds.has(old.id)&&!(depth==="metadata"&&old.kind==="host_tool"&&old.contextRevision===context.revision)){this.repo.put("capability_sources",old.id,{...old,stale:true});changes.push({sourceId:old.id,name:old.name,change:"removed"});}
          for(const old of this.contextCapabilities(context.id))if(!capIds.has(old.id)&&
            (old.kind==="skill"||(old.executor==="codex_host"&&depth==="catalog")||(!sourceIds.has(old.sourceRefs[0]?.sourceId)&&!(depth==="metadata"&&old.executor==="codex_host"&&old.contextRevision===context.revision))||(depth==="catalog"&&this.repo.get("capability_sources",old.sourceRefs[0]?.sourceId)?.discovery==="schema_discovered")))this.putCapability({...old,stale:true});
        }
        update({status:scan.issues.length?"PARTIAL":"SUCCEEDED",coverage:scan.issues.length?"partial":"complete",issues:scan.issues,completedAt:now(),sources:this.contextSources(context.id),components:safeComponents,changes});
        this.catalog.replace(context,this.repo.get("discovery_jobs",scanId),this.contextSources(context.id),this.contextCapabilities(context.id));
      });
    }catch(e){controller.abort();const code=e instanceof HubError?e.code:"SOURCE_UNREADABLE";update({status:code==="DISCOVERY_CANCELLED"?"CANCELLED":["SCAN_SUPERSEDED","CONTEXT_CHANGED"].includes(code)?"PARTIAL":"FAILED",issues:[{code}],coverage:"partial",completedAt:now()});}
    finally{clearTimeout(timer);}
  }
  private contextSources(contextId:string):Json[]{return (this.repo.db.prepare("SELECT body FROM capability_sources WHERE json_extract(body,'$.contextId')=?").all(contextId) as {body:string}[]).map(r=>JSON.parse(r.body));}
  private contextCapabilities(contextId:string):Json[]{return (this.repo.db.prepare("SELECT body FROM capabilities WHERE json_extract(body,'$.contextId')=?").all(contextId) as {body:string}[]).map(r=>JSON.parse(r.body));}
  private discoveredSelf(discovered:Json) {
    const info=discovered.discovery?.discover?.serverInfo??discovered.discovery?.serverInfo??discovered.serverInfo;
    return info && (/^(?:flowhub|mcp-flowhub)$/i.test(info.name??"")||!!info.instanceId&&info.instanceId===this.identity.instanceId);
  }
  private connection(config:Json,sourceId:string,importSecrets:boolean,sourceFingerprint=hash(config)):Json {
    const policy=sourcePolicy(config);ensure(!policy.credentialArgs&&!policy.embeddedUrl&&!policy.unsupported,"CREDENTIAL_IMPORT_UNSUPPORTED","This source requires separate local connection configuration.");
    const refs:Json={};if(importSecrets)for(const [name,value] of Object.entries(config.env??{}))refs[name]=this.engine.vault.addSecret("Imported MCP variable "+name,String(value)).id;
    const url=config.url?new URL(config.url):null;
    return {id:"conn_"+hash([sourceId,sourceFingerprint]).slice(0,24),name:"Imported MCP",revision:1,transport:url?"streamable_http":"stdio",protocolEra:"auto",disabled:config.enabled===false,sourceFingerprint,
      ...(url?{endpoint:url.href,allowedHosts:[url.hostname]}:{command:config.command,args:config.args??[],envRefs:refs,commandApproved:true}),tools:[],sourceId};
  }
  search(a:Json={}) {
    a={query:"",...a};input("capability_search",a);
    if(["mcp_server","plugin"].includes(a.kind))return this.catalog.search(a);
    const limit=a.limit??20,fingerprint=hash({...a,cursor:undefined,limit:undefined}).slice(0,16);let after="",cursor:Json;
    if(a.cursor){try{cursor=JSON.parse(Buffer.from(a.cursor,"base64url").toString());ensure(cursor.f===fingerprint&&typeof cursor.a==="string","INPUT_INVALID","Cursor filter changed.");after=cursor.a;}catch{throw new HubError("INPUT_INVALID","Invalid capability cursor.");}}
    const where:string[]=[],params:Json[]=[];
    for(const field of ["contextId","kind","executor"])if(a[field]){where.push("json_extract(body,'$."+field+"')=?");params.push(a[field]);}
    if(a.sourceId){where.push("EXISTS(SELECT 1 FROM json_each(json_extract(body,'$.sourceRefs')) r WHERE json_extract(r.value,'$.sourceId')=?)");params.push(a.sourceId);}
    if(a.environment){where.push("EXISTS(SELECT 1 FROM bindings b WHERE json_extract(b.body,'$.sourceCapabilityId')=capabilities.id AND json_extract(b.body,'$.environment')=?)");params.push(a.environment);}
    for(const term of String(a.query).toLowerCase().split(/\s+/).filter(Boolean)){where.push("instr(lower(json_extract(body,'$.name')||' '||coalesce(json_extract(body,'$.description'),'')||' '||coalesce((SELECT json_extract(e.body,'$.searchText') FROM discovery_entities e WHERE e.id=capabilities.id),'')||' '||coalesce((SELECT json_extract(p.body,'$.displayName')||' '||coalesce(json_extract(p.body,'$.summary'),'') FROM discovery_entities e JOIN discovery_entities g ON g.id=json_extract(e.body,'$.pluginId') JOIN discovery_presentations p ON json_extract(p.body,'$.entityId')=g.id AND json_extract(p.body,'$.sourceFingerprint')=json_extract(g.body,'$.sourceFingerprint') WHERE e.id=capabilities.id ORDER BY p.revision DESC LIMIT 1),'')||' '||coalesce((SELECT json_extract(p.body,'$.displayName')||' '||coalesce(json_extract(p.body,'$.summary'),'')||' '||coalesce(json_extract(p.body,'$.description'),'') FROM discovery_presentations p JOIN discovery_entities e ON e.id=capabilities.id WHERE json_extract(p.body,'$.entityId')=capabilities.id AND json_extract(p.body,'$.sourceFingerprint')=json_extract(e.body,'$.sourceFingerprint') ORDER BY p.revision DESC LIMIT 1),'')),?)>0");params.push(term);}
    const clause=where.length?" WHERE "+where.join(" AND "):"";
    // Evaluate filters over large schema-bearing rows once, then reuse the small
    // identity set for both the cursor fingerprint and the bounded result page.
    const result=this.repo.db.prepare(`WITH filtered AS MATERIALIZED (
      SELECT id,revision,coalesce(json_extract(body,'$.stale'),0) AS stale FROM capabilities${clause}
    ) SELECT
      (SELECT group_concat(id||':'||revision||':'||stale) FROM (SELECT * FROM filtered ORDER BY id)) AS versions,
      (SELECT group_concat(id||':'||revision) FROM (
        SELECT p.id,p.revision FROM discovery_presentations p JOIN filtered f ON f.id=json_extract(p.body,'$.entityId') ORDER BY p.id
      )) AS presentations,
      (SELECT json_group_array(json(summary)) FROM (
        SELECT json_remove(c.body,'$.inputSchema','$.outputSchema','$.tool','$.skillContent') AS summary
        FROM capabilities c JOIN filtered f ON f.id=c.id WHERE c.id>? ORDER BY c.id LIMIT ?
      )) AS page`).get(...params,after,limit+1) as {versions:string|null;presentations:string|null;page:string};
    const snapshot=hash([result.versions??"",result.presentations??""]).slice(0,16);if(a.cursor)ensure(cursor!.s===snapshot,"CAPABILITY_STALE","Capability cursor snapshot changed.",409);
    const rows=JSON.parse(result.page) as Json[];
    const items=rows.slice(0,limit).map(value=>{const entity=this.repo.get("discovery_entities",value.id);return entity?{...value,discovery:this.catalog.present(entity)}:value;});
    return {items,nextCursor:rows.length>limit?Buffer.from(JSON.stringify({f:fingerprint,s:snapshot,a:items.at(-1).id})).toString("base64url"):null};
  }
  get(a:Json) {
    input("capability_get",a);const cap=a.revision?this.repo.get("capability_revisions",a.capabilityId+"@"+a.revision):this.repo.get("capabilities",a.capabilityId);
    if(!cap){const entity=this.repo.get("discovery_entities",a.capabilityId);if(entity&&["mcp_server","plugin"].includes(entity.entityKind)){ensure(!a.revision||a.revision===entity.revision,"CAPABILITY_STALE","Requested discovery revision is not current.",409);return this.catalog.get(a.capabilityId);}}
    ensure(cap,"NOT_FOUND","Capability missing.",404);const {inputSchema,outputSchema,tool,skillContent,...summary}=cap;
    return {...summary,...(a.includeSchemas?{inputSchema,outputSchema,tool}:{}),...(a.includeSkillContent?{skillContent:skillContent?.slice(0,32768),contentTruncated:(skillContent?.length??0)>32768}: {})};
  }
  async import(a:Json,owner="admin"):Promise<Json> {
    a={lockedArguments:{},...a};input("capability_import",a);const replay=this.replay(owner,"capability.import",a);if(replay)return replay;
    ensure(!this.closing,"SERVICE_CLOSING","Discovery is shutting down.",503);
    const key=hash([owner,a.idempotencyKey]),fingerprint=hash(a),existing=this.imports.get(key);
    if(existing){ensure(existing.fingerprint===fingerprint,"IDEMPOTENCY_CONFLICT","Key already used with different content.",409);return existing.work;}
    const work=this.prepareImport(a,owner).finally(()=>this.imports.delete(key));this.imports.set(key,{fingerprint,work});return work;
  }
  private async prepareImport(a:Json,owner:string) {
    const cap=this.repo.get("capabilities",a.capabilityId);ensure(cap&&!cap.stale&&cap.enabled==="enabled","CAPABILITY_STALE","Capability missing, disabled or stale.",409);
    ensure(cap.revision===a.expectedSourceRevision,"CAPABILITY_STALE","Review the current capability revision.",409);
    const context=this.repo.get("host_contexts",cap.contextId);ensure(context&&(!cap.contextRevision||context.revision===cap.contextRevision),"CAPABILITY_STALE","Context changed; rescan before importing.",409);
    if(a.target==="codex_host") {ensure(cap.executor!=="informational"&&["host_only","ready"].includes(cap.availability),"HOST_ONLY","Capability is unavailable to Codex.");return this.repo.command(owner,"capability.import",a.idempotencyKey,a,()=>({status:"host_reference",hostReference:{capabilityId:cap.id,revision:cap.revision,executor:"codex_host"}}));}
    ensure(cap.executor==="hub_direct","HOST_ONLY","Capability requires Codex.");
    const source=this.repo.get("capability_sources",cap.sourceRefs[0].sourceId);
    ensure(source&&!source.self,"SELF_REFERENCE_DENIED","FlowHub cannot be its own downstream.");
    ensure(source.enabled&&!source.stale&&source.revision===cap.sourceRefs[0].revision,"CAPABILITY_STALE","Source changed or disabled.",409);
    const config=await resolveSource(context,source.locator,{},this.options.hostRuntime);ensure(config&&hash(config)===source.sourceFingerprint,"CAPABILITY_STALE","Source configuration changed.",409);
    ensure(!selfSource({name:source.name,config},this.identity),"SELF_REFERENCE_DENIED","FlowHub cannot be its own downstream.");
    ensure(toolEnabled(config,cap.name),"CAPABILITY_STALE","Tool disabled by source policy.",409);
    const policy=sourcePolicy(config);ensure(!policy.credentialArgs&&!policy.embeddedUrl&&!policy.unsupported,"CREDENTIAL_IMPORT_UNSUPPORTED","Source requires separate local connection configuration.");
    const prepared=source.preparedConnectionId?this.repo.get("connections",source.preparedConnectionId):undefined,configured=prepared?.sourceFingerprint===source.sourceFingerprint;
    if(!configured&&policy.requiresCredentials)return {status:"configuration_required",missing:source.credentialVariables,reason:"Register credential references through local connection settings."};
    const connection=configured?prepared:this.connection(config,source.id,false,source.sourceFingerprint),discovered=await this.engine.connectors.discover(connection);
    ensure(!this.discoveredSelf(discovered),"SELF_REFERENCE_DENIED","FlowHub cannot be its own downstream.");
    const tool=discovered.tools.find((t:Json)=>t.name===cap.name);ensure(tool&&hash(tool.inputSchema)===hash(cap.inputSchema)&&hash(tool.outputSchema??null)===hash(cap.outputSchema??null),"CAPABILITY_STALE","Tool schema changed; rescan before importing.",409);
    return this.repo.command(owner,"capability.import",a.idempotencyKey,a,()=>{
      ensure(!this.closing&&this.repo.get("capabilities",cap.id)?.revision===cap.revision&&this.repo.get("host_contexts",context.id)?.revision===context.revision&&this.repo.get("capability_sources",source.id)?.revision===source.revision,"CAPABILITY_STALE","Source or capability changed while importing.",409);
      const tools=discovered.tools.filter((t:Json)=>toolEnabled(config,t.name)).sort((left:Json,right:Json)=>left.name.localeCompare(right.name)),catalogFingerprint=hash(tools);
      const connectionId="conn_"+hash([source.id,source.sourceFingerprint,connection.envRefs??{},connection.secretRef??null,discovered.protocolEra??null,catalogFingerprint]).slice(0,24);
      const previous=this.repo.get("connections",connectionId);
      const executionConnection={...discovered,id:connectionId,revision:1,verifiedRevision:1,tools,catalogFingerprint};
      if(previous)ensure(previous.catalogFingerprint===catalogFingerprint,"CAPABILITY_STALE","Stored catalog identity differs.",409);
      else this.repo.insert("connections",connectionId,executionConnection);
      const bindingId="binding_"+hash([source.id,connectionId,cap.id,cap.revision,a.environment,a.lockedArguments]).slice(0,24),binding={id:bindingId,revision:1,name:cap.name,connectionId,connectionRevision:(previous??executionConnection).revision,environment:a.environment,
        allowedTools:[cap.name],lockedArguments:a.lockedArguments,allowedQueryTemplates:[],simulationOnly:false,validationStatus:"UNVERIFIED",maxRows:100,timeoutSeconds:10,sourceCapabilityId:cap.id,sourceCapabilityRevision:cap.revision};
      if(!this.repo.get("bindings",bindingId))this.repo.insert("bindings",bindingId,binding);
      return {connectionId,bindingId,status:"configuration_required",reason:"Protocol catalog imported; independently verify the environment/resource binding before live publication."};
    });
  }
  async idle(){await Promise.allSettled(this.jobs.values());}
  async close(){this.closing=true;for(const controller of this.controls.values())controller.abort();await this.idle();await this.engine.connectors.closeDiscovery?.();await Promise.allSettled([...this.imports.values()].map(i=>i.work));}
}
