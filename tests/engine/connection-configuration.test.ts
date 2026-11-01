import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { credentialInventory } from "../../packages/security/src/credential-metadata.js";
import { configurationFields } from "../../packages/host-discovery/src/connection-fields.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { CapabilityRegistry } from "../../packages/capability-registry/src/index.js";
import {
  createMockServer,
  startMockHttp,
} from "../../packages/mock-mcps/src/index.js";
import { createLocalHttp } from "../../apps/daemon/src/http.js";
import { nodeScriptRuntime } from "../helpers/discovery-runtime.js";
import { startDaemon } from "../../apps/daemon/src/index.js";

async function fixture(
  t: any,
  config: any = {
    url: "https://synthetic.invalid/mcp",
    bearer_token_env_var: "AUTH",
  },
  name = "synthetic-config",
) {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "flowhub-connection-config-")),
    ),
    home = join(root, "home"),
    cwd = join(root, "project"),
    cli = join(root, "codex.mjs");
  await Promise.all([mkdir(home), mkdir(cwd)]);
  await writeFile(join(home, "config.toml"), "");
  await writeFile(
    cli,
    `const a=process.argv.slice(2);console.log(a.includes('--version')?'codex-config-fixture':a.includes('--help')?'--json':${JSON.stringify(
      JSON.stringify([
        { name, transport: config },
        { name: "unrelated", transport: { url: "http://127.0.0.1:9/mcp" } },
      ]),
    )});`,
  );
  const db = new Database(":memory:"),
    repo = new Repository(db),
    vault = new Vault(repo),
    engine = new Engine(repo, vault, new Connectors(repo, vault)),
    registry = new CapabilityRegistry(engine, {
      hostRuntime: nodeScriptRuntime,
    });
  vault.initialize("Synthetic-configuration-password");
  const context = await registry.context({
    codexHome: home,
    cwd,
    codexPath: cli,
  });
  registry.scan({
    contextId: context.id,
    depth: "metadata",
    idempotencyKey: "metadata",
  });
  await registry.idle();
  const source = repo.all("capability_sources").find((s) => s.name === name);
  t.after(async () => {
    await registry.close();
    await engine.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const save = (body: any) =>
    registry.configureSource({
      sourceId: source.id,
      expectedRevision: source.revision,
      idempotencyKey: "save",
      ...body,
    });
  return { root, cli, source, context, repo, vault, engine, registry, save };
}

test("configuration metadata distinguishes reviewed config, explicit auth and unknown variables without exposing values", async (t) => {
  const f = await fixture(
    t,
    {
      command: process.execPath,
      args: ["/synthetic/server.js"],
      env: {
        CBM_ALLOWED_ROOT: "PRIVATE_SOURCE_ROOT_CANARY",
        CBM_LOG_LEVEL: "info",
        OTHER: "SECRET_CANARY",
      },
    },
    "codebase-memory-mcp",
  );
  const data = f.registry.sourceConfiguration(f.source.id);
  assert.equal(
    data.fields.find((v: any) => v.name === "CBM_ALLOWED_ROOT").kind,
    "config",
  );
  assert.equal(
    data.fields.find((v: any) => v.name === "OTHER").kind,
    "unknown",
  );
  assert.ok(data.fields.every((v: any) => v.inline));
  assert.ok(!JSON.stringify(data).includes("SECRET_CANARY"));
  assert.ok(!JSON.stringify(data).includes("PRIVATE_SOURCE_ROOT_CANARY"));
  assert.equal(
    configurationFields(
      {
        env: { CBM_LOG_LEVEL: "token" },
        bearer_token_env_var: "CBM_LOG_LEVEL",
      },
      "codebase-memory-mcp",
    )[0].kind,
    "credential",
  );
});

test("new values and bindings are atomic, idempotent, encrypted, and source files remain unchanged", async (t) => {
  const f = await fixture(t),
    before = await readFile(f.cli, "utf8"),
    body = {
      entries: {
        "env:AUTH": {
          mode: "new",
          kind: "credential",
          label: "MCP authentication",
          value: "UNIQUE_NEW_AUTH_CANARY",
        },
      },
    };
  const [a, b] = await Promise.all([f.save(body), f.save(body)]);
  assert.deepEqual(a, b);
  assert.equal(f.repo.all("secrets").length, 1);
  assert.equal(f.repo.all("connections").length, 1);
  assert.equal(
    f.vault.secret(a.entryRefs["env:AUTH"]),
    "UNIQUE_NEW_AUTH_CANARY",
  );
  assert.equal(
    f.repo.get("connections", a.connectionId).secretRef,
    a.entryRefs["env:AUTH"],
  );
  assert.equal(await readFile(f.cli, "utf8"), before);
  for (const table of [
    "secrets",
    "commands",
    "connections",
    "capability_sources",
    "application_events",
  ] as const) {
    const rows =
      table === "commands"
        ? f.repo.db.prepare("SELECT * FROM commands").all()
        : table === "application_events"
          ? f.repo.changes(0)
          : f.repo.all(table);
    assert.ok(!JSON.stringify(rows).includes("UNIQUE_NEW_AUTH_CANARY"), table);
  }
  await assert.rejects(
    f.save({
      ...body,
      entries: {
        "env:AUTH": { ...body.entries["env:AUTH"], value: "changed" },
      },
    }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
});

test("invalid late fields and stale revisions roll back all new values and do not leave orphan entries", async (t) => {
  const f = await fixture(t, {
    url: "https://synthetic.invalid/mcp",
    env_vars: ["FIRST", "SECOND"],
  });
  await assert.rejects(
    f.save({
      entries: {
        "env:FIRST": { mode: "new", value: "FIRST_CANARY" },
        "env:SECOND": { mode: "new" },
      },
    }),
    { code: "CREDENTIALS_REQUIRED" },
  );
  assert.equal(f.repo.all("secrets").length, 0);
  assert.equal(f.repo.all("connections").length, 0);
  assert.equal(f.repo.get("capability_sources", f.source.id).revision, 1);
  await assert.rejects(
    f.save({
      expectedRevision: 99,
      entries: { "env:FIRST": { mode: "new", value: "FIRST_CANARY" } },
    }),
    { code: "CAPABILITY_STALE" },
  );
  await assert.rejects(
    f.save({ entries: { "env:UNDECLARED": { mode: "new", value: "CANARY" } } }),
    { code: "INPUT_INVALID" },
  );
  assert.equal(f.repo.all("secrets").length, 0);
});

test("model purpose is derived from real legacy references, not labels, and is enforced server side", async (t) => {
  const f = await fixture(t),
    model = f.vault.addSecret("not-a-model-label", "MODEL_ONLY_CANARY"),
    ordinary = f.vault.addSecret("Model API credential", "MCP_ACTUAL_TOKEN");
  const original = f.repo.get("secrets", model.id);
  f.repo.put("model_profiles", "legacy-model", {
    id: "legacy-model",
    name: "Legacy model",
    secretRef: model.id,
  });
  const inventory = credentialInventory(f.repo);
  assert.equal(inventory.find((s) => s.id === model.id).eligibleForMcp, false);
  assert.equal(
    inventory.find((s) => s.id === ordinary.id).eligibleForMcp,
    true,
  );
  await assert.rejects(f.save({ secretRefs: { AUTH: model.id } }), {
    code: "CREDENTIAL_PURPOSE_MISMATCH",
  });
  assert.deepEqual(f.repo.get("secrets", model.id), original);
  assert.equal(f.repo.all("connections").length, 0);
  const receipt = await f.save({
    idempotencyKey: "actual-mcp",
    secretRefs: { AUTH: ordinary.id },
  });
  assert.equal(
    f.repo.get("connections", receipt.connectionId).secretRef,
    ordinary.id,
  );
});

test("explicit normal config remains encrypted, preserves empty source values, and does not corrupt ordinary catalog text", async (t) => {
  const f = await fixture(
    t,
    {
      command: process.execPath,
      args: ["/synthetic/server.js"],
      env: { CBM_ALLOWED_ROOT: "", CBM_LOG_LEVEL: "info" },
    },
    "codebase-memory-mcp",
  );
  const receipt = await f.save({
    entries: {
      "env:CBM_ALLOWED_ROOT": { mode: "source" },
      "env:CBM_LOG_LEVEL": { mode: "source" },
    },
  });
  assert.equal(f.vault.secret(receipt.entryRefs["env:CBM_ALLOWED_ROOT"]), "");
  assert.equal(f.vault.secret(receipt.entryRefs["env:CBM_LOG_LEVEL"]), "info");
  assert.ok(
    f.repo
      .all("secrets")
      .every((s) => s.encrypted && s.purpose === "mcp_config"),
  );
  assert.deepEqual(f.vault.protectDiagnostic({ note: "info" }), {
    note: "info",
  });
  f.vault.assertCatalogSafe(
    { description: "info", inputSchema: { enum: ["info", "warn"] } },
    f.vault.catalogContext(),
  );
  const ref = receipt.entryRefs["env:CBM_LOG_LEVEL"];
  f.repo.put("model_profiles", "reused", {
    id: "reused",
    name: "Reused",
    secretRef: ref,
  });
  assert.notDeepEqual(f.vault.protectDiagnostic({ note: "info" }), {
    note: "info",
  });
});

test("locked Vault and explicitly declared authentication cannot be bypassed with config classification", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.save({
      entries: { "env:AUTH": { mode: "new", kind: "config", value: "info" } },
    }),
    { code: "INPUT_INVALID" },
  );
  f.vault.lock();
  await assert.rejects(
    f.save({ entries: { "env:AUTH": { mode: "new", value: "LOCK_CANARY" } } }),
    { code: "CREDENTIAL_LOCKED" },
  );
  assert.equal(f.repo.all("secrets").length, 0);
  assert.equal(f.repo.all("connections").length, 0);
  f.vault.unlock("Synthetic-configuration-password");
  const receipt = await f.save({
    entries: { "env:AUTH": { mode: "new", value: "AFTER_UNLOCK" } },
  });
  assert.ok(receipt.connectionId);
});

test("save then real SDK detection reads only the selected source directory, creates capabilities and never calls tools", async (t) => {
  let calls = 0;
  const app = createLocalHttp(createMockServer, "DETECTION_TOKEN");
  app.addHook("preHandler", async (req) => {
    if ((req.body as any)?.method === "tools/call") calls++;
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const port = (app.server.address() as any).port,
    f = await fixture(t, {
      url: "http://127.0.0.1:" + port + "/mcp",
      bearer_token_env_var: "AUTH",
    });
  const other = f.repo
      .all("capability_sources")
      .find((s) => s.name === "unrelated"),
    before = structuredClone(other);
  const receipt = await f.save({
    entries: { "env:AUTH": { mode: "new", value: "DETECTION_TOKEN" } },
  });
  const result = await f.registry.detectSource(f.source.id, receipt.revision);
  assert.equal(result.status, "catalog_ready");
  assert.equal(result.toolCount, 4);
  assert.equal(result.resourceBindingVerified, false);
  assert.equal(f.registry.catalog.get(f.source.id).availability, "ready");
  assert.equal(
    f.registry.search({ contextId: f.context.id, sourceId: f.source.id }).items
      .length,
    4,
  );
  assert.deepEqual(f.repo.get("capability_sources", other.id), before);
  assert.equal(calls, 0);
  assert.equal(f.repo.all("runs").length, 0);
  assert.equal(f.repo.all("bindings").length, 0);
});

test("detection rejection does not roll back a successful configuration save", async (t) => {
  const mock = await startMockHttp("RIGHT_TOKEN");
  t.after(() => mock.close());
  const f = await fixture(t, {
    url: String(mock.url),
    bearer_token_env_var: "AUTH",
  });
  const receipt = await f.save({
    entries: { "env:AUTH": { mode: "new", value: "WRONG_TOKEN" } },
  });
  await assert.rejects(f.registry.detectSource(f.source.id, receipt.revision), {
    code: "AUTH_REQUIRED",
  });
  assert.equal(f.repo.all("secrets").length, 1);
  assert.ok(f.repo.get("connections", receipt.connectionId));
  assert.notEqual(f.registry.catalog.get(f.source.id).availability, "ready");
});

test("detection CAS rejects a late directory result after source change and does not create capabilities", async (t) => {
  const f = await fixture(t),
    receipt = await f.save({
      entries: { "env:AUTH": { mode: "new", value: "CAS_TOKEN" } },
    });
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>((r) => {
      started = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  f.engine.connectors.discover = async () => {
    started();
    await gate;
    return {
      tools: [{ name: "late-tool", inputSchema: { type: "object" } }],
    } as any;
  };
  const pending = f.registry.detectSource(f.source.id, receipt.revision),
    rejected = assert.rejects(pending, { code: "CAPABILITY_STALE" });
  await entered;
  f.repo.put("capability_sources", f.source.id, {
    ...f.repo.get("capability_sources", f.source.id),
    revision: receipt.revision + 1,
  });
  release();
  await rejected;
  assert.equal(f.repo.all("capabilities").length, 0);
});

test("HTTP library creates typed entries once, returns metadata only, and preserves IDs and envelopes across restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "flowhub-credential-http-"));
  let daemon = await startDaemon({ dataDir: dir, port: 0 });
  t.after(async () => {
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  });
  let cookie = "",
    csrf = "";
  const api = async (path: string, method = "GET", body?: any) => {
    const response = await fetch(
      "http://127.0.0.1:" + daemon.port + "/api/v1" + path,
      {
        method,
        headers: {
          Cookie: cookie,
          "X-CSRF-Token": csrf,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    const result = (await response.json()) as any;
    if (path === "/auth/session" && method === "POST") {
      cookie = response.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; ");
      csrf = result.data.csrf;
    }
    return { status: response.status, data: result.data };
  };
  await api("/auth/session", "POST", { username: "admin", password: "admin" });
  const request = {
    label: "MCP local value",
    value: "HTTP_PRIVATE_CANARY",
    purpose: "mcp_auth",
    idempotencyKey: "http-once",
  };
  const first = await api("/secrets", "POST", request),
    second = await api("/secrets", "POST", request);
  assert.equal(first.status, 200);
  assert.deepEqual(first.data, second.data);
  const legacyConnection = await api("/connections", "POST", {
    name: "manual-without-source",
    transport: "streamable_http",
    protocolEra: "modern",
    endpoint: "http://127.0.0.1:9/mcp",
    allowedHosts: ["127.0.0.1"],
    secretRef: first.data.id,
  });
  assert.equal(legacyConnection.status, 200);
  assert.ok(
    (await api("/secrets")).data
      .find((s: any) => s.id === first.data.id)
      .usedBy.some((u: any) => u.id === legacyConnection.data.id),
  );
  assert.notDeepEqual(
    daemon.engine.vault.protectDiagnostic({ message: "HTTP_PRIVATE_CANARY" }),
    { message: "HTTP_PRIVATE_CANARY" },
  );
  const profile = daemon.application.assistant.saveProfile({
    name: "purpose-bound-model",
    providerKind: "openai_compatible_chat",
    baseUrl: "https://synthetic.invalid/v1",
    model: "synthetic",
    apiKey: "SYNTHETIC_MODEL_KEY",
  });
  assert.equal(
    (
      await api("/connections", "POST", {
        name: "rejected-model-ref",
        transport: "streamable_http",
        protocolEra: "modern",
        endpoint: "http://127.0.0.1:9/mcp",
        allowedHosts: ["127.0.0.1"],
        secretRef: profile.secretRef,
      })
    ).status,
    409,
  );
  const original = daemon.engine.repo.get("secrets", first.data.id),
    library = (await api("/secrets")).data;
  assert.equal(library[0].purpose, "mcp_auth");
  assert.equal(library[0].eligibleForMcp, true);
  assert.ok(!JSON.stringify(library).includes("HTTP_PRIVATE_CANARY"));
  assert.equal(library[0].encrypted, undefined);
  assert.equal(
    (await api("/secrets", "POST", { ...request, value: "changed" })).status,
    409,
  );
  await daemon.close();
  daemon = await startDaemon({ dataDir: dir, port: 0 });
  await api("/auth/session", "POST", { username: "admin", password: "admin" });
  assert.equal(daemon.engine.vault.locked, true);
  assert.deepEqual(daemon.engine.repo.get("secrets", first.data.id), original);
  assert.equal((await api("/secrets")).data[0].id, first.data.id);
});

test("shutdown aborts and drains an in-flight source detection before the store can close", async (t) => {
  const f = await fixture(t),
    receipt = await f.save({
      entries: { "env:AUTH": { mode: "new", value: "SHUTDOWN_TOKEN" } },
    });
  let entered!: () => void,
    disposed = false;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  f.engine.connectors.discover = async (_c, options) =>
    new Promise((resolve) => {
      options!.signal!.addEventListener(
        "abort",
        () => {
          disposed = true;
          // A transport may finish successfully just as shutdown aborts it.
          // Such late success must never publish a new catalog.
          resolve({ tools: [] });
        },
        { once: true },
      );
      entered();
    });
  const pending = f.registry.detectSource(f.source.id, receipt.revision),
    rejected = assert.rejects(pending, (error: any) => error.code === "DISCOVERY_CANCELLED");
  await started;
  await f.registry.close();
  await rejected;
  assert.equal(disposed, true);
  assert.equal(f.repo.all("capabilities").length, 0);
  assert.ok(
    !f.repo.changes(0).some((e) => e.type === "connection.catalog.checked"),
  );
});
