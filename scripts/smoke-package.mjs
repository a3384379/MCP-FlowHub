import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { verifyBundle } from "./verify-release.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { archive, archiveSha256 } = JSON.parse(
  await readFile(join(root, "artifacts/latest-package.json"), "utf8"),
);
assert.equal(
  createHash("sha256")
    .update(await readFile(archive))
    .digest("hex"),
  archiveSha256,
);
const dir = await mkdtemp(join(tmpdir(), "FlowHub 离线 package "));
const clients = [];
let child;
let stderr = "";
try {
  const exec = promisify(execFile);
  if (process.platform === "win32") {
    await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath $env:FLOWHUB_ARCHIVE_PATH -DestinationPath $env:FLOWHUB_EXTRACT_DIR",
      ],
      {
        env: {
          ...process.env,
          FLOWHUB_ARCHIVE_PATH: archive,
          FLOWHUB_EXTRACT_DIR: dir,
        },
      },
    );
  } else await exec("tar", ["-xzf", archive, "-C", dir]);
  const folders = await readdir(dir);
  assert.equal(folders.length, 1);
  const bundle = join(dir, folders[0]);
  await verifyBundle(bundle);
  const runtime = join(
    bundle,
    "runtime",
    process.platform === "win32" ? "node.exe" : "node",
  );
  const entry = join(bundle, "dist/apps/daemon/src/cli.js");
  const dataDir = join(dir, "用户 data");
  // No npm, external Node or network credentials in the spawned application's PATH/env.
  const env = Object.fromEntries(
    [
      "SystemRoot",
      "WINDIR",
      "TEMP",
      "TMP",
      "HOME",
      "USERPROFILE",
      "LOCALAPPDATA",
    ].flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])),
  );
  env.PATH = join(bundle, "runtime");
  child = spawn(
    runtime,
    [entry, "serve", "--port", "0", "--data-dir", dataDir],
    { cwd: dir, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  );
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  let endpoint;
  const deadline = Date.now() + 12000;
  while (!endpoint && Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Packaged daemon exited ${child.exitCode}: ${stderr}`);
    try {
      endpoint = JSON.parse(
        await readFile(join(dataDir, "endpoint.json"), "utf8"),
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  assert.ok(endpoint, `Packaged daemon did not become ready: ${stderr}`);
  const health = await fetch(`http://127.0.0.1:${endpoint.port}/api/v1/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).phase, "RC");
  const page = await fetch(`http://127.0.0.1:${endpoint.port}/`);
  assert.match(await page.text(), /assets\/index-/);
  const html = await (
    await fetch("http://127.0.0.1:" + endpoint.port + "/")
  ).text();
  const script = html.match(/src="([^"]+\.js)"/)[1];
  assert.equal(
    (await fetch("http://127.0.0.1:" + endpoint.port + script)).status,
    200,
  );
  for (const mode of [{ pin: "2026-07-28" }, "legacy"]) {
    const client = new Client(
      { name: "independent-package-smoke", version: "1" },
      { versionNegotiation: { mode } },
    );
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: runtime,
        args: [entry, "mcp", "--stdio", "--data-dir", dataDir],
        cwd: dir,
        env,
        stderr: "pipe",
      }),
      { timeout: 5000 },
    );
    const { tools } = await client.listTools();
    assert.equal(tools.length, 7);
    const response = await client.callTool({
      name: "workflow_get",
      arguments: { workflowId: "incident-production" },
    });
    assert.equal(response.structuredContent.instanceId, endpoint.instanceId);
    assert.equal(response.structuredContent.demoOnly, true);
    console.log(
      `Offline archive smoke PASS: ${client.getProtocolEra()} ${client.getNegotiatedProtocolVersion()} × stdio, ${process.platform}, synthetic only.`,
    );
    await client.close();
    const mock = new Client(
      { name: "independent-package-mock-check", version: "1" },
      { versionNegotiation: { mode } },
    );
    clients.push(mock);
    await mock.connect(
      new StdioClientTransport({
        command: runtime,
        args: [entry, "mock", "--stdio"],
        cwd: dir,
        env,
        stderr: "pipe",
      }),
      { timeout: 5000 },
    );
    const mockResult = await mock.callTool({
      name: "synthetic_order_lookup",
      arguments: { orderNo: "DEMO-1001" },
    });
    assert.equal(
      mockResult.structuredContent.sentinel,
      "FLOWHUB_S0_TEST_ONLY_041",
    );
    assert.equal(mockResult.structuredContent.synthetic, true);
    await mock.close();
  }
  // Integrity negative control: deliberate tamper is detected on this disposable copy.
  const { appendFile } = await import("node:fs/promises");
  await appendFile(join(bundle, "README.md"), "\nTAMPER TEST\n");
  await assert.rejects(verifyBundle(bundle), /Hash mismatch: README.md/);
  console.log(
    "Tampered package rejected; no external npm/node used by packaged application.",
  );
} finally {
  await Promise.allSettled(clients.map((c) => c.close()));
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(force);
  }
  await rm(dir, { recursive: true, force: true });
}
