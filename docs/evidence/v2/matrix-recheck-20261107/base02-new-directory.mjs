import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const evidence = fileURLToPath(new URL("./", import.meta.url));
const buildRoot = process.cwd();
const require = createRequire(join(buildRoot, "package.json")), Database = require("better-sqlite3");
const { startDaemon } = await import(pathToFileURL(join(buildRoot, "dist/apps/daemon/src/index.js")));
const { MIGRATIONS, validateMigrations } = await import(pathToFileURL(join(buildRoot, "dist/packages/persistence/src/migrations.js")));
const root = await realpath(await mkdtemp(join(tmpdir(), "flowhub-base02-fresh-dir-"))), dataDir = join(root, "data");
let daemon;
try {
  await mkdir(dataDir); assert.deepEqual(await readdir(dataDir), []);
  daemon = await startDaemon({ dataDir, port: 0 });
  const history = daemon.engine.repo.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  assert.deepEqual(history.map(row => [row.version, row.checksum]), MIGRATIONS.map(m => [m.version, m.checksum]));
  assert.equal(validateMigrations(daemon.engine.repo.db), MIGRATIONS.length);
  for (const migration of MIGRATIONS) for (const table of migration.tables)
    assert.ok(daemon.engine.repo.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
  assert.equal((await fetch("http://127.0.0.1:" + daemon.port + "/api/v1/health")).status, 200);
  await daemon.close(); daemon = undefined;
  const readonly = new Database(join(dataDir, "flowhub.sqlite"), { readonly: true });
  try { assert.deepEqual(readonly.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), history); }
  finally { readonly.close(); }
  const receipt = { id: "BASE-02", status: "PASS", setup: "daemon starts in an actually empty isolated data directory", history, expectedVersions: MIGRATIONS.map(m => m.version), allManagedTablesVerified: MIGRATIONS.flatMap(m => m.tables), healthStatus: 200, survivedStoppedReopen: true, formalDataAccessed: false };
  await writeFile(join(evidence, "base02-new-directory.receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt, null, 2));
} finally { await daemon?.close(); await rm(root, { recursive: true, force: true }); }
