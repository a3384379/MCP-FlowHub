import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, get as httpGet, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDaemon } from "../../apps/daemon/src/index.js";
import type { Json } from "../../packages/contracts/src/domain.js";

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function within<T>(operation: Promise<T>, description: string, milliseconds = 5000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(description)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function answer(res: ServerResponse, calls: Json[] = []) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ finish_reason: calls.length ? "tool_calls" : "stop", message: { role: "assistant", content: calls.length ? "" : "草稿已保存", tool_calls: calls } }] }));
}

test("ASST-05: an authenticated real SSE disconnect after successful patch replays later task events without another patch or model call", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "flowhub-assistant-sse-replay-")), requests: Json[] = [], errors: unknown[] = [];
  const secondRequest = gate<ServerResponse>(), disconnected = gate<Json>();
  const workflowId = "sse-replay-draft", patchKey = "sse-replay-patch-once";
  const provider = createServer(async (req, res) => {
    try {
      let text = ""; for await (const part of req) text += part; requests.push(JSON.parse(text));
      if (requests.length === 1) answer(res, [{ id: "patch-once", type: "function", function: { name: "workflow_draft_patch", arguments: JSON.stringify({ workflowId, expectedRevision: 1, idempotencyKey: patchKey, operations: [{ op: "set_metadata", changes: { name: "SSE实际持久化修改" } }] }) } }]);
      else if (requests.length === 2) secondRequest.resolve(res);
      else { errors.push(new Error("Unexpected repeated model request")); answer(res); }
    } catch (error) { errors.push(error); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise<void>(r => provider.listen(0, "127.0.0.1", r));
  const daemon = await startDaemon({ dataDir, port: 0 }), responses: IncomingMessage[] = [];
  t.after(async () => {
    for (const response of responses) response.destroy();
    await daemon.close(); provider.closeAllConnections(); await new Promise<void>(r => provider.close(() => r())); await rm(dataDir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${daemon.port}`;
  const bootstrap = await fetch(origin + "/api/v1/auth/bootstrap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ setupToken: await readFile(join(dataDir, "admin-setup-token"), "utf8"), password: "Synthetic-assistant-sse-replay-password-173" }) });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!, csrf = ((await bootstrap.json()) as Json).data.csrf;
  const api = async (path: string, body?: Json) => {
    const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrf, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as Json; assert.equal(response.status, 200, JSON.stringify(value)); return value.data;
  };
  const open = (path: string, headers: Record<string, string>, onEvent: (event: Json, response: IncomingMessage) => void) => new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpGet(origin + path, { headers: { Cookie: cookie, ...headers } }, response => {
      responses.push(response); if (response.statusCode !== 200) { response.resume(); reject(new Error("SSE status " + response.statusCode)); return; }
      response.setEncoding("utf8"); let buffered = "";
      response.on("data", (part: string) => {
        buffered += part; let boundary: number;
        while ((boundary = buffered.indexOf("\n\n")) !== -1) {
          const frame = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 2);
          const id = frame.split("\n").find(line => line.startsWith("id: "))?.slice(4), data = frame.split("\n").find(line => line.startsWith("data: "))?.slice(6);
          if (id && data) { const event = JSON.parse(data); assert.equal(Number(id), event.eventId); onEvent(event, response); if (response.destroyed) return; }
        }
      });
      response.on("error", error => { if (!response.destroyed) reject(error); }); resolve(response);
    });
    request.on("error", reject);
  });

  await api("/api/v2/workflows", { workflowId, name: "SSE原草稿", environment: "test", mode: "auto", template: "blank", idempotencyKey: "sse-replay-create" });
  const profile = await api("/api/v2/model-profiles", { name: "Loopback SSE provider", providerKind: "openai_compatible_chat", baseUrl: "http://127.0.0.1:" + (provider.address() as { port: number }).port + "/v1", model: "synthetic", apiKey: "synthetic-sse-provider-key-only", stream: false });
  const session = await api("/api/v2/assistant/sessions", {}), repo = daemon.engine.repo, before = repo.changes(0, 10000).at(-1)?.eventId ?? 0;
  const initialEvents: Json[] = [];
  await within(open("/api/v2/events?afterEventId=" + before + "&workflowId=" + workflowId, {}, (event, response) => {
    initialEvents.push(event);
    if (event.type === "draft.changed") {
      // Drop the actual TCP response immediately after observing the committed
      // patch event, before processing any following event in the same chunk.
      response.once("close", () => disconnected.resolve(event)); response.destroy();
    }
  }), "Initial authenticated SSE did not open");
  const body = { text: "修改当前流程名称并保存草稿", mode: "compose", context: { workflowId, revision: 1 }, requestedActions: ["edit_draft"], modelProfileId: profile.id, idempotencyKey: "sse-replay-message-once" };
  const accepted = await api("/api/v2/assistant/sessions/" + session.id + "/messages", body);
  const cut = await within(disconnected.promise, "Successful patch event was not received before disconnect"), held = await within(secondRequest.promise, "Assistant did not continue after the committed patch");
  assert.equal(cut.workflowId, workflowId); assert.equal(cut.revision, 2); assert.ok(cut.eventId > before);
  assert.equal(repo.get("workflows", workflowId).revision, 2); assert.equal(repo.get("workflows", workflowId).draft.name, "SSE实际持久化修改");
  assert.equal(daemon.application.assistant.task(accepted.taskId).status, "GENERATING"); assert.ok(initialEvents.every(event => event.eventId <= cut.eventId));
  // The model finishes while no SSE client is connected. An unrelated event
  // exercises the task filter without revealing its data on replay.
  const unrelated = repo.changed("synthetic.unrelated", { taskId: "unrelated-task", data: { content: "UNRELATED_REPLAY_PRIVATE_CONTENT" } });
  answer(held); await within(daemon.application.assistant.settled(), "Offline assistant task did not complete");
  const completed = await api("/api/v2/assistant/tasks/" + accepted.taskId); assert.equal(completed.status, "COMPLETED"); assert.equal(requests.length, 2); assert.equal(completed.tools.length, 1); assert.equal(completed.tools[0].status, "COMPLETED");
  const lastBeforeReplay = repo.changes(0, 10000).at(-1)!.eventId, replayed: Json[] = [], replayComplete = gate<void>();
  await within(open("/api/v2/events?afterEventId=0&taskId=" + accepted.taskId, { "Last-Event-ID": String(cut.eventId) }, (event, response) => {
    replayed.push(event); if (event.type === "task.completed") { response.destroy(); replayComplete.resolve(); }
  }), "Reconnected authenticated SSE did not open");
  await within(replayComplete.promise, "Task completion was not replayed");
  assert.ok(replayed.length > 0); assert.ok(replayed.every(event => event.eventId > cut.eventId)); assert.deepEqual(replayed.map(event => event.eventId), [...replayed.map(event => event.eventId)].sort((a, b) => a - b)); assert.equal(new Set(replayed.map(event => event.eventId)).size, replayed.length);
  assert.ok(replayed.some(event => event.type === "task.completed" && event.taskId === accepted.taskId)); assert.ok(replayed.every(event => event.type === "cursor" || event.taskId === accepted.taskId));
  assert.deepEqual(replayed.find(event => event.eventId === unrelated.eventId), { eventId: unrelated.eventId, type: "cursor", timestamp: unrelated.timestamp }); assert.ok(!JSON.stringify(replayed).includes("UNRELATED_REPLAY_PRIVATE_CONTENT"));
  assert.equal(replayed.at(-1)!.eventId, lastBeforeReplay);
  const revision = repo.get("workflows", workflowId).revision, toolReceipt = structuredClone(completed.tools[0]), patchCommands = repo.all("authoring_commands").filter(command => command.workflowId === workflowId && command.operation === "patch");
  assert.equal(revision, 2); assert.equal(patchCommands.length, 1); assert.equal(patchCommands[0].idempotencyKey, patchKey);
  const repeated = await api("/api/v2/assistant/sessions/" + session.id + "/messages", body); await daemon.application.assistant.settled();
  assert.equal(repeated.taskId, accepted.taskId); assert.equal(repo.get("workflows", workflowId).revision, revision); assert.equal(requests.length, 2); assert.equal(repo.changes(0, 10000).at(-1)!.eventId, lastBeforeReplay);
  assert.deepEqual(daemon.application.assistant.task(accepted.taskId).tools, [toolReceipt]); assert.equal(repo.all("assistant_tool_calls").filter(call => call.taskId === accepted.taskId).length, 1); assert.equal(repo.all("authoring_commands").filter(command => command.workflowId === workflowId && command.operation === "patch").length, 1); assert.deepEqual(errors, []);
});
