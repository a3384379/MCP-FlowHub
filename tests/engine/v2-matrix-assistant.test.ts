import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createServer, type ServerResponse } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { Application } from "../../packages/application/src/index.js";
import { HttpModelProvider } from "../../packages/llm-providers/src/index.js";
import { VERSION } from "../../packages/contracts/src/index.js";
import { HubError, type Json } from "../../packages/contracts/src/domain.js";

type Protocol = "openai_responses" | "openai_compatible_chat";
const syntheticKey = "SYNTHETIC-MATRIX-MODEL-KEY-941ec";
const blank = (workflowId: string) => ({ workflowId, name: workflowId, environment: "test", mode: "auto", template: "blank", idempotencyKey: workflowId + ":create" });
function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function within<T>(promise: Promise<T>, description: string, milliseconds = 10000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(description)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function answer(res: ServerResponse, text: string, calls: Json[] = []) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ finish_reason: calls.length ? "tool_calls" : "stop", message: { role: "assistant", content: text, tool_calls: calls } }] }));
}
function tool(name: string, args: Json, id: string) { return { id, type: "function", function: { name, arguments: JSON.stringify(args) } }; }
async function fixture(t: TestContext, respond?: (body: Json, res: ServerResponse, index: number) => void) {
  const requests: Json[] = [], paths: string[] = [], callbackErrors: unknown[] = [];
  const server = createServer(async (req, res) => {
    try { let text = ""; for await (const part of req) text += part; const body = JSON.parse(text); requests.push(body); paths.push(req.url ?? ""); respond?.(body, res, requests.length - 1); }
    catch (error) { callbackErrors.push(error); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const db = new Database(":memory:"), repo = new Repository(db), vault = new Vault(repo); vault.initialize("Synthetic-matrix-password-141");
  const engine = new Engine(repo, vault, new Connectors(repo, vault)), app = new Application(engine);
  t.after(async () => { await app.close(); await engine.close(); db.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); assert.deepEqual(callbackErrors, []); });
  const baseUrl = "http://127.0.0.1:" + (server.address() as { port: number }).port + "/v1";
  const profile = () => app.assistant.saveProfile({ name: "Synthetic matrix", providerKind: "openai_compatible_chat", baseUrl, model: "synthetic-matrix", apiKey: syntheticKey, stream: false });
  const send = (modelProfileId: string, mode = "help", context: Json = {}) => {
    const session = app.assistant.session();
    return app.assistant.submit(session.id, { text: mode === "help" ? "解释当前项目的用法" : "创建合成流程并保存草稿", mode, context, requestedActions: mode === "help" ? [] : ["edit_draft"], modelProfileId, idempotencyKey: crypto.randomUUID() });
  };
  return { app, repo, engine, vault, requests, paths, baseUrl, profile, send };
}

test("LLM-01 matrix: zero model profiles still allow actual draft editing and deterministic Mock tests, while inference fails explicitly", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.app.assistant.profiles(), []);
  const created = f.app.authoring.create(blank("matrix-no-profile"));
  const changed = f.app.authoring.patch({ workflowId: created.workflowId, expectedRevision: created.revision, operations: [{ op: "set_metadata", changes: { description: "Manual edit without a model profile" } }], idempotencyKey: "manual-without-profile" });
  const suite = await f.app.handle("workflow_test_generate", { workflowId: created.workflowId, expectedRevision: changed.revision, strategy: "deterministic", idempotencyKey: "no-profile-suite" });
  const acceptedRun = await f.app.handle("workflow_test_run", { suiteId: suite.suiteId, expectedSuiteRevision: suite.suiteRevision, mode: "mock", idempotencyKey: "no-profile-run" });
  await f.app.testing.idle();
  const result = await f.app.handle("workflow_test_status", { testRunId: acceptedRun.testRunId });
  assert.equal(result.status, "SUCCEEDED"); assert.ok(result.cases.length > 0);
  assert.equal(f.app.authoring.get(created.workflowId).draft.description, "Manual edit without a model profile");
  const task = f.send(""); await f.app.assistant.settled();
  assert.equal(f.app.assistant.task(task.taskId).errorCode, "MODEL_NOT_CONFIGURED");
  assert.equal(f.requests.length, 0); assert.deepEqual(f.app.assistant.profiles(), []);
});

test("LLM-02 matrix: real HTTP 401 diagnostics containing a Key never enter the public task, message, event or ordinary storage", async t => {
  const privateDiagnostic = "SYNTHETIC-UPSTREAM-PRIVATE-DIAGNOSTIC";
  const f = await fixture(t, (_body, res) => { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { code: "invalid_api_key", message: syntheticKey + ":" + privateDiagnostic } })); });
  const profile = f.profile(), accepted = f.send(profile.id); await f.app.assistant.settled();
  const task = f.app.assistant.task(accepted.taskId);
  assert.equal(task.status, "FAILED"); assert.equal(task.errorCode, "MODEL_AUTH_FAILED"); assert.equal(f.requests.length, 1);
  const stored = JSON.stringify({ task, profiles: f.app.assistant.profiles(), messages: f.repo.all("assistant_messages"), tasks: f.repo.all("assistant_tasks"), tools: f.repo.all("assistant_tool_calls"), commands: f.repo.db.prepare("SELECT * FROM commands").all(), secrets: f.repo.all("secrets"), events: f.repo.changes(0, 10000) });
  assert.ok(!stored.includes(syntheticKey)); assert.ok(!stored.includes(privateDiagnostic));
  assert.equal(task.tools.length, 0); assert.equal(f.repo.all("workflows").length, 0);
});

test("LLM-03 matrix: Retry-After controls a bounded three-attempt retry and cancellation interrupts the actual retry wait", async t => {
  const responseFinished = gate(), f = await fixture(t, (_body, res) => {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0.04" }); res.end(JSON.stringify({ error: { message: "synthetic rate limit" } }));
  });
  const provider = new HttpModelProvider({ providerKind: "openai_compatible_chat", baseUrl: f.baseUrl, model: "synthetic" }, syntheticKey), request = { messages: [], tools: [], signal: new AbortController().signal, stream: false };
  const started = performance.now(); await assert.rejects(provider.complete(request), (error: unknown) => error instanceof HubError && error.code === "MODEL_RATE_LIMITED" && error.details?.attempts === 3);
  assert.equal(f.requests.length, 3); assert.ok(performance.now() - started >= 65, "Two Retry-After waits must occur before the terminal rate-limit error");
  const g = await fixture(t, (_body, res) => { res.once("finish", () => responseFinished.resolve()); res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" }); res.end("{}"); });
  const accepted = g.send(g.profile().id); await within(responseFinished.promise, "429 response did not finish");
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(g.requests.length, 1); assert.equal(g.app.assistant.task(accepted.taskId).status, "GENERATING");
  const cancelledAt = performance.now(); g.app.assistant.cancel(accepted.taskId); await within(g.app.assistant.settled(), "Cancellation did not interrupt Retry-After", 500);
  assert.equal(g.app.assistant.task(accepted.taskId).status, "CANCELLED"); assert.ok(performance.now() - cancelledAt < 500);
  await new Promise(resolve => setTimeout(resolve, 1050)); assert.equal(g.requests.length, 1); assert.equal(g.repo.all("assistant_tool_calls").length, 0);
});

test("LLM-05 matrix: a real text-only HTTP service can answer help after rejecting tools, and composition fails before another request", async t => {
  for (const providerCode of ["unsupported_parameter", "unsupported_value"]) await t.test(providerCode, async sub => {
    const f = await fixture(sub, (body, res) => {
      if (body.tools?.length) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { code: providerCode, param: "tools", message: "Text-only synthetic model" } })); return; }
      if (body.stream) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end('data: {"choices":[{"delta":{"content":"text help"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); return; }
      answer(res, "text help");
    });
    const profile = f.profile(), probes = await f.app.assistant.testProfile(profile.id);
    assert.equal(probes.text.status, "passed"); assert.equal(probes.tools.status, "unsupported"); assert.equal(probes.tools.errorCode, "MODEL_UNSUPPORTED_TOOLS"); assert.equal(probes.tools.httpStatus, 400); assert.equal(probes.tools.providerCode, providerCode);
    const beforeHelp = f.requests.length, help = f.send(profile.id); await f.app.assistant.settled();
    assert.equal(f.app.assistant.task(help.taskId).status, "COMPLETED"); assert.equal(f.app.assistant.task(help.taskId).answer, "text help");
    assert.equal(f.requests.length, beforeHelp + 1); assert.equal(f.requests.at(-1).tools, undefined);
    const beforeCompose = f.requests.length, compose = f.send(profile.id, "compose"); await f.app.assistant.settled();
    assert.equal(f.app.assistant.task(compose.taskId).errorCode, "MODEL_UNSUPPORTED_TOOLS"); assert.equal(f.requests.length, beforeCompose);
    assert.equal(f.repo.all("workflows").length, 0); assert.equal(f.repo.all("assistant_tool_calls").length, 0); assert.ok(f.paths.every(path => path === "/v1/chat/completions"));
  });
});

test("LLM-05 matrix: authentication, tool-schema errors and server failures never mark tool support absent or trigger a text-only fallback", async t => {
  const cases = [
    { name: "401 authentication wins over unsupported tools code", status: 401, error: { code: "unsupported_parameter", param: "tools" }, expected: "MODEL_AUTH_FAILED", allRequests: true },
    { name: "403 authentication wins over unsupported tools value", status: 403, error: { code: "unsupported_value", param: "tools" }, expected: "MODEL_AUTH_FAILED", allRequests: true },
    { name: "400 unknown error without parameter", status: 400, error: {}, expected: "MODEL_INVALID_CONFIGURATION", allRequests: true },
    { name: "400 invalid tool schema", status: 400, error: { code: "invalid_request_error", param: "tools" }, expected: "MODEL_INVALID_CONFIGURATION", allRequests: false },
    { name: "400 tools parameter without unsupported code", status: 400, error: { param: "tools" }, expected: "MODEL_INVALID_CONFIGURATION", allRequests: false },
    { name: "400 unsupported stream parameter is not tool capability", status: 400, error: { code: "unsupported_parameter", param: "stream" }, expected: "MODEL_INVALID_CONFIGURATION", allRequests: false },
    { name: "500 tools parameter without unsupported code", status: 500, error: { param: "tools" }, expected: "MODEL_REQUEST_FAILED", allRequests: false },
    { name: "500 explicit unsupported tools code is still a server failure", status: 500, error: { code: "unsupported_parameter", param: "tools" }, expected: "MODEL_REQUEST_FAILED", allRequests: false },
    { name: "503 explicit unsupported tools value is still a server failure", status: 503, error: { code: "unsupported_value", param: "tools" }, expected: "MODEL_REQUEST_FAILED", allRequests: false },
    { name: "422 does not establish an unsupported tool capability", status: 422, error: { code: "unsupported_parameter", param: "tools" }, expected: "MODEL_REQUEST_FAILED", allRequests: false },
  ];
  for (const scenario of cases) await t.test(scenario.name, async sub => {
    const f = await fixture(sub, (body, res) => {
      if (scenario.allRequests || body.tools?.length) { res.writeHead(scenario.status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { ...scenario.error, message: "Classified synthetic failure" } })); return; }
      if (body.stream) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end('data: {"choices":[{"delta":{"content":"text help"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); return; }
      answer(res, "text help");
    });
    const profile = f.profile(), probes = await f.app.assistant.testProfile(profile.id);
    assert.equal(probes.text.status, scenario.allRequests ? "failed" : "passed"); assert.equal(probes.tools.status, "failed"); assert.equal(probes.tools.errorCode, scenario.expected); assert.equal(probes.tools.httpStatus, scenario.status);
    assert.equal(f.app.assistant.profiles().find(entry => entry.id === profile.id)!.capabilities.tools.status, "failed");
    const beforeHelp = f.requests.length;
    const help = f.send(profile.id); await f.app.assistant.settled();
    assert.equal(f.app.assistant.task(help.taskId).status, "FAILED"); assert.equal(f.app.assistant.task(help.taskId).errorCode, scenario.expected); assert.equal(f.requests.length, beforeHelp + 1); assert.ok(f.requests.at(-1).tools.length > 0);
    const beforeCompose = f.requests.length, compose = f.send(profile.id, "compose"); await f.app.assistant.settled();
    assert.equal(f.app.assistant.task(compose.taskId).status, "FAILED"); assert.equal(f.app.assistant.task(compose.taskId).errorCode, scenario.expected); assert.equal(f.requests.length, beforeCompose + 1); assert.ok(f.requests.at(-1).tools.length > 0);
    assert.ok(f.paths.every(path => path === "/v1/chat/completions")); assert.equal(f.repo.all("assistant_tool_calls").length, 0); assert.equal(f.repo.all("workflows").length, 0); assert.equal(f.repo.all("authoring_commands").length, 0);
  });
});

test("LLM-06 matrix: both HTTP protocols keep partial and even valid-but-unfinished streamed arguments away from every write", async t => {
  for (const protocol of ["openai_responses", "openai_compatible_chat"] as const) await t.test(protocol, async sub => {
    const partialSent = gate(), continueArguments = gate(), completeArgumentsSent = gate(), finishStream = gate();
    const workflowId = "matrix-stream-" + (protocol === "openai_responses" ? "responses" : "chat"), args = JSON.stringify(blank(workflowId)), midpoint = Math.floor(args.length / 2);
    const f = await fixture(sub, (body, res, index) => {
      if (index > 0) {
        if (protocol === "openai_responses") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'); }
        else { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end('data: {"choices":[{"delta":{"content":"saved"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); } return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (event: Json) => res.write("data: " + JSON.stringify(event) + "\n\n");
      void (async () => {
        if (protocol === "openai_responses") { emit({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "gated-create", name: "workflow_draft_create", arguments: "" } }); emit({ type: "response.function_call_arguments.delta", output_index: 0, delta: args.slice(0, midpoint) }); }
        else emit({ choices: [{ delta: { tool_calls: [{ index: 0, id: "gated-create", function: { name: "workflow_draft_create", arguments: args.slice(0, midpoint) } }] } }] });
        partialSent.resolve(); await continueArguments.promise;
        if (protocol === "openai_responses") emit({ type: "response.function_call_arguments.delta", output_index: 0, delta: args.slice(midpoint) });
        else emit({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(midpoint) } }] } }] });
        completeArgumentsSent.resolve(); await finishStream.promise;
        if (protocol === "openai_responses") emit({ type: "response.completed", response: { status: "completed", output: [{ type: "function_call", call_id: "gated-create", name: "workflow_draft_create", arguments: args }] } });
        else emit({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }); res.end("data: [DONE]\n\n");
      })().catch(error => { res.destroy(error); });
    });
    const profile = f.app.assistant.saveProfile({ name: protocol, providerKind: protocol, baseUrl: f.baseUrl, model: "synthetic", apiKey: syntheticKey, stream: true });
    sub.after(() => { continueArguments.resolve(); finishStream.resolve(); });
    try {
      const accepted = f.send(profile.id, "compose"); await within(partialSent.promise, "First parameter delta was not sent"); await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(f.repo.all("workflows").length, 0); assert.equal(f.repo.all("assistant_tool_calls").length, 0); assert.equal(f.repo.all("authoring_commands").length, 0);
      continueArguments.resolve(); await within(completeArgumentsSent.promise, "Valid parameter JSON was not sent"); await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(f.repo.all("workflows").length, 0); assert.equal(f.repo.all("assistant_tool_calls").length, 0); assert.equal(f.repo.all("authoring_commands").length, 0);
      finishStream.resolve(); await within(f.app.assistant.settled(), "Completed parameter stream did not settle");
      assert.equal(f.app.assistant.task(accepted.taskId).status, "COMPLETED"); assert.equal(f.repo.get("workflows", workflowId).revision, 1);
      assert.equal(f.repo.all("assistant_tool_calls").length, 1); assert.equal((f.repo.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE operation='draft.create'").get() as { n: number }).n, 1); assert.equal(f.requests.length, 2);
    } finally { continueArguments.resolve(); finishStream.resolve(); }
  });
});

test("KB-01/02/03/04 matrix: current-version TopK excerpts provide exact Chinese binding, type-error repair and unsupported-loop evidence", async t => {
  const f = await fixture(t);
  const samples = [
    { query: "试运行数据库绑定", expected: /试运行数据库绑定先登记实际连接、锁定资源/ },
    { query: "TYPE_MISMATCH", expected: /TYPE_MISMATCH：映射来源与目标 Schema 类型不一致，检查节点、目标 JSON Pointer 及来源字段/ },
    { query: "不支持循环", expected: /只支持串行与互斥条件，不支持循环、并行或任意脚本/ },
  ];
  for (const sample of samples) {
    const result = f.app.knowledge.search({ query: sample.query, limit: 5 });
    assert.ok(result.excerpts.some((excerpt: Json) => sample.expected.test(excerpt.content)), sample.query);
    assert.ok(result.citations.length > 0 && result.citations.length <= 5);
    for (const citation of result.citations) {
      assert.equal(citation.productVersion, VERSION); assert.equal(citation.availability, "implemented"); assert.ok(!citation.sourcePath.includes("upgrade-v2"));
      const source = f.app.knowledge.source(citation); assert.equal(source.stale, false); assert.equal(source.currentContentHash, citation.contentHash);
    }
  }
});

test("ASST-02 matrix: actual TYPE_MISMATCH feedback repairs the next patch while an already waiting checkpoint remains identical", async t => {
  const workflowId = "matrix-type-correction"; let checkpoint: Json;
  const f = await fixture(t, (body, res, index) => {
    if (index === 1) {
      const feedback = JSON.parse(body.messages.find((message: Json) => message.tool_call_id === "wrong-mapping").content);
      assert.ok(feedback.issues.some((issue: Json) => issue.code === "TYPE_MISMATCH" && issue.nodeId === "report"));
      const unchanged = f.engine.status(checkpoint.runId); assert.equal(unchanged.checkpoint.id, checkpoint.checkpoint.id); assert.equal(unchanged.checkpoint.token, checkpoint.checkpoint.token); assert.equal(unchanged.revision, checkpoint.revision);
    }
    answer(res, "fixed mapping", index < 2 ? [tool("workflow_draft_patch", { workflowId, expectedRevision: index === 0 ? 3 : 4, idempotencyKey: "mapping-" + index, operations: [{ op: "set_mapping", nodeId: "report", section: "argumentsMappings", destination: "/orderNo", expression: { ref: { source: "input", pointer: index === 0 ? "/count" : "/orderNo" } } }] }, index === 0 ? "wrong-mapping" : "fixed-mapping")] : []);
  });
  const connection = await f.engine.connectors.discover({ id: "typed-fixture", name: "Matrix synthetic MCP", revision: 1, synthetic: true, transport: "stdio", protocolEra: "modern", disabled: false, tools: [] }), modelTool = connection.tools.find((entry: Json) => entry.name === "synthetic_order_lookup")!;
  f.repo.put("connections", connection.id, connection);
  f.repo.put("bindings", "typed-binding", { id: "typed-binding", revision: 1, connectionId: "typed-fixture", connectionRevision: 1, environment: "test", allowedTools: [modelTool.name], lockedArguments: {}, allowedQueryTemplates: [], simulationOnly: true, validationStatus: "MOCK_VERIFIED", maxRows: 10, timeoutSeconds: 5 });
  f.app.authoring.create({ ...blank(workflowId), mode: "guided" });
  const changed = f.app.authoring.patch({ workflowId, expectedRevision: 1, idempotencyKey: "mapping-wire", operations: [
    { op: "set_input_schema", schema: { type: "object", properties: { count: { type: "number" }, orderNo: { type: "string", pattern: "^DEMO-[A-Za-z0-9-]{1,64}$" } }, required: ["count", "orderNo"], additionalProperties: false } },
    { op: "set_binding", key: "typed", bindingId: "typed-binding" },
    { op: "add_node", nodeId: "analysis", nodeType: "agent_task", title: "Waiting original analysis", config: { kind: "analysis", executorRef: "assistant_local", instructions: "Return count", inputMappings: {}, outputSchema: { type: "object", properties: { count: { type: "number" } }, required: ["count"], additionalProperties: false } } },
    { op: "add_node", nodeId: "report", nodeType: "mcp_tool", title: "Typed synthetic mapping", config: { bindingKey: "typed", toolName: modelTool.name, toolSchemaHash: modelTool.schemaHash, argumentsMappings: { "/orderNo": { value: "DEMO-MATRIX-ORIGINAL" } } } },
    { op: "disconnect", source: "input", target: "end", port: "next" }, { op: "connect", source: "input", target: "analysis", port: "next" }, { op: "connect", source: "analysis", target: "report", port: "next" }, { op: "connect", source: "report", target: "end", port: "next" },
  ] });
  assert.deepEqual(changed.issues, []); f.app.authoring.publish({ workflowId, expectedRevision: 2, version: "1.0.0", expectedBindingRevisions: { "typed-binding": 1 }, expectedCapabilityRevisions: {}, idempotencyKey: "mapping-publish" });
  const started = f.engine.start({ workflowId, version: "1.0.0", mode: "guided", inputs: { count: 42, orderNo: "DEMO-MATRIX-CORRECTED" }, idempotencyKey: "mapping-start" });
  for (let index = 0; index < 200; index++) { checkpoint = f.engine.status(started.runId); if (checkpoint.state === "WAITING_AGENT") break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(checkpoint!.state, "WAITING_AGENT"); const beforeVersions = structuredClone(f.repo.all("versions"));
  const accepted = f.send(f.profile().id, "compose", { workflowId, revision: 3 }); await f.app.assistant.settled(); const task = f.app.assistant.task(accepted.taskId);
  assert.equal(task.status, "COMPLETED", JSON.stringify(task)); assert.equal(task.tools.length, 2); assert.ok(task.tools[0].result.issues.some((issue: Json) => issue.code === "TYPE_MISMATCH")); assert.deepEqual(task.tools[1].result.issues, []);
  assert.deepEqual(f.app.authoring.get(workflowId).draft.nodes.find((node: Json) => node.id === "report").config.argumentsMappings["/orderNo"], { ref: { source: "input", pointer: "/orderNo" } });
  const after = f.engine.status(started.runId); assert.equal(after.state, "WAITING_AGENT"); assert.deepEqual(after.checkpoint, checkpoint!.checkpoint); assert.equal(after.revision, checkpoint!.revision);
  assert.deepEqual(f.repo.all("versions"), beforeVersions); assert.equal((f.repo.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE operation='advance'").get() as { n: number }).n, 0);
});

test("ASST-06 matrix: hard daemon termination after a committed patch preserves its disk receipt, interrupts the task and never replays it on restart", async t => {
  const root = await mkdtemp(join(tmpdir(), "flowhub-matrix-restart-")), home = join(root, "empty-codex-home"); await mkdir(home); await writeFile(join(home, "config.toml"), "");
  const providerWaiting = gate(), requests: Json[] = [], errors: unknown[] = [], logs: string[] = [], processes: ChildProcessWithoutNullStreams[] = [];
  const workflowId = "matrix-hard-restart", patchKey = "matrix-restart-patch-once", callback = tool("workflow_draft_patch", { workflowId, expectedRevision: 1, idempotencyKey: patchKey, operations: [{ op: "set_metadata", changes: { name: "Persisted before hard restart" } }] }, "patch-before-crash");
  const provider = createServer(async (req, res) => {
    try { let text = ""; for await (const part of req) text += part; requests.push(JSON.parse(text)); if (requests.length === 1) answer(res, "", [callback]); else if (requests.length === 2) providerWaiting.resolve(); else { errors.push(new Error("Model call replayed after restart")); answer(res, "unexpected replay"); } }
    catch (error) { errors.push(error); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const child of processes) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await within(new Promise<void>(resolve => child.once("exit", () => resolve())), "Child cleanup did not exit"); } provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const start = async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../../apps/daemon/src/cli.js", import.meta.url)), "serve", "--data-dir", root, "--port", "0"], { env: { ...process.env, CODEX_HOME: home }, stdio: "pipe" }); processes.push(child);
    const ready = gate<string>(); let output = "";
    const record = (part: Buffer) => { const text = part.toString(); logs.push(text); output += text; const port = output.match(/FlowHub ready on 127\.0\.0\.1:(\d+)/)?.[1]; if (port) ready.resolve("http://127.0.0.1:" + port); };
    child.stdout.on("data", record); child.stderr.on("data", record); child.once("error", error => errors.push(error));
    const stopped = new Promise<never>((_resolve, reject) => child.once("exit", (code, signal) => reject(new Error("Isolated daemon exited before readiness: " + code + "/" + signal + " " + output))));
    return { child, origin: await within(Promise.race([ready.promise, stopped]), "Isolated daemon did not become ready") };
  };
  const password = "Synthetic-hard-restart-password-941", first = await start();
  const login = async (origin: string, bootstrap: boolean) => {
    const response = await fetch(origin + "/api/v1/auth/" + (bootstrap ? "bootstrap" : "session"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password, ...(bootstrap ? { setupToken: await readFile(join(root, "admin-setup-token"), "utf8") } : {}) }) });
    assert.equal(response.status, 200); const cookie = response.headers.get("set-cookie")!.split(";")[0]!, csrf = ((await response.json()) as Json).data.csrf;
    return async (path: string, body?: Json) => { const result = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrf, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await result.json() as Json; assert.equal(result.status, 200, JSON.stringify(data)); return data.data; };
  };
  const api = await login(first.origin, true); await api("/api/v2/workflows", blank(workflowId));
  const profile = await api("/api/v2/model-profiles", { name: "Synthetic restart", providerKind: "openai_compatible_chat", baseUrl: "http://127.0.0.1:" + (provider.address() as { port: number }).port + "/v1", model: "synthetic", apiKey: syntheticKey, stream: false });
  const session = await api("/api/v2/assistant/sessions", {}), message = { text: "修改当前流程名称并保存草稿", mode: "compose", context: { workflowId, revision: 1 }, requestedActions: ["edit_draft"], modelProfileId: profile.id, idempotencyKey: "matrix-restart-message-once" };
  const accepted = await api("/api/v2/assistant/sessions/" + session.id + "/messages", message); await within(providerWaiting.promise, "Second model request did not wait after the committed patch");
  const before = await api("/api/v2/assistant/tasks/" + accepted.taskId), draft = await api("/api/v2/workflows/" + workflowId + "/draft");
  assert.equal(before.status, "GENERATING"); assert.equal(before.tools.length, 1); assert.equal(before.tools[0].status, "COMPLETED"); assert.equal(draft.revision, 2); assert.equal(draft.draft.name, "Persisted before hard restart");
  const exited = new Promise<void>(resolve => first.child.once("exit", () => resolve())); first.child.kill("SIGKILL"); await within(exited, "Hard-terminated daemon did not exit");
  // The documented crash-recovery step requires verifying this exact PID before
  // removing its stale lock. This is the test's own disposable daemon only.
  assert.equal(JSON.parse(await readFile(join(root, "daemon.lock"), "utf8")).pid, first.child.pid);
  assert.throws(() => process.kill(first.child.pid!, 0), { code: "ESRCH" }); await unlink(join(root, "daemon.lock"));
  const second = await start(), recoveredApi = await login(second.origin, false), recovered = await recoveredApi("/api/v2/assistant/tasks/" + accepted.taskId);
  assert.equal(recovered.status, "INTERRUPTED"); assert.equal(recovered.errorCode, "TASK_INTERRUPTED"); assert.deepEqual(recovered.tools, before.tools);
  assert.deepEqual(await recoveredApi("/api/v2/workflows/" + workflowId + "/draft"), draft);
  const replay = await recoveredApi("/api/v2/assistant/sessions/" + session.id + "/messages", message); assert.equal(replay.taskId, accepted.taskId);
  const afterReplay = await recoveredApi("/api/v2/assistant/tasks/" + accepted.taskId); assert.equal(afterReplay.status, "INTERRUPTED"); assert.deepEqual(afterReplay.tools, before.tools); assert.equal(requests.length, 2);
  assert.equal((await recoveredApi("/api/v2/workflows/" + workflowId + "/draft")).revision, 2);
  assert.ok(!logs.join("").includes(syntheticKey)); assert.deepEqual(errors, []);
});
