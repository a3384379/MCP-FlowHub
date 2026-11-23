import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
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

test("automatic incident run has no approval controls and a restricted host completes the Web-started chain", async ({
  page,
}) => {
  const api = await admin(page);
  if ((await api("/auth/state")).vaultLocked)
    await api("/credentials/migrate", "POST", { password });
  const source = (await api("/workflows/incident-staging/versions"))[0];
  const workflow = structuredClone(source.snapshot.workflow);
  workflow.workflowId = "ui-automatic-" + randomUUID();
  workflow.name = "自动执行回归";
  const record = await api("/workflows", "POST", { workflow });
  await api("/workflows/" + record.id + "/publish", "POST", {
    expectedRevision: record.revision,
    expectedBindingRevisions: await bindingRevisions(api, workflow),
  });
  const identity = await api("/clients", "POST", {
    label: "UI Codex",
    workflowAllowlist: [record.id],
  });
  await page.goto("/workflows/" + record.id + "/editor");
  await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await expect(
    page.getByRole("button", { name: "人工审批", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "工作流", exact: true }).click();
  const card = page
    .locator("article")
    .filter({
      has: page.getByRole("heading", { name: workflow.name, exact: true }),
    });
  await card.getByRole("button", { name: "启动", exact: true }).click();
  await page.getByLabel("继续执行的宿主身份").selectOption(identity.id);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: /plan · 宿主待办/ }),
  ).toBeVisible();
  const runId = new URL(page.url()).pathname.split("/").at(-1)!;
  const host = new Client(
    { name: "ui-synthetic-codex", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const token = await readFile(
    process.env.FLOWHUB_UI_DATA_DIR + "/" + identity.tokenFile,
    "utf8",
  );
  await host.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1:18479/mcp"), {
      requestInit: {
        headers: { Authorization: "Bearer " + token },
        redirect: "error",
      },
    }),
  );
  async function status() {
    const response = await host.callTool({
      name: "workflow_status",
      arguments: { runId },
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    return response.structuredContent as any;
  }
  async function checkpoint(node: string) {
    let state: any;
    await expect
      .poll(async () => {
        state = await status();
        return state.checkpoint?.nodeId;
      })
      .toBe(node);
    return state;
  }
  async function submit(state: any, payload: any, fallback = false) {
    const response = await host.callTool({
      name: "workflow_advance",
      arguments: {
        runId,
        checkpointId: state.checkpoint.id,
        checkpointToken: state.checkpoint.token,
        expectedRevision: state.revision,
        idempotencyKey: randomUUID(),
        submission: fallback
          ? { type: "host_skill_unavailable", useDeclaredFallback: true }
          : { type: "agent_result", payload },
      },
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
  }
  try {
    let state = await checkpoint("plan");
    await submit(state, {
      queryNeeded: true,
      orderNo: workflow.inputSchema.examples[0].orderNo,
      reason: "合成完整链路",
      evidenceRefs: [state.artifacts[0].id],
    });
    state = await checkpoint("synthesize");
    expect(state.steps.db).toBe("SUCCEEDED");
    const refs = state.artifacts.map((a: any) => a.id);
    await submit(state, {
      summary:
        "中文业务 dev@example.com 13900000001 password=example token=ordinary",
      findings: [
        { statement: "合成证据", kind: "hypothesis", evidenceRefs: refs },
      ],
      nextActions: ["复查"],
      evidenceRefs: refs,
    });
    state = await checkpoint("report");
    await submit(state, {}, true);
    await expect.poll(async () => (await status()).state).toBe("SUCCEEDED");
    await page.reload();
    await expect(page.getByText("已完成", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /批准|拒绝/ })).toHaveCount(
      0,
    );
    await expect(page.getByText("调用参数", { exact: true })).toHaveCount(2);
    await expect(page.locator(".artifact")).toHaveCount(4);
    const completed = await status();
    for (const [mimeType, extension] of [["text/markdown", "md"], ["text/html", "html"]]) {
      const artifact = completed.artifacts.find((entry: { mimeType: string }) => entry.mimeType === mimeType);
      const artifactPath = "/runs/" + runId + "/artifacts/" + artifact.id;
      const row = page.locator(".artifact").filter({ hasText: artifact.id });
      await row.getByRole("button", { name: "查看", exact: true }).click();
      const doc = page.frameLocator('iframe[title="报告内容"]');
      await expect(doc.getByRole("heading", { name: "问题摘要" })).toBeVisible();
      await doc.getByRole("navigation", { name: "报告目录" }).getByRole("link", { name: "证据索引" }).click();
      await expect(doc.locator("h2:target")).toHaveText("证据索引");
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        row.getByRole("button", { name: extension === "md" ? "下载 MD" : "下载", exact: true }).click(),
      ]);
      expect(download.suggestedFilename()).toBe("flowhub-" + artifact.id + "." + extension);
      expect(await download.failure()).toBeNull();
      const bytes = await readFile((await download.path())!);
      expect(bytes.length).toBe(artifact.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
      const served = await page.request.get("/api/v1" + artifactPath + "/download");
      expect(served.headers()["content-type"]).toBe("application/octet-stream");
      expect(served.headers()["cache-control"]).toBe("no-store");
      expect(await served.body()).toEqual(bytes);
      const [readable] = extension === "html" ? [download] : await Promise.all([
        page.waitForEvent("download"),
        row.getByRole("button", { name: "下载 HTML", exact: true }).click(),
      ]);
      const path = test.info().outputPath("report-from-" + extension + ".html");
      await readable.saveAs(path);
      const offline = await page.context().browser()!.newContext({ offline: true });
      try {
        const saved = await offline.newPage();
        await saved.goto(pathToFileURL(path).href);
        await expect(saved.getByRole("heading", { name: "问题摘要" })).toBeVisible();
        await expect(saved.locator("main")).toHaveCSS("background-color", "rgb(255, 255, 255)");
        await saved.getByRole("navigation", { name: "报告目录" }).getByRole("link", { name: "证据索引" }).click();
        await expect(saved.locator("h2:target")).toHaveText("证据索引");
      } finally {
        await offline.close();
      }
    }
    await page.screenshot({
      path: "artifacts/ui-automatic-run.png",
      fullPage: true,
    });
  } finally {
    await host.close();
  }
});

test("run details distinguish failure and cancellation without obsolete action buttons", async ({
  page,
}) => {
  const api = await admin(page);
  if ((await api("/auth/state")).vaultLocked)
    await api("/credentials/migrate", "POST", { password });
  const source = (await api("/workflows/incident-staging/versions"))[0].snapshot
    .workflow;
  const failed = structuredClone(source);
  failed.workflowId = "ui-failure-" + randomUUID();
  failed.name = "预算失败合成用例";
  failed.mode = "auto";
  failed.bindings = {};
  failed.budgets.maxNodeExecutions = 1;
  failed.nodes = failed.nodes.filter((node: any) =>
    ["input", "end"].includes(node.id),
  );
  failed.nodes.find((node: any) => node.id === "end").config.resultRef = {
    ref: { source: "input", pointer: "" },
  };
  failed.edges = [{ source: "input", target: "end", port: "next" }];
  const draft = await api("/workflows", "POST", { workflow: failed });
  await api("/workflows/" + draft.id + "/publish", "POST", {
    expectedRevision: draft.revision,
    expectedBindingRevisions: {},
  });
  const run = await api("/runs", "POST", {
    workflowId: draft.id,
    version: failed.version,
    mode: "auto",
    inputs: source.inputSchema.examples[0],
    idempotencyKey: randomUUID(),
  });
  await expect
    .poll(async () => (await api("/runs/" + run.runId)).state)
    .toBe("FAILED");
  await page.goto("/runs/" + run.runId);
  await expect(page.locator(".run-summary")).toContainText("失败");
  await expect(page.locator(".run-summary")).toContainText("BUDGET_EXCEEDED");
  const cancelled = await api("/runs", "POST", {
    workflowId: source.workflowId,
    version: source.version,
    mode: source.mode,
    inputs: source.inputSchema.examples[0],
    idempotencyKey: randomUUID(),
  });
  let state: any;
  await expect
    .poll(async () => {
      state = await api("/runs/" + cancelled.runId);
      return state.state;
    })
    .toBe("WAITING_AGENT");
  await api("/runs/" + cancelled.runId + "/cancel", "POST", {
    expectedRevision: state.revision,
    reason: "合成浏览器取消用例",
    idempotencyKey: randomUUID(),
  });
  await page.goto("/runs/" + cancelled.runId);
  await expect(page.locator(".run-summary")).toContainText("已取消");
  await expect(page.getByRole("button", { name: /批准|拒绝/ })).toHaveCount(0);
});
