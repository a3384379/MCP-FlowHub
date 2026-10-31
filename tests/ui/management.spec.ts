import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
const password = "Synthetic-browser-password-041";
test("bootstrap, six pages, real flow canvas, save/validate, start and Agent handoff", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const stateResponse = await page.request.get("/api/v1/auth/state");
  expect(stateResponse.ok()).toBe(true);
  const initialized = (await stateResponse.json()).data.initialized;
  await page.goto("/");
  const setup = page.getByLabel("本机一次性设置码");
  if (!initialized) {
    await expect(setup).toBeVisible();
    const token = await readFile(
      process.env.FLOWHUB_UI_DATA_DIR + "/admin-setup-token",
      "utf8",
    );
    await setup.fill(token);
    await page.getByLabel("管理员密码").fill(password);
    await page.getByRole("button", { name: "创建并进入" }).click();
  } else {
    await expect(
      page.getByRole("button", { name: "登录管理中心", exact: true }),
    ).toBeVisible();
    await expect(setup).toHaveCount(0);
    await page.getByLabel("管理员密码").fill(password);
    await page.getByRole("button", { name: "登录管理中心" }).click();
  }
  await expect(
    page.getByRole("heading", { name: "工作流", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /试运行问题排查/ }),
  ).toBeVisible();
  for (const label of ["MCP 工具库", "环境与权限", "运行记录", "接入设置"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: label, exact: true }),
    ).toBeVisible();
  }
  await page.goto("/tools");
  await expect(
    page.getByRole("heading", { name: "MCP 工具库", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "工作流库", exact: true }).click();
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
  await page.getByRole("button", { name: "工作流库", exact: true }).click();
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
  await expect(page.locator(".artifact")).toHaveCount(1);
  await page.getByRole("button", { name: "查看", exact: true }).click();
  await expect(page.locator(".evidence")).toContainText("synthetic");
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.screenshot({ path: "artifacts/ui-run-1366.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "工作流库", exact: true }).click();
  await page.screenshot({
    path: "artifacts/ui-library-1440.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("a pending auth-state request never exposes a consumed setup-token field", async ({
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
  const state = await page.request.get("/api/v1/auth/state");
  expect((await state.json()).data.initialized).toBe(true);
  const session = await page.request.post("/api/v1/auth/session", {
    data: { password },
  });
  expect(session.ok(), await session.text()).toBe(true);
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
      page.getByRole("heading", { name: "正在检查登录状态", exact: true }),
    ).toBeVisible();
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
