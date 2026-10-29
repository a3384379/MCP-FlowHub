import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  unlink,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { openStore } from "../../packages/persistence/src/index.js";
import { Repository } from "../../packages/persistence/src/repository.js";
import { restoreBackup } from "../../packages/persistence/src/maintenance.js";
import { restoreJournalPath } from "../../packages/persistence/src/restore-journal.js";
import { startDaemon } from "../../apps/daemon/src/index.js";

const cli = resolve("dist/apps/daemon/src/cli.js");
const preloadSource = `
import fs from 'node:fs/promises';
import { basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const point = process.env.FLOWHUB_RESTORE_FAULT;
const rename = fs.rename;
fs.rename = async (source, destination) => {
  const old = basename(source) === 'flowhub.sqlite' && basename(destination).startsWith('replaced-');
  const next = basename(source).startsWith('restore-') && basename(destination) === 'flowhub.sqlite';
  if ((old && point === 'before-old') || (next && point === 'before-new')) process.exit(86);
  await rename(source, destination);
  if ((old && point === 'after-old') || (next && point === 'after-new')) process.exit(86);
};
const unlink = fs.unlink;
fs.unlink = async (path) => {
  await unlink(path);
  if (point === 'after-wal' && basename(path) === 'flowhub.sqlite-wal') process.exit(86);
};
syncBuiltinESMExports();
`;

async function paths() {
  const root = await mkdtemp(join(tmpdir(), "flowhub-restore-interruption-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir);
  const preload = join(root, "crash-preload.mjs");
  await writeFile(preload, preloadSource);
  return {
    root,
    dataDir,
    target: join(dataDir, "flowhub.sqlite"),
    source: join(root, "backup.sqlite"),
    preload,
  };
}

function sentinel(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare("SELECT body FROM settings WHERE id='restore-sentinel'")
      .get() as { body: string };
    return JSON.parse(row.body).value;
  } finally {
    db.close();
  }
}

async function interruptedRestore(
  p: Awaited<ReturnType<typeof paths>>,
  point: string,
) {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(p.preload).href,
      cli,
      "restore",
      "--data-dir",
      p.dataDir,
      "--backup",
      p.source,
    ],
    {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, FLOWHUB_RESTORE_FAULT: point },
    },
  );
  assert.equal(child.status, 86, child.stderr + String(child.error ?? ""));
  const lock = JSON.parse(
    await readFile(join(p.dataDir, "daemon.lock"), "utf8"),
  );
  assert.equal(lock.pid, child.pid);
  // spawnSync has confirmed this exact lock owner exited before removal.
  await unlink(join(p.dataDir, "daemon.lock"));
  const journalPath = restoreJournalPath(p.target);
  const journalText = await readFile(journalPath, "utf8");
  assert.throws(() => openStore(p.target), /RESTORE_INCOMPLETE/);
  await assert.rejects(
    startDaemon({ dataDir: p.dataDir, port: 0 }),
    /RESTORE_INCOMPLETE/,
  );
  assert.equal(await readFile(journalPath, "utf8"), journalText);
  return { journal: JSON.parse(journalText), journalText };
}

for (const point of ["before-old", "after-old", "before-new", "after-new"]) {
  test(
    "interrupted restore at " +
      point +
      " blocks startup and explicitly recovers the preserved previous database",
    async (t) => {
      const p = await paths();
      t.after(() => rm(p.root, { recursive: true, force: true }));
      const store = openStore(p.target);
      const instanceId = store.instanceId;
      try {
        const repo = new Repository(store.db);
        repo.put("settings", "restore-sentinel", {
          value: "REQUESTED_BACKUP_SYNTHETIC_STATE",
        });
        await repo.backup(p.source);
        repo.put("settings", "restore-sentinel", {
          value: "PREVIOUS_SYNTHETIC_STATE",
        });
      } finally {
        store.close();
      }
      const { journal, journalText } = await interruptedRestore(p, point);
      assert.equal(
        sentinel(journal.previousBackup),
        "PREVIOUS_SYNTHETIC_STATE",
      );
      if (point === "after-old" || point === "before-new")
        await assert.rejects(stat(p.target), { code: "ENOENT" });
      if (
        point === "after-old" ||
        point === "before-new" ||
        point === "after-new"
      )
        assert.equal(sentinel(journal.oldPath), "PREVIOUS_SYNTHETIC_STATE");
      const recovered = await restoreBackup(p.dataDir, journal.previousBackup);
      assert.equal(recovered.restored, true);
      assert.ok(recovered.previousJournal);
      assert.equal(
        await readFile(recovered.previousJournal, "utf8"),
        journalText,
      );
      await assert.rejects(stat(restoreJournalPath(p.target)), {
        code: "ENOENT",
      });
      assert.equal(
        sentinel(journal.previousBackup),
        "PREVIOUS_SYNTHETIC_STATE",
      );
      const reopened = openStore(p.target);
      try {
        assert.equal(reopened.instanceId, instanceId);
        assert.equal(
          new Repository(reopened.db).get("settings", "restore-sentinel").value,
          "PREVIOUS_SYNTHETIC_STATE",
        );
      } finally {
        reopened.close();
      }
    },
  );
}

test("a restore interrupted after deleting committed WAL blocks stale startup and retains latest data in the previous backup", async (t) => {
  const p = await paths();
  t.after(() => rm(p.root, { recursive: true, force: true }));
  const writerPath = join(p.root, "wal-writer.mjs");
  const storeUrl = pathToFileURL(
    resolve("dist/packages/persistence/src/index.js"),
  ).href;
  const repoUrl = pathToFileURL(
    resolve("dist/packages/persistence/src/repository.js"),
  ).href;
  await writeFile(
    writerPath,
    `
import { openStore } from ${JSON.stringify(storeUrl)};
import { Repository } from ${JSON.stringify(repoUrl)};
const store = openStore(process.argv[2]), repo = new Repository(store.db);
repo.put('settings', 'restore-sentinel', { value: 'BASE_SYNTHETIC_STATE' });
await repo.backup(process.argv[3]);
store.db.pragma('wal_checkpoint(TRUNCATE)');
store.db.pragma('wal_autocheckpoint=0');
repo.put('settings', 'restore-sentinel', { value: 'LATEST_COMMITTED_SYNTHETIC_STATE' });
process.stdout.write('READY\\n');
setInterval(() => {}, 60000);
`,
  );
  const writer = spawn(process.execPath, [writerPath, p.target, p.source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (writer.exitCode === null && writer.signalCode === null) {
      const exited = once(writer, "exit");
      writer.kill("SIGKILL");
      await exited;
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((ready, reject) => {
      let output = "";
      timer = setTimeout(
        () => reject(new Error("WAL writer did not become ready")),
        10000,
      );
      writer.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("READY\n")) ready();
      });
      writer.on("error", reject);
      writer.on("exit", (code) =>
        reject(new Error("WAL writer exited " + code)),
      );
    });
  } finally {
    clearTimeout(timer);
  }
  const exited = once(writer, "exit");
  writer.kill("SIGKILL");
  await exited;
  assert.ok((await stat(p.target + "-wal")).size > 0);
  const { journal } = await interruptedRestore(p, "after-wal");
  assert.equal(
    sentinel(journal.previousBackup),
    "LATEST_COMMITTED_SYNTHETIC_STATE",
  );
  await restoreBackup(p.dataDir, journal.previousBackup);
  assert.equal(sentinel(p.target), "LATEST_COMMITTED_SYNTHETIC_STATE");
});

test("empty, malformed and unsupported restore markers block new-store initialization and explicit restore archives them", async (t) => {
  for (const marker of ["", "{broken", '{"version":999}']) {
    const p = await paths();
    t.after(() => rm(p.root, { recursive: true, force: true }));
    const source = openStore(p.source);
    try {
      new Repository(source.db).put("settings", "restore-sentinel", {
        value: "VERIFIED_SYNTHETIC_BACKUP",
      });
    } finally {
      source.close();
    }
    await writeFile(restoreJournalPath(p.target), marker);
    assert.throws(() => openStore(p.target), /RESTORE_INCOMPLETE/);
    await assert.rejects(stat(p.target), { code: "ENOENT" });
    const restored = await restoreBackup(p.dataDir, p.source);
    assert.equal(await readFile(restored.previousJournal!, "utf8"), marker);
    assert.equal(sentinel(p.target), "VERIFIED_SYNTHETIC_BACKUP");
    await assert.rejects(stat(restoreJournalPath(p.target)), {
      code: "ENOENT",
    });
  }
});
