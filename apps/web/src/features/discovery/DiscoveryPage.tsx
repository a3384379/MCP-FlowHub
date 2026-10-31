import { useEffect, useState } from "react";
type Api=(path:string,method?:string,body?:any,revision?:number)=>Promise<any>;
export function DiscoveryPage({api}:{api:Api}) {
  const [contexts,setContexts]=useState<any[]>([]),[contextId,setContextId]=useState(""),[scan,setScan]=useState<any>(null),[caps,setCaps]=useState<any[]>([]),[detail,setDetail]=useState<any>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[query,setQuery]=useState(""),[environment,setEnvironment]=useState("test"),[result,setResult]=useState<any>(null);
  const call=(path:string,method="GET",body?:any)=>api("/api/v2"+path,method,body);
  const search=async(id=contextId)=>{const data=await call("/capabilities?contextId="+encodeURIComponent(id)+"&query="+encodeURIComponent(query));setCaps(data.items);};
  const refresh=async(id:string,depth="metadata")=>{
    setBusy(true);setError("");try{
      const job=await call("/host-scans","POST",{contextId:id,depth,idempotencyKey:crypto.randomUUID()});setScan(job);
      let next;do {await new Promise(r=>setTimeout(r,250));next=await call("/host-scans/"+job.scanId);setScan(next);}while(!["SUCCEEDED","PARTIAL","FAILED","CANCELLED"].includes(next.status));
      await search(id);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  useEffect(()=>{let live=true;void(async()=>{try{
    let list=await call("/host-contexts");if(!list.length)list=[await call("/host-contexts","POST",{})];if(!live)return;setContexts(list);setContextId(list[0].id);await refresh(list[0].id);
  }catch(e){if(live)setError((e as Error).message);}})();return()=>{live=false;};},[]);
  return <section className="v2-discovery">
    <h1>Codex 发现</h1><p>读取已登记本机上下文，保留来源与可用性。元数据扫描不调用业务工具。</p>
    <div className="panel"><label className="field">本机上下文<select value={contextId} onChange={e=>{setContextId(e.target.value);void refresh(e.target.value);}}>{contexts.map(c=><option key={c.id} value={c.id}>{c.executionLocation} · {c.codexVersion??"仅配置"} · {c.canonicalCwd}</option>)}</select></label>
    <div className="actions"><button disabled={busy||!contextId} onClick={()=>void refresh(contextId)}>重新扫描</button><button disabled={busy||!contextId} onClick={()=>void refresh(contextId,"catalog")}>连接并同步工具</button></div>
    <p role="status" aria-live="polite">{busy?"正在扫描…":scan?.status??"尚未扫描"} · 来源覆盖：{scan?.coverage??"未知"} · {scan?.resolutionQuality??"未知"}</p></div>
    {error&&<p role="alert">{error}</p>}
    {!!scan?.issues?.length&&<div className="banner">部分来源需要处理：{scan.issues.map((i:any)=>i.code).join("、")}</div>}
    <div className="panel"><h2>来源与已安装组件</h2>{!scan?.sources&&!scan?.components?<p>来源数量未知，等待扫描。</p>:<ul>{[...(scan.sources??[]),...(scan.components??[])].map((s:any)=><li key={s.id??s.sourceKey}><strong>{s.name}</strong> · {s.kind} · {s.enabled?"启用":"禁用"} · {s.self?"FlowHub 自身，禁止导入":s.executor??"codex_host"} · {s.availability??"宿主能力"}{s.stale?" · 来源已失效":""}</li>)}</ul>}</div>
    <div className="panel"><h2>MCP 能力目录</h2><label className="field">搜索能力<input value={query} onChange={e=>setQuery(e.target.value)}/></label><button onClick={()=>void search().catch(e=>setError(e.message))}>搜索</button>
    {!caps.length?<p>尚无匹配能力。MCP 工具 Schema 需要“连接并同步工具”。</p>:caps.map(c=><div className="row" key={c.id}><span>{c.name} · {c.kind} · {c.executor} · {c.availability} · r{c.revision}</span><button onClick={()=>void call("/capabilities/"+c.capabilityId+"?includeSchemas=true").then(setDetail).catch(e=>setError(e.message))}>查看能力</button><button disabled={c.stale||c.enabled==="disabled"} onClick={()=>void call("/capabilities/"+c.capabilityId+"/import","POST",{expectedSourceRevision:c.revision,target:c.executor==="hub_direct"?"hub_direct":"codex_host",environment,lockedArguments:{},idempotencyKey:crypto.randomUUID()}).then(setResult).catch(e=>setError(e.message))}>{c.executor==="hub_direct"?"导入连接":"用于 Codex 流程"}</button></div>)}
    <label className="field">导入固定环境<select value={environment} onChange={e=>setEnvironment(e.target.value)}><option value="test">测试</option><option value="staging">试运行</option><option value="production">生产</option></select></label>
    {result&&<pre style={{overflow:"auto",maxHeight:260}}>{JSON.stringify(result,null,2)}</pre>}
    {detail&&<div><h3>{detail.name} · 实际 Schema 与来源</h3><pre style={{overflow:"auto",maxHeight:360}}>{JSON.stringify(detail,null,2)}</pre><button onClick={()=>setDetail(null)}>关闭详情</button></div>}</div>
  </section>;
}
