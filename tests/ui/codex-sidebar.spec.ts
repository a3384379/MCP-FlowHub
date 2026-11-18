import { test, expect } from "@playwright/test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("Codex MCP App launch opens the complete FlowHub workspace and can save a draft", async ({ page }) => {
  const { startDaemon } = await import(pathToFileURL(resolve("dist/apps/daemon/src/index.js")).href);
  const { MODERN_PROTOCOL } = await import(pathToFileURL(resolve("dist/packages/contracts/src/index.js")).href);
  const dataDir = await mkdtemp(join(tmpdir(), "flowhub-codex-sidebar-"));
  const daemon = await startDaemon({ dataDir, port: 0 });
  const client = new Client({ name: "flowhub-sidebar-browser", version: "1" }, {
    versionNegotiation: { mode: { pin: MODERN_PROTOCOL } },
  });
  try {
    const origin = `http://127.0.0.1:${daemon.port}`;
    const bearer = await readFile(join(dataDir, "execution-token"), "utf8");
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", origin), {
      requestInit: { headers: { Authorization: "Bearer " + bearer.trim(), "X-FlowHub-Codex-Sidebar": "1" } },
    }));
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(21);
    const entry = tools.find(tool => tool.name === "project_help_search")!;
    expect(entry.title).toBe("FlowHub");
    expect(entry._meta?.["openai/ui"]).toEqual({ entrypoints: [{ type: "global" }] });
    const { resourceUri } = entry._meta!.ui as { resourceUri: string };
    const view = (await client.readResource({ uri: resourceUri })).contents[0]!;
    expect(view.mimeType).toBe("text/html;profile=mcp-app");
    expect(view._meta?.ui).toMatchObject({ csp: { frameDomains: [origin] } });
    const launch = await client.callTool({ name: entry.name, arguments: {} });
    expect(launch.structuredContent).toEqual({ opened: true });
    const ticket = launch._meta?.["flowhub/launch"];
    expect(ticket).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(launch.content)).not.toContain(ticket);
    const invalid = await client.callTool({ name: entry.name, arguments: { limit: 1 } });
    expect(invalid.isError).toBe(true);

    // Serve the actual resource to a browser under an isolated MCP host origin.
    // Only the host handshake is simulated, all workspace requests reach the daemon.
    const host = "https://flowhub-test.web-sandbox.oaiusercontent.com";
    const devtools = await page.context().newCDPSession(page);
    const { targetInfo } = await devtools.send("Target.getTargetInfo");
    try {
      await devtools.send("Browser.setPermission", {
        permission: { name: "loopback-network" }, setting: "granted", origin: host,
        ...(targetInfo.browserContextId ? { browserContextId: targetInfo.browserContextId } : {}),
      });
    } catch (error) {
      if (!/unknown permission/i.test(String(error))) throw error;
    }
    await page.route(host + "/app", route => route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><style>iframe{width:100vw;height:100vh;border:0}</style>
<iframe src="/resource" title="Codex MCP App"></iframe>
<script>
const frame = document.querySelector("iframe");
addEventListener("message", event => {
  if (event.source !== frame.contentWindow) return;
  if (event.data.method === "ui/initialize") frame.contentWindow.postMessage({
    jsonrpc:"2.0",id:event.data.id,result:{protocolVersion:"2026-01-26",hostInfo:{name:"test",version:"1"},hostCapabilities:{},hostContext:{}}
  }, location.origin);
  if (event.data.method === "ui/notifications/initialized") frame.contentWindow.postMessage({
    jsonrpc:"2.0",method:"ui/notifications/tool-result",params:${JSON.stringify(launch)}
  }, location.origin);
});
</script>`,
    }));
    await page.route(host + "/resource", route => route.fulfill({
      contentType: "text/html",
      headers: { "Content-Security-Policy": `frame-src ${origin}` },
      body: String("text" in view ? view.text : ""),
    }));
    await page.goto(host + "/app");
    const workspace = page.frameLocator('iframe[title="Codex MCP App"]')
      .frameLocator('iframe[title="FlowHub 管理页面"]');
    await expect(workspace.getByRole("heading", { name: "工作流", exact: true })).toBeVisible();
    await workspace.getByRole("button", { name: "打开编排", exact: true }).first().click();
    await expect(workspace.locator(".react-flow__node").first()).toBeVisible();
    await workspace.locator(".react-flow__node").first().click();
    await workspace.getByLabel("节点名称", { exact: true }).fill("Codex 侧栏已编辑");
    await workspace.getByRole("button", { name: "运行记录", exact: true }).click();
    await workspace.getByRole("dialog", { name: "草稿有未保存修改，是否离开？" }).getByRole("button", { name: "取消" }).click();
    await expect(workspace.getByLabel("节点名称", { exact: true })).toHaveValue("Codex 侧栏已编辑");
    await workspace.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(workspace.getByRole("status")).toContainText("草稿");
    await workspace.getByRole("button", { name: "系统设置", exact: true }).click();
    await expect(workspace.getByRole("heading", { name: "系统设置", exact: true })).toBeVisible();
    await workspace.getByRole("button", { name: "工作流", exact: true }).click();
    await workspace.getByRole("button", { name: "打开编排", exact: true }).first().click();
    await expect(workspace.getByText("Codex 侧栏已编辑", { exact: true })).toBeVisible();

    const headers = { Origin: origin, "X-FlowHub-Local": "1" };
    const tokenReuse = await page.request.post(origin + "/api/v1/auth/codex-session", { headers, data: { ticket } });
    expect(tokenReuse.status()).toBe(401);
    const noTicket = await page.request.post(origin + "/api/v1/auth/codex-session", { headers, data: {} });
    expect(noTicket.ok()).toBe(false);
    const embedded = await page.request.get(origin + "/codex/");
    expect(embedded.headers()["content-security-policy"]).toMatch(/frame-ancestors codex-sandbox:/);
    const standard = await page.request.get(origin + "/");
    expect(standard.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  } finally {
    await client.close();
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
