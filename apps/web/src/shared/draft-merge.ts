type Value=any;
export type DraftFieldConflict={path:string;local:Value;remote:Value;base:Value;localMissing:boolean;remoteMissing:boolean};
const object=(value:Value)=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const canonical=(value:Value):string=>Array.isArray(value)?"["+value.map(canonical).join(",")+"]":object(value)?"{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+canonical(value[key])).join(",")+"}":JSON.stringify(value)??"undefined";
const same=(left:Value,right:Value)=>canonical(left)===canonical(right);
const pointer=(path:string[])=>"/"+path.map(part=>part.replaceAll("~","~0").replaceAll("/","~1")).join("/");
function keyed(value:Value,field:string) {
  if(!Array.isArray(value))return value;
  const key=(item:Value)=>field==="nodes"?item?.id:field==="edges"&&item?JSON.stringify([item.source,item.port,item.target]):undefined;
  if(!["nodes","edges"].includes(field)||value.some(item=>typeof key(item)!=="string")||new Set(value.map(key)).size!==value.length)return value;
  return Object.fromEntries(value.map(item=>[key(item),item]));
}
function editable(record:Value){return {draft:{...record.draft,nodes:keyed(record.draft.nodes,"nodes"),edges:keyed(record.draft.edges,"edges")},layout:record.layout??{}};}
/** Merge only editable content; metadata and CAS revisions always come from the server receipt. */
export function mergeDraft(base:Value,local:Value,remote:Value,choices:Record<string,"local"|"remote">={}) {
  const conflicts:DraftFieldConflict[]=[];
  const merge=(before:Value,mine:Value,theirs:Value,path:string[]):Value=>{
    if(same(mine,theirs))return structuredClone(mine);
    if(same(mine,before))return structuredClone(theirs);
    if(same(theirs,before))return structuredClone(mine);
    if(object(mine)&&object(theirs)&&(object(before)||before===undefined)) {
      const result:Value={};for(const key of new Set([...Object.keys(theirs),...Object.keys(mine),...Object.keys(before??{})])){const value=merge(before?.[key],mine[key],theirs[key],[...path,key]);if(value!==undefined)result[key]=value;}return result;
    }
    const pathKey=pointer(path),choice=choices[pathKey];
    if(choice)return structuredClone(choice==="local"?mine:theirs);
    conflicts.push({path:pathKey,base:structuredClone(before),local:structuredClone(mine),remote:structuredClone(theirs),localMissing:mine===undefined,remoteMissing:theirs===undefined});
    return structuredClone(mine);
  };
  const value=merge(editable(base),editable(local),editable(remote),[]);
  for(const field of ["nodes","edges"])if(!Array.isArray(value.draft[field]))value.draft[field]=Object.values(value.draft[field]);
  const record={...structuredClone(remote),draft:value.draft,layout:value.layout};
  // A delete/edit merge must not silently remove an edge whose endpoint was retained locally.
  const nodeIds=new Set(record.draft.nodes.map((node:Value)=>node.id));
  const invalidEdges=record.draft.edges.filter((edge:Value)=>!nodeIds.has(edge.source)||!nodeIds.has(edge.target));
  return {record,conflicts,dirty:!same(editable(record),editable(remote)),invalidEdges};
}
