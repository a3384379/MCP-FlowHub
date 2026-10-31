import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeDraft } from "../../apps/web/src/shared/draft-merge.js";
const record=()=>({id:"workflow",revision:1,layoutRevision:1,draft:{workflowId:"workflow",name:"Base",description:"",nodes:[{id:"input",title:"Input",config:{a:1,b:2}},{id:"end",title:"End",config:{}}],edges:[{source:"input",port:"next",target:"end"}]},layout:{input:{x:0,y:0},end:{x:100,y:0}}});
test("draft three-way merge combines keyed nodes, independent fields, edges and layout using server CAS",()=>{
  const base=record(),local=record(),remote=record();local.draft.nodes[0]!.title="Local";local.layout.input.x=40;remote.revision=3;remote.layoutRevision=2;remote.draft.name="Remote";remote.draft.nodes[0]!.config.b=5;remote.layout.end.y=20;
  const merged=mergeDraft(base,local,remote);assert.equal(merged.conflicts.length,0);assert.equal(merged.record.draft.nodes[0].title,"Local");assert.equal(merged.record.draft.nodes[0].config.b,5);assert.equal(merged.record.draft.name,"Remote");assert.equal(merged.record.revision,3);assert.equal(merged.record.layout.input.x,40);assert.equal(merged.record.layout.end.y,20);assert.equal(merged.dirty,true);assert.equal(base.draft.name,"Base");
});
test("same-field conflicts retain both values and independent per-field resolutions persist",()=>{
  const base=record(),local=record(),remote=record();local.draft.nodes[0]!.title="Mine";remote.draft.nodes[0]!.title="Theirs";local.draft.name="Local name";remote.draft.name="Server name";
  const first=mergeDraft(base,local,remote);assert.equal(first.conflicts.length,2);assert.equal(first.conflicts.find(c=>c.path==="/draft/nodes/input/title")!.remote,"Theirs");
  const choices={"/draft/nodes/input/title":"remote" as const,"/draft/name":"local" as const},resolved=mergeDraft(base,first.record,remote,choices);assert.equal(resolved.conflicts.length,0);assert.equal(resolved.record.draft.nodes[0].title,"Theirs");assert.equal(resolved.record.draft.name,"Local name");
});
test("node edit/delete is explicit and keyed edge additions are preserved without silent cascade",()=>{
  const base=record(),local=record(),remote=record();local.draft.nodes[1]!.title="Edited";remote.draft.nodes.pop();remote.draft.edges=[];
  const merged=mergeDraft(base,local,remote);assert.equal(merged.conflicts[0]?.path,"/draft/nodes/end");assert.equal(merged.conflicts[0]?.remoteMissing,true);assert.equal(merged.record.draft.nodes.length,2);
  const resolved=mergeDraft(base,local,remote,{"/draft/nodes/end":"remote"});assert.equal(resolved.conflicts.length,0);assert.equal(resolved.record.draft.nodes.length,1);assert.equal(resolved.record.draft.edges.length,0);
});
