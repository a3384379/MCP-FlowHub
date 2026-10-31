import { useEffect,useRef,useState } from "react";
import { subscribeEvents,type Api } from "../../shared/v2";
export function RunAnalysisControl({api,run}:{api:Api;run:any}) {
  const [profiles,setProfiles]=useState<any[]>([]),[profile,setProfile]=useState(""),[error,setError]=useState(""),[task,setTask]=useState<any>(null),[submitting,setSubmitting]=useState(false);
  const taskRef=useRef<any>(null),keyRef=useRef<string|null>(null),epoch=useRef(0),statusRequest=useRef(0),mounted=useRef(true),scopeRef=useRef("");
  taskRef.current=task;scopeRef.current=JSON.stringify([run.runId,run.checkpoint?.id]);
  const taskId=()=>taskRef.current?.id??taskRef.current?.taskId;
  const current=(generation:number,scope:string,id?:string)=>mounted.current&&generation===epoch.current&&scope===scopeRef.current&&(!id||id===taskId());
  const adopt=(next:any)=>{statusRequest.current++;taskRef.current=next;setTask(next);};
  const refresh=async(id:string,generation:number,scope:string)=>{const request=++statusRequest.current;try{
    const next=await api("/api/v2/assistant/tasks/"+id);if(request===statusRequest.current&&current(generation,scope,id))adopt(next);
  }catch(e){if(request===statusRequest.current&&current(generation,scope,id))setError((e as Error).message);}};
  useEffect(()=>{let live=true;void api("/api/v2/model-profiles").then(list=>{if(!live)return;const enabled=list.filter((p:any)=>!p.disabled);setProfiles(enabled);setProfile(enabled[0]?.id??"");}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[]);
  useEffect(()=>{epoch.current++;adopt(null);setError("");setSubmitting(false);keyRef.current=null;},[run.runId,run.checkpoint?.id]);
  useEffect(()=>{mounted.current=true;const unsubscribe=subscribeEvents(event=>{const id=taskId();if(id&&event.taskId===id)void refresh(id,epoch.current,scopeRef.current);});return()=>{mounted.current=false;epoch.current++;statusRequest.current++;unsubscribe();};},[]);
  const busy=submitting||task&&["GENERATING","CALLING_TOOL"].includes(task.status);
  const submit=async()=>{const generation=++epoch.current,scope=scopeRef.current;adopt(null);setSubmitting(true);setError("");keyRef.current??=crypto.randomUUID();try{
    const receipt=await api("/api/v2/runs/"+run.runId+"/analysis","POST",{modelProfileId:profile,idempotencyKey:keyRef.current});
    if(!current(generation,scope))return;adopt(receipt);setSubmitting(false);await refresh(receipt.taskId,generation,scope);
  }catch(e){if(current(generation,scope))setError((e as Error).message);}finally{if(current(generation,scope))setSubmitting(false);}};
  const cancel=async()=>{const id=taskId(),generation=epoch.current,scope=scopeRef.current;if(!id||!["GENERATING","CALLING_TOOL"].includes(taskRef.current?.status))return;statusRequest.current++;try{
    const next=await api("/api/v2/assistant/tasks/"+id+"/cancel","POST",{});if(current(generation,scope,id))adopt(next);
  }catch(e){if(current(generation,scope,id))setError((e as Error).message);}};
  const terminal=task&&!["GENERATING","CALLING_TOOL"].includes(task.status);
  if(run.checkpoint?.kind!=="analysis"||run.checkpoint?.executorRef==="codex_host")return <p>此节点需要 Codex 宿主实际执行。模型 API Key 不提供宿主插件权限。</p>;
  return <div><label className="field">本地分析模型<select disabled={busy} value={profile} onChange={e=>{setProfile(e.target.value);keyRef.current=null;}}><option value="">尚未配置模型</option>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <button disabled={!profile||busy||task?.status==="COMPLETED"} onClick={()=>{if(terminal)keyRef.current=null;void submit();}}>{terminal&&task.status!=="COMPLETED"?"重试模型分析":"使用模型继续分析"}</button>
    {busy&&task&&<button onClick={()=>void cancel()}>取消模型分析</button>}
    {task&&<p role="status">分析任务 {task.id??task.taskId} · {task.status}{task.errorCode?" · "+task.errorCode:""}</p>}{error&&<p role="alert">{error}</p>}
  </div>;
}
