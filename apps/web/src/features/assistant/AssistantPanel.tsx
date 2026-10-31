import { useEffect, useRef, useState } from "react";
import { requestedActions, subscribeEvents, type Api } from "../../shared/v2";
let sharedSessionId:string|null=null;
export function AssistantPanel({api,context={},dirty=false,onOpenWorkflow}:{api:Api;context?:any;dirty?:boolean;onOpenWorkflow?:(id:string)=>void}) {
  const [sessions,setSessions]=useState<any[]>([]),[session,setSession]=useState(""),[profiles,setProfiles]=useState<any[]>([]),[profile,setProfile]=useState(""),[messages,setMessages]=useState<any[]>([]),[text,setText]=useState(""),[mode,setMode]=useState("help"),[task,setTask]=useState<any>(null),[error,setError]=useState(""),[partial,setPartial]=useState(""),[help,setHelp]=useState<any>(null);
  const [undos,setUndos]=useState<Record<string,any>>({});
  const taskRef=useRef<any>(task),sessionRef=useRef(session);taskRef.current=task;sessionRef.current=session;
  const history=(id=sessionRef.current)=>api("/api/v2/assistant/sessions/"+id+"/messages").then(setMessages);
  useEffect(()=>{let live=true;void(async()=>{try{
    const [models,existing]=await Promise.all([api("/api/v2/model-profiles"),api("/api/v2/assistant/sessions")]);
    const list=existing.length?existing:[await api("/api/v2/assistant/sessions","POST",{})];
    if(!live)return;setProfiles(models);setProfile(models[0]?.id??"");setSessions(list);
    const chosen=list.find((s:any)=>s.id===sharedSessionId)?.id??list.at(-1).id;setSession(chosen);sharedSessionId=chosen;await history(chosen);
    const tasks=await api("/api/v2/assistant/sessions/"+chosen+"/tasks");if(live)setTask(tasks.at(-1)??null);
  }catch(e){if(live)setError((e as Error).message);}})();
  const unsubscribe=subscribeEvents(event=>{
    if(event.taskId!==taskRef.current?.id&&event.taskId!==taskRef.current?.taskId)return;
    if(event.type==="message.delta")setPartial(old=>old+event.data.text);
    if(event.type.startsWith("tool.")||event.type.startsWith("task."))void api("/api/v2/assistant/tasks/"+event.taskId).then(next=>{if(live){setTask(next);if(!["GENERATING","CALLING_TOOL"].includes(next.status)){setPartial("");void history();}}}).catch(e=>setError(e.message));
  });return()=>{live=false;unsubscribe();};},[]);
  const busy=task&&["GENERATING","CALLING_TOOL"].includes(task.status);
  const send=async()=>{setError("");setPartial("");try{
    const accepted=await api("/api/v2/assistant/sessions/"+session+"/messages","POST",{text,mode,modelProfileId:profile,context,requestedActions:mode==="help"?[]:requestedActions(text),idempotencyKey:crypto.randomUUID()});
    setTask(accepted);setText("");await history();
    const next=await api("/api/v2/assistant/tasks/"+accepted.taskId);setTask(next);
    if(!["GENERATING","CALLING_TOOL"].includes(next.status))await history();
  }catch(e){setError((e as Error).message);}};
  return <section className="v2-assistant" aria-label="AI 助手">
    <div className="v2-assistant-controls"><label className="field">助手会话<select value={session} onChange={e=>{setSession(e.target.value);sharedSessionId=e.target.value;setTask(null);void history(e.target.value);}}>{sessions.map(s=><option key={s.id} value={s.id}>{s.createdAt} · {s.id.slice(-6)}</option>)}</select></label><button onClick={()=>void api("/api/v2/assistant/sessions","POST",{}).then(next=>{setSessions(old=>[...old,next]);setSession(next.id);sharedSessionId=next.id;setMessages([]);setTask(null);})}>新建会话</button></div>
    {context.workflowId&&<p className="badge">当前流程 {context.workflowId} · r{context.revision} · 节点 {(context.selectedNodeIds??[]).join("、")||"未选"}</p>}
    {dirty&&<p className="banner">本地有未保存编辑。AI 保存的修订会保留为冲突，不覆盖输入。</p>}
    {!profiles.length&&<p className="banner">尚未配置模型。可继续在 Codex 使用 FlowHub，也可检索本地帮助。</p>}
    {error&&<p role="alert" className="banner error">{error}</p>}
    <div className="v2-messages" aria-live="polite">{messages.map(m=><article key={m.id}><strong>{m.role==="user"?"你":"FlowHub 助手"}</strong><p style={{whiteSpace:"pre-wrap"}}>{m.text}</p>{m.citations?.map((c:any)=><details key={c.sourcePath+c.lineStart}><summary>{c.sourcePath} · L{c.lineStart}–{c.lineEnd}</summary><p>{c.heading} · {c.productVersion} · {c.contentHash}</p></details>)}</article>)}{partial&&<p style={{whiteSpace:"pre-wrap"}}>{partial}</p>}</div>
    {task&&<div className="v2-tool-cards" role="status"><strong>任务：{task.status}</strong>{task.errorCode&&<p>{task.errorCode} · 草稿与已完成回执已保留</p>}{task.tools?.map((tool:any)=><details key={tool.id} open><summary>{tool.name} · {tool.isError?"失败":tool.status} · {tool.durationMs??"…"} ms</summary><pre>{JSON.stringify(tool.result,null,2)}</pre>{tool.result?.commandId&&<button disabled={busy} onClick={()=>void (async()=>{try{const workflow=await api("/api/v2/workflows/"+tool.result.workflowId+"/draft");const result=await api("/api/v2/workflows/"+tool.result.workflowId+"/undo","POST",{commandId:undos[tool.id]?.commandId??tool.result.commandId,expectedRevision:workflow.revision,idempotencyKey:crypto.randomUUID()});setUndos(old=>({...old,[tool.id]:{...result,undone:!old[tool.id]?.undone}}));}catch(e){setError((e as Error).message);}})()}>{undos[tool.id]?.undone?"重做此改图":"撤销此改图"}</button>}{tool.result?.workflowId&&onOpenWorkflow&&<button onClick={()=>onOpenWorkflow(tool.result.workflowId)}>打开工作流</button>}</details>)}<p>usage：{task.usage?JSON.stringify(task.usage):"未知"}</p></div>}
    <form onSubmit={e=>{e.preventDefault();void send();}}><label className="field">助手模式<select value={mode} onChange={e=>setMode(e.target.value)}><option value="help">帮助：只解释和检索</option><option value="compose">编排：按本次指令操作</option></select></label>
    <label className="field">使用模型<select value={profile} onChange={e=>setProfile(e.target.value)}><option value="">未配置</option>{profiles.map(p=><option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}</select></label>
    <label className="field">发送给助手<textarea rows={4} value={text} onChange={e=>setText(e.target.value)} placeholder="例如：为当前流程增加异常分支并保存，不执行"/></label>
    <p>本次动作范围：{mode==="help"?"检索与解释":requestedActions(text).join("、")||"只读"}</p>
    <div className="actions"><button className="primary" type="submit" disabled={busy||!profile||!text.trim()||!session}>发送</button><button type="button" disabled={busy||!text.trim()} onClick={()=>void api("/api/v2/help/search?query="+encodeURIComponent(text)).then(setHelp).catch(e=>setError(e.message))}>检索项目帮助</button>{busy&&<button type="button" onClick={()=>void api("/api/v2/assistant/tasks/"+(task.id??task.taskId)+"/cancel","POST",{}).then(setTask)}>取消当前任务</button>}</div></form>
    {help&&<div><h3>本地资料检索</h3>{help.excerpts.map((e:any)=><details key={e.id} open><summary>{e.sourcePath} · L{e.lineStart}–{e.lineEnd}</summary><p style={{whiteSpace:"pre-wrap"}}>{e.content}</p></details>)}</div>}
  </section>;
}
