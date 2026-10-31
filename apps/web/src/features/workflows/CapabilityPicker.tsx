import { useEffect, useState } from "react";
import type { Api } from "../../shared/v2";
export function CapabilityPicker({api,draft,selected}:{api:Api;draft:any;selected:string|null}) {
  const [caps,setCaps]=useState<any[]>([]),[query,setQuery]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const load=()=>api("/api/v2/capabilities?executor=hub_direct&query="+encodeURIComponent(query)).then(data=>setCaps(data.items));
  useEffect(()=>{void load().catch(e=>setError(e.message));},[]);
  const add=async(cap:any)=>{setBusy(true);setError("");try{
    const bindings=await api("/bindings");let binding=bindings.find((b:any)=>b.sourceCapabilityId===cap.id&&b.environment===draft.draft.environment);
    if(!binding){const result=await api("/api/v2/capabilities/"+cap.id+"/import","POST",{expectedSourceRevision:cap.revision,target:"hub_direct",environment:draft.draft.environment,lockedArguments:{},idempotencyKey:crypto.randomUUID()});if(!result.bindingId)throw new Error("连接仍需配置："+result.reason);binding={id:result.bindingId};}
    const anchor=selected??draft.draft.nodes.find((n:any)=>n.type==="input").id,edge=draft.draft.edges.find((e:any)=>e.source===anchor&&e.port==="next");if(!edge)throw new Error("请选择有下一步的串行节点作为插入位置");
    const nodeId="tool-"+crypto.randomUUID().slice(0,8),key="role-"+crypto.randomUUID().slice(0,8);
    await api("/api/v2/workflows/"+draft.id+"/operations","POST",{expectedRevision:draft.revision,idempotencyKey:crypto.randomUUID(),operations:[{op:"set_binding",key,bindingId:binding.id},{op:"add_node",nodeId,nodeType:"mcp_tool",title:cap.name,capabilityRef:{capabilityId:cap.id,revision:cap.revision},config:{bindingKey:key,argumentsMappings:{}}},{op:"disconnect",source:edge.source,target:edge.target,port:edge.port},{op:"connect",source:anchor,target:nodeId,port:"next"},{op:"connect",source:nodeId,target:edge.target,port:"next"}]},draft.revision);
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <div className="v2-capability-picker"><h3>已发现能力</h3><label className="field">查找工具<input value={query} onChange={e=>setQuery(e.target.value)}/></label><button onClick={()=>void load().catch(e=>setError(e.message))}>搜索能力</button>{error&&<p role="alert">{error}</p>}{!caps.length?<p>先到 Codex 发现同步目录。</p>:caps.map(c=><button disabled={busy||c.stale} key={c.id} onClick={()=>void add(c)}>{c.name}<small>添加到当前画布 · r{c.revision}</small></button>)}</div>;
}
