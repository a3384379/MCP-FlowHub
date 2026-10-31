import { useEffect, useState } from "react";
import type { Api } from "../../shared/v2";
export function ModelsPage({api}:{api:Api}) {
  const [profiles,setProfiles]=useState<any[]>([]),[current,setCurrent]=useState<any>(null),[name,setName]=useState(""),[kind,setKind]=useState("openai_responses"),[baseUrl,setBaseUrl]=useState("https://api.openai.com/v1"),[model,setModel]=useState(""),[key,setKey]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[probe,setProbe]=useState<any>(null);
  const load=()=>api("/api/v2/model-profiles").then(setProfiles);
  useEffect(()=>{void load().catch(e=>setError(e.message));},[]);
  const save=async()=>{setBusy(true);setError("");try{
    await api("/api/v2/model-profiles"+(current?"/"+current.id:""),current?"PATCH":"POST",{name,providerKind:kind,baseUrl,model,stream:true,...(key?{apiKey:key}:{}),...(current?{expectedRevision:current.revision}:{})});
    setKey("");setCurrent(null);setName("");await load();
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <section className="v2-page"><h1>模型设置</h1><p>选择明确的 API 协议。Key 保存到本机凭据库；未配置模型时，Codex、画布和 Mock 仍可使用。</p>
    {error&&<p className="banner error" role="alert">{error}</p>}
    <div className="v2-two-columns"><form className="panel" onSubmit={e=>{e.preventDefault();void save();}}>
      <h2>{current?"修改模型":"添加模型"}</h2>
      <label className="field">模型配置名称<input required value={name} onChange={e=>setName(e.target.value)}/></label>
      <label className="field">API 协议<select value={kind} onChange={e=>setKind(e.target.value)}><option value="openai_responses">OpenAI Responses</option><option value="openai_compatible_chat">OpenAI-compatible Chat Completions</option></select></label>
      <label className="field">Base URL<input required type="url" value={baseUrl} onChange={e=>setBaseUrl(e.target.value)}/></label>
      <label className="field">Model<input required value={model} onChange={e=>setModel(e.target.value)} placeholder="填写提供商实际模型标识"/></label>
      <label className="field">API Key<input type="password" autoComplete="off" value={key} onChange={e=>setKey(e.target.value)} placeholder={current?.keyConfigured?"已配置；留空保留原 Key":"只在此输入，不放入聊天"}/></label>
      <button className="primary" disabled={busy} type="submit">{busy?"保存中…":"保存模型"}</button>{current&&<button type="button" onClick={()=>{setCurrent(null);setKey("");}}>取消修改</button>}
    </form><div className="panel"><h2>已配置模型</h2>{!profiles.length?<p>尚未配置。可继续使用无 Key 功能。</p>:profiles.map(p=><article key={p.id} className="v2-model-card"><h3>{p.name}</h3><p>{p.providerKind} · {p.model} · {p.keyConfigured?"Key 已配置":"未配置 Key"}</p><div className="actions">
      <button onClick={()=>{setCurrent(p);setName(p.name);setKind(p.providerKind);setBaseUrl(p.baseUrl);setModel(p.model);setKey("");}}>编辑模型</button>
      <button disabled={busy} onClick={()=>{setBusy(true);void api("/api/v2/model-profiles/"+p.id+"/test","POST",{}).then(setProbe).then(load).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>测试文本 / 工具 / 流式</button>
      <button onClick={()=>void api("/api/v2/model-profiles/"+p.id,"DELETE").then(load).catch(e=>setError(e.message))}>删除模型</button></div>
      <pre>{JSON.stringify(p.capabilities,null,2)}</pre></article>)}{probe&&<div role="status"><h3>最近探测结果</h3><pre>{JSON.stringify(probe,null,2)}</pre></div>}</div></div>
  </section>;
}
