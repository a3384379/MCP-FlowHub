import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/server";
import { startDaemon } from "../../apps/daemon/src/index.js";
import { createLocalHttp } from "../../apps/daemon/src/http.js";
import {
  type Json,
  type Workflow,
} from "../../packages/contracts/src/domain.js";
import { assertSafePattern } from "../../packages/contracts/src/schema-safety.js";

type Cleanup = () => unknown | Promise<unknown>;
async function verifySchemaSafety(cleanups: Cleanup[]) {
  for (const pattern of [
    "^DEMO-[A-Z0-9-]+$",
    "^demo-",
    "^ORDER-[0-9]{4}-[A-Z]{2}$",
    "^[a-z0-9._-]{1,64}$",
  ])
    assertSafePattern(pattern);
  const attacks = [
    "^(a|aa)+$",
    "^(a+)+$",
    "a*a*a*a*a*a*a*a*a*a*b",
    "^a+a+$",
    "a+b",
    "a{4096}b",
    "^a{1,64}a{1,64}b$",
    "^(?=a)a$",
    "^([a-z])\\1$",
  ];
  const dataDir = await mkdtemp(join(tmpdir(), "flowhub-schema-safety-"));
  const daemon = await startDaemon({ dataDir, port: 0 }),
    engine = daemon.engine;
  cleanups.push(async () => {
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  for (const pattern of attacks) {
    const w = structuredClone(
      engine.repo.get("workflows", "incident-staging").draft,
    ) as Workflow;
    w.inputSchema.properties.question.pattern = pattern;
    assert.throws(
      () => engine.validateDraft(w),
      { code: "SCHEMA_INVALID" },
      pattern,
    );
    delete w.inputSchema.properties.question.pattern;
    w.nodes.find(
      (n) => n.id === "plan",
    )!.config.outputSchema.properties.reason.pattern = pattern;
    assert.throws(
      () => engine.validateDraft(w),
      { code: "SCHEMA_INVALID" },
      "Agent: " + pattern,
    );
  }
  let unsafeInput: Json = {
    type: "object",
    properties: {
      environment: { const: "staging" },
      needle: { type: "string", pattern: attacks[0] },
    },
  };
  let unsafeOutput: Json = { type: "object" };
  const token = "9".repeat(64),
    server = createLocalHttp(() => {
      const s = new McpServer(
        { name: "unsafe-schema-local-fixture", version: "1" },
        { capabilities: { tools: {} } },
      );
      // Advertise untrusted raw schemas without registering an executable tool
      // validator in the fixture itself.
      s.server.setRequestHandler("tools/list", async () => ({
        tools: [
          {
            name: "unsafe",
            inputSchema: unsafeInput,
            outputSchema: unsafeOutput,
          },
        ],
      }));
      return s;
    }, token);
  await server.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => server.close());
  const secret = engine.vault.addSecret(
    "Unsafe schema local fixture token",
    token,
  );
  const candidate = {
    id: "unsafe-discovery",
    name: "Local unsafe schema",
    transport: "streamable_http",
    revision: 1,
    disabled: false,
    protocolEra: "modern",
    endpoint:
      "http://127.0.0.1:" +
      (server.server.address() as { port: number }).port +
      "/mcp",
    allowedHosts: ["127.0.0.1"],
    secretRef: secret.id,
  };
  for (const location of [
    "input",
    "output",
    "patternProperties",
    "propertyNames",
  ]) {
    unsafeInput = { type: "object" };
    unsafeOutput = { type: "object" };
    if (location === "input")
      unsafeInput.properties = {
        needle: { type: "string", pattern: attacks[0] },
      };
    if (location === "output")
      unsafeOutput.properties = {
        needle: { type: "string", pattern: attacks[0] },
      };
    if (location === "patternProperties")
      unsafeInput.patternProperties = { [attacks[0]!]: { type: "string" } };
    if (location === "propertyNames")
      unsafeInput.propertyNames = { type: "string", pattern: attacks[0] };
    await assert.rejects(
      engine.connectors.discover(candidate),
      { code: "SCHEMA_INVALID" },
      location,
    );
    assert.equal(engine.repo.get("connections", candidate.id), undefined);
  }
}

if (process.argv.includes("--schema-safety-worker")) {
  const cleanups: Cleanup[] = [];
  try {
    await verifySchemaSafety(cleanups);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
} else
  test("schema regex subset rejects dangerous workflow, Agent and discovered schemas before evaluation", async () => {
    // The entire adversarial workflow and raw-SDK fixture run under an OS-level
    // hard limit, including cleanup of the worker process group on POSIX.
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "--schema-safety-worker"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
        killSignal: "SIGKILL",
        detached: process.platform !== "win32",
      },
    );
    let diagnostic = "";
    child.stderr.on("data", (bytes) => {
      diagnostic += bytes.toString();
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", resolve);
      });
      assert.equal(
        code,
        0,
        diagnostic || "Schema safety worker exceeded its hard deadline",
      );
    } finally {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      } else child.kill("SIGKILL");
    }
  });
