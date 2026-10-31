import Database from "better-sqlite3";
import { hash, now, ensure } from "../../contracts/src/domain.js";
import { V1_TABLES, V1_REPOSITORY_DDL, V1_JOURNAL_DDL } from "./v1.js";

export const MIGRATION_DDL = "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)";
export type Migration = { version: number; ddl: string; checksum: string; tables: readonly string[] };
export const MIGRATIONS: readonly Migration[] = [{
  version: 1, ddl: V1_REPOSITORY_DDL + ";" + V1_JOURNAL_DDL,
  checksum: hash(V1_REPOSITORY_DDL),
  tables: [...V1_TABLES, "commands", "run_events", "audit_events"],
}];

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
    return history.length;
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
