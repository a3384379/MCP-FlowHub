import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { assertRestoreComplete } from "./restore-journal.js";

/** S0 validates native SQLite/WAL and restart durability; no workflow engine yet. */
export function openStore(path: string) {
  assertRestoreComplete(path);
  const db = new Database(path);
  try {
    chmodSync(path, 0o600);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.transaction(() => {
      db.exec(
        "CREATE TABLE IF NOT EXISTS poc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      db.prepare("INSERT OR IGNORE INTO poc_meta VALUES (?, ?)").run(
        "instance_id",
        randomUUID(),
      );
      db.prepare("INSERT OR IGNORE INTO poc_meta VALUES (?, ?)").run(
        "boots",
        "0",
      );
      db.prepare(
        "UPDATE poc_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'boots'",
      ).run();
    })();
    const get = (key: string) =>
      (
        db.prepare("SELECT value FROM poc_meta WHERE key = ?").get(key) as {
          value: string;
        }
      ).value;
    return {
      db,
      instanceId: get("instance_id"),
      boots: Number(get("boots")),
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
