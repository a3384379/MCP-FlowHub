import { test, expect, type Page } from "@playwright/test";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  realpath,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

async function setup(page: Page) {
  const dataDir = process.env.FLOWHUB_UI_DATA_DIR!,
    state = (await (await page.request.get("/api/v1/auth/state")).json()).data;
  const password = "Synthetic-browser-password-041",
    auth = await page.request.post(
      "/api/v1/auth/" + (state.initialized ? "session" : "bootstrap"),
      {
        data: state.initialized
          ? { password }
          : {
              password,
              setupToken: await readFile(
                join(dataDir, "admin-setup-token"),
                "utf8",
              ),
            },
      },
    );
  expect(auth.ok(), await auth.text()).toBeTruthy();
  const csrf = (await auth.json()).data.csrf;
  const api = async (path: string, method = "GET", data?: any) => {
    const response = await page.request.fetch(path, {
      method,
      headers: { "X-CSRF-Token": csrf },
      ...(data === undefined ? {} : { data }),
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()).data;
  };
  const root = await realpath(
      await mkdtemp(join(dataDir, "discovery-design-")),
    ),
    home = join(root, "home"),
    cwd = join(root, "project"),
    cli = join(root, "codex.mjs"),
    mcp = join(root, "mcp.mjs");
  await mkdir(home);
  await mkdir(cwd);
  const suffix = randomUUID().slice(0, 6),
    pluginName = "dev-" + suffix,
    serverName = "source-" + suffix,
    skillName = "review-" + suffix;
  await writeFile(
    join(home, "config.toml"),
    `[plugins."${pluginName}@market"]\nenabled = true\n`,
  );
  await writeFile(
    cli,
    `const a=process.argv.slice(2);if(a.includes('--version'))console.log('codex-fixture-discovery');else if(a.includes('--help'))console.log('--json');else{await new Promise(r=>setTimeout(r,150));console.log('[]');}`,
  );
  await writeFile(
    mcp,
    `import {serveStdio} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))};import {createMockServer} from ${JSON.stringify(pathToFileURL(resolve("dist/packages/mock-mcps/src/index.js")).href)};serveStdio(createMockServer,{legacy:'serve'});`,
  );
  const plugin = join(home, "plugins/cache/market", pluginName, "1.0"),
    skill = join(plugin, "skills/review");
  await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
  await mkdir(join(skill, "agents"), { recursive: true });
  await writeFile(
    join(plugin, ".codex-plugin/plugin.json"),
    JSON.stringify({
      name: pluginName,
      description: "Synthetic developer collaboration package.",
      mcpServers: "./.mcp.json",
    }),
  );
  await writeFile(
    join(plugin, ".mcp.json"),
    JSON.stringify({
      mcpServers: { [serverName]: { command: process.execPath, args: [mcp] } },
    }),
  );
  const original = `---\nname: ${skillName}\ndescription: Review source changes and report actionable findings.\n---\nThis synthetic Skill is indexed but must never run during discovery.\n`;
  await writeFile(join(skill, "SKILL.md"), original);
  await writeFile(
    join(skill, "agents/openai.yaml"),
    `dependencies:\n  tools:\n    - type: mcp\n      value: ${serverName}\n`,
  );
  await mkdir(join(home, "skills/report"), { recursive: true });
  await writeFile(
    join(home, "skills/report/SKILL.md"),
    "---\nname: standalone-report\ndescription: Produce a report from provided results.\n---\nIndependent synthetic Skill.",
  );
  const context = await api("/api/v2/host-contexts", "POST", {
    codexHome: home,
    cwd,
    codexPath: cli,
  });
  await page.addInitScript(
    (id) => localStorage.setItem("flowhub.discovery.context", id),
    context.id,
  );
  await page.goto("/discovery");
  await expect(page.locator(".d-scan-status")).toContainText("扫描完成");
  const scan = async () => {
    await page
      .getByRole("button", { name: "同步工具目录", exact: true })
      .click();
    await expect(page.locator(".d-scan-status")).toContainText("正在扫描");
    await expect(page.locator(".d-scan-status")).toContainText("扫描完成");
  };
  const catalog = (kind?: string) =>
    api(
      "/api/v2/discovery/catalog?contextId=" +
        context.id +
        (kind ? "&kind=" + kind : "") +
        "&limit=100",
    );
  const seedChinese = async () => {
    const all = await catalog();
    const entries = all.items.map((e: any) => ({
      entityId: e.id,
      entityKind: e.entityKind,
      expectedSourceRevision: e.revision,
      sourceFingerprint: e.sourceFingerprint,
      expectedPresentationRevision: e.presentation.revision,
      locale: "zh-CN",
      displayName:
        e.entityKind === "plugin"
          ? "研发协作插件"
          : e.entityKind === "mcp_server"
            ? "合成订单服务"
            : e.name === skillName
              ? "代码审查"
              : e.entityKind === "skill"
                ? "独立报告"
                : e.name === "synthetic_order_lookup"
                  ? "读取订单"
                  : "合成工具 " + e.name,
      summary:
        e.entityKind === "mcp_server"
          ? "读取测试订单与状态，提供合成业务工具。"
          : e.entityKind === "plugin"
            ? "打包合成订单 MCP 与代码审查技能。"
            : e.entityKind === "skill"
              ? "整理改动或运行结果，输出可核对的报告。"
              : "按条件读取合成测试数据。",
      useCases: e.entityKind === "skill" ? ["分析一次改动并整理报告"] : [],
      evidenceRefs: [e.evidenceRefs[0]],
    }));
    await api("/api/v2/host-scans", "POST", {
      contextId: context.id,
      action: "submit_descriptions",
      expectedContextRevision: context.revision,
      entries,
      idempotencyKey: randomUUID(),
    });
    await page.reload();
    await expect(page.locator(".d-cap-row").first()).toContainText(
      "合成订单服务",
    );
    return all;
  };
  return {
    api,
    catalog,
    root,
    context,
    serverName,
    skillName,
    skill,
    original,
    scan,
    seedChinese,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("typed discovery uses real catalog, Chinese descriptions and evidenced plugin/Skill relationships", async ({
  page,
}) => {
  const f = await setup(page),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await expect(page.locator(".d-stat").nth(0)).toContainText("1");
    await expect(page.locator(".d-stat").nth(1)).toContainText("2");
    await expect(page.locator(".d-stat").nth(2)).toContainText("1");
    await f.scan();
    await f.seedChinese();
    await page.getByRole("textbox", { name: "搜索名称或用途" }).fill("研发协作插件");
    await expect(page.locator(".d-cap-row")).toHaveCount(1);
    await expect(page.locator(".d-cap-row .d-source")).toContainText("研发协作插件");
    await page
      .getByRole("textbox", { name: "搜索名称或用途" })
      .fill("测试订单");
    await expect(page.locator(".d-cap-row")).toHaveCount(1);
    await page
      .getByRole("textbox", { name: "搜索名称或用途" })
      .fill(f.serverName);
    await expect(page.locator(".d-cap-row")).toHaveCount(1);
    await page
      .getByRole("textbox", { name: "搜索名称或用途" })
      .fill("not-found-anywhere");
    await expect(
      page.getByText("没有匹配的能力，试试其他名称或筛选条件。"),
    ).toBeVisible();
    await page.getByRole("textbox", { name: "搜索名称或用途" }).fill("");
    await expect(page.locator(".d-cap-row")).toHaveCount(1);
    await page.getByRole("button", { name: "中 / EN 中文优先" }).click();
    await expect(page.locator(".d-cap-name")).toHaveText(f.serverName);
    await page.getByRole("button", { name: "中 / EN 原文展示" }).click();
    await page.getByRole("button", { name: "查看合成订单服务详情" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator(".d-tool-card")).not.toHaveCount(0);
    await expect(dialog.locator("pre")).toBeHidden();
    await dialog
      .getByRole("button", { name: "相关 Skills", exact: true })
      .click();
    await expect(dialog.locator(".d-relation")).toContainText("代码审查");
    await expect(dialog.locator(".d-relation")).toContainText("声明依赖");
    await dialog.getByRole("button", { name: "代码审查", exact: true }).click();
    await expect(
      dialog.getByRole("heading", { name: "代码审查", exact: true }),
    ).toBeVisible();
    await expect(dialog.locator(".d-dependency")).toContainText(
      "声明依赖 · 已匹配",
    );
    await expect(dialog.locator(".d-dependency")).toContainText(
      "agents/openai.yaml",
    );
    await expect(dialog.locator(".d-fact-grid")).toContainText("研发协作插件");
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "查看合成订单服务详情" }),
    ).toBeFocused();
    await page.getByRole("tab", { name: /Skills 技能/ }).click();
    await expect(page.locator(".d-cap-row")).toHaveCount(2);
    await page
      .getByRole("combobox", { name: "来源筛选" })
      .selectOption("independent");
    await expect(page.locator(".d-cap-row")).toHaveCount(1);
    await expect(page.locator(".d-cap-row")).toContainText("未声明 MCP 依赖");
    await page.getByRole("tab", { name: /插件与关系/ }).click();
    await expect(page.locator(".d-plugin-card")).toHaveCount(1);
    await expect(page.locator(".d-tree")).toContainText("合成订单服务");
    await expect(page.locator(".d-tree")).toContainText("代码审查");
    expect(await readFile(join(f.skill, "SKILL.md"), "utf8")).toBe(f.original);
    expect(errors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("manual Chinese edits persist, Esc keeps pending input and source updates flag old descriptions", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    await f.scan();
    await f.seedChinese();
    await page.getByRole("tab", { name: /Skills 技能/ }).click();
    await page.getByRole("button", { name: "查看代码审查详情" }).click();
    let dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "编辑中文说明", exact: true })
      .click();
    await dialog
      .getByLabel("中文显示名称", { exact: true })
      .fill("我的审查技能");
    await dialog
      .getByLabel("详细介绍", { exact: true })
      .fill('<img src=x onerror="window.__discoveryXss=1">');
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "查看代码审查详情" }).click();
    dialog = page.getByRole("dialog");
    await expect(
      dialog.getByLabel("中文显示名称", { exact: true }),
    ).toHaveValue("我的审查技能");
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v2/discovery/descriptions") &&
        r.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "保存中文说明", exact: true })
      .click();
    expect((await saved).ok()).toBeTruthy();
    await expect(
      dialog.getByRole("heading", { name: "我的审查技能", exact: true }),
    ).toBeVisible();
    await expect(dialog.locator("img")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as any).__discoveryXss),
    ).toBeUndefined();
    await page.keyboard.press("Escape");
    await page.reload();
    await page.getByRole("tab", { name: /Skills 技能/ }).click();
    await expect(
      page.locator(".d-cap-row").filter({ hasText: "我的审查技能" }),
    ).toHaveCount(1);
    await writeFile(
      join(f.skill, "SKILL.md"),
      f.original.replace("actionable findings", "new version findings"),
    );
    await page.getByRole("button", { name: "重新扫描", exact: true }).click();
    await expect(page.locator(".d-scan-status")).toContainText("扫描完成");
    const row = page.locator(".d-cap-row").filter({ hasText: f.skillName });
    await expect(row).toContainText("中文说明待更新");
    await row.getByRole("button").click();
    await page
      .getByRole("dialog")
      .getByText("查看保留的旧中文说明", { exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText("我的审查技能");
  } finally {
    await f.close();
  }
});

test("MCP detail imports a real discovered tool into a fixed test binding without claiming execution verification", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    await f.scan();
    await f.seedChinese();
    const beforeBindings = (await f.api("/api/v1/bindings")).length;
    await page.getByRole("button", { name: "查看合成订单服务详情" }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .locator(".d-tool-card")
      .filter({ hasText: "读取订单" })
      .getByRole("button", { name: "导入工具", exact: true })
      .click();
    await expect(
      dialog.getByLabel("导入固定环境", { exact: true }),
    ).toHaveValue("test");
    const accepted = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v2/capabilities/") &&
        r.url().endsWith("/import") &&
        r.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "导入连接与绑定", exact: true })
      .click();
    const receipt = (await (await accepted).json()).data;
    await expect(dialog.getByRole("status")).toContainText("资源绑定尚未验证");
    const bindings = await f.api("/api/v1/bindings");
    expect(bindings.length).toBe(beforeBindings + 1);
    const binding = bindings.find((b: any) => b.id === receipt.bindingId);
    expect(binding.validationStatus).toBe("UNVERIFIED");
    const tools = (await f.catalog("mcp_tool")).items;
    expect(
      tools.find((e: any) => e.capabilityId === binding.sourceCapabilityId)
        .importState,
    ).toMatchObject({ verified: false });
    await expect(dialog.getByText("绑定已验证", { exact: true })).toHaveCount(
      0,
    );
  } finally {
    await f.close();
  }
});

test("real discovery layout works on desktop/mobile and exposes a copyable Codex synchronization task", async ({
  page,
}) => {
  const f = await setup(page);
  try {
    await f.scan();
    await f.seedChinese();
    for (const width of [1440, 1366, 390, 320]) {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 960 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.getByRole("button", { name: "查看合成订单服务详情" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.keyboard.press("Escape");
    }
    await page
      .getByRole("button", { name: "中文整理方式", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("textbox")).toContainText(
      "submit_descriptions",
    );
    await expect(dialog.getByRole("textbox")).toContainText(f.context.id);
    await expect(dialog.getByRole("textbox")).toContainText("不执行业务工具");
  } finally {
    await f.close();
  }
});

test("a late catalog search response cannot replace the user's newer Chinese query results", async ({
  page,
}) => {
  const f = await setup(page);
  let release!: () => void;
  let captured!: () => void;
  const delayed = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (captured = r));
  try {
    await f.scan();
    await f.seedChinese();
    await page.getByRole("tab", { name: /Skills 技能/ }).click();
    await expect(page.locator(".d-cap-row")).toHaveCount(2);
    await page.route("**/api/v2/discovery/catalog?*", async (route) => {
      if (
        new URL(route.request().url()).searchParams.get("query") ===
        "missing-delay"
      ) {
        const response = await route.fetch();
        captured();
        await delayed;
        await route.fulfill({ response });
      } else await route.continue();
    });
    await page
      .getByRole("textbox", { name: "搜索名称或用途" })
      .fill("missing-delay");
    await started;
    await page
      .getByRole("textbox", { name: "搜索名称或用途" })
      .fill("独立报告");
    await expect(page.locator(".d-cap-row")).toHaveCount(1);
    await expect(page.locator(".d-cap-row")).toContainText("独立报告");
    const completed = page.waitForResponse(
      (r) => new URL(r.url()).searchParams.get("query") === "missing-delay",
    );
    release();
    await completed;
    await expect(page.locator(".d-cap-row")).toHaveCount(1);
    await expect(page.locator(".d-cap-row")).toContainText("独立报告");
  } finally {
    release?.();
    await f.close();
  }
});
