import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { AuthoringService } from "../../packages/workflow-authoring/src/index.js";

export function authoringFixture() {
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo),engine=new Engine(repo,vault,new Connectors(repo,vault));
  const authoring=new AuthoringService(engine);
  const create=(workflowId="authoring-demo", owner="admin")=>authoring.create({workflowId,name:"合成流程",environment:"test",mode:"auto",template:"blank",idempotencyKey:"create-"+workflowId},owner);
  const patch=(operations: any[], revision=1,key:string=crypto.randomUUID())=>authoring.patch({workflowId:"authoring-demo",expectedRevision:revision,idempotencyKey:key,operations});
  return {db,repo,engine,authoring,create,patch,close:async()=>{await engine.close();db.close();}};
}
test("authoring creates real drafts, retains idempotency and restricts creation ownership",async t=>{
  const f=authoringFixture();t.after(f.close);
  f.repo.put("clients","author",{id:"author",revision:1,scopes:["workflow:execute","workflow:author"],workflowAllowlist:[],revoked:false});
  const one=f.create("author-created","author");assert.deepEqual(f.create("author-created","author"),one);
  assert.equal(f.authoring.get("author-created","author").revision,1);
  assert.deepEqual(f.repo.get("clients","author").workflowAllowlist,["author-created"]);
  f.create("other");assert.throws(()=>f.authoring.get("other","author"),{code:"AUTH_REQUIRED"});
  assert.throws(()=>f.authoring.create({workflowId:"author-created",name:"different",environment:"test",mode:"auto",template:"blank",idempotencyKey:"create-author-created"},"author"),{code:"IDEMPOTENCY_CONFLICT"});
});
test("patch transaction rolls back all mutations and events, CAS and command replay are exact",async t=>{
  const f=authoringFixture();t.after(f.close);f.create();
  const events=f.repo.changes().length;
  assert.throws(()=>f.patch([{op:"set_metadata",changes:{name:"MUST_ROLL_BACK"}},{op:"update_node",nodeId:"absent",changes:{title:"bad"}}]));
  assert.equal(f.authoring.get("authoring-demo").draft.name,"合成流程");assert.equal(f.repo.changes().length,events);
  const operations=[{op:"set_metadata",changes:{name:"Saved"}}],one=f.patch(operations,1,"same");
  assert.deepEqual(f.patch(operations,1,"same"),one);assert.equal(f.authoring.get("authoring-demo").revision,2);
  assert.throws(()=>f.patch([{op:"set_metadata",changes:{name:"overwritten"}}],1),{code:"REVISION_CONFLICT"});
  assert.throws(()=>f.patch([{op:"set_metadata",changes:{name:"conflict"}}],2,"same"),{code:"IDEMPOTENCY_CONFLICT"});
});
test("layout CAS is independent from semantic edits and incomplete legal drafts retain issues",async t=>{
  const f=authoringFixture();t.after(f.close);f.create();
  f.patch([{op:"set_metadata",changes:{name:"semantic"}}]);
  const moved=f.patch([{op:"move_nodes",positions:[{nodeId:"input",x:80,y:20}],expectedLayoutRevision:1}],1);
  assert.equal(moved.revision,2);assert.equal(moved.layoutRevision,2);
  assert.throws(()=>f.patch([{op:"move_nodes",positions:[{nodeId:"input",x:1,y:1}],expectedLayoutRevision:1}],2),{code:"REVISION_CONFLICT"});
  const incomplete=f.patch([{op:"disconnect",source:"input",target:"end",port:"next"}],2);
  assert.ok(incomplete.issues.length>0);assert.equal(f.authoring.get("authoring-demo").layout.input.x,80);
  assert.throws(()=>f.authoring.publish({workflowId:"authoring-demo",expectedRevision:3,version:"1.0.0",expectedBindingRevisions:{},expectedCapabilityRevisions:{},idempotencyKey:"bad-publish"}));
});
test("publish freezes v2 snapshot, respects revision and preserves v1 schema restrictions",async t=>{
  const f=authoringFixture();t.after(f.close);f.create();
  const a={workflowId:"authoring-demo",expectedRevision:1,version:"2.0.0",expectedBindingRevisions:{},expectedCapabilityRevisions:{},idempotencyKey:"pub"};
  const published=f.authoring.publish(a);assert.deepEqual(f.authoring.publish(a),published);
  f.patch([{op:"set_metadata",changes:{name:"Later"}}],2);
  assert.equal(f.repo.get("versions","authoring-demo@2.0.0").snapshot.workflow.name,"合成流程");
  const v1=structuredClone(published.snapshot.workflow);v1.schemaVersion="flowhub.workflow/v1";v1.workflowId="invalid-v1";v1.executionRequirements={requiresCodex:true};
  assert.throws(()=>f.authoring.saveRaw(v1,undefined,{}),{code:"INPUT_INVALID"});
  assert.throws(()=>f.patch([{op:"add_node",nodeId:"human",nodeType:"approval",title:"forbidden",config:{}}],3));
});
test("semantic undo and redo preserve unrelated later fields and reject same-field conflicts",async t=>{
  const f=authoringFixture();t.after(f.close);f.create();
  const ai=f.patch([{op:"set_metadata",changes:{name:"AI edit"}}]);
  f.patch([{op:"set_metadata",changes:{description:"User retained"}}],2);
  const undone=f.authoring.undo({workflowId:"authoring-demo",expectedRevision:3,commandId:ai.commandId,idempotencyKey:"undo"});
  assert.equal(f.authoring.get("authoring-demo").draft.name,"合成流程");assert.equal(f.authoring.get("authoring-demo").draft.description,"User retained");
  const redo=f.authoring.undo({workflowId:"authoring-demo",expectedRevision:4,commandId:undone.commandId,idempotencyKey:"redo"});assert.equal(redo.revision,5);assert.equal(f.authoring.get("authoring-demo").draft.name,"AI edit");
  f.patch([{op:"set_metadata",changes:{name:"New user value"}}],5);
  assert.throws(()=>f.authoring.undo({workflowId:"authoring-demo",expectedRevision:6,commandId:ai.commandId,idempotencyKey:"conflict"}),{code:"REVISION_CONFLICT"});assert.equal(f.authoring.get("authoring-demo").draft.name,"New user value");
});
test("undo cannot remove a node referenced by later user edits",async t=>{
  const f=authoringFixture();t.after(f.close);f.create();
  const added=f.patch([{op:"add_node",nodeId:"ai-node",nodeType:"agent_task",title:"AI",config:{kind:"analysis",instructions:"Analyze",inputMappings:{},outputSchema:{type:"object",properties:{},additionalProperties:false}}}]);
  f.patch([{op:"add_node",nodeId:"later",nodeType:"agent_task",title:"User",config:{kind:"analysis",instructions:"Analyze",inputMappings:{"/data":{ref:{source:"node",nodeId:"ai-node",pointer:""}}},outputSchema:{type:"object",properties:{},additionalProperties:false}}}],2);
  assert.throws(()=>f.authoring.undo({workflowId:"authoring-demo",expectedRevision:3,commandId:added.commandId,idempotencyKey:"referenced"}),{code:"REFERENCE_IN_USE"});
  assert.equal(f.authoring.get("authoring-demo").revision,3);assert.ok(f.authoring.get("authoring-demo").draft.nodes.some((n:any)=>n.id==="ai-node"));
});
test("AUTHOR-06 referenced deletion is denied atomically and explicit cascade removes only the dependency closure",async t=>{
  const f=authoringFixture();t.after(f.close);
  f.authoring.create({workflowId:"authoring-demo",name:"合成删除链",environment:"test",mode:"guided",template:"blank",idempotencyKey:"create"});
  const output={type:"object",properties:{summary:{type:"string"}},required:["summary"],additionalProperties:false};
  const task=(nodeId:string,source?:string)=>({op:"add_node",nodeId,nodeType:"agent_task",title:nodeId,config:{kind:"analysis",instructions:"Synthetic dependency test",inputMappings:source?{"/source":{ref:{source:"node",nodeId:source,pointer:""}}}:{},outputSchema:output}});
  f.patch([task("source"),task("dependent","source"),task("transitive","dependent"),task("retained"),
    {op:"disconnect",source:"input",target:"end",port:"next"},
    ...[["input","source"],["source","dependent"],["dependent","transitive"],["transitive","retained"],["retained","end"]].map(([source,target])=>({op:"connect",source,target,port:"next"}))]);
  const before=f.authoring.get("authoring-demo"),events=f.repo.changes().length,commands=f.repo.all("authoring_commands").length;
  assert.deepEqual(before.issues,[]);
  assert.throws(()=>f.patch([{op:"remove_node",nodeId:"source"}],2,"omitted-cascade"),{code:"INPUT_INVALID"});
  assert.throws(()=>f.patch([{op:"remove_node",nodeId:"source",cascade:false}],2,"default-delete"),{code:"REFERENCE_IN_USE"});
  assert.throws(()=>f.patch([{op:"set_metadata",changes:{name:"MUST_ROLL_BACK"}},{op:"remove_node",nodeId:"source",cascade:false}],2,"failed-batch"),{code:"REFERENCE_IN_USE"});
  assert.deepEqual(f.authoring.get("authoring-demo"),before);assert.equal(f.repo.changes().length,events);assert.equal(f.repo.all("authoring_commands").length,commands);
  const deleted=f.patch([{op:"remove_node",nodeId:"source",cascade:true},{op:"connect",source:"input",target:"retained",port:"next"}],2,"cascade-delete"),after=f.authoring.get("authoring-demo");
  assert.equal(deleted.revision,3);assert.deepEqual(deleted.issues,[]);assert.deepEqual(after.draft.nodes.map((node:any)=>node.id),["input","end","retained"]);
  assert.deepEqual(after.draft.edges,[{source:"retained",target:"end",port:"next"},{source:"input",target:"retained",port:"next"}]);
  for(const nodeId of ["source","dependent","transitive"])assert.equal(Object.hasOwn(after.layout,nodeId),false);
  for(const nodeId of ["input","end","retained"])assert.deepEqual(after.draft.nodes.find((node:any)=>node.id===nodeId),before.draft.nodes.find((node:any)=>node.id===nodeId));
  assert.deepEqual(after.layout.retained,before.layout.retained);assert.ok(!JSON.stringify(after.draft.nodes).includes('"nodeId":"source"'));assert.ok(!JSON.stringify(after.draft.nodes).includes('"nodeId":"dependent"'));
  assert.equal(f.repo.changes().length,events+1);assert.equal(f.repo.all("authoring_commands").length,commands+1);
  const published=f.authoring.publish({workflowId:"authoring-demo",expectedRevision:3,version:"1.0.0",expectedBindingRevisions:{},expectedCapabilityRevisions:{},idempotencyKey:"publish-after-cascade"});
  assert.deepEqual(published.snapshot.workflow.nodes,after.draft.nodes);
});
