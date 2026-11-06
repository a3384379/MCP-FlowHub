import { useEffect, useRef, useState } from "react";
import type { Api } from "../../shared/v2";
import "./testing.css";

type Mode="mock"|"contract"|"live";
const active=(task:any)=>!!task&&["QUEUED","RUNNING","GENERATING","CALLING_TOOL","CANCEL_REQUESTED"].includes(task.status);
const modeName=(mode:Mode)=>({mock:"Mock（合成运行）",contract:"Contract（协议契约）",live:"Live（真实调用）"}[mode]??"未知验证级别");
export function TestingPanel({api,workflowId,revision}:{api:Api;workflowId:string;revision:number}) {
  const [suite,setSuite]=useState<any>(null),[test,setTest]=useState<any>(null),[generationTask,setGenerationTask]=useState<any>(null);
  const [error,setError]=useState(""),[editing,setEditing]=useState(false),[fixtures,setFixtures]=useState(""),[busy,setBusy]=useState(false);
  const [mode,setMode]=useState<Mode>("mock"),[strategy,setStrategy]=useState("deterministic"),[profiles,setProfiles]=useState<any[]>([]),[modelProfileId,setModelProfileId]=useState(""),[hints,setHints]=useState("");
  const [bindings,setBindings]=useState<any[]>([]),[allowedBindingIds,setAllowedBindingIds]=useState<string[]>([]),[caseIds,setCaseIds]=useState<string[]>([]),[maxCalls,setMaxCalls]=useState(1),[timeoutMs,setTimeoutMs]=useState(10000);
  const epoch=useRef(0),initialLoad=useRef(0),mounted=useRef(false),pending=useRef(new Map<string,string>());
  const call=(path:string,method="GET",body?:any)=>api("/api/v2"+path,method,body);
  const acceptSuite=(next:any)=>{setSuite(next);setFixtures(JSON.stringify(next.cases,null,2));setCaseIds([]);setEditing(false);};
  const signatureFor=(kind:string,body:any)=>JSON.stringify({kind,workflowId,body});
  const requestKey=(kind:string,body:any)=>{const signature=signatureFor(kind,body);if(!pending.current.has(signature))pending.current.set(signature,crypto.randomUUID());return pending.current.get(signature)!;};
  const finishRequest=(kind:string,body:any)=>pending.current.delete(signatureFor(kind,body));
  useEffect(()=>{
    const request=++epoch.current,load=++initialLoad.current;mounted.current=true;pending.current.clear();
    setSuite(null);setTest(null);setGenerationTask(null);setError("");setEditing(false);setFixtures("");setBusy(false);setMode("mock");setStrategy("deterministic");setProfiles([]);setModelProfileId("");setBindings([]);setAllowedBindingIds([]);setCaseIds([]);setHints("");
    void Promise.all([call("/workflows/"+encodeURIComponent(workflowId)+"/test-suites"),call("/workflows/"+encodeURIComponent(workflowId)+"/test-runs")]).then(async([list,runs])=>{
      const ordered=[...list].sort((a:any,b:any)=>(a.updatedAt??a.createdAt??"").localeCompare(b.updatedAt??b.createdAt??""));
      const latest=ordered.length?await call("/test-suites/"+encodeURIComponent(ordered.at(-1).id)):null;
      if(!mounted.current||request!==epoch.current||load!==initialLoad.current)return;
      if(latest)acceptSuite(latest);
      const generations=runs.filter((run:any)=>run.kind==="generation"),tests=runs.filter((run:any)=>run.kind!=="generation");
      const savedGeneration=generations.find(active)??generations[0],savedTest=tests.find(active)??tests[0];
      if(savedGeneration)setGenerationTask({...savedGeneration,testRunId:savedGeneration.id,needsRefresh:true,adoptSuiteOnSuccess:active(savedGeneration)||!latest||savedGeneration.suiteId===latest.id});
      if(savedTest)setTest({...savedTest,testRunId:savedTest.id,needsRefresh:true});
    }).catch(e=>{if(mounted.current&&request===epoch.current&&load===initialLoad.current)setError(e.message);});
    return()=>{mounted.current=false;epoch.current++;};
  },[workflowId]);
  useEffect(()=>{
    let live=true;setAllowedBindingIds([]);
    void Promise.all([call("/workflows/"+encodeURIComponent(workflowId)+"/draft"),api("/bindings")]).then(([draft,all])=>{
      if(!live)return;const referenced=new Set<string>(draft.draft.nodes.filter((node:any)=>node.type==="mcp_tool").map((node:any)=>draft.draft.bindings[node.config.bindingKey]).filter((id:any)=>typeof id==="string"));
      setBindings([...referenced].map(id=>all.find((binding:any)=>binding.id===id)??{id,missing:true}));
    }).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};
  },[workflowId,revision]);
  useEffect(()=>{
    if(strategy!=="ai_assisted")return;let live=true;
    void call("/model-profiles").then(list=>{if(live)setProfiles(list.filter((profile:any)=>!profile.disabled));}).catch(e=>{if(live)setError(e.message);});
    return()=>{live=false;};
  },[strategy,workflowId]);
  useEffect(()=>{
    if(!test?.testRunId||!active(test)&&!test.needsRefresh)return;
    let live=true,timer:ReturnType<typeof setTimeout>|undefined;
    const poll=async()=>{try{
      const next=await call("/test-runs/"+encodeURIComponent(test.testRunId));
      if(!live)return;setTest((previous:any)=>previous?.testRunId===next.id&&!active(previous)&&active(next)?previous:{...next,testRunId:next.id});
      if(active(next))timer=setTimeout(()=>void poll(),300);
    }catch(e){if(live){setError((e as Error).message);timer=setTimeout(()=>void poll(),1000);}}};
    void poll();return()=>{live=false;clearTimeout(timer);};
  },[test?.testRunId,workflowId]);
  useEffect(()=>{
    if(!generationTask?.testRunId||!active(generationTask)&&!generationTask.needsRefresh)return;
    let live=true,timer:ReturnType<typeof setTimeout>|undefined;
    const poll=async()=>{try{
      const next=await call("/test-runs/"+encodeURIComponent(generationTask.testRunId));
      if(!live)return;setGenerationTask((previous:any)=>previous?.testRunId===next.id&&!active(previous)&&active(next)?previous:{...next,testRunId:next.id});
      if(active(next))timer=setTimeout(()=>void poll(),300);
      else if(next.status==="SUCCEEDED"&&next.suiteId&&generationTask.adoptSuiteOnSuccess!==false){const generated=await call("/test-suites/"+encodeURIComponent(next.suiteId));if(live){acceptSuite(generated);setTest((previous:any)=>active(previous)||previous?.suiteId===generated.id?previous:null);}}
    }catch(e){if(live){setError((e as Error).message);timer=setTimeout(()=>void poll(),1000);}}};
    void poll();return()=>{live=false;clearTimeout(timer);};
  },[generationTask?.testRunId,workflowId]);
  const currentProfile=profiles.find(profile=>profile.id===modelProfileId),running=active(test)||active(generationTask),locked=busy||running;
  const stale=!!test&&(test.stale||suite&&test.suiteId!==undefined&&test.suiteId!==suite.id||test.draftRevision!==undefined&&test.draftRevision!==revision||test.suiteRevision!==undefined&&suite&&test.suiteRevision!==suite.suiteRevision);
  const validBudget=Number.isInteger(maxCalls)&&maxCalls>=1&&maxCalls<=50&&Number.isInteger(timeoutMs)&&timeoutMs>=1000&&timeoutMs<=60000;
  const missingScope=mode!=="mock"&&(!allowedBindingIds.length||!validBudget)||mode==="live"&&!caseIds.length;
  const act=async(fn:(request:number)=>Promise<void>)=>{const request=epoch.current;initialLoad.current++;setBusy(true);setError("");try{await fn(request);}catch(e){if(mounted.current&&request===epoch.current)setError((e as Error).message);}finally{if(mounted.current&&request===epoch.current)setBusy(false);}};
  const changeMode=(next:Mode)=>{setMode(next);setAllowedBindingIds([]);setCaseIds([]);setError("");};
  const toggle=(values:string[],id:string,checked:boolean)=>checked?[...values.filter(value=>value!==id),id]:values.filter(value=>value!==id);
  const generate=()=>void act(async request=>{
    const body={expectedRevision:revision,strategy,...(strategy==="ai_assisted"?{modelProfileId,expectedModelRevision:currentProfile.revision,scenarioHints:hints.split("\n").map(line=>line.trim()).filter(Boolean)}:{})};
    const created=await call("/workflows/"+encodeURIComponent(workflowId)+"/test-suites","POST",{...body,idempotencyKey:requestKey("generate",body)});
    if(!mounted.current||request!==epoch.current)return;
    if(created.testRunId){finishRequest("generate",body);setGenerationTask({...created,testRunId:created.testRunId});return;}
    const next=await call("/test-suites/"+encodeURIComponent(created.suiteId));
    if(mounted.current&&request===epoch.current){finishRequest("generate",body);acceptSuite(next);setGenerationTask(null);setTest(null);}
  });
  const run=()=>void act(async request=>{
    const selected=suite.cases.filter((c:any)=>caseIds.includes(c.id));
    const body={expectedSuiteRevision:suite.suiteRevision,mode,...(mode!=="mock"?{allowedBindingIds,budgets:{maxCalls,timeoutMs}}:{}),...(mode==="live"?{caseIds:selected.map((c:any)=>c.id),inputScope:{fixtureHash:suite.fixtureHash,caseInputs:selected.map((c:any)=>({caseId:c.id,inputs:c.inputs}))}}:{})};
    const accepted=await call("/test-suites/"+encodeURIComponent(suite.id)+"/runs","POST",{...body,idempotencyKey:requestKey("run",body)});
    if(mounted.current&&request===epoch.current){finishRequest("run",body);setTest({...accepted,mode,suiteId:suite.id,draftRevision:suite.draftRevision,suiteRevision:suite.suiteRevision});}
  });
  const cancel=(task:any,generation:boolean)=>void act(async request=>{const next=await call("/test-runs/"+encodeURIComponent(task.testRunId)+"/cancel","POST",{});if(mounted.current&&request===epoch.current){const updated={...task,...next,testRunId:task.testRunId};if(generation)setGenerationTask(updated);else setTest(updated);}});
  return <section className="panel v2-testing" aria-label="工作流自测"><h2>工作流自测</h2><p>草稿 r{revision} · {suite?"套件 r"+suite.suiteRevision:"尚无套件"} · 默认 Mock，不访问真实业务服务</p>
    {suite?.draftRevision!==undefined&&suite.draftRevision!==revision&&<p className="banner">测试基线已过期：请重新生成用例。</p>}
    {error&&<p className="banner error" role="alert">{error}</p>}
    <div className="testing-controls"><label className="field">用例生成方式<select aria-label="用例生成方式" value={strategy} disabled={locked} onChange={e=>{setStrategy(e.target.value);setModelProfileId("");setError("");}}><option value="deterministic">确定性生成（无需模型 Key）</option><option value="ai_assisted">AI 辅助生成</option></select></label>
      {strategy==="ai_assisted"&&<><label className="field">生成使用模型<select aria-label="生成使用模型" disabled={locked} value={modelProfileId} onChange={e=>setModelProfileId(e.target.value)}><option value="">请选择已配置模型</option>{profiles.map(profile=><option key={profile.id} value={profile.id} disabled={!profile.keyConfigured}>{profile.name} · {profile.model}{!profile.keyConfigured?"（未配置 Key）":""}</option>)}</select></label><label className="field">生成场景提示（每行一项）<textarea aria-label="生成场景提示（每行一项）" rows={3} disabled={locked} value={hints} onChange={e=>setHints(e.target.value)}/><small>最多 50 项，每项最多 256 个字符；不填写 Key 或连接凭据。</small></label><p>生成仅提出合成用例，不执行业务调用；通过 Schema 校验后保存套件，测试结果仍由独立断言器产生。Key 不会发送到页面。</p>{!profiles.length&&<p>尚无可用模型配置。可在“模型设置”添加，也可继续确定性生成。</p>}</>}
    </div>
    <div className="actions"><button disabled={locked||strategy==="ai_assisted"&&(!currentProfile?.keyConfigured||hints.split("\n").filter(line=>line.trim()).length>50||hints.split("\n").some(line=>line.trim().length>256))} onClick={generate}>生成用例</button><button disabled={!suite||locked} onClick={()=>setEditing(old=>!old)}>编辑夹具与断言</button></div>
    {generationTask&&<div className="testing-task" aria-live="polite"><p>用例生成任务：{generationTask.status}</p><p>生成成功表示用例已保存，不等于自测通过或模型效果验收通过。</p>{generationTask.errorCode&&<p className="error">{generationTask.errorCode}{generationTask.message?" · "+generationTask.message:""}</p>}{active(generationTask)&&<button disabled={busy} onClick={()=>cancel(generationTask,true)}>取消用例生成</button>}</div>}
    {editing&&<div><label className="field">合成用例 JSON<textarea aria-label="合成用例 JSON" rows={12} value={fixtures} disabled={locked} onChange={e=>setFixtures(e.target.value)}/></label><button disabled={locked} onClick={()=>void act(async request=>{const body={cases:JSON.parse(fixtures),expectedRevision:revision,expectedSuiteRevision:suite.suiteRevision};const updated=await call("/test-suites/"+encodeURIComponent(suite.id),"PUT",{...body,idempotencyKey:requestKey("edit",body)});const next=await call("/test-suites/"+encodeURIComponent(updated.suiteId));if(mounted.current&&request===epoch.current){finishRequest("edit",body);acceptSuite(next);}})}>保存夹具</button></div>}
    {suite&&<ul>{suite.cases.map((c:any)=><li key={c.id}>{c.name} · {c.assertions.length} 项独立断言</li>)}</ul>}
    <label className="field">验证级别<select aria-label="验证级别" value={mode} disabled={locked} onChange={e=>changeMode(e.target.value as Mode)}><option value="mock">Mock（合成运行）</option><option value="contract">Contract（协议契约）</option><option value="live">Live（真实调用）</option></select></label>
    <p className="testing-mode-note">{mode==="mock"?"使用隔离库和合成夹具，不读取真实连接凭据，不调用真实业务工具。":mode==="contract"?"仅对所选绑定协商 MCP 协议、读取工具目录并检查 Schema；不执行用例和业务工具，不证明业务结果或只读权限。":"会按当前套件的选定输入调用所选真实 MCP 绑定。只允许已列出的绑定、输入及预算；不会使用 Mock 结果冒充真实输出。"}</p>
    {mode!=="mock"&&<fieldset className="testing-scope" disabled={locked}><legend>本次{mode==="live"?"真实调用":"协议验证"}范围</legend>
      <fieldset><legend>目标 MCP 绑定</legend>{bindings.length?bindings.map(binding=><label className="testing-choice" key={binding.id}><input type="checkbox" checked={allowedBindingIds.includes(binding.id)} disabled={binding.missing} onChange={e=>setAllowedBindingIds(toggle(allowedBindingIds,binding.id,e.target.checked))}/><span>{binding.name??binding.id} · {binding.environment??"未知环境"}{binding.missing?"（绑定缺失）":""}</span></label>):<p>当前草稿没有 MCP 绑定，可先使用 Mock 或在画布配置绑定。</p>}</fieldset>
      <div className="testing-budgets"><label className="field">最大调用次数<input aria-label="最大调用次数" type="number" min={1} max={50} value={maxCalls} onChange={e=>setMaxCalls(Number(e.target.value))}/></label><label className="field">本次超时（毫秒）<input aria-label="本次超时（毫秒）" type="number" min={1000} max={60000} value={timeoutMs} onChange={e=>setTimeoutMs(Number(e.target.value))}/></label></div>
      {mode==="live"&&<fieldset><legend>允许的用例输入</legend>{suite?.cases.map((c:any)=><div key={c.id}><label className="testing-choice"><input type="checkbox" checked={caseIds.includes(c.id)} onChange={e=>setCaseIds(toggle(caseIds,c.id,e.target.checked))}/><span>{c.name} · {c.id}</span></label>{caseIds.includes(c.id)&&<pre aria-label={"输入范围："+c.name}>{JSON.stringify(c.inputs,null,2)}</pre>}</div>)}<p>输入范围来自当前套件的已保存用例，只读展示；修改输入需先编辑并保存套件，再重新选择。</p></fieldset>}
      {!validBudget&&<p className="error">调用次数须为 1–50，超时须为 1000–60000 毫秒。</p>}
    </fieldset>}
    <div className="actions"><button disabled={locked||!suite||suite.draftRevision!==revision||missingScope} onClick={run}>{mode==="mock"?"运行 Mock":mode==="contract"?"验证协议契约":"运行 Live"}</button>{active(test)&&<button disabled={busy} onClick={()=>cancel(test,false)}>取消自测</button>}</div>
    {test&&<div aria-live="polite"><p>实际自测状态：{test.status}{stale?" · 基线已过期":""}</p><p>实际验证级别：{modeName(test.mode??"mock")} · 来源：{test.provenance??"等待结果"} · 真实工具调用：{test.toolCalls??(test.mode==="mock"?0:"未知")} · 目录检查：{test.catalogChecks??(test.mode==="mock"?0:"未知")} · 凭据读取统计：{test.credentialReadAccounting==="not_instrumented"?"未计量":test.realSecretReads??"未知"}</p>{test.mode==="contract"&&<p>协议契约结果不等于数据流自测或真实业务权限验证。</p>}{test.errorCode&&<p className="error">{test.errorCode}</p>}{test.outcomeUnknown&&<p className="banner error">已派发调用的远端结果未知；取消仅停止本地后续执行，不会自动重试。</p>}<pre>{JSON.stringify(test.summary,null,2)}</pre>{test.mode==="contract"&&<details><summary>协议目录证据</summary><pre>{JSON.stringify(test.schemaChecks??test.catalogs??test.catalog??test.contractEvidence??test.evidence??test.cases,null,2)}</pre></details>}{test.cases?.map((c:any)=><details key={c.id}><summary>{c.name} · {c.status} · {c.errorCode??""}</summary><pre>{JSON.stringify({assertions:c.assertions,trace:c.trace,outputs:c.outputs},null,2)}</pre></details>)}{!!test.gaps?.length&&<p>缺口：{JSON.stringify(test.gaps)}</p>}</div>}
  </section>;
}
