import Database from "better-sqlite3";
import { chmodSync } from "node:fs";
import { hash, now, ensure, type Json } from "../../contracts/src/domain.js";
import { V1_TABLES } from "./v1.js";
import { migrate } from "./migrations.js";
export { validateMigrations } from "./migrations.js";
export type Table = (typeof V1_TABLES)[number];
export class Repository {
  constructor(public db: Database.Database) {
    migrate(db);
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
