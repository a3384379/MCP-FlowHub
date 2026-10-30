import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { startDaemon } from "../../apps/daemon/src/index.js";
import {
  hostIntegration,
  localCliPath,
  offlineRestoreInstructions,
  tomlString,
} from "../../packages/admin-api/src/settings-integration.js";
import type { Json } from "../../packages/contracts/src/domain.js";

test("Codex TOML and Claude JSON use actual separate formats and explicit scoped token-file paths", () => {
  const paths = {
    runtimePath: "C:\\Program Files\\FlowHub\\runtime\\node.exe",
    cliPath: "C:\\Program Files\\FlowHub\\app\\dist\\cli.js",
    dataDir: 'C:\\Users\\演示用户\\FlowHub "demo"',
    tokenFile: 'C:\\Users\\演示用户\\FlowHub "demo"\\clients\\scoped.token',
  };
  const integration = hostIntegration(paths);
  assert.match(integration.codexToml, /^\[mcp_servers\.flowhub\]\n/);
  assert.ok(!integration.codexToml.includes("mcpServers"));
  assert.ok(
    integration.codexToml.includes(
      'command = "C:\\\\Program Files\\\\FlowHub\\\\runtime\\\\node.exe"',
    ),
  );
  const argsLine = integration.codexToml
    .split("\n")
    .find((line) => line.startsWith("args = "))!;
  const args = JSON.parse(argsLine.slice("args = ".length));
  assert.deepEqual(args, [
    paths.cliPath,
    "mcp",
    "--stdio",
    "--data-dir",
    paths.dataDir,
    "--token-file",
    paths.tokenFile,
  ]);
  assert.deepEqual(JSON.parse(integration.claudeJson), {
    mcpServers: { flowhub: { command: paths.runtimePath, args } },
  });
  assert.equal(tomlString('a\u007fb\n\t"\\'), '"a\\u007Fb\\n\\t\\"\\\\"');
  assert.throws(
    () => hostIntegration({ ...paths, tokenFile: "clients/scoped.token" }),
    /absolute/,
  );
  assert.equal(isAbsolute(localCliPath), true);
  assert.match(localCliPath, /apps[\\/]daemon[\\/]src[\\/]cli\.js$/);
});

test("offline restore commands quote spaces, quotes and shell metacharacters without evaluating paths", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "flowhub restore quoted "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cliPath = join(directory, "cli ' quoted.js");
  await writeFile(
    cliPath,
    "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
  );
  const dataDir = join(directory, "data ' $HOME `id` $(id)");
  const backupPath = join(directory, "backup ' quoted.sqlite");
  const instructions = offlineRestoreInstructions({
    runtimePath: process.execPath,
    cliPath,
    dataDir,
    backupPath,
    platform: "linux",
  });
  if (process.platform !== "win32") {
    const args = JSON.parse(
      execFileSync("sh", ["-c", instructions.restoreCommand], {
        encoding: "utf8",
      }),
    );
    assert.deepEqual(args, [
      "restore",
      "--data-dir",
      dataDir,
      "--backup",
      backupPath,
    ]);
  }
  assert.ok(instructions.steps.some((step) => step.includes("Ctrl+C")));
  assert.ok(instructions.steps.some((step) => step.includes("daemon.lock")));
  const windows = offlineRestoreInstructions({
    runtimePath: "C:\\Flow Hub\\node.exe",
    cliPath: "C:\\Flow Hub\\cli.js",
    dataDir: "C:\\User's data",
    backupPath: "C:\\User's data\\backups\\x.sqlite",
    platform: "win32",
  });
  assert.equal(windows.shell, "PowerShell");
  assert.match(windows.restoreCommand, /^& 'C:\\Flow Hub\\node\.exe' /);
  assert.ok(windows.restoreCommand.includes("'C:\\User''s data'"));
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const requestedDataDir = await mkdtemp(join(tmpdir(), "flowhub settings 受限 "));
  const dataDir = await realpath(requestedDataDir);
  const daemon = await startDaemon({ dataDir: requestedDataDir, port: 0 });
  t.after(async () => {
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + daemon.port + "/api/v1";
  const bootstrap = await fetch(base + "/auth/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      setupToken: await readFile(join(dataDir, "admin-setup-token"), "utf8"),
      password: "Settings-synthetic-password-42",
    }),
  });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
  const csrf = ((await bootstrap.json()) as Json).data.csrf;
  const api = async (path: string, value?: Json) => {
    const response = await fetch(base + path, {
      method: value === undefined ? "GET" : "POST",
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        ...(value === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    return { status: response.status, ...((await response.json()) as Json) };
  };
  return { dataDir, daemon, api, base, cookie };
}

test("settings and new/reloaded restricted clients return current-machine paths without token values", async (t) => {
  const { dataDir, api, daemon } = await fixture(t);
  const settings = await api("/settings");
  assert.equal(settings.status, 200);
  assert.equal(settings.data.runtimePath, process.execPath);
  assert.equal(settings.data.cliPath, localCliPath);
  assert.equal(settings.data.dataDir, dataDir);
  assert.equal(
    settings.data.mcpEndpoint,
    "http://127.0.0.1:" + daemon.port + "/mcp",
  );
  assert.equal(settings.data.hostVerification.status, "not_performed");
  const created = await api("/clients", {
    label: "Only staging",
    workflowAllowlist: ["incident-staging"],
  });
  assert.equal(created.status, 200);
  assert.equal(
    created.data.absoluteTokenFile,
    join(dataDir, created.data.tokenFile),
  );
  const token = await readFile(created.data.absoluteTokenFile, "utf8");
  assert.ok(!JSON.stringify(created).includes(token));
  assert.deepEqual(created.data.hostIntegration.args.slice(-2), [
    "--token-file",
    created.data.absoluteTokenFile,
  ]);
  const list = await api("/clients");
  const client = list.data.find((item: Json) => item.id === created.data.id);
  assert.deepEqual(client.hostIntegration, created.data.hostIntegration);
  assert.equal(client.tokenHash, undefined);
  assert.ok(!JSON.stringify(list).includes(token));
  await api("/clients/" + created.data.id + "/revoke", {});
  assert.equal(
    (await api("/clients")).data.find(
      (item: Json) => item.id === created.data.id,
    ).hostIntegration,
    null,
  );
});

test("backup listing exposes local metadata and preflight leaves original backup and active business state untouched", async (t) => {
  const { dataDir, api, daemon, base, cookie } = await fixture(t);
  assert.deepEqual((await api("/backups")).data.files, []);
  const created = await api("/backups", {});
  assert.equal(created.status, 200);
  assert.equal(
    created.data.path,
    join(dataDir, "backups", created.data.filename),
  );
  const original = await readFile(created.data.path);
  daemon.engine.repo.put("settings", "preflight-sentinel", {
    value: "CURRENT_STATE",
  });
  const listed = (await api("/backups")).data;
  assert.equal(listed.directory, join(dataDir, "backups"));
  assert.equal(listed.files[0].filename, created.data.filename);
  assert.equal(listed.files[0].sizeBytes, original.length);
  const dataFiles = (await readdir(dataDir)).sort();
  const backupFiles = (await readdir(listed.directory)).sort();
  const checked = await api("/backups/preflight", {
    filename: created.data.filename,
  });
  assert.equal(checked.status, 200);
  assert.equal(checked.data.compatible, true);
  assert.equal(checked.data.integrity, "ok");
  assert.match(checked.data.instructions.restoreCommand, /restore/);
  assert.ok(
    checked.data.instructions.restoreCommand.includes(created.data.filename),
  );
  assert.equal(
    daemon.engine.repo.get("settings", "preflight-sentinel").value,
    "CURRENT_STATE",
  );
  assert.deepEqual(await readFile(created.data.path), original);
  assert.deepEqual((await readdir(dataDir)).sort(), dataFiles);
  assert.deepEqual((await readdir(listed.directory)).sort(), backupFiles);
  assert.equal(
    (
      await fetch(base + "/backups/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: created.data.filename }),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(base + "/backups/preflight", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ filename: created.data.filename }),
      })
    ).status,
    403,
  );
  assert.equal(
    (await api("/backups/restore", { filename: created.data.filename })).status,
    404,
  );
});

test("preflight rejects traversal, symlinks, hardlinks, non-files and SQLite sidecars", async (t) => {
  const { dataDir, api } = await fixture(t);
  const created = (await api("/backups", {})).data;
  for (const filename of [
    "../flowhub.sqlite",
    "..\\flowhub.sqlite",
    created.path,
    "/tmp/external.sqlite",
    "x/../../flowhub.sqlite",
  ]) {
    const checked = await api("/backups/preflight", { filename });
    assert.equal(checked.status, 422, filename);
    assert.equal(checked.error.code, "BACKUP_PATH_INVALID");
  }
  const directory = join(dataDir, "backups");
  await mkdir(join(directory, "directory.sqlite"));
  assert.equal(
    (await api("/backups/preflight", { filename: "directory.sqlite" })).error
      .code,
    "BACKUP_PATH_INVALID",
  );
  await link(created.path, join(directory, "hard.sqlite"));
  assert.equal(
    (await api("/backups/preflight", { filename: "hard.sqlite" })).error.code,
    "BACKUP_PATH_INVALID",
  );
  await rm(join(directory, "hard.sqlite"));
  if (process.platform !== "win32") {
    await symlink(created.path, join(directory, "linked.sqlite"));
    assert.equal(
      (await api("/backups/preflight", { filename: "linked.sqlite" })).error
        .code,
      "BACKUP_PATH_INVALID",
    );
  }
  await writeFile(created.path + "-wal", "synthetic sidecar");
  assert.equal(
    (await api("/backups/preflight", { filename: created.filename })).error
      .code,
    "BACKUP_NOT_STANDALONE",
  );
  await rm(created.path + "-wal");
  assert.equal(
    (await api("/backups/preflight", { filename: "missing.sqlite" })).status,
    404,
  );
  const files = (await api("/backups")).data.files;
  assert.ok(
    !files.some(
      (file: Json) =>
        file.filename === "linked.sqlite" || file.filename === "hard.sqlite",
    ),
  );
  assert.ok(!files.some((file: Json) => file.filename === "directory.sqlite"));
});

test("preflight reports invalid and incompatible snapshots without returning restore commands", async (t) => {
  const { dataDir, api } = await fixture(t);
  const created = (await api("/backups", {})).data;
  const db = new Database(created.path);
  db.pragma("journal_mode=DELETE");
  db.prepare("UPDATE schema_migrations SET checksum=? WHERE version=1").run(
    "f".repeat(64),
  );
  db.close();
  const checked = await api("/backups/preflight", {
    filename: created.filename,
  });
  assert.equal(checked.status, 200);
  assert.equal(checked.data.compatible, false);
  assert.equal(checked.data.errorCode, "BACKUP_INCOMPATIBLE");
  assert.equal(checked.data.instructions, null);
  await writeFile(join(dataDir, "backups", "invalid.sqlite"), "not a database");
  const invalid = await api("/backups/preflight", {
    filename: "invalid.sqlite",
  });
  assert.equal(invalid.data.compatible, false);
  assert.equal(invalid.data.errorCode, "BACKUP_INVALID");
  assert.equal(invalid.data.instructions, null);
});
