import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, realpath, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { installApplication, uninstallApplication, preflight, validateWindowsPaths, assertProcessesStopped, execWithoutInput } =
  await import(pathToFileURL(resolve("installer/windows/install-helper.mjs")).href);
const { verifyPinnedToolchain, peMachine, verifyLoadedNativeModules } =
  await import(pathToFileURL(resolve("scripts/windows-installer.mjs")).href);
const { windowsTestEnvironment } = await import(pathToFileURL(resolve("scripts/windows-test-environment.mjs")).href);
const { taskDefinition, windowsAutostart } = await import(pathToFileURL(resolve("installer/windows/autostart.mjs")).href);
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

test("offline Windows processes retain OS identity without global tools, credentials or Node injection", () => {
  const environment = windowsTestEnvironment("C:\\isolated\\runtime", {
    SYSTEMROOT: "C:\\Windows", SYSTEMDRIVE: "C:", ComSpec: "C:\\Windows\\System32\\cmd.exe", USERNAME: "synthetic",
    Path: "C:\\global-node;C:\\global-npm", OPENAI_API_KEY: "must-not-propagate", GITHUB_TOKEN: "must-not-propagate",
    NODE_OPTIONS: "--require untrusted", PSModulePath: "untrusted-modules",
  });
  assert.equal(environment.SystemRoot, "C:\\Windows");
  assert.equal(environment.SystemDrive, "C:");
  assert.equal(environment.ComSpec, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(environment.USERNAME, "synthetic");
  assert.equal(environment.PATH, "C:\\isolated\\runtime");
  for (const key of ["OPENAI_API_KEY", "GITHUB_TOKEN", "NODE_OPTIONS", "PSModulePath", "Path"]) assert.equal(environment[key], undefined);
});

test("noninteractive installer probes receive EOF and preserve Unicode output and process failures", async () => {
  const script = "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({target:'C:\\\\用户\\\\程序 files\\\\node.exe'})));";
  const result = await execWithoutInput(process.execPath, ["-e", script], { timeout: 5000 });
  assert.deepEqual(JSON.parse(result.stdout), { target: "C:\\用户\\程序 files\\node.exe" });
  await assert.rejects(execWithoutInput(process.execPath, ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.exit(7));"], { timeout: 5000 }), { code: 7 });
});

test("Windows logon task uses the bundled runtime, stable data identity and current-user ownership", async () => {
  const options = { programDir: "C:\\用户\\FlowHub 程序", dataDir: "D:\\同一数据 目录", port: "19222" };
  const task = taskDefinition(options);
  assert.equal(task.node, "C:\\用户\\FlowHub 程序\\runtime\\node.exe");
  assert.equal(task.key, taskDefinition({ ...options, port: "18473", programDir: "C:\\另一安装" }).key);
  assert.match(task.argumentsPrefix, /" serve --data-dir "D:\\同一数据 目录" --port$/);
  assert.throws(() => taskDefinition({ ...options, dataDir: options.programDir + "\\data" }), /independent/);
  for (const port of ["0", "65536", "18473 extra"]) assert.throws(() => taskDefinition({ ...options, port }), /PORT/);
  const simulated = async (executable: string, args: string[], launch: { env: Record<string, string> }) => {
    assert.match(executable, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
    assert.ok(!args.includes("Bypass"));
    assert.equal(args.at(-2), "-EncodedCommand");
    assert.match(Buffer.from(args.at(-1)!, "base64").toString("utf16le"), /-LogonType Interactive -RunLevel Limited/);
    assert.equal(launch.env.FLOWHUB_TASK_ACTION, "enable");
    assert.equal(launch.env.FLOWHUB_TASK_PORT, task.port);
    assert.equal(launch.env.FLOWHUB_TASK_ARGUMENTS, task.argumentsPrefix);
    return { stdout: '{"state":"different_installation"}' };
  };
  await assert.rejects(windowsAutostart("enable", options, simulated), /AUTOSTART_CONFLICT/);
  await assert.rejects(windowsAutostart("status", options, async () => {
    throw Object.assign(new Error("scheduler failed"), { stderr: "Access is denied." });
  }), /Access is denied/);
  await assert.rejects(windowsAutostart("status", options, async () => {
    throw Object.assign(new Error("scheduler timed out"), { killed: true, signal: "SIGTERM", stderr: "#< CLIXML" });
  }), /计划任务服务响应超时/);
});

async function put(root: string, name: string, content: string) {
  await mkdir(dirname(join(root, name)), { recursive: true });
  await writeFile(join(root, name), content);
}
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "FlowHub 安装 helper ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installDir = join(root, "程序 files");
  const dataDir = join(root, "用户 data");
  const payloadDir = join(root, "payload");
  const payloadManifest = { "runtime/node.exe": hash("native fixture"), "obsolete.txt": hash("old release") };
  await put(payloadDir, "runtime/node.exe", "native fixture");
  await put(payloadDir, "obsolete.txt", "old release");
  await put(dataDir, "audit.json", "SYNTHETIC_RETAIN_SENTINEL");
  return { root, installDir, dataDir, payloadDir, payloadManifest, version: "fixture-1", processInspector: async () => [] };
}

test("installer ownership preserves data and extra files across upgrade and uninstall", async (t) => {
  const options = await fixture(t);
  await installApplication(options);
  await put(options.installDir, "app/user-note.txt", "EXTRA_APP_SENTINEL");
  await put(options.installDir, "personal.txt", "EXTRA_ROOT_SENTINEL");
  await rm(join(options.payloadDir, "obsolete.txt"));
  await put(options.payloadDir, "runtime/node.exe", "new native fixture");
  const payloadManifest = { "runtime/node.exe": hash("new native fixture") };
  await installApplication({ ...options, version: "fixture-2", payloadManifest });
  assert.equal(await readFile(join(options.installDir, "app/runtime/node.exe"), "utf8"), "new native fixture");
  await assert.rejects(readFile(join(options.installDir, "app/obsolete.txt")), { code: "ENOENT" });
  await uninstallApplication(options);
  assert.equal(await readFile(join(options.dataDir, "audit.json"), "utf8"), "SYNTHETIC_RETAIN_SENTINEL");
  assert.equal(await readFile(join(options.installDir, "app/user-note.txt"), "utf8"), "EXTRA_APP_SENTINEL");
  assert.equal(await readFile(join(options.installDir, "personal.txt"), "utf8"), "EXTRA_ROOT_SENTINEL");
  await assert.rejects(readFile(join(options.installDir, "app/runtime/node.exe")), { code: "ENOENT" });
});

test("install refuses unrelated directories, changed payloads, and extra-file collisions before replacing files", async (t) => {
  const options = await fixture(t);
  await put(options.installDir, "unrelated.txt", "DO_NOT_TOUCH");
  await assert.rejects(installApplication(options), /INSTALL_DIRECTORY_NOT_EMPTY/);
  assert.equal(await readFile(join(options.installDir, "unrelated.txt"), "utf8"), "DO_NOT_TOUCH");
  await rm(options.installDir, { recursive: true });
  await put(options.payloadDir, "runtime/node.exe", "TAMPERED");
  await assert.rejects(installApplication(options), /INSTALL_PAYLOAD_INVALID/);
  await assert.rejects(readdir(options.installDir), { code: "ENOENT" });
  await put(options.payloadDir, "runtime/node.exe", "native fixture");
  await installApplication(options);
  await put(options.installDir, "app/new.txt", "USER_FILE");
  await put(options.payloadDir, "new.txt", "NEW_RELEASE_FILE");
  await assert.rejects(installApplication({ ...options, payloadManifest: { ...options.payloadManifest, "new.txt": hash("NEW_RELEASE_FILE") } }), /INSTALL_FILE_COLLISION/);
  assert.equal(await readFile(join(options.installDir, "app/new.txt"), "utf8"), "USER_FILE");
});

test("daemon locks and process-inspection failures block every destructive installer operation", async (t) => {
  const options = await fixture(t);
  await installApplication(options);
  await put(options.dataDir, "daemon.lock", '{"pid":99999999}');
  await assert.rejects(installApplication(options), /INSTALL_DAEMON_LOCKED/);
  await assert.rejects(uninstallApplication(options), /INSTALL_DAEMON_LOCKED/);
  assert.equal(await readFile(join(options.dataDir, "daemon.lock"), "utf8"), '{"pid":99999999}');
  await rm(join(options.dataDir, "daemon.lock"));
  await assert.rejects(uninstallApplication({ ...options, processInspector: async () => { throw new Error("CIM failed"); } }), /CIM failed/);
  assert.equal(await readFile(join(options.installDir, "app/runtime/node.exe"), "utf8"), "native fixture");
});

test("Unicode bridge paths, external Node CLI references and options before serve all block replacement", async (t) => {
  const { installDir } = await fixture(t);
  assert.throws(() => assertProcessesStopped([{ ProcessId: 123, ExecutablePath: join(installDir, "app/runtime/node.exe"), CommandLine: 'node cli.js mcp --stdio' }], installDir, 456), /INSTALL_BUSY/);
  assert.throws(() => assertProcessesStopped([{ ProcessId: 123, ExecutablePath: join(tmpdir(), "external/node.exe"), CommandLine: `node "${join(installDir, "app/dist/apps/daemon/src/cli.js")}" mcp --stdio` }], installDir, 456), /INSTALL_BUSY/);
  assert.throws(() => assertProcessesStopped([{ ProcessId: 123, CommandLine: 'node "C:\\other\\dist\\apps\\daemon\\src\\cli.js" --data-dir "C:\\用户 data" serve' }], installDir, 456), /INSTALL_BUSY/);
  assert.doesNotThrow(() => assertProcessesStopped([{ ProcessId: 123, ExecutablePath: join(installDir, "Uninstall.exe"), CommandLine: `"${join(installDir, "Uninstall.exe")}" /S _?=${installDir}` }], installDir, 456));
});

test("Windows program paths reject drive roots, UNC and program/data overlap", () => {
  assert.doesNotThrow(() => validateWindowsPaths("C:\\用户 apps\\FlowHub", "C:\\用户 data\\FlowHub"));
  for (const program of ["C:\\", "\\\\server\\share\\app", "C:\\data", "C:\\data\\app", "C:\\data\\..\\app", "C:\\app."])
    assert.throws(() => validateWindowsPaths(program, "C:\\data"), /INSTALL_PATH_UNSAFE/);
  assert.throws(() => validateWindowsPaths("C:\\parent", "C:\\parent\\data"), /INSTALL_PATH_UNSAFE/);
});

test("uninstall rejects marker traversal and directory-link replacements without deleting data", async (t) => {
  const options = await fixture(t);
  await installApplication(options);
  const marker = join(options.installDir, ".flowhub-install.json");
  const original = await readFile(marker, "utf8");
  const state = JSON.parse(original);
  await writeFile(marker, JSON.stringify({ ...state, payloadFiles: ["../audit.json"] }));
  await assert.rejects(uninstallApplication(options), /INSTALL_OWNER_INVALID/);
  assert.equal(await readFile(join(options.dataDir, "audit.json"), "utf8"), "SYNTHETIC_RETAIN_SENTINEL");
  await writeFile(marker, original);
  await mkdir(join(options.installDir, "flowhub.cmd"));
  await assert.rejects(uninstallApplication(options), /INSTALL_OWNER_INVALID/);
  assert.equal(await readFile(join(options.installDir, "app/runtime/node.exe"), "utf8"), "native fixture");
  await rm(join(options.installDir, "flowhub.cmd"), { recursive: true });
  await rm(join(options.installDir, "app/runtime"), { recursive: true });
  await symlink(options.dataDir, join(options.installDir, "app/runtime"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(uninstallApplication(options), /INSTALL_PATH_UNSAFE/);
  assert.equal(await readFile(join(options.installDir, "app/obsolete.txt"), "utf8"), "old release");
});

test("uninstaller does not claim or remove an unowned directory", async (t) => {
  const options = await fixture(t);
  await put(options.installDir, "user.txt", "DO_NOT_TOUCH");
  await assert.rejects(uninstallApplication(options), /INSTALL_OWNER_INVALID/);
  assert.equal(await readFile(join(options.installDir, "user.txt"), "utf8"), "DO_NOT_TOUCH");
});

test("compiler archive hash and native PE headers reject substitutes", async (t) => {
  const { root } = await fixture(t);
  const archive = join(root, "nsis.zip");
  await writeFile(archive, "fixture bytes");
  await assert.rejects(verifyPinnedToolchain(archive, { name: "NSIS", version: "3.11", sha256: "0".repeat(64) }), /NSIS archive SHA-256 mismatch/);
  assert.throws(() => peMachine(Buffer.from("\x7fELF linux payload")), /native Windows PE/);
  const malformed = Buffer.alloc(64);
  malformed.write("MZ");
  malformed.writeUInt32LE(65535, 0x3c);
  assert.throws(() => peMachine(malformed), /Invalid Windows PE header/);
});

test("native verification checks the SQLite binding actually loaded while inventorying unused foreign prebuilds", async (t) => {
  const { root } = await fixture(t);
  const windows = join(root, "node_modules/better-sqlite3/prebuilds/win32-x64.node");
  const linux = join(root, "node_modules/better-sqlite3/prebuilds/linux-x64.node");
  await mkdir(dirname(windows), { recursive: true });
  const pe = Buffer.alloc(128);
  pe.write("MZ");
  pe.writeUInt32LE(64, 0x3c);
  pe.write("PE\0\0", 64, "binary");
  pe.writeUInt16LE(0x8664, 68);
  await writeFile(windows, pe);
  await writeFile(linux, "\x7fELF unused foreign prebuild");
  assert.deepEqual(await verifyLoadedNativeModules(root, [windows]), {
    loaded: ["node_modules/better-sqlite3/prebuilds/win32-x64.node"],
    unused: ["node_modules/better-sqlite3/prebuilds/linux-x64.node"],
  });
  await assert.rejects(verifyLoadedNativeModules(root, [linux]), /native Windows PE/);
  await assert.rejects(verifyLoadedNativeModules(root, [join(root, "external/win32-x64.node")]), /must belong to the verified bundle/);
  const wrongArch = Buffer.from(pe);
  wrongArch.writeUInt16LE(0xaa64, 68);
  await writeFile(windows, wrongArch);
  await assert.rejects(verifyLoadedNativeModules(root, [windows]), /Actually loaded binding must be Windows x64 PE/);
  await assert.rejects(verifyLoadedNativeModules(root, []), /actually loaded native binding paths/);
});

test("Linux invocation cannot generate a Windows installer", { skip: process.platform === "win32" ? "Native Windows build is covered by the actual installer smoke job" : false }, async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ["scripts/windows-installer.mjs"]), (error: Error) => /WINDOWS_BUILD_REQUIRED/.test(error.message));
});
