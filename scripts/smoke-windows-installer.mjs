import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyBundle } from "./verify-release.mjs";
import { assertWindowsBuild } from "./windows-installer.mjs";

assertWindowsBuild();
const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);
const metadata = JSON.parse(await readFile(join(root, "artifacts/latest-installer.json"), "utf8"));
const installer = resolve(metadata.installer);
assert.equal(createHash("sha256").update(await readFile(installer)).digest("hex"), metadata.installerSha256);
assert.ok(process.env.LOCALAPPDATA, "LOCALAPPDATA must refer to the current Windows test account.");
const dataDir = join(process.env.LOCALAPPDATA, "MCP-FlowHub");
try {
  await access(dataDir);
  throw new Error("INSTALLER_SMOKE_REQUIRES_CLEAN_ACCOUNT: The default data directory already exists. Use a clean disposable Windows account; existing user data will not be changed.");
} catch (error) { if (error.code !== "ENOENT") throw error; }

const temporary = await realpath(await mkdtemp(join(tmpdir(), "FlowHub 安装 smoke ")));
const installDir = join(temporary, "程序 files");
const extraRoot = join(installDir, "personal.txt");
const extraApp = join(installDir, "app/user-note.txt");
const sentinel = "FLOWHUB_SYNTHETIC_INSTALLER_SMOKE_DATA";
const checks = [];
const children = new Set();
let success = false;
let installed = false;
const env = Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"]
  .flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
// Installed applications do not get access to a global npm/node executable.
env.PATH = join(installDir, "app/runtime");

async function within(promise, timeout, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}
async function runExe(executable, args, expected = 0) {
  let result;
  try { await exec(executable, args, { env, windowsHide: true, windowsVerbatimArguments: true, timeout: 600_000 }); result = 0; }
  catch (error) { result = error.code; }
  assert.equal(result, expected, `${executable} returned ${result}; expected ${expected}`);
}
async function runSetup(directory, expected = 0) {
  // NSIS /D= consumes the unquoted remainder of the native command line and
  // must be last. Controlled test paths contain no quotes or command syntax.
  assert.ok(!/[\r\n"]/.test(directory));
  return runExe(installer, ["/S", `/D=${directory}`], expected);
}
async function runUninstall(expected = 0) {
  // _?= keeps the uninstaller in this process so its actual status is awaited.
  // NSIS cannot self-delete in this test mode; the test removes that one file
  // after exit. Ordinary interactive and /S uninstalls use NSIS self-copying.
  return runExe(join(installDir, "Uninstall.exe"), ["/S", `_?=${installDir}`], expected);
}
async function startCommand(runtime, entry, args) {
  const code = "const {main}=await import(process.env.FLOWHUB_SMOKE_ENTRY);process.on('message',m=>{if(m==='stop'){process.emit('SIGTERM');process.stdin.destroy();process.disconnect();}});await main(JSON.parse(process.env.FLOWHUB_SMOKE_ARGS));process.send({ready:true});";
  const child = spawn(runtime, ["--input-type=module", "-e", code], {
    env: { ...env, FLOWHUB_SMOKE_ENTRY: pathToFileURL(entry).href, FLOWHUB_SMOKE_ARGS: JSON.stringify(args) },
    cwd: temporary, windowsHide: true, stdio: ["pipe", "ignore", "pipe", "ipc"],
  });
  children.add(child);
  let stderr = "";
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  child.smokeExit = once(child, "exit");
  await within(Promise.race([
    once(child, "message").then(([message]) => assert.equal(message.ready, true)),
    child.smokeExit.then(([status]) => { throw new Error(`Installed command exited ${status}: ${stderr}`); }),
  ]), 30_000, "installed command startup");
  return child;
}
async function stopCommand(child) {
  if (!children.has(child)) return;
  if (child.exitCode === null && child.connected) child.send("stop");
  const [status] = await within(child.smokeExit, 15_000, "graceful daemon/bridge shutdown");
  children.delete(child);
  assert.equal(status, 0, "Installed process must stop cleanly, without TerminateProcess or stale locks.");
}
async function readDatabaseIdentity(runtime, appDir) {
  const code = "const DB=require('better-sqlite3');const db=new DB(process.env.FLOWHUB_SMOKE_DB,{readonly:true,fileMustExist:true});const get=k=>db.prepare('SELECT value FROM poc_meta WHERE key = ?').get(k).value;console.log(JSON.stringify({instanceId:get('instance_id'),boots:Number(get('boots'))}));db.close();";
  const result = await exec(runtime, ["--input-type=commonjs", "-e", code], {
    env: { ...env, FLOWHUB_SMOKE_DB: join(dataDir, "flowhub.sqlite") }, cwd: appDir, windowsHide: true,
  });
  return JSON.parse(result.stdout);
}

try {
  const unrelated = join(temporary, "unrelated");
  await mkdir(unrelated);
  await writeFile(join(unrelated, "user.txt"), sentinel);
  await runSetup(unrelated, 21);
  assert.equal(await readFile(join(unrelated, "user.txt"), "utf8"), sentinel);
  checks.push("refuses unrelated nonempty program directory");

  await runSetup(installDir);
  installed = true;
  const appDir = join(installDir, "app");
  await verifyBundle(appDir);
  const state = JSON.parse(await readFile(join(installDir, ".flowhub-install.json"), "utf8"));
  assert.equal(state.phase, "installed");
  assert.equal(state.installDir.toLowerCase(), installDir.toLowerCase());
  const runtime = join(appDir, "runtime/node.exe");
  const entry = join(appDir, "dist/apps/daemon/src/cli.js");
  const help = await exec(runtime, [entry, "--help"], { env, windowsHide: true });
  assert.match(help.stdout, /MCP FlowHub/);
  const cmd = join(process.env.SystemRoot ?? "C:\\Windows", "System32/cmd.exe");
  const launcherHelp = await exec(cmd, ["/d", "/s", "/c", `""${join(installDir, "flowhub.cmd")}" --help"`], {
    env, cwd: temporary, windowsHide: true, windowsVerbatimArguments: true,
  });
  assert.match(launcherHelp.stdout, /MCP FlowHub/);
  assert.ok(process.env.APPDATA, "APPDATA is required to verify current-user Start Menu shortcuts.");
  const shortcutsDir = join(process.env.APPDATA, "Microsoft/Windows/Start Menu/Programs/MCP FlowHub");
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const shortcutResult = await exec(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut($env:FLOWHUB_SHORTCUT_PATH); @{target=$s.TargetPath;arguments=$s.Arguments}|ConvertTo-Json -Compress"],
  { env: { ...env, FLOWHUB_SHORTCUT_PATH: join(shortcutsDir, "Start FlowHub.lnk") }, windowsHide: true });
  const shortcut = JSON.parse(shortcutResult.stdout);
  assert.equal(shortcut.target.toLowerCase(), runtime.toLowerCase());
  assert.equal(shortcut.arguments, `"${entry}" serve`);
  assert.match(await readFile(join(shortcutsDir, "Open management.url"), "utf8"), /URL=http:\/\/127\.0\.0\.1:18473\//);
  checks.push("native offline install in a Unicode and space path; complete payload integrity");
  checks.push("actual flowhub.cmd launcher and current-user Start Menu targets");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "installer-smoke-sentinel.txt"), sentinel);
  await writeFile(extraRoot, "USER_ROOT_FILE");
  await writeFile(extraApp, "USER_APP_FILE");

  const daemon = await startCommand(runtime, entry, ["serve", "--port", "0"]);
  const endpoint = JSON.parse(await readFile(join(dataDir, "endpoint.json"), "utf8"));
  assert.equal((await fetch(`http://127.0.0.1:${endpoint.port}/api/v1/health`)).status, 200);
  const page = await fetch(`http://127.0.0.1:${endpoint.port}/`);
  assert.match(await page.text(), /assets\/index-/);
  const doctor = await exec(runtime, [entry, "doctor"], { env, windowsHide: true, timeout: 15_000 });
  assert.equal(JSON.parse(doctor.stdout).tools.length, 7);
  await runSetup(installDir, 20);
  await runUninstall(20);
  checks.push("installed daemon, UI and seven tools; active-daemon install/uninstall refusal");
  await stopCommand(daemon);
  await assert.rejects(access(join(dataDir, "daemon.lock")), { code: "ENOENT" });
  const executionToken = await readFile(join(dataDir, "execution-token"));
  const databaseBeforeReinstall = await readFile(join(dataDir, "flowhub.sqlite"));
  const identityBeforeReinstall = await readDatabaseIdentity(runtime, appDir);
  assert.equal(identityBeforeReinstall.instanceId, endpoint.instanceId);

  // Isolate the Unicode CIM executable-path check: the real daemon below uses
  // the ZIP's runtime, a separate data directory and no CLI path in argv. Only
  // the installed bridge process belongs to the installation being replaced.
  const outsideData = join(temporary, "外部 daemon data");
  const outsideDaemon = await startCommand(join(metadata.bundle, "runtime/node.exe"),
    join(metadata.bundle, "dist/apps/daemon/src/cli.js"), ["serve", "--port", "0", "--data-dir", outsideData]);
  const bridge = await startCommand(runtime, entry, ["mcp", "--stdio", "--data-dir", outsideData]);
  await runSetup(installDir, 20);
  await runUninstall(20);
  await stopCommand(bridge);
  await stopCommand(outsideDaemon);
  checks.push("Unicode-path bridge alone blocks upgrade/uninstall without a default-data lock");

  await runSetup(join(temporary, "second installation"), 21);
  await runSetup(installDir);
  assert.equal(await readFile(join(dataDir, "installer-smoke-sentinel.txt"), "utf8"), sentinel);
  assert.equal(await readFile(extraApp, "utf8"), "USER_APP_FILE");
  assert.deepEqual(await readFile(join(dataDir, "execution-token")), executionToken);
  assert.deepEqual(await readFile(join(dataDir, "flowhub.sqlite")), databaseBeforeReinstall);
  assert.deepEqual(await readDatabaseIdentity(runtime, appDir), identityBeforeReinstall);
  const restarted = await startCommand(runtime, entry, ["serve", "--port", "0"]);
  const restartedEndpoint = JSON.parse(await readFile(join(dataDir, "endpoint.json"), "utf8"));
  assert.equal(restartedEndpoint.instanceId, endpoint.instanceId);
  const restartedDoctor = await exec(runtime, [entry, "doctor"], { env, windowsHide: true, timeout: 15_000 });
  assert.equal(JSON.parse(restartedDoctor.stdout).tools.length, 7);
  await stopCommand(restarted);
  const identityAfterRestart = await readDatabaseIdentity(runtime, appDir);
  assert.equal(identityAfterRestart.instanceId, identityBeforeReinstall.instanceId);
  assert.equal(identityAfterRestart.boots, identityBeforeReinstall.boots + 1);
  checks.push("single per-user installation; same-version reinstall preserves database bytes, instance ID, token and extra files");

  await runUninstall();
  installed = false;
  await rm(join(installDir, "Uninstall.exe"), { force: true });
  await assert.rejects(access(runtime), { code: "ENOENT" });
  await assert.rejects(access(join(installDir, ".flowhub-install.json")), { code: "ENOENT" });
  await assert.rejects(access(join(shortcutsDir, "Start FlowHub.lnk")), { code: "ENOENT" });
  await assert.rejects(access(join(shortcutsDir, "Open management.url")), { code: "ENOENT" });
  assert.equal(await readFile(extraRoot, "utf8"), "USER_ROOT_FILE");
  assert.equal(await readFile(extraApp, "utf8"), "USER_APP_FILE");
  assert.equal(await readFile(join(dataDir, "installer-smoke-sentinel.txt"), "utf8"), sentinel);
  checks.push("synchronous silent uninstall removes managed files and retains all data and extra files");
  const evidence = { formatVersion: 1, os: "win32", arch: "x64", node: process.versions.node,
    installerSha256: metadata.installerSha256, nativeWindowsInstallerSmoke: "PASS", companyValidated: false,
    signed: false, testedAt: new Date().toISOString(), checks };
  await writeFile(join(root, "artifacts/windows-installer-smoke.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  success = true;
} finally {
  for (const child of children) await stopCommand(child);
  if (success) {
    assert.equal(await readFile(join(dataDir, "installer-smoke-sentinel.txt"), "utf8"), sentinel);
    await rm(dataDir, { recursive: true });
    await rm(temporary, { recursive: true, force: true });
  } else {
    console.error(`Installer smoke failed; synthetic diagnostic files retained at ${temporary}. Data directory retained at ${dataDir}. Installed=${installed}. No process was force-terminated.`);
  }
}
