import { useEffect,useState } from "react";
import type { Api } from "../../shared/v2";
export function RunAnalysisControl({api,run}:{api:Api;run:any}) {
  const [profiles,setProfiles]=useState<any[]>([]),[profile,setProfile]=useState(""),[error,setError]=useState(""),[task,setTask]=useState<any>(null);
  useEffect(()=>{void api("/api/v2/model-profiles").then(list=>{setProfiles(list);setProfile(list[0]?.id??"");}).catch(e=>setError(e.message));},[]);
  if(run.checkpoint.kind!=="analysis"||run.checkpoint.executorRef==="codex_host")return <p>此节点需要 Codex 宿主实际执行。模型 API Key 不提供宿主插件权限。</p>;
  return <div><label className="field">本地分析模型<select value={profile} onChange={e=>setProfile(e.target.value)}><option value="">尚未配置模型</option>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button disabled={!profile||task} onClick={()=>void api("/api/v2/runs/"+run.runId+"/analysis","POST",{modelProfileId:profile,idempotencyKey:crypto.randomUUID()}).then(setTask).catch(e=>setError(e.message))}>使用模型继续分析</button>{task&&<p>分析任务 {task.taskId} 已提交；运行状态由实际检查点推进更新。</p>}{error&&<p role="alert">{error}</p>}</div>;
}
