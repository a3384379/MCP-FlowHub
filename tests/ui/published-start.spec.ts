import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const password = "Synthetic-browser-password-041";

async function admin(page: Page) {
  const state = await page.request.get("/api/v1/auth/state");
  const initialized = (await state.json()).data.initialized;
  const response = await page.request.post(
    "/api/v1/auth/" + (initialized ? "session" : "bootstrap"),
    {
      data: initialized
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
  expect(response.ok(), await response.text()).toBe(true);
  const csrf = (await response.json()).data.csrf;
  return async (
    path: string,
    method = "GET",
    data?: unknown,
    revision?: number,
  ) => {
    const result = await page.request.fetch("/api/v1" + path, {
      method,
      headers: {
        "X-CSRF-Token": csrf,
        ...(revision === undefined ? {} : { "If-Match": String(revision) }),
      },
      ...(data === undefined ? {} : { data }),
    });
    expect(result.ok(), await result.text()).toBe(true);
    return (await result.json()).data;
  };
}

async function bindingRevisions(
  api: Awaited<ReturnType<typeof admin>>,
  workflow: { bindings: Record<string, string> },
) {
  const references = new Set(Object.values(workflow.bindings));
  return Object.fromEntries(
    (await api("/bindings"))
      .filter((binding: { id: string }) => references.has(binding.id))
      .map((binding: { id: string; revision: number }) => [
        binding.id,
        binding.revision,
      ]),
  );
}

test("unpublished environment, mode and input changes cannot alter a published start", async ({
  page,
}) => {
  const api = await admin(page);
  if ((await api("/auth/state")).vaultLocked)
    await api("/credentials/migrate", "POST", { password });
  expect((await api("/auth/state")).vaultLocked).toBe(false);
  const source = (await api("/workflows/incident-production/versions"))[0];
  const workflow = structuredClone(source.snapshot.workflow);
  workflow.workflowId = "ui-published-" + randomUUID();
  workflow.name = "已发布生产合成流程";
  const record = await api("/workflows", "POST", { workflow });
  const published = await api("/workflows/" + record.id + "/publish", "POST", {
    expectedRevision: record.revision,
    expectedBindingRevisions: await bindingRevisions(api, workflow),
  });
  const current = await api("/workflows/" + record.id + "/draft");
  const changed = structuredClone(workflow);
  changed.version = "1.0.1";
  changed.name = "未发布试运行草稿";
  changed.environment = "staging";
  changed.mode = "auto";
  changed.inputSchema = {
    type: "object",
    properties: { draftOnly: { type: "string" } },
    required: ["draftOnly"],
    additionalProperties: false,
    examples: [{ draftOnly: "UNPUBLISHED" }],
  };
  await api(
    "/workflows/" + record.id + "/draft",
    "PUT",
    {
      workflow: changed,
      layout: {},
    },
    current.revision,
  );

  await page.goto("/workflows");
  const card = page.locator("article").filter({ hasText: changed.name });
  await card.getByRole("button", { name: "启动", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "启动工作流" });
  await expect(dialog).toContainText("production · v1.0.0");
  await expect(dialog).toContainText(workflow.name);
  await expect(dialog).toContainText("执行模式：guided");
  await expect(dialog).toContainText(published.publishedAt);
  await expect(dialog).toContainText(published.contentHash);
  await expect(dialog.getByLabel("业务输入")).toHaveValue(
    JSON.stringify(workflow.inputSchema.examples[0], null, 2),
  );
  await dialog.getByText("已发布输入契约", { exact: true }).click();
  await expect(dialog.locator("details pre")).toHaveText(
    JSON.stringify(workflow.inputSchema, null, 2),
  );
  const request = page.waitForRequest(
    (r) =>
      r.method() === "POST" && new URL(r.url()).pathname === "/api/v1/runs",
  );
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  const submitted = (await request).postDataJSON();
  expect(submitted).toMatchObject({
    workflowId: workflow.workflowId,
    version: "1.0.0",
    mode: "guided",
    inputs: workflow.inputSchema.examples[0],
  });
  await expect(page).toHaveURL(/\/runs\/run_/);
  const runId = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect
    .poll(async () => (await api("/runs/" + runId)).state)
    .toBe("WAITING_AGENT");
  const run = await api("/runs/" + runId);
  expect(run).toMatchObject({ environment: "production", version: "1.0.0" });
});

test("rollback preview and submission stay bound to the selected immutable version", async ({
  page,
}) => {
  const api = await admin(page);
  if ((await api("/auth/state")).vaultLocked)
    await api("/credentials/migrate", "POST", { password });
  expect((await api("/auth/state")).vaultLocked).toBe(false);
  const source = (await api("/workflows/incident-production/versions"))[0];
  const workflow = structuredClone(source.snapshot.workflow);
  workflow.workflowId = "ui-rollback-" + randomUUID();
  workflow.name = "回滚生产合成流程";
  const record = await api("/workflows", "POST", { workflow });
  const first = await api("/workflows/" + record.id + "/publish", "POST", {
    expectedRevision: record.revision,
    expectedBindingRevisions: await bindingRevisions(api, workflow),
  });
  const current = await api("/workflows/" + record.id + "/draft");
  const staging = structuredClone(
    (await api("/workflows/incident-staging/versions"))[0].snapshot.workflow,
  );
  staging.workflowId = record.id;
  staging.name = "新版试运行合成流程";
  staging.version = "2.0.0";
  staging.mode = "auto";
  staging.nodes = staging.nodes.filter((node: { id: string }) =>
    ["input", "log", "end"].includes(node.id),
  );
  staging.nodes.find((node: { id: string }) => node.id === "end").config = {
    resultRef: { ref: { source: "input", pointer: "" } },
  };
  staging.edges = [
    { source: "input", target: "log", port: "next" },
    { source: "log", target: "end", port: "next" },
  ];
  staging.inputSchema.examples[0].question = "新版试运行示例";
  const saved = await api(
    "/workflows/" + record.id + "/draft",
    "PUT",
    { workflow: staging, layout: {} },
    current.revision,
  );
  await api("/workflows/" + record.id + "/publish", "POST", {
    expectedRevision: saved.revision,
    expectedBindingRevisions: await bindingRevisions(api, staging),
  });

  await page.goto("/workflows");
  const card = page.locator("article").filter({ hasText: staging.name });
  await card.getByRole("button", { name: "版本", exact: true }).click();
  const versions = page.getByRole("dialog").locator(".artifact");
  const oldVersion = versions.filter({
    has: page.getByText("v1.0.0", { exact: true }),
  });
  await oldVersion
    .getByRole("button", { name: "设为默认", exact: true })
    .click();
  await expect(card).toContainText("默认发布 v1.0.0");
  await card.getByRole("button", { name: "启动", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "启动工作流" });
  await expect(dialog).toContainText("production · v1.0.0");
  await expect(dialog).toContainText("执行模式：guided");
  await expect(dialog).toContainText(workflow.name);
  await expect(dialog).toContainText(first.contentHash);
  await expect(dialog.getByLabel("业务输入")).toHaveValue(
    JSON.stringify(workflow.inputSchema.examples[0], null, 2),
  );

  // A concurrent default-pointer change must not change a preview already confirmed by the user.
  await api("/workflows/" + record.id + "/select-version", "POST", {
    version: "2.0.0",
  });
  const request = page.waitForRequest(
    (r) =>
      r.method() === "POST" && new URL(r.url()).pathname === "/api/v1/runs",
  );
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  expect((await request).postDataJSON()).toMatchObject({
    version: "1.0.0",
    mode: "guided",
    inputs: workflow.inputSchema.examples[0],
  });
  await expect(page).toHaveURL(/\/runs\/run_/);
  const runId = new URL(page.url()).pathname.split("/").at(-1)!;
  const run = await api("/runs/" + runId);
  expect(run).toMatchObject({ environment: "production", version: "1.0.0" });
});

test("missing immutable default fails closed without opening a draft-based preview", async ({
  page,
}) => {
  await admin(page);
  await page.route(
    "**/api/v1/workflows/incident-production/versions",
    (route) => route.fulfill({ json: { data: [] } }),
  );
  let starts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v1/runs"
    )
      starts++;
  });
  await page.goto("/workflows");
  const card = page
    .locator("article")
    .filter({ hasText: "生产问题排查与报告" });
  await card.getByRole("button", { name: "启动", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("已发布默认版本不可用");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(starts).toBe(0);
});
