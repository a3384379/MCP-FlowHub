import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { verifyBundle } from "./verify-release.mjs";
import {
  SyntheticReadyStdioTransport,
  redactSmokeDiagnostic,
} from "./synthetic-stdio-smoke.mjs";

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
const processDiagnostics = [];
const diagnostics = {
  syntheticOnly: true,
  os: process.platform,
  arch: process.arch,
  node: process.versions.node,
  startedAt: new Date().toISOString(),
  completed: false,
  stages: [],
};
async function stage(label, action) {
  const began = performance.now();
  const record = { label, ok: false, durationMs: 0 };
  diagnostics.stages.push(record);
  console.log(JSON.stringify({ packageSmokeStage: label, event: "start" }));
  try {
    const result = await action();
    record.ok = true;
    return result;
  } catch (error) {
    record.error = redactSmokeDiagnostic(error.message ?? error);
    record.errorCode = redactSmokeDiagnostic(error.code ?? error.name);
    throw error;
  } finally {
    record.durationMs = Math.round(performance.now() - began);
    console.log(
      JSON.stringify({
        packageSmokeStage: label,
        event: record.ok ? "pass" : "fail",
        durationMs: record.durationMs,
      }),
    );
  }
}
function observeBaseTransport(wire, role, era) {
  const record = {
    role,
    era,
    sdkDisposableProbeStderr: "Not exposed by SDK base transport",
    stderr: "",
    events: [],
  };
  wire.stderr?.on("data", (bytes) => {
    record.stderr = redactSmokeDiagnostic(
      record.stderr + bytes.toString("utf8"),
    ).slice(-16_384);
  });
  wire.onerror = (error) =>
    record.events.push({
      event: "error",
      code: redactSmokeDiagnostic(error.code ?? error.name),
    });
  wire.onclose = () => record.events.push({ event: "closed" });
  processDiagnostics.push(() => ({ ...record, pid: wire.pid }));
}
let child;
let stderr = "";
try {
  const exec = promisify(execFile);
  await stage("archive extraction", async () => {
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
  });
  const folders = await readdir(dir);
  assert.equal(folders.length, 1);
  const bundle = join(dir, folders[0]);
  await stage("extracted bundle integrity", () => verifyBundle(bundle));
  await stage("new assistant module tamper is rejected", async()=>{
    const file=join(bundle,"dist/packages/assistant-core/src/index.js"),original=await readFile(file);
    try{await writeFile(file,Buffer.concat([original,Buffer.from("\n// synthetic corruption\n")]));await assert.rejects(verifyBundle(bundle),/Hash mismatch/);}
    finally{await writeFile(file,original);}
    await verifyBundle(bundle);
  });
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
  let endpoint;
  await stage("packaged daemon startup", async () => {
    child = spawn(
      runtime,
      [entry, "serve", "--port", "0", "--data-dir", dataDir],
      { cwd: dir, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    child.stderr.on("data", (data) => {
      stderr = redactSmokeDiagnostic(stderr + data.toString("utf8")).slice(
        -16_384,
      );
    });
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
  });
  await stage("packaged daemon health and web assets", async () => {
    const health = await fetch(
      `http://127.0.0.1:${endpoint.port}/api/v1/health`,
    );
    assert.equal(health.status, 200);
    assert.equal((await health.json()).phase, "ALPHA");
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
  });
  let legacyTokenFile;
  await stage("packaged legacy execution identity",async()=>{
    const base="http://127.0.0.1:"+endpoint.port;
    const initialized=await fetch(base+"/api/v1/auth/bootstrap",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({setupToken:await readFile(join(dataDir,"admin-setup-token"),"utf8"),password:"Synthetic-offline-smoke-password"})});
    assert.equal(initialized.status,200);const csrf=(await initialized.json()).data.csrf,cookie=initialized.headers.get("set-cookie").split(";")[0];
    const response=await fetch(base+"/api/v1/clients",{method:"POST",headers:{"Content-Type":"application/json",Cookie:cookie,"X-CSRF-Token":csrf},body:JSON.stringify({label:"Offline legacy scope",workflowAllowlist:["incident-production"]})});
    assert.equal(response.status,200);legacyTokenFile=(await response.json()).data.absoluteTokenFile;
  });
  for (const mode of [{ pin: "2026-07-28" }, "legacy"]) {
    const era = typeof mode === "string" ? mode : "modern";
    const client = new Client(
      { name: "independent-package-smoke", version: "1" },
      { versionNegotiation: { mode } },
    );
    clients.push(client);
    // Preserve the ordinary user-facing CLI/STDIO gate, including the SDK's
    // normal disposable probe behavior. Only the synthetic Mock below is instrumented.
    const hubWire = new StdioClientTransport({
      command: runtime,
      args: [entry, "mcp", "--stdio", "--data-dir", dataDir],
      cwd: dir,
      env,
      stderr: "pipe",
    });
    observeBaseTransport(hubWire, "Hub bridge ordinary CLI", era);
    await stage(`${era} Hub bridge connect`, () =>
      client.connect(hubWire, { timeout: 5000 }),
    );
    await stage(`${era} Hub bridge 21 tools and persisted authoring`, async () => {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 21);
      const created=await client.callTool({name:"workflow_draft_create",arguments:{workflowId:"package-"+era,name:"Offline packaged authoring",environment:"test",mode:"auto",template:"blank",idempotencyKey:"package-create-"+era}});
      assert.notEqual(created.isError,true);
      const draft=await client.callTool({name:"workflow_draft_get",arguments:{workflowId:"package-"+era}});
      assert.equal(draft.structuredContent.revision,1);
      const help=await client.callTool({name:"project_help_search",arguments:{query:"试运行数据库绑定",limit:3}});
      assert.ok(help.structuredContent.citations.some(c=>c.sourcePath.endsWith("V2_USER_GUIDE.md")));
      const response = await client.callTool({
        name: "workflow_get",
        arguments: { workflowId: "incident-production" },
      });
      assert.equal(response.structuredContent.instanceId, endpoint.instanceId);
      assert.equal(response.structuredContent.demoOnly, true);
    });
    console.log(
      `Offline archive smoke PASS: ${client.getProtocolEra()} ${client.getNegotiatedProtocolVersion()} × stdio, ${process.platform}, synthetic only.`,
    );
    await stage(`${era} Hub bridge close`, () => client.close());
    await stage(`${era} old execution identity retains seven tools`,async()=>{
      const restricted=new Client({name:"packaged-legacy-scope",version:"1"},{versionNegotiation:{mode}});clients.push(restricted);
      await restricted.connect(new StdioClientTransport({command:runtime,args:[entry,"mcp","--stdio","--data-dir",dataDir,"--token-file",legacyTokenFile],cwd:dir,env,stderr:"pipe"}),{timeout:5000});
      assert.equal((await restricted.listTools()).tools.length,7);const existing=await restricted.callTool({name:"workflow_get",arguments:{workflowId:"incident-production"}});assert.notEqual(existing.isError,true);await restricted.close();
    });
    const mock = new Client(
      { name: "independent-package-mock-check", version: "1" },
      { versionNegotiation: { mode } },
    );
    clients.push(mock);
    const mockWire = new SyntheticReadyStdioTransport(
      {
        command: runtime,
        entry,
        args: ["mock", "--stdio"],
        cwd: dir,
        env,
      },
      {
        startupTimeoutMs: 12_000,
        onDiagnostic: (record) =>
          console.log(JSON.stringify({ syntheticMockStartup: era, ...record })),
      },
    );
    processDiagnostics.push(() => ({
      role: "synthetic Mock CLI instrumentation",
      era,
      ...mockWire.diagnostics(),
    }));
    await stage(`${era} synthetic Mock startup and connect`, () =>
      mock.connect(mockWire, { timeout: 5000 }),
    );
    assert.equal(mock.getProtocolEra(), era);
    if (era === "modern")
      assert.equal(mock.getNegotiatedProtocolVersion(), "2026-07-28");
    await stage(`${era} synthetic Mock validated lookup`, async () => {
      const mockResult = await mock.callTool({
        name: "synthetic_order_lookup",
        arguments: { orderNo: "DEMO-1001" },
      });
      assert.equal(
        mockResult.structuredContent.sentinel,
        "FLOWHUB_S0_TEST_ONLY_041",
      );
      assert.equal(mockResult.structuredContent.synthetic, true);
    });
    await stage(`${era} synthetic Mock close`, () => mock.close());
  }
  // Integrity negative control: deliberate tamper is detected on this disposable copy.
  const { appendFile } = await import("node:fs/promises");
  await appendFile(join(bundle, "README.md"), "\nTAMPER TEST\n");
  await assert.rejects(verifyBundle(bundle), /Hash mismatch: README.md/);
  console.log(
    "Tampered package rejected; no external npm/node used by packaged application.",
  );
  diagnostics.completed = true;
} catch (error) {
  diagnostics.failure = {
    message: redactSmokeDiagnostic(error.message ?? error),
    code: redactSmokeDiagnostic(error.code ?? error.name),
  };
  // No envelopes, HTTP headers, tokens or tool arguments enter diagnostics.
  console.error(
    JSON.stringify(
      {
        packageSmokeFailure: diagnostics.failure,
        processes: processDiagnostics.map((read) => read()),
      },
      null,
      2,
    ),
  );
  throw Object.assign(new Error(diagnostics.failure.message), {
    code: diagnostics.failure.code,
  });
} finally {
  await Promise.allSettled(clients.map((c) => c.close()));
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(force);
  }
  diagnostics.finishedAt = new Date().toISOString();
  diagnostics.processes = [
    {
      role: "packaged daemon",
      pid: child?.pid,
      exitCode: child?.exitCode,
      stderr,
    },
    ...processDiagnostics.map((read) => read()),
  ];
  await mkdir(join(root, "artifacts"), { recursive: true });
  await writeFile(
    join(root, "artifacts/package-smoke-diagnostics.json"),
    JSON.stringify(diagnostics, null, 2),
  );
  await rm(dir, { recursive: true, force: true });
}
