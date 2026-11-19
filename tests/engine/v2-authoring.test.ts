import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { AuthoringService } from "../../packages/workflow-authoring/src/index.js";
import { hash, type Json } from "../../packages/contracts/src/domain.js";
import { sourceConnectionRouteHash } from "../../packages/contracts/src/source-connection.js";

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

function switchFixture() {
  const f = authoringFixture();
  f.create();
  const contextId = "ordered-context";
  const source = { id: "ordered-source", contextId, revision: 1, contextRevision: 1,
    enabled: true, sourceFingerprint: "synthetic-ordered-source" };
  f.repo.insert("host_contexts", contextId, { id: contextId, revision: 1 });
  f.repo.insert("capability_sources", source.id, source);
  const scopedSchema = { type: "object", properties: { traceId: { type: "string" } },
    required: ["traceId"], additionalProperties: false };
  const tool = { name: "read_trace", inputSchema: scopedSchema, outputSchema: scopedSchema,
    schemaHash: "sha256:" + hash({ inputSchema: scopedSchema, outputSchema: scopedSchema }) };
  const common = { contextId, contextRevision: 1, kind: "mcp_tool", name: tool.name,
    revision: 1, enabled: "enabled", stale: false, inputSchema: scopedSchema, outputSchema: scopedSchema, tool };
  const direct = { ...common, id: "direct-read", capabilityId: "direct-read", executor: "hub_direct",
    provenance: { serverSourceFingerprint: source.sourceFingerprint }, sourceRefs: [{ sourceId: source.id, revision: 1 }] };
  const host = { ...common, id: "codex-read", capabilityId: "codex-read", executor: "codex_host",
    provenance: { serverSourceId: source.id, serverSourceFingerprint: source.sourceFingerprint } };
  for (const capability of [direct, host]) {
    f.repo.insert("capabilities", capability.id, capability);
    f.repo.insert("capability_revisions", capability.id + "@1",
      { ...capability, id: capability.id + "@1", capabilityRevision: 1 });
  }
  const connection = { id: "ordered-connection", revision: 1, sourceId: source.id, sourceFingerprint: source.sourceFingerprint,
    transport: "streamable_http", protocolEra: "modern", endpoint: "http://127.0.0.1:1/synthetic-ordered",
    allowedHosts: ["127.0.0.1"], disabled: false, tools: [tool] };
  f.repo.insert("connections", connection.id, { ...connection, sourceRouteHash: sourceConnectionRouteHash(connection) });
  const binding = { id: "direct-binding", environment: "test", revision: 1, connectionId: connection.id,
    connectionRevision: 1, sourceCapabilityId: direct.id, sourceCapabilityRevision: 1, allowedTools: [tool.name],
    lockedArguments: {}, allowedQueryTemplates: [], maxRows: 100, timeoutSeconds: 10,
    simulationOnly: false, validationStatus: "BINDING_VERIFIED" };
  f.repo.insert("bindings", binding.id, binding);
  const mappings = { "/traceId": { ref: { source: "input", pointer: "/traceId" } } };
  const businessRule = { pointer: "/traceId", verified: ["demo-verified"],
    unavailable: ["demo-unavailable"], failed: ["demo-failed"] };
  const added = f.patch([
    { op: "set_input_schema", schema: scopedSchema },
    { op: "set_binding", key: "read", bindingId: binding.id },
    { op: "add_node", nodeId: "trace", nodeType: "mcp_tool", title: "Read trace",
      capabilityRef: { capabilityId: direct.id, revision: 1 },
      config: { bindingKey: "read", argumentsMappings: mappings, businessVerification: businessRule } },
    { op: "disconnect", source: "input", target: "end", port: "next" },
    { op: "connect", source: "input", target: "trace", port: "next" },
    { op: "connect", source: "trace", target: "end", port: "next" },
    { op: "update_node", nodeId: "end", changes: { config: { resultRef: { ref: { source: "node", nodeId: "trace", pointer: "/traceId" } } } } },
  ]);
  assert.deepEqual(added.issues, []);
  return { ...f, added, binding, direct, host, connection, source, mappings, businessRule,
    switchToCodex: { op: "switch_tool_executor", nodeId: "trace", capabilityId: host.id, revision: 1 } };
}

test("executor switches preserve graph, mappings and business verification, with requirements bound to each published version", async t => {
  const f = switchFixture();
  t.after(f.close);
  const before = f.authoring.get("authoring-demo");
  const original = f.authoring.publish({ workflowId: before.id, expectedRevision: before.revision, version: "1.0.0",
    expectedBindingRevisions: { [f.binding.id]: 1 }, expectedCapabilityRevisions: { [f.direct.id]: 1 }, idempotencyKey: "publish-direct" });
  const switched = f.patch([f.switchToCodex], before.revision + 1, "switch-codex");
  assert.deepEqual(f.patch([f.switchToCodex], before.revision + 1, "switch-codex"), switched);
  assert.deepEqual(switched.issues, []);
  const current = f.authoring.get(before.id);
  assert.deepEqual(current.layout, before.layout);
  assert.deepEqual(current.draft.edges, before.draft.edges);
  assert.deepEqual(current.draft.bindings, {});
  assert.equal(current.draft.mode, "guided");
  assert.deepEqual(current.draft.nodes.find((node: Json) => node.id === "trace"), {
    id: "trace", title: "Read trace", type: "agent_task", config: {
      kind: "host_tool", executorRef: "codex_host", requireHostReceipt: true,
      instructions: "Call the frozen Codex tool and submit its structured result.",
      inputMappings: f.mappings, outputSchema: f.host.outputSchema, capabilityRef: { capabilityId: f.host.id, revision: 1 },
      businessVerification: f.businessRule,
    },
  });
  assert.equal(current.draft.executionRequirements.requiresCodex, true);
  const publishedHost = f.authoring.publish({ workflowId: before.id, expectedRevision: current.revision,
    version: "2.0.0", expectedBindingRevisions: {}, expectedCapabilityRevisions: { [f.host.id]: 1 }, idempotencyKey: "publish-host" });
  const switchBack = f.patch([
    { op: "set_binding", key: "reviewed", bindingId: f.binding.id },
    { op: "switch_tool_executor", nodeId: "trace", capabilityId: f.direct.id, revision: 1, bindingKey: "reviewed" },
  ], current.revision + 1, "switch-direct");
  assert.deepEqual(switchBack.issues, []);
  const restored = f.authoring.get(before.id);
  const restoredNode = restored.draft.nodes.find((node: Json) => node.id === "trace");
  assert.deepEqual(restoredNode.config.argumentsMappings, f.mappings);
  assert.deepEqual(restoredNode.config.businessVerification, f.businessRule);
  assert.equal(restored.draft.executionRequirements.requiresCodex, false);
  for (const [version, frozen, requiresCodex, hostNodes] of [
    ["1.0.0", original, false, []],
    ["2.0.0", publishedHost, true, [{ id: "trace", title: "Read trace" }]],
  ] as const) {
    assert.equal(f.repo.get("versions", before.id + "@" + version).contentHash, frozen.contentHash);
    const requirements = f.engine.handle("workflow_get", { workflowId: before.id, version }).executionRequirements;
    assert.equal(requirements.requiresCodex, requiresCodex);
    assert.deepEqual(requirements.hostNodes, hostNodes);
  }
});

test("executor switches require current source and actual direct binding affinity and retain binding constraints", async t => {
  const variants: { name: string; code?: string; adjust: (f: ReturnType<typeof switchFixture>) => void }[] = [
    { name: "unrelated binding", adjust: f => f.repo.put("bindings", f.binding.id, { ...f.binding, sourceCapabilityId: "other" }) },
    { name: "wrong binding environment", adjust: f => f.repo.put("bindings", f.binding.id, { ...f.binding, environment: "staging" }) },
    { name: "unrelated connection", adjust: f => f.repo.put("connections", f.connection.id, { ...f.connection, sourceId: "other" }) },
    { name: "changed approved endpoint", adjust: f => {
      const connection = f.repo.get("connections", f.connection.id);
      f.repo.put("connections", connection.id, { ...connection, endpoint: "http://127.0.0.1:2/other" });
    } },
    { name: "historical edited connection without route evidence", adjust: f => {
      f.repo.put("connections", f.connection.id, { ...f.connection, revision: 2 });
      f.repo.put("bindings", f.binding.id, { ...f.binding, connectionRevision: 2 });
    } },
    { name: "locked parameters", adjust: f => f.repo.put("bindings", f.binding.id, { ...f.binding, lockedArguments: { "/traceId": "demo" } }) },
    { name: "narrower row budget", adjust: f => f.repo.put("bindings", f.binding.id, { ...f.binding, maxRows: 10 }) },
    { name: "shorter tool timeout", adjust: f => f.repo.put("bindings", f.binding.id, { ...f.binding, timeoutSeconds: 1 }) },
    { name: "simulation-only binding", adjust: f => f.repo.put("bindings", f.binding.id, { ...f.binding, simulationOnly: true }) },
    { name: "stale context", code: "CAPABILITY_STALE", adjust: f =>
      f.repo.put("host_contexts", f.host.contextId, { id: f.host.contextId, revision: 2 }) },
  ];
  for (const { name, code, adjust } of variants) await t.test(name, async sub => {
    const f = switchFixture();
    sub.after(f.close);
    adjust(f);
    const before = f.authoring.get("authoring-demo");
    const eventCount = f.repo.changes().length;
    assert.throws(() => f.patch([
      { op: "set_metadata", changes: { name: "must roll back" } }, f.switchToCodex,
    ], f.added.revision), { code: code ?? "ENVIRONMENT_OVERRIDE_DENIED" });
    assert.deepEqual(f.authoring.get("authoring-demo"), before);
    assert.equal(f.repo.changes().length, eventCount);
  });
});

test("scope mappings need structured receipts and guaranteed, compatible fields", async t => {
  const f = switchFixture();
  t.after(f.close);
  const switched = f.patch([f.switchToCodex], f.added.revision);
  const before = f.authoring.get("authoring-demo");
  const host = before.draft.nodes.find((node: Json) => node.id === "trace");
  const update = (config: Json) => [{ op: "update_node", nodeId: "trace", changes: { config } }];
  const { requireHostReceipt, ...legacy } = host.config;
  const scope = { "/traceId": "/traceId" };
  for (const config of [legacy, { ...legacy, requireHostReceipt: false }]) {
    assert.throws(() => f.patch(update({ ...config, receiptScopeMappings: scope }), switched.revision),
      { code: "HOST_RECEIPT_REQUIRED" });
    assert.equal(f.authoring.get(before.id).revision, switched.revision);
  }
  const invalid = f.patch(update({ ...host.config, receiptScopeMappings: { "/traceId": "/unbound" } }), switched.revision);
  assert.deepEqual(invalid.issues.map((issue: Json) => [issue.code, issue.path]), [
    ["REFERENCE_INVALID", "/nodes/2/config/receiptScopeMappings/~1traceId"],
  ]);
  const valid = f.patch(update({ ...host.config, receiptScopeMappings: scope }), invalid.revision);
  assert.deepEqual(valid.issues, []);
  assert.throws(() => f.patch([
    { op: "set_binding", key: "read", bindingId: f.binding.id },
    { op: "switch_tool_executor", nodeId: "trace", capabilityId: f.direct.id, revision: 1, bindingKey: "read" },
  ], valid.revision), { code: "ENVIRONMENT_OVERRIDE_DENIED" });
});

test("raw draft save and semantic undo derive executor requirements from current nodes", async t => {
  const f = switchFixture();
  t.after(f.close);
  const switched = f.patch([f.switchToCodex], f.added.revision);
  const current = f.authoring.get("authoring-demo");
  const saved = f.authoring.saveRaw({ ...current.draft, executionRequirements: {
    requiresCodex: false, executors: [], capabilityRefs: [],
  } }, current.revision, current.layout, current.layoutRevision);
  assert.equal(saved.draft.executionRequirements.requiresCodex, true);
  const changed = f.patch([
    { op: "add_node", nodeId: "assistant", nodeType: "agent_task", title: "Later assistant", config: {
      kind: "analysis", instructions: "Review synthetic trace", executorRef: "assistant_local",
      inputMappings: {}, outputSchema: { type: "object", properties: {}, additionalProperties: false },
    } },
  ], saved.revision);
  f.authoring.undo({ workflowId: current.id, expectedRevision: changed.revision,
    commandId: switched.commandId, idempotencyKey: "undo-switch" });
  const finalDraft = f.authoring.get(current.id).draft;
  assert.deepEqual(finalDraft.executionRequirements.executors, ["hub_direct", "assistant_local"]);
  assert.equal(finalDraft.executionRequirements.requiresCodex, false);
  assert.ok(finalDraft.nodes.some((node: Json) => node.id === "assistant"));
});
