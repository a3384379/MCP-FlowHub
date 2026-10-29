import Database from "better-sqlite3";
import { chmodSync } from "node:fs";
import { hash, now, ensure, type Json } from "../../contracts/src/domain.js";
const TABLES = [
  "settings",
  "connections",
  "bindings",
  "workflows",
  "versions",
  "runs",
  "artifacts",
  "approvals",
  "secrets",
  "attempts",
  "clients",
] as const;
export type Table = (typeof TABLES)[number];
const repositoryDdl = TABLES.map(
  (t) =>
    "CREATE TABLE IF NOT EXISTS " +
    t +
    " (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL)",
).join(";");
const journalDdl =
  "CREATE TABLE IF NOT EXISTS commands(owner TEXT,operation TEXT,key TEXT,request_hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(owner,operation,key)); CREATE TABLE IF NOT EXISTS run_events(run_id TEXT,seq INTEGER,body TEXT NOT NULL,PRIMARY KEY(run_id,seq)); CREATE TABLE IF NOT EXISTS audit_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL)";
const migrationDdl =
  "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)";
const managedTables = [...TABLES, "commands", "run_events", "audit_events"];
// Derive required names, types, nullability and primary keys from the same DDL
// used to create new stores, without changing the existing v1 checksum.
const expectedLayouts = (() => {
  const reference = new Database(":memory:");
  try {
    reference.exec(migrationDdl + ";" + repositoryDdl + ";" + journalDdl);
    return new Map(
      ["schema_migrations", ...managedTables].map((table) => [
        table,
        hash(reference.pragma("table_info(" + table + ")")),
      ]),
    );
  } finally {
    reference.close();
  }
})();

/** Read-only compatibility check shared by startup and pre-replacement restore. */
export function validateMigrations(
  db: Database.Database,
  allowUninitialized = false,
) {
  const tables = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  const pristine = managedTables.every((table) => !tables.has(table));
  if (!tables.has("schema_migrations")) {
    ensure(
      allowUninitialized && pristine,
      "MIGRATION_MISMATCH",
      "Migration history is missing.",
      500,
    );
    return;
  }
  const checkLayout = (table: string) =>
    ensure(
      hash(db.pragma("table_info(" + table + ")")) ===
        expectedLayouts.get(table),
      "MIGRATION_MISMATCH",
      "Database columns or constraints do not match the recorded migration.",
      500,
    );
  checkLayout("schema_migrations");
  const history = db
    .prepare(
      "SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version",
    )
    .all() as { version: number; checksum: string }[];
  if (allowUninitialized && pristine && history.length === 0) return;
  ensure(
    history.length === 1 && history[0]!.version === 1,
    "MIGRATION_MISMATCH",
    "Migration history is unsupported by this program.",
    500,
  );
  ensure(
    history[0]!.checksum === hash(repositoryDdl),
    "MIGRATION_MISMATCH",
    "Migration checksum changed.",
    500,
  );
  ensure(
    managedTables.every((table) => tables.has(table)),
    "MIGRATION_MISMATCH",
    "Database tables do not match the recorded migration.",
    500,
  );
  for (const table of managedTables) checkLayout(table);
}

export class Repository {
  constructor(public db: Database.Database) {
    validateMigrations(db, true);
    db.exec(migrationDdl);
    db.transaction(() => {
      db.exec(repositoryDdl);
      db.exec(journalDdl);
      db.prepare("INSERT OR IGNORE INTO schema_migrations VALUES(1,?,?)").run(
        hash(repositoryDdl),
        now(),
      );
    })();
  }
  get<T = Json>(table: Table, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT body FROM " + table + " WHERE id=?")
      .get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  all<T = Json>(table: Table): T[] {
    return (
      this.db
        .prepare("SELECT body FROM " + table + " ORDER BY rowid")
        .all() as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  put(table: Table, id: string, value: Json, expected?: number) {
    if (expected !== undefined) {
      const row = this.db
        .prepare(
          "UPDATE " +
            table +
            " SET revision=?,body=? WHERE id=? AND revision=?",
        )
        .run(
          value.revision ?? expected + 1,
          JSON.stringify(value),
          id,
          expected,
        );
      ensure(
        row.changes === 1,
        "REVISION_CONFLICT",
        "Reload before saving.",
        409,
      );
    } else
      this.db
        .prepare(
          "INSERT INTO " +
            table +
            "(id,revision,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body",
        )
        .run(id, value.revision ?? 1, JSON.stringify(value));
  }
  insert(table: Table, id: string, value: Json) {
    ensure(
      !this.get(table, id),
      "VERSION_MISMATCH",
      "Record already exists.",
      409,
    );
    this.db
      .prepare("INSERT INTO " + table + " VALUES(?,?,?)")
      .run(id, value.revision ?? 1, JSON.stringify(value));
  }
  remove(table: Table, id: string) {
    this.db.prepare("DELETE FROM " + table + " WHERE id=?").run(id);
  }
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
  event(runId: string, type: string, payload: Json = {}) {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(seq),0)+1 AS n FROM run_events WHERE run_id=?",
      )
      .get(runId) as { n: number };
    const event = { seq: row.n, type, ...payload, createdAt: now() };
    this.db
      .prepare("INSERT INTO run_events VALUES(?,?,?)")
      .run(runId, row.n, JSON.stringify(event));
    return event;
  }
  events(runId: string, after = 0, limit = 50): Json[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?",
        )
        .all(runId, after, limit) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  command(
    owner: string,
    operation: string,
    key: string,
    request: Json,
    fn: () => Json,
  ): Json {
    return this.tx(() => {
      const prior = this.db
        .prepare(
          "SELECT request_hash,response FROM commands WHERE owner=? AND operation=? AND key=?",
        )
        .get(owner, operation, key) as
        | { request_hash: string; response: string }
        | undefined;
      if (prior) {
        ensure(
          prior.request_hash === hash(request),
          "IDEMPOTENCY_CONFLICT",
          "Key already used with different content.",
          409,
        );
        return JSON.parse(prior.response);
      }
      const response = fn();
      this.db
        .prepare("INSERT INTO commands VALUES(?,?,?,?,?)")
        .run(owner, operation, key, hash(request), JSON.stringify(response));
      return response;
    });
  }
  audit(actor: string, action: string, targetId: string, outcome = "accepted") {
    this.db
      .prepare("INSERT INTO audit_events(body) VALUES(?)")
      .run(
        JSON.stringify({ actor, action, targetId, outcome, createdAt: now() }),
      );
  }
  async backup(path: string) {
    await this.db.backup(path);
    chmodSync(path, 0o600);
  }
}
