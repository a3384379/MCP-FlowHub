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
  await page.goto("/workflows");
  const navigation = page.getByRole("navigation", {
    name: "主菜单",
    exact: true,
  });
  await expect(navigation.getByRole("button")).toHaveCount(7);
  for (const group of ["工作区", "能力与连接", "系统配置"])
    await expect(
      navigation.getByRole("heading", { name: group, exact: true }),
    ).toBeVisible();
  for (const [path, label, heading] of [
    ["workflows", "工作流", "工作流"],
    ["runs", "运行记录", "运行记录"],
    ["discovery", "能力发现", "Codex 能力发现"],
    ["connections", "MCP 服务", "MCP 服务"],
    ["bindings", "环境与资源", "环境与资源"],
    ["models", "模型设置", "模型设置"],
    ["settings", "系统设置", "系统设置"],
  ] as const) {
    const item = navigation.getByRole("button", { name: label, exact: true });
    await expect(item.locator("svg")).toHaveCount(1);
    await item.click();
    await expect(page).toHaveURL(new RegExp("/" + path + "$"));
    await expect(item).toHaveAttribute("aria-current", "page");
    await expect(navigation.locator("[aria-current='page']")).toHaveCount(1);
    await expect(page.locator(".breadcrumbs")).toContainText(label!);
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
  }
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const [path, heading] of [
      ["runs", "运行记录"],
      ["settings", "系统设置"],
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
  // The drawer owns focus and blocks the page; Escape, outside click and
  // breakpoint changes must all restore the original interaction state.
  const toggle = page.getByRole("button", { name: "打开导航", exact: true });
  await toggle.click();
  const drawer = page.getByRole("dialog", { name: "主导航", exact: true });
  await expect(drawer).toBeVisible();
  const close = drawer.getByRole("button", { name: "关闭导航", exact: true });
  await expect(close).toBeFocused();
  expect(
    await page
      .locator("#root")
      .evaluate((element) => (element as HTMLElement).inert),
  ).toBe(true);
  expect(
    await page.locator("body").evaluate((element) => element.style.overflow),
  ).toBe("hidden");
  await page.keyboard.press("Shift+Tab");
  await expect(
    drawer.getByRole("button", { name: "系统设置", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(toggle).toBeFocused();
  expect(
    await page
      .locator("#root")
      .evaluate((element) => (element as HTMLElement).inert),
  ).toBe(false);
  expect(
    await page.locator("body").evaluate((element) => element.style.overflow),
  ).toBe("");
  await toggle.click();
  await page
    .locator(".navigation-overlay")
    .click({ position: { x: 384, y: 180 } });
  await expect(drawer).toHaveCount(0);
  await toggle.click();
  await drawer.getByRole("button", { name: "MCP 服务", exact: true }).click();
  await expect(page).toHaveURL(/\/connections$/);
  await expect(drawer).toHaveCount(0);
  await toggle.click();
  await page.goBack();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(drawer).toHaveCount(0);
  await toggle.click();
  await drawer.getByRole("button", { name: "MCP 服务", exact: true }).click();
  await expect(page).toHaveURL(/\/connections$/);
  await page.setViewportSize({ width: 320, height: 740 });
  await toggle.click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  const cdp = await page.context().newCDPSession(page);
  for (const scale of [2, 3]) {
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: scale });
    await expect
      .poll(() => page.evaluate(() => visualViewport!.width))
      .toBeCloseTo(320 / scale, 0);
    await expect
      .poll(async () =>
        drawer.evaluate((element) => {
          const viewport = visualViewport!,
            panel = element.getBoundingClientRect();
          return (
            Math.abs(panel.left - viewport.offsetLeft) +
            Math.max(0, panel.right - viewport.offsetLeft - viewport.width) +
            Math.abs(panel.height - viewport.height)
          );
        }),
      )
      .toBeLessThan(2);
    const system = drawer.getByRole("button", {
      name: "系统设置",
      exact: true,
    });
    await system.scrollIntoViewIfNeeded();
    for (const control of [close, system]) {
      const geometry = await control.evaluate((element) => {
        const box = element.getBoundingClientRect(),
          viewport = visualViewport!;
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          viewportLeft: viewport.offsetLeft,
          viewportTop: viewport.offsetTop,
          width: viewport.width,
          height: viewport.height,
        };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(geometry.viewportLeft - 1);
      expect(geometry.right).toBeLessThanOrEqual(
        geometry.viewportLeft + geometry.width + 1,
      );
      expect(geometry.top).toBeGreaterThanOrEqual(geometry.viewportTop - 1);
      expect(geometry.bottom).toBeLessThanOrEqual(
        geometry.viewportTop + geometry.height + 1,
      );
    }
  }
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  await page.setViewportSize({ width: 900, height: 740 });
  await expect(drawer).toHaveCount(0);
  await expect(
    navigation.getByRole("button", { name: "MCP 服务", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  expect(
    await page
      .locator("#root")
      .evaluate((element) => (element as HTMLElement).inert),
  ).toBe(false);
  expect(
    await page.locator("body").evaluate((element) => element.style.overflow),
  ).toBe("");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/workflows/incident-staging/editor");
  await page.getByText("节点列表（键盘可选择）", { exact: true }).click();
  await page
    .getByRole("button", { name: /查询固定环境日志 · MCP 工具 · log/ })
    .click();
  await expect(page.getByLabel("节点名称", { exact: true })).toBeVisible();
  await page
    .getByLabel("节点名称", { exact: true })
    .fill("导航中保留的未保存名称");
  await toggle.click();
  await expect(
    drawer.getByRole("button", { name: "工作流", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  page.once("dialog", (dialog) => dialog.dismiss());
  await drawer.getByRole("button", { name: "工作流", exact: true }).click();
  await expect(page).toHaveURL(/\/incident-staging\/editor$/);
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("节点名称", { exact: true })).toHaveValue(
    "导航中保留的未保存名称",
  );
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
  await toggle.click();
  page.once("dialog", (dialog) => dialog.accept());
  await drawer.getByRole("button", { name: "MCP 服务", exact: true }).click();
  await expect(page).toHaveURL(/\/connections$/);
  await expect(drawer).toHaveCount(0);
});
