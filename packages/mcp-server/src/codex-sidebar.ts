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
section{max-width:32rem;margin:24px;padding:24px;border:1px solid GrayText;border-radius:12px}
a{display:inline-block;margin:8px 0}
input{width:100%;box-sizing:border-box;padding:8px}
</style>
<p id="status" role="status">正在打开本机 FlowHub…</p>
<section id="fallback" hidden>
  <h1>打开 FlowHub 管理页</h1>
  <p id="failure" role="status"></p>
  <a id="open" href="${origin}/" target="_blank" rel="noopener noreferrer">在浏览器打开完整管理页</a>
  <label>本机地址<input value="${origin}/" readonly></label>
</section>
<iframe title="FlowHub 管理页面" referrerpolicy="no-referrer"
 sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" allow="loopback-network"></iframe>
<script>
const origin = ${JSON.stringify(origin)};
const frame = document.querySelector("iframe");
const status = document.querySelector("#status");
const fallback = document.querySelector("#fallback");
const failure = document.querySelector("#failure");
function send(message) { parent.postMessage({jsonrpc:"2.0", ...message}, "*"); }
let opened = false;
let ready = false;
let receivedResult = false;
let hostOpensLinks = false;
function showFallback(message) {
  if (ready || receivedResult) return;
  failure.textContent = message;
  status.hidden = true;
  fallback.hidden = false;
}
document.addEventListener("securitypolicyviolation", event => {
  if (opened && event.disposition === "enforce" &&
      ["frame-src", "child-src"].includes(event.effectiveDirective) &&
      (event.blockedURI === origin || event.blockedURI.startsWith(origin + "/"))) {
    showFallback("当前 Codex 的内嵌页面规则阻止了本机地址，仍可打开完整管理页。");
  }
});
document.querySelector("#open").addEventListener("click", event => {
  if (!hostOpensLinks) return;
  event.preventDefault();
  send({id:2,method:"ui/open-link",params:{url:origin + "/"}});
});
window.addEventListener("message", event => {
  if (event.source === frame.contentWindow && event.origin === origin && event.data?.type === "flowhub:workspace-ready") {
    ready = true;
    frame.style.visibility = "visible";
    status.hidden = true;
    fallback.hidden = true;
    return;
  }
  if (event.source !== parent || event.data?.jsonrpc !== "2.0") return;
  const message = event.data;
  if (message.id === 1 && message.result) {
    hostOpensLinks = Boolean(message.result.hostCapabilities?.openLinks);
    send({method:"ui/notifications/initialized"});
  }
  if (message.id === 2 && (message.error || message.result?.isError)) {
    failure.textContent = "Codex 未能打开链接。可使用下方本机地址打开完整管理页。";
  }
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
  if (fallback.hidden) showFallback(opened
    ? "内嵌管理页未能加载。可以直接打开本机管理页。"
    : "Codex 未能启动内嵌管理页。可以直接打开本机管理页。");
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
