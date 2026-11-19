import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { CapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { AuthoringService } from "../../packages/workflow-authoring/src/index.js";
import type { Json } from "../../packages/contracts/src/domain.js";
import { nodeScriptRuntime } from "../helpers/discovery-runtime.js";
import { createLocalHttp } from "../../apps/daemon/src/http.js";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flowhub-matrix-discovery-")));
  const home = join(root, "selected-home"), cwd = join(root, "project");
  const cli = join(root, "codex-fixture.mjs"), calls = join(root, "cli-calls.jsonl");
  await mkdir(home);
  await mkdir(cwd);
  await writeFile(join(home, "config.toml"), "");
  await writeFile(join(home, "servers.json"), JSON.stringify({ default: [] }));
  await writeFile(cli, `import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2), home=process.env.CODEX_HOME;
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,home,cwd:process.cwd()})+'\\n');
if(args.includes('--version'))console.log('codex-cli 0.164.0-alpha.11.1');
else if(args.includes('--help'))console.log(args.includes('mcp')?'--json':'--profile <PROFILE>');
else if(args.includes('--json')){const index=args.indexOf('--profile'), data=JSON.parse(fs.readFileSync(path.join(home,'servers.json'),'utf8'));console.log(JSON.stringify(data[index<0?'default':args[index+1]]??[]));}
else process.exit(3);
`);
  const db = new Database(":memory:"), repo = new Repository(db), vault = new Vault(repo);
  const engine = new Engine(repo, vault, new Connectors(repo, vault));
  const registry = new CapabilityRegistry(engine, { hostRuntime: nodeScriptRuntime });
  const authoring = new AuthoringService(engine);
  t.after(async () => {
    await registry.close();
    await engine.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const context = (extra: Json = {}) => registry.context({ codexHome: home, cwd, codexPath: cli, ...extra });
  const scan = async (c: Json, key: string, depth = "metadata") => {
    const receipt = registry.scan({ contextId: c.id, depth, idempotencyKey: key });
    await registry.idle();
    return registry.status(receipt.scanId);
  };
  return { root, home, cwd, cli, calls, repo, vault, engine, registry, authoring, context, scan };
}

const importRequest = (cap: Json, key: string) => ({
  capabilityId: cap.id, expectedSourceRevision: cap.revision, target: "hub_direct",
  environment: "test", lockedArguments: {}, idempotencyKey: key,
});

test("Chrome's latest alias resolves to its canonical installed version without hiding real ambiguity", async t => {
  const f = await fixture(t);
  const version = await installed(f, "chrome", 1);
  const base = join(version, "..");
  await writeFile(join(f.home, "config.toml"), '[plugins."chrome@matrix-market"]\nenabled=true\n');
  await symlink(version, join(base, "latest"), process.platform === "win32" ? "junction" : "dir");
  const outside = await installed(f, "other", 1);
  await writeFile(join(outside, ".codex-plugin/plugin.json"), JSON.stringify({ name: "chrome" }));
  await symlink(outside, join(base, "outside"), process.platform === "win32" ? "junction" : "dir");
  const context = await f.context({ discoveryMode: "config_only" });
  const scan = await f.scan(context, "alias");
  assert.ok(!scan.issues.some((issue: Json) => issue.code === "PLUGIN_VERSION_AMBIGUOUS"));
  assert.equal(scan.components.find((item: Json) => item.kind === "plugin" && item.name === "chrome")?.version, "1.0");
  assert.equal(scan.components.filter((item: Json) => item.kind === "skill" && item.parent === "chrome@matrix-market").length, 1);
  await mkdir(join(base, "2.0", ".codex-plugin"), { recursive: true });
  await writeFile(join(base, "2.0", ".codex-plugin/plugin.json"), JSON.stringify({ name: "chrome" }));
  assert.ok((await f.scan(context, "distinct")).issues.some((issue: Json) => issue.code === "PLUGIN_VERSION_AMBIGUOUS"));
  await writeFile(join(f.home, "config.toml"), '[plugins."chrome@matrix-market"]\nenabled=true\nversion="latest"\n');
  const pinned = await f.scan(context, "alias-pin");
  assert.equal(pinned.components.find((item: Json) => item.kind === "plugin" && item.name === "chrome")?.version, "1.0");
});

async function installed(f: Awaited<ReturnType<typeof fixture>>, name: string, skills = 0, servers: Json = {}) {
  const root = join(f.home, "plugins/cache/matrix-market", name, "1.0");
  await mkdir(join(root, ".codex-plugin"), { recursive: true });
  await writeFile(join(root, ".codex-plugin/plugin.json"), JSON.stringify({
    name, version: "1.0", ...(Object.keys(servers).length ? { mcpServers: "./.mcp.json" } : {}),
  }));
  if (Object.keys(servers).length) await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
  for (let index = 0; index < skills; index++) {
    const directory = join(root, "skills", "skill-" + index);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}-skill-${index}\ndescription: Synthetic matrix skill\n---\nKeep ordinary business content unchanged.\n`);
  }
  return root;
}

async function mcpServer(f: Awaited<ReturnType<typeof fixture>>, authenticated = false) {
  const path = join(f.root, "official-mcp-fixture.mjs"), launches = join(f.root, "mcp-launches.jsonl");
  await writeFile(path, `import fs from 'node:fs';
import {McpServer,fromJsonSchema} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server"))};
import {serveStdio} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))};
const token=process.env.MATRIX_PROFILE_TOKEN;
${authenticated ? "if(!['SYNTHETIC_PROFILE_A_VALUE','SYNTHETIC_PROFILE_B_VALUE'].includes(token))process.exit(2);" : ""}
const name=${authenticated ? "token==='SYNTHETIC_PROFILE_A_VALUE'?'profile_a_query':'profile_b_query'" : "'query'"};
fs.appendFileSync(${JSON.stringify(launches)},JSON.stringify({name})+'\\n');
serveStdio(()=>{const server=new McpServer({name:'matrix-synthetic-server',version:'1'},{capabilities:{tools:{}}});
server.registerTool(name,{inputSchema:fromJsonSchema({type:'object',properties:{},additionalProperties:false})},async()=>({content:[{type:'text',text:'Synthetic business value'}]}));return server;},{legacy:'serve'});
`);
  return { path, launches };
}

test("DISC-01 matrix: missing Codex with an empty PATH/config preserves manual create, patch, publish and execution", async t => {
  const f = await fixture(t), previousPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const context = await f.registry.context({ codexHome: f.home, cwd: f.cwd });
    assert.equal(context.codexPath, null);
    assert.equal(context.codexVersion, null);
    const scan = await f.scan(context, "missing-cli", "catalog");
    assert.equal(scan.status, "PARTIAL");
    assert.ok(scan.issues.some((issue: Json) => issue.code === "CODEX_NOT_FOUND"));
    assert.deepEqual(scan.sources, []);
    assert.deepEqual(f.registry.search().items, []);
    const created = f.authoring.create({ workflowId: "no-codex-manual", name: "Manual", environment: "test", mode: "auto", template: "blank", idempotencyKey: "manual-create" });
    const changed = f.authoring.patch({ workflowId: created.workflowId, expectedRevision: created.revision, operations: [{ op: "set_metadata", changes: { name: "Manual saved without Codex" } }], idempotencyKey: "manual-patch" });
    assert.equal(f.authoring.get(created.workflowId).draft.name, "Manual saved without Codex");
    assert.deepEqual(changed.issues, []);
    const version = f.authoring.publish({ workflowId: created.workflowId, expectedRevision: changed.revision, version: "1.0.0", expectedBindingRevisions: {}, expectedCapabilityRevisions: {}, idempotencyKey: "manual-publish" });
    assert.ok(f.repo.get("versions", version.id));
    const run = f.engine.start({ workflowId: created.workflowId, version: "1.0.0", inputs: {}, mode: "auto", idempotencyKey: "manual-run" });
    for (let index = 0; index < 100 && f.engine.status(run.runId).state !== "SUCCEEDED"; index++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(f.engine.status(run.runId).state, "SUCCEEDED");
    await assert.rejects(readFile(f.calls), { code: "ENOENT" });
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  }
});

test("DISC-02 matrix: an explicit CODEX_HOME selects its own configuration and CLI environment despite a decoy default home", async t => {
  const f = await fixture(t), decoy = join(f.root, "decoy-default-home"), previousHome = process.env.CODEX_HOME;
  await mkdir(decoy);
  const selectedConfig = '[mcp_servers.selected]\nurl="https://selected.invalid/mcp"\n';
  const decoyConfig = '[mcp_servers.decoy]\nurl="https://decoy.invalid/mcp"\n';
  await writeFile(join(f.home, "config.toml"), selectedConfig);
  await writeFile(join(decoy, "config.toml"), decoyConfig);
  for (const [home, name] of [[f.home, "selected"], [decoy, "decoy"]] as const)
    await writeFile(join(home, "servers.json"), JSON.stringify({ default: [{ name, enabled: true, transport: { type: "http", url: `https://${name}.invalid/mcp` } }] }));
  process.env.CODEX_HOME = decoy;
  try {
    const selected = await f.context(), implicit = await f.registry.context({ cwd: f.cwd, codexPath: f.cli });
    assert.equal(selected.codexHome, f.home);
    assert.equal(implicit.codexHome, decoy);
    assert.notEqual(selected.id, implicit.id);
    const target = await f.scan(selected, "selected-home"), other = await f.scan(implicit, "default-home");
    assert.equal(target.resolutionQuality, "host_effective");
    assert.deepEqual(target.sources.map((source: Json) => source.name), ["selected"]);
    assert.deepEqual(target.sources[0].sourceChain, ["host CLI effective configuration", join(f.home, "config.toml")]);
    assert.deepEqual(other.sources.map((source: Json) => source.name), ["decoy"]);
    const observed = (await readFile(f.calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(observed.some(call => call.home === f.home && call.args.join(" ") === "mcp list --json"));
    assert.ok(observed.some(call => call.home === decoy && call.args.join(" ") === "mcp list --json"));
    assert.ok(observed.every(call => call.cwd === f.cwd));
    assert.equal(await readFile(join(f.home, "config.toml"), "utf8"), selectedConfig);
    assert.equal(await readFile(join(decoy, "config.toml"), "utf8"), decoyConfig);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  }
});

test("DISC-06 matrix: two CLI Profiles with the same server retain distinct Vault authentication, tool catalogs and bindings", async t => {
  const f = await fixture(t), mcp = await mcpServer(f, true);
  f.vault.initialize("Synthetic-matrix-profile-password");
  const value = (profile: string) => `SYNTHETIC_PROFILE_${profile.toUpperCase()}_VALUE`;
  await writeFile(join(f.home, "servers.json"), JSON.stringify(Object.fromEntries(["a", "b"].map(profile => [profile, [{ name: "shared", enabled: true, transport: { type: "stdio", command: process.execPath, args: [mcp.path], env: { MATRIX_PROFILE_TOKEN: value(profile) } } }]]))));
  const saved: Json[] = [];
  for (const profile of ["a", "b"]) {
    const context = await f.context({ profile });
    assert.equal(context.profile, profile);
    const before = await f.scan(context, "before-" + profile, "catalog"), source = before.sources[0];
    assert.equal(before.resolutionQuality, "host_effective");
    assert.equal(source.availability, "credentials_required");
    const prepared = await f.registry.configureSource({ sourceId: source.id, expectedRevision: source.revision, importInlineCredentials: true, idempotencyKey: "configure-" + profile });
    const connection = f.repo.get("connections", prepared.connectionId);
    assert.equal(f.vault.secret(connection.envRefs.MATRIX_PROFILE_TOKEN), value(profile));
    const scanned = await f.scan(context, "after-" + profile, "catalog");
    assert.equal(scanned.status, "SUCCEEDED");
    const caps = f.registry.search({ contextId: context.id }).items;
    assert.deepEqual(caps.map((cap: Json) => cap.name), ["profile_" + profile + "_query"]);
    const cap = caps[0], imported = await f.registry.import(importRequest(cap, "import-" + profile));
    const binding = f.repo.get("bindings", imported.bindingId), executable = f.repo.get("connections", imported.connectionId);
    assert.equal(binding.sourceCapabilityId, cap.id);
    assert.equal(binding.connectionId, executable.id);
    assert.equal(executable.envRefs.MATRIX_PROFILE_TOKEN, connection.envRefs.MATRIX_PROFILE_TOKEN);
    saved.push({ context, source, cap, imported, ref: connection.envRefs.MATRIX_PROFILE_TOKEN });
  }
  for (const key of ["context", "source", "cap"])
    assert.notEqual(saved[0]![key].id, saved[1]![key].id);
  assert.notEqual(saved[0]!.ref, saved[1]!.ref);
  assert.notEqual(saved[0]!.imported.connectionId, saved[1]!.imported.connectionId);
  assert.notEqual(saved[0]!.imported.bindingId, saved[1]!.imported.bindingId);
  for (const item of saved)
    assert.deepEqual(f.registry.search({ contextId: item.context.id }).items.map((cap: Json) => cap.name), [item.cap.name]);
  const observed = (await readFile(f.calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  for (const profile of ["a", "b"])
    assert.ok(observed.some(call => call.args.join(" ") === `--profile ${profile} mcp list --json`));
  for (const table of ["connections", "bindings", "capability_sources", "capabilities", "capability_revisions", "discovery_jobs", "secrets"] as const)
    for (const profile of ["a", "b"]) assert.ok(!JSON.stringify(f.repo.all(table)).includes(value(profile)));
});

test("DISC-08 matrix: corrupt TOML reports its exact source while a healthy CLI tool and Skill remain discoverable", async t => {
  const f = await fixture(t), mcp = await mcpServer(f), userPath = join(f.home, "config.toml");
  await writeFile(userPath, "broken = [");
  await mkdir(join(f.home, "skills/healthy"), { recursive: true });
  await writeFile(join(f.home, "skills/healthy/SKILL.md"), "---\nname: healthy-skill\n---\nSynthetic healthy skill\n");
  await writeFile(join(f.home, "servers.json"), JSON.stringify({ default: [{ name: "healthy", enabled: true, transport: { type: "stdio", command: process.execPath, args: [mcp.path] } }] }));
  const context = await f.context(), scan = await f.scan(context, "corrupt-with-healthy", "catalog");
  assert.equal(scan.status, "PARTIAL");
  assert.equal(scan.coverage, "partial");
  assert.ok(scan.issues.some((issue: Json) => issue.code === "CONFIG_PARSE_ERROR" && issue.source === userPath));
  assert.equal(scan.sources.find((source: Json) => source.name === "healthy").availability, "ready");
  assert.deepEqual(f.registry.search({ contextId: context.id }).items.map((cap: Json) => cap.name).sort(), ["healthy-skill", "query"]);
  assert.equal(scan.catalog.counts.mcp_server, 1);
  assert.equal(scan.catalog.counts.skill, 1);
  assert.equal(await readFile(userPath, "utf8"), "broken = [");
});

test("PLUG-01 matrix: ten local marketplace entries yield two installations and eight informational available items without expanding or installing candidates", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 10; index++) await installed(f, "candidate-" + index);
  await writeFile(join(f.home, "config.toml"), '[plugins."candidate-0@matrix-market"]\nenabled=true\n[plugins."candidate-1@matrix-market"]\nenabled=true\n');
  const catalogPath = join(f.root, ".agents/plugins/marketplace.json"), target = join(f.root, "candidate-source");
  const marker = join(f.root, "candidate-hook-ran");
  await mkdir(join(f.root, ".agents/plugins"), { recursive: true });
  await mkdir(join(target, "skills/never"), { recursive: true });
  await writeFile(join(target, "skills/never/SKILL.md"), "---\nname: must-not-index-market-skill\n---\nNever execute this.\n");
  await writeFile(join(target, "hooks.json"), JSON.stringify({ command: `${process.execPath} ${join(target, "run.mjs")}` }));
  await writeFile(join(target, "run.mjs"), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'must not run');`);
  const catalogBytes = JSON.stringify({ name: "matrix-market", plugins: Array.from({ length: 10 }, (_, index) => ({
    name: "candidate-" + index, source: { source: "local", path: "./candidate-source" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity",
    interface: { shortDescription: "Synthetic candidate description " + index },
  })) });
  await writeFile(catalogPath, catalogBytes);
  const context = await f.context(), scan = await f.scan(context, "ten-market-two-installed");
  assert.equal(scan.status, "SUCCEEDED");
  assert.deepEqual(scan.components.filter((component: Json) => component.kind === "plugin" && component.installed).map((component: Json) => component.name).sort(), ["candidate-0", "candidate-1"]);
  const plugins = f.registry.catalog.search({ contextId: context.id, kind: "plugin" }).items;
  assert.equal(plugins.length, 10);
  assert.equal(new Set(plugins.map((plugin: Json) => plugin.id)).size, 10);
  assert.equal(plugins.filter((plugin: Json) => plugin.installation === "installed" && plugin.availability === "installed").length, 2);
  const available = plugins.filter((plugin: Json) => plugin.installation === "available_only");
  assert.equal(available.length, 8);
  assert.ok(available.every((plugin: Json) => plugin.availability === "available_only" && plugin.executor === "informational" && plugin.enabled === null));
  assert.ok(available.every((plugin: Json) => !plugin.capabilityId && plugin.description.startsWith("Synthetic candidate description")));
  assert.ok(available.every((plugin: Json) => f.registry.catalog.get(plugin.id).children.length === 0));
  assert.equal(f.registry.catalog.overview(context.id).counts.plugin, 2);
  assert.equal((f.registry.catalog.overview(context.id) as Json).availablePluginCount, 8);
  assert.equal(f.registry.search({ contextId: context.id }).items.length, 0);
  assert.equal(scan.sources.length, 0);
  assert.equal(f.repo.all("connections").length, 0);
  assert.equal(f.repo.all("bindings").length, 0);
  await assert.rejects(f.registry.import(importRequest(available[0], "available-is-not-installed")), { code: "CAPABILITY_STALE" });
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.equal(await readFile(catalogPath, "utf8"), catalogBytes);
  assert.ok(!JSON.stringify(scan).includes("./candidate-source"));
});

test("PLUG-01 matrix: untrusted project markets are unread, policy defaults are not installations, and unsupported metadata preserves healthy entries", async t => {
  const f = await fixture(t), projectPath = join(f.cwd, ".agents/plugins/marketplace.json");
  await mkdir(join(f.cwd, ".agents/plugins"), { recursive: true });
  const entry = (name: string, installation = "AVAILABLE") => ({ name, source: { source: "local", path: "./not-read" }, policy: { installation, authentication: "ON_INSTALL" }, category: "Productivity" });
  await writeFile(projectPath, JSON.stringify({ name: "project-market", plugins: [entry("allowed"), entry("default-only", "INSTALLED_BY_DEFAULT"), entry("policy-denied", "NOT_AVAILABLE")] }));
  const untrusted = await f.context();
  const ignored = await f.scan(untrusted, "untrusted-market");
  assert.equal(ignored.status, "SUCCEEDED");
  assert.equal(f.registry.catalog.search({ contextId: untrusted.id, kind: "plugin" }).items.length, 0);
  const trusted = await f.registry.context({ contextId: untrusted.id, expectedRevision: untrusted.revision, projectTrusted: true });
  const known = await f.scan(trusted, "trusted-market");
  assert.equal(known.status, "SUCCEEDED");
  const plugins = f.registry.catalog.search({ contextId: trusted.id, kind: "plugin" }).items;
  assert.equal(plugins.length, 3);
  assert.ok(plugins.every((plugin: Json) => plugin.installation === "available_only" && plugin.enabled === null && plugin.executor === "informational"));
  assert.equal(plugins.find((plugin: Json) => plugin.name === "policy-denied").availability, "unavailable");
  assert.equal(f.registry.catalog.overview(trusted.id).counts.plugin, 0);
  assert.equal((f.registry.catalog.overview(trusted.id) as Json).availablePluginCount, 2);
  const personalPath = join(f.root, ".agents/plugins/marketplace.json");
  await mkdir(join(f.root, ".agents/plugins"), { recursive: true });
  const invalidCatalogs: Json[] = [
    { name: "future", schema_version: 999, plugins: [entry("never-index")] },
    { name: "bad-entries", plugins: [entry("escape"), { ...entry("remote"), source: { source: "git-subdir", url: "https://user:SYNTHETIC_MARKET_URL_SECRET@remote.invalid/repo" } }] },
  ];
  for (const [index, personal] of invalidCatalogs.entries()) {
    if (index === 1) personal.plugins[0]!.source.path = "./../../SYNTHETIC_MARKET_PATH_SECRET";
    await writeFile(personalPath, JSON.stringify(personal));
    const partial = await f.scan(trusted, "unsupported-market-" + index);
    assert.equal(partial.status, "PARTIAL");
    assert.ok(partial.issues.some((issue: Json) => issue.code === "PLUGIN_MARKETPLACE_UNSUPPORTED" && issue.source === personalPath));
    assert.deepEqual(f.registry.catalog.search({ contextId: trusted.id, kind: "plugin" }).items.map((plugin: Json) => plugin.name).sort(), ["allowed", "default-only", "policy-denied"]);
    assert.ok(!JSON.stringify(partial).includes("SYNTHETIC_MARKET_URL_SECRET"));
    assert.ok(!JSON.stringify(partial).includes("SYNTHETIC_MARKET_PATH_SECRET"));
  }
  assert.equal(f.registry.search({ contextId: trusted.id }).items.length, 0);
  assert.equal(f.repo.all("connections").length, 0);
  assert.equal(f.repo.all("bindings").length, 0);
});

test("PLUG-02/PLUG-03/CAP-01/CAP-03 matrix: two same-name server tools and three Skills preserve one plugin tree, independent sources and idempotent imports", async t => {
  const f = await fixture(t), mcp = await mcpServer(f);
  await installed(f, "multi", 3, Object.fromEntries(["server-a", "server-b"].map(name => [name, { command: process.execPath, args: [mcp.path, name] }])));
  const configPath = join(f.home, "config.toml");
  await writeFile(configPath, '[plugins."multi@matrix-market"]\nenabled=true\n');
  const context = await f.context(), scan = await f.scan(context, "multi-components", "catalog");
  assert.equal(scan.status, "SUCCEEDED");
  const plugin = f.registry.catalog.search({ contextId: context.id, kind: "plugin" }).items[0];
  const entities = f.registry.catalog.search({ contextId: context.id, parentId: plugin.id, limit: 100 }).items;
  assert.equal(entities.filter((entity: Json) => entity.entityKind === "mcp_server").length, 2);
  assert.equal(entities.filter((entity: Json) => entity.entityKind === "skill").length, 3);
  assert.equal(entities.filter((entity: Json) => entity.entityKind === "mcp_tool").length, 2);
  assert.equal(new Set(entities.map((entity: Json) => entity.id)).size, 7);
  assert.ok(entities.every((entity: Json) => entity.pluginId === plugin.id));
  for (const server of entities.filter((entity: Json) => entity.entityKind === "mcp_server")) {
    const children = f.registry.catalog.search({ contextId: context.id, parentId: server.id }).items;
    assert.equal(children.length, 1);
    assert.equal(children[0].name, "query");
    assert.equal(children[0].parentId, server.id);
    assert.equal(server.toolCount, 1);
  }
  const caps = f.registry.search({ contextId: context.id, query: "query" }).items;
  assert.equal(caps.length, 2);
  assert.notEqual(caps[0].id, caps[1].id);
  assert.notEqual(caps[0].sourceRefs[0].sourceId, caps[1].sourceRefs[0].sourceId);
  for (const cap of caps)
    assert.deepEqual(f.registry.search({ contextId: context.id, query: "query", sourceId: cap.sourceRefs[0].sourceId }).items.map((item: Json) => item.id), [cap.id]);
  const first = await f.registry.import(importRequest(caps[0], "multi-import-first"));
  const replay = await f.registry.import(importRequest(caps[0], "multi-import-first"));
  const freshKey = await f.registry.import(importRequest(caps[0], "multi-import-second-key"));
  assert.deepEqual(replay, first);
  assert.equal(freshKey.connectionId, first.connectionId);
  assert.equal(freshKey.bindingId, first.bindingId);
  assert.equal(f.repo.all("connections").length, 1);
  assert.equal(f.repo.all("bindings").length, 1);
  const other = await f.registry.import(importRequest(caps[1], "multi-import-other-source"));
  assert.notEqual(other.connectionId, first.connectionId);
  assert.notEqual(other.bindingId, first.bindingId);
  await f.scan(context, "multi-identical-rescan", "catalog");
  assert.deepEqual(f.registry.catalog.search({ contextId: context.id, parentId: plugin.id, limit: 100 }).items.map((entity: Json) => entity.id).sort(), entities.map((entity: Json) => entity.id).sort());
  const launched = await readFile(mcp.launches, "utf8");
  await writeFile(configPath, '[plugins."multi@matrix-market"]\nenabled=false\n');
  const disabled = await f.scan(context, "multi-disabled", "catalog");
  assert.equal(disabled.status, "SUCCEEDED");
  assert.equal(f.registry.catalog.get(plugin.id).installation, "installed");
  assert.equal(f.registry.catalog.get(plugin.id).enabled, false);
  const disabledChildren = f.registry.catalog.search({ contextId: context.id, parentId: plugin.id, limit: 100 }).items;
  assert.equal(disabledChildren.filter((entity: Json) => entity.entityKind === "skill").length, 3);
  assert.ok(disabledChildren.every((entity: Json) => entity.enabled === false && entity.availability !== "ready"));
  for (const cap of f.registry.search({ contextId: context.id }).items)
    await assert.rejects(f.registry.import(importRequest(cap, "disabled-import-" + cap.id)), { code: "CAPABILITY_STALE" });
  assert.equal(await readFile(mcp.launches, "utf8"), launched);
});

test("CAP-04 matrix: a missing authentication variable stays credentials_required without connecting or recording a process environment value", async t => {
  const f = await fixture(t), variable = "FLOWHUB_MATRIX_ABSENT_TOKEN_20261106";
  assert.equal(process.env[variable], undefined);
  let discoveryCalls = 0;
  f.engine.connectors.discover = async () => { discoveryCalls++; throw new Error("Missing authentication must not attempt a connection."); };
  await writeFile(join(f.home, "servers.json"), JSON.stringify({ default: [{ name: "missing-auth", enabled: true, transport: { type: "http", url: "https://missing-auth.invalid/mcp", bearer_token_env_var: variable } }] }));
  const context = await f.context(), scan = await f.scan(context, "missing-auth", "catalog"), source = scan.sources[0];
  assert.equal(scan.status, "PARTIAL");
  assert.equal(source.availability, "credentials_required");
  assert.deepEqual(source.credentialVariables, [variable]);
  assert.ok(scan.issues.some((issue: Json) => issue.sourceId === source.id && issue.code === "CREDENTIALS_REQUIRED"));
  assert.equal(discoveryCalls, 0);
  assert.deepEqual(f.registry.search({ contextId: context.id }).items, []);
  assert.equal(f.repo.all("connections").length, 0);
  assert.equal(f.repo.all("bindings").length, 0);
  assert.equal(f.repo.all("secrets").length, 0);
  const row = f.repo.get("capability_sources", source.id);
  assert.ok(!Object.hasOwn(row, "config"));
  assert.ok(!Object.hasOwn(row, "env"));
  assert.ok(!Object.hasOwn(row, "secretRef"));
  await assert.rejects(f.registry.configureSource({ sourceId: source.id, expectedRevision: source.revision, importInlineCredentials: true, idempotencyKey: "no-missing-source-value" }), { code: "CREDENTIALS_REQUIRED" });
  assert.equal(f.repo.all("connections").length, 0);
  assert.equal(f.repo.all("secrets").length, 0);
});

test("CAP-02 matrix: one real HTTP endpoint authenticates two tenant Vault references without merging their tools, connections or bindings", async t => {
  const f = await fixture(t), subjects: string[] = [], businessCalls: string[] = [];
  const tokens = { a: "SYNTHETIC_MATRIX_TENANT_A_KEY", b: "SYNTHETIC_MATRIX_TENANT_B_KEY" };
  f.vault.initialize("Synthetic-matrix-tenant-password");
  const server = createLocalHttp(subject => {
    subjects.push(subject);
    const mcp = new McpServer({ name: "matrix-tenant-catalog", version: "1" }, { capabilities: { tools: {} } });
    mcp.registerTool("query", { description: "Synthetic tenant " + subject, inputSchema: fromJsonSchema({ type: "object", properties: {}, additionalProperties: false }) }, async () => {
      businessCalls.push(subject);
      return { content: [{ type: "text", text: "Synthetic tenant result" }] };
    });
    return mcp;
  }, "SYNTHETIC_UNUSED_EXECUTION_TOKEN", header => header === "Bearer " + tokens.a ? "a" : header === "Bearer " + tokens.b ? "b" : undefined);
  await server.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${(server.server.address() as { port: number }).port}/mcp`;
  await writeFile(join(f.home, "servers.json"), JSON.stringify({ default: ["a", "b"].map(tenant => ({ name: "tenant-" + tenant, enabled: true, transport: { type: "http", url: endpoint, bearer_token_env_var: "MATRIX_TENANT_TOKEN" } })) }));
  const context = await f.context();
  await f.scan(context, "tenant-metadata");
  const refs = { a: f.vault.addSecret("Synthetic tenant A", tokens.a), b: f.vault.addSecret("Synthetic tenant B", tokens.b) };
  for (const tenant of ["a", "b"] as const) {
    const source = f.repo.all("capability_sources").find(source => source.name === "tenant-" + tenant);
    await f.registry.configureSource({ sourceId: source.id, expectedRevision: source.revision, secretRefs: { MATRIX_TENANT_TOKEN: refs[tenant].id }, idempotencyKey: "tenant-configure-" + tenant });
  }
  const scan = await f.scan(context, "tenant-catalog", "catalog");
  assert.equal(scan.status, "SUCCEEDED");
  const caps = f.registry.search({ contextId: context.id, query: "query" }).items;
  assert.equal(caps.length, 2);
  assert.notEqual(caps[0].id, caps[1].id);
  const receipts: Json[] = [];
  for (const tenant of ["a", "b"] as const) {
    const source = f.repo.all("capability_sources").find(source => source.name === "tenant-" + tenant);
    const cap = caps.find((cap: Json) => cap.sourceRefs[0].sourceId === source.id);
    assert.ok(cap);
    assert.equal(cap.description, "Synthetic tenant " + tenant);
    const receipt = await f.registry.import(importRequest(cap, "tenant-import-" + tenant));
    const connection = f.repo.get("connections", receipt.connectionId), binding = f.repo.get("bindings", receipt.bindingId);
    assert.equal(connection.endpoint, endpoint);
    assert.equal(connection.secretRef, refs[tenant].id);
    assert.equal(connection.tools[0].description, "Synthetic tenant " + tenant);
    assert.equal(binding.connectionId, receipt.connectionId);
    assert.equal(binding.sourceCapabilityId, cap.id);
    receipts.push(receipt);
  }
  assert.notEqual(receipts[0]!.connectionId, receipts[1]!.connectionId);
  assert.notEqual(receipts[0]!.bindingId, receipts[1]!.bindingId);
  assert.deepEqual([...new Set(subjects)].sort(), ["a", "b"]);
  assert.deepEqual(businessCalls, []);
  for (const receipt of receipts) assert.ok(f.repo.get("bindings", receipt.bindingId));
  for (const table of ["connections", "bindings", "capability_sources", "capabilities", "capability_revisions", "discovery_jobs", "secrets"] as const)
    for (const token of Object.values(tokens)) assert.ok(!JSON.stringify(f.repo.all(table)).includes(token));
});

test("CAP-05 matrix: self sources remain visible but source import and configuration cannot create a recursive connection", async t => {
  const f = await fixture(t);
  f.registry.setSelfIdentity({ instanceId: "synthetic-matrix-instance", endpoints: ["http://127.0.0.1:39521/mcp"] });
  let discoveryCalls = 0;
  f.engine.connectors.discover = async () => { discoveryCalls++; throw new Error("Self sources must not connect."); };
  await writeFile(join(f.home, "servers.json"), JSON.stringify({ default: [
    { name: "flowhub", enabled: true, transport: { type: "http", url: "http://127.0.0.1:39521/mcp" } },
    { name: "innocent-self-alias", enabled: true, transport: { type: "http", url: "http://localhost:39521/mcp/" } },
  ] }));
  const context = await f.context(), scan = await f.scan(context, "self-catalog", "catalog");
  assert.equal(scan.status, "SUCCEEDED");
  assert.equal(scan.sources.length, 2);
  assert.equal(f.registry.catalog.search({ contextId: context.id, kind: "mcp_server" }).items.length, 2);
  assert.ok(scan.sources.every((source: Json) => source.self === true && source.executor === "informational"));
  assert.equal(discoveryCalls, 0);
  for (const source of scan.sources) {
    await assert.rejects(f.registry.import(importRequest(source, "self-import-" + source.id)), { code: "CAPABILITY_STALE" });
    await assert.rejects(f.registry.configureSource({ sourceId: source.id, expectedRevision: source.revision, idempotencyKey: "self-configure-" + source.id }), { code: "SELF_REFERENCE_DENIED" });
  }
  assert.deepEqual(f.registry.search({ contextId: context.id }).items, []);
  assert.equal(f.repo.all("connections").length, 0);
  assert.equal(f.repo.all("bindings").length, 0);
});

test("CAP-06 matrix: removing a discovered source marks current capability stale while preserving published dependencies and prior revision bytes", async t => {
  const f = await fixture(t), skill = join(f.home, "skills/history/SKILL.md");
  await mkdir(join(f.home, "skills/history"), { recursive: true });
  const original = "---\nname: history-skill\ndescription: Synthetic frozen source\n---\nKeep this exact content in the publication.\n";
  await writeFile(skill, original);
  const context = await f.context();
  await f.scan(context, "history-source");
  const cap = f.registry.search({ contextId: context.id }).items[0];
  f.authoring.create({ workflowId: "source-history", name: "Published source history", environment: "test", mode: "guided", template: "blank", idempotencyKey: "history-create" });
  const patched = f.authoring.patch({ workflowId: "source-history", expectedRevision: 1, idempotencyKey: "history-wire", operations: [
    { op: "add_node", nodeId: "host", nodeType: "agent_task", title: "Synthetic host Skill", capabilityRef: { capabilityId: cap.id, revision: cap.revision }, config: { kind: "host_skill", executorRef: "codex_host", skillRef: cap.name, instructions: "Use the frozen synthetic Skill.", reportContractRef: "incident-report/v1", inputMappings: {}, outputSchema: { type: "object", properties: { reportMarkdown: { type: "string" }, evidenceRefs: { type: "array", items: { type: "string" } } }, required: ["reportMarkdown", "evidenceRefs"], additionalProperties: false } } },
    { op: "disconnect", source: "input", target: "end", port: "next" },
    { op: "connect", source: "input", target: "host", port: "next" },
    { op: "connect", source: "host", target: "end", port: "next" },
  ] });
  assert.deepEqual(patched.issues, []);
  const published = f.authoring.publish({ workflowId: "source-history", expectedRevision: patched.revision, version: "1.0.0", expectedBindingRevisions: {}, expectedCapabilityRevisions: { [cap.id]: cap.revision }, idempotencyKey: "history-publish" });
  const snapshot = JSON.stringify(f.repo.get("versions", published.id));
  const revisionId = cap.id + "@" + cap.revision, revisionBytes = JSON.stringify(f.repo.get("capability_revisions", revisionId));
  assert.equal(published.snapshot.capabilities[0].skillContent, original);
  await rm(join(f.home, "skills/history"), { recursive: true });
  const after = await f.scan(context, "history-source-removed");
  assert.equal(after.status, "SUCCEEDED");
  assert.ok(after.changes.some((change: Json) => change.sourceId === cap.sourceRefs[0].sourceId && change.change === "removed"));
  assert.equal(f.repo.get("capability_sources", cap.sourceRefs[0].sourceId).stale, true);
  assert.equal(f.registry.get({ capabilityId: cap.id }).stale, true);
  assert.equal(JSON.stringify(f.repo.get("versions", published.id)), snapshot);
  assert.equal(JSON.stringify(f.repo.get("capability_revisions", revisionId)), revisionBytes);
  assert.ok(f.authoring.get("source-history").issues.some((issue: Json) => issue.code === "CAPABILITY_STALE" && issue.nodeId === "host"));
  await assert.rejects(f.registry.import({ ...importRequest(cap, "removed-import"), target: "codex_host" }), { code: "CAPABILITY_STALE" });
  assert.equal(f.repo.all("versions").length, 1);
});

test("PLUG-01 matrix: personal and trusted project market symlinks cannot read beyond registered roots while in-root links remain readable", async t => {
  const f = await fixture(t), external = await realpath(await mkdtemp(join(tmpdir(), "flowhub-outside-market-")));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(join(external, "marketplace.json"), "SYNTHETIC_OUTSIDE_MARKET_CONTENT_NOT_JSON");
  await installed(f, "healthy");
  await writeFile(join(f.home, "config.toml"), '[plugins."healthy@matrix-market"]\nenabled=true\n');
  const personalDirectory = join(f.root, ".agents/plugins"), projectDirectory = join(f.cwd, ".agents/plugins");
  for (const directory of [personalDirectory, projectDirectory]) {
    await mkdir(join(directory, ".."), { recursive: true });
    await symlink(external, directory, process.platform === "win32" ? "junction" : "dir");
  }
  const context = await f.context({ projectTrusted: true }), scan = await f.scan(context, "outside-market-links");
  assert.equal(scan.status, "PARTIAL");
  for (const directory of [personalDirectory, projectDirectory]) {
    const issues = scan.issues.filter((issue: Json) => issue.source === join(directory, "marketplace.json"));
    assert.deepEqual(issues.map((issue: Json) => issue.code), ["SOURCE_UNREADABLE"], "Root rejection must happen before parsing the outside file body.");
    assert.equal(await realpath(directory), external);
  }
  assert.deepEqual(f.registry.catalog.search({ contextId: context.id, kind: "plugin" }).items.map((plugin: Json) => plugin.name), ["healthy"]);
  assert.ok(!JSON.stringify(scan).includes("SYNTHETIC_OUTSIDE_MARKET_CONTENT"));
  const internal = join(f.root, "in-root-market");
  await mkdir(internal);
  await writeFile(join(internal, "marketplace.json"), JSON.stringify({ name: "inside-market", plugins: [{ name: "safe-available", source: { source: "local", path: "./not-read" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }] }));
  await rm(personalDirectory);
  await symlink(internal, personalDirectory, process.platform === "win32" ? "junction" : "dir");
  const inside = await f.scan(context, "inside-market-link");
  assert.equal(inside.status, "PARTIAL", "The unchanged project link must still report its own boundary failure.");
  assert.ok(!inside.issues.some((issue: Json) => issue.source === join(personalDirectory, "marketplace.json")));
  assert.deepEqual(f.registry.catalog.search({ contextId: context.id, kind: "plugin" }).items.map((plugin: Json) => plugin.name).sort(), ["healthy", "safe-available"]);
  assert.equal(f.registry.catalog.overview(context.id).counts.plugin, 1);
  assert.equal((f.registry.catalog.overview(context.id) as Json).availablePluginCount, 1);
  assert.equal(f.registry.search({ contextId: context.id }).items.length, 0);
  assert.equal(f.repo.all("connections").length, 0);
});

const marketEntry = (description: string, installation = "AVAILABLE", category = "Productivity"): Json => ({
  name: "shared-plugin", source: { source: "local", path: "./not-expanded" },
  description, policy: { installation, authentication: "ON_INSTALL" }, category,
});
async function sharedMarkets(f: Awaited<ReturnType<typeof fixture>>, personal: Json, project: Json, projectMarket = "shared-market") {
  const personalPath = join(f.root, ".agents/plugins/marketplace.json"), projectPath = join(f.cwd, ".agents/plugins/marketplace.json");
  await mkdir(join(f.root, ".agents/plugins"), { recursive: true });
  await mkdir(join(f.cwd, ".agents/plugins"), { recursive: true });
  const write = (path: string, name: string, entry: Json) => writeFile(path, JSON.stringify({ name, plugins: [entry] }));
  await write(personalPath, "shared-market", personal);
  await write(projectPath, projectMarket, project);
  return { personalPath, projectPath, write };
}

test("PLUG-01 matrix: conflicting market sources stay ambiguous and every second-source metadata change advances the persisted fingerprint", async t => {
  const f = await fixture(t), personal = marketEntry("Personal description"), project = marketEntry("Project description", "NOT_AVAILABLE", "Research");
  const paths = await sharedMarkets(f, personal, project), context = await f.context({ projectTrusted: true });
  const scan = await f.scan(context, "conflicting-market-sources");
  assert.equal(scan.status, "PARTIAL");
  assert.deepEqual(scan.issues.filter((issue: Json) => issue.code === "PLUGIN_MARKETPLACE_AMBIGUOUS").map((issue: Json) => issue.source).sort(), [paths.personalPath, paths.projectPath].sort());
  const plugins = f.registry.catalog.search({ contextId: context.id, kind: "plugin" }).items;
  assert.equal(plugins.length, 1);
  let plugin = plugins[0];
  assert.equal(plugin.installation, "available_only");
  assert.equal(plugin.availability, "ambiguous");
  assert.equal(plugin.executor, "informational");
  assert.equal(plugin.enabled, null);
  assert.equal(plugin.marketplaceConflict, true);
  assert.equal(plugin.marketplaceSources.length, 2);
  const source = (value: Json, path: string) => value.marketplaceSources.find((item: Json) => item.path === path);
  assert.equal(source(plugin, paths.personalPath).description, "Personal description");
  assert.equal(source(plugin, paths.personalPath).marketplacePolicy, "AVAILABLE");
  assert.equal(source(plugin, paths.projectPath).description, "Project description");
  assert.equal(source(plugin, paths.projectPath).marketplacePolicy, "NOT_AVAILABLE");
  assert.equal(source(plugin, paths.projectPath).category, "Research");
  assert.equal(source(plugin, paths.projectPath).authenticationPolicy, "ON_INSTALL");
  assert.equal(plugin.marketplacePolicy, undefined, "Conflicting policies must not pick the personal value as effective.");
  assert.equal(f.registry.catalog.overview(context.id).availablePluginCount, null);
  await f.scan(context, "unchanged-conflicting-market-metadata");
  const repeatedConflict = f.registry.catalog.get(plugin.id);
  assert.equal(repeatedConflict.revision, plugin.revision);
  assert.equal(repeatedConflict.manifestHash, plugin.manifestHash);
  assert.equal(repeatedConflict.sourceFingerprint, plugin.sourceFingerprint);
  for (const [index, patch] of [
    { policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" } },
    { description: "Changed project description" },
    { category: "Operations" },
  ].entries()) {
    Object.assign(project, patch);
    await paths.write(paths.projectPath, "shared-market", project);
    const changed = await f.scan(context, "second-source-change-" + index);
    assert.equal(changed.status, "PARTIAL");
    const current = f.registry.catalog.get(plugin.id);
    assert.equal(current.marketplaceConflict, true);
    assert.equal(current.availability, "ambiguous");
    assert.equal(current.revision, plugin.revision + 1);
    assert.notEqual(current.sourceFingerprint, plugin.sourceFingerprint);
    assert.notEqual(current.manifestHash, plugin.manifestHash);
    assert.equal(source(current, paths.projectPath).description, project.description);
    assert.equal(source(current, paths.projectPath).marketplacePolicy, project.policy.installation);
    assert.equal(source(current, paths.projectPath).category, project.category);
    plugin = current;
  }
  await paths.write(paths.projectPath, "shared-market", personal);
  const identical = await f.scan(context, "identical-market-metadata");
  assert.equal(identical.status, "SUCCEEDED");
  const agreed = f.registry.catalog.get(plugin.id);
  assert.equal(agreed.marketplaceConflict, false);
  assert.equal(agreed.availability, "available_only");
  assert.equal(agreed.description, "Personal description");
  assert.equal(agreed.marketplaceSources.length, 2);
  assert.equal(f.registry.catalog.overview(context.id).availablePluginCount, 1);
  await f.scan(context, "identical-market-rescan");
  const stable = f.registry.catalog.get(plugin.id);
  assert.equal(stable.revision, agreed.revision);
  assert.equal(stable.manifestHash, agreed.manifestHash);
  assert.equal(stable.sourceFingerprint, agreed.sourceFingerprint);
  assert.equal(f.registry.search({ contextId: context.id }).items.length, 0);
  assert.equal(f.repo.all("connections").length, 0);
  assert.equal(f.repo.all("bindings").length, 0);
});

test("PLUG-01 matrix: different marketplaces remain independent and conflicting catalogs preserve actual installed plugin and Skill facts", async t => {
  const f = await fixture(t), mcp = await mcpServer(f), personal = marketEntry("Personal description"), project = marketEntry("Project description", "NOT_AVAILABLE", "Research");
  const paths = await sharedMarkets(f, personal, project, "other-market"), context = await f.context({ projectTrusted: true });
  const separate = await f.scan(context, "distinct-market-identities");
  assert.equal(separate.status, "SUCCEEDED");
  let plugins = f.registry.catalog.search({ contextId: context.id, kind: "plugin" }).items;
  assert.equal(plugins.length, 2);
  assert.deepEqual(plugins.map((plugin: Json) => plugin.sourceKey).sort(), ["shared-plugin@other-market", "shared-plugin@shared-market"]);
  assert.ok(plugins.every((plugin: Json) => !plugin.marketplaceConflict && plugin.marketplaceSources.length === 1));
  assert.equal(f.registry.catalog.overview(context.id).counts.plugin, 0);
  assert.equal(f.registry.catalog.overview(context.id).availablePluginCount, 1);
  const installedRoot = join(f.home, "plugins/cache/shared-market/shared-plugin/1.0");
  await mkdir(join(installedRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(installedRoot, "skills/actual"), { recursive: true });
  await writeFile(join(installedRoot, ".codex-plugin/plugin.json"), JSON.stringify({ name: "shared-plugin", description: "Actual installed manifest description", version: "1.0", mcpServers: "./.mcp.json" }));
  await writeFile(join(installedRoot, ".mcp.json"), JSON.stringify({ mcpServers: { "actual-server": { command: process.execPath, args: [mcp.path] } } }));
  await writeFile(join(installedRoot, "skills/actual/SKILL.md"), "---\nname: actual-installed-skill\n---\nSynthetic installed instructions\n");
  await writeFile(join(f.home, "config.toml"), '[plugins."shared-plugin@shared-market"]\nenabled=true\n');
  await f.scan(context, "actual-installed-priority", "catalog");
  plugins = f.registry.catalog.search({ contextId: context.id, kind: "plugin" }).items;
  const before = plugins.find((plugin: Json) => plugin.sourceKey === "shared-plugin@shared-market");
  assert.equal(before.installation, "installed");
  assert.equal(before.availability, "installed");
  assert.equal(before.enabled, true);
  assert.equal(before.description, "Actual installed manifest description");
  const skill = f.registry.search({ contextId: context.id, kind: "skill" }).items[0];
  assert.equal(skill.name, "actual-installed-skill");
  const tool = f.registry.search({ contextId: context.id, kind: "mcp_tool" }).items[0];
  assert.equal(tool.name, "query");
  const imported = await f.registry.import(importRequest(tool, "installed-tool-binding-before-market-conflict"));
  const bindingBytes = JSON.stringify(f.repo.get("bindings", imported.bindingId));
  const connectionBytes = JSON.stringify(f.repo.get("connections", imported.connectionId));
  const launches = await readFile(mcp.launches, "utf8");
  assert.equal(f.registry.catalog.overview(context.id).counts.plugin, 1);
  await paths.write(paths.projectPath, "shared-market", project);
  const conflicting = await f.scan(context, "installed-with-conflicting-catalogs");
  assert.equal(conflicting.status, "PARTIAL");
  assert.ok(conflicting.issues.some((issue: Json) => issue.code === "PLUGIN_MARKETPLACE_AMBIGUOUS"));
  const current = f.registry.catalog.get(before.id);
  assert.equal(current.installation, "installed");
  assert.equal(current.availability, "installed");
  assert.equal(current.enabled, true);
  assert.equal(current.marketplaceConflict, true);
  assert.equal(current.marketplaceSources.length, 2);
  assert.equal(current.description, "Actual installed manifest description");
  assert.equal(current.manifestHash, before.manifestHash, "The installed manifest is separate from catalog source metadata.");
  assert.notEqual(current.marketplaceFingerprint, before.marketplaceFingerprint);
  assert.ok(current.revision > before.revision);
  assert.equal(current.children.length, 2);
  assert.equal(current.children.find((child: Json) => child.entityKind === "skill").capabilityId, skill.id);
  assert.equal(f.registry.get({ capabilityId: skill.id }).revision, skill.revision);
  assert.equal(f.registry.get({ capabilityId: tool.id }).revision, tool.revision);
  assert.equal(JSON.stringify(f.repo.get("bindings", imported.bindingId)), bindingBytes);
  assert.equal(JSON.stringify(f.repo.get("connections", imported.connectionId)), connectionBytes);
  assert.equal(f.registry.catalog.overview(context.id).counts.plugin, 1);
  assert.equal(f.registry.catalog.overview(context.id).availablePluginCount, null);
  await f.scan(context, "unchanged-installed-market-conflict");
  const repeated = f.registry.catalog.get(before.id);
  assert.equal(repeated.revision, current.revision);
  assert.equal(repeated.sourceFingerprint, current.sourceFingerprint);
  assert.equal(repeated.marketplaceFingerprint, current.marketplaceFingerprint);
  assert.equal(await readFile(mcp.launches, "utf8"), launches);
  await writeFile(join(f.home, "config.toml"), '[plugins."shared-plugin@shared-market"]\nenabled=false\n');
  await f.scan(context, "disabled-installed-with-market-conflict");
  const disabled = f.registry.catalog.get(before.id);
  assert.equal(disabled.installation, "installed");
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.marketplaceConflict, true);
  assert.equal(disabled.children.length, 2);
  assert.ok(disabled.children.every((child: Json) => child.enabled === false));
  assert.equal(JSON.stringify(f.repo.get("bindings", imported.bindingId)), bindingBytes);
  assert.equal(JSON.stringify(f.repo.get("connections", imported.connectionId)), connectionBytes);
  assert.equal(f.repo.all("connections").length, 1);
  assert.equal(f.repo.all("bindings").length, 1);
});
