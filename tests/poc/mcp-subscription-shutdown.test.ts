import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { startDaemon } from "../../apps/daemon/src/index.js";
import { readEndpoint } from "../../apps/daemon/src/local-config.js";
import {
  createClient,
  localHttpTransport,
} from "../../packages/mcp-connectors/src/index.js";
import type { Json } from "../../packages/contracts/src/domain.js";

async function within<T>(promise: Promise<T>, milliseconds = 5000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("MCP subscription prevented shutdown")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("official MCP subscriptions end gracefully on daemon.close while modern and legacy tool calls remain functional", async (t) => {
  const dataDir = await mkdtemp(
    join(tmpdir(), "flowhub-mcp-subscription-close-"),
  );
  const daemon = await startDaemon({ dataDir, port: 0 });
  const modern = createClient("modern"),
    legacy = createClient("legacy");
  t.after(async () => {
    await Promise.allSettled([modern.close(), legacy.close()]);
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const { url, token } = await readEndpoint(dataDir);
  await Promise.all([
    modern.connect(localHttpTransport(new URL(url), token), { timeout: 5000 }),
    legacy.connect(localHttpTransport(new URL(url), token), { timeout: 5000 }),
  ]);
  const subscription = await modern.listen(
    { toolsListChanged: true },
    { timeout: 5000 },
  );
  assert.equal(subscription.honoredFilter.toolsListChanged, true);
  for (const client of [modern, legacy]) {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 21);
    const search = await client.callTool({
      name: "workflow_search",
      arguments: { query: "排查", environment: "staging" },
    });
    assert.notEqual(search.isError, true);
    assert.equal(
      (search.structuredContent as Json).items[0].workflowId,
      "incident-staging",
    );
  }
  const [, reason] = await within(
    Promise.all([daemon.close(), subscription.closed]),
  );
  assert.equal(reason, "graceful");
  await assert.rejects(access(join(dataDir, "endpoint.json")));
  await assert.rejects(access(join(dataDir, "daemon.lock")));
});

test(
  "CLI SIGTERM closes an acknowledged official MCP subscription without client abort",
  {
    skip:
      process.platform === "win32"
        ? "Windows native signal delivery is verified separately."
        : false,
  },
  async (t) => {
    const dataDir = await mkdtemp(
      join(tmpdir(), "flowhub-mcp-subscription-signal-"),
    );
    const child = spawn(
      process.execPath,
      [
        resolve("dist/apps/daemon/src/cli.js"),
        "serve",
        "--data-dir",
        dataDir,
        "--port",
        "0",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const client = createClient("modern");
    let stderr = "";
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    t.after(async () => {
      await client.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      await rm(dataDir, { recursive: true, force: true });
    });
    for (let attempt = 0; attempt < 600; attempt++) {
      assert.equal(child.exitCode, null, stderr);
      try {
        await readFile(join(dataDir, "endpoint.json"));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise((ready) => setTimeout(ready, 25));
    }
    const { url, token } = await readEndpoint(dataDir);
    await client.connect(localHttpTransport(new URL(url), token), {
      timeout: 5000,
    });
    const subscription = await client.listen(
      { toolsListChanged: true },
      { timeout: 5000 },
    );
    assert.equal(subscription.honoredFilter.toolsListChanged, true);
    const exited = once(child, "exit");
    assert.equal(child.kill("SIGTERM"), true);
    const [[code, signal], reason] = await within(
      Promise.all([exited, subscription.closed]),
    );
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
    assert.equal(reason, "graceful");
    await assert.rejects(access(join(dataDir, "endpoint.json")));
    await assert.rejects(access(join(dataDir, "daemon.lock")));
  },
);
