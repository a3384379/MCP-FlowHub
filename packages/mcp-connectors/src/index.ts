import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import {
  MODERN_PROTOCOL,
  VERSION,
  SDK_VERSION,
} from "../../contracts/src/index.js";

export type Era = "modern" | "legacy";
export function createClient(era: Era, name = "flowhub-poc-client"): Client {
  return new Client(
    { name, version: VERSION },
    {
      versionNegotiation: {
        mode: era === "modern" ? { pin: MODERN_PROTOCOL } : "legacy",
      },
    },
  );
}

export function mockStdioTransport(entry: string) {
  return new StdioClientTransport({
    command: process.execPath,
    args: [entry, "mock", "--stdio"],
    env: getDefaultEnvironment(),
    stderr: "pipe",
    maxBufferSize: 262144,
  });
}

export function localHttpTransport(url: URL, token: string) {
  // S0 supports local synthetic endpoints only. No redirects or auth fallback.
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "TARGET_DENIED: S0 allows only fixed local synthetic MCP endpoints.",
    );
  }
  return new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
    },
  });
}

export function protocolEvidence(client: Client, transport: string) {
  return {
    sdkVersion: SDK_VERSION,
    protocolVersion: client.getNegotiatedProtocolVersion(),
    era: client.getProtocolEra(),
    transport,
    os: process.platform,
    node: process.version,
    synthetic: true,
  };
}
