import { useEffect, useState } from "react";
import type { Api } from "../../shared/v2";
export function TestingPanel({api,workflowId,revision}:{api:Api;workflowId:string;revision:number}) {
  const [suite,setSuite]=useState<any>(null),[test,setTest]=useState<any>(null),[error,setError]=useState(""),[editing,setEditing]=useState(false),[fixtures,setFixtures]=useState(""),[busy,setBusy]=useState(false);
  const call=(path:string,method="GET",body?:any)=>api("/api/v2"+path,method,body);
  useEffect(()=>{let live=true;setSuite(null);setTest(null);void call("/workflows/"+workflowId+"/test-suites").then(async list=>{if(list.length){const latest=await call("/test-suites/"+list.at(-1).id);if(live){setSuite(latest);setFixtures(JSON.stringify(latest.cases,null,2));}}}).catch(e=>setError(e.message));return()=>{live=false;};},[workflowId]);
  useEffect(()=>{if(!test?.testRunId)return;let live=true;const timer=setInterval(()=>{void call("/test-runs/"+test.testRunId).then(next=>{if(live)setTest({...next,testRunId:next.id});if(!["QUEUED","RUNNING"].includes(next.status))clearInterval(timer);}).catch(e=>{if(live)setError(e.message);clearInterval(timer);});},300);return()=>{live=false;clearInterval(timer);};},[test?.testRunId,revision,suite?.suiteRevision]);
  const stale=!!test&&(test.stale||test.draftRevision!==undefined&&test.draftRevision!==revision||test.suiteRevision!==undefined&&suite&&test.suiteRevision!==suite.suiteRevision);
  const act=async(fn:()=>Promise<void>)=>{setBusy(true);setError("");try{await fn();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <section className="panel v2-testing" aria-label="工作流自测"><h2>工作流自测</h2><p>草稿 r{revision} · {suite?"套件 r"+suite.suiteRevision:"尚无套件"} · 默认 Mock，不访问真实业务服务</p>
    {suite?.draftRevision!==undefined&&suite.draftRevision!==revision&&<p className="banner">测试基线已过期：请重新生成用例。</p>}
    {error&&<p className="banner error" role="alert">{error}</p>}
    <div className="actions"><button disabled={busy} onClick={()=>void act(async()=>{const created=await call("/workflows/"+workflowId+"/test-suites","POST",{expectedRevision:revision,strategy:"deterministic",idempotencyKey:crypto.randomUUID()});const next=await call("/test-suites/"+created.suiteId);setSuite(next);setFixtures(JSON.stringify(next.cases,null,2));setTest(null);})}>生成用例</button>
    <button disabled={busy||!suite||suite.draftRevision!==revision||["QUEUED","RUNNING"].includes(test?.status)} onClick={()=>void act(async()=>setTest(await call("/test-suites/"+suite.id+"/runs","POST",{expectedSuiteRevision:suite.suiteRevision,mode:"mock",idempotencyKey:crypto.randomUUID()})))}>运行 Mock</button>
    <button disabled={!suite||busy} onClick={()=>setEditing(old=>!old)}>编辑夹具与断言</button></div>
    {editing&&<div><label className="field">合成用例 JSON<textarea rows={12} value={fixtures} onChange={e=>setFixtures(e.target.value)}/></label><button disabled={busy} onClick={()=>void act(async()=>{const updated=await call("/test-suites/"+suite.id,"PUT",{cases:JSON.parse(fixtures),expectedRevision:revision,expectedSuiteRevision:suite.suiteRevision,idempotencyKey:crypto.randomUUID()});setSuite(await call("/test-suites/"+updated.suiteId));setEditing(false);})}>保存夹具</button></div>}
    {suite&&<ul>{suite.cases.map((c:any)=><li key={c.id}>{c.name} · {c.assertions.length} 项独立断言</li>)}</ul>}
    {test&&<div aria-live="polite"><p>实际自测状态：{test.status}{stale?" · 基线已过期":""}</p><pre>{JSON.stringify(test.summary,null,2)}</pre>{test.cases?.map((c:any)=><details key={c.id}><summary>{c.name} · {c.status} · {c.errorCode??""}</summary><pre>{JSON.stringify({assertions:c.assertions,trace:c.trace,outputs:c.outputs},null,2)}</pre></details>)}{!!test.gaps?.length&&<p>缺口：{JSON.stringify(test.gaps)}</p>}</div>}
  </section>;
}
