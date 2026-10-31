import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { Application } from "../../packages/application/src/index.js";
import { ScriptedModelProvider } from "../../packages/llm-providers/src/index.js";
import { projectState } from "../../packages/assistant-core/src/project-state.js";
import { requestedActions } from "../../packages/contracts/src/assistant-intent.js";
import { HubError, type Json } from "../../packages/contracts/src/domain.js";

async function fixture(t: any, script: any[] = []) {
  const db = new Database(":memory:"),
    repo = new Repository(db),
    vault = new Vault(repo);
  vault.initialize("Synthetic-conversation-password");
  const engine = new Engine(repo, vault, new Connectors(repo, vault)),
    provider = new ScriptedModelProvider(script);
  const app = new Application(engine, { providerFactory: () => provider });
  t.after(async () => {
    await app.close();
    await engine.close();
    db.close();
  });
  const profile = app.assistant.saveProfile({
    name: "对话测试模型",
    providerKind: "openai_compatible_chat",
    baseUrl: "https://example.invalid/v1",
    model: "synthetic",
  });
  const session = app.assistant.session();
  const send = (
    text: string,
    context: Json = {},
    modelProfileId = profile.id,
    continueTaskId?: string,
  ) =>
    app.assistant.submit(session.id, {
      text,
      context,
      modelProfileId,
      mode: requestedActions(text).length ? "compose" : "help",
      requestedActions: requestedActions(text),
      idempotencyKey: crypto.randomUUID(),
      ...(continueTaskId ? { continueTaskId } : {}),
    });
  return { app, repo, provider, profile, session, send };
}
const done = { text: "已根据当前数据回答。", calls: [], usage: null };

test("runtime inventory separates unscanned, empty, partial and failed; projection excludes credentials and transport data", async (t) => {
  const f = await fixture(t);
  f.repo.put("connections", "registered", {
    id: "registered",
    name: "已登记日志",
    revision: 2,
    verifiedRevision: 1,
    tools: [{ name: "search" }],
    endpoint: "https://private.invalid?key=SECRET",
    args: ["SECRET_ARG"],
    env: { API_KEY: "SECRET_VALUE" },
    secretRef: "SECRET_REF",
  });
  let state = projectState(f.app, "execution");
  assert.equal(state.discovery.status, "not_scanned");
  assert.equal(state.discovery.toolCountKnown, false);
  assert.equal(state.registeredConnections.count, 1);
  assert.deepEqual(state.registeredConnections.items[0].cachedTools,["search"]);
  assert.equal(state.registeredConnections.items[0].catalogVerified, false);
  assert.doesNotMatch(JSON.stringify(state), /SECRET|private\.invalid/);
  f.repo.put("host_contexts", "host", { id: "host", revision: 1 });
  f.repo.put("discovery_jobs", "scan", {
    id: "scan",
    contextId: "host",
    contextRevision: 1,
    generation: 1,
    depth: "catalog",
    status: "SUCCEEDED",
    coverage: "complete",
    issues: [],
  });
  state = projectState(f.app, "execution");
  assert.equal(state.discovery.status, "ready");
  assert.equal(state.discovery.toolCountKnown, true);
  assert.equal(state.discovery.currentCounts.mcpTools, 0);
  for (const status of ["PARTIAL", "FAILED", "CANCELLED", "READING_SOURCES"]) {
    f.repo.put("discovery_jobs", "scan", {
      ...f.repo.get("discovery_jobs", "scan"),
      status,
      issues: [{ code: "SOURCE_UNREADABLE", message: "SECRET_DIAGNOSTIC" }],
    });
    state = projectState(f.app, "execution");
    assert.equal(state.discovery.toolCountKnown, false);
    assert.equal(
      state.discovery.status,
      status === "PARTIAL"
        ? "partial"
        : status === "READING_SOURCES"
          ? "scanning"
          : "failed",
    );
    assert.doesNotMatch(JSON.stringify(state), /SECRET_DIAGNOSTIC/);
  }
  assert.deepEqual(projectState(f.app, "unprivileged"), {
    status: "unavailable",
    reason: "AUTH_REQUIRED",
  });
});
test("metadata is never presented as a fully known catalog; stale and host-only capabilities remain distinct", async (t) => {
  const f = await fixture(t);
  f.repo.put("host_contexts", "host", { id: "host", revision: 1 });
  f.repo.put("discovery_jobs", "scan", {
    id: "scan",
    contextId: "host",
    contextRevision: 1,
    generation: 1,
    depth: "metadata",
    status: "SUCCEEDED",
    coverage: "complete",
    issues: [],
  });
  f.repo.put("capability_sources", "source", {
    id: "source",
    contextId: "host",
    contextRevision: 1,
    kind: "mcp_server",
    name: "元数据来源",
    discovery: "metadata_only",
  });
  f.repo.put("capabilities", "host-tool", {
    id: "host-tool",
    contextId: "host",
    contextRevision: 1,
    name: "host_tool",
    kind: "mcp_tool",
    executor: "codex_host",
    availability: "host_only",
  });
  let state = projectState(f.app, "execution");
  assert.equal(state.discovery.status, "metadata_only");
  assert.equal(state.discovery.toolCountKnown, false);
  assert.equal(state.discovery.currentCounts.hostOnly, 1);
  f.repo.put("host_contexts", "host", { id: "host", revision: 2 });
  state = projectState(f.app, "execution");
  assert.equal(state.discovery.status, "not_scanned");
  assert.equal(state.discovery.currentCounts.hostOnly, 0);
  assert.equal(state.discovery.cachedCapabilities.items[0].stale, true);
});
test("real state is included before help and three turns retain same-scope history without executing tools", async (t) => {
  const f = await fixture(t, [done, done, done]);
  for (const text of [
    "当前 MCP 有哪些？",
    "这会影响现有配置吗？",
    "那下一步应该怎么做？",
  ]) {
    f.send(text);
    await f.app.assistant.settled();
  }
  const context = JSON.parse(
    f.provider.requests[2]!.messages[1]!.content.slice(
      "Selected context (data): ".length,
    ),
  );
  assert.equal(context.projectState.discovery.status, "not_scanned");
  assert.equal(
    f.provider.requests[2]!.messages.filter((m) => m.role === "user").length,
    4,
  );
  assert.match(
    f.provider.requests[0]!.messages[0]!.content,
    /not the user's connected MCP inventory/,
  );
  assert.equal(f.repo.all("assistant_tool_calls").length, 0);
  assert.equal(f.repo.all("discovery_jobs").length, 0);
});
test("conversation page groups per-turn receipts in one batch, paginates, and enforces owner", async (t) => {
  const f = await fixture(t, [done, done, done]);
  for (const text of ["第一问", "第二问", "第三问"]) {
    f.send(text);
    await f.app.assistant.settled();
  }
  const task = f.repo.all("assistant_tasks")[1];
  f.repo.put("assistant_tool_calls", "legacy-receipt", {
    id: "legacy-receipt",
    taskId: task.id,
    result: { revision: 7, checkpoint: { token: "OPERATIONAL_SECRET" } },
    status: "COMPLETED",
  });
  const page = f.app.assistant.conversationPage(f.session.id, { limit: 4 });
  assert.equal(page.items.length, 4);
  assert.equal(page.tasks.length, 2);
  assert.ok(page.nextCursor);
  assert.equal(
    page.tasks.find((t: Json) => t.id === task.id).tools[0].result.revision,
    7,
  );
  assert.doesNotMatch(
    JSON.stringify(page),
    /OPERATIONAL_SECRET|providerContinuation/,
  );
  assert.equal(
    f.app.assistant.conversationPage(f.session.id, { before: page.nextCursor })
      .items.length,
    2,
  );
  assert.throws(
    () => f.app.assistant.conversationPage(f.session.id, {}, "another-owner"),
    { code: "NOT_FOUND" },
  );
  assert.equal(f.app.assistant.sessions()[0].title, "第一问");
});
test("partial reply survives cancellation and a conversation reload; continuation only reads saved results", async (t) => {
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const f = await fixture(t, [
    (req: any) =>
      new Promise((_resolve, reject) => {
        req.onDelta("已经输出的正文");
        started();
        req.signal.addEventListener(
          "abort",
          () => reject(new HubError("TASK_CANCELLED", "stopped")),
          { once: true },
        );
      }),
  ]);
  const accepted = f.send("解释项目");
  await ready;
  assert.equal(
    f.app.assistant.task(accepted.taskId).partialText,
    "已经输出的正文",
  );
  f.app.assistant.cancel(accepted.taskId);
  await f.app.assistant.settled();
  const page = f.app.assistant.conversationPage(f.session.id);
  assert.equal(page.tasks[0].status, "CANCELLED");
  assert.equal(page.tasks[0].partialText, "已经输出的正文");
  assert.equal(page.items.length, 1);
  f.provider.script.push(done);
  const continued = f.send(
    "请根据上一轮已保存的工具回执继续回复，只解释结果，不要重复执行操作。",
    {},
    f.profile.id,
    accepted.taskId,
  );
  await f.app.assistant.settled();
  assert.equal(f.app.assistant.task(continued.taskId).status, "COMPLETED");
  const request = f.provider.requests.at(-1)!,
    context = JSON.parse(
      request.messages[1]!.content.slice("Selected context (data): ".length),
    );
  assert.equal(context.previousTurnResults[0].partialText, "已经输出的正文");
  assert.equal(context.previousTurnResults[0].taskId, accepted.taskId);
  assert.deepEqual(context.previousTurnResults[0].tools, []);
  assert.ok(
    request.tools.every(
      (tool) =>
        ![
          "workflow_draft_patch",
          "workflow_start",
          "workflow_draft_create",
        ].includes(tool.name),
    ),
  );
});
test("streaming promptly releases ordinary short text while protecting checkpoint credentials split across chunks", async (t) => {
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r)),
    credential = "SYNTHETIC_OPERATIONAL_CHECKPOINT_CREDENTIAL";
  const f = await fixture(t, [
    (req: any) =>
      new Promise((_resolve, reject) => {
        req.onDelta("简短的即时回复。");
        started();
        req.onDelta(credential.slice(0, 12));
        req.onDelta(credential.slice(12));
        req.onDelta("继续正文。");
        req.signal.addEventListener(
          "abort",
          () => reject(new HubError("TASK_CANCELLED", "stopped")),
          { once: true },
        );
      }),
  ]);
  f.repo.put("runs", "protected-run", {
    id: "protected-run",
    owner: "execution",
    state: "WAITING_AGENT",
    checkpoint: {
      id: "cp",
      delivery: f.app.engine.vault.encrypt(credential, "protected-run:cp"),
    },
  });
  const accepted = f.send("解释项目");
  await ready;
  const partial = f.app.assistant.task(accepted.taskId).partialText;
  assert.match(partial, /简短的即时回复。/);
  assert.match(partial, /继续正文。/);
  assert.doesNotMatch(partial, /SYNTHETIC_OPERATIONAL|CHECKPOINT_CREDENTIAL/);
  f.app.assistant.cancel(accepted.taskId);
  await f.app.assistant.settled();
});
test("a follow-up can read the workflow created in this same scoped conversation, but cannot access an unrelated draft", async (t) => {
  const create = {
    workflowId: "conversation-created",
    name: "本次创建",
    environment: "test",
    mode: "auto",
    template: "blank",
    idempotencyKey: "create",
  };
  const call = (name: string, args: Json) => ({
    text: "",
    calls: [{ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }],
    usage: null,
  });
  const f = await fixture(t, [
    call("workflow_draft_create", create),
    done,
    call("workflow_draft_get", { workflowId: create.workflowId }),
    done,
    call("workflow_draft_get", { workflowId: "unrelated" }),
  ]);
  f.app.authoring.create({
    ...create,
    workflowId: "unrelated",
    idempotencyKey: "unrelated",
  });
  f.send("创建并保存一个流程");
  await f.app.assistant.settled();
  const followup = f.send("解释刚才创建的流程");
  await f.app.assistant.settled();
  assert.equal(f.app.assistant.task(followup.taskId).status, "COMPLETED");
  assert.equal(
    f.app.assistant.task(followup.taskId).tools[0].result.workflow.workflowId,
    create.workflowId,
  );
  const forbidden = f.send("解释另一个未选流程");
  await f.app.assistant.settled();
  assert.equal(
    f.app.assistant.task(forbidden.taskId).errorCode,
    "INTENT_NOT_ALLOWED",
  );
});
test("design and advice questions do not grant edit permissions; implementing an agreed plan does", () => {
  assert.deepEqual(requestedActions("先给个创建工作流的方案"), []);
  assert.deepEqual(requestedActions("给我修改流程的建议"), []);
  assert.deepEqual(requestedActions("根据方案修改流程并保存，不要发布或执行"), [
    "edit_draft",
  ]);
});
