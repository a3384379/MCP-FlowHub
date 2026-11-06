import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { promisify } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

// Invoke after build:server. All databases, Codex settings and business data are synthetic.
// FLOWHUB_CODEX_PATH selects an already installed executable; no model or enterprise access is used.
const buildRoot = fileURLToPath(new URL("../", import.meta.url));
const evidence = resolve(process.env.FLOWHUB_HOST_HANDOFF_EVIDENCE_DIR ?? join(buildRoot, "artifacts", "codex-host-handoff"));
await mkdir(evidence, { recursive: true });
const require = createRequire(join(buildRoot, "package.json")), Ajv = require("ajv");
const { startDaemon } = await import(pathToFileURL(join(buildRoot, "dist/apps/daemon/src/index.js")));
const { tomlString } = await import(pathToFileURL(join(buildRoot, "dist/packages/admin-api/src/settings-integration.js")));
const { locateCodex } = await import(pathToFileURL(join(buildRoot, "dist/packages/host-discovery/src/index.js")));
const codex = process.env.FLOWHUB_CODEX_PATH ?? await locateCodex();
assert.ok(codex, "Specify the verified local Codex executable.");
const root = await realpath(await mkdtemp(join(tmpdir(), "flowhub-codex-host-handoff-"))), home = join(root, "codex"), cwd = join(root, "project"), dataDir = join(root, "data"), marker = join(root, "host-calls.jsonl"), schemaDir = join(root, "schema");
await mkdir(home); await mkdir(cwd);
const codexEnv = { ...process.env, CODEX_HOME: home };
const version = (await promisify(execFile)(codex, ["--version"], { env: codexEnv })).stdout.trim();
try {
  const help = (await promisify(execFile)(codex, ["app-server", "generate-json-schema", "--help"], { env: codexEnv })).stdout;
  assert.match(help, /--out/);
  await promisify(execFile)(codex, ["app-server", "generate-json-schema", "--out", schemaDir], { env: codexEnv, timeout: 15000 });
} catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
const paramsBytes = await readFile(join(schemaDir, "v2/McpServerToolCallParams.json")), generated = JSON.parse(paramsBytes), checkParams = new Ajv().compile(generated);
await writeFile(join(evidence, "codex-host-call.params.schema.json"), paramsBytes);
await writeFile(join(evidence, "codex-host-call.response.schema.json"), await readFile(join(schemaDir, "v2/McpServerToolCallResponse.json")));
const inputSchema = { type: "object", properties: { resource: { type: "string", const: "synthetic-test-only" } }, required: ["resource"], additionalProperties: false };
const outputSchema = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false };
const hostEntry = join(root, "owned-host-mcp.mjs");
await writeFile(hostEntry, `import {appendFile} from 'node:fs/promises';
import {McpServer,fromJsonSchema} from ${JSON.stringify(pathToFileURL(require.resolve("@modelcontextprotocol/server")).href)};
import {serveStdio} from ${JSON.stringify(pathToFileURL(require.resolve("@modelcontextprotocol/server/stdio")).href)};
serveStdio(()=>{const s=new McpServer({name:'owned-host-fixture',version:'1'},{capabilities:{tools:{}}});s.registerTool('read_synthetic_host',{inputSchema:fromJsonSchema(${JSON.stringify(inputSchema)}),outputSchema:fromJsonSchema(${JSON.stringify(outputSchema)})},async args=>{await appendFile(${JSON.stringify(marker)},JSON.stringify({args,invokedBy:'actual-local-Codex-AppServer'})+'\\n');const value={summary:'actual local Codex host synthetic result 中文 token=password'};return {structuredContent:value,content:[{type:'text',text:JSON.stringify(value)}]};});return s;},{legacy:'serve'});`);
let providerRequests = 0;
const daemon = await startDaemon({ dataDir, port: 0, providerFactory: () => { providerRequests++; throw new Error("No model request is permitted in this deterministic host handoff drill."); } });
const trace = [], pending = new Map(); let seq = 0, child, lines, stderr = "";
const emit = record => trace.push({ at: new Date().toISOString(), ...record });
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function rpc(method, params, timeoutMs = 15000) {
  if (method === "mcpServer/tool/call") assert.equal(checkParams(params), true, JSON.stringify(checkParams.errors));
  return new Promise((resolvePromise, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error("RPC timeout " + method)); }, timeoutMs);
    pending.set(id, { resolve: resolvePromise, reject, timer });
    emit({ method, ...(params.server ? { server: params.server, tool: params.tool } : {}) });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
async function api(path, body) {
  const response = await fetch("http://127.0.0.1:" + daemon.port + path, { method: body ? "POST" : "GET", headers: { Cookie: cookie, "X-CSRF-Token": csrf, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
async function hub(tool, args) {
  const result = await rpc("mcpServer/tool/call", { threadId, server: "flowhub_runtime", tool, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}
let cookie, csrf, threadId;
try {
  const bootstrap = await fetch("http://127.0.0.1:" + daemon.port + "/api/v1/auth/bootstrap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "Synthetic-host-handoff-password", setupToken: await readFile(join(dataDir, "admin-setup-token"), "utf8") }) });
  assert.equal(bootstrap.status, 200); cookie = bootstrap.headers.get("set-cookie").split(";")[0]; csrf = (await bootstrap.json()).data.csrf;
  const profileResponse = await api("/api/v2/model-profiles", { name: "synthetic configured Key", providerKind: "openai_compatible_chat", baseUrl: "https://synthetic.invalid/v1", model: "synthetic-no-request", apiKey: "synthetic-not-a-real-api-key" });
  assert.equal(profileResponse.status, 200); const profile = profileResponse.body.data; assert.equal(profile.keyConfigured, true);
  await writeFile(join(home, "config.toml"), ["[features]", "apps = false", "[mcp_servers.flowhub_runtime]", "command = " + tomlString(process.execPath), "args = [" + [join(buildRoot, "dist/apps/daemon/src/cli.js"), "mcp", "--stdio", "--data-dir", dataDir].map(tomlString).join(",") + "]", "[mcp_servers.owned_host]", "command = " + tomlString(process.execPath), "args = [" + tomlString(hostEntry) + "]"].join("\n"));
  child = spawn(codex, ["app-server", "--stdio"], { cwd, env: codexEnv, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", part => { stderr = (stderr + part.toString()).slice(-8192); });
  lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const waiting = pending.get(message.id);
    if (waiting) { clearTimeout(waiting.timer); pending.delete(message.id); message.error ? waiting.reject(new Error("Codex RPC " + JSON.stringify(message.error))) : waiting.resolve(message.result); }
    else if (message.id !== undefined && message.method) child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "This synthetic harness has no interactive handler." } }) + "\n");
  });
  child.on("error", error => { for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); } pending.clear(); });
  const initialized = await rpc("initialize", { clientInfo: { name: "flowhub-host-handoff-audit", version: "2.0.0-alpha.2" }, capabilities: { experimentalApi: false } });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const startedThread = await rpc("thread/start", { cwd, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" }); threadId = startedThread.thread.id;
  let ownedTool;
  for (let i = 0; i < 100; i++) {
    const inventory = await rpc("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly", limit: 10 });
    const hubServer = inventory.data.find(server => server.name === "flowhub_runtime"), ownedServer = inventory.data.find(server => server.name === "owned_host");
    ownedTool = ownedServer?.tools?.read_synthetic_host;
    if (Object.keys(hubServer?.tools ?? {}).length === 21 && ownedTool) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ownedTool, stderr); assert.deepEqual(ownedTool.inputSchema, inputSchema); assert.deepEqual(ownedTool.outputSchema, outputSchema);
  // The synthetic host reference uses the actual schema obtained from Codex.
  // It intentionally has no Hub connection/binding and cannot be called by Key.
  const cap = { id: "audit-owned-host", capabilityId: "audit-owned-host", name: "read_synthetic_host", kind: "mcp_tool", executor: "codex_host", availability: "host_only", revision: 1, inputSchema: ownedTool.inputSchema, outputSchema: ownedTool.outputSchema, sourceRefs: [{ server: "owned_host", provenance: "synthetic actual local Codex inventory" }] };
  daemon.engine.repo.put("capabilities", cap.id, cap); daemon.engine.repo.put("capability_revisions", cap.id + "@1", { ...cap, id: cap.id + "@1", capabilityRevision: 1 });
  const created = await hub("workflow_draft_create", { workflowId: "actual-host-handoff", name: "真实本机Codex合成宿主交接", environment: "test", mode: "guided", template: "blank", idempotencyKey: "create" });
  const patched = await hub("workflow_draft_patch", { workflowId: created.workflowId, expectedRevision: created.revision, idempotencyKey: "patch", operations: [{ op: "add_node", nodeId: "host", nodeType: "agent_task", title: "Host-only synthetic tool", capabilityRef: { capabilityId: cap.id, revision: 1 }, config: { kind: "host_tool", executorRef: "codex_host", instructions: "Call the owned synthetic Codex host tool with the frozen arguments, then return its supplied summary.", inputMappings: { "/resource": { value: "synthetic-test-only" } }, outputSchema } }, { op: "disconnect", source: "input", target: "end", port: "next" }, { op: "connect", source: "input", target: "host", port: "next" }, { op: "connect", source: "host", target: "end", port: "next" }] });
  assert.deepEqual(patched.issues, []);
  const draft = await hub("workflow_draft_get", { workflowId: created.workflowId }); assert.equal(draft.workflow.executionRequirements.requiresCodex, true);
  await hub("workflow_draft_publish", { workflowId: created.workflowId, expectedRevision: patched.revision, version: "1.0.0", expectedBindingRevisions: {}, expectedCapabilityRevisions: { [cap.id]: 1 }, idempotencyKey: "publish" });
  const run = await hub("workflow_start", { workflowId: created.workflowId, version: "1.0.0", mode: "guided", inputs: {}, idempotencyKey: "run" });
  let status;
  for (let i = 0; i < 100; i++) { status = await hub("workflow_status", { runId: run.runId }); if (status.state === "WAITING_AGENT") break; await new Promise(r => setTimeout(r, 10)); }
  assert.equal(status.state, "WAITING_AGENT"); assert.equal(status.checkpoint.executorRef, "codex_host"); assert.equal(status.checkpoint.capability.name, "read_synthetic_host"); assert.deepEqual(status.checkpoint.resolvedArguments, { resource: "synthetic-test-only" });
  const beforeDenied = digest(daemon.engine.repo.get("runs", run.runId));
  const denied = await api("/api/v2/runs/" + run.runId + "/analysis", { modelProfileId: profile.id, idempotencyKey: "web-key-cannot-host" });
  assert.equal(denied.body.error.code, "HOST_CAPABILITY_UNAVAILABLE"); assert.equal(providerRequests, 0); assert.equal(digest(daemon.engine.repo.get("runs", run.runId)), beforeDenied);
  assert.equal(daemon.engine.repo.all("connections").some(connection => connection.args?.includes(hostEntry)), false);
  const hostResult = await rpc("mcpServer/tool/call", { threadId, server: "owned_host", tool: status.checkpoint.capability.name, arguments: status.checkpoint.resolvedArguments });
  assert.notEqual(hostResult.isError, true); const payload = hostResult.structuredContent;
  assert.equal(payload.summary, "actual local Codex host synthetic result 中文 token=password");
  const submitted = { runId: run.runId, checkpointId: status.checkpoint.id, checkpointToken: status.checkpoint.token, expectedRevision: status.revision, idempotencyKey: "host-result", submission: { type: "agent_result", payload } };
  await hub("workflow_advance", submitted); await hub("workflow_advance", submitted);
  for (let i = 0; i < 100; i++) { status = await hub("workflow_status", { runId: run.runId }); if (status.state === "SUCCEEDED") break; await new Promise(r => setTimeout(r, 10)); }
  assert.equal(status.state, "SUCCEEDED");
  const saved = daemon.engine.repo.get("runs", run.runId); assert.equal(saved.hostReported.host.verification, "host_reported"); assert.deepEqual(saved.outputs.host, payload);
  const calls = (await readFile(marker, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls, [{ args: { resource: "synthetic-test-only" }, invokedBy: "actual-local-Codex-AppServer" }]); assert.equal(providerRequests, 0);
  const receipt = { id: "RUN-07", status: "PASS_LOCAL_HOST_SEGMENT", codexVersion: version, codexUserAgent: initialized.userAgent ?? null, platform: process.platform, arch: process.arch, node: process.versions.node,
    generatedSchemaSha256: createHash("sha256").update(paramsBytes).digest("hex"), workflowId: created.workflowId, runId: run.runId, draftRevision: patched.revision, terminalState: status.state, requiresCodex: true,
    webModelProfileKeyConfigured: true, webAnalysisError: denied.body.error.code, webAnalysisMessage: denied.body.error.message, modelRequests: providerRequests, codexHostToolCalls: calls.length, hostVerification: saved.hostReported.host.verification, hostOutputSha256: digest(payload), rpcTrace: trace,
    fixtureBoundary: "Actual installed Codex and actual MCP protocol with an owned synthetic host tool. Capability reference is seeded from Codex inventory; no enterprise plugin permissions or natural-language model turn is claimed.", personalCodexConfigTouched: false, externalBusinessCalls: 0 };
  await writeFile(join(evidence, "codex-host-handoff.receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt, null, 2));
} finally {
  for (const waiting of pending.values()) clearTimeout(waiting.timer); pending.clear();
  lines?.close();
  if (child?.exitCode === null) { child.stdin.end(); child.kill("SIGTERM"); await Promise.race([once(child, "exit"), new Promise(r => setTimeout(() => { child.kill("SIGKILL"); r(); }, 3000).unref())]); }
  await daemon.close(); await rm(root, { recursive: true, force: true });
}
