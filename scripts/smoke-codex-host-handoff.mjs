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
const lookupInput = { type: "object", properties: { resource: { type: "string" }, traceId: { type: "string" }, limit: { type: "integer" } }, required: ["resource", "traceId", "limit"], additionalProperties: false };
const lookupOutput = { type: "object", properties: { resource: { type: "string" }, rowCount: { type: "integer" }, state: { type: "string" }, environment: { type: "string" }, rows: { type: "array", items: { type: "object" } } }, required: ["resource", "rowCount", "state", "environment", "rows"], additionalProperties: false };
const sourceOutput = { ...outputSchema, properties: { ...outputSchema.properties, traceId: { type: "string" } }, required: ["summary", "traceId"] };
const hostEntry = join(root, "owned-host-mcp.mjs");
await writeFile(hostEntry, String.raw`import {appendFile} from 'node:fs/promises';
import {McpServer,fromJsonSchema} from ${JSON.stringify(pathToFileURL(require.resolve("@modelcontextprotocol/server")).href)};
import {serveStdio} from ${JSON.stringify(pathToFileURL(require.resolve("@modelcontextprotocol/server/stdio")).href)};
serveStdio(()=>{
  const s=new McpServer({name:'owned-host-fixture',version:'1'},{capabilities:{tools:{}}});
  const register=(name,inputSchema,outputSchema,execute)=>s.registerTool(name,{
    inputSchema:fromJsonSchema(inputSchema),outputSchema:fromJsonSchema(outputSchema)
  },async args=>{
    await appendFile(${JSON.stringify(marker)},JSON.stringify({name,args})+'\n');
    const value=execute(args);return {structuredContent:value,content:[{type:'text',text:JSON.stringify(value)}]};
  });
  register('read_synthetic_host',${JSON.stringify(inputSchema)},${JSON.stringify(sourceOutput)},()=>({traceId:'trace_demo_0042',summary:'actual local Codex host synthetic result 中文 token=password'}));
  register('lookup_synthetic_host',${JSON.stringify(lookupInput)},${JSON.stringify(lookupOutput)},args=>({resource:args.resource,environment:'test',state:'ok',rowCount:0,rows:[]}));
  return s;
},{legacy:'serve'});`);
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
  assert.ok(ownedTool, stderr); assert.deepEqual(ownedTool.inputSchema, inputSchema); assert.deepEqual(ownedTool.outputSchema, sourceOutput);
  const scanContext = (await api("/api/v2/host-contexts", { codexHome: home, cwd, codexPath: codex, discoveryMode: "auto" })).body.data;
  assert.equal(scanContext.useAppServer, false);
  const authScan = (await api("/api/v2/host-scans", { contextId: scanContext.id, depth: "host_catalog", idempotencyKey: "discover" })).body.data;
  let scanned;
  for (let i = 0; i < 500; i++) {
    scanned = (await api("/api/v2/host-scans/" + authScan.scanId)).body.data;
    if (["SUCCEEDED","PARTIAL","FAILED"].includes(scanned.status)) break;
    await new Promise(r => setTimeout(r, 20));
  }
  const caps = (await api("/api/v2/capabilities?contextId=" + scanContext.id)).body.data.items;
  const cap = caps.find(item => item.name === "read_synthetic_host" && item.executor === "codex_host");
  const lookup = caps.find(item => item.name === "lookup_synthetic_host" && item.executor === "codex_host");
  assert.ok(cap && lookup, JSON.stringify(scanned));
  assert.equal(caps.some(item => item.executor === "hub_direct"), false);
  const source = scanned.sources.find(item => item.name === "owned_host" && item.kind === "mcp_server");
  assert.ok(source && !source.preparedConnectionId);
  assert.equal(daemon.engine.repo.all("connections").some(connection => connection.args?.includes(hostEntry)), false);
  const create = workflowId => hub("workflow_draft_create", { workflowId, name: "本机合成流程 " + workflowId, environment: "test", mode: "guided", template: "blank", idempotencyKey: "create-" + workflowId });
  const created = await create("actual-host-handoff");
  const ref = item => ({ capabilityId: item.id, revision: item.revision });
  const literal = value => ({ value });
  const prior = (nodeId, pointer) => ({ ref: { source: "node", nodeId, pointer } });
  const tool = (nodeId, capability, inputMappings, outputSchema, extra = {}) => ({
    op: "add_node", nodeId, nodeType: "agent_task", title: capability.name, capabilityRef: ref(capability),
    config: { kind: "host_tool", executorRef: "codex_host", requireHostReceipt: true,
      instructions: "Call the frozen owned synthetic fixture.", inputMappings, outputSchema, ...extra },
  });
  const chain = (...nodes) => [
    { op: "disconnect", source: "input", target: "end", port: "next" },
    ...nodes.slice(1).map((target, i) => ({ op: "connect", source: nodes[i], target, port: "next" })),
  ];
  const report = { op: "add_node", nodeId: "report", nodeType: "report_template", title: "归档报告",
    config: { templateRef: "incident-markdown/v1", inputMappings: { "/analysis/summary": prior("logs", "/summary") },
      outputSchema: { type: "object", properties: { reportMarkdown: { type: "string" }, evidenceRefs: { type: "array", items: { type: "string" } } }, required: ["reportMarkdown", "evidenceRefs"], additionalProperties: false } } };
  const lookupMappings = { "/resource": literal("synthetic-test-only"), "/traceId": prior("logs", "/traceId"), "/limit": literal(20) };
  const businessVerification = { pointer: "/state", verified: ["ok"], rowCountPointer: "/rowCount" };
  const patched = await hub("workflow_draft_patch", { workflowId: created.workflowId, expectedRevision: created.revision, idempotencyKey: "patch",
    operations: [tool("logs", cap, { "/resource": literal("synthetic-test-only") }, sourceOutput),
      tool("lookup", lookup, lookupMappings, lookupOutput, { receiptScopeMappings: { "/resource": "/resource" }, businessVerification }),
      report, ...chain("input", "logs", "lookup", "report", "end")] });
  assert.deepEqual(patched.issues, []);
  const draft = await hub("workflow_draft_get", { workflowId: created.workflowId }); assert.equal(draft.workflow.executionRequirements.requiresCodex, true);
  await hub("workflow_draft_publish", { workflowId: created.workflowId, expectedRevision: patched.revision, version: "1.0.0", expectedBindingRevisions: {}, expectedCapabilityRevisions: { [cap.id]: cap.revision, [lookup.id]: lookup.revision }, idempotencyKey: "publish" });
  const run = await hub("workflow_start", { workflowId: created.workflowId, version: "1.0.0", mode: "guided", inputs: {}, idempotencyKey: "run" });
  const waitFor = async (runId, predicate) => {
    for (let i = 0; i < 100; i++) {
      const status = await hub("workflow_status", { runId, view: "checkpoint" });
      if (predicate(status)) return status;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error("Run did not reach the expected state.");
  };
  const hostResults = [];
  for (const nodeId of ["logs", "lookup"]) {
    const status = await waitFor(run.runId, status => status.state === "WAITING_AGENT" && status.currentNode === nodeId);
    assert.equal(status.outputs, undefined); assert.equal(status.events, undefined);
    const checkpoint = status.checkpoint;
    if (nodeId === "logs") {
      const beforeDenied = digest(daemon.engine.repo.get("runs", run.runId));
      const denied = await api("/api/v2/runs/" + run.runId + "/analysis", { modelProfileId: profile.id, idempotencyKey: "web-key-cannot-host" });
      assert.equal(denied.body.error.code, "HOST_CAPABILITY_UNAVAILABLE");
      assert.equal(digest(daemon.engine.repo.get("runs", run.runId)), beforeDenied);
    } else {
      assert.deepEqual(checkpoint.resolvedArguments, { resource: "synthetic-test-only", traceId: "trace_demo_0042", limit: 20 });
      assert.ok(checkpoint.availableEvidence.some(artifact => artifact.nodeId === "logs"));
    }
    const envelope = { runId: run.runId, checkpointId: checkpoint.id, checkpointToken: checkpoint.token, expectedRevision: status.revision };
    const claimRequest = { ...envelope, idempotencyKey: "claim-" + nodeId, submission: { type: "host_tool_claim" } };
    const claim = await hub("workflow_advance", claimRequest);
    assert.deepEqual(await hub("workflow_advance", claimRequest), claim);
    const hostResult = await rpc("mcpServer/tool/call", { threadId, server: checkpoint.capability.serverName, tool: checkpoint.capability.name, arguments: checkpoint.resolvedArguments });
    assert.notEqual(hostResult.isError, true);
    const submitted = { ...envelope, expectedRevision: claim.acceptedRevision, idempotencyKey: "result-" + nodeId,
      submission: { type: "host_tool_result", claimId: claim.claimId, capabilityId: checkpoint.capabilityRef.capabilityId,
        capabilityRevision: checkpoint.capabilityRef.revision, argumentsHash: checkpoint.argumentsHash, payload: hostResult.structuredContent } };
    const result = await hub("workflow_advance", submitted);
    assert.deepEqual(await hub("workflow_advance", submitted), result);
    assert.equal(result.receipt.verification, "host_reported");
    hostResults.push(result.receipt.artifactId);
  }
  const status = await waitFor(run.runId, status => status.state === "SUCCEEDED");
  assert.equal(status.reportArchived, true);
  assert.deepEqual(status.businessVerification.nodes.find(node => node.nodeId === "lookup").rowCount, 0);
  const markdown = status.artifacts.find(artifact => artifact.mimeType === "text/markdown");
  const html = status.artifacts.find(artifact => artifact.mimeType === "text/html");
  assert.ok(markdown && html);
  const reportBytes = await hub("artifact_read", { runId: run.runId, artifactId: markdown.id });
  assert.ok(hostResults.every(id => reportBytes.content.includes(id)));
  const calls = (await readFile(marker, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls, [
    { name: "read_synthetic_host", args: { resource: "synthetic-test-only" } },
    { name: "lookup_synthetic_host", args: { resource: "synthetic-test-only", traceId: "trace_demo_0042", limit: 20 } },
  ]);
  assert.equal(providerRequests, 0);

  const configured = await api("/api/v2/capability-sources/" + source.id + "/credentials", { expectedRevision: source.revision, idempotencyKey: "explicit-direct" });
  assert.equal(configured.status, 200, JSON.stringify(configured));
  const detected = await api("/api/v2/capability-sources/" + source.id + "/detect", { expectedRevision: configured.body.data.revision });
  assert.equal(detected.status, 200, JSON.stringify(detected));
  const direct = (await api("/api/v2/capabilities?contextId=" + scanContext.id + "&executor=hub_direct")).body.data.items.find(cap => cap.name === lookup.name);
  assert.ok(direct);
  const bound = await hub("capability_import", { capabilityId: direct.id, expectedSourceRevision: direct.revision,
    target: "hub_direct", environment: "test", lockedArguments: {}, idempotencyKey: "direct-import" });
  const probe = { resource: "synthetic-test-only", traceId: "trace_demo_0042", limit: 20 };
  const verified = await api("/api/v1/bindings/" + bound.bindingId + "/verify", { probe: { toolName: direct.name, arguments: probe },
    serverEnforcedReadOnly: true, scope: "Read-only owned synthetic MCP fixture", expectedEnvironmentPointer: "/environment" });
  assert.equal(verified.status, 200, JSON.stringify(verified));
  const independent = await create("independent-direct");
  const added = await hub("workflow_draft_patch", { workflowId: independent.workflowId, expectedRevision: independent.revision,
    idempotencyKey: "direct-add", operations: [
      tool("lookup", lookup, Object.fromEntries(Object.entries(probe).map(([key,value])=>["/"+key,literal(value)])), lookupOutput, { businessVerification }),
      ...chain("input","lookup","end")] });
  const switched = await hub("workflow_draft_patch", { workflowId: independent.workflowId, expectedRevision: added.revision, idempotencyKey: "direct-switch",
    operations: [{ op: "set_binding", key: "read", bindingId: bound.bindingId },
      { op: "switch_tool_executor", nodeId: "lookup", capabilityId: direct.id, revision: direct.revision, bindingKey: "read" }] });
  assert.deepEqual(switched.issues, []);
  const directDraft = await hub("workflow_draft_get", { workflowId: independent.workflowId });
  assert.equal(directDraft.workflow.executionRequirements.requiresCodex, false);
  await hub("workflow_draft_publish", { workflowId: independent.workflowId, expectedRevision: switched.revision, version: "1.0.0",
    expectedBindingRevisions: { [bound.bindingId]: verified.body.data.revision }, expectedCapabilityRevisions: { [direct.id]: direct.revision }, idempotencyKey: "direct-publish" });
  const directRun = daemon.engine.start({ workflowId: independent.workflowId, version: "1.0.0", mode: "guided", inputs: {}, idempotencyKey: "direct-run" });
  for (let i = 0; i < 100; i++) {
    if (daemon.engine.status(directRun.runId).state === "SUCCEEDED") break;
    await new Promise(r => setTimeout(r, 20));
  }
  const directStatus = daemon.engine.status(directRun.runId);
  assert.equal(directStatus.state, "SUCCEEDED", JSON.stringify(directStatus.events));
  assert.equal(directStatus.hostResultReceived, false);
  assert.equal(directStatus.nodeDetails.find(node => node.nodeId === "lookup").executor, "hub_direct");
  assert.deepEqual(directStatus.nodeDetails.find(node => node.nodeId === "lookup").arguments, probe);

  const receipt = { status: "PASS_LOCAL_HOST_AND_DIRECT", codexVersion: version, codexUserAgent: initialized.userAgent ?? null,
    platform: process.platform, arch: process.arch, node: process.versions.node, workflowId: created.workflowId,
    runId: run.runId, directRunId: directRun.runId, scanStatus: scanned.status, terminalState: status.state,
    reportFormats: [markdown.mimeType, html.mimeType], codexHostToolCalls: calls.length,
    zeroRows: true, providerRequests, rpcTrace: trace,
    fixtureBoundary: "Actual local Codex App Server and MCP transports, using an owned synthetic service and an isolated Codex home. No model inference or enterprise privileges." };
  await writeFile(join(evidence, "codex-host-handoff.receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt, null, 2));
} finally {
  for (const waiting of pending.values()) clearTimeout(waiting.timer); pending.clear();
  lines?.close();
  if (child?.exitCode === null) { child.stdin.end(); child.kill("SIGTERM"); await Promise.race([once(child, "exit"), new Promise(r => setTimeout(() => { child.kill("SIGKILL"); r(); }, 3000).unref())]); }
  await daemon.close(); await rm(root, { recursive: true, force: true });
}
