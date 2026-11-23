import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("a legacy workspace migrates saved credentials once without replacing them", async ({ page }) => {
  const { startDaemon } = await import(pathToFileURL(resolve("dist/apps/daemon/src/index.js")).href);
  const dataDir = await mkdtemp(join(tmpdir(), "flowhub-local-workspace-ui-"));
  const password = "Synthetic-local-vault-041";
  let daemon = await startDaemon({ dataDir, port: 0 });
  const { repo, vault } = daemon.engine;
  vault.lock();
  repo.remove("settings", "vault");
  vault.initialize(password);
  const saved = vault.addSecret("Old synthetic connection key", "synthetic-legacy-browser-token");
  await daemon.close();
  daemon = await startDaemon({ dataDir, port: 0 });
  try {
    const base = `http://127.0.0.1:${daemon.port}`;
    await page.goto(base);
    await expect(page.getByRole("heading", { name: "工作流", exact: true })).toBeVisible();
    await expect(page.getByLabel("管理员密码")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "退出登录", exact: true })).toHaveCount(0);
    const state = async () => (await (await page.request.get(base + "/api/v1/auth/state")).json()).data;
    expect(await state()).toMatchObject({ initialized: false, credentialMigrationRequired: true });

    await page.getByRole("button", { name: "系统设置", exact: true }).click();
    const setup = page.getByRole("button", { name: "迁移旧版凭据", exact: true });
    await setup.click();
    const dialog = page.getByRole("dialog", { name: "迁移旧版凭据", exact: true });
    const input = dialog.getByLabel("旧版凭据口令", { exact: true });
    await input.fill("incorrect-synthetic-password");
    const confirm = dialog.getByRole("button", { name: "确认", exact: true });
    await confirm.click();
    await expect(dialog.getByRole("alert")).toContainText("旧版凭据口令不正确");
    await input.fill(password);
    // A second page can replace the shared cookie while this page holds the old CSRF token.
    await page.context().clearCookies();
    const opened = await page.request.post(base + "/api/v1/auth/local-session", {
      headers: { Origin: base, "X-FlowHub-Local": "1" },
      data: {},
    });
    expect(opened.ok()).toBe(true);
    await confirm.click();
    await expect(page.getByRole("alert")).toContainText("本机连接已恢复，请重试刚才的操作");
    expect((await state()).credentialMigrationRequired).toBe(true);
    await expect(input).toHaveValue(password);
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect(setup).toHaveCount(0);
    expect(await state()).toMatchObject({ credentialMigrationRequired: false, vaultLocked: false });

    const port = daemon.port;
    await daemon.close();
    daemon = await startDaemon({ dataDir, port });
    await page.context().clearCookies();
    await page.reload();
    await expect(page.getByRole("heading", { name: "系统设置", exact: true })).toBeVisible();
    await expect(setup).toHaveCount(0);
    expect(daemon.engine.vault.secret(saved.id)).toBe("synthetic-legacy-browser-token");
  } finally {
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
