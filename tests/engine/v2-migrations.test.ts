import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { MIGRATIONS, migrate, validateMigrations } from "../../packages/persistence/src/migrations.js";
import { hash } from "../../packages/contracts/src/domain.js";
import { V1_REPOSITORY_DDL } from "../../packages/persistence/src/v1.js";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../packages/persistence/src/index.js";
import { Repository } from "../../packages/persistence/src/repository.js";
import { inspectBackup, restoreBackup } from "../../packages/persistence/src/maintenance.js";

test("sequential migrations preserve a real v1 layout and immutable snapshot bytes", () => {
  const db = new Database(":memory:");
  try {
    migrate(db, MIGRATIONS.slice(0, 1));
    const checksum = hash(V1_REPOSITORY_DDL);
    assert.equal(checksum, "39b4d8eab1f40befe28a3c7642a8e6b2b9398e1aa6a7e3895f74d572c4c88784");
    db.prepare("INSERT INTO versions VALUES(?,?,?)").run("old@1", 1, '{"contentHash":"original","business":"中文 token=literal"}');
    const before = db.prepare("SELECT body FROM versions").get();
    const ddl = "CREATE TABLE extension(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL)";
    const registry = [...MIGRATIONS, {version:MIGRATIONS.length+1,ddl,checksum:hash(ddl),tables:["extension"]}];
    migrate(db, registry);
    assert.equal(validateMigrations(db, false, registry), registry.length);
    assert.deepEqual(db.prepare("SELECT body FROM versions").get(), before);
    assert.equal((db.prepare("SELECT checksum FROM schema_migrations WHERE version=1").get() as {checksum:string}).checksum, checksum);
    assert.throws(() => validateMigrations(db), { code:"FUTURE_SCHEMA_VERSION" });
  } finally { db.close(); }
});

test("damaged history, missing columns, gaps and future versions never rebuild stores", () => {
  for (const sql of ["UPDATE schema_migrations SET checksum='broken'", "DROP TABLE runs", "ALTER TABLE runs RENAME COLUMN revision TO changed", "UPDATE schema_migrations SET version=99 WHERE version=1"]) {
    const db = new Database(":memory:");
    try { migrate(db); db.exec(sql); assert.throws(() => migrate(db)); }
    finally { db.close(); }
  }
});

test("failed multi-step migration rolls back DDL and history together", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const before = db.prepare("SELECT * FROM schema_migrations").all();
    const registry = [...MIGRATIONS, {version:MIGRATIONS.length+1,ddl:"CREATE TABLE staged(id TEXT); INVALID SQL",checksum:"fail",tables:["staged"]}];
    assert.throws(() => migrate(db, registry));
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations").all(), before);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='staged'").get(), undefined);
    assert.equal(validateMigrations(db), MIGRATIONS.length);
  } finally { db.close(); }
});

test("v2 to v3 preserves frozen migration bytes and business snapshots; Chinese descriptions survive backup and restore", async t => {
  const root = await mkdtemp(join(tmpdir(), "flowhub-v3-preserve-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "old.sqlite"), old = openStore(path);
  migrate(old.db, MIGRATIONS.slice(0, 2));
  const history = old.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), original = '{"id":"immutable@1","business":"中文 password=literal","snapshot":{"model":"keep"}}';
  old.db.prepare("INSERT INTO versions VALUES(?,?,?)").run("immutable@1", 1, original); old.close();
  const current = openStore(path), repo = new Repository(current.db);
  assert.deepEqual(current.db.prepare("SELECT * FROM schema_migrations WHERE version<=2 ORDER BY version").all(), history);
  assert.equal((current.db.prepare("SELECT body FROM versions WHERE id='immutable@1'").get() as any).body, original);
  repo.put("discovery_entities", "entity", { id: "entity", revision: 1, name: "raw_tool", sourceFingerprint: "raw-hash" });
  repo.put("discovery_presentations", "localized", { id: "localized", revision: 2, entityId: "entity", displayName: "手工说明", authorship: "manual", sourceFingerprint: "raw-hash" });
  const backup = join(root, "saved.sqlite"); await repo.backup(backup); assert.equal(inspectBackup(backup).compatible, true); current.close();
  const target = join(root, "restored"); await mkdir(target); await restoreBackup(target, backup);
  const restored = openStore(join(target, "flowhub.sqlite")); try {
    const result = new Repository(restored.db); assert.equal(result.get("discovery_presentations", "localized")?.displayName, "手工说明");
    assert.equal(result.get("discovery_entities", "entity")?.name, "raw_tool"); assert.equal((restored.db.prepare("SELECT body FROM versions WHERE id='immutable@1'").get() as any).body, original);
  } finally { restored.close(); }
});
