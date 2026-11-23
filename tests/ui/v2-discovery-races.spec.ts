import { test, expect, type Page } from "@playwright/test";
import { mkdir, mkdtemp, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

test.afterEach(async ({ page }) => {
  const session = await page.request.get("/api/v1/auth/session");
  if (!session.ok()) return;
  const { csrf } = (await session.json()).data;
  const loggedOut = await page.request.delete("/api/v1/auth/session", { headers: { "X-CSRF-Token": csrf } });
  expect(loggedOut.ok(), await loggedOut.text()).toBe(true);
});

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
async function authenticate(page: Page) {
  const dataDir = process.env.FLOWHUB_UI_DATA_DIR!, password = "Synthetic-browser-password-041",
    initialized = (await (await page.request.get("/api/v1/auth/state")).json()).data.initialized,
    response = await page.request.post("/api/v1/auth/" + (initialized ? "session" : "bootstrap"), {
      data: initialized ? { password } : { password, setupToken: await readFile(join(dataDir, "admin-setup-token"), "utf8") },
    });
  expect(response.ok(), await response.text()).toBeTruthy();
  const csrf = (await response.json()).data.csrf;
  return async (path: string, method = "GET", data?: any) => {
    const result = await page.request.fetch(path, { method, headers: { "X-CSRF-Token": csrf }, ...(data === undefined ? {} : { data }) });
    expect(result.ok(), await result.text()).toBeTruthy();
    return (await result.json()).data;
  };
}
const context = (id: string) => ({ id, revision: 1, catalogScanId: "done-" + id, codexHome: "/synthetic/" + id, canonicalCwd: "/synthetic/project-" + id, discoveryMode: "config_only", projectTrusted: false, useAppServer: false, executionLocation: "macos" });
async function fakeContexts(page: Page, handler: (method: string, body: any) => Promise<any>) {
  await authenticate(page);
  await page.route("**/api/v2/host-contexts", async route => {
    const result = await handler(route.request().method(), route.request().postDataJSON());
    await route.fulfill(result?.error ? { status: 409, json: result } : { json: { data: result } });
  });
  await page.route("**/api/v2/discovery/catalog?*", route => route.fulfill({ json: { data: { items: [], nextCursor: null, total: 0, scanId: "done", status: "SUCCEEDED", coverage: "complete", snapshot: "synthetic", counts: { mcp_server: 0, skill: 0, plugin: 0, issues: 0 } } } }));
  await page.addInitScript(() => localStorage.setItem("flowhub.discovery.context", "A"));
  await page.goto("/discovery");
  await expect(page.getByLabel("本机上下文", { exact: true })).toHaveValue("A");
  await page.getByText("登记本机 Codex 上下文", { exact: true }).click();
}

for (const failure of [false, true]) test("late context registration " + (failure ? "error" : "success") + " cannot change the selected context or show an abandoned error", async ({ page }) => {
  const gate = deferred(); let posts = 0, gets = 0, body: any;
  await fakeContexts(page, async (method, request) => {
    if (method === "GET") { gets++; return [context("A"), context("B")]; }
    posts++; body = request; await gate.promise;
    return failure ? { error: { code: "SYNTHETIC_OLD_ERROR", message: "abandoned-registration-error" } } : context("A");
  });
  try {
    await page.getByRole("button", { name: "更新当前上下文的读取选项", exact: true }).click();
    await expect.poll(() => posts).toBe(1); expect(body).toMatchObject({ contextId: "A", expectedRevision: 1 });
    await expect(page.getByLabel("项目目录（留空使用当前目录）", { exact: true })).toBeDisabled();
    const initialGets = gets;
    await page.getByLabel("本机上下文", { exact: true }).selectOption("B");
    await expect(page.getByLabel("项目目录（留空使用当前目录）", { exact: true })).toHaveValue("/synthetic/project-B");
    await expect.poll(() => gets).toBeGreaterThan(initialGets);
    const before = gets;
    const response = page.waitForResponse(r => r.url().endsWith("/api/v2/host-contexts") && r.request().method() === "POST");
    gate.release(); await response;
    await expect(page.getByLabel("本机上下文", { exact: true })).toHaveValue("B");
    await expect(page.locator(".v2-discovery [role=alert]")).toHaveCount(0);
    expect(gets).toBe(before);
  } finally { gate.release(); }
});

test("registration context-list response cannot revive an old selection after the POST has completed", async ({ page }) => {
  const gate = deferred(); let deferList = false, listWaiting = false;
  await fakeContexts(page, async method => {
    if (method === "POST") { deferList = true; return context("C"); }
    if (deferList) { deferList = false; listWaiting = true; await gate.promise; }
    return [context("A"), context("B"), context("C")];
  });
  try {
    await page.getByRole("button", { name: "登记上下文", exact: true }).click();
    await expect.poll(() => listWaiting).toBe(true);
    await page.getByLabel("本机上下文", { exact: true }).selectOption("B");
    gate.release();
    await expect(page.getByLabel("项目目录（留空使用当前目录）", { exact: true })).toHaveValue("/synthetic/project-B");
    await expect(page.getByLabel("本机上下文", { exact: true })).toHaveValue("B");
    await expect(page.getByRole("button", { name: "登记上下文", exact: true })).toBeEnabled();
  } finally { gate.release(); }
});

test("a newer registration after selecting another context owns the UI and navigation invalidates the older request", async ({ page }) => {
  const gate = deferred(); let posts = 0;
  await fakeContexts(page, async method => {
    if (method === "GET") return [context("A"), context("B"), context("C")];
    posts++;
    if (posts === 1) { await gate.promise; return context("A"); }
    return context("C");
  });
  try {
    await page.getByRole("button", { name: "登记上下文", exact: true }).click(); await expect.poll(() => posts).toBe(1);
    await page.getByLabel("本机上下文", { exact: true }).selectOption("B");
    await page.getByRole("button", { name: "登记上下文", exact: true }).click();
    await expect(page.getByLabel("本机上下文", { exact: true })).toHaveValue("C");
    await page.getByRole("button", { name: "工作流", exact: true }).click();
    const response = page.waitForResponse(r => r.url().endsWith("/api/v2/host-contexts") && r.request().method() === "POST");
    gate.release(); await response;
    expect(await page.evaluate(() => localStorage.getItem("flowhub.discovery.context"))).toBe("C");
    await expect(page).not.toHaveURL(/\/discovery$/);
  } finally { gate.release(); }
});

async function realDiscovery(page: Page) {
  const api = await authenticate(page), root = await realpath(await mkdtemp(join(process.env.FLOWHUB_UI_DATA_DIR!, "discovery-races-"))),
    home = join(root, "home"), cwd = join(root, "project"), cli = join(root, "codex.mjs"), servers = join(root, "servers.json"), hold = join(root, "hold"), marker = join(root, "entered"),
    skillDir = join(home, "skills/review"), skill = join(skillDir, "SKILL.md"), name = "synthetic-race-" + randomUUID().slice(0, 8);
  await Promise.all([mkdir(home), mkdir(cwd)]); await mkdir(skillDir, { recursive: true });
  await writeFile(join(home, "config.toml"), "");
  const original = `---\nname: ${name}\ndescription: Synthetic revision one purpose.\n---\nRead synthetic evidence only.\n`;
  await writeFile(skill, original);
  await writeFile(servers, JSON.stringify([{ name: "synthetic-auth", enabled: true, transport: { url: "https://synthetic.invalid/mcp", env_http_headers: { AUTHORIZATION: "SYNTHETIC_AUTH" } } }]));
  await writeFile(cli, `import fs from 'node:fs/promises';const a=process.argv.slice(2);if(a.includes('--version'))console.log('codex-cli synthetic-ui-races');else if(a.includes('--help'))console.log('--json');else{try{await fs.access(${JSON.stringify(hold)});await fs.writeFile(${JSON.stringify(marker)},'entered');while(true){try{await fs.access(${JSON.stringify(hold)});}catch{break;}await new Promise(r=>setTimeout(r,5));}}catch{}console.log(await fs.readFile(${JSON.stringify(servers)},'utf8'));}`);
  const c = await api("/api/v2/host-contexts", "POST", { codexHome: home, cwd, codexPath: cli });
  const scan = async () => {
    const accepted = await api("/api/v2/host-scans", "POST", { contextId: c.id, depth: "metadata", idempotencyKey: randomUUID() });
    await expect.poll(async () => (await api("/api/v2/host-scans/" + accepted.scanId)).status).toBe("SUCCEEDED");
  };
  await scan();
  let entity = (await api("/api/v2/discovery/catalog?contextId=" + c.id + "&kind=skill")).items[0];
  const descriptions = (e: any, displayName: string, summary: string) => ({ contextId: c.id, expectedContextRevision: c.revision, action: "submit_descriptions", idempotencyKey: randomUUID(), entries: [{ entityId: e.id, entityKind: e.entityKind, expectedSourceRevision: e.revision, sourceFingerprint: e.sourceFingerprint, expectedPresentationRevision: e.presentation.revision, locale: "zh-CN", displayName, summary, evidenceRefs: e.evidenceRefs }] });
  await api("/api/v2/discovery/descriptions", "POST", descriptions(entity, "合成审查原说明", "旧中文用途"));
  entity = await api("/api/v2/discovery/entities/" + entity.id);
  await page.addInitScript(id => localStorage.setItem("flowhub.discovery.context", id), c.id);
  await page.goto("/discovery"); await expect(page.getByRole("button", { name: "重新扫描", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: /Skills 技能/ }).click();
  const row = page.locator(`.d-cap-row[data-entity-id="${entity.id}"][data-entity-kind="skill"]`);
  await expect(row).toHaveCount(1);
  const open = async () => { await row.getByRole("button").click(); await expect(page.getByRole("dialog").locator(".d-detail-title")).toBeVisible(); };
  return { api, root, skill, servers, original, context: c, entity, descriptions, scan, open,
    pendingScan: async () => { await writeFile(hold, "hold"); await page.getByRole("button", { name: "重新扫描", exact: true }).click(); await expect.poll(async () => readFile(marker, "utf8").catch(() => "")).toBe("entered"); },
    release: () => rm(hold, { force: true }), close: async () => { await rm(hold, { force: true }); await rm(root, { recursive: true, force: true }); } };
}

test("clearing an existing Profile sends null, preserves rejected input and can register the default Profile separately", async ({ page }) => {
  const f = await realDiscovery(page);
  try {
    const profiled = await f.api("/api/v2/host-contexts", "POST", { codexHome: f.context.codexHome, cwd: f.context.canonicalCwd, codexPath: f.context.codexPath, profile: "synthetic-profile" }),
      scan = await f.api("/api/v2/host-scans", "POST", { contextId: profiled.id, depth: "metadata", idempotencyKey: randomUUID() });
    await expect.poll(async () => (await f.api("/api/v2/host-scans/" + scan.scanId)).status).toBe("PARTIAL");
    await page.reload();
    await page.getByLabel("本机上下文", { exact: true }).selectOption(profiled.id);
    await page.getByText("登记本机 Codex 上下文", { exact: true }).click();
    const profile = page.getByLabel("Profile（可选）", { exact: true });
    await expect(profile).toHaveValue("synthetic-profile");
    const before = (await f.api("/api/v2/host-contexts")).find((c: any) => c.id === profiled.id);
    await profile.fill("");
    const rejectedResponse = page.waitForResponse(r => r.url().endsWith("/api/v2/host-contexts") && r.request().method() === "POST");
    await page.getByRole("button", { name: "更新当前上下文的读取选项", exact: true }).click();
    const rejected = await rejectedResponse;
    expect(rejected.status()).toBe(409); expect((await rejected.json()).error.code).toBe("CONTEXT_IDENTITY_CHANGED");
    expect(rejected.request().postDataJSON()).toMatchObject({ contextId: profiled.id, expectedRevision: profiled.revision, profile: null, codexPath: f.context.codexPath });
    await expect(profile).toHaveValue("");
    await expect(page.locator(".v2-discovery [role=alert]")).toContainText("登记新上下文");
    expect((await f.api("/api/v2/host-contexts")).find((c: any) => c.id === profiled.id)).toEqual(before);
    const registeredResponse = page.waitForResponse(r => r.url().endsWith("/api/v2/host-contexts") && r.request().method() === "POST");
    await page.getByRole("button", { name: "登记上下文", exact: true }).click();
    const registered = await registeredResponse;
    expect(registered.ok()).toBe(true); expect((await registered.json()).data.id).toBe(f.context.id);
    expect(registered.request().postDataJSON()).toMatchObject({ profile: null });
    expect(registered.request().postDataJSON()).not.toHaveProperty("contextId");
    await expect(page.getByLabel("本机上下文", { exact: true })).toHaveValue(f.context.id);
    expect((await f.api("/api/v2/host-contexts")).find((c: any) => c.id === profiled.id)).toEqual(before);
  } finally { await f.close(); }
});

test("clearing an explicit CLI in auto mode sends an empty reset intent and preserves the rejected form instead of reviving the old path", async ({ page }) => {
  const f = await realDiscovery(page);
  try {
    await page.getByText("登记本机 Codex 上下文", { exact: true }).click();
    const cli = page.getByLabel("Codex 可执行文件绝对路径（留空自动查找）", { exact: true }),
      before = (await f.api("/api/v2/host-contexts")).find((c: any) => c.id === f.context.id);
    await expect(cli).toHaveValue(f.context.codexPath); await cli.fill("");
    const rejectedResponse = page.waitForResponse(r => r.url().endsWith("/api/v2/host-contexts") && r.request().method() === "POST");
    await page.getByRole("button", { name: "更新当前上下文的读取选项", exact: true }).click();
    const rejected = await rejectedResponse;
    expect(rejected.status()).toBe(409); expect((await rejected.json()).error.code).toBe("CONTEXT_IDENTITY_CHANGED");
    expect(rejected.request().postDataJSON()).toMatchObject({ contextId: f.context.id, expectedRevision: f.context.revision, discoveryMode: "auto", codexPath: "" });
    await expect(cli).toHaveValue(""); await expect(page.locator(".v2-discovery [role=alert]")).toContainText("登记新上下文");
    expect((await f.api("/api/v2/host-contexts")).find((c: any) => c.id === f.context.id)).toEqual(before);
  } finally { await f.close(); }
});

for (const change of ["source", "presentation"]) test("a retained description draft keeps its original baseline across a pending scan and " + change + " change", async ({ page }) => {
  const f = await realDiscovery(page);
  try {
    await f.pendingScan(); await f.open(); const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "编辑中文说明", exact: true }).click();
    await dialog.getByLabel("一句话用途", { exact: true }).fill("开始编辑时保留的草稿");
    if (change === "source") await writeFile(f.skill, f.original.replace("revision one", "revision two"));
    else await f.api("/api/v2/discovery/descriptions", "POST", f.descriptions(f.entity, "较新的手工说明", "并发保存的新用途"));
    await f.release();
    await expect(dialog.getByText(/当前草稿保留开始编辑时的版本/)).toBeVisible();
    await expect(dialog.getByLabel("一句话用途", { exact: true })).toHaveValue("开始编辑时保留的草稿");
    const response = page.waitForResponse(r => r.url().endsWith("/api/v2/discovery/descriptions") && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "保存中文说明", exact: true }).click();
    const rejected = await response; expect(rejected.status()).toBe(409);
    const sent = rejected.request().postDataJSON();
    expect(sent.entries[0]).toMatchObject({ expectedSourceRevision: f.entity.revision, sourceFingerprint: f.entity.sourceFingerprint, expectedPresentationRevision: f.entity.presentation.revision });
    expect((await rejected.json()).error.code).toBe(change === "source" ? "CAPABILITY_STALE" : "REVISION_CONFLICT");
    await expect(dialog.getByLabel("一句话用途", { exact: true })).toHaveValue("开始编辑时保留的草稿");
    const saved = await f.api("/api/v2/discovery/entities/" + f.entity.id);
    expect(saved.presentation.summary).toBe(change === "source" ? "旧中文用途" : "并发保存的新用途");
  } finally { await f.close(); }
});

test("changing capability type hides old rows and rejects a late response from the previous type", async ({ page }) => {
  const f = await realDiscovery(page), mcp = deferred(), skill = deferred();
  let mcpWaiting = false, skillWaiting = false;
  await page.route("**/api/v2/discovery/catalog?*", async route => {
    const kind = new URL(route.request().url()).searchParams.get("kind");
    if (kind === "mcp_server") { mcpWaiting = true; await mcp.promise; }
    if (kind === "skill") { skillWaiting = true; await skill.promise; }
    await route.continue();
  });
  try {
    await page.getByRole("tab", {name:/MCP 服务/}).click();
    await expect.poll(() => mcpWaiting).toBe(true);
    await expect(page.locator(".d-cap-row")).toHaveCount(0);
    await page.getByRole("tab", {name:/Skills 技能/}).click();
    await expect.poll(() => skillWaiting).toBe(true);
    const finished = page.waitForResponse(r => r.url().includes("/discovery/catalog?") && new URL(r.url()).searchParams.get("kind") === "mcp_server");
    mcp.release(); await finished;
    await expect(page.locator(".d-cap-row")).toHaveCount(0);
    skill.release();
    await expect(page.locator(".d-cap-row .d-cap-icon.skill")).toHaveCount(1);
    await expect(page.locator(".d-cap-row .d-cap-icon.mcp_server")).toHaveCount(0);
  } finally { mcp.release(); skill.release(); await f.close(); }
});

test("Esc, rescan and reopen preserve the edit baseline; cancel and a fresh edit deliberately adopt the new source", async ({ page }) => {
  const f = await realDiscovery(page);
  try {
    await f.open(); let dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "编辑中文说明", exact: true }).click();
    await dialog.getByLabel("一句话用途", { exact: true }).fill("Esc 保留的旧草稿"); await page.keyboard.press("Escape");
    await writeFile(f.skill, f.original.replace("revision one", "revision two"));
    await f.pendingScan();
    await expect(page.getByRole("button", { name: "重新扫描", exact: true })).toBeDisabled();
    await f.open(); dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("一句话用途", { exact: true })).toHaveValue("Esc 保留的旧草稿");
    await f.release();
    await expect(dialog.getByText(/当前草稿保留开始编辑时的版本/)).toBeVisible();
    await expect(dialog.getByLabel("一句话用途", { exact: true })).toHaveValue("Esc 保留的旧草稿");
    await dialog.getByRole("button", { name: "取消编辑", exact: true }).click();
    await dialog.getByRole("button", { name: "编辑中文说明", exact: true }).click();
    await dialog.getByLabel("一句话用途", { exact: true }).fill("核对新来源后的新草稿");
    const savedResponse = page.waitForResponse(r => r.url().endsWith("/api/v2/discovery/descriptions") && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "保存中文说明", exact: true }).click();
    expect((await savedResponse).ok()).toBe(true);
    await expect(dialog.getByRole("button", { name: "编辑中文说明", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "编辑中文说明", exact: true }).click();
    await expect(dialog.getByLabel("一句话用途", { exact: true })).toHaveValue("核对新来源后的新草稿");
    await expect(dialog.getByText(/当前草稿保留开始编辑时的版本/)).toHaveCount(0);
  } finally { await f.close(); }
});

test("description and credential fields remain locked while their save HTTP requests are pending", async ({ page }) => {
  const f = await realDiscovery(page), description = deferred(), credentials = deferred();
  let descriptionWaiting = false, credentialsWaiting = false;
  try {
    await page.route("**/api/v2/discovery/descriptions", async route => { descriptionWaiting = true; await description.promise; await route.continue(); });
    await f.open(); let dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "编辑中文说明", exact: true }).click();
    await dialog.getByLabel("一句话用途", { exact: true }).fill("待保存的明确输入");
    await dialog.getByRole("button", { name: "保存中文说明", exact: true }).click(); await expect.poll(() => descriptionWaiting).toBe(true);
    await expect(dialog.getByLabel("一句话用途", { exact: true })).toBeDisabled(); await expect(dialog.getByLabel("中文显示名称", { exact: true })).toBeDisabled();
    description.release(); await expect(dialog.getByRole("button", { name: "编辑中文说明", exact: true })).toBeVisible();
    expect((await f.api("/api/v2/discovery/entities/" + f.entity.id)).presentation.summary).toBe("待保存的明确输入");
    await page.keyboard.press("Escape");
    await f.api("/api/v1/credentials/migrate", "POST", { password: "Synthetic-browser-password-041" });
    const secret = await f.api("/api/v1/secrets", "POST", { label: "Synthetic pending credential", value: "only-synthetic" });
    const source = (await f.api("/api/v2/discovery/catalog?contextId=" + f.context.id + "&kind=mcp_server")).items[0];
    await page.getByRole("tab", { name: /MCP 服务/ }).click();
    const server = page.locator(".d-cap-row").filter({ hasText: source.name });
    await expect(server).toHaveCount(1);
    await f.pendingScan();
    await server.getByRole("button").click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "启用 FlowHub 直连", exact: true }).click();
    await dialog.getByLabel("SYNTHETIC_AUTH", { exact: true }).selectOption(secret.id);
    await page.route("**/api/v2/capability-sources/*/credentials", async route => { credentialsWaiting = true; await credentials.promise; await route.continue(); });
    await dialog.getByRole("button", { name: "保存配置", exact: true }).click(); await expect.poll(() => credentialsWaiting).toBe(true);
    await expect(dialog.getByLabel("SYNTHETIC_AUTH", { exact: true })).toBeDisabled();
    await expect(dialog.getByRole("checkbox", { name: "使用来源已有配置（加密保存）" })).toBeDisabled();
    // Refresh the source snapshot while the connection save is still in flight.
    await f.release();
    await expect(page.locator(".d-scan-status")).toContainText("扫描完成");
    await expect(dialog.getByLabel("SYNTHETIC_AUTH", { exact: true })).toHaveValue(secret.id);
    await expect(dialog.getByLabel("SYNTHETIC_AUTH", { exact: true })).toBeDisabled();
    const savedResponse = page.waitForResponse(r => /\/api\/v2\/capability-sources\/[^/]+\/credentials$/.test(new URL(r.url()).pathname) && r.request().method() === "POST");
    credentials.release(); const saved = await savedResponse;
    expect(saved.ok(), await saved.text()).toBe(true);
    const receipt = (await saved.json()).data; expect(receipt.status).toBe("credentials_configured");
    expect(saved.request().postDataJSON()).toMatchObject({ expectedRevision: source.configurationRevision, secretRefs: { SYNTHETIC_AUTH: secret.id } });
    const connection = (await f.api("/api/v1/connections")).find((c: any) => c.id === receipt.connectionId);
    expect(connection).toMatchObject({ id: receipt.connectionId, secretRef: secret.id });
    await expect(dialog.getByText("连接配置已保存。可检测连接并读取工具目录，资源绑定仍需独立验证。")).toBeVisible();
    await expect(dialog.getByLabel("SYNTHETIC_AUTH", { exact: true })).toHaveValue(secret.id);
  } finally { description.release(); credentials.release(); await f.close(); }
});

test("a credential draft keeps its original configuration revision through a source-changing snapshot refresh", async ({ page }) => {
  const f = await realDiscovery(page);
  try {
    await f.api("/api/v1/credentials/migrate", "POST", { password: "Synthetic-browser-password-041" });
    const secret = await f.api("/api/v1/secrets", "POST", { label: "Synthetic credential baseline", value: "only-synthetic" }),
      source = (await f.api("/api/v2/discovery/catalog?contextId=" + f.context.id + "&kind=mcp_server")).items[0],
      connections = (await f.api("/api/v1/connections")).map((c: any) => c.id);
    await page.getByRole("tab", { name: /需处理/ }).click(); await f.pendingScan();
    await page.getByRole("button", { name: "查看详情", exact: true }).click(); const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "启用 FlowHub 直连", exact: true }).click();
    await dialog.getByLabel("SYNTHETIC_AUTH", { exact: true }).selectOption(secret.id);
    await writeFile(f.servers, (await readFile(f.servers, "utf8")).replace("https://synthetic.invalid/mcp", "https://changed-synthetic.invalid/mcp"));
    await f.release(); await expect(dialog.getByText(/当前填写保留读取时的版本/)).toBeVisible();
    await expect(dialog.getByLabel("SYNTHETIC_AUTH", { exact: true })).toHaveValue(secret.id);
    const rejectedResponse = page.waitForResponse(r => /\/api\/v2\/capability-sources\/[^/]+\/credentials$/.test(new URL(r.url()).pathname) && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "保存配置", exact: true }).click(); const rejected = await rejectedResponse;
    expect(rejected.status()).toBe(409); expect((await rejected.json()).error.code).toBe("CAPABILITY_STALE");
    expect(rejected.request().postDataJSON().expectedRevision).toBe(source.configurationRevision);
    await expect(dialog.getByLabel("SYNTHETIC_AUTH", { exact: true })).toHaveValue(secret.id);
    expect((await f.api("/api/v1/connections")).map((c: any) => c.id)).toEqual(connections);
  } finally { await f.close(); }
});
