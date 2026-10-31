import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { MIGRATIONS, migrate, validateMigrations } from "../../packages/persistence/src/migrations.js";
import { hash } from "../../packages/contracts/src/domain.js";
import { V1_REPOSITORY_DDL } from "../../packages/persistence/src/v1.js";

test("sequential migrations preserve a real v1 layout and immutable snapshot bytes", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const checksum = hash(V1_REPOSITORY_DDL);
    assert.equal(checksum, "39b4d8eab1f40befe28a3c7642a8e6b2b9398e1aa6a7e3895f74d572c4c88784");
    db.prepare("INSERT INTO versions VALUES(?,?,?)").run("old@1", 1, '{"contentHash":"original","business":"中文 token=literal"}');
    const before = db.prepare("SELECT body FROM versions").get();
    const ddl = "CREATE TABLE extension(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL)";
    const registry = [...MIGRATIONS, {version:2,ddl,checksum:hash(ddl),tables:["extension"]}];
    migrate(db, registry);
    assert.equal(validateMigrations(db, false, registry), 2);
    assert.deepEqual(db.prepare("SELECT body FROM versions").get(), before);
    assert.equal((db.prepare("SELECT checksum FROM schema_migrations WHERE version=1").get() as {checksum:string}).checksum, checksum);
    assert.throws(() => validateMigrations(db), { code:"FUTURE_SCHEMA_VERSION" });
  } finally { db.close(); }
});

test("damaged history, missing columns, gaps and future versions never rebuild stores", () => {
  for (const sql of ["UPDATE schema_migrations SET checksum='broken'", "DROP TABLE runs", "ALTER TABLE runs RENAME COLUMN revision TO changed", "UPDATE schema_migrations SET version=99"]) {
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
    const registry = [...MIGRATIONS, {version:2,ddl:"CREATE TABLE staged(id TEXT); INVALID SQL",checksum:"fail",tables:["staged"]}];
    assert.throws(() => migrate(db, registry));
    assert.deepEqual(db.prepare("SELECT * FROM schema_migrations").all(), before);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='staged'").get(), undefined);
    assert.equal(validateMigrations(db), 1);
  } finally { db.close(); }
});
