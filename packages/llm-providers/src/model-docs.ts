import {ensure,hash,type Json} from "../../contracts/src/domain.js";

export function parseOfficialModelDoc(model:string,markdown:string):Json {
  const documented=markdown.match(/Model ID:\s*`([^`]+)`/i)?.[1];
  if(documented!==model)return {status:"unavailable",reason:"EXACT_MODEL_NOT_DOCUMENTED"};
  const tokens=(pattern:RegExp)=>{const value=markdown.match(pattern)?.[1];if(!value)return null;const count=Number(value.replaceAll(",",""));return Number.isSafeInteger(count)&&count>0?count:null;};
  const reasoningLine=markdown.split("\n").find(line=>line.includes("`reasoning.effort` supports"));
  const reasoningEfforts=reasoningLine?[...reasoningLine.matchAll(/`(none|minimal|low|medium|high|xhigh|max)`/g)].map(match=>match[1]):[];
  return {status:"available",contextWindow:tokens(/([\d,]+)\s+context window/i),maxInputTokens:tokens(/Maximum input tokens:\s*([\d,]+)/i),maxOutputTokens:tokens(/([\d,]+)\s+max output tokens/i),
    reasoningEfforts:[...new Set(reasoningEfforts)],chatToolsReasoningEffort:markdown.match(/Chat Completions supports function calling only with\s*`reasoning_effort`\s*set to\s*`(none|minimal|low|medium|high|xhigh|max)`/i)?.[1]??null,
    contentHash:hash(markdown)};
}

export async function fetchOfficialModelDoc(model:string,signal:AbortSignal) {
  ensure(/^[a-z0-9][a-z0-9._-]{0,127}$/.test(model),"INPUT_INVALID","Use an exact public model identifier.");
  const sourceUrl="https://developers.openai.com/api/docs/models/"+encodeURIComponent(model),fetchedAt=new Date().toISOString();
  const response=await fetch(sourceUrl+".md",{headers:{Accept:"text/markdown"},signal,redirect:"error"});
  if(!response.ok){await response.body?.cancel();return {status:"unavailable",reason:"OFFICIAL_DOCUMENT_UNAVAILABLE",sourceUrl,fetchedAt};}
  ensure(response.body,"MODEL_OUTPUT_INVALID","Official documentation body missing.");
  const reader=response.body.getReader(),decoder=new TextDecoder();let content="",bytes=0;
  try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;ensure(bytes<=262144,"BUDGET_EXCEEDED","Official model document exceeded 256 KiB.");content+=decoder.decode(part.value,{stream:true});}content+=decoder.decode();}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return {...parseOfficialModelDoc(model,content),sourceUrl,fetchedAt};
}
