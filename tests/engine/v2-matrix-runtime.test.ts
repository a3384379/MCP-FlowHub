import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../../apps/daemon/src/index.js";
import { openStore } from "../../packages/persistence/src/index.js";
import { Repository } from "../../packages/persistence/src/repository.js";
import { inspectBackup, restoreBackup } from "../../packages/persistence/src/maintenance.js";
import { migrate, MIGRATIONS, validateMigrations } from "../../packages/persistence/src/migrations.js";
import { Vault } from "../../packages/security/src/index.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { AuthoringService } from "../../packages/workflow-authoring/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { MCP_RAW_RESULT } from "../../packages/mcp-connectors/src/results.js";
import { createContext, readConfig, scanHost } from "../../packages/host-discovery/src/index.js";
import { hash, type Json } from "../../packages/contracts/src/domain.js";

const temporaryRoots: string[] = [];
after(async () => { for (const root of temporaryRoots) await rm(root, { recursive: true, force: true }); });

async function temporary(_t: TestContext, label: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "flowhub-matrix-" + label + "-")));
  temporaryRoots.push(root);
  return root;
}

const schema = (db: Database.Database) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
const history = (db: Database.Database) => db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
const legacyRows = (db: Database.Database) => Object.fromEntries(["workflows", "versions", "artifacts", "approvals"].map(table =>
  [table, db.prepare("SELECT id,revision,body FROM " + table + " ORDER BY id").all()]));

function insertLegacyRows(db: Database.Database) {
  for (const table of ["workflows", "versions", "artifacts", "approvals"]) {
    const body = JSON.stringify({ id: table + "-v1", revision: 1, content: "原始报告 business@example.invalid 13900000001 token=password 中文 <tag>", table });
    db.prepare("INSERT INTO " + table + " VALUES(?,?,?)").run(table + "-v1", 1, body);
  }
}

test("BASE-01/02: fresh and genuine frozen-v1 databases use the same complete migration chain and retain report bytes", () => {
  const fresh = new Database(":memory:"), upgraded = new Database(":memory:");
  try {
    migrate(fresh);
    assert.deepEqual(history(fresh).map((row: any) => [row.version, row.checksum]), MIGRATIONS.map(m => [m.version, m.checksum]));
    migrate(upgraded, MIGRATIONS.slice(0, 1));
    insertLegacyRows(upgraded);
    const before = legacyRows(upgraded), v1 = history(upgraded)[0];
    migrate(upgraded);
    assert.equal(validateMigrations(upgraded), MIGRATIONS.length);
    assert.deepEqual(history(upgraded)[0], v1);
    assert.deepEqual(legacyRows(upgraded), before);
    assert.deepEqual(schema(upgraded), schema(fresh));
    for (const table of ["assistant_tasks", "workflow_test_suites", "capability_revisions", "knowledge_chunks", "discovery_presentations"])
      assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table), "missing " + table);
  } finally { fresh.close(); upgraded.close(); }
});

test("BASE-03: a failure while adding v2 rolls back to a readable frozen-v1 schema, history and original report", async t => {
  const root = await temporary(t, "migration-rollback"), path = join(root, "v1.sqlite"), db = new Database(path);
  try {
    migrate(db, MIGRATIONS.slice(0, 1));
    insertLegacyRows(db);
    const before = { schema: schema(db), history: history(db), rows: legacyRows(db) };
    const second = MIGRATIONS[1]!;
    const failing = [MIGRATIONS[0]!, { ...second, ddl: second.ddl + "; SELECT * FROM synthetic_missing_migration_table" }];
    assert.throws(() => migrate(db, failing), /synthetic_missing_migration_table/);
    assert.deepEqual({ schema: schema(db), history: history(db), rows: legacyRows(db) }, before);
    assert.equal(validateMigrations(db, false, MIGRATIONS.slice(0, 1)), 1);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='assistant_tasks'").get(), undefined);
  } finally { db.close(); }
  const reopened = new Database(path, { readonly: true });
  try {
    assert.equal(validateMigrations(reopened, false, MIGRATIONS.slice(0, 1)), 1);
    assert.ok((reopened.prepare("SELECT body FROM artifacts").get() as any).body.includes("token=password"));
  } finally { reopened.close(); }
});

for (const [id, corruption, code] of [
  ["BASE-04", "INSERT INTO schema_migrations VALUES(999,'future','2099-01-01T00:00:00.000Z')", "FUTURE_SCHEMA_VERSION"],
  ["BASE-05", "UPDATE schema_migrations SET checksum='synthetic-broken-checksum' WHERE version=1", "MIGRATION_MISMATCH"],
] as const) test(id + ": startup rejects the precise history error before writing or rebuilding any byte", async t => {
  const root = await temporary(t, id.toLowerCase()), path = join(root, "flowhub.sqlite"), db = new Database(path);
  migrate(db); insertLegacyRows(db); db.exec(corruption);
  const beforeRows = legacyRows(db), beforeHistory = history(db), beforeSchema = schema(db);
  db.close();
  const before = await readFile(path);
  assert.throws(() => openStore(path), { code });
  assert.deepEqual(await readFile(path), before);
  const readonly = new Database(path, { readonly: true });
  try {
    assert.deepEqual(legacyRows(readonly), beforeRows);
    assert.deepEqual(history(readonly), beforeHistory);
    assert.deepEqual(schema(readonly), beforeSchema);
  } finally { readonly.close(); }
});

test("BASE-06: valid current backup restores every new table; missing v2 table rejects before replacing the target", async t => {
  const root = await temporary(t, "backup"), dataDir = join(root, "data");
  await mkdir(dataDir);
  const target = join(dataDir, "flowhub.sqlite"), good = join(root, "good.sqlite"), broken = join(root, "broken.sqlite");
  const store = openStore(target), repo = new Repository(store.db);
  const preserved = ["assistant_sessions", "assistant_tasks", "workflow_test_suites", "capability_revisions", "discovery_presentations"] as const;
  for (const table of preserved) repo.put(table, table + "-sentinel", { id: table + "-sentinel", revision: 1, marker: "backup-" + table });
  repo.put("settings", "matrix-sentinel", { value: "backup-value" });
  await repo.backup(good);
  repo.put("settings", "matrix-sentinel", { value: "original-target-value" });
  store.close();
  assert.equal(inspectBackup(good).compatible, true);
  await copyFile(good, broken);
  const damaged = new Database(broken); damaged.exec("DROP TABLE assistant_tasks"); damaged.close();
  const before = await readFile(target), files = await readdir(dataDir);
  const inspection = inspectBackup(broken);
  assert.equal(inspection.compatible, false);
  assert.equal((inspection as any).errorCode, "BACKUP_INCOMPATIBLE");
  await assert.rejects(restoreBackup(dataDir, broken), { code: "BACKUP_INCOMPATIBLE" });
  assert.deepEqual(await readFile(target), before);
  assert.deepEqual(await readdir(dataDir), files);
  assert.equal((await restoreBackup(dataDir, good)).restored, true);
  const restored = openStore(target);
  try {
    const result = new Repository(restored.db);
    assert.equal(result.get("settings", "matrix-sentinel").value, "backup-value");
    for (const table of preserved) assert.equal(result.get(table, table + "-sentinel").marker, "backup-" + table);
  } finally { restored.close(); }
});

test("PACK-04: native permission denial on isolated configuration and data ancestors is explicit and leaves modes unchanged", async t => {
  if (process.platform === "win32" || process.getuid?.() === 0) { t.skip("POSIX unprivileged permission evidence only; Windows requires its native ACL drill."); return; }
  const root = await temporary(t, "permissions"), home = join(root, "home"), cwd = join(root, "project"), denied = join(root, "denied");
  await mkdir(home); await mkdir(cwd); await mkdir(denied);
  const config = join(home, "config.toml");
  await writeFile(config, '[mcp_servers.synthetic]\nurl = "https://synthetic.invalid/mcp"\n');
  const sourceBytes = await readFile(config), context = await createContext({ codexHome: home, cwd, codexPath: null });
  await chmod(config, 0o000); await chmod(denied, 0o500);
  try {
    await assert.rejects(readConfig(config), { code: "EACCES" });
    const scan = await scanHost(context);
    assert.ok(scan.issues.some(issue => issue.source === config && issue.code === "SOURCE_UNREADABLE"), JSON.stringify(scan.issues));
    assert.equal((await stat(config)).mode & 0o777, 0o000);
    await assert.rejects(startDaemon({ dataDir: join(denied, "new-data"), port: 0 }), { code: "EACCES" });
    assert.equal((await stat(denied)).mode & 0o777, 0o500);
    assert.deepEqual(await readdir(denied), []);
  } finally { await chmod(config, 0o600); await chmod(denied, 0o700); }
  assert.deepEqual(await readFile(config), sourceBytes);
});

test("PACK-05: occupied loopback port preserves its service and a distinct development port starts with the failed lock released", async t => {
  const root = await temporary(t, "ports"), dataDir = join(root, "development");
  const existing = await startDaemon({ dataDir: join(root, "existing"), port: 0 });
  let development: Awaited<ReturnType<typeof startDaemon>> | undefined;
  t.after(async () => { await development?.close(); await existing.close(); });
  const endpoint = JSON.parse(await readFile(join(root, "existing", "endpoint.json"), "utf8"));
  await assert.rejects(startDaemon({ dataDir, port: existing.port }), /PORT_IN_USE/);
  await assert.rejects(access(join(dataDir, "daemon.lock")));
  await assert.rejects(access(join(dataDir, "endpoint.json")));
  assert.equal((await fetch("http://127.0.0.1:" + existing.port + "/api/v1/health")).status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(root, "existing", "endpoint.json"), "utf8")), endpoint);
  development = await startDaemon({ dataDir, port: 0 });
  assert.notEqual(development.port, existing.port);
  assert.equal((await fetch("http://127.0.0.1:" + development.port + "/api/v1/health")).status, 200);
  assert.equal((await fetch("http://127.0.0.1:" + existing.port + "/api/v1/health")).status, 200);
  assert.equal(existing.instanceId, endpoint.instanceId);
});

async function runtime(t: TestContext, label: string) {
  const root = await temporary(t, label), db = new Database(":memory:"), repo = new Repository(db), vault = new Vault(repo);
  vault.initialize("Synthetic-matrix-runtime-password");
  const connectors = new Connectors(repo, vault), engine = new Engine(repo, vault, connectors), author = new AuthoringService(engine);
  t.after(async () => { await engine.close(); db.close(); });
  return { root, repo, engine, author, connectors };
}

async function publishDirect(f: Awaited<ReturnType<typeof runtime>>, id: string, environment: string, entry: string, maxRetries = 0) {
  const connection = await f.connectors.discover({ id: id + "-connection", name: id, revision: 1, transport: "stdio", command: process.execPath,
    args: [entry], commandApproved: true, protocolEra: "auto", disabled: false, tools: [] });
  f.repo.put("connections", connection.id, connection);
  const binding = { id: id + "-binding", revision: 1, environment, connectionId: connection.id, connectionRevision: connection.revision,
    allowedTools: ["query_template"], lockedArguments: { "/database": environment }, allowedQueryTemplates: ["lookup"], simulationOnly: false,
    validationStatus: "BINDING_VERIFIED", maxRows: 10, timeoutSeconds: 5 };
  f.repo.put("bindings", binding.id, binding);
  f.author.create({ workflowId: id, name: id, environment, mode: "auto", template: "blank", idempotencyKey: id + ":create" });
  const inputSchema = { type: "object", properties: { orderNo: { type: "string" }, limit: { type: "integer", minimum: 1 } }, required: ["orderNo", "limit"], additionalProperties: false };
  const config = { bindingKey: "db", toolName: "query_template", toolSchemaHash: connection.tools[0].schemaHash, rowLimitArgument: "/limit", resultAdapterRef: "structured",
    argumentsMappings: { "/templateId": { value: "lookup" }, "/parameters/orderNo": { ref: { source: "input", pointer: "/orderNo" } }, "/limit": { ref: { source: "input", pointer: "/limit" } } } };
  const changed = f.author.patch({ workflowId: id, expectedRevision: 1, idempotencyKey: id + ":patch", operations: [
    { op: "set_input_schema", schema: inputSchema }, { op: "set_binding", key: "db", bindingId: binding.id },
    { op: "add_node", nodeId: "db", nodeType: "mcp_tool", title: "Synthetic database", config },
    { op: "disconnect", source: "input", target: "end", port: "next" }, { op: "connect", source: "input", target: "db", port: "next" },
    { op: "connect", source: "db", target: "end", port: "next" },
    { op: "update_node", nodeId: "end", changes: { config: { resultRef: { ref: { source: "node", nodeId: "db", pointer: "" } } } } },
  ] });
  assert.deepEqual(changed.issues, []);
  if (maxRetries) {
    const record = f.repo.get("workflows", id); record.draft.budgets.maxRetries = maxRetries;
    f.repo.put("workflows", id, record);
  }
  f.author.publish({ workflowId: id, expectedRevision: changed.revision, version: "1.0.0", expectedBindingRevisions: { [binding.id]: 1 }, expectedCapabilityRevisions: {}, idempotencyKey: id + ":publish" });
  return { binding, start: { workflowId: id, version: "1.0.0", inputs: { orderNo: "SYNTHETIC-017", limit: 100 }, mode: "auto", idempotencyKey: id + ":start" } };
}

async function settled(engine: Engine, runId: string) {
  for (let i = 0; i < 500; i++) {
    const result = engine.status(runId);
    if (!["QUEUED", "RUNNING"].includes(result.state)) return result;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail("Synthetic local MCP run did not settle.");
}

const databaseInputSchema = { type: "object", properties: { database: { type: "string" }, templateId: { type: "string" }, parameters: { type: "object", properties: { orderNo: { type: "string" } }, required: ["orderNo"], additionalProperties: false }, limit: { type: "integer", minimum: 1 } }, required: ["database", "templateId", "parameters", "limit"], additionalProperties: false };
const databaseOutputSchema = { type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { sentinel: { type: "string" } }, required: ["sentinel"], additionalProperties: false } }, rowCount: { type: "integer" }, receivedLimit: { type: "integer" }, message: { type: "string" } }, required: ["rows", "rowCount", "receivedLimit", "message"], additionalProperties: false };

async function databaseServer(root: string, name: string, trace: string, disconnect = false) {
  const entry = join(root, name + ".mjs");
  await writeFile(entry, `import {appendFile} from 'node:fs/promises';
import {McpServer,fromJsonSchema} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server"))};
import {serveStdio} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))};
serveStdio(()=>{const s=new McpServer({name:${JSON.stringify(name)},version:'1'},{capabilities:{tools:{}}});
s.registerTool('query_template',{inputSchema:fromJsonSchema(${JSON.stringify(databaseInputSchema)}),outputSchema:fromJsonSchema(${JSON.stringify(databaseOutputSchema)})},async args=>{
await appendFile(${JSON.stringify(trace)},JSON.stringify({server:${JSON.stringify(name)},arguments:args})+'\\n');
${disconnect ? "process.exit(0);" : `const value={rows:[{sentinel:${JSON.stringify(name)}}],rowCount:1,receivedLimit:args.limit,message:'business@example.invalid 13900000001 token=password 中文'};return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};`}
});return s;},{legacy:'serve'});`);
  return entry;
}

test("RUN-01/03/05/06: direct database chains have no approval, route to distinct sentinels without an environment result field, and limit before dispatch", async t => {
  const f = await runtime(t, "environment"), trace = join(f.root, "calls.jsonl");
  for (const environment of ["production", "staging"]) {
    const entry = await databaseServer(f.root, environment + "-sentinel", trace), direct = await publishDirect(f, "direct-" + environment, environment, entry);
    const started = f.engine.start(direct.start), result = await settled(f.engine, started.runId), saved = f.repo.get("runs", started.runId);
    assert.equal(result.state, "SUCCEEDED", JSON.stringify(saved));
    assert.equal(saved.outputs.db.rows[0].sentinel, environment + "-sentinel");
    assert.equal(Object.hasOwn(saved.outputs.db, "environment"), false);
    assert.equal(saved.outputs.db.receivedLimit, 10);
    assert.equal(saved.snapshot.workflow.nodes.some((n: Json) => n.type === "approval"), false);
    assert.equal(f.repo.events(started.runId).some(event => /APPROVAL/.test(event.type)), false);
    assert.equal(f.repo.all("approvals").length, 0);
    assert.equal(saved.snapshot.bindings[0].id, direct.binding.id);
  }
  const calls = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls, ["production", "staging"].map(environment => ({ server: environment + "-sentinel", arguments: { database: environment, templateId: "lookup", parameters: { orderNo: "SYNTHETIC-017" }, limit: 10 } })));
});

test("RUN-08: a real local MCP exits after dispatch, producing OUTCOME_UNKNOWN with one call and no replay after recovery or idempotent start", async t => {
  const f = await runtime(t, "disconnect"), trace = join(f.root, "calls.jsonl"), entry = await databaseServer(f.root, "disconnect-sentinel", trace, true);
  const direct = await publishDirect(f, "disconnect", "test", entry, 2), accepted = f.engine.start(direct.start);
  const status = await settled(f.engine, accepted.runId);
  assert.equal(status.state, "OUTCOME_UNKNOWN");
  assert.equal(f.repo.all("attempts").filter(attempt => attempt.runId === accepted.runId).length, 1);
  assert.equal(f.repo.all("attempts")[0].state, "OUTCOME_UNKNOWN");
  assert.equal(f.repo.events(accepted.runId).some(event => event.type === "TOOL_RETRY_SCHEDULED"), false);
  const before = hash({ run: f.repo.get("runs", accepted.runId), attempts: f.repo.all("attempts"), events: f.repo.events(accepted.runId) });
  f.engine.recover(); f.engine.recover();
  assert.equal(f.engine.start(direct.start).runId, accepted.runId);
  assert.throws(() => f.engine.resume(accepted.runId), { code: "STATE_INVALID" });
  assert.equal(hash({ run: f.repo.get("runs", accepted.runId), attempts: f.repo.all("attempts"), events: f.repo.events(accepted.runId) }), before);
  const calls = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].arguments.limit, 10);
});

test("RUN-04: declared text adapters preserve every original MCP content block through mapping, persistence and artifact_read", async t => {
  const f = await runtime(t, "raw-text"), entry = join(f.root, "text-only.mjs"), expected = { message: "中文 business@example.invalid 13900000001 token=password <原值>", count: 42 };
  const content = [
    { type: "text", text: '{"message":' + JSON.stringify(expected.message) },
    { type: "text", text: ',"count":42}' },
    { type: "resource_link", uri: "https://synthetic.invalid/owned-evidence", name: "合成证据原值" },
  ];
  await writeFile(entry, `import {McpServer,fromJsonSchema} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server"))};import {serveStdio} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/server/stdio"))};serveStdio(()=>{const s=new McpServer({name:'raw-text-fixture',version:'1'},{capabilities:{tools:{}}});s.registerTool('read',{inputSchema:fromJsonSchema({type:'object',properties:{},additionalProperties:false})},async()=>({content:${JSON.stringify(content)}}));return s;},{legacy:'serve'});`);
  const connection = await f.connectors.discover({ id: "raw-text", name: "raw-text", revision: 1, transport: "stdio", command: process.execPath, args: [entry], commandApproved: true, protocolEra: "auto", disabled: false, tools: [] });
  f.repo.put("connections", connection.id, connection);
  const binding = { id: "raw-text-binding", revision: 1, environment: "test", connectionId: connection.id, connectionRevision: connection.revision, allowedTools: ["read"], lockedArguments: {}, allowedQueryTemplates: [], simulationOnly: false, validationStatus: "BINDING_VERIFIED", maxRows: 10, timeoutSeconds: 5 };
  f.repo.put("bindings", binding.id, binding);
  const config = { bindingKey: "raw", toolName: "read", toolSchemaHash: connection.tools[0].schemaHash, argumentsMappings: {}, resultAdapterRef: "json_text" };
  f.author.create({ workflowId: "raw-text", name: "raw-text", environment: "test", mode: "auto", template: "blank", idempotencyKey: "create" });
  const patch = f.author.patch({ workflowId: "raw-text", expectedRevision: 1, idempotencyKey: "patch", operations: [
    { op: "set_binding", key: "raw", bindingId: binding.id }, { op: "add_node", nodeId: "read", nodeType: "mcp_tool", title: "Read original text", config },
    { op: "disconnect", source: "input", target: "end", port: "next" }, { op: "connect", source: "input", target: "read", port: "next" }, { op: "connect", source: "read", target: "end", port: "next" },
  ] });
  assert.deepEqual(patch.issues, []);
  f.author.publish({ workflowId: "raw-text", expectedRevision: patch.revision, version: "1.0.0", expectedBindingRevisions: { [binding.id]: 1 }, expectedCapabilityRevisions: {}, idempotencyKey: "publish" });
  const started = f.engine.start({ workflowId: "raw-text", version: "1.0.0", mode: "auto", inputs: {}, idempotencyKey: "start" }), status = await settled(f.engine, started.runId);
  assert.equal(status.state, "SUCCEEDED");
  assert.deepEqual(f.repo.get("runs", started.runId).outputs.read, expected);
  const rawArtifact = f.repo.all("artifacts").find(artifact => artifact.runId === started.runId && artifact.mimeType === "application/mcp+json")!;
  assert.ok(rawArtifact);
  assert.deepEqual(JSON.parse(rawArtifact.content).content, content);
  assert.equal(Object.hasOwn(JSON.parse(rawArtifact.content), "structuredContent"), false);
  const read = f.engine.readArtifact({ runId: started.runId, artifactId: rawArtifact.id, maxBytes: 262144 });
  assert.equal(read.content, rawArtifact.content);
  assert.deepEqual(JSON.parse(read.content).content, content);
  const text = await f.connectors.call(binding, { config: { ...config, resultAdapterRef: "text" } }, {}, 5000);
  assert.equal(text.text, content.filter(block => block.type === "text").map(block => block.text).join("\n"));
  assert.deepEqual(text.content, content);
  assert.deepEqual(text[MCP_RAW_RESULT].content, content);
  await assert.rejects(f.connectors.call(binding, { config: { ...config, resultAdapterRef: "structured" } }, {}, 5000), { code: "OUTPUT_ADAPTER_REQUIRED" });
});
