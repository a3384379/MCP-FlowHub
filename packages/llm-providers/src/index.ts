import { ensure, HubError, type Json } from "../../contracts/src/domain.js";
export type ModelCall={id:string;name:string;arguments:string};
export type ModelTurn={text:string;calls:ModelCall[];usage:Json;continuation?:Json[]};
export type ModelRequest={messages:Json[];tools:Json[];signal:AbortSignal;stream:boolean;continuation?:Json[];onDelta?:(text:string)=>void};
export interface ModelProvider { complete(request:ModelRequest):Promise<ModelTurn>; }
export type ProviderFactory=(profile:Json,key:string)=>ModelProvider;

export function providerUrl(baseUrl:string,kind:string) {
  const url=new URL(baseUrl);
  ensure((url.protocol==="https:"||(url.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(url.hostname)))&&!url.username&&!url.password&&!url.search&&!url.hash,"INPUT_INVALID","Use an HTTPS provider URL, or an explicit loopback test URL.");
  const suffix=kind==="openai_responses"?"responses":"chat/completions";
  url.pathname=url.pathname.replace(/\/+$/,"");
  if(!url.pathname.endsWith("/"+suffix))url.pathname+="/"+suffix;
  return url.href;
}
function validateCalls(calls:ModelCall[]) {
  ensure(new Set(calls.map(c=>c.id)).size===calls.length,"TOOL_ARGUMENTS_INCOMPLETE","Duplicate tool call IDs.");
  for(const c of calls) {
    ensure(typeof c.id==="string"&&c.id.length>0&&typeof c.name==="string"&&c.name.length>0&&typeof c.arguments==="string"&&c.arguments.length<=524288,"TOOL_ARGUMENTS_INCOMPLETE","Incomplete or oversized tool call.");
    let value;try{value=JSON.parse(c.arguments);}catch{throw new HubError("TOOL_ARGUMENTS_INCOMPLETE","Tool arguments did not finish as valid JSON.");}
    ensure(value&&typeof value==="object"&&!Array.isArray(value),"TOOL_ARGUMENTS_INCOMPLETE","Tool arguments must be an object.");
  }
}
async function events(response:Response,onEvent:(event:Json)=>void) {
  ensure(response.body,"MODEL_STREAM_INTERRUPTED","Provider returned no stream.");
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer="",bytes=0;
  try{while(true){const read=await reader.read();if(read.done)break;bytes+=read.value.length;
    ensure(bytes<=4*1024*1024,"BUDGET_EXCEEDED","Provider response exceeded 4 MiB.");
    buffer+=decoder.decode(read.value,{stream:true});buffer=buffer.replaceAll("\r\n","\n");
    let boundary;while((boundary=buffer.indexOf("\n\n"))!==-1){const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
      const data=block.split("\n").filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trimStart()).join("\n");
      if(data==="[DONE]")onEvent({type:"transport.done"});else if(data) {try{onEvent(JSON.parse(data));}catch(e){if(e instanceof HubError)throw e;throw new HubError("MODEL_STREAM_INTERRUPTED","Invalid provider event.");}}
    }
  }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export class HttpModelProvider implements ModelProvider {
  constructor(readonly profile:Json,readonly key:string) {}
  async complete(request:ModelRequest):Promise<ModelTurn> {
    const responses=this.profile.providerKind==="openai_responses";
    const tools=request.tools.map(t=>responses?{type:"function",name:t.name,description:t.description,parameters:t.parameters,strict:false}:{type:"function",function:{name:t.name,description:t.description,parameters:t.parameters,strict:false}});
    let body:Json;
    if(responses) {
      const input=request.continuation??request.messages.map(m=>m.role==="tool"?{type:"function_call_output",call_id:m.tool_call_id,output:m.content}:{role:m.role,content:m.content});
      body={model:this.profile.model,input,store:false,stream:request.stream,...(tools.length?{tools,parallel_tool_calls:false}:{})};
    }else body={model:this.profile.model,messages:request.messages,stream:request.stream,...(tools.length?{tools,parallel_tool_calls:false}:{})};
    let response:Response;
    try {response=await fetch(providerUrl(this.profile.baseUrl,this.profile.providerKind),{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+this.key},body:JSON.stringify(body),signal:AbortSignal.any([request.signal,AbortSignal.timeout(this.profile.timeoutMs??180000)]),redirect:"error"});}
    catch(e){if(request.signal.aborted)throw new HubError("TASK_CANCELLED","Task cancelled.");throw new HubError((e as Error).name==="TimeoutError"?"MODEL_TIMEOUT":"MODEL_CONNECTION_FAILED","Model request did not complete; no write will be replayed.");}
    if(!response.ok){await response.body?.cancel();throw new HubError(response.status===401||response.status===403?"MODEL_AUTH_FAILED":response.status===429?"MODEL_RATE_LIMITED":"MODEL_REQUEST_FAILED","Model service rejected the request.",422,{status:response.status,retryAfter:response.headers.get("retry-after")});}
    if(!request.stream) {
      const data=await response.json() as Json;
      if(responses){const output=data.output??[],calls=output.filter((x:Json)=>x.type==="function_call").map((x:Json)=>({id:x.call_id,name:x.name,arguments:x.arguments}));validateCalls(calls);
        ensure(data.status===undefined||data.status==="completed","MODEL_STREAM_INTERRUPTED","Response did not complete.");
        return {text:output.filter((x:Json)=>x.type==="message").flatMap((m:Json)=>m.content??[]).filter((x:Json)=>x.type==="output_text").map((x:Json)=>x.text).join(""),calls,usage:data.usage??null,continuation:output};
      }
      const choice=data.choices?.[0],message=choice?.message??{},calls=(message.tool_calls??[]).map((c:Json)=>({id:c.id,name:c.function?.name,arguments:c.function?.arguments}));
      ensure(["stop","tool_calls"].includes(choice?.finish_reason),"MODEL_STREAM_INTERRUPTED","Chat response did not complete.");validateCalls(calls);return {text:message.content??"",calls,usage:data.usage??null};
    }
    const calls=new Map<number,ModelCall>();let text="",usage:Json=null,complete=false,continuation:Json[]|undefined;
    await events(response,event=>{
      if(responses) {
        if(event.type==="response.output_text.delta"){text+=event.delta;request.onDelta?.(event.delta);}
        if(event.type==="response.output_item.added"&&event.item?.type==="function_call")calls.set(event.output_index,{id:event.item.call_id,name:event.item.name,arguments:event.item.arguments??""});
        if(event.type==="response.function_call_arguments.delta"){const call=calls.get(event.output_index);ensure(call,"TOOL_ARGUMENTS_INCOMPLETE","Arguments arrived without a tool identity.");call.arguments+=event.delta;}
        if(event.type==="response.function_call_arguments.done"){const call=calls.get(event.output_index);if(call)call.arguments=event.arguments;}
        if(event.type==="response.completed") {complete=event.response?.status==="completed";usage=event.response?.usage??null;continuation=event.response?.output;}
        if(["error","response.failed","response.incomplete"].includes(event.type))throw new HubError("MODEL_STREAM_INTERRUPTED","Provider response failed before completion.");
      }else {
        const choice=event.choices?.[0],delta=choice?.delta??{};
        if(delta.content){text+=delta.content;request.onDelta?.(delta.content);}
        for(const c of delta.tool_calls??[]) {
          const prior=calls.get(c.index)??{id:"",name:"",arguments:""};
          if(c.id)prior.id=c.id;if(c.function?.name)prior.name+=c.function.name;if(c.function?.arguments)prior.arguments+=c.function.arguments;calls.set(c.index,prior);
        }
        if(choice?.finish_reason)complete=["stop","tool_calls"].includes(choice.finish_reason);
        if(event.usage)usage=event.usage;
      }
    });
    ensure(complete,"MODEL_STREAM_INTERRUPTED","Model stream ended before a completed response; no tool dispatched.");
    const outputCalls=continuation?.filter(x=>x.type==="function_call").map(x=>({id:x.call_id,name:x.name,arguments:x.arguments}));
    const finalized=outputCalls?.length?outputCalls:[...calls.values()];validateCalls(finalized);
    if(!text&&continuation)text=continuation.filter(x=>x.type==="message").flatMap(x=>x.content??[]).filter(x=>x.type==="output_text").map(x=>x.text).join("");
    return {text,calls:finalized,usage,...(continuation?{continuation}:{})};
  }
}
/** Deterministic dependency injection for tests. Never selected by an end-user profile. */
export class ScriptedModelProvider implements ModelProvider {
  private offset=0;
  readonly requests:ModelRequest[]=[];
  constructor(readonly script:(ModelTurn|Error|((request:ModelRequest)=>Promise<ModelTurn>))[]){}
  async complete(request:ModelRequest) {
    this.requests.push(request);const step=this.script[this.offset++];ensure(step,"MODEL_SCRIPT_EXHAUSTED","Synthetic provider has no next response.");
    if(step instanceof Error)throw step;
    const result=typeof step==="function"?await step(request):structuredClone(step);validateCalls(result.calls);request.onDelta?.(result.text);return result;
  }
}
