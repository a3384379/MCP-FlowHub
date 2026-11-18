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

export function sidebarOpened(workflows: { items: unknown[]; hasMore: boolean }) {
  return { ...result({ opened: true }), _meta: { "flowhub/workflows": workflows } };
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
  let script = "";
  try {
    script = readFileSync(join(projectRoot, "web-dist/mcp-app/sidebar.js"), "utf8")
      .replace(/<\/script/gi, "<\\/script");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const text = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>FlowHub</title></head>
<body data-workspace="${origin}/" data-version="${VERSION}">
<main><h1>FlowHub</h1><a href="${origin}/" target="_blank" rel="noopener noreferrer">在浏览器打开完整管理页</a></main>
${script ? "<script>" + script + "</script>" : ""}</body></html>`;
  return {
    contents: [{
      uri: SIDEBAR_RESOURCE_URI,
      mimeType,
      text,
      _meta: { ui: { prefersBorder: false }, "openai/ui": { availableDisplayModes: ["fullscreen"] } },
    }],
  };
}
