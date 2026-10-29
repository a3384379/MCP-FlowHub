import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/client";

const { SyntheticReadyStdioTransport, redactSmokeDiagnostic } = await import(
  pathToFileURL(resolve("scripts/synthetic-stdio-smoke.mjs")).href
);
const require = createRequire(import.meta.url);
const sdk = pathToFileURL(require.resolve("@modelcontextprotocol/server")).href;
const stdio = pathToFileURL(
  require.resolve("@modelcontextprotocol/server/stdio"),
).href;

function registerFixtureCleanup(t: TestContext, directory: string) {
  const resources: { client?: Client } = {};
  // Windows cannot remove a directory while it is a live child's cwd. Keep
  // teardown in one hook: a failed earlier hook would skip later hooks.
  t.after(async () => {
    try {
      await resources.client?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  return resources;
}

test(
  "synthetic package smoke separates real child cold-start readiness from the strict modern probe timeout",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "FlowHub cold startup "));
    const resources = registerFixtureCleanup(t, directory);
    const entry = join(directory, "fixture.mjs");
    await writeFile(
      entry,
      `import {McpServer} from ${JSON.stringify(sdk)};import {serveStdio} from ${JSON.stringify(stdio)};export async function main(){await new Promise(r=>setTimeout(r,1500));serveStdio(()=>new McpServer({name:'slow-synthetic-fixture',version:'1'},{capabilities:{}}),{legacy:'serve'});}`,
    );
    const wire = new SyntheticReadyStdioTransport(
      { command: process.execPath, entry, args: [], cwd: directory },
      { startupTimeoutMs: 8000 },
    );
    const client = new Client(
      { name: "package-startup-regression", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    resources.client = client;
    try {
      await client.connect(wire, { timeout: 1000 });
    } catch (error) {
      t.diagnostic(JSON.stringify(wire.diagnostics()));
      throw error;
    }
    assert.equal(client.getProtocolEra(), "modern");
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
    const events = wire.diagnostics().events as Array<{
      event: string;
      elapsedMs: number;
      method?: string;
    }>;
    const ready = events.find((event) => event.event === "READY")!;
    const probe = events.find(
      (event) => event.event === "send" && event.method === "server/discover",
    )!;
    assert.ok(
      ready.elapsedMs >= 1500,
      "The fixture actually takes longer to start than the probe deadline.",
    );
    assert.ok(
      probe.elapsedMs >= ready.elapsedMs,
      "Only SDK start after genuine readiness may start protocol negotiation.",
    );
  },
);

test(
  "synthetic startup failure retains safe stderr and fails before any protocol request",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "FlowHub early exit "));
    const resources = registerFixtureCleanup(t, directory);
    const entry = join(directory, "fixture.mjs");
    const fakeToken = "a".repeat(64);
    await writeFile(
      entry,
      `export async function main(){console.error('token=${fakeToken}');throw new Error('SYNTHETIC_STARTUP_REFUSED');}`,
    );
    const wire = new SyntheticReadyStdioTransport(
      { command: process.execPath, entry, args: [], cwd: directory },
      { startupTimeoutMs: 3000 },
    );
    const client = new Client(
      { name: "package-startup-negative", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    resources.client = client;
    await assert.rejects(
      client.connect(wire, { timeout: 1000 }),
      /SMOKE_STARTUP_EXITED/,
    );
    const diagnostics = wire.diagnostics();
    assert.equal(diagnostics.ready, false);
    assert.ok(
      diagnostics.stderr.some((line: string) =>
        line.includes("SYNTHETIC_STARTUP_REFUSED"),
      ),
      JSON.stringify(diagnostics),
    );
    assert.equal(JSON.stringify(diagnostics).includes(fakeToken), false);
    assert.equal(
      diagnostics.events.some(
        (event: { event: string }) => event.event === "send",
      ),
      false,
    );
    assert.equal(
      redactSmokeDiagnostic("Authorization: Bearer fake-secret"),
      "Authorization: [REDACTED] [REDACTED]",
    );
  },
);

test(
  "synthetic fixture that never becomes ready fails its startup deadline without sending an MCP probe",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "FlowHub never ready "));
    const resources = registerFixtureCleanup(t, directory);
    const entry = join(directory, "fixture.mjs");
    await writeFile(
      entry,
      "export async function main(){setInterval(()=>{},1000);await new Promise(()=>{});}",
    );
    const wire = new SyntheticReadyStdioTransport(
      { command: process.execPath, entry, args: [], cwd: directory },
      { startupTimeoutMs: 4000 },
    );
    const client = new Client(
      { name: "package-never-ready-negative", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    resources.client = client;
    await assert.rejects(
      client.connect(wire, { timeout: 1000 }),
      /SMOKE_STARTUP_TIMEOUT/,
    );
    const diagnostics = wire.diagnostics();
    assert.equal(diagnostics.ready, false);
    assert.ok(
      diagnostics.events.some(
        (event: { event: string }) => event.event === "CLI_IMPORTED",
      ),
      JSON.stringify(diagnostics),
    );
    assert.equal(
      diagnostics.events.some(
        (event: { event: string }) => event.event === "send",
      ),
      false,
    );
  },
);
