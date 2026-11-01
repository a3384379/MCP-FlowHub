import Database from "better-sqlite3";
import { hash, now, ensure, HubError } from "../../contracts/src/domain.js";
import { V1_TABLES, V1_REPOSITORY_DDL, V1_JOURNAL_DDL } from "./v1.js";
import { V2_MIGRATION } from "./v2.js";
import { V3_MIGRATION } from "./v3.js";

export const MIGRATION_DDL = "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)";
export type Migration = { version: number; ddl: string; checksum: string; tables: readonly string[] };
export const MIGRATIONS: readonly Migration[] = [{
  version: 1, ddl: V1_REPOSITORY_DDL + ";" + V1_JOURNAL_DDL,
  checksum: hash(V1_REPOSITORY_DDL),
  tables: [...V1_TABLES, "commands", "run_events", "audit_events"],
}, V2_MIGRATION, V3_MIGRATION];

/** Read-only validation accepts only a complete known prefix; never repairs history. */
export function validateMigrations(db: Database.Database, allowUninitialized = false, registry = MIGRATIONS) {
  const existing = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name: string}[]).map(x => x.name));
  const pristine = registry.flatMap(m => [...m.tables]).every(t => !existing.has(t));
  if (!existing.has("schema_migrations")) {
    ensure(allowUninitialized && pristine, "MIGRATION_MISMATCH", "Migration history is missing.", 500);
    return 0;
  }
  const reference = new Database(":memory:");
  try {
    reference.exec(MIGRATION_DDL);
    const layout = (table: string) => ensure(hash(db.pragma("table_info(" + table + ")")) === hash(reference.pragma("table_info(" + table + ")")),
      "MIGRATION_MISMATCH", "Database columns or constraints do not match migration: " + table, 500);
    layout("schema_migrations");
    const history = db.prepare("SELECT version,checksum FROM schema_migrations ORDER BY version").all() as {version:number;checksum:string}[];
    ensure(!history.some(h => h.version > registry.length), "FUTURE_SCHEMA_VERSION", "Database requires a newer FlowHub program.", 500);
    ensure(history.length > 0 || (allowUninitialized && pristine), "MIGRATION_MISMATCH", "Migration history is empty.", 500);
    history.forEach((h, i) => {
      const migration = registry[i];
      ensure(migration && h.version === i + 1 && migration.version === h.version && migration.checksum === h.checksum,
        "MIGRATION_MISMATCH", "Migration prefix or checksum changed.", 500);
      reference.exec(migration.ddl);
    });
    for (const m of registry.slice(0, history.length)) for (const table of m.tables) {
      ensure(existing.has(table), "MIGRATION_MISMATCH", "Missing migrated table: " + table, 500);
      layout(table);
    }
    for (const m of registry.slice(history.length)) for (const table of m.tables)
      ensure(!existing.has(table), "MIGRATION_MISMATCH", "Unrecorded migration table: " + table, 500);
    // table_info omits CHECK/FK clauses, virtual-table modules and hidden FTS
    // columns. Compare the actual recorded DDL as well, including generated
    // shadow tables and automatic indexes. This is read-only on the input and
    // leaves the frozen migration bytes/checksums untouched.
    type SchemaObject = { type:string; name:string; tbl_name:string; sql:string|null };
    const objects=reference.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') ORDER BY type,name").all() as SchemaObject[];
    for(const object of objects) {
      const actual=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name=?").get(object.name) as SchemaObject|undefined;
      ensure(actual && hash(actual)===hash(object),"MIGRATION_MISMATCH","Required migration schema differs: "+object.name,500);
      if(object.type==="table")
        ensure(hash(db.pragma("table_xinfo("+object.name+")"))===hash(reference.pragma("table_xinfo("+object.name+")")),
          "MIGRATION_MISMATCH","Required migration table layout differs: "+object.name,500);
    }
    return history.length;
  } catch(error) {
    if(error instanceof HubError)throw error;
    // A broken virtual-table shadow can make even PRAGMA table_info fail.
    // Report that as a schema mismatch, never as an opportunity to rebuild it.
    throw new HubError("MIGRATION_MISMATCH","Database schema could not be validated.",500);
  } finally { reference.close(); }
}

export function migrate(db: Database.Database, registry = MIGRATIONS) {
  const count = validateMigrations(db, true, registry);
  db.transaction(() => {
    db.exec(MIGRATION_DDL);
    for (const m of registry.slice(count)) {
      db.exec(m.ddl);
      db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(m.version, m.checksum, now());
    }
    validateMigrations(db, false, registry);
  })();
}
