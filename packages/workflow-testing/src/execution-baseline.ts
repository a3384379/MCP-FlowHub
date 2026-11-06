import { clone, hash, type Json } from "../../contracts/src/domain.js";

const pick=(record:Json,keys:string[])=>record?Object.fromEntries(keys.filter(key=>Object.hasOwn(record,key)).map(key=>[key,clone(record[key])])):null;
/** Observation timestamps never change a reviewed execution/generation contract. */
export const capabilityDefinition=(capability:Json)=>pick(capability,["id","capabilityId","revision","capabilityRevision","stale","kind","name","description","executor","inputSchema","outputSchema","tool","contentHash","skillContent","enabled","disabled","available","requiresCodex"]);
/** Used only for hashing; transport/auth fields must not become model context. */
export function connectionDefinition(connection:Json) {
  if(!connection)return null;
  const definition=clone(connection);
  for(const key of ["history","discovery","createdAt","updatedAt","verifiedAt","lastError"])delete definition[key];
  return definition;
}
export const connectionBaseline=(connection:Json)=>connection?hash(connectionDefinition(connection)):null;
