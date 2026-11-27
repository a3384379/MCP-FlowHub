import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

async function workspace(page: Page) {
  const { startDaemon } = await import(pathToFileURL(resolve("dist/apps/daemon/src/index.js")).href);
  const dataDir = await mkdtemp(join(tmpdir(), "flowhub-workspace-requests-"));
  const daemon = await startDaemon({ dataDir, port: 0 });
  const requests: URL[] = [];
  page.on("request", request => requests.push(new URL(request.url())));
  // Observe delivery on the actual browser EventSource so negative assertions can
  // wait for a known server-side event even when it has no visible UI effect.
  await page.addInitScript(() => {
    window.EventSource = class extends EventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener("message", event => {
          document.documentElement.dataset.observedEvent = event.lastEventId;
        });
      }
    };
  });
  const repo = daemon.engine.repo;
  const create = (workflowId: string) => daemon.application.authoring.create({
    workflowId, name: workflowId, environment: "test", mode: "auto", template: "blank", idempotencyKey: randomUUID(),
  });
  return {
    origin: "http://127.0.0.1:" + daemon.port, repo, authoring: daemon.application.authoring,
    requests, create,
    lists: () => requests.filter(url => /^\/api\/v1\/(workflows|connections|tools|bindings|runs)$/.test(url.pathname))
      .map(url => url.pathname + url.search).sort(),
    observed: (id: number) => page.waitForFunction(id => Number(document.documentElement.dataset.observedEvent) >= id, id),
    close: async () => { await page.close(); await daemon.close(); await rm(dataDir, { recursive: true, force: true }); },
  };
}

test("model settings skip old drafts and load workflow and run references only when displayed", async ({ page }) => {
  const app = await workspace(page);
  try {
    // Two draft.changed events per creation.
    for (let i = 0; i < 10; i++) app.create("historical-" + i);
    const history = app.repo.changes();
    expect(history.filter((event: any) => event.type === "draft.changed")).toHaveLength(20);
    await page.goto(app.origin + "/models");
    await expect(page.getByRole("heading", { name: "模型设置", exact: true })).toBeVisible();
    const marker = app.repo.changed("test.marker").eventId;
    await app.observed(marker);
    expect(app.requests.filter(url => url.pathname === "/api/v2/events").map(url => url.searchParams.get("afterEventId")))
      .toEqual([String(history.at(-1).eventId)]);
    expect(app.requests.filter(url => url.pathname.startsWith("/api/")).map(url => url.pathname).sort())
      .toEqual(["/api/v1/auth/local-session", "/api/v1/auth/state", "/api/v2/events", "/api/v2/model-profiles"]);
    app.create("live-model-page");
    await app.observed(app.repo.changed("test.marker").eventId);
    await page.getByRole("button", { name: "打开 FlowHub 助手", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "使用模型", exact: true })).toBeVisible();
    expect(app.lists()).toEqual([]);
    await page.getByRole("button", { name: "发送上下文与模型状态" }).click();
    const workflows = page.getByRole("combobox", { name: "关联流程" });
    await expect(workflows.locator('option[value="live-model-page"]')).toHaveCount(1);
    expect(app.lists()).toEqual(["/api/v1/runs?limit=50", "/api/v1/workflows"]);

    // All 20 new events reach the same browser without refreshing unrelated lists.
    app.requests.length = 0;
    app.repo.tx(() => { for (let i = 0; i < 10; i++) app.create("burst-" + i); });
    await expect(workflows.locator('option[value="burst-9"]')).toHaveCount(1);
    expect(app.lists()).toEqual(["/api/v1/workflows"]);

    await page.getByRole("button", { name: "收起聊天窗口", exact: true }).click();
    app.requests.length = 0;
    await page.getByRole("button", { name: "工作流", exact: true }).click();
    await expect(page.getByRole("heading", { name: "burst-9", exact: true })).toBeVisible();
    await expect.poll(app.lists).toEqual(["/api/v1/connections", "/api/v1/runs?limit=1", "/api/v1/workflows"]);
    const last = app.repo.changed("test.marker").eventId;
    await app.observed(last);
    const reconnect = page.waitForRequest(request => new URL(request.url()).pathname === "/api/v2/events");
    await page.evaluate(() => window.dispatchEvent(new Event("flowhub-session-restored")));
    expect(new URL((await reconnect).url()).searchParams.get("afterEventId")).toBe(String(last));
    app.create("after-reconnect");
    await expect(page.getByRole("heading", { name: "after-reconnect", exact: true })).toBeVisible();
  } finally { await app.close(); }
});

test("editor receives a draft change that arrived while its initial snapshot was in flight", async ({ page }) => {
  const app = await workspace(page);
  const id = "draft-during-load";
  let captured!: () => void, release!: () => void;
  const snapshot = new Promise<void>(resolve => { captured = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    app.create(id);
    await page.route("**/api/v1/workflows/" + id + "/draft", async route => {
      const response = await route.fetch();
      captured();
      await gate;
      await route.fulfill({ response });
    });
    await page.goto(app.origin + "/workflows/" + id + "/editor");
    await snapshot;
    app.repo.tx(() => {
      app.create("unrelated-draft");
      for (let revision = 1; revision <= 4; revision++) app.authoring.patch({
        workflowId: id, expectedRevision: revision, idempotencyKey: randomUUID(),
        operations: [{ op: "set_metadata", changes: { name: "Remote revision " + (revision + 1) } }],
      });
    });
    await app.observed(app.repo.changed("test.marker").eventId);
    release();
    await expect(page.getByRole("heading", { name: "Remote revision 5", exact: true })).toBeVisible();
    expect(app.requests.filter(url => url.pathname === "/api/v2/workflows/" + id + "/draft")).toHaveLength(1);
    expect(app.lists()).toEqual(["/api/v1/bindings", "/api/v1/tools"]);
  } finally { release(); await app.close(); }
});

test("an idle workspace recovers an expired local session and catches up missed edits", async ({ page }) => {
  const app = await workspace(page);
  try {
    await page.goto(app.origin + "/workflows");
    await expect(page.getByRole("heading", { name: "工作流", exact: true })).toBeVisible();
    const cursor = app.repo.changed("test.marker").eventId;
    await app.observed(cursor);
    const session = await (await page.request.get(app.origin + "/api/v1/auth/session")).json();
    const denied = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v2/events" && response.status() === 401);
    const logout = await page.request.delete(app.origin + "/api/v1/auth/session", {
      headers: { "X-CSRF-Token": session.data.csrf },
    });
    expect(logout.ok()).toBe(true);
    app.create("changed-while-disconnected");
    await denied;
    await expect(page.getByRole("heading", { name: "changed-while-disconnected", exact: true })).toBeVisible({ timeout: 10000 });
    expect(app.requests.filter(url => url.pathname === "/api/v1/auth/local-session")).toHaveLength(2);
    expect(app.requests.filter(url => url.pathname === "/api/v2/events").at(-1)?.searchParams.get("afterEventId")).toBe(String(cursor));
  } finally { await app.close(); }
});
