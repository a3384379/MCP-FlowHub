#!/usr/bin/env node
import { RELEASE_PHASE } from "../../../packages/contracts/src/index.js";
import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultDataDir, readEndpoint } from "./local-config.js";

export async function inspectMcpConnection(dataDir: string, tokenFile?: string) {
  const { url, token } = await readEndpoint(dataDir, tokenFile);
  const { createClient, localHttpTransport, protocolEvidence } = await import(
    "../../../packages/mcp-connectors/src/index.js"
  );
  const client = createClient("modern", "flowhub-doctor");
  try {
    await client.connect(localHttpTransport(new URL(url), token), { timeout: 5000 });
    const { tools } = await client.listTools();
    return { ...protocolEvidence(client, "http"), tools: tools.map(tool => tool.name), phase: RELEASE_PHASE };
  } finally {
    await client.close();
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      backup: { type: "string" },
      "token-file": { type: "string" },
      port: { type: "string" },
      stdio: { type: "boolean" },
      "codex-sidebar": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(
      "MCP FlowHub\n  flowhub serve [--data-dir PATH] [--port 18473]\n  flowhub mcp --stdio [--data-dir PATH] [--token-file ABSOLUTE_PATH]\n  flowhub doctor [--data-dir PATH] [--token-file ABSOLUTE_PATH]\n  flowhub restore --backup PATH [--data-dir PATH] (daemon must be stopped)\n  flowhub mock --stdio\nConfigure connections and bindings through the independent management UI. Use the token-file reference generated for each restricted host identity; never place the token itself in arguments.",
    );
    return;
  }
  if (positionals.length !== 1)
    throw new Error("CLI_INPUT_INVALID: unexpected positional arguments.");
  const dataDir = resolve(values["data-dir"] ?? defaultDataDir());
  if (command !== "serve" && values.port)
    throw new Error("CLI_INPUT_INVALID: --port is only valid for serve.");
  if (command === "serve") {
    if (values.stdio)
      throw new Error("CLI_INPUT_INVALID: serve does not use --stdio.");
    const rawPort = values.port ?? "18473";
    if (!/^\d+$/.test(rawPort) || Number(rawPort) > 65535)
      throw new Error("CLI_INPUT_INVALID: port must be 0..65535.");
    const { startDaemon } = await import("./index.js");
    const daemon = await startDaemon({ dataDir, port: Number(rawPort) });
    console.error(`FlowHub ready on 127.0.0.1:${daemon.port} (loopback only).`);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void daemon.close().catch(() => {
        console.error("SHUTDOWN_FAILED");
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }
  if (command === "mcp") {
    if (!values.stdio)
      throw new Error("CLI_INPUT_INVALID: use flowhub mcp --stdio.");
    const { startBridge } = await import("../../mcp-bridge/src/index.js");
    const bridge = await startBridge(dataDir, values["token-file"], values["codex-sidebar"]);
    process.once("SIGINT", () => {
      void bridge.close();
    });
    process.once("SIGTERM", () => {
      void bridge.close();
    });
    return;
  }
  if (command === "mock") {
    if (!values.stdio)
      throw new Error("CLI_INPUT_INVALID: use flowhub mock --stdio.");
    const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
    const { createMockServer } = await import(
      "../../../packages/mock-mcps/src/index.js"
    );
    serveStdio(createMockServer, {
      legacy: "serve",
      onerror: () => console.error("MOCK_PROTOCOL_ERROR"),
    });
    return;
  }
  if (command === "restore") {
    if (!values.backup)
      throw new Error(
        "CLI_INPUT_INVALID: restore requires --backup PATH and a stopped daemon.",
      );
    const { restoreBackup } = await import(
      "../../../packages/persistence/src/maintenance.js"
    );
    console.log(JSON.stringify(await restoreBackup(dataDir, values.backup)));
    return;
  }
  if (command === "doctor") {
    console.log(JSON.stringify(await inspectMcpConnection(dataDir, values["token-file"]), null, 2));
    return;
  }
  throw new Error("CLI_INPUT_INVALID: unknown command; use --help.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  main().catch((error) => {
    // Do not print SDK stacks, headers or tokens.
    const message =
      error instanceof Error &&
      /^(DAEMON_|TOKEN_|PORT_|CLI_|RESTORE_)/.test(error.message)
        ? error.message
        : "STARTUP_FAILED: check runtime version, data-directory permissions and the local service.";
    console.error(message);
    process.exitCode = 1;
  });
}
