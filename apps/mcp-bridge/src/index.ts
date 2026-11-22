import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createHubServer } from "../../../packages/mcp-server/src/index.js";
import { SIDEBAR_RESOURCE_URI, SIDEBAR_TOOL } from "../../../packages/mcp-server/src/codex-sidebar.js";
import {
  MODERN_PROTOCOL,
  VERSION,
  failure,
  TOOL_NAMES,
  type ToolName,
} from "../../../packages/contracts/src/index.js";
import { readEndpoint } from "../../daemon/src/local-config.js";

export type SidebarLifecycle = {
  generation: string;
  prepareSidebar: () => Promise<string>;
};

async function connect(dataDir: string, tokenFile: string | undefined, requestSidebar: boolean) {
  const { url, token } = await readEndpoint(dataDir, tokenFile);
  const client = new Client(
    { name: "flowhub-stdio-bridge", version: VERSION },
    {
      versionNegotiation: { mode: { pin: MODERN_PROTOCOL } },
    },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${token}`,
            ...(requestSidebar ? { "X-FlowHub-Codex-Sidebar": "1" } : {}),
          },
          redirect: "error",
        },
      }),
      { timeout: 5000 },
    );
    return { client, tools: (await client.listTools()).tools };
  } catch {
    await client.close();
    throw new Error(
      "DAEMON_UNAVAILABLE: run flowhub serve first, using the same --data-dir.",
    );
  }
}

/** The optional Codex launcher supplies the lifecycle. This bridge only connects and forwards. */
export async function startBridge(
  dataDir: string, tokenFile?: string, codexSidebar = false, lifecycle?: SidebarLifecycle,
) {
  const requestSidebar = codexSidebar && !tokenFile;
  const upstream = await connect(dataDir, tokenFile, requestSidebar);
  let client = upstream.client;
  let generation = lifecycle?.generation;
  let refreshing: Promise<void> | undefined;
  const refreshSidebar = () => {
    if (!lifecycle) return;
    return refreshing ??= (async () => {
      const current = await lifecycle.prepareSidebar();
      if (current === generation) return;
      const previous = client;
      client = (await connect(dataDir, tokenFile, requestSidebar)).client;
      generation = current;
      await previous.close().catch(() => {});
    })().finally(() => { refreshing = undefined; });
  };

  // Preserve the authenticated daemon's scope and expose only fixed tools.
  const advertised: ToolName[] = TOOL_NAMES.filter(name => upstream.tools.some(tool => tool.name === name));
  const sidebar = upstream.tools.find(tool => tool.name === SIDEBAR_TOOL);
  const ui = sidebar?._meta?.ui as { resourceUri?: string } | undefined;
  const sidebarAvailable = requestSidebar && ui?.resourceUri === SIDEBAR_RESOURCE_URI;
  const handle = serveStdio(
    () =>
      createHubServer(async (name, args) => {
        try {
          if (sidebarAvailable && name === SIDEBAR_TOOL && Object.keys(args).length === 0)
            await refreshSidebar();
          return (await client.callTool(
            { name, arguments: args },
            { timeout: 10000 },
          )) as CallToolResult;
        } catch {
          return failure(
            "DAEMON_UNAVAILABLE",
            "The daemon request failed. Verify daemon health before retrying.",
          );
        }
      }, advertised, sidebarAvailable ? {
        readSidebar: async () => {
          await refreshSidebar();
          return client.readResource({ uri: SIDEBAR_RESOURCE_URI }, { timeout: 5000 });
        },
      } : {}),
    {
      legacy: "serve",
      onerror: () =>
        process.stderr.write("MCP_PROTOCOL_ERROR: invalid STDIO exchange.\n"),
    },
  );
  const close = async () => {
    await handle.close();
    await refreshing?.catch(() => {});
    await client.close();
  };
  process.stdin.once("end", () => {
    void close();
  });
  return { close };
}
