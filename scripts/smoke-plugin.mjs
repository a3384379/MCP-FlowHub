import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { verifyBundle } from "./verify-release.mjs";

const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await exited;
  } finally {
    clearTimeout(force);
  }
}

async function codexPluginSmoke(codex, bundle, env, toolCount) {
  const run = (args) =>
    exec(codex, args, {
      env,
      cwd: bundle,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
  await run(["plugin", "marketplace", "add", bundle]);
  await run(["plugin", "add", "flowhub@flowhub-local", "--json"]);
  const listed = await run(["plugin", "list"]);
  const configuredMcp = await run([
    "-c",
    "features.remote_plugin=false",
    "mcp",
    "list",
    "--json",
  ]);
  assert.match(listed.stdout, /flowhub/);
  const cached = join(
    env.CODEX_HOME,
    "plugins",
    "cache",
    "flowhub-local",
    "flowhub",
  );
  assert.ok((await readdir(cached)).length > 0);
  // No hand-written mcp_servers entry: discovery must come from the installed plugin.
  const child = spawn(codex, ["app-server", "--stdio"], {
    env: { ...env, RUST_LOG: "codex_core_plugins=warn,codex_core=warn" },
    cwd: bundle,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let hostDiagnostic = "";
  child.stderr.on("data", (bytes) => {
    hostDiagnostic = (hostDiagnostic + bytes.toString("utf8")).slice(-12000);
  });
  const pending = new Map();
  let seq = 0;
  const lines = createInterface({ input: child.stdout });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Codex RPC timeout: " + method));
        }, 20000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      message.error
        ? waiter.reject(new Error(JSON.stringify(message.error)))
        : waiter.resolve(message.result);
    } else if (message.id !== undefined && message.method) {
      child.stdin.write(
        JSON.stringify({
          id: message.id,
          error: {
            code: -32601,
            message: "No interaction during synthetic verification.",
          },
        }) + "\n",
      );
    }
  });
  const rejectPending = () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Codex exited"));
    }
    pending.clear();
  };
  child.on("error", rejectPending);
  child.on("exit", rejectPending);
  let result;
  try {
    const initialized = await rpc("initialize", {
      clientInfo: { name: "flowhub-plugin-smoke", version: "1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(
      JSON.stringify({ method: "initialized", params: {} }) + "\n",
    );
    const started = await rpc("thread/start", {
      cwd: bundle,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const threadId = started.thread.id;
    let entry, inventory;
    for (let attempt = 0; attempt < 50; attempt++) {
      const status = await rpc("mcpServerStatus/list", {
        threadId,
        detail: "toolsAndAuthOnly",
        limit: 100,
      });
      inventory = status.data;
      entry = status.data.find(
        (item) =>
          Object.keys(item.tools ?? {}).length === toolCount &&
          item.name.includes("flowhub"),
      );
      if (entry) break;
      await sleep(100);
    }
    assert.ok(
      entry,
      "Installed plugin must expose the configured FlowHub identity: " +
        JSON.stringify({
          inventory,
          configuredMcp: configuredMcp.stdout,
          listed: listed.stdout,
          config: await readFile(join(env.CODEX_HOME, "config.toml"), "utf8"),
          hostDiagnostic,
        }),
    );
    const skills = await rpc("skills/list", {
      cwds: [bundle],
      forceReload: true,
    });
    const names = skills.data
      .flatMap((item) => item.skills)
      .filter((skill) => skill.name.startsWith("flowhub:"))
      .map((skill) => skill.name)
      .sort();
    assert.deepEqual(
      names,
      [
        "flowhub:flowhub-author",
        "flowhub:flowhub-setup",
        "flowhub:flowhub-test-report",
      ],
      JSON.stringify(
        skills.data.map((item) => ({
          errors: item.errors,
          names: item.skills.map((skill) => skill.name),
        })),
      ),
    );
    const tool = toolCount === 21 ? "workflow_draft_get" : "workflow_search";
    const call = await rpc("mcpServer/tool/call", {
      threadId,
      server: entry.name,
      tool,
      arguments:
        toolCount === 21
          ? { workflowId: "plugin-local-smoke" }
          : { query: "incident" },
    });
    assert.notEqual(call.isError, true, JSON.stringify(call.structuredContent));
    if (toolCount === 21) assert.equal(call.structuredContent.revision, 1);
    result = {
      status: "PASS",
      userAgent: initialized.userAgent ?? null,
      tools: Object.keys(entry.tools).length,
      skills: names,
      actualMcpCall: tool,
      modelTurns: 0,
    };
  } finally {
    lines.close();
    await stop(child);
    rejectPending();
  }
  await run(["plugin", "remove", "flowhub@flowhub-local"]);
  assert.ok(
    JSON.parse(
      await readFile(
        join(env.CODEX_HOME, "flowhub", "connection.json"),
        "utf8",
      ),
    ).dataDir,
  );
  return result;
}

export async function smokePlugin(bundle, codex) {
  await verifyBundle(bundle);
  const root = await mkdtemp(join(tmpdir(), "FlowHub 插件移植 "));
  const home = join(root, "codex"),
    dataDir = join(root, "业务 data");
  const runtime = join(
    bundle,
    "runtime",
    process.platform === "win32" ? "node.exe" : "node",
  );
  const entry = join(bundle, "scripts", "flowhub-plugin.mjs");
  const env = Object.fromEntries(
    ["SystemRoot", "WINDIR", "TEMP", "TMP"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  );
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: root,
    CODEX_HOME: home,
    PATH: join(bundle, "runtime"),
  });
  await mkdir(home);
  await writeFile(
    join(home, "config.toml"),
    "[features]\napps = false\nplugins = true\nremote_plugin = false\n",
  );
  const run = (args) =>
    exec(runtime, [entry, ...args], {
      env,
      cwd: root,
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    });
  const clients = [],
    stages = [];
  let daemon;
  const stage = async (name, action) => {
    const value = await action();
    stages.push({ name, status: "PASS", ...value });
    return value;
  };
  try {
    await stage(
      "configuration outside plugin; MCP never starts daemon",
      async () => {
        await run(["configure", "--data-dir", dataDir]);
        await assert.rejects(run(["mcp"]), (error) =>
          /DAEMON_UNAVAILABLE/.test(error.stderr),
        );
        await assert.rejects(readFile(join(dataDir, "endpoint.json")), {
          code: "ENOENT",
        });
        await assert.rejects(readdir(dataDir), { code: "ENOENT" });
      },
    );
    daemon = spawn(runtime, [entry, "start", "--port", "0"], {
      env,
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    daemon.stderr.resume();
    let endpoint;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (daemon.exitCode !== null)
        throw new Error("Packaged plugin daemon exited: " + daemon.exitCode);
      try {
        endpoint = JSON.parse(
          await readFile(join(dataDir, "endpoint.json"), "utf8"),
        );
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await sleep(50);
    }
    assert.ok(endpoint, "Plugin daemon ready");
    const connect = async (count) => {
      const client = new Client(
        { name: "plugin-package-smoke", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      clients.push(client);
      const wire = new StdioClientTransport({
        command: runtime,
        args: [entry, "mcp"],
        cwd: root,
        env,
        stderr: "pipe",
      });
      wire.stderr?.resume();
      await client.connect(wire, { timeout: 10000 });
      assert.equal((await client.listTools()).tools.length, count);
      return client;
    };
    await stage(
      "personal plugin bridge and doctor expose 21 tools",
      async () => {
        assert.equal(
          JSON.parse((await run(["doctor"])).stdout).tools.length,
          21,
        );
        const client = await connect(21);
        const created = await client.callTool({
          name: "workflow_draft_create",
          arguments: {
            workflowId: "plugin-local-smoke",
            name: "插件隔离草稿",
            environment: "test",
            mode: "auto",
            template: "blank",
            idempotencyKey: "plugin-create",
          },
        });
        assert.notEqual(created.isError, true);
        const got = await client.callTool({
          name: "workflow_draft_get",
          arguments: { workflowId: "plugin-local-smoke" },
        });
        assert.equal(got.structuredContent.revision, 1);
        await client.close();
      },
    );
    if (codex)
      await stage(
        "actual Codex marketplace installation, skills and MCP; uninstall preserves data",
        async () => {
          const result = await codexPluginSmoke(codex, bundle, env, 21);
          assert.equal(
            (await fetch(`http://127.0.0.1:${endpoint.port}/api/v1/health`))
              .status,
            200,
          );
          return result;
        },
      );
    else
      stages.push({
        name: "actual Codex plugin installation",
        status: "UNVERIFIED",
        reason: "Codex executable not supplied to this portable package check",
      });
    await stage(
      "restricted identity preserved; doctor and bridge expose only 7 tools",
      async () => {
        const base = "http://127.0.0.1:" + endpoint.port;
        const bootstrap = await fetch(base + "/api/v1/auth/bootstrap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            setupToken: await readFile(
              join(dataDir, "admin-setup-token"),
              "utf8",
            ),
            password: "Synthetic-plugin-smoke-password",
          }),
        });
        assert.equal(bootstrap.status, 200);
        const csrf = (await bootstrap.json()).data.csrf,
          cookie = bootstrap.headers.get("set-cookie").split(";")[0];
        const response = await fetch(base + "/api/v1/clients", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
            "X-CSRF-Token": csrf,
          },
          body: JSON.stringify({
            label: "Plugin restricted scope",
            workflowAllowlist: ["incident-production"],
          }),
        });
        assert.equal(response.status, 200);
        const tokenFile = (await response.json()).data.absoluteTokenFile;
        await run(["configure", "--token-file", tokenFile]);
        await run(["configure", "--data-dir", dataDir]);
        assert.equal(
          JSON.parse((await run(["doctor"])).stdout).tools.length,
          7,
        );
        const client = await connect(7);
        assert.equal(
          (await client.listTools()).tools.some(
            (tool) => tool.name === "workflow_draft_create",
          ),
          false,
        );
        await client.close();
        if (codex)
          stages.push({
            name: "actual Codex plugin preserves restricted identity",
            ...(await codexPluginSmoke(codex, bundle, env, 7)),
          });
        await writeFile(tokenFile, "0".repeat(64));
        await assert.rejects(run(["doctor"]));
        // An invalid restricted token must never fall back to the personal token.
        const denied = new Client(
          { name: "plugin-invalid-token", version: "1" },
          { versionNegotiation: { mode: { pin: "2026-07-28" } } },
        );
        clients.push(denied);
        const wire = new StdioClientTransport({
          command: runtime,
          args: [entry, "mcp"],
          cwd: root,
          env,
          stderr: "pipe",
        });
        wire.stderr?.resume();
        await assert.rejects(denied.connect(wire, { timeout: 5000 }));
        const references = await readFile(
          join(home, "flowhub", "connection.json"),
          "utf8",
        );
        assert.equal(JSON.parse(references).tokenFile, tokenFile);
        assert.equal(references.includes("0".repeat(64)), false);
      },
    );
    await verifyBundle(bundle);
    return {
      os: process.platform,
      arch: process.arch,
      node: process.versions.node,
      syntheticOnly: true,
      persistentCodexConfigModified: false,
      privateCredentialsCopied: false,
      stages,
    };
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stop(daemon);
    await rm(root, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const { archive, archiveSha256 } = JSON.parse(
    await readFile(join(repo, "artifacts/latest-package.json"), "utf8"),
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(archive))
      .digest("hex"),
    archiveSha256,
  );
  const { locateCodex } = await import(
    "../dist/packages/host-discovery/src/index.js"
  );
  const extracted = await mkdtemp(join(tmpdir(), "FlowHub 插件归档 "));
  try {
    if (process.platform === "win32")
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
            FLOWHUB_EXTRACT_DIR: extracted,
          },
        },
      );
    else await exec("tar", ["-xzf", archive, "-C", extracted]);
    const folders = await readdir(extracted);
    assert.equal(folders.length, 1);
    const result = {
      archiveSha256,
      ...(await smokePlugin(
        join(extracted, folders[0]),
        process.env.FLOWHUB_CODEX_PATH ?? (await locateCodex()),
      )),
    };
    await writeFile(
      join(repo, "artifacts/plugin-smoke.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
}
