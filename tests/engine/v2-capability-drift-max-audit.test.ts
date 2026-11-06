import {test} from "node:test";
import assert from "node:assert/strict";
import {capabilitySchemaChanges,driftIssue} from "../../packages/workflow-authoring/src/capability-drift.js";
import {assertSafeNativeObjectSchema} from "../../packages/contracts/src/schema-safety.js";
import {get,validate,type Json} from "../../packages/contracts/src/domain.js";

const object=(field:Json,base:Json={})=>({type:"object",$defs:{base},properties:{count:field},required:["count"],additionalProperties:false});
function check(before:Json,after:Json,oldValue:Json,newValue:Json){
  // These are product-accepted schemas with an observable validation change,
  // rather than snapshots of an assumed diagnostic representation.
  assertSafeNativeObjectSchema(before);assertSafeNativeObjectSchema(after);
  validate(before,oldValue);validate(after,newValue);
  assert.throws(()=>validate(after,oldValue),{code:"INPUT_INVALID"});
  const result=capabilitySchemaChanges({inputSchema:before},{inputSchema:after});
  assert.equal(result.truncated,false);
  for(const change of result.changes)assert.doesNotThrow(()=>get(change.change==="removed"?before:after,change.schemaPath));
  return result.changes;
}

test("CAP-01: local ref siblings retain type diagnostics, real schema locations and mapping pointers",()=>{
  const before=object({$ref:"#/$defs/base",type:"string"}),after=object({$ref:"#/$defs/base",type:"integer"});
  const changes=check(before,after,{count:"2"},{count:2});
  assert.deepEqual(changes,[{section:"inputSchema",parameter:"/count",schemaPath:"/properties/count",change:"type_changed",previousType:"string",currentType:"integer",previousRequired:true,currentRequired:true}]);
  const node={id:"read",type:"mcp_tool",config:{argumentsMappings:{"/count":{value:"2"}}}},issue=driftIssue(node,{capabilityId:"synthetic-ref",revision:1},{revision:1,inputSchema:before},{revision:2,inputSchema:after},1);
  assert.equal(issue.code,"CAPABILITY_STALE");assert.equal(issue.schemaChanges[0].mappingPath,"/nodes/1/config/argumentsMappings/~1count");
  assert.deepEqual(get({nodes:[{},node]},issue.schemaChanges[0].mappingPath),{value:"2"});
});

test("CAP-01: minimum siblings and required siblings diagnose their own constraints without merging a ref",()=>{
  const before=object({$ref:"#/$defs/base",minimum:1},{type:"integer"}),after=object({$ref:"#/$defs/base",minimum:3},{type:"integer"});
  assert.ok(check(before,after,{count:1},{count:3}).some(c=>c.parameter==="/count"&&c.schemaPath==="/properties/count"&&c.change==="schema_changed"));
  const base={type:"object",properties:{label:{type:"string"}},additionalProperties:false},optional=object({$ref:"#/$defs/base",required:[]},base),required=object({$ref:"#/$defs/base",required:["label"]},base);
  const change=check(optional,required,{count:{}},{count:{label:"synthetic"}}).find(c=>c.parameter==="/count/label"&&c.change==="required_changed");
  assert.ok(change);assert.equal(change.schemaPath,"/properties/count/required");assert.equal(change.previousRequired,false);assert.equal(change.currentRequired,true);
});

test("CAP-01: ref target drift still locates the field and the actual target schema",()=>{
  const before=object({$ref:"#/$defs/base",description:"synthetic parameter"},{type:"string"}),after=object({$ref:"#/$defs/base",description:"synthetic parameter"},{type:"integer"});
  const change=check(before,after,{count:"2"},{count:2}).find(c=>c.change==="type_changed");
  assert.ok(change);assert.equal(change.parameter,"/count");assert.equal(change.schemaPath,"/$defs/base");
});

test("CAP-01: contradictory constraints stay independent structural declarations",()=>{
  const before=object({$ref:"#/$defs/base",type:"string"},{type:"string"}),after=object({$ref:"#/$defs/base",type:"integer"},{type:"string"});
  assertSafeNativeObjectSchema(before);assertSafeNativeObjectSchema(after);validate(before,{count:"2"});
  for(const count of ["2",2])assert.throws(()=>validate(after,{count}),{code:"INPUT_INVALID"});
  const {changes,truncated}=capabilitySchemaChanges({inputSchema:before},{inputSchema:after});
  assert.equal(truncated,false);assert.equal(changes.length,1);assert.equal(changes[0].schemaPath,"/properties/count");
  // currentType reports that declaration, never an invented effective type.
  assert.equal(changes[0].currentType,"integer");
});

test("CAP-01: diagnostics retain bounded visits/depth/change limits and mark incomplete refs",()=>{
  const schema=(type:string)=>({type:"object",properties:Object.fromEntries(Array.from({length:70},(_,i)=>["field"+i,{$ref:"#/$defs/base",type}])),additionalProperties:false,$defs:{base:{}}});
  const before=schema("string"),after=schema("integer");assertSafeNativeObjectSchema(before);assertSafeNativeObjectSchema(after);
  const limited=capabilitySchemaChanges({inputSchema:before},{inputSchema:after});assert.equal(limited.changes.length,64);assert.equal(limited.truncated,true);
  const recursive={type:"object",properties:{child:{$ref:"#/"}},$defs:{}};
  assert.equal(capabilitySchemaChanges({inputSchema:recursive},{inputSchema:recursive}).truncated,true);
  const missing={type:"object",properties:{child:{$ref:"#/$defs/missing"}}};
  assert.equal(capabilitySchemaChanges({inputSchema:missing},{inputSchema:missing}).truncated,true);
  const defs:Json={};for(let i=0;i<30;i++)defs["step"+i]=i===29?{type:"string"}:{$ref:"#/$defs/step"+(i+1)};
  assert.equal(capabilitySchemaChanges({inputSchema:object({$ref:"#/$defs/step0"})},{inputSchema:{...object({$ref:"#/$defs/step0"}),$defs:defs}}).truncated,true);
});
