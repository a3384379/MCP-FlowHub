import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
const password = "Synthetic-browser-password-041";
test("passwordless workspace, six pages, real flow canvas, save/validate, start and Agent handoff", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const stateResponse = await page.request.get("/api/v1/auth/state");
  expect(stateResponse.ok()).toBe(true);
  const initialized = (await stateResponse.json()).data.initialized;
  if (!initialized) {
    // Legacy setup remains available to seed this suite's custom credential.
    const token = await readFile(process.env.FLOWHUB_UI_DATA_DIR + "/admin-setup-token", "utf8");
    const seeded = await page.request.post("/api/v1/auth/bootstrap", {data:{setupToken:token,password}});
    expect(seeded.ok()).toBe(true);
    await page.context().clearCookies();
  }
  await page.goto("/");
  await expect(page.getByLabel("本机一次性设置码")).toHaveCount(0);
  await expect(page.getByLabel("管理员账号", {exact:true})).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "工作流", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /试运行问题排查/ }),
  ).toBeVisible();
  const menu = page.getByRole("navigation", { name: "主菜单", exact: true });
  await expect(menu.getByRole("button", { name: "环境与资源", exact: true })).toHaveCount(0);
  for (const label of ["MCP 服务", "运行记录", "系统设置"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: label, exact: true }),
    ).toBeVisible();
    if (label === "系统设置") {
      await expect(page.getByRole("heading", { name: "配置与凭据库", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "迁移旧版凭据", exact: true })).toHaveCount(0);
    }
  }
  await page.goto("/bindings");
  await expect(page).toHaveURL("/connections/bindings");
  await expect(menu.getByRole("button", { name: "MCP 服务", exact: true })).toHaveAttribute("aria-current", "page");
  const sample = page.getByRole("heading", { name: "阿里云生产日志（模拟）", exact: true });
  await expect(sample).toBeHidden();
  await page.getByText("内置示例（4）", { exact: true }).click();
  await expect(sample).toBeVisible();
  await page.locator(".breadcrumbs").getByRole("link", { name: "MCP 服务" }).click();
  await expect(page).toHaveURL("/connections");
  await page.goto("/tools");
  await expect(
    page.getByRole("heading", { name: "MCP 服务", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "工作流", exact: true }).click();
  await page.getByRole("button", { name: "打开编排" }).nth(1).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await page.getByRole("button", { name: "校验流程", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("后端校验通过");
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "查询固定环境日志" })
    .click();
  await expect(page.getByLabel("节点名称")).toBeVisible();
  await expect(page.getByLabel("实际 MCP 工具")).toHaveValue(
    "huawei_log_search",
  );
  await page.getByRole("button", { name: "工作流", exact: true }).click();
  await page.getByRole("button", { name: "启动", exact: true }).nth(1).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "incident-staging", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /plan · 宿主待办/ }),
  ).toBeVisible({ timeout: 20000 });
  await expect(
    page.getByRole("button", { name: "手动提交", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Skill 不可用，使用已声明模板",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "复制 runId", exact: true }),
  ).toBeVisible();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "复制 Codex 续跑指令" }).click();
  const instruction = await page.evaluate(() => navigator.clipboard.readText());
  expect(instruction).toContain("flowhub-run");
  expect(instruction).toContain("固定环境 \"staging\"");
  expect(instruction).not.toMatch(/checkpointToken|cp_[0-9a-f-]+|[0-9a-f]{64}/);
  const runPath = new URL(page.url()).pathname;
  const runId = runPath.split("/").at(-1)!;
  expect(instruction).toContain(runId);
  await page.getByRole("button", { name: "返回运行记录" }).click();
  await page.getByRole("row").filter({ hasText: runId.slice(0, 24) })
    .getByRole("button", { name: "查看详情 →" }).click();
  await expect(page).toHaveURL(runPath);
  await expect(page.locator(".artifact")).toHaveCount(1);
  const previewUrl = /\/api\/v1\/runs\/[^/]+\/artifacts\/[^/?]+\?offset=0/;
  await page.route(previewUrl, (route) => route.fulfill({
    status: 503,
    json: { error: { message: "附件暂时无法读取。" } },
  }));
  await page.getByRole("button", { name: "查看", exact: true }).click();
  const preview = page.getByRole("region", { name: "附件预览" });
  await expect(preview.getByRole("alert")).toContainText("附件暂时无法读取。");
  await page.unroute(previewUrl);
  await preview.getByRole("button", { name: "重试读取", exact: true }).click();
  await expect(preview).toContainText("synthetic");
  await expect(preview).toBeFocused();
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.screenshot({ path: "artifacts/ui-run-1366.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "工作流", exact: true }).click();
  await page.screenshot({
    path: "artifacts/ui-library-1440.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("run detail supports loading, retry, sparse history and return to the list", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let responseStatus = 503;
  const runId = "historical-run";
  await page.route(/\/api\/v1\/runs\/historical-run\?after=/, async (route) => {
    await waiting;
    const response = responseStatus === 200
      ? { data: { runId, workflowId: "旧版工作流", state: "SUCCEEDED" } }
      : { error: { message: "运行数据暂时不可用。" } };
    await route.fulfill({ status: responseStatus, json: response });
  });
  try {
    await page.goto("/runs/" + runId, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("正在读取运行详情…", { exact: true })).toBeVisible();
    release();
    await expect(page.getByRole("alert")).toContainText("运行数据暂时不可用。");
    responseStatus = 200;
    await page.getByRole("button", { name: "重试读取运行详情" }).click();
    await expect(page.getByRole("heading", { name: "旧版工作流" })).toBeVisible();
    await expect(page.getByText("快照哈希未记录")).toBeVisible();
    await expect(page.getByText("尚未收集到证据。")).toBeVisible();
    const listUrl = /\/api\/v1\/runs\?limit=/;
    await page.route(listUrl, (route) => route.fulfill({
      status: 503,
      json: { error: { message: "运行列表暂时不可用。" } },
    }));
    await page.reload();
    await expect(page.getByRole("heading", { name: "旧版工作流" })).toBeVisible();
    await page.getByRole("button", { name: "返回运行记录" }).click();
    await expect(page.getByRole("heading", { name: "运行记录", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("运行列表暂时不可用。");
    await page.unroute(listUrl);
    await page.getByRole("button", { name: "重试读取运行记录" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.goto("/runs/missing-run");
    await expect(page.getByRole("alert")).toContainText("这条记录不存在，或已超过保留期限。");
    await expect(page.getByRole("button", { name: "重试读取运行详情" })).toBeVisible();
    await expect(page.getByRole("button", { name: "返回运行记录" })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    release();
  }
});

test("completed run drains its timeline and only refreshes again on request", async ({ page }) => {
  const cursors: number[] = [];
  const runId = "completed-paged-run";
  let streams = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/runs/" + runId + "/events?*", async route => {
    streams++;
    await route.abort();
  });
  await page.route("**/api/v1/runs/" + runId + "?after=*", async route => {
    const after = Number(new URL(route.request().url()).searchParams.get("after"));
    cursors.push(after);
    if (cursors.length === 4) await blocked;
    const nextAfter = Math.min(after + 1, 2);
    await route.fulfill({ json: { data: {
      runId,
      workflowId: "分页合成历史",
      state: "SUCCEEDED",
      events: nextAfter > after ? [{ seq: nextAfter, type: "TEST_EVENT_" + nextAfter }] : [],
      eventCursor: { nextAfter, hasMore: nextAfter < 2 },
    } } });
  });
  await page.goto("/runs/" + runId);
  await expect(page.getByText("TEST_EVENT_2", { exact: true })).toBeVisible();
  await page.waitForTimeout(2400); // Longer than the old terminal polling interval.
  expect(cursors).toEqual([0, 1]);
  expect(streams).toBe(0);
  await page.getByRole("button", { name: "↻ 刷新" }).click();
  await expect.poll(() => cursors).toEqual([0, 1, 2]);
  await expect(page.getByText("TEST_EVENT_1", { exact: true })).toHaveCount(1);
  await expect(page.getByText("TEST_EVENT_2", { exact: true })).toHaveCount(1);
  try {
    await page.getByRole("button", { name: "返回运行记录" }).click();
    await expect(page.getByRole("heading", { name: "运行记录", exact: true })).toBeVisible();
    await page.goBack({ waitUntil: "commit" });
    await expect(page.getByText("正在读取运行详情…", { exact: true })).toBeVisible();
    await expect(page.getByText("TEST_EVENT_2", { exact: true })).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.getByText("TEST_EVENT_2", { exact: true })).toBeVisible();
});

test("a pending workspace request shows loading until the workspace opens", async ({
  page,
}) => {
  let release!: () => void;
  let requested!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route("**/api/v1/auth/state", async (route) => {
    const response = await route.fetch();
    requested();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.goto("/workflows", { waitUntil: "domcontentloaded" });
    await started;
    await expect(
      page.getByRole("status"),
    ).toHaveText("正在打开本机工作区…");
    await expect(page.getByLabel("本机一次性设置码")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "创建并进入", exact: true }),
    ).toHaveCount(0);
    release();
    await expect(
      page.getByRole("heading", { name: "工作流", exact: true }),
    ).toBeVisible();
  } finally {
    release();
  }
});
