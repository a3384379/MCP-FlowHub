import type { McpServer, ReadResourceResult } from "@modelcontextprotocol/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION, result, projectRoot } from "../../contracts/src/index.js";

export const SIDEBAR_TOOL = "project_help_search";
export const SIDEBAR_RESOURCE_URI = `ui://flowhub/management-${VERSION}.html`;
const mimeType = "text/html;profile=mcp-app";
const logo = ["assets/logo.svg", "plugins/flowhub/assets/logo.svg"].flatMap(path => {
  try {
    const source = readFileSync(join(projectRoot, path), "base64");
    return [{ src: "data:image/svg+xml;base64," + source, mimeType: "image/svg+xml" }];
  } catch {
    return [];
  }
}).slice(0, 1);
export const sidebarIcons = logo;
export const sidebarToolMetadata = {
  ui: { resourceUri: SIDEBAR_RESOURCE_URI },
  "openai/ui": { entrypoints: [{ type: "global" }] },
};

// The sidebar opens its tool with {}. Existing help searches retain their query.
export function sidebarInputSchema(search: Record<string, unknown>) {
  return {
    ...search,
    required: [],
    anyOf: [{ maxProperties: 0 }, { required: ["query"] }],
  };
}

export function sidebarOpened(ticket: string) {
  return { ...result({ opened: true }), _meta: { "flowhub/launch": ticket } };
}

export function registerSidebarResource(
  server: McpServer,
  readSidebar: () => ReadResourceResult | Promise<ReadResourceResult>,
) {
  server.registerResource("flowhub-management", SIDEBAR_RESOURCE_URI, {
    title: "FlowHub",
    mimeType,
  }, readSidebar);
}

export function renderSidebarResource(origin: string): ReadResourceResult {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("Expected a loopback workspace origin.");
  const text = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>FlowHub</title>
<style>
html,body{margin:0;height:100%;font:14px system-ui;color-scheme:light dark}
body{display:grid;place-items:center}
iframe{position:absolute;inset:0;width:100%;height:100%;border:0;visibility:hidden}
</style>
<p id="status" role="status">正在打开本机 FlowHub…</p>
<iframe title="FlowHub 管理页面" referrerpolicy="no-referrer"
 sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" allow="loopback-network"></iframe>
<script>
const origin = ${JSON.stringify(origin)};
const frame = document.querySelector("iframe");
const status = document.querySelector("#status");
function send(message) { parent.postMessage({jsonrpc:"2.0", ...message}, "*"); }
let opened = false;
let receivedResult = false;
window.addEventListener("message", event => {
  if (event.source === frame.contentWindow && event.origin === origin && event.data?.type === "flowhub:workspace-ready") {
    frame.style.visibility = "visible";
    status.hidden = true;
    return;
  }
  if (event.source !== parent || event.data?.jsonrpc !== "2.0") return;
  const message = event.data;
  if (message.id === 1 && message.result) send({method:"ui/notifications/initialized"});
  if (message.method !== "ui/notifications/tool-result" || opened) return;
  const ticket = message.params?._meta?.["flowhub/launch"];
  if (typeof ticket !== "string" || !/^[a-f0-9]{64}$/.test(ticket)) {
    if (Array.isArray(message.params?.structuredContent?.excerpts)) {
      receivedResult = true;
      status.textContent = "帮助查询已完成，结果见对话。";
    }
    return;
  }
  opened = true;
  frame.src = origin + "/codex/#launch=" + ticket;
});
send({id:1,method:"ui/initialize",params:{
  protocolVersion:"2026-01-26",appInfo:{name:"FlowHub",version:${JSON.stringify(VERSION)}},appCapabilities:{}
}});
setTimeout(() => {
  if (!status.hidden && !receivedResult) status.textContent = "管理页面暂未连接。请确认本机后台已启动。若 Codex 提示允许本机访问，处理后重新打开 FlowHub。";
}, 10000);
</script></html>`;
  return {
    contents: [{
      uri: SIDEBAR_RESOURCE_URI,
      mimeType,
      text,
      _meta: { ui: { csp: { frameDomains: [origin] }, prefersBorder: false } },
    }],
  };
}
