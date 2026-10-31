import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createHubServer } from "../../../packages/mcp-server/src/index.js";
import {
  MODERN_PROTOCOL,
  VERSION,
  failure,
  TOOL_NAMES,
  type ToolName,
} from "../../../packages/contracts/src/index.js";
import { readEndpoint } from "../../daemon/src/local-config.js";

/** No persistence/engine imports, no implicit daemon startup. */
export async function startBridge(dataDir: string, tokenFile?: string) {
  const { url, token } = await readEndpoint(dataDir, tokenFile);
  const client = new Client(
    { name: "flowhub-stdio-bridge", version: VERSION },
    {
      versionNegotiation: { mode: { pin: MODERN_PROTOCOL } },
    },
  );
  let advertised:ToolName[]=[];
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
        },
      }),
      { timeout: 5000 },
    );
    const upstream=await client.listTools();
    // The bridge preserves the authenticated daemon's scope and only exposes
    // names from the fixed contract. It does not invent authoring permission.
    advertised=TOOL_NAMES.filter(name=>upstream.tools.some(tool=>tool.name===name));
  } catch {
    await client.close();
    throw new Error(
      "DAEMON_UNAVAILABLE: run flowhub serve first, using the same --data-dir.",
    );
  }
  const handle = serveStdio(
    () =>
      createHubServer(async (name, args) => {
        try {
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
      },advertised),
    {
      legacy: "serve",
      onerror: () =>
        process.stderr.write("MCP_PROTOCOL_ERROR: invalid STDIO exchange.\n"),
    },
  );
  const close = async () => {
    await handle.close();
    await client.close();
  };
  process.stdin.once("end", () => {
    void close();
  });
  return { close };
}
