import { test, expect } from "@playwright/test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("fullscreen Codex resource uses MCP under a network and frame blocking policy", async ({ page }) => {
  const { startDaemon } = await import(pathToFileURL(resolve("dist/apps/daemon/src/index.js")).href);
  const { MODERN_PROTOCOL } = await import(pathToFileURL(resolve("dist/packages/contracts/src/index.js")).href);
  const dataDir = await mkdtemp(join(tmpdir(), "flowhub-codex-sidebar-"));
  const daemon = await startDaemon({ dataDir, port: 0 });
  const client = new Client({ name: "flowhub-sidebar-browser", version: "1" }, {
    versionNegotiation: { mode: { pin: MODERN_PROTOCOL } },
  });
  try {
    const origin = `http://127.0.0.1:${daemon.port}`;
    const bearer = (await readFile(join(dataDir, "execution-token"), "utf8")).trim();
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
      requestInit: { headers: { Authorization: "Bearer " + bearer, "X-FlowHub-Codex-Sidebar": "1" } },
    }));
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(21);
    const entry = tools.find(tool => tool.name === "project_help_search")!;
    expect(entry.title).toBe("FlowHub");
    expect(entry._meta?.["openai/ui"]).toEqual({ entrypoints: [{ type: "global" }] });
    const { resourceUri } = entry._meta!.ui as { resourceUri: string };
    const view = (await client.readResource({ uri: resourceUri })).contents[0]!;
    expect(view.mimeType).toBe("text/html;profile=mcp-app");
    expect(view._meta?.["openai/ui"]).toEqual({ availableDisplayModes: ["fullscreen"] });
    expect(view._meta?.ui).toEqual({ prefersBorder: false });
    const html = "text" in view ? view.text : "";
    expect(html).not.toContain(bearer);
    expect(html).not.toMatch(/<iframe[\s>]/i);
    const fixture = await client.callTool({ name: "workflow_draft_create", arguments: {
      name: "侧栏隔离工作流 <草稿>", workflowId: "sidebar-fixture", environment: "test",
      mode: "auto", template: "blank", idempotencyKey: "sidebar-fixture-setup",
    } });
    expect(fixture.isError).not.toBe(true);
    const launch = await client.callTool({ name: entry.name, arguments: {} });
    expect(launch.structuredContent).toEqual({ opened: true });
    expect(launch._meta?.["flowhub/workflows"]).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ workflowId: "sidebar-fixture" })]),
    });
    expect(JSON.stringify(launch.content)).not.toContain("sidebar-fixture");
    const invalid = await client.callTool({ name: entry.name, arguments: { limit: 1 } });
    expect(invalid.isError).toBe(true);
    const help = await client.callTool({ name: entry.name, arguments: { query: "工作流" } });
    expect(help.structuredContent).toHaveProperty("excerpts");

    // Emulate the host bridge. Every UI tool call reaches the real daemon via MCP.
    const host = "https://flowhub-test.web-sandbox.oaiusercontent.com";
    const calls: { name: string; arguments: Record<string, unknown> }[] = [];
    const pageErrors: string[] = [];
    const browserNetwork: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("request", request => browserNetwork.push(request.url()));
    await page.exposeFunction("flowhubTool", async (params: (typeof calls)[number]) => {
      calls.push(params);
      return client.callTool(params);
    });
    await page.route(host + "/app", route => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><style>iframe{width:100%;height:95vh;border:0}</style>
<iframe src="/resource" title="Codex MCP App"></iframe><output hidden id="opened"></output>
<script>
const frame = document.querySelector("iframe");
function send(message) {
  frame.contentWindow.postMessage({ jsonrpc: "2.0", ...message }, location.origin);
}
addEventListener("message", async event => {
  if (event.source !== frame.contentWindow) return;
  const { id, method, params } = event.data;
  if (method === "ui/initialize") send({
    id, result: {
      protocolVersion: "2026-01-26", hostInfo: { name: "test", version: "1" },
      hostCapabilities: { openLinks: {}, serverTools: {} }, hostContext: { displayMode: "fullscreen" }
    }
  });
  if (method === "ui/notifications/initialized") send({
    method: "ui/notifications/tool-result", params: ${JSON.stringify(launch)}
  });
  if (method === "tools/call") send({ id, result: await window.flowhubTool(params) });
  if (method === "ui/open-link") {
    document.querySelector("#opened").textContent = params.url;
    send({ id, result: {} });
  }
});
</script>`,
    }));
    await page.route(host + "/resource", route => route.fulfill({
      contentType: "text/html",
      headers: { "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'none'; connect-src 'none'" },
      body: html,
    }));
    await page.goto(host + "/app");
    const sidebar = page.frameLocator('iframe[title="Codex MCP App"]');
    await expect(sidebar.getByRole("heading", { name: "工作流库" })).toBeVisible();
    await expect(sidebar.getByRole("button", { name: /生产问题排查/ })).toBeVisible();
    await sidebar.getByLabel("筛选工作流").fill("sidebar-fixture");
    await expect(sidebar.getByRole("button", { name: /生产问题排查/ })).toHaveCount(0);
    await sidebar.getByRole("button", { name: /侧栏隔离工作流/ }).click();
    await expect(sidebar.getByRole("heading", { name: "侧栏隔离工作流 <草稿>" })).toBeVisible();
    await expect(sidebar.getByText("输入 · 输入 → 结束")).toBeVisible();
    await sidebar.getByRole("button", { name: "校验结构" }).click();
    await expect(sidebar.getByText("草稿结构校验通过。")).toBeVisible();
    await sidebar.getByRole("button", { name: "生成用例" }).click();
    await expect(sidebar.getByText(/已生成 \d+ 个用例/)).toBeVisible();
    await sidebar.getByRole("button", { name: "运行 Mock 自测" }).click();
    await expect(sidebar.getByText(/Mock 自测通过/)).toBeVisible();
    const run = calls.find(call => call.name === "workflow_test_run");
    expect(run?.arguments.mode).toBe("mock");
    expect(calls.filter(call => call.name === "workflow_test_run")).toHaveLength(1);
    const status = calls.find(call => call.name === "workflow_test_status")!;
    const report = await client.callTool(status);
    expect(report.structuredContent).toMatchObject({ status: "SUCCEEDED", networkCalls: 0, realSecretReads: 0 });

    await sidebar.getByRole("button", { name: "能力目录" }).click();
    await expect.poll(() => calls.some(call => call.name === "capability_search")).toBe(true);
    await sidebar.getByLabel("能力类型").selectOption("skill");
    await expect.poll(() => calls.some(call => call.name === "capability_search" && call.arguments.kind === "skill")).toBe(true);
    await sidebar.getByRole("button", { name: "工作流", exact: true }).click();
    await sidebar.getByRole("button", { name: "刷新工作流" }).click();
    await expect.poll(() => calls.some(call => call.name === "project_help_search")).toBe(true);
    await sidebar.getByRole("link", { name: /打开完整管理页/ }).click();
    await expect(page.locator("#opened")).toHaveText(origin + "/");
    await expect(sidebar.locator("iframe")).toHaveCount(0);
    expect(browserNetwork).toEqual([host + "/app", host + "/resource"]);
    expect(pageErrors).toEqual([]);
    await page.setViewportSize({ width: 390, height: 850 });
    const dimensions = await sidebar.locator("body").evaluate(body => ({
      content: body.scrollWidth,
      viewport: body.clientWidth,
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  } finally {
    await client.close();
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
