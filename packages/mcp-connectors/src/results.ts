import { ensure, validate, HubError, type Json } from "../../contracts/src/domain.js";
export const MCP_RAW_RESULT=Symbol("mcpRawResult");
/** Preserve the complete protocol result; a declared adapter controls mapping only. */
export function adaptMcpResult(result:Json, adapter="structured", outputSchema?:Json) {
  ensure(result&&!result.isError,"TOOL_FAILED","Downstream returned an error.");
  if(result.structuredContent!==undefined && (outputSchema!==undefined || adapter!=="text")) {
    if(outputSchema)validate(outputSchema,result.structuredContent);
    return {value:result.structuredContent,raw:result};
  }
  ensure(Array.isArray(result.content),"OUTPUT_INVALID","MCP result content is missing.");
  const text=result.content.filter((c:Json)=>c.type==="text").map((c:Json)=>c.text).join("\n");
  if(adapter==="json_text") {
    let value;try{value=JSON.parse(text);}catch{throw new HubError("OUTPUT_INVALID","Text is not valid JSON.");}
    if(outputSchema)validate(outputSchema,value);return {value,raw:result};
  }
  ensure(adapter==="text","OUTPUT_ADAPTER_REQUIRED","Select text or json_text for a text-only tool result.");
  const value={text,content:result.content};
  if(outputSchema)validate(outputSchema,value);
  return {value,raw:result};
}
