import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative } from "node:path";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const evidence = join(root, "artifacts/matrix-recheck-20261106/independent-audit");
const require = createRequire(join(root, "package.json"));
const sha = value => createHash("sha256").update(value).digest("hex");
const runtime = relative => pathToFileURL(join(root, "dist", relative.replace(/\.ts$/, ".js"))).href;
const sources = ["packages/host-discovery/src/marketplace.ts", "packages/host-discovery/src/index.ts", "packages/capability-registry/src/discovery-catalog.ts", "packages/assistant-core/src/index.ts", "packages/llm-providers/src/index.ts"];
const bindings = [];
for (const path of sources) {
  const source = await readFile(join(root, path), "utf8");
  const compiled = await readFile(join(root, "dist", path.replace(/\.ts$/, ".js")), "utf8");
  bindings.push({ path, sourceSha256: sha(source), distSha256: sha(compiled), method: ["packages/host-discovery/src/marketplace.ts", "packages/assistant-core/src/index.ts", "packages/llm-providers/src/index.ts"].includes(path) ? "current source transformed in memory by Node 24 stripTypeScriptTypes" : "source audit and dist dependency identity only" });
}
const loadedSources = new Map();
async function sourceModule(path, overrides = new Map()) {
  let code = stripTypeScriptTypes(await readFile(join(root, path), "utf8"), { mode: "transform" });
  code = code.replace(/from\s*(["'])(\.\.?\/[^"']+)\1/g, (_all, _quote, specifier) => {
    const dependency = relative(root, resolve(root, dirname(path), specifier)).replace(/\.js$/, ".ts");
    return "from " + JSON.stringify(overrides.get(dependency) ?? runtime(dependency));
  });
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  loadedSources.set(path, url); return import(url);
}
const Database = require("better-sqlite3");
const { Repository } = await import(runtime("packages/persistence/src/repository.ts"));
const { Vault } = await import(runtime("packages/security/src/index.ts"));
const { Connectors } = await import(runtime("packages/mcp-connectors/src/registry.ts"));
const { Engine } = await import(runtime("packages/workflow-core/src/engine.ts"));
const { Application } = await import(runtime("packages/application/src/index.ts"));
const { addLocalMarketplaces } = await sourceModule("packages/host-discovery/src/marketplace.ts");
const { modelServiceFailure } = await sourceModule("packages/llm-providers/src/index.ts");
const { AssistantCore } = await sourceModule("packages/assistant-core/src/index.ts", loadedSources);

const results = { format: "flowhub.independent-audit.probe.v1", at: new Date().toISOString(), node: process.version, platform: process.platform + "/" + process.arch, bindings, modelCases: [], marketplaceCases: [] };
for (const [name, status, body] of [
  ["explicit_unsupported", 400, { error: { code: "unsupported_parameter", param: "tools", message: "Synthetic unsupported tools" } }],
  ["unknown_400_tools", 400, { error: { code: "invalid_request_error", param: "tools", message: "Synthetic malformed tool schema" } }],
  ["unknown_400_no_param", 400, { error: { message: "Synthetic unclassified failure" } }],
  ["auth_401_tools", 401, { error: { code: "unsupported_parameter", param: "tools", message: "Synthetic authentication failed" } }],
  ["server_500_tools", 500, { error: { param: "tools", message: "Synthetic transient server failure" } }],
]) {
  const requests = [];
  const errors = [];
  const server = createServer(async (req, res) => {
    try {
      let text = "";
      for await (const part of req) text += part;
      const input = JSON.parse(text);
      requests.push({ toolsPresent: !!input.tools?.length, stream: input.stream });
      if (input.tools?.length || name.startsWith("auth_") || name === "unknown_400_no_param") {
        res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); return;
      }
      if (input.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end('data: {"choices":[{"delta":{"content":"Synthetic text help"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Synthetic text help" } }] }));
    } catch (error) { errors.push(String(error)); res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const db = new Database(":memory:"), repo = new Repository(db), vault = new Vault(repo);
  vault.initialize("Synthetic-independent-audit-password");
  const engine = new Engine(repo, vault, new Connectors(repo, vault)), app = new Application(engine);
  await app.assistant.close();
  app.assistant = new AssistantCore(app);
  try {
    const profile = app.assistant.saveProfile({ name: "Independent synthetic", providerKind: "openai_compatible_chat", baseUrl: "http://127.0.0.1:" + server.address().port + "/v1", model: "synthetic", apiKey: "SYNTHETIC-INDEPENDENT-AUDIT-KEY", stream: false });
    const probes = await app.assistant.testProfile(profile.id);
    const before = requests.length;
    const session = app.assistant.session();
    const accepted = app.assistant.submit(session.id, { text: "解释当前项目用法", mode: "help", context: {}, requestedActions: [], modelProfileId: profile.id, idempotencyKey: "independent-help" });
    await app.assistant.settled();
    const help = app.assistant.task(accepted.taskId);
    const compose = app.assistant.submit(session.id, { text: "创建合成流程并保存草稿", mode: "compose", context: {}, requestedActions: ["edit_draft"], modelProfileId: profile.id, idempotencyKey: "independent-compose" });
    await app.assistant.settled();
    const composed = app.assistant.task(compose.taskId);
    const classification = await modelServiceFailure(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
    results.modelCases.push({ name, response: { status, body }, classifiedCode: classification.code, toolProbe: probes.tools, help: { status: help.status, errorCode: help.errorCode ?? null, answer: help.answer ?? null }, helpRequest: requests[before] ?? null, compose: { status: composed.status, errorCode: composed.errorCode ?? null }, requestCount: requests.length, writeCounts: { workflows: repo.all("workflows").length, toolLedger: repo.all("assistant_tool_calls").length, authoringCommands: repo.all("authoring_commands").length }, callbackErrors: errors });
    assert.equal(repo.all("workflows").length, 0);
    assert.equal(repo.all("assistant_tool_calls").length, 0);
  } finally {
    await app.close(); await engine.close(); db.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

const temporary = await realpath(await mkdtemp(join(tmpdir(), "flowhub-independent-market-")));
try {
  const home = join(temporary, "selected-home"), project = join(temporary, "project");
  const personal = join(temporary, ".agents/plugins/marketplace.json"), projectFile = join(project, ".agents/plugins/marketplace.json");
  for (const path of [home, join(temporary, ".agents/plugins"), join(project, ".agents/plugins")]) await mkdir(path, { recursive: true });
  const context = { codexHome: home, canonicalCwd: project, projectTrusted: true };
  const entry = (installation, description) => ({ name: "shared-plugin", source: { source: "local", path: "./never-read-source" }, policy: { installation, authentication: "ON_INSTALL" }, category: "Productivity", description });
  const run = async name => {
    const components = [], issues = [];
    await addLocalMarketplaces(context, components, (path, code) => issues.push({ path, code }));
    const result = { name, components, issues };
    results.marketplaceCases.push(result); return result;
  };
  await writeFile(personal, JSON.stringify({ name: "shared-market", plugins: [entry("AVAILABLE", "Personal description")] }));
  await writeFile(projectFile, JSON.stringify({ name: "other-market", plugins: [entry("NOT_AVAILABLE", "Project description")] }));
  const distinct = await run("distinct_market_identity");
  assert.equal(distinct.components.length, 2);
  await writeFile(projectFile, JSON.stringify({ name: "shared-market", plugins: [entry("NOT_AVAILABLE", "Project description")] }));
  const collision = await run("same_market_name_conflicting_sources");
  assert.equal(collision.components.length, 1);
  await writeFile(projectFile, JSON.stringify({ name: "shared-market", plugins: [entry("AVAILABLE", "Changed project description")] }));
  const changed = await run("same_market_second_source_changed");
  results.marketplaceSecondSourceFingerprintUnchanged = collision.components[0].manifestHash === changed.components[0].manifestHash;
  await rm(personal);
  const external = await realpath(await mkdtemp(join(tmpdir(), "flowhub-independent-outside-")));
  try {
    await writeFile(join(external, "marketplace.json"), "SYNTHETIC_OUTSIDE_NOT_JSON");
    await symlink(join(external, "marketplace.json"), personal);
    const escaping = await run("escaping_file_symlink");
    assert.ok(escaping.issues.some(issue => issue.path === personal && issue.code === "SOURCE_UNREADABLE"));
    assert.ok(!escaping.issues.some(issue => issue.path === personal && issue.code === "PLUGIN_MARKETPLACE_UNSUPPORTED"));
  } finally { await rm(external, { recursive: true, force: true }); }
} finally { await rm(temporary, { recursive: true, force: true }); }

await writeFile(join(evidence, "probe-results.json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify({ results: join(evidence, "probe-results.json"), node: results.node, sourceBindings: bindings.length, modelCases: results.modelCases.map(item => ({ name: item.name, classifiedCode: item.classifiedCode, toolProbe: item.toolProbe.status, help: item.help.status, helpToolsPresent: item.helpRequest?.toolsPresent, writes: item.writeCounts })), marketplaceCases: results.marketplaceCases.map(item => ({ name: item.name, count: item.components.length, policy: item.components.map(component => component.marketplacePolicy), issues: item.issues })), marketplaceSecondSourceFingerprintUnchanged: results.marketplaceSecondSourceFingerprintUnchanged }, null, 2));
