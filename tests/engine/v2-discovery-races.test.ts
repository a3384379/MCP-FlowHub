import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { CapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import { startMockHttp } from "../../packages/mock-mcps/src/index.js";
import { nodeScriptRuntime } from "../helpers/discovery-runtime.js";

const bearerSource = { url: "https://synthetic.invalid/mcp", bearer_token_env_var: "SYNTHETIC_AUTH" };
async function fixture(t: any, transport: any = bearerSource) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flowhub-discovery-race-"))),
    home = join(root, "home"), cwd = join(root, "project"), cli = join(root, "codex.mjs"),
    hold = join(root, "hold"), entered = join(root, "entered"), servers = join(root, "servers.json");
  await Promise.all([mkdir(home), mkdir(cwd), mkdir(entered)]);
  await writeFile(join(home, "config.toml"), "");
  await writeFile(servers, JSON.stringify([{ name: "synthetic-auth", enabled: true, transport }]));
  await writeFile(cli, `import fs from 'node:fs/promises';const a=process.argv.slice(2);if(a.includes('--version'))console.log('codex-cli synthetic-race');else if(a.includes('--help'))console.log('--json');else{try{await fs.access(${JSON.stringify(hold)});await fs.writeFile(${JSON.stringify(entered)}+'/'+process.pid,'started');while(true){try{await fs.access(${JSON.stringify(hold)});}catch{break;}try{await fs.access(${JSON.stringify(join(root,"release-"))}+process.pid);break;}catch{}await new Promise(r=>setTimeout(r,5));}}catch{}console.log(await fs.readFile(${JSON.stringify(servers)},'utf8'));}`);
  const db = new Database(":memory:"), repo = new Repository(db), vault = new Vault(repo),
    engine = new Engine(repo, vault, new Connectors(repo, vault)),
    registry = new CapabilityRegistry(engine, { hostRuntime: nodeScriptRuntime });
  vault.initialize("Synthetic-discovery-race-password");
  const context = await registry.context({ codexHome: home, cwd, codexPath: cli });
  let n = 0;
  const scan = async (depth = "metadata") => {
    const accepted = registry.scan({ contextId: context.id, depth, idempotencyKey: "scan-" + ++n });
    await registry.idle(); return registry.status(accepted.scanId);
  };
  const block = async () => {
    await writeFile(hold, "hold synthetic source resolution");
    return {
      entered: async (count = 1) => {
        const deadline = Date.now() + 3000;
        while ((await readdir(entered)).length < count) {
          assert.ok(Date.now() < deadline, "Synthetic source resolver must reach its deterministic barrier");
          await new Promise(r => setTimeout(r, 5));
        }
      },
      releaseOne: async () => writeFile(join(root, "release-" + (await readdir(entered))[0]), "release one resolver"),
      release: () => rm(hold, { force: true }),
    };
  };
  t.after(async () => { await rm(hold, { force: true }); await registry.close(); await engine.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  await scan();
  return { root, home, cwd, cli, servers, repo, vault, registry, context, scan, block, source: () => repo.all("capability_sources")[0] };
}

test("context updates bind the original ID even when another project has the same or a different revision", async t => {
  const f = await fixture(t), cwdB = join(f.root, "project-b"); await mkdir(cwdB);
  const b = await f.registry.context({ codexHome: f.home, cwd: cwdB, codexPath: f.cli, useAppServer: true });
  const aBefore = f.repo.get("host_contexts", f.context.id);
  for (const unequal of [false, true]) {
    if (unequal) await f.registry.context({ contextId: b.id, expectedRevision: b.revision, codexHome: f.home, cwd: cwdB, codexPath: f.cli, useAppServer: false });
    const bBefore = f.repo.get("host_contexts", b.id);
    await assert.rejects(f.registry.context({ contextId: f.context.id, expectedRevision: f.context.revision, codexHome: f.home, cwd: cwdB, codexPath: f.cli, projectTrusted: true }), { code: "CONTEXT_IDENTITY_CHANGED" });
    assert.deepEqual(f.repo.get("host_contexts", f.context.id), aBefore);
    assert.deepEqual(f.repo.get("host_contexts", b.id), bBefore);
  }
  await assert.rejects(f.registry.context({ expectedRevision: 1, codexHome: f.home, cwd: cwdB, codexPath: f.cli }), { code: "INPUT_INVALID" });
});

test("a same-version explicit CLI registration conflicts, and a target-bound CAS update uses the chosen executable", async t => {
  const f = await fixture(t), other = join(f.root, "other-codex.mjs");
  await writeFile(other, "const a=process.argv.slice(2);console.log(a.includes('--version')?'codex-cli synthetic-race':a.includes('--help')?'--json':JSON.stringify([{name:'other-sentinel',transport:{url:'https://other-synthetic.invalid/mcp'}}]));");
  await assert.rejects(f.registry.context({ codexHome: f.home, cwd: f.cwd, codexPath: other }), { code: "CONTEXT_REGISTRATION_CONFLICT" });
  assert.equal(f.repo.get("host_contexts", f.context.id).codexPath, f.cli);
  const updated = await f.registry.context({ contextId: f.context.id, expectedRevision: 1, codexHome: f.home, cwd: f.cwd, codexPath: other });
  assert.equal(updated.id, f.context.id); assert.equal(updated.codexPath, other); assert.equal(updated.revision, 2);
  await f.scan();
  assert.ok(f.repo.all("capability_sources").some(s => s.name === "other-sentinel" && s.contextRevision === 2));
});

test("partial context updates retain the target paths, profile and independent read options; unspecified registration defaults reuse it", async t => {
  const f = await fixture(t), selected = await f.registry.context({ codexHome: f.home, cwd: f.cwd, codexPath: f.cli, profile: "synthetic-profile", useAppServer: true });
  const updated = await f.registry.context({ contextId: selected.id, expectedRevision: selected.revision, projectTrusted: true });
  assert.equal(updated.id, selected.id); assert.equal(updated.codexHome, selected.codexHome); assert.equal(updated.canonicalCwd, selected.canonicalCwd);
  assert.equal(updated.profile, "synthetic-profile"); assert.equal(updated.codexPath, f.cli); assert.equal(updated.useAppServer, true); assert.equal(updated.discoveryMode, "auto"); assert.equal(updated.projectTrusted, true);
  const reused = await f.registry.context({ codexHome: f.home, cwd: f.cwd, codexPath: f.cli, profile: "synthetic-profile" });
  assert.deepEqual(reused, updated);
  const configOnly = await f.registry.context({ codexHome: f.home, cwd: f.cwd, discoveryMode: "config_only" });
  const trustOnly = await f.registry.context({ contextId: configOnly.id, expectedRevision: configOnly.revision, projectTrusted: true });
  assert.equal(trustOnly.codexPath, null); assert.equal(trustOnly.discoveryMode, "config_only"); assert.equal(trustOnly.useAppServer, false);
});

test("explicitly clearing a Profile rejects identity changes without a write, while a separate registration selects the default Profile", async t => {
  const f = await fixture(t), profiled = await f.registry.context({ codexHome: f.home, cwd: f.cwd, codexPath: f.cli, profile: "synthetic-profile" }),
    before = f.repo.get("host_contexts", profiled.id);
  await assert.rejects(f.registry.context({ contextId: profiled.id, expectedRevision: profiled.revision, profile: null }), { code: "CONTEXT_IDENTITY_CHANGED" });
  assert.deepEqual(f.repo.get("host_contexts", profiled.id), before);
  const registered = await f.registry.context({ codexHome: f.home, cwd: f.cwd, codexPath: f.cli, profile: null });
  assert.equal(registered.profile, null); assert.equal(registered.id, f.context.id);
  assert.deepEqual(f.repo.get("host_contexts", profiled.id), before);
});

for (const sameVersion of [false, true]) test("explicit empty CLI path resolves PATH instead of retaining the prior executable (" + (sameVersion ? "same version CAS" : "different identity") + ")", async t => {
  const f = await fixture(t), autoDir = join(f.root, "synthetic-path"), autoCli = join(autoDir, process.platform === "win32" ? "codex.exe" : "codex"),
    version = sameVersion ? f.context.codexVersion : "codex-cli synthetic-auto-different", before = f.repo.get("host_contexts", f.context.id), previousPath = process.env.PATH;
  await mkdir(autoDir);
  await writeFile(autoCli, `const a=process.argv.slice(2);console.log(a.includes('--version')?${JSON.stringify(version)}:a.includes('--help')?'--json':JSON.stringify([{name:'automatic-sentinel',transport:{url:'https://automatic-synthetic.invalid/mcp'}}]));`);
  process.env.PATH = autoDir;
  try {
    const request = { contextId: f.context.id, expectedRevision: f.context.revision, codexPath: "", discoveryMode: "auto" };
    if (sameVersion) {
      const updated = await f.registry.context(request);
      assert.equal(updated.id, f.context.id); assert.equal(updated.codexPath, autoCli); assert.equal(updated.revision, before.revision + 1);
      await f.scan(); assert.ok(f.repo.all("capability_sources").some(s => s.name === "automatic-sentinel"));
    } else {
      await assert.rejects(f.registry.context(request), { code: "CONTEXT_IDENTITY_CHANGED" });
      assert.deepEqual(f.repo.get("host_contexts", f.context.id), before);
      const registered = await f.registry.context({ codexHome: f.home, cwd: f.cwd, profile: null, codexPath: "", discoveryMode: "auto" });
      assert.notEqual(registered.id, f.context.id); assert.equal(registered.codexPath, autoCli); assert.equal(registered.codexVersion, version); assert.equal(registered.discoveryMode, "auto");
      assert.deepEqual(f.repo.get("host_contexts", f.context.id), before);
    }
    const configOnly = await f.registry.context({ codexHome: f.home, cwd: f.cwd, codexPath: null });
    assert.equal(configOnly.codexPath, null); assert.equal(configOnly.discoveryMode, "config_only");
  } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
});

test("concurrent credential saves have one CAS winner and identical idempotent retries reuse that winner", async t => {
  const f = await fixture(t), source = f.source(), one = f.vault.addSecret("Synthetic one", "synthetic-one"), two = f.vault.addSecret("Synthetic two", "synthetic-two"), barrier = await f.block();
  const args = [one, two].map((secret, i) => ({ sourceId: source.id, expectedRevision: source.revision, secretRefs: { SYNTHETIC_AUTH: secret.id }, idempotencyKey: "concurrent-" + i }));
  const pending = args.map(a => f.registry.configureSource(a));
  const settled = Promise.allSettled(pending); await barrier.entered(2); await barrier.release();
  const outcomes = await settled, winners = outcomes.filter(o => o.status === "fulfilled"), losers = outcomes.filter(o => o.status === "rejected");
  assert.equal(winners.length, 1); assert.equal(losers.length, 1); assert.equal(losers[0]!.reason.code, "CAPABILITY_STALE");
  assert.equal(f.source().revision, source.revision + 1); assert.equal(f.repo.all("connections").length, 1); assert.equal(f.repo.all("secrets").length, 2);
  const winner = outcomes.findIndex(o => o.status === "fulfilled"), receipt = (outcomes[winner] as PromiseFulfilledResult<any>).value;
  assert.deepEqual(await f.registry.configureSource(args[winner]!), receipt);
  // Replay remains valid even after the context changes; it creates no fresh configuration.
  await f.registry.context({ contextId: f.context.id, expectedRevision: 1, codexHome: f.home, cwd: f.cwd, codexPath: f.cli, projectTrusted: true });
  assert.deepEqual(await f.registry.configureSource(args[winner]!), receipt);
  assert.equal(f.repo.all("connections").length, 1);
});

test("identical requests crossing the resolver barrier produce one connection and one receipt", async t => {
  const f = await fixture(t), source = f.source(), secret = f.vault.addSecret("Synthetic identical", "synthetic-value"), barrier = await f.block(),
    args = { sourceId: source.id, expectedRevision: source.revision, secretRefs: { SYNTHETIC_AUTH: secret.id }, idempotencyKey: "identical" };
  const pending = Promise.all([f.registry.configureSource(args), f.registry.configureSource(args)]);
  await barrier.entered(2); await barrier.release();
  const [one, two] = await pending; assert.deepEqual(one, two); assert.equal(f.repo.all("connections").length, 1); assert.equal(f.source().revision, source.revision + 1);
});

test("a delayed identical retry replays a committed receipt even if its own resolver later sees a missing source", async t => {
  const f = await fixture(t), source = f.source(), secret = f.vault.addSecret("Synthetic replay", "synthetic-value"), barrier = await f.block(),
    args = { sourceId: source.id, expectedRevision: source.revision, secretRefs: { SYNTHETIC_AUTH: secret.id }, idempotencyKey: "delayed-identical" };
  const pending = [f.registry.configureSource(args), f.registry.configureSource(args)], settled = Promise.all(pending);
  await barrier.entered(2); await barrier.releaseOne(); const committed = await Promise.race(pending);
  await writeFile(f.servers, "[]"); await barrier.release();
  const receipts = await settled; assert.deepEqual(receipts, [committed, committed]);
  assert.equal(f.repo.all("connections").length, 1); assert.equal(f.repo.all("secrets").length, 1);
});

for (const change of ["disabled", "stale", "removed", "fingerprint", "rescanned", "context"])
  test("credential commit rejects " + change + " state after source resolution starts, without orphan connections or secrets", async t => {
    const f = await fixture(t, { url: "https://synthetic.invalid/mcp", http_headers: { AUTHORIZATION: "Bearer synthetic-inline" } }), source = f.source(), barrier = await f.block();
    const pending = f.registry.configureSource({ sourceId: source.id, expectedRevision: source.revision, importInlineCredentials: true, idempotencyKey: "pending" });
    const rejected = assert.rejects(pending, { code: change === "context" ? "CONTEXT_CHANGED" : "CAPABILITY_STALE" });
    await barrier.entered();
    if (change === "removed") f.repo.remove("capability_sources", source.id);
    else if (change === "context") await f.registry.context({ contextId: f.context.id, expectedRevision: 1, codexHome: f.home, cwd: f.cwd, codexPath: f.cli, projectTrusted: true });
    else f.repo.put("capability_sources", source.id, { ...source, ...(change === "disabled" ? { enabled: false } : change === "stale" ? { stale: true } : change === "fingerprint" ? { sourceFingerprint: "changed" } : { lastObservation: { scanId: "newer-scan", at: "newer" } }) });
    await barrier.release(); await rejected;
    assert.equal(f.repo.all("connections").length, 0); assert.equal(f.repo.all("secrets").length, 0);
    assert.equal((f.repo.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE operation='source.configure'").get() as { n: number }).n, 0);
  });

test("old context snapshots are read only and cannot configure; a fresh scan permits configuration", async t => {
  const f = await fixture(t), source = f.source(), secret = f.vault.addSecret("Synthetic reference", "synthetic-value");
  await f.registry.context({ contextId: f.context.id, expectedRevision: 1, codexHome: f.home, cwd: f.cwd, codexPath: f.cli, projectTrusted: true });
  assert.equal(f.registry.catalog.overview(f.context.id).requiresScan, true);
  assert.ok(!f.registry.catalog.overview(f.context.id).issues.some((i: any) => i.connectionSetup === "references"));
  assert.equal(f.registry.catalog.get(source.id).stale, true);
  await assert.rejects(f.registry.configureSource({ sourceId: source.id, expectedRevision: source.revision, secretRefs: { SYNTHETIC_AUTH: secret.id }, idempotencyKey: "old" }), { code: "CONTEXT_CHANGED" });
  assert.equal(f.repo.all("connections").length, 0); assert.equal(f.repo.all("secrets").length, 1);
  await f.scan(); const fresh = f.source();
  assert.equal(fresh.contextRevision, 2); assert.equal(f.registry.catalog.overview(f.context.id).requiresScan, false);
  const receipt = await f.registry.configureSource({ sourceId: fresh.id, expectedRevision: fresh.revision, secretRefs: { SYNTHETIC_AUTH: secret.id }, idempotencyKey: "fresh" });
  assert.equal(receipt.status, "credentials_configured");
});

test("every Authorization case maps the selected Vault reference and authenticates official SDK catalog discovery", async t => {
  const mock = await startMockHttp("Synthetic-Only-Discovery-Token"); t.after(() => mock.close());
  for (const header of ["Authorization", "authorization", "AUTHORIZATION", "aUtHoRiZaTiOn"]) {
    const f = await fixture(t, { url: String(mock.url), env_http_headers: { [header]: "SYNTHETIC_AUTH" } }), source = f.source(), secret = f.vault.addSecret("Synthetic Bearer", "Synthetic-Only-Discovery-Token");
    const receipt = await f.registry.configureSource({ sourceId: source.id, expectedRevision: source.revision, secretRefs: { SYNTHETIC_AUTH: secret.id }, idempotencyKey: "save" });
    assert.equal(f.repo.get("connections", receipt.connectionId).secretRef, secret.id);
    await f.scan("catalog"); assert.equal(f.source().availability, "ready"); assert.equal(f.repo.all("capabilities").length, 4);
  }
});

test("Authorization duplicate conflicts and missing references fail without persisting credentials", async t => {
  for (const headers of [{ env_http_headers: { Authorization: "ONE", AUTHORIZATION: "TWO" } }, { http_headers: { Authorization: "Bearer one", AUTHORIZATION: "Bearer two" } }]) {
    const f = await fixture(t, { url: "https://synthetic.invalid/mcp", ...headers }), source = f.source();
    await assert.rejects(f.registry.configureSource({ sourceId: source.id, expectedRevision: source.revision, importInlineCredentials: true, idempotencyKey: "conflict" }), { code: "AUTHORIZATION_CONFLICT" });
    assert.equal(f.repo.all("connections").length, 0); assert.equal(f.repo.all("secrets").length, 0);
  }
  const f = await fixture(t, { url: "https://synthetic.invalid/mcp", env_http_headers: { aUtHoRiZaTiOn: "MISSING" } }), source = f.source();
  await assert.rejects(f.registry.configureSource({ sourceId: source.id, expectedRevision: source.revision, idempotencyKey: "missing" }), { code: "CREDENTIALS_REQUIRED" });
  assert.equal(f.repo.all("connections").length, 0); assert.equal(f.repo.all("secrets").length, 0);
});
