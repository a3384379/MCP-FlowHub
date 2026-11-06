import { get, hash, type Json } from "../../contracts/src/domain.js";

const encode=(value:string)=>value.replaceAll("~","~0").replaceAll("/","~1");

/** Bounded structural diagnostics only; schema defaults/example values are not copied. */
function fields(root:Json) {
  const result=new Map<string,Json>();let visits=0,truncated=false;
  const walk=(value:Json,pointer:string,schemaPath:string,required=false,refs:string[]=[],depth=0)=>{
    if(++visits>2048||depth>24){truncated=true;return;}
    if(typeof value?.$ref==="string"&&value.$ref.startsWith("#/")&&!refs.includes(value.$ref)) {
      try{walk(get(root,value.$ref.slice(1)),pointer,value.$ref.slice(1),required,[...refs,value.$ref],depth+1);return;}catch{}
    }
    const own=value&&typeof value==="object"&&!Array.isArray(value)
      ?Object.fromEntries(Object.entries(value).filter(([key])=>!["properties","items","$defs","definitions","required"].includes(key)))
      :value??null;
    result.set(pointer,{fingerprint:hash(own),type:value?.type??null,required,schemaPath});
    for(const [key,child] of Object.entries(value?.properties??{}))
      walk(child,pointer+"/"+encode(key),schemaPath+"/properties/"+encode(key),Array.isArray(value.required)&&value.required.includes(key),refs,depth+1);
    if(value?.items&&typeof value.items==="object"&&!Array.isArray(value.items))
      walk(value.items,pointer+"/*",schemaPath+"/items",false,refs,depth+1);
  };
  walk(root,"","");return {result,truncated};
}

export function capabilitySchemaChanges(previous:Json,current:Json) {
  const changes:Json[]=[];let truncated=false;
  for(const section of ["inputSchema","outputSchema"]) {
    const before=fields(previous?.[section]),after=fields(current?.[section]);truncated ||= before.truncated||after.truncated;
    for(const pointer of new Set([...before.result.keys(),...after.result.keys()])) {
      const old=before.result.get(pointer),next=after.result.get(pointer);
      if(old?.fingerprint===next?.fingerprint&&old?.required===next?.required)continue;
      if(changes.length>=64){truncated=true;break;}
      changes.push({section,parameter:pointer,schemaPath:next?.schemaPath??old?.schemaPath??"",
        change:!old?"added":!next?"removed":hash(old.type)!==hash(next.type)?"type_changed":old.required!==next.required?"required_changed":"schema_changed",
        previousType:old?.type??null,currentType:next?.type??null,previousRequired:old?.required??false,currentRequired:next?.required??false});
    }
  }
  return {changes,truncated};
}

export function driftIssue(node:Json,reference:Json,previous:Json,current:Json,nodeIndex:number) {
  const difference=previous&&current?capabilitySchemaChanges(previous,current):{changes:[],truncated:false};
  const nodePath="/nodes/"+nodeIndex+"/config",mappingField=node.type==="mcp_tool"?"argumentsMappings":"inputMappings";
  const schemaChanges=difference.changes.map(change=>({...change,
    ...(change.section==="inputSchema"&&Object.hasOwn(node.config[mappingField]??{},change.parameter)
      ?{mappingPath:nodePath+"/"+mappingField+"/"+encode(change.parameter)}:{})}));
  return {code:"CAPABILITY_STALE",message:"能力定义已变化，请更新能力引用并核对节点参数。",nodeId:node.id,
    path:nodePath+"/capabilityRef",capabilityId:reference.capabilityId,
    expectedRevision:reference.revision,currentRevision:current?.revision??null,
    previousRevisionAvailable:!!previous,schemaChanges,changesTruncated:difference.truncated};
}
