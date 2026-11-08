import { ensure, HubError, type Json } from "../../contracts/src/domain.js";
export type ModelCall={id:string;name:string;arguments:string};
export type ModelTurn={text:string;calls:ModelCall[];usage:Json;continuation?:Json[]};
export type ModelRequest={messages:Json[];tools:Json[];signal:AbortSignal;stream:boolean;maxAttempts?:number;continuation?:Json[];onDelta?:(text:string)=>void};
export interface ModelProvider { complete(request:ModelRequest):Promise<ModelTurn>; }
export type ProviderFactory=(profile:Json,key:string)=>ModelProvider;

export function providerBaseUrl(baseUrl:string) {
  let url:URL;try{url=new URL(baseUrl);}catch{throw new HubError("INPUT_INVALID","Enter a valid model Base URL.");}
  ensure((url.protocol==="https:"||(url.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(url.hostname)))&&!url.username&&!url.password&&!url.search&&!url.hash,"INPUT_INVALID","Use an HTTPS provider URL, or an explicit loopback test URL.");
  url.pathname=url.pathname.replace(/\/+$/,"").replace(/\/(?:responses|chat\/completions)$/,"");
  return url.href.replace(/\/+$/,"");
}
export function providerUrl(baseUrl:string,kind:string) {
  ensure(["openai_responses","openai_compatible_chat"].includes(kind),"INPUT_INVALID","Unsupported model protocol.");
  return providerBaseUrl(baseUrl)+"/"+(kind==="openai_responses"?"responses":"chat/completions");
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
async function bodyJson(response:Response) {
  ensure(response.body,"MODEL_OUTPUT_INVALID","Provider returned no JSON body.");
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let bytes=0;
  try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;ensure(bytes<=4*1024*1024,"BUDGET_EXCEEDED","Provider response exceeded 4 MiB.");parts.push(part.value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const result=new Uint8Array(bytes);let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}
  try{return JSON.parse(new TextDecoder().decode(result)) as Json;}catch{throw new HubError("MODEL_OUTPUT_INVALID","Provider returned invalid JSON.");}
}
const safeProviderCodes=new Set(["model_not_found","invalid_api_key","insufficient_quota","billing_hard_limit_reached","permission_denied","unsupported_parameter","unsupported_value","invalid_request_error"]);
export async function modelServiceFailure(response:Response,attempts=1):Promise<HubError> {
  let body:Json;try{body=await bodyJson(response);}catch{body=null;}
  const providerCode=safeProviderCodes.has(body?.error?.code)?body.error.code:null;
  const parameter=["model","tools","stream","parallel_tool_calls","messages","input"].includes(body?.error?.param)?body.error.param:null;
  // The rejected field alone does not distinguish unsupported tools from a bad schema or server failure.
  const unsupportedTools=response.status===400&&parameter==="tools"&&["unsupported_parameter","unsupported_value"].includes(providerCode);
  const code=response.status===401||response.status===403?"MODEL_AUTH_FAILED":
    providerCode==="model_not_found"?"MODEL_NOT_AVAILABLE":
    ["insufficient_quota","billing_hard_limit_reached"].includes(providerCode)?"MODEL_QUOTA_EXCEEDED":
    response.status===404?"MODEL_ENDPOINT_NOT_FOUND":response.status===429?"MODEL_RATE_LIMITED":
    unsupportedTools?"MODEL_UNSUPPORTED_TOOLS":response.status===400?"MODEL_INVALID_CONFIGURATION":"MODEL_REQUEST_FAILED";
  return new HubError(code,"Model service rejected the request.",422,{status:response.status,providerCode,parameter,attempts});
}
export async function fetchModelCatalog(baseUrl:string,key:string,signal:AbortSignal) {
  const endpoint=providerBaseUrl(baseUrl)+"/models";
  const response=await fetch(endpoint,{headers:{Authorization:"Bearer "+key,Accept:"application/json"},signal,redirect:"error"});
  if(!response.ok)throw await modelServiceFailure(response);
  const result=await bodyJson(response);
  ensure(Array.isArray(result.data)&&result.data.length<=10000,"MODEL_OUTPUT_INVALID","Invalid model catalog.");
  const models=result.data.map((model:Json)=>{
    ensure(typeof model?.id==="string"&&model.id.length>0&&model.id.length<=256,"MODEL_OUTPUT_INVALID","Invalid model identifier.");
    return {id:model.id,ownedBy:typeof model.owned_by==="string"?model.owned_by.slice(0,160):null,
      created:Number.isSafeInteger(model.created)&&model.created>=0&&model.created<=253402300799?model.created:null,
      shutdownDate:typeof model.shutdown_date==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(model.shutdown_date)?model.shutdown_date:null};
  });
  ensure(new Set(models.map((model:Json)=>model.id)).size===models.length,"MODEL_OUTPUT_INVALID","Duplicate model identifiers.");
  return {models:models.sort((a:Json,b:Json)=>a.id.localeCompare(b.id)),endpoint,fetchedAt:new Date().toISOString()};
}
function cancelled(signal:AbortSignal):never {
  if(signal.reason instanceof HubError)throw signal.reason;
  throw new HubError("TASK_CANCELLED","Task cancelled.");
}
async function retryDelay(ms:number,signal:AbortSignal) {
  if(signal.aborted)cancelled(signal);
  await new Promise<void>((resolve,reject)=>{const stop=()=>{clearTimeout(timer);reject(signal.reason instanceof HubError?signal.reason:new HubError("TASK_CANCELLED","Task cancelled."));};const timer=setTimeout(()=>{signal.removeEventListener("abort",stop);resolve();},ms);signal.addEventListener("abort",stop,{once:true});});
}
export class HttpModelProvider implements ModelProvider {
  constructor(readonly profile:Json,readonly key:string) {}
  async complete(request:ModelRequest):Promise<ModelTurn> {
    const maxAttempts=request.maxAttempts??3;
    ensure(Number.isSafeInteger(maxAttempts)&&maxAttempts>=1&&maxAttempts<=3,"INPUT_INVALID","Model requests allow one to three HTTP attempts.");
    const timeout=AbortSignal.timeout(this.profile.timeoutMs??180000),signal=AbortSignal.any([request.signal,timeout]);
    try {
    const responses=this.profile.providerKind==="openai_responses";
    const tools=request.tools.map(t=>responses?{type:"function",name:t.name,description:t.description,parameters:t.parameters,strict:false}:{type:"function",function:{name:t.name,description:t.description,parameters:t.parameters,strict:false}});
    let body:Json;
    if(responses) {
      const input=request.continuation??request.messages.map(m=>m.role==="tool"?{type:"function_call_output",call_id:m.tool_call_id,output:m.content}:{role:m.role,content:m.content});
      body={model:this.profile.model,input,store:false,stream:request.stream,...(tools.length?{tools,parallel_tool_calls:false}:{})};
    }else body={model:this.profile.model,messages:request.messages,stream:request.stream,...(tools.length?{tools,parallel_tool_calls:false}:{})};
    let response:Response;
    for(let attempt=0;;attempt++) {
      response=await fetch(providerUrl(this.profile.baseUrl,this.profile.providerKind),{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+this.key},body:JSON.stringify(body),signal,redirect:"error"});
      if(response.ok)break;
      const failure=await modelServiceFailure(response,attempt+1);
      const raw=response.headers.get("retry-after"),retryMs=raw===null?250:/^\d+(?:\.\d+)?$/.test(raw)?Number(raw)*1000:Math.max(0,Date.parse(raw)-Date.now());
      if(failure.code==="MODEL_RATE_LIMITED"&&attempt+1<maxAttempts&&Number.isFinite(retryMs)&&retryMs<=2000){await retryDelay(retryMs,signal);continue;}
      throw failure;
    }
    if(!request.stream) {
      const data=await bodyJson(response);
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
    }catch(e){
      if(request.signal.aborted)cancelled(request.signal);
      if(timeout.aborted)throw new HubError("MODEL_TIMEOUT","Model request timed out before the complete response was received.");
      if(e instanceof HubError)throw e;
      throw new HubError(request.stream?"MODEL_STREAM_INTERRUPTED":"MODEL_CONNECTION_FAILED","Model response did not complete; no write will be replayed.");
    }
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
