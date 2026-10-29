import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDaemon } from "../../apps/daemon/src/index.js";
import { openStore } from "../../packages/persistence/src/index.js";
import { Repository } from "../../packages/persistence/src/repository.js";
import { restoreBackup } from "../../packages/persistence/src/maintenance.js";

const corruptions: [string, (db: Database.Database) => void][] = [
  [
    "changed checksum",
    (db) => {
      db.prepare("UPDATE schema_migrations SET checksum=? WHERE version=1").run(
        "f".repeat(64),
      );
    },
  ],
  [
    "unsupported migration",
    (db) => {
      db.prepare("INSERT INTO schema_migrations VALUES(2,?,?)").run(
        "synthetic",
        new Date().toISOString(),
      );
    },
  ],
  [
    "missing migration",
    (db) => {
      db.exec("DELETE FROM schema_migrations");
    },
  ],
  [
    "missing managed table",
    (db) => {
      db.exec("DROP TABLE approvals");
    },
  ],
  [
    "incomplete table",
    (db) => {
      db.exec("ALTER TABLE runs RENAME COLUMN body TO missing_body");
    },
  ],
  [
    "missing primary key",
    (db) => {
      db.exec(
        "ALTER TABLE settings RENAME TO old_settings; CREATE TABLE settings(id TEXT, revision INTEGER NOT NULL, body TEXT NOT NULL); INSERT INTO settings SELECT * FROM old_settings; DROP TABLE old_settings",
      );
    },
  ],
  [
    "missing null constraint",
    (db) => {
      db.exec(
        "ALTER TABLE settings RENAME TO old_settings; CREATE TABLE settings(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT); INSERT INTO settings SELECT * FROM old_settings; DROP TABLE old_settings",
      );
    },
  ],
];

for (const [label, corrupt] of corruptions) {
  test(
    "restore rejects " +
      label +
      " before replacement and the original daemon can restart",
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "flowhub-restore-preflight-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const dataDir = join(root, "data");
      await mkdir(dataDir);
      const target = join(dataDir, "flowhub.sqlite");
      const source = join(root, "backup.sqlite");
      const store = openStore(target);
      try {
        const repo = new Repository(store.db);
        repo.put("settings", "restore-sentinel", {
          value: "ORIGINAL_SYNTHETIC_STATE",
        });
        await repo.backup(source);
      } finally {
        store.close();
      }
      const original = await readFile(target);
      const backup = new Database(source);
      try {
        backup
          .prepare("UPDATE settings SET body=? WHERE id='restore-sentinel'")
          .run(JSON.stringify({ value: "BAD_BACKUP_SYNTHETIC_STATE" }));
        corrupt(backup);
        assert.equal(backup.pragma("integrity_check", { simple: true }), "ok");
        assert.throws(() => new Repository(backup));
      } finally {
        backup.close();
      }
      await assert.rejects(restoreBackup(dataDir, source), (error: unknown) => {
        assert.equal((error as { code?: string }).code, "BACKUP_INCOMPATIBLE");
        return true;
      });
      assert.deepEqual(await readFile(target), original);
      assert.deepEqual(await readdir(dataDir), ["flowhub.sqlite"]);
      const daemon = await startDaemon({ dataDir, port: 0 });
      try {
        assert.equal(
          daemon.engine.repo.get("settings", "restore-sentinel").value,
          "ORIGINAL_SYNTHETIC_STATE",
        );
      } finally {
        await daemon.close();
      }
    },
  );
}

test("a compatible backup restores and preserves a usable copy of the replaced database", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "flowhub-restore-compatible-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  await mkdir(dataDir);
  const target = join(dataDir, "flowhub.sqlite");
  const source = join(root, "backup.sqlite");
  const store = openStore(target);
  try {
    const repo = new Repository(store.db);
    repo.put("settings", "restore-sentinel", {
      value: "BACKUP_SYNTHETIC_STATE",
    });
    await repo.backup(source);
    repo.put("settings", "restore-sentinel", {
      value: "CURRENT_SYNTHETIC_STATE",
    });
  } finally {
    store.close();
  }
  const result = await restoreBackup(dataDir, source);
  assert.equal(result.restored, true);
  assert.ok(result.previousBackup);
  for (const [path, expected] of [
    [target, "BACKUP_SYNTHETIC_STATE"],
    [result.previousBackup, "CURRENT_SYNTHETIC_STATE"],
  ]) {
    const db = new Database(path!);
    try {
      const repo = new Repository(db);
      assert.equal(repo.get("settings", "restore-sentinel").value, expected);
    } finally {
      db.close();
    }
  }
});
