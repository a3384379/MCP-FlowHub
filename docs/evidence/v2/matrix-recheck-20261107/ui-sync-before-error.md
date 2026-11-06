# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: v2-discovery-design.spec.ts >> issue actions open the matching manual connection and credential forms and complete real directory sync
- Location: tests/ui/v2-discovery-design.spec.ts:285:1

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('.connection-grid .panel').filter({ has: getByRole('heading', { name: 'manual-c19a07', exact: true }) })
Expected substring: "已验证协议"
Received string:    "⌘待验证manual-c19a07stdio · modern0 工具revision 1检测与同步历史摘要编辑禁用"
Timeout: 5000ms

Call log:
  - Expect "toContainText" locator('.connection-grid .panel').filter({ has: getByRole('heading', { name: 'manual-c19a07', exact: true }) }) with timeout 5000ms
  - waiting for locator('.connection-grid .panel').filter({ has: getByRole('heading', { name: 'manual-c19a07', exact: true }) })
    13 × locator resolved to <section class="panel">…</section>
       - unexpected value "⌘待验证manual-c19a07stdio · modern0 工具revision 1检测与同步历史摘要编辑禁用"

```

```yaml
- text: ⌘ 待验证
- heading "manual-c19a07" [level=2]
- paragraph: stdio · modern
- text: 0 工具
- code: revision 1
- button "检测与同步"
- button "历史摘要"
- button "编辑"
- button "禁用"
```

# Test source

```ts
  228 |     await page
  229 |       .getByRole("textbox", { name: "搜索名称或用途" })
  230 |       .fill(f.serverName);
  231 |     await expect(page.locator(".d-cap-row")).toHaveCount(1);
  232 |     await page
  233 |       .getByRole("textbox", { name: "搜索名称或用途" })
  234 |       .fill("not-found-anywhere");
  235 |     await expect(
  236 |       page.getByText("没有匹配的能力，试试其他名称或筛选条件。"),
  237 |     ).toBeVisible();
  238 |     await page.getByRole("textbox", { name: "搜索名称或用途" }).fill("");
  239 |     await expect(page.locator(".d-cap-row")).toHaveCount(1);
  240 |     await page.getByRole("button", { name: "中 / EN 中文优先" }).click();
  241 |     await expect(page.locator(".d-cap-name")).toHaveText(f.serverName);
  242 |     await page.getByRole("button", { name: "中 / EN 原文展示" }).click();
  243 |     await page.getByRole("button", { name: "查看合成订单服务详情" }).click();
  244 |     const dialog = page.getByRole("dialog");
  245 |     await expect(dialog.locator(".d-tool-card")).not.toHaveCount(0);
  246 |     await expect(dialog.locator("pre")).toBeHidden();
  247 |     await dialog
  248 |       .getByRole("button", { name: "相关 Skills", exact: true })
  249 |       .click();
  250 |     await expect(dialog.locator(".d-relation")).toContainText("代码审查");
  251 |     await expect(dialog.locator(".d-relation")).toContainText("声明依赖");
  252 |     await dialog.getByRole("button", { name: "代码审查", exact: true }).click();
  253 |     await expect(
  254 |       dialog.getByRole("heading", { name: "代码审查", exact: true }),
  255 |     ).toBeVisible();
  256 |     await expect(dialog.locator(".d-dependency")).toContainText(
  257 |       "声明依赖 · 已匹配",
  258 |     );
  259 |     await expect(dialog.locator(".d-dependency")).toContainText(
  260 |       "agents/openai.yaml",
  261 |     );
  262 |     await expect(dialog.locator(".d-fact-grid")).toContainText("研发协作插件");
  263 |     await page.keyboard.press("Escape");
  264 |     await expect(
  265 |       page.getByRole("button", { name: "查看合成订单服务详情" }),
  266 |     ).toBeFocused();
  267 |     await page.getByRole("tab", { name: /Skills 技能/ }).click();
  268 |     await expect(page.locator(".d-cap-row")).toHaveCount(2);
  269 |     await page
  270 |       .getByRole("combobox", { name: "来源筛选" })
  271 |       .selectOption("independent");
  272 |     await expect(page.locator(".d-cap-row")).toHaveCount(1);
  273 |     await expect(page.locator(".d-cap-row")).toContainText("未声明 MCP 依赖");
  274 |     await page.getByRole("tab", { name: /插件与关系/ }).click();
  275 |     await expect(page.locator(".d-plugin-card")).toHaveCount(1);
  276 |     await expect(page.locator(".d-tree")).toContainText("合成订单服务");
  277 |     await expect(page.locator(".d-tree")).toContainText("代码审查");
  278 |     expect(await readFile(join(f.skill, "SKILL.md"), "utf8")).toBe(f.original);
  279 |     expect(errors).toEqual([]);
  280 |   } finally {
  281 |     await f.close();
  282 |   }
  283 | });
  284 | 
  285 | test("issue actions open the matching manual connection and credential forms and complete real directory sync", async ({
  286 |   page,
  287 | }) => {
  288 |   const f = await setup(page);
  289 |   try {
  290 |     const issue = await f.addIssues(),
  291 |       original = await readFile(issue.path, "utf8");
  292 |     const row = (name: string) =>
  293 |       page
  294 |         .locator(".d-issue")
  295 |         .filter({ has: page.getByRole("heading", { name, exact: true }) });
  296 |     await row(issue.manual)
  297 |       .getByRole("button", { name: "手动连接", exact: true })
  298 |       .click();
  299 |     await expect(page).toHaveURL(/\/connections$/);
  300 |     const dialog = page.getByRole("dialog");
  301 |     await expect(dialog.getByLabel("连接名称", { exact: true })).toHaveValue(
  302 |       issue.manual,
  303 |     );
  304 |     await expect(dialog.getByLabel("传输方式", { exact: true })).toHaveValue(
  305 |       "",
  306 |     );
  307 |     await dialog.getByLabel("传输方式", { exact: true }).selectOption("stdio");
  308 |     await dialog
  309 |       .getByLabel("绝对可执行文件路径", { exact: true })
  310 |       .fill(process.execPath);
  311 |     await dialog
  312 |       .getByRole("button", { name: "添加命令参数", exact: true })
  313 |       .click();
  314 |     await dialog.getByLabel("命令参数 1", { exact: true }).fill(issue.mcp);
  315 |     await dialog
  316 |       .getByRole("checkbox", {
  317 |         name: "我已核对程序和每项参数，获准启动该本机程序",
  318 |       })
  319 |       .check();
  320 |     await dialog.getByRole("button", { name: "确认", exact: true }).click();
  321 |     await expect(dialog).toHaveCount(0);
  322 |     const card = page
  323 |       .locator(".connection-grid .panel")
  324 |       .filter({
  325 |         has: page.getByRole("heading", { name: issue.manual, exact: true }),
  326 |       });
  327 |     await card.getByRole("button", { name: "检测与同步", exact: true }).click();
> 328 |     await expect(card).toContainText("已验证协议");
      |                        ^ Error: expect(locator).toContainText(expected) failed
  329 |     expect(
  330 |       (await f.api("/api/v1/connections")).find(
  331 |         (c: any) => c.name === issue.manual,
  332 |       ).tools.length,
  333 |     ).toBeGreaterThan(0);
  334 |     const profile = await f.api("/api/v2/model-profiles", "POST", { name: "model-only-" + issue.credential, providerKind: "openai_compatible_chat", baseUrl: "https://synthetic.invalid/v1", model: "synthetic", apiKey: "MODEL_ONLY_SYNTHETIC_KEY", stream: false });
  335 |     await f.api("/api/v1/vault/lock", "POST", {});
  336 |     await page.goto("/discovery");
  337 |     await page.getByRole("tab", { name: /需处理/ }).click();
  338 |     await row(issue.credential).getByRole("button", { name: "连接配置", exact: true }).click();
  339 |     const setup = page.getByRole("dialog");
  340 |     await expect(setup.getByRole("heading", { name: "连接配置", exact: true })).toBeVisible();
  341 |     await setup.getByLabel("凭据库口令", { exact: true }).fill("Synthetic-browser-password-041");
  342 |     await setup.getByRole("button", { name: "解锁凭据库", exact: true }).click();
  343 |     await expect(setup.getByText("本地库已解锁，填写内容已保留。", { exact: true })).toBeVisible();
  344 |     await expect(setup.getByLabel("SYNTHETIC_AUTH", { exact: true }).locator("option[value='" + profile.secretRef + "']")).toHaveCount(0);
  345 |     await setup.getByLabel("SYNTHETIC_AUTH", { exact: true }).selectOption("");
  346 |     await setup.getByRole("button", { name: "新增并用于此项", exact: true }).click();
  347 |     await expect(page).toHaveURL(/\/discovery$/);
  348 |     await setup.getByLabel("配置类型 · SYNTHETIC_AUTH", { exact: true }).selectOption("credential");
  349 |     await setup.getByLabel("值 · SYNTHETIC_AUTH", { exact: true }).fill("SYNTHETIC_SECRET_DO_NOT_DISPLAY");
  350 |     await setup.getByRole("button", { name: "保存并检测连接", exact: true }).click();
  351 |     await expect(setup.getByText(/本服务连接及目录检测通过/)).toBeVisible();
  352 |     const secret = (await f.api("/api/v1/secrets")).find((s: any) => s.sourceId && s.variable === "SYNTHETIC_AUTH");
  353 |     expect(secret.purpose).toBe("mcp_auth");
  354 |     await expect(setup.getByLabel("SYNTHETIC_AUTH", { exact: true })).toHaveValue(secret.id);
  355 |     expect((await f.api("/api/v1/secrets")).filter((s: any) => s.variable === "SYNTHETIC_AUTH")).toHaveLength(1);
  356 |     await expect(setup.getByLabel("值 · SYNTHETIC_AUTH", { exact: true })).toHaveCount(0);
  357 |     expect(await page.locator("body").innerText()).not.toContain("SYNTHETIC_SECRET_DO_NOT_DISPLAY");
  358 |     await page.keyboard.press("Escape");
  359 |     await page
  360 |       .getByRole("button", { name: "同步工具目录", exact: true })
  361 |       .first()
  362 |       .click();
  363 |     await expect
  364 |       .poll(
  365 |         async () =>
  366 |           (await f.catalog("mcp_server")).items.find(
  367 |             (e: any) => e.name === issue.credential,
  368 |           )?.availability,
  369 |       )
  370 |       .toBe("ready");
  371 |     await expect(row(issue.credential)).toHaveCount(0);
  372 |     expect(await readFile(issue.path, "utf8")).toBe(original);
  373 |     expect(await page.locator("body").innerText()).not.toContain(
  374 |       "SYNTHETIC_SECRET_DO_NOT_DISPLAY",
  375 |     );
  376 |   } finally {
  377 |     await f.close();
  378 |   }
  379 | });
  380 | 
  381 | test("issue guides expose real source settings, empty search and mobile actions; legacy assistant opens the floating chat", async ({
  382 |   page,
  383 | }) => {
  384 |   const f = await setup(page);
  385 |   try {
  386 |     const issues = await f.addIssues();
  387 |     await page.setViewportSize({ width: 320, height: 844 });
  388 |     await page
  389 |       .getByRole("textbox", { name: "搜索名称或用途" })
  390 |       .fill(issues.manual);
  391 |     const row = page.locator(".d-issue");
  392 |     await expect(row).toHaveCount(1);
  393 |     await row.getByRole("button", { name: "处理说明", exact: true }).click();
  394 |     await expect(page.getByRole("dialog")).toContainText(issues.path);
  395 |     await page
  396 |       .getByRole("dialog")
  397 |       .getByRole("button", { name: "检查发现设置", exact: true })
  398 |       .click();
  399 |     await expect(page.locator("#discovery-settings")).toHaveAttribute(
  400 |       "open",
  401 |       "",
  402 |     );
  403 |     await expect(page.locator("#discovery-settings summary")).toBeFocused();
  404 |     expect(
  405 |       await page.evaluate(
  406 |         () => document.documentElement.scrollWidth <= innerWidth,
  407 |       ),
  408 |     ).toBe(true);
  409 |     await page
  410 |       .getByRole("textbox", { name: "搜索名称或用途" })
  411 |       .fill("no-such-issue");
  412 |     await expect(
  413 |       page.getByText("没有匹配的问题，试试其他名称或诊断代码。", {
  414 |         exact: true,
  415 |       }),
  416 |     ).toBeVisible();
  417 |     await page.goto("/assistant");
  418 |     await expect(page).toHaveURL(/\/workflows$/);
  419 |     await expect(
  420 |       page.getByRole("button", { name: "AI 工作台", exact: true }),
  421 |     ).toHaveCount(0);
  422 |     await expect(page.locator(".assistant-workbench")).toHaveCount(0);
  423 |     await expect(
  424 |       page.getByRole("region", { name: "FlowHub 助手聊天窗口", exact: true }),
  425 |     ).toBeVisible();
  426 |     const session = await page
  427 |       .getByRole("region", { name: "FlowHub 助手聊天窗口" })
  428 |       .getAttribute("data-session-id");
```