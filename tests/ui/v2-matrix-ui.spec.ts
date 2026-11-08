import { test, expect, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

test.afterEach(async ({ page }) => {
  const response = await page.request.get("/api/v1/auth/session");
  if (response.ok()) {
    const csrf = (await response.json()).data.csrf;
    const closed = await page.request.delete("/api/v1/auth/session", { headers: { "X-CSRF-Token": csrf } });
    expect(closed.ok(), await closed.text()).toBeTruthy();
  }
});

type Data = Record<string, any>;
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function authenticated(page: Page) {
  const password = "Synthetic-browser-password-041", initialized = (await (await page.request.get("/api/v1/auth/state")).json()).data.initialized;
  const auth = await page.request.post("/api/v1/auth/" + (initialized ? "session" : "bootstrap"), { data: { password, ...(initialized ? {} : { setupToken: await readFile(join(process.env.FLOWHUB_UI_DATA_DIR!, "admin-setup-token"), "utf8") }) } });
  expect(auth.ok(), await auth.text()).toBeTruthy(); const csrf = (await auth.json()).data.csrf;
  return async (path: string, method = "GET", data?: Data, revision?: number) => {
    const response = await page.request.fetch(path, { method, headers: { "X-CSRF-Token": csrf, ...(revision === undefined ? {} : { "If-Match": String(revision) }) }, ...(data === undefined ? {} : { data }) });
    expect(response.ok(), await response.text()).toBeTruthy(); return (await response.json()).data;
  };
}

test("UI-03/UI-05 matrix: an AI batch only places new nodes, and browser undo restores its graph while preserving manual layout and immutable publication", async ({ page }) => {
  const api = await authenticated(page), workflowId = "matrix-layout-" + randomUUID().slice(0, 8), requests: Data[] = [];
  await api("/api/v2/workflows", "POST", { workflowId, name: "Matrix layout and undo", environment: "test", mode: "auto", template: "blank", idempotencyKey: randomUUID() });
  const initial = await api("/api/v2/workflows/" + workflowId + "/draft"), positions = [{ nodeId: "input", x: 65, y: 110 }, { nodeId: "end", x: 780, y: 360 }];
  await api("/api/v2/workflows/" + workflowId + "/operations", "POST", { expectedRevision: initial.revision, operations: [{ op: "move_nodes", expectedLayoutRevision: initial.layoutRevision, positions }], idempotencyKey: randomUUID() }, initial.revision);
  const arranged = await api("/api/v2/workflows/" + workflowId + "/draft");
  await api("/api/v2/workflows/" + workflowId + "/publish", "POST", { expectedRevision: arranged.revision, version: "1.0.0", expectedBindingRevisions: {}, expectedCapabilityRevisions: {}, idempotencyKey: randomUUID() });
  const baseline = await api("/api/v2/workflows/" + workflowId + "/draft");
  const published = await api("/api/v1/workflows/" + workflowId + "/versions"), patchKey = randomUUID();
  const operations = [
    { op: "add_node", nodeId: "branch", nodeType: "condition", title: "Matrix new branch", config: { expression: { op: "eq", left: { value: 1 }, right: { value: 1 } } } },
    { op: "disconnect", source: "input", target: "end", port: "next" }, { op: "connect", source: "input", target: "branch", port: "next" },
    { op: "connect", source: "branch", target: "end", port: "true" }, { op: "connect", source: "branch", target: "end", port: "false" },
  ];
  const model = createServer(async (req, res) => {
    let text = ""; for await (const part of req) text += part; const body = JSON.parse(text); requests.push(body);
    const completed = body.messages.some((message: Data) => message.role === "tool"), calls = completed ? [] : [{ id: "matrix-layout-patch", type: "function", function: { name: "workflow_draft_patch", arguments: JSON.stringify({ workflowId, expectedRevision: baseline.revision, idempotencyKey: patchKey, operations }) } }];
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ finish_reason: calls.length ? "tool_calls" : "stop", message: { role: "assistant", content: calls.length ? "" : "已保存新的分支。", tool_calls: calls } }] }));
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  try {
    const profile = await api("/api/v2/model-profiles", "POST", { name: "Matrix layout model", providerKind: "openai_compatible_chat", baseUrl: "http://127.0.0.1:" + (model.address() as { port: number }).port + "/v1", model: "synthetic-layout", apiKey: "synthetic-matrix-layout-key", stream: false });
    await page.goto("/workflows/" + workflowId + "/editor"); await expect(page.locator(".react-flow__node")).toHaveCount(2);
    const transforms = { input: await page.locator('.react-flow__node[data-id="input"]').evaluate((node: HTMLElement) => node.style.transform), end: await page.locator('.react-flow__node[data-id="end"]').evaluate((node: HTMLElement) => node.style.transform) };
    await page.locator(".editor-toolbar").getByRole("button", { name: "AI 助手", exact: true }).click(); await expect(page.locator(".assistant-loading")).toHaveCount(0);
    const sessionBefore = await page.getByRole("region", { name: "FlowHub 助手聊天窗口" }).getAttribute("data-session-id");
    await page.getByRole("button", { name: "新建会话", exact: true }).click(); await expect.poll(() => page.getByRole("region", { name: "FlowHub 助手聊天窗口" }).getAttribute("data-session-id")).not.toBe(sessionBefore);
    await page.getByRole("combobox", { name: "使用模型", exact: true }).selectOption(profile.id); await page.getByLabel("发送给助手").fill("为当前流程增加条件分支并保存草稿，不发布不执行"); await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator('.assistant-turn[data-status="COMPLETED"]').last()).toBeVisible(); await expect(page.locator(".react-flow__node")).toHaveCount(3);
    const changed = await api("/api/v2/workflows/" + workflowId + "/draft");
    expect(changed.layout.input).toEqual(baseline.layout.input); expect(changed.layout.end).toEqual(baseline.layout.end); expect(changed.layout.branch).toEqual({ x: expect.any(Number), y: expect.any(Number) });
    expect(changed.draft.nodes.find((node: Data) => node.id === "input")).toEqual(baseline.draft.nodes.find((node: Data) => node.id === "input"));
    expect(changed.draft.nodes.find((node: Data) => node.id === "end")).toEqual(baseline.draft.nodes.find((node: Data) => node.id === "end"));
    expect(await page.locator('.react-flow__node[data-id="input"]').evaluate((node: HTMLElement) => node.style.transform)).toBe(transforms.input); expect(await page.locator('.react-flow__node[data-id="end"]').evaluate((node: HTMLElement) => node.style.transform)).toBe(transforms.end);
    expect(await api("/api/v1/workflows/" + workflowId + "/versions")).toEqual(published);
    await page.reload(); await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await page.locator(".editor-toolbar").getByRole("button", { name: "AI 助手", exact: true }).click();
    const undone = page.waitForResponse(response => response.url().endsWith("/api/v2/workflows/" + workflowId + "/undo") && response.request().method() === "POST");
    await page.getByRole("button", { name: "撤销改图", exact: true }).click(); const undo = await undone; expect(undo.ok(), await undo.text()).toBeTruthy(); const inverse = (await undo.json()).data.inverse; expect(inverse).toBeTruthy();
    await expect(page.locator(".react-flow__node")).toHaveCount(2); const restored = await api("/api/v2/workflows/" + workflowId + "/draft");
    expect(restored.draft).toEqual(baseline.draft); expect(restored.layout).toEqual(baseline.layout); expect(restored.revision).toBe(changed.revision + 1); expect(await api("/api/v1/workflows/" + workflowId + "/versions")).toEqual(published);
    await page.reload(); await expect(page.locator(".react-flow__node")).toHaveCount(2); expect(requests).toHaveLength(2);
  } finally { await page.unrouteAll({ behavior: "wait" }); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); }
});

test("UI-06 matrix: saving a synthetic model Key and reopening its form only exposes configuration status", async ({ page }) => {
  const api = await authenticated(page), name = "Matrix key " + randomUUID().slice(0, 8), key = "SYNTHETIC-MATRIX-REOPEN-KEY-" + randomUUID();
  await page.goto("/models"); await page.getByLabel("模型服务", { exact: true }).selectOption("custom"); await page.getByLabel("模型配置名称").fill(name); await page.getByLabel("API 协议").selectOption("openai_compatible_chat"); await page.getByLabel("Base URL").fill("http://127.0.0.1:1/v1"); await page.getByLabel("Model", { exact: true }).fill("synthetic-key-reopen"); await page.getByLabel("API Key", { exact: true }).fill(key); await page.getByRole("button", { name: "保存模型", exact: true }).click();
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name, exact: true }) }); await expect(card).toContainText("Key 已配置");
  await page.reload(); await expect(card).toContainText("Key 已配置"); await card.getByRole("button", { name: "编辑模型", exact: true }).click();
  await expect(page.getByLabel("API Key", { exact: true })).toHaveValue(""); await expect(page.getByLabel("API Key", { exact: true })).toHaveAttribute("placeholder", "已配置；留空保留原 Key");
  const browser = await page.evaluate(() => JSON.stringify({ local: localStorage, session: sessionStorage, html: document.documentElement.outerHTML, inputs: [...document.querySelectorAll("input")].map(input => input.value) })); expect(browser).not.toContain(key);
  const profile = (await api("/api/v2/model-profiles")).find((entry: Data) => entry.name === name); expect(profile.keyConfigured).toBe(true); expect(JSON.stringify(profile)).not.toContain(key);
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("synthetic-key-reopen"); await expect(page.getByLabel("Base URL")).toHaveValue("http://127.0.0.1:1/v1");
});

test("PLUG-01/UI-01 matrix: ten market entries remain two installed plugins and eight visible informational candidates without importing their components", async ({ page }) => {
  const api = await authenticated(page), root = await realpath(await mkdtemp(join(process.env.FLOWHUB_UI_DATA_DIR!, "matrix-market-"))), home = join(root, "home"), cwd = join(root, "project"), market = "matrix-market";
  await mkdir(home); await mkdir(cwd); await mkdir(join(root, ".agents/plugins"), { recursive: true });
  const entries = Array.from({ length: 10 }, (_, index) => ({ name: "matrix-candidate-" + index, source: { source: "local", path: "./must-not-expand" }, category: "Productivity", policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, interface: { displayName: "Matrix candidate " + index, shortDescription: "Synthetic available plugin " + index } }));
  const config = '[plugins."matrix-candidate-0@matrix-market"]\nenabled=true\n[plugins."matrix-candidate-1@matrix-market"]\nenabled=true\n', catalog = JSON.stringify({ name: market, plugins: entries });
  await writeFile(join(home, "config.toml"), config); await writeFile(join(root, ".agents/plugins/marketplace.json"), catalog);
  for (const index of [0, 1]) { const plugin = join(home, "plugins/cache", market, "matrix-candidate-" + index, "1.0"); await mkdir(join(plugin, ".codex-plugin"), { recursive: true }); await writeFile(join(plugin, ".codex-plugin/plugin.json"), JSON.stringify({ name: "matrix-candidate-" + index, version: "1.0.0" })); }
  const uninstalled = join(root, ".agents/plugins/must-not-expand"); await mkdir(join(uninstalled, "skills/hidden"), { recursive: true }); await writeFile(join(uninstalled, "skills/hidden/SKILL.md"), "---\nname: must-not-index-market-skill\ndescription: This component belongs to an uninstalled plugin.\n---\nNever execute or index me during metadata discovery.\n");
  try {
    const context = await api("/api/v2/host-contexts", "POST", { codexHome: home, cwd, discoveryMode: "config_only" }); await page.addInitScript(id => localStorage.setItem("flowhub.discovery.context", id), context.id); await page.goto("/discovery");
    await expect(page.locator(".v2-discovery [role=status]")).toContainText("部分完成");
    const registered = (await api("/api/v2/host-contexts")).find((entry: Data) => entry.id === context.id), scanResult = await api("/api/v2/host-scans/" + registered.lastScanId);
    expect(scanResult.status).toBe("PARTIAL"); expect(scanResult.issues.map((issue: Data) => issue.code)).toEqual(["STATIC_RESOLUTION_PARTIAL"]);
    const overview = await api("/api/v2/discovery/catalog?contextId=" + context.id); expect(overview.counts.plugin).toBe(2); expect(overview.availablePluginCount).toBe(8);
    await expect(page.locator(".d-stat").filter({ hasText: "已安装插件" }).locator("strong")).toHaveText("2"); await expect(page.getByText("另有 8 个市场可用插件尚未安装，可在“插件与关系”查看。", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: /插件与关系/ }).click(); await expect(page.locator(".d-plugin-card")).toHaveCount(10);
    const plugins = await api("/api/v2/discovery/catalog?contextId=" + context.id + "&kind=plugin&limit=100"); expect(plugins.items.filter((entry: Data) => entry.installation === "installed")).toHaveLength(2); expect(plugins.items.filter((entry: Data) => entry.installation === "available_only")).toHaveLength(8);
    const candidate = plugins.items.find((entry: Data) => entry.name === "matrix-candidate-2"); expect(candidate).toMatchObject({ installation: "available_only", availability: "available_only", executor: "informational", enabled: null });
    const row = page.locator(".d-plugin-card").filter({ has: page.getByRole("heading", { name: candidate.name, exact: true }) }); await expect(row).toContainText("可用，尚未安装"); await expect(row).toContainText("仅显示市场介绍，尚未安装或读取插件组件。"); await row.getByRole("button", { name: /插件详情/ }).click();
    const drawer = page.getByRole("dialog"); await expect(drawer).toContainText("仅有市场介绍，尚未安装或读取插件组件。"); await expect(drawer.getByRole("button", { name: /导入|连接|添加到/ })).toHaveCount(0);
    const skills = await api("/api/v2/capabilities?contextId=" + context.id + "&kind=skill&limit=100"); expect(skills.items.some((entry: Data) => entry.name === "must-not-index-market-skill")).toBe(false);
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe(config); expect(await readFile(join(root, ".agents/plugins/marketplace.json"), "utf8")).toBe(catalog);
    await page.reload(); await expect(page.locator(".d-stat").filter({ hasText: "已安装插件" }).locator("strong")).toHaveText("2");
  } finally { await page.unrouteAll({ behavior: "wait" }); await rm(root, { recursive: true, force: true }); }
});

test("RUN-07 matrix: a real waiting host-only run explains the Codex requirement while a configured model Key dispatches no call", async ({ page }) => {
  const api = await authenticated(page), root = await realpath(await mkdtemp(join(process.env.FLOWHUB_UI_DATA_DIR!, "matrix-host-run-"))), home = join(root, "home"), cwd = join(root, "project"), skillName = "matrix-host-skill-" + randomUUID().slice(0, 8), sentinel = join(root, "host-script-executed");
  await mkdir(join(home, "skills", skillName), { recursive: true }); await mkdir(cwd); await writeFile(join(home, "config.toml"), "");
  await writeFile(join(home, "skills", skillName, "SKILL.md"), "---\nname: " + skillName + "\ndescription: Synthetic host-only Skill; requires Codex to run its external script.\n---\nUse script.mjs only when actually executing this Skill in Codex. Discovery and viewing a workflow must never execute it.\n");
  await writeFile(join(home, "skills", skillName, "script.mjs"), "import fs from 'node:fs';fs.writeFileSync(" + JSON.stringify(sentinel) + ",'executed');");
  const modelRequests: Data[] = [], model = createServer(async (req, res) => { let text = ""; for await (const part of req) text += part; modelRequests.push(JSON.parse(text)); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"summary":"must not be called"}' } }] })); });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  try {
    const profile = await api("/api/v2/model-profiles", "POST", { name: "Matrix host boundary", providerKind: "openai_compatible_chat", baseUrl: "http://127.0.0.1:" + (model.address() as { port: number }).port + "/v1", model: "synthetic-host-boundary", apiKey: "synthetic-host-boundary-key", stream: false }); expect(profile.keyConfigured).toBe(true);
    const context = await api("/api/v2/host-contexts", "POST", { codexHome: home, cwd, discoveryMode: "config_only" }), scan = await api("/api/v2/host-scans", "POST", { contextId: context.id, depth: "metadata", idempotencyKey: randomUUID() });
    await expect.poll(async () => (await api("/api/v2/host-scans/" + scan.scanId)).status).toBe("PARTIAL");
    const scanResult = await api("/api/v2/host-scans/" + scan.scanId); expect(scanResult.issues.map((issue: Data) => issue.code)).toEqual(["STATIC_RESOLUTION_PARTIAL"]);
    const catalog = await api("/api/v2/capabilities?contextId=" + context.id + "&kind=skill"), capability = catalog.items.find((entry: Data) => entry.name === skillName); expect(capability.executor).toBe("codex_host");
    await api("/api/v2/capabilities/" + capability.id + "/import", "POST", { capabilityId: capability.id, expectedSourceRevision: capability.revision, target: "codex_host", environment: "test", lockedArguments: {}, idempotencyKey: randomUUID() });
    const workflowId = "matrix-host-run-" + randomUUID().slice(0, 8); await api("/api/v2/workflows", "POST", { workflowId, name: "Matrix host requirement", environment: "test", mode: "guided", template: "blank", idempotencyKey: randomUUID() });
    const outputSchema = { type: "object", properties: { reportMarkdown: { type: "string" }, evidenceRefs: { type: "array", items: { type: "string" } } }, required: ["reportMarkdown", "evidenceRefs"], additionalProperties: false };
    const changed = await api("/api/v2/workflows/" + workflowId + "/operations", "POST", { expectedRevision: 1, idempotencyKey: randomUUID(), operations: [
      { op: "add_node", nodeId: "host", nodeType: "agent_task", title: "Codex-only Skill", capabilityRef: { capabilityId: capability.id, revision: capability.revision }, config: { kind: "host_skill", skillRef: capability.name, reportContractRef: "incident-report/v1", executorRef: "codex_host", instructions: "Synthetic host-only fixture", inputMappings: {}, outputSchema } },
      { op: "disconnect", source: "input", target: "end", port: "next" }, { op: "connect", source: "input", target: "host", port: "next" }, { op: "connect", source: "host", target: "end", port: "next" },
    ] }, 1);
    await api("/api/v2/workflows/" + workflowId + "/publish", "POST", { expectedRevision: changed.revision, version: "1.0.0", expectedBindingRevisions: {}, expectedCapabilityRevisions: { [capability.id]: capability.revision }, idempotencyKey: randomUUID() });
    const started = await api("/api/v1/runs", "POST", { workflowId, version: "1.0.0", mode: "guided", inputs: {}, idempotencyKey: randomUUID() }); await expect.poll(async () => (await api("/api/v1/runs/" + started.runId)).state).toBe("WAITING_AGENT");
    const before = await api("/api/v1/runs/" + started.runId); expect(before.checkpoint).toMatchObject({ kind: "host_skill", executorRef: "codex_host" });
    await page.goto("/runs/" + started.runId); await expect(page.getByText("此节点需要 Codex 宿主实际执行。模型 API Key 不提供宿主插件权限。", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "使用模型继续分析", exact: true })).toHaveCount(0); await expect(page.getByLabel("本地分析模型", { exact: true })).toHaveCount(0);
    await page.reload(); await expect(page.getByText("此节点需要 Codex 宿主实际执行。模型 API Key 不提供宿主插件权限。", { exact: true })).toBeVisible();
    const after = await api("/api/v1/runs/" + started.runId); expect(after.state).toBe("WAITING_AGENT"); expect(after.revision).toBe(before.revision); expect(after.checkpoint).toEqual(before.checkpoint); expect(modelRequests).toHaveLength(0);
    await expect(readFile(sentinel, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await page.unrouteAll({ behavior: "wait" }); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test("ASST-05 matrix: browser offline recovery replays completion after a saved patch without issuing another model call or write", async ({ page }) => {
  const api = await authenticated(page), workflowId = "matrix-browser-replay-" + randomUUID().slice(0, 8), secondEntered = gate(), finishSecond = gate(), secondFinished = gate(), requests: Data[] = [];
  await api("/api/v2/workflows", "POST", { workflowId, name: "Before browser disconnect", environment: "test", mode: "auto", template: "blank", idempotencyKey: randomUUID() });
  const model = createServer(async (req, res) => {
    let text = ""; for await (const part of req) text += part; const body = JSON.parse(text); requests.push(body);
    if (requests.length === 1) {
      const call = { id: "browser-replay-patch", type: "function", function: { name: "workflow_draft_patch", arguments: JSON.stringify({ workflowId, expectedRevision: 1, operations: [{ op: "set_metadata", changes: { name: "Saved while browser disconnects" } }], idempotencyKey: "browser-replay-patch-once" }) } };
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [call] } }] }));
    } else { secondEntered.resolve(); await finishSecond.promise; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "离线期间保存的回执已完成。" } }] })); secondFinished.resolve(); }
  }); await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  try {
    const profile = await api("/api/v2/model-profiles", "POST", { name: "Matrix browser replay", providerKind: "openai_compatible_chat", baseUrl: "http://127.0.0.1:" + (model.address() as { port: number }).port + "/v1", model: "synthetic-browser-replay", apiKey: "synthetic-browser-replay-key", stream: false });
    await page.goto("/workflows/" + workflowId + "/editor"); await page.locator(".editor-toolbar").getByRole("button", { name: "AI 助手", exact: true }).click(); await expect(page.locator(".assistant-loading")).toHaveCount(0);
    const chat = page.getByRole("region", { name: "FlowHub 助手聊天窗口" }), previous = await chat.getAttribute("data-session-id"); await page.getByRole("button", { name: "新建会话", exact: true }).click(); await expect.poll(() => chat.getAttribute("data-session-id")).not.toBe(previous);
    await page.getByRole("combobox", { name: "使用模型", exact: true }).selectOption(profile.id); await page.getByLabel("发送给助手").fill("修改当前流程名称并保存草稿，不发布不运行"); await page.getByRole("button", { name: "发送", exact: true }).click();
    await secondEntered.promise; await expect(page.getByRole("heading", { name: "Saved while browser disconnects", exact: true })).toBeVisible();
    const sessionId = await chat.getAttribute("data-session-id"), conversation = await api("/api/v2/assistant/sessions/" + sessionId + "/conversation"), taskId = conversation.tasks.at(-1).id;
    const before = await api("/api/v2/assistant/tasks/" + taskId); expect(before.status).toBe("GENERATING"); expect(before.tools).toHaveLength(1); expect(before.tools[0].status).toBe("COMPLETED");
    await page.context().setOffline(true); finishSecond.resolve(); await secondFinished.promise; await page.context().setOffline(false);
    await expect(page.locator('.assistant-turn[data-status="COMPLETED"]').last()).toBeVisible(); await expect(page.getByText("离线期间保存的回执已完成。", { exact: true })).toBeVisible();
    const after = await api("/api/v2/assistant/tasks/" + taskId), draft = await api("/api/v2/workflows/" + workflowId + "/draft"); expect(after.status).toBe("COMPLETED"); expect(after.tools).toEqual(before.tools); expect(draft.revision).toBe(2); expect(draft.draft.name).toBe("Saved while browser disconnects"); expect(requests).toHaveLength(2);
    await page.reload(); await page.locator(".editor-toolbar").getByRole("button", { name: "AI 助手", exact: true }).click(); await expect(page.getByText("离线期间保存的回执已完成。", { exact: true })).toBeVisible(); expect((await api("/api/v2/workflows/" + workflowId + "/draft")).revision).toBe(2); expect(requests).toHaveLength(2);
  } finally { finishSecond.resolve(); await page.context().setOffline(false); await page.unrouteAll({ behavior: "wait" }); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); }
});
