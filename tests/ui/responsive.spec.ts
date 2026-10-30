import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("run and settings actions fit desktop, boundary and mobile viewports, and the mobile inspector closes", async ({
  page,
}) => {
  const password = "Synthetic-browser-password-041";
  const state = (await (await page.request.get("/api/v1/auth/state")).json())
    .data;
  const auth = await page.request.post(
    "/api/v1/auth/" + (state.initialized ? "session" : "bootstrap"),
    {
      data: state.initialized
        ? { password }
        : {
            password,
            setupToken: await readFile(
              process.env.FLOWHUB_UI_DATA_DIR + "/admin-setup-token",
              "utf8",
            ),
          },
    },
  );
  expect(auth.ok(), await auth.text()).toBe(true);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const [path, heading] of [
      ["runs", "运行记录"],
      ["settings", "接入设置"],
    ] as const) {
      await page.goto("/" + path);
      await expect(
        page.getByRole("heading", { name: heading, exact: true }),
      ).toBeVisible();
      if (path === "runs")
        await expect(
          page.getByLabel("运行状态筛选", { exact: true }),
        ).toBeVisible();
      else {
        await expect(
          page.getByRole("button", { name: "创建受限宿主身份", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "SQLite 一致性备份", exact: true }),
        ).toBeVisible();
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        ),
      ).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: `artifacts/ui-responsive-${path}-${viewport.width}.png`,
        fullPage: true,
      });
    }
  }
  await page.goto("/workflows/incident-staging/editor");
  await page.getByText("节点列表（键盘可选择）", { exact: true }).click();
  await page
    .getByRole("button", { name: /查询固定环境日志 · MCP 工具 · log/ })
    .click();
  await expect(page.getByLabel("节点名称", { exact: true })).toBeVisible();
  await page
    .locator(".inspector")
    .getByRole("button", { name: "收起节点属性", exact: true })
    .click();
  await expect(page.locator(".inspector")).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: "artifacts/ui-responsive-editor-390.png",
    fullPage: true,
  });
});
