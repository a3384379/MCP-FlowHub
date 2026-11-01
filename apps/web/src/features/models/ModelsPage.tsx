import { useEffect, useRef, useState } from "react";
import type { Api } from "../../shared/v2";
import { useVaultState } from "../../shared/useVaultState";
import { VaultNotice } from "../settings/VaultNotice";
import { MODEL_SERVICES, OPENAI_BASE_URL, modelServiceId, modelErrorHint } from "../../../../../packages/contracts/src/model-services";

type Catalog = {models:{id:string;ownedBy:string|null;created:number|null;shutdownDate:string|null}[];endpoint:string;fetchedAt:string;docsUrl:string|null};
export function ModelsPage({api,onUnlockVault}:{api:Api;onUnlockVault:()=>void}) {
  const vault=useVaultState(api);
  const [profiles,setProfiles]=useState<any[]>([]),[current,setCurrent]=useState<any>(null);
  const [service,setService]=useState("openai"),[name,setName]=useState(""),[kind,setKind]=useState("openai_responses"),[baseUrl,setBaseUrl]=useState(OPENAI_BASE_URL),[model,setModel]=useState(""),[key,setKey]=useState("");
  const [modelDoc,setModelDoc]=useState<any>(null),[docBusy,setDocBusy]=useState(false);
  const [catalog,setCatalog]=useState<Catalog|null>(null),[catalogBusy,setCatalogBusy]=useState(false),[filter,setFilter]=useState(""),[manual,setManual]=useState(false);
  const [error,setError]=useState(""),[busy,setBusy]=useState(false),[probe,setProbe]=useState<any>(null),[timeoutMs,setTimeoutMs]=useState(180000),[stream,setStream]=useState(true),[maxRounds,setMaxRounds]=useState(12),[maxToolCalls,setMaxToolCalls]=useState(24),[taskTimeoutMs,setTaskTimeoutMs]=useState(180000),[maxCorrectionAttempts,setMaxCorrectionAttempts]=useState(3);
  const explain=(error:any)=>error?.code&&(error.code.startsWith("MODEL_")||error.code==="CREDENTIAL_LOCKED")?error.code+" · "+modelErrorHint(error.code):error.message;
  const generation=useRef(0),live=useRef(true);
  const load=()=>api("/api/v2/model-profiles").then(list=>{if(live.current)setProfiles(list);});
  useEffect(()=>{live.current=true;void load().catch(e=>setError(explain(e)));return()=>{live.current=false;generation.current++;};},[]);
  const invalidate=()=>{generation.current++;setCatalog(null);setCatalogBusy(false);setFilter("");setError("");};
  const chooseService=(id:string)=>{invalidate();setService(id);setKey("");setModel("");setManual(id==="custom");setKind(id==="openai"?"openai_responses":"openai_compatible_chat");setBaseUrl(id==="openai"?OPENAI_BASE_URL:"");};
  const edit=(profile:any)=>{invalidate();setCurrent(profile);setName(profile.name);const selected=profile.serviceId??modelServiceId(profile.baseUrl);setService(selected);setManual(selected==="custom");setKind(profile.providerKind);setBaseUrl(selected==="openai"?OPENAI_BASE_URL:profile.baseUrl);setModel(profile.model);setTimeoutMs(profile.timeoutMs??180000);setTaskTimeoutMs(profile.limits?.taskTimeoutMs??180000);setMaxRounds(profile.limits?.maxRounds??12);setMaxToolCalls(profile.limits?.maxToolCalls??24);setMaxCorrectionAttempts(profile.limits?.maxCorrectionAttempts??3);setStream(profile.stream!==false);setKey("");};
  const refreshModels=async()=>{const request=++generation.current;setCatalogBusy(true);setCatalog(null);setError("");try{
    const result=await api("/api/v2/model-catalog","POST",{serviceId:service,baseUrl,...(key?{apiKey:key}:{}),...(current?{profileId:current.id,expectedRevision:current.revision}:{})});
    if(!live.current||request!==generation.current)return;setCatalog(result);if(service==="custom")setManual(false);
  }catch(e){if(live.current&&request===generation.current)setError(explain(e));}finally{if(live.current&&request===generation.current)setCatalogBusy(false);}};
  const selected=catalog?.models.find(item=>item.id===model);
  const available=!!selected&&(!selected.shutdownDate||selected.shutdownDate>new Date().toISOString().slice(0,10));
  const save=async()=>{setBusy(true);setError("");try{
    if((service==="openai"||!manual)&&!available)throw new Error("请先从官方接口刷新模型列表，再选择可用模型。");
    const request=generation.current;
    await api("/api/v2/model-profiles"+(current?"/"+current.id:""),current?"PATCH":"POST",{name,serviceId:service,providerKind:kind,baseUrl,model,stream,timeoutMs,limits:{maxRounds,maxToolCalls,taskTimeoutMs,maxCorrectionAttempts},...(key?{apiKey:key}:{}),...(current?{expectedRevision:current.revision}:{})});
    if(!live.current||request!==generation.current)return;invalidate();setKey("");setCurrent(null);setName("");setModel("");await load();
  }catch(e){if(live.current)setError(explain(e));}finally{if(live.current)setBusy(false);}};
  useEffect(()=>{let current=true;setModelDoc(null);setDocBusy(false);if(service!=="openai"||!available||!model)return;
    setDocBusy(true);void api("/api/v2/model-docs?model="+encodeURIComponent(model)).then(result=>{if(current)setModelDoc(result);}).catch(()=>{if(current)setModelDoc({status:"unavailable"});}).finally(()=>{if(current)setDocBusy(false);});return()=>{current=false;};
  },[service,model,available]);
  const visibleModels=catalog?.models.filter(item=>item.id.toLowerCase().includes(filter.toLowerCase()))??[];
  const diagnostic=(value:any)=>typeof value==="object"&&value?Object.entries(value).map(([type,result]:[string,any])=><div key={type}><strong>{{text:"文本",tools:"工具调用",stream:"流式"}[type]??type}：{result?.status??"未知"}</strong>{result?.errorCode&&<p>{result.errorCode} · {modelErrorHint(result.errorCode)}{result.httpStatus?"（HTTP "+result.httpStatus+"）":""}</p>}</div>):null;
  return <section className="v2-page"><h1>模型设置</h1><p>选择模型服务后查询可用模型。API Key 保存在本机凭据库；Codex、画布和 Mock 不依赖此配置。</p>
    <VaultNotice vault={vault} unlock={onUnlockVault} />
    {error&&<p className="banner error" role="alert">{error}</p>}
    <div className="v2-two-columns"><form className="panel" onSubmit={e=>{e.preventDefault();void save();}}>
      <h2>{current?"修改模型":"添加模型"}</h2>
      <label className="field">模型服务<select aria-label="模型服务" disabled={busy} value={service} onChange={e=>chooseService(e.target.value)}>{MODEL_SERVICES.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {service==="openai"&&<p>使用 OpenAI API Key；ChatGPT/Codex 中显示的模型名称需以当前 API Key 的查询结果为准。</p>}
      <label className="field">模型配置名称<input required disabled={busy} value={name} onChange={e=>setName(e.target.value)}/></label>
      <label className="field">API 协议<select aria-label="API 协议" disabled={busy} value={kind} onChange={e=>{invalidate();setKind(e.target.value);}}><option value="openai_responses">OpenAI Responses</option><option value="openai_compatible_chat">OpenAI-compatible Chat Completions</option></select></label>
      <label className="field">Base URL<input required type="url" readOnly={service==="openai"} disabled={busy} value={baseUrl} onChange={e=>{invalidate();setBaseUrl(e.target.value);}}/></label>
      <small>请求会按所选协议使用 /responses 或 /chat/completions，完整接口地址也会自动归一化。</small>
      <label className="field">API Key<input type="password" disabled={busy} autoComplete="off" value={key} onChange={e=>{invalidate();setKey(e.target.value);}} placeholder={current?.keyConfigured?"已配置；留空保留原 Key":"只在此输入，不放入聊天"}/></label>
      <button type="button" disabled={busy||catalogBusy||(!key&&!current?.keyConfigured)||!baseUrl||(!key&&vault.locked!==false)} onClick={()=>void refreshModels()}>{catalogBusy?"正在查询模型…":"刷新可用模型"}</button>
      <p role="status">{catalogBusy?"正在请求模型服务目录…":catalog?"已从模型接口获取 "+catalog.models.length+" 个模型 · "+catalog.fetchedAt:"填写 API Key 或编辑已有配置后，刷新模型列表。"}</p>
      {service==="custom"&&<label><input type="checkbox" disabled={catalogBusy||busy} checked={manual} onChange={e=>setManual(e.target.checked)}/>输入自定义模型名称</label>}
      {manual&&service==="custom"?<label className="field">Model<input required disabled={catalogBusy||busy} value={model} onChange={e=>setModel(e.target.value)} placeholder="填写兼容服务实际模型标识"/></label>:<>
        <label className="field">搜索模型<input disabled={!catalog||busy} value={filter} onChange={e=>setFilter(e.target.value)}/></label>
        <label className="field">Model<select aria-label="Model" required disabled={busy||catalogBusy||!catalog} value={model} onChange={e=>setModel(e.target.value)}><option value="">请选择模型</option>{model&&!visibleModels.some(item=>item.id===model)&&<option value={model} disabled>{model}（当前配置，未在列表中）</option>}{visibleModels.map(item=><option value={item.id} disabled={!!item.shutdownDate&&item.shutdownDate<=new Date().toISOString().slice(0,10)} key={item.id}>{item.id}{item.shutdownDate?" · 停用日期 "+item.shutdownDate:""}</option>)}</select></label>
        {catalog&&!catalog.models.length&&<p>服务未返回可用模型，请检查 API 项目权限。</p>}
        {catalog&&model&&!selected&&<p className="banner">当前模型 {model} 不在这个 Key 的目录中，请重新选择；原配置尚未修改。</p>}
      </>}
      {selected&&<div className="panel"><strong>模型信息：{selected.id}</strong><p>归属：{selected.ownedBy??"官方接口未提供"} · 创建时间：{selected.created?new Date(selected.created*1000).toISOString():"未知"}</p>{selected.shutdownDate&&<p>停用日期：{selected.shutdownDate}</p>}{service==="openai"&&<><p>{docBusy?"正在查询官方模型参数…":modelDoc?.status==="available"?"以下参数来自当前模型的官方文档":"此模型的官方参数暂不可用，未知项不会填入默认值。"}</p>{modelDoc?.status==="available"&&<><p>上下文窗口：{modelDoc.contextWindow??"未知"} · 最大输入：{modelDoc.maxInputTokens??"未知"} · 最大输出：{modelDoc.maxOutputTokens??"未知"}</p><p>推理强度：{modelDoc.reasoningEfforts?.join(" / ")||"未知"} · 获取时间：{modelDoc.fetchedAt}</p>{kind==="openai_compatible_chat"&&modelDoc.chatToolsReasoningEffort&&<p className="banner">官方说明：此模型通过 Chat Completions 调用工具需要 reasoning_effort={modelDoc.chatToolsReasoningEffort}；建议使用 Responses 协议。</p>}</>}<a href={modelDoc?.sourceUrl??"https://developers.openai.com/api/docs/models/"+encodeURIComponent(model)} target="_blank" rel="noreferrer">OpenAI 官方模型与参数文档</a></>}<p>价格与完整限制请查看官方文档；工具与流式能力以连接测试为准。</p></div>}
      <label className="field">请求超时（毫秒）<input type="number" min={1000} max={300000} required value={timeoutMs} onChange={e=>setTimeoutMs(Number(e.target.value))}/></label>
      <label className="field">任务时限（毫秒）<input type="number" min={1000} max={300000} required value={taskTimeoutMs} onChange={e=>setTaskTimeoutMs(Number(e.target.value))}/></label>
      <label className="field">模型轮数上限<input type="number" min={1} max={12} required value={maxRounds} onChange={e=>setMaxRounds(Number(e.target.value))}/></label>
      <label className="field">工具调用上限<input type="number" min={1} max={24} required value={maxToolCalls} onChange={e=>setMaxToolCalls(Number(e.target.value))}/></label>
      <label className="field">校验尝试上限（含首次）<input type="number" min={1} max={3} required value={maxCorrectionAttempts} onChange={e=>setMaxCorrectionAttempts(Number(e.target.value))}/></label>
      <label className="field">流式回答<select value={String(stream)} onChange={e=>setStream(e.target.value==="true")}><option value="true">优先流式（探测失败后使用非流式）</option><option value="false">非流式</option></select></label>
      <button className="primary" disabled={busy||catalogBusy||vault.locked!==false||((service==="openai"||!manual)&&!available)} type="submit">{busy?"保存中…":"保存模型"}</button>{current&&<button type="button" disabled={busy} onClick={()=>{invalidate();setCurrent(null);setModel("");setKey("");setName("");}}>取消修改</button>}
    </form><div className="panel"><h2>已配置模型</h2><p>探测结果是上次测试的历史记录；当前能否使用还取决于凭据库是否解锁。</p>{!profiles.length?<p>尚未配置。可继续使用无 Key 功能。</p>:profiles.map(p=><article key={p.id} className="v2-model-card"><h3>{p.name}</h3><p>{(p.serviceId??modelServiceId(p.baseUrl))==="openai"?"OpenAI（ChatGPT）":"自定义兼容服务"} · {p.providerKind} · {p.model} · {p.keyConfigured?"Key 已配置":"未配置 Key"} · 请求超时 {p.timeoutMs} ms · 最近探测 {p.lastTestAt??"未测试"}</p><div className="actions">
      <button disabled={busy} onClick={()=>edit(p)}>编辑模型</button>
      <button disabled={busy||catalogBusy||vault.locked!==false} onClick={()=>{setBusy(true);setError("");void api("/api/v2/model-profiles/"+p.id+"/test","POST",{}).then(result=>{if(live.current)setProbe(result);}).then(load).catch(e=>{if(live.current)setError(explain(e));}).finally(()=>{if(live.current)setBusy(false);});}}>测试文本 / 工具 / 流式</button>
      <button disabled={busy} onClick={()=>void api("/api/v2/model-profiles/"+p.id,"DELETE").then(load).catch(e=>setError(explain(e)))}>删除模型</button></div>
      {diagnostic(p.capabilities)}</article>)}{probe&&<div role="status"><h3>最近探测结果（历史记录）</h3>{diagnostic(probe)}</div>}</div></div>
  </section>;
}
