import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("a fresh workspace opens directly and sets a separate vault password on demand", async ({ page }) => {
  const { startDaemon } = await import(pathToFileURL(resolve("dist/apps/daemon/src/index.js")).href);
  const dataDir = await mkdtemp(join(tmpdir(), "flowhub-local-workspace-ui-"));
  const daemon = await startDaemon({ dataDir, port: 0 });
  try {
    const base = `http://127.0.0.1:${daemon.port}`;
    await page.goto(base);
    await expect(page.getByRole("heading", { name: "工作流", exact: true })).toBeVisible();
    await expect(page.getByLabel("管理员密码")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "退出登录", exact: true })).toHaveCount(0);
    const state = async () => (await (await page.request.get(base + "/api/v1/auth/state")).json()).data;
    expect(await state()).toMatchObject({ initialized: false, vaultInitialized: false, vaultLocked: true });

    await page.getByRole("button", { name: "系统设置", exact: true }).click();
    const setup = page.getByRole("button", { name: "设置凭据库口令", exact: true });
    await setup.click();
    const dialog = page.getByRole("dialog", { name: "设置凭据库口令", exact: true });
    await dialog.getByLabel("凭据库口令", { exact: true }).fill("Synthetic-local-vault-041");
    const confirm = dialog.getByRole("button", { name: "确认", exact: true });
    // A second page can replace the shared cookie while this page holds the old CSRF token.
    await page.context().clearCookies();
    const opened = await page.request.post(base + "/api/v1/auth/local-session", {
      headers: { Origin: base, "X-FlowHub-Local": "1" },
      data: {},
    });
    expect(opened.ok()).toBe(true);
    await confirm.click();
    await expect(page.getByRole("alert")).toContainText("本机连接已恢复，请重试刚才的操作");
    expect((await state()).vaultInitialized).toBe(false);
    await expect(dialog.getByLabel("凭据库口令", { exact: true })).toHaveValue("Synthetic-local-vault-041");
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(/本地库已解锁/)).toBeVisible();
    expect(await state()).toMatchObject({ initialized: false, vaultInitialized: true, vaultLocked: false });

    await page.getByRole("button", { name: "立即锁定", exact: true }).click();
    await expect(page.locator("#credential-library").getByText(/本地库已锁定/)).toBeVisible();
    await page.context().clearCookies();
    await page.reload();
    await expect(page.getByRole("heading", { name: "系统设置", exact: true })).toBeVisible();
    await expect(page.getByText(/本地库已锁定/)).toBeVisible();
    expect(await state()).toMatchObject({ initialized: false, vaultInitialized: true, vaultLocked: true });
  } finally {
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
