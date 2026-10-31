import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createServer, type ServerResponse } from "node:http";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { Application } from "../../packages/application/src/index.js";
import { AssistantCore } from "../../packages/assistant-core/src/index.js";
import { ProjectKnowledge } from "../../packages/project-knowledge/src/index.js";
import { projectRoot } from "../../packages/contracts/src/index.js";
import { requestedActions } from "../../packages/contracts/src/assistant-intent.js";
import { hash, type Json } from "../../packages/contracts/src/domain.js";

type Protocol = "openai_responses" | "openai_compatible_chat";
const MODEL_KEY = "synthetic-acceptance-model-key-only";
const draft = (workflowId: string) => ({ workflowId, name: workflowId, environment: "test", mode: "auto", template: "blank", idempotencyKey: workflowId + ":create" });
const tool = (name: string, args: Json, id: string) => ({ id, name, arguments: JSON.stringify(args) });
const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };

function reply(res: ServerResponse, kind: Protocol, text = "done", calls: Json[] = [], usage?: Json) {
  const body = kind === "openai_responses"
    ? { status: "completed", output: calls.length ? calls.map(c => ({ type: "function_call", call_id: c.id, name: c.name, arguments: c.arguments })) : [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] }
    : { choices: [{ finish_reason: calls.length ? "tool_calls" : "stop", message: { role: "assistant", content: text, tool_calls: calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) } }] };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ...body, ...(usage === undefined ? {} : { usage }) }));
}

async function fixture(t: TestContext, respond: (body: Json, res: ServerResponse, index: number) => void, kind: Protocol = "openai_compatible_chat") {
  const requests: Json[] = [], callbackErrors: unknown[] = [];
  const server = createServer(async (req, res) => {
    try { let text = ""; for await (const part of req) text += part; const body = JSON.parse(text); requests.push(body); respond(body, res, requests.length - 1); }
    catch (error) { callbackErrors.push(error); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const db = new Database(":memory:"), repo = new Repository(db), vault = new Vault(repo); vault.initialize("Synthetic-acceptance-password-only");
  const engine = new Engine(repo, vault, new Connectors(repo, vault)), app = new Application(engine);
  t.after(async () => { await app.close(); await engine.close(); db.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); assert.deepEqual(callbackErrors, []); });
  const profile = app.assistant.saveProfile({ name: "Loopback acceptance", providerKind: kind, baseUrl: "http://127.0.0.1:" + (server.address() as { port: number }).port + "/v1", model: "synthetic", apiKey: MODEL_KEY, stream: false });
  const send = (text: string, context: Json = {}, mode = "compose", owner = "execution", key = crypto.randomUUID()) => {
    const session = app.assistant.session(owner), body = { text, context, mode, requestedActions: requestedActions(text), modelProfileId: profile.id, idempotencyKey: key };
    return { ...app.assistant.submit(session.id, body, owner), sessionId: session.id, body };
  };
  return { app, engine, repo, vault, profile, requests, send };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function publish(f: Fixture, workflowId: string, revision = 1) {
  return f.app.authoring.publish({ workflowId, expectedRevision: revision, version: "1.0.0", expectedBindingRevisions: {}, expectedCapabilityRevisions: {}, idempotencyKey: workflowId + ":publish" });
}
async function state(f: Fixture, runId: string, expected: string, owner = "execution") {
  for (let i = 0; i < 200; i++) { const current = f.engine.status(runId, owner); if (current.state === expected) return current; if (["FAILED", "CANCELLED", "OUTCOME_UNKNOWN"].includes(current.state)) assert.fail(JSON.stringify(current)); await new Promise(r => setTimeout(r, 5)); }
  assert.fail("Synthetic run did not reach " + expected);
}
async function waiting(f: Fixture, workflowId: string) {
  f.app.authoring.create({ ...draft(workflowId), mode: "guided" });
  const changed = f.app.authoring.patch({ workflowId, expectedRevision: 1, idempotencyKey: workflowId + ":patch", operations: [
    { op: "add_node", nodeId: "analysis", nodeType: "agent_task", title: "Synthetic analysis", config: { kind: "analysis", executorRef: "assistant_local", instructions: "Return numeric count", inputMappings: {}, outputSchema: { type: "object", properties: { count: { type: "number" } }, required: ["count"], additionalProperties: false } } },
    { op: "disconnect", source: "input", target: "end", port: "next" }, { op: "connect", source: "input", target: "analysis", port: "next" }, { op: "connect", source: "analysis", target: "end", port: "next" },
  ] }); publish(f, workflowId, changed.revision);
  const accepted = f.engine.start({ workflowId, version: "1.0.0", mode: "guided", inputs: {}, idempotencyKey: workflowId + ":run" });
  return state(f, accepted.runId, "WAITING_AGENT");
}

test("LLM-07: one real HTTP response mixes reads and writes, awaits each dispatch, and returns matching call IDs in both protocols", async t => {
  for (const kind of ["openai_responses", "openai_compatible_chat"] as const) await t.test(kind, async sub => {
    const workflowId = "multi-" + (kind === "openai_responses" ? "responses" : "chat"), gate = deferred(), entered = deferred();
    const calls = [tool("workflow_draft_create", draft(workflowId), "create"), tool("workflow_draft_get", { workflowId }, "read-before"),
      tool("workflow_draft_patch", { workflowId, expectedRevision: 1, operations: [{ op: "set_metadata", changes: { name: "first write" } }], idempotencyKey: "first-write" }, "patch-first"),
      tool("workflow_draft_get", { workflowId }, "read-between"),
      tool("workflow_draft_patch", { workflowId, expectedRevision: 2, operations: [{ op: "set_metadata", changes: { name: "second write" } }], idempotencyKey: "second-write" }, "patch-second")];
    const f = await fixture(sub, (_body, res, index) => reply(res, kind, "done", index === 0 ? calls : []), kind);
    const original = f.app.handle.bind(f.app), order: string[] = []; let running = 0, maxRunning = 0;
    f.app.handle = async (name, args, owner) => { running++; maxRunning = Math.max(maxRunning, running); order.push(name); try { if (name === "workflow_draft_create") { entered.release(); await gate.promise; } return await original(name, args, owner); } finally { running--; } };
    sub.after(() => gate.release());
    const accepted = f.send("创建流程并连续修改名称，然后保存草稿"); await entered.promise;
    assert.equal(f.repo.all("assistant_tool_calls").length, 1); assert.equal(f.repo.all("assistant_tool_calls")[0].status, "DISPATCHED"); assert.equal(f.repo.get("workflows", workflowId), undefined);
    gate.release(); await f.app.assistant.settled(); const task = f.app.assistant.task(accepted.taskId);
    assert.equal(task.status, "COMPLETED"); assert.equal(maxRunning, 1); assert.deepEqual(order, calls.map(c => c.name)); assert.equal(f.requests.length, 2);
    const sent = kind === "openai_responses" ? f.requests[1].input.filter((m: Json) => m.type === "function_call_output").map((m: Json) => ({ id: m.call_id, result: JSON.parse(m.output) })) : f.requests[1].messages.filter((m: Json) => m.role === "tool").map((m: Json) => ({ id: m.tool_call_id, result: JSON.parse(m.content) }));
    assert.deepEqual(sent.map((m: Json) => m.id), calls.map(c => c.id)); assert.deepEqual(sent.map((m: Json) => m.result.revision), [1, 1, 2, 2, 3]);
    assert.equal(sent[1].result.draft.name, workflowId); assert.equal(sent[3].result.draft.name, "first write");
    for (const receipt of sent) assert.deepEqual(receipt.result, task.tools.find((c: Json) => c.callId === receipt.id).result);
    assert.equal(f.repo.get("workflows", workflowId).draft.name, "second write"); assert.equal(f.repo.get("workflows", workflowId).revision, 3);
  });
});

test("LLM-08: absent usage stays null, and mixed multi-round usage remains explicitly partial in durable task state", async t => {
  const f = await fixture(t, (_body, res) => reply(res, "openai_compatible_chat", "help"));
  const noUsage = f.send("解释本项目", {}, "help"); await f.app.assistant.settled();
  const unknown = f.app.assistant.task(noUsage.taskId); assert.equal(unknown.status, "COMPLETED"); assert.equal(unknown.usage, null); assert.equal(unknown.usageAccounting, "partial_or_unknown"); assert.equal(f.repo.get("assistant_tasks", noUsage.taskId).usage, null);
  for (const missingFirst of [false, true]) await t.test(missingFirst ? "missing then reported" : "reported then missing", async sub => {
    const workflowId = missingFirst ? "usage-missing-first" : "usage-missing-last";
    const g = await fixture(sub, (_body, res, index) => reply(res, "openai_compatible_chat", "done", index === 0 ? [tool("workflow_draft_create", draft(workflowId), "create")] : [], (index === 0) === missingFirst ? undefined : { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 }));
    const accepted = g.send("创建流程并保存草稿"); await g.app.assistant.settled(); const task = g.app.assistant.task(accepted.taskId);
    assert.equal(task.status, "COMPLETED"); assert.equal(task.rounds, 2); assert.deepEqual(task.usage, { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 }); assert.equal(task.usageAccounting, "partial_or_unknown"); assert.deepEqual(g.repo.get("assistant_tasks", task.id).usage, task.usage);
    const usageEvents = g.repo.changes(0, 10000).filter(e => e.taskId === task.id && e.type === "usage.updated"); assert.equal(usageEvents.length, 2); if (missingFirst) assert.equal(usageEvents[0].data.usage, null);
  });
});

test("ASST-02: real HTTP tool feedback corrects a schema type error while the exact checkpoint remains unconsumed", async t => {
  let checkpoint: Json, f!: Fixture;
  f = await fixture(t, (body, res, index) => {
    if (index === 1) {
      const error = JSON.parse(body.messages.find((m: Json) => m.tool_call_id === "wrong-type").content).error;
      assert.equal(error.code, "INPUT_INVALID"); assert.match(error.message, /count.*number/);
      const same = f.engine.status(checkpoint.runId); assert.equal(same.checkpoint.id, checkpoint.checkpoint.id); assert.equal(same.revision, checkpoint.revision); assert.equal(same.checkpoint.token, checkpoint.checkpoint.token);
      assert.equal(f.repo.all("assistant_tool_calls").filter(c => c.taskId === accepted.taskId && !c.isError).length, 0);
    }
    reply(res, "openai_compatible_chat", "done", index < 2 ? [tool("workflow_advance", { runId: checkpoint.runId, checkpointId: checkpoint.checkpoint.id, expectedRevision: checkpoint.revision, idempotencyKey: index === 0 ? "wrong-type" : "correct-type", submission: { type: "agent_result", payload: { count: index === 0 ? "wrong" : 42 } } }, index === 0 ? "wrong-type" : "correct-type")] : []);
  });
  checkpoint = await waiting(f, "correction"); const accepted = f.send("运行选中的流程并完成分析", { runId: checkpoint.runId }); await f.app.assistant.settled();
  const task = f.app.assistant.task(accepted.taskId); assert.equal(task.status, "COMPLETED"); assert.equal(f.requests.length, 3); assert.equal(task.tools.length, 2); assert.equal(task.tools.filter((c: Json) => c.isError).length, 1);
  assert.equal(task.tools[0].arguments.checkpointId, task.tools[1].arguments.checkpointId); await state(f, checkpoint.runId, "SUCCEEDED"); assert.equal(f.repo.get("runs", checkpoint.runId).outputs.analysis.count, 42);
  assert.equal((f.repo.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE operation='advance' AND key='correct-type'").get() as { n: number }).n, 1);
  assert.equal((f.repo.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE operation='advance' AND key='wrong-type'").get() as { n: number }).n, 0);
});

test("ASST-02: analysis worker retries a wrong output type and advances the same checkpoint exactly once", async t => {
  let checkpoint: Json, f!: Fixture;
  f = await fixture(t, (body, res, index) => {
    if (index === 1) { const same = f.engine.status(checkpoint.runId); assert.equal(same.checkpoint.id, checkpoint.checkpoint.id); assert.equal(same.revision, checkpoint.revision); assert.match(body.messages.at(-1).content, /invalid/); }
    reply(res, "openai_compatible_chat", JSON.stringify({ count: index === 0 ? "wrong" : 7 }));
  });
  checkpoint = await waiting(f, "analysis-correction"); let advances = 0; const original = f.engine.advance.bind(f.engine);
  f.engine.advance = (...args: Parameters<Engine["advance"]>) => { advances++; assert.equal(args[0].checkpointId, checkpoint.checkpoint.id); return original(...args); };
  const accepted = f.app.assistant.analyzeCheckpoint(checkpoint.runId, f.profile.id, "analysis-correct-type"); await f.app.assistant.settled();
  assert.equal(f.app.assistant.task(accepted.taskId).status, "COMPLETED"); assert.equal(f.requests.length, 2); assert.equal(advances, 1); await state(f, checkpoint.runId, "SUCCEEDED"); assert.equal(f.repo.get("runs", checkpoint.runId).outputs.analysis.count, 7);
});

test("ASST-04: cancellation during a dispatched write retains its real receipt and never dispatches queued calls or replays acceptance", async t => {
  const gate = deferred(), entered = deferred(), workflowId = "cancel-dispatched";
  const f = await fixture(t, (_body, res) => reply(res, "openai_compatible_chat", "", [tool("workflow_draft_create", draft(workflowId), "first-write"), tool("workflow_draft_patch", { workflowId, expectedRevision: 1, idempotencyKey: "must-not-run", operations: [{ op: "set_metadata", changes: { name: "must not happen" } }] }, "queued-write")]));
  const original = f.app.handle.bind(f.app); let dispatched = 0;
  f.app.handle = async (name, args, owner) => { dispatched++; entered.release(); await gate.promise; return original(name, args, owner); };
  t.after(() => gate.release()); const accepted = f.send("创建流程并修改名称，然后保存草稿"); await entered.promise;
  const ledgerId = accepted.taskId + ":first-write"; assert.equal(f.repo.get("assistant_tool_calls", ledgerId).status, "DISPATCHED"); assert.equal(f.app.assistant.task(accepted.taskId).status, "CALLING_TOOL");
  f.app.assistant.cancel(accepted.taskId); gate.release(); await f.app.assistant.settled(); const task = f.app.assistant.task(accepted.taskId);
  assert.equal(task.status, "CANCELLED"); assert.equal(dispatched, 1); assert.equal(f.requests.length, 1); assert.equal(task.tools.length, 1); assert.equal(task.tools[0].status, "COMPLETED"); assert.equal(task.tools[0].result.workflowId, workflowId); assert.equal(f.repo.get("workflows", workflowId).revision, 1);
  const receipt = f.repo.get("assistant_tool_calls", ledgerId), eventsBefore = f.repo.changes(0, 10000).length;
  const restarted = new AssistantCore(f.app); t.after(() => restarted.close());
  assert.equal(restarted.submit(accepted.sessionId, accepted.body).taskId, accepted.taskId); await restarted.settled();
  assert.equal(restarted.task(accepted.taskId).status, "CANCELLED"); assert.deepEqual(f.repo.get("assistant_tool_calls", ledgerId), receipt); assert.equal(f.repo.changes(0, 10000).length, eventsBefore); assert.equal(dispatched, 1); assert.equal(f.requests.length, 1);
});

test("KB-05: editing only a temporary document updates real hashes and line numbers, while an already issued citation remains stale after rebuild", t => {
  const root = mkdtempSync(resolve(tmpdir(), "flowhub-knowledge-acceptance-")), db = new Database(":memory:"), repo = new Repository(db);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); }); mkdirSync(resolve(root, "docs")); mkdirSync(resolve(root, "contracts"));
  copyFileSync(resolve(projectRoot, "contracts/mcp-v2-tool-inputs.schema.json"), resolve(root, "contracts/mcp-v2-tool-inputs.schema.json"));
  const path = resolve(root, "docs/V2_USER_GUIDE.md"), original = [...Array.from({ length: 24 }, (_, i) => "placeholder " + i), "# citationupgradefixture", "citationupgradefixture version one"].join("\n"); writeFileSync(path, original);
  const knowledge = new ProjectKnowledge(repo, root), issued = knowledge.search({ query: "citationupgradefixture", limit: 1 }).citations[0];
  assert.equal(issued.lineStart, 25); assert.equal(knowledge.source(issued).stale, false);
  const updated = [...Array.from({ length: 24 }, (_, i) => "inserted heading line " + i), original.replace("version one", "version two")].join("\n"); writeFileSync(path, updated);
  assert.equal(knowledge.source(issued).stale, true); knowledge.rebuild(); const current = knowledge.search({ query: "citationupgradefixture", limit: 1 }).citations[0];
  assert.equal(current.lineStart, 49); assert.notEqual(current.contentHash, issued.contentHash); assert.notEqual(current.chunkId, issued.chunkId); assert.equal(knowledge.source(current).stale, false);
  const old = knowledge.source({ ...issued, lineStart: String(issued.lineStart), lineEnd: String(issued.lineEnd) }); assert.equal(old.stale, true); assert.equal(old.contentHash, issued.contentHash); assert.equal(old.lineStart, issued.lineStart); assert.notEqual(old.currentContentHash, issued.contentHash);
  const actual = readFileSync(path, "utf8").split("\n").slice(current.lineStart - 1, current.lineEnd).join("\n"); assert.equal(current.contentHash, hash(actual));
  for (const invalid of [{ ...issued, lineStart: "1e2" }, { ...issued, lineEnd: issued.lineStart + 1000 }, { chunkId: issued.chunkId, contentHash: "bad" }, { ...issued, lineStart: -1 }, { ...issued, contentHash: "0".repeat(65) }]) assert.throws(() => knowledge.source(invalid), { code: "INPUT_INVALID" });
});

test("KB-06: a real large report is explicitly bounded in model context, artifact pages keep offsets, and original bytes and hash remain intact", async t => {
  let artifact: Json, run: Json, nextPageOffset: number;
  const f = await fixture(t, (_body, res, index) => reply(res, "openai_compatible_chat", "done", index === 0 ? [tool("artifact_read", { runId: run.runId, artifactId: artifact.id, offset: nextPageOffset, maxBytes: 12000 }, "next-page")] : []));
  const workflowId = "large-report"; f.app.authoring.create(draft(workflowId));
  const question = "LARGE_ARTIFACT_SYNTHETIC_START\n" + "业务原文 business-token@example.invalid 中文\n".repeat(1800) + "LARGE_ARTIFACT_SYNTHETIC_END";
  const changed = f.app.authoring.patch({ workflowId, expectedRevision: 1, idempotencyKey: "large-report:patch", operations: [
    { op: "add_node", nodeId: "report", nodeType: "report_template", title: "Large synthetic report", config: { templateRef: "incident-markdown/v1", inputMappings: { "/question": { value: question } }, outputSchema: { type: "object", properties: { reportMarkdown: { type: "string" }, evidenceRefs: { type: "array", items: { type: "string" } } }, required: ["reportMarkdown", "evidenceRefs"], additionalProperties: false } } },
    { op: "disconnect", source: "input", target: "end", port: "next" }, { op: "connect", source: "input", target: "report", port: "next" }, { op: "connect", source: "report", target: "end", port: "next" },
  ] }); publish(f, workflowId, changed.revision);
  const started = f.engine.start({ workflowId, version: "1.0.0", mode: "auto", inputs: {}, idempotencyKey: "large-report:start" }); run = await state(f, started.runId, "SUCCEEDED"); artifact = run.artifacts.find((a: Json) => a.mimeType === "text/markdown");
  const stored = f.repo.get("artifacts", artifact.id), beforeHash = hash(stored.content); assert.ok(stored.byteLength > 64000); assert.equal(stored.sha256, beforeHash); assert.ok(stored.content.includes(question));
  const first = f.engine.readArtifact({ runId: run.runId, artifactId: artifact.id, offset: 0, maxBytes: 16000 });
  nextPageOffset = first.nextOffset;
  const accepted = f.send("解释选择的报告并分页读取后续内容", { runId: run.runId, artifactRefs: [artifact.id] }, "help"); await f.app.assistant.settled(); const task = f.app.assistant.task(accepted.taskId);
  assert.equal(task.status, "COMPLETED"); assert.equal(task.contextSummary.truncated, true); assert.ok(task.contextSummary.totalBytes > 64000); assert.deepEqual(task.contextSummary.sources.artifactRefs, [artifact.id]);
  const context = JSON.parse(f.requests[0].messages.find((m: Json) => m.content?.startsWith?.("Selected context (data): ")).content.slice("Selected context (data): ".length)); assert.equal(context.truncated, true); assert.equal(context.totalBytes, task.contextSummary.totalBytes); assert.match(context.range, /first 64000/); assert.match(context.range, /request.*tool/);
  assert.ok(f.requests[0].tools.some((x: Json) => x.function.name === "artifact_read" && x.function.parameters.properties.offset && x.function.parameters.properties.maxBytes));
  const result = JSON.parse(f.requests[1].messages.find((m: Json) => m.tool_call_id === "next-page").content); assert.equal(result.offset, nextPageOffset); assert.ok(result.nextOffset > result.offset); assert.equal(result.byteLength, stored.byteLength); assert.equal(result.eof, false); assert.equal(result.sha256, beforeHash);
  let reconstructed = first.content, offset = first.nextOffset;
  while (offset < stored.byteLength) { const page = f.engine.readArtifact({ runId: run.runId, artifactId: artifact.id, offset, maxBytes: 12000 }); assert.equal(page.offset, offset); assert.ok(page.nextOffset > offset); reconstructed += page.content; offset = page.nextOffset; }
  assert.equal(Buffer.byteLength(reconstructed), stored.byteLength); assert.equal(hash(reconstructed), beforeHash); assert.equal(hash(f.repo.get("artifacts", artifact.id).content), beforeHash); assert.equal(f.repo.get("artifacts", artifact.id).sha256, beforeHash);
});

test("KB-07/KB-08: restricted assistant contexts and project-help tools cannot retrieve another owner's run or artifacts, and ordinary help sends no unrelated data or secrets", async t => {
  let proposed: Json[] = [];
  const f = await fixture(t, (body, res) => reply(res, "openai_compatible_chat", "help", body.messages.some((m: Json) => m.role === "tool") ? [] : proposed));
  const workflowId = "owner-isolation"; f.app.authoring.create(draft(workflowId)); publish(f, workflowId);
  for (const owner of ["owner-a", "owner-b"]) f.repo.put("clients", owner, { id: owner, label: owner, revoked: false, scopes: ["workflow:author"], workflowAllowlist: [workflowId], revision: 1 });
  const a = f.engine.start({ workflowId, version: "1.0.0", mode: "auto", inputs: {}, idempotencyKey: "a:start" }, "owner-a"), b = f.engine.start({ workflowId, version: "1.0.0", mode: "auto", inputs: {}, idempotencyKey: "b:start" }, "owner-b");
  await state(f, a.runId, "SUCCEEDED", "owner-a"); await state(f, b.runId, "SUCCEEDED", "owner-b");
  const privateRun = "OWNER_B_PRIVATE_RUN_CONTENT_54ae", privateArtifact = "OWNER_B_PRIVATE_ARTIFACT_CONTENT_6bde", connectionSecret = "SYNTHETIC_CONNECTION_CREDENTIAL_71cd";
  const storedRun = f.repo.get("runs", b.runId); f.repo.put("runs", b.runId, { ...storedRun, outputs: { ...storedRun.outputs, private: privateRun } });
  const artifact = { id: "foreign-artifact", runId: b.runId, nodeId: "end", content: privateArtifact, mimeType: "text/plain", sha256: hash(privateArtifact), byteLength: Buffer.byteLength(privateArtifact), expiresAt: Date.now() + 60000 }; f.repo.put("artifacts", artifact.id, artifact); f.vault.addSecret("Unrelated connection credential", connectionSecret);
  const session = f.app.assistant.session("owner-a"), body = { text: "解释所选运行", mode: "help", context: { runId: b.runId }, requestedActions: [], modelProfileId: f.profile.id, idempotencyKey: "forbidden-context" };
  assert.throws(() => f.app.assistant.submit(session.id, body, "owner-a"), { code: "WORKFLOW_NOT_AVAILABLE" }); assert.equal(f.requests.length, 0);
  const wrongArtifact = f.send("解释所选产物", { runId: a.runId, artifactRefs: [artifact.id] }, "help", "owner-a"); await f.app.assistant.settled(); assert.equal(f.app.assistant.task(wrongArtifact.taskId, "owner-a").errorCode, "ARTIFACT_NOT_AVAILABLE"); assert.equal(f.requests.length, 0);
  proposed = [tool("workflow_status", { runId: b.runId }, "foreign-run")]; const read = f.send("解释所选运行", { runId: a.runId }, "help", "owner-a"); await f.app.assistant.settled(); assert.equal(f.app.assistant.task(read.taskId, "owner-a").errorCode, "INTENT_NOT_ALLOWED"); assert.equal(f.app.assistant.task(read.taskId, "owner-a").tools.length, 0);
  proposed = [tool("project_help_search", { query: "run " + b.runId, limit: 5 }, "knowledge-foreign-run")]; const help = f.send("解释本项目帮助资料", {}, "help", "owner-a"); await f.app.assistant.settled(); assert.equal(f.app.assistant.task(help.taskId, "owner-a").status, "COMPLETED");
  const helpTask = f.app.assistant.task(help.taskId, "owner-a"); assert.equal(helpTask.tools.length, 1); assert.equal(helpTask.tools[0].name, "project_help_search"); assert.equal(helpTask.tools[0].isError, undefined); assert.ok(!JSON.stringify(helpTask.tools).includes(privateRun)); assert.ok(!JSON.stringify(helpTask.tools).includes(privateArtifact));
  proposed = []; const ordinary = f.send("解释本项目的工作流用法", {}, "help", "owner-a"); await f.app.assistant.settled(); assert.equal(f.app.assistant.task(ordinary.taskId, "owner-a").status, "COMPLETED");
  const outbound = JSON.stringify(f.requests); for (const value of [privateRun, privateArtifact, MODEL_KEY, connectionSecret]) assert.ok(!outbound.includes(value), value);
  const last = f.requests.at(-1).messages.find((m: Json) => m.content?.startsWith?.("Selected context (data): ")); const context = JSON.parse(last.content.slice("Selected context (data): ".length)); assert.equal(context.run, undefined); assert.equal(context.artifacts, undefined);
  assert.throws(() => f.engine.status(b.runId, "owner-a"), { code: "WORKFLOW_NOT_AVAILABLE" }); assert.throws(() => f.engine.readArtifact({ runId: b.runId, artifactId: artifact.id }, "owner-a"), { code: "WORKFLOW_NOT_AVAILABLE" });
});
