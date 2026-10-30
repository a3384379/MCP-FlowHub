import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { lstat, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from "node:path";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const product = "MCP-FlowHub";
const markerName = ".flowhub-install.json";
const ownedRootFiles = ["flowhub.cmd", "installer-helper.mjs", "NSIS-COPYING.txt", "NSIS-NOTICE.txt"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalize = (path) => resolve(path).toLowerCase();
const contains = (parent, child) => {
  const value = relative(normalize(parent), normalize(child));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
};
function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}
function safeRelative(path) {
  return typeof path === "string" && path.length > 0 &&
    path.split("/").every((part) => part && part !== "." && part !== ".." && !/[\\:<>"|?*\x00-\x1f]/.test(part) && !/[ .]$/.test(part));
}

export function validateWindowsPaths(installDir, dataDir) {
  for (const path of [installDir, dataDir]) {
    if (typeof path !== "string" || !/^[a-z]:\\/i.test(path) || path === win32.parse(path).root ||
      path.split("\\").slice(1).some((part) => !part || part === "." || part === ".." || /[ .]$|[<>:"|?*\x00-\x1f]/.test(part)))
      fail("INSTALL_PATH_UNSAFE", "Choose a local drive directory below the drive root, without junctions or reserved path characters.");
  }
  const a = win32.resolve(installDir).toLowerCase();
  const b = win32.resolve(dataDir).toLowerCase();
  if (a === b || a.startsWith(`${b}\\`) || b.startsWith(`${a}\\`))
    fail("INSTALL_PATH_UNSAFE", "Program and data directories must be separate and cannot contain one another.");
}

async function stat(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function noLinks(path) {
  const full = resolve(path);
  let current = parse(full).root;
  for (const part of full.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await stat(current);
    if (!info) break;
    if (info.isSymbolicLink()) fail("INSTALL_PATH_UNSAFE", "Junctions and symbolic links are not supported in managed program paths.");
  }
}
// Resolve existing ancestors before comparing ownership or containment. Windows
// 8.3 aliases are ordinary directory names; lexical case folding cannot prove
// that an installation is separate from the data directory. Check links first.
async function canonicalPath(path) {
  await noLinks(path);
  let current = resolve(path); const missing = [];
  while (!(await stat(current))) {
    const parent = dirname(current);
    if (parent === current) fail("INSTALL_PATH_UNSAFE", "Path has no accessible existing ancestor.");
    missing.unshift(relative(parent, current)); current = parent;
  }
  return resolve(await realpath(current), ...missing);
}
async function stateAt(installDir) {
  const path = join(installDir, markerName);
  const info = await stat(path);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) fail("INSTALL_OWNER_INVALID", "The installation ownership marker is invalid; preserve the directory and choose another location.");
  let state;
  try { state = JSON.parse(await readFile(path, "utf8")); }
  catch { fail("INSTALL_OWNER_INVALID", "The installation ownership marker cannot be read; repair with a reviewed installer."); }
  if (state.product !== product || state.formatVersion !== 1 ||
    typeof state.installDir !== "string" || !isAbsolute(state.installDir) ||
    normalize(await canonicalPath(state.installDir)) !== normalize(await canonicalPath(installDir)) ||
    !Array.isArray(state.payloadFiles) || state.payloadFiles.some((name) => !safeRelative(name)) ||
    new Set(state.payloadFiles).size !== state.payloadFiles.length)
    fail("INSTALL_OWNER_INVALID", "This directory is not a valid managed FlowHub installation.");
  return state;
}

export async function inspectWindowsProcesses() {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const { stdout } = await exec(powershell, ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress"],
    { windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    const records = JSON.parse(stdout);
    const result = records === null ? [] : Array.isArray(records) ? records : [records];
    if (result.some((p) => !Number.isInteger(p.ProcessId))) throw new Error("Invalid process inventory");
    return result;
  } catch {
    fail("INSTALL_PROCESS_CHECK_FAILED", "Windows process inspection failed. No files were replaced; allow the approved local PowerShell/CIM check and retry.");
  }
}

export function assertProcessesStopped(records, installDir, selfPid = process.pid) {
  for (const process of records) {
    if (process.ProcessId === selfPid) continue;
    const executable = process.ExecutablePath;
    const commandLine = process.CommandLine ?? "";
    // Match all CLI modes, including option-before-command invocations and an
    // external Node executable using installed CLI files. Restrict executable
    // ownership to app/: the NSIS Uninstall.exe itself lives in the program root.
    const flowhubCli = /(?:^|[\\/\s"'])dist[\\/]apps[\\/]daemon[\\/]src[\\/]cli\.js(?:["'\s]|$)/i.test(commandLine);
    const programReference = commandLine.toLowerCase().replaceAll("\\", "/").includes(`${normalize(installDir).replaceAll("\\", "/")}/app/`);
    if ((typeof executable === "string" && contains(join(installDir, "app"), executable)) || flowhubCli || programReference)
      fail("INSTALL_BUSY", "Stop FlowHub and its MCP bridge processes, then retry. The installer never terminates a process.");
  }
}

export async function preflight({ installDir, dataDir, processInspector = inspectWindowsProcesses, requireInstalled = false }) {
  if (process.platform === "win32") validateWindowsPaths(installDir, dataDir);
  else if (!isAbsolute(installDir) || !isAbsolute(dataDir) || contains(installDir, dataDir) || contains(dataDir, installDir))
    fail("INSTALL_PATH_UNSAFE", "Program and data directories must be separate absolute directories.");
  await noLinks(installDir);
  await noLinks(dataDir);
  const programPath = await canonicalPath(installDir), dataPath = await canonicalPath(dataDir);
  if (contains(programPath, dataPath) || contains(dataPath, programPath))
    fail("INSTALL_PATH_UNSAFE", "Program and data aliases resolve to overlapping directories.");
  const state = await stateAt(installDir);
  if (requireInstalled && !state) fail("INSTALL_OWNER_INVALID", "The managed installation marker is missing; no files were removed.");
  if (!state && await stat(installDir) && (await readdir(installDir)).length > 0)
    fail("INSTALL_DIRECTORY_NOT_EMPTY", "Choose an empty directory or the existing managed FlowHub installation. Unrelated files will not be overwritten.");
  if (state && (typeof state.dataDir !== "string" || !isAbsolute(state.dataDir) ||
    normalize(await canonicalPath(state.dataDir)) !== normalize(dataPath)))
    fail("INSTALL_OWNER_INVALID", "The recorded data directory differs from the expected independent data directory.");
  if (await stat(join(dataDir, "daemon.lock")))
    fail("INSTALL_DAEMON_LOCKED", "Stop the daemon before installing, upgrading or uninstalling. A stale daemon.lock must be checked manually; it is never removed by the installer.");
  assertProcessesStopped(await processInspector(), programPath);
  return state;
}

async function inventory(root) {
  const files = {};
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      const name = relative(root, target).replaceAll("\\", "/");
      if (!safeRelative(name) || entry.isSymbolicLink()) fail("INSTALL_PAYLOAD_INVALID", "Unsafe payload path.");
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) files[name] = hash(await readFile(target));
      else fail("INSTALL_PAYLOAD_INVALID", "Payload contains a non-regular file.");
    }
  }
  await walk(root);
  return files;
}
async function atomicWrite(path, bytes) {
  await noLinks(path);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.flowhub-${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    try { await unlink(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
async function removeOwnedFile(root, name) {
  if (!safeRelative(name)) fail("INSTALL_OWNER_INVALID", "Unsafe managed file path.");
  const path = join(root, ...name.split("/"));
  await noLinks(path);
  const info = await stat(path);
  if (!info) return;
  if (!info.isFile()) fail("INSTALL_OWNER_INVALID", "A managed file has been replaced by a directory; it was preserved.");
  await unlink(path);
}
async function pruneEmptyDirectories(root, names) {
  const dirs = new Set([root]);
  for (const name of names) {
    let dir = dirname(join(root, ...name.split("/")));
    while (contains(root, dir)) {
      dirs.add(dir);
      if (dir === root) break;
      dir = dirname(dir);
    }
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    try { await rmdir(dir); }
    catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
  }
}

export async function installApplication(options) {
  const { installDir, dataDir, payloadDir, payloadManifest, version } = options;
  const previous = await preflight(options);
  const actual = await inventory(payloadDir);
  try { assert.deepEqual(Object.entries(actual).sort(), Object.entries(payloadManifest).sort()); }
  catch { fail("INSTALL_PAYLOAD_INVALID", "Embedded offline payload failed its complete SHA-256 inventory check. No application files were replaced."); }
  const appDir = join(installDir, "app");
  const oldFiles = previous?.payloadFiles ?? [];
  const newFiles = Object.keys(actual).sort();
  for (const name of newFiles) {
    await noLinks(join(appDir, ...name.split("/")));
    if (!oldFiles.includes(name) && await stat(join(appDir, ...name.split("/"))))
      fail("INSTALL_FILE_COLLISION", "An extra file conflicts with this release. Preserve it outside the program directory and retry.");
  }
  // Record ownership before copying, so an interrupted installation can be
  // repaired or removed without broad recursive deletion. User data is untouched.
  const state = { formatVersion: 1, product, version, installDir: resolve(installDir), dataDir: resolve(dataDir),
    phase: "installing", payloadFiles: [...new Set([...oldFiles, ...newFiles])].sort() };
  await atomicWrite(join(installDir, markerName), JSON.stringify(state, null, 2));
  for (const name of newFiles)
    await atomicWrite(join(appDir, ...name.split("/")), await readFile(join(payloadDir, ...name.split("/"))));
  for (const name of oldFiles) if (!Object.hasOwn(actual, name)) await removeOwnedFile(appDir, name);
  await pruneEmptyDirectories(appDir, oldFiles.filter((name) => !Object.hasOwn(actual, name)));
  state.phase = "installed";
  state.payloadFiles = newFiles;
  await atomicWrite(join(installDir, markerName), JSON.stringify(state, null, 2));
  return state;
}

export async function uninstallApplication(options) {
  const state = await preflight({ ...options, requireInstalled: true });
  const appDir = join(options.installDir, "app");
  // Validate every target before the first deletion. Never follow junctions or
  // remove an unlisted file, including files added by the user after installation.
  for (const name of state.payloadFiles) {
    const target = join(appDir, ...name.split("/"));
    await noLinks(target);
    const info = await stat(target);
    if (info && !info.isFile()) fail("INSTALL_OWNER_INVALID", "A managed file is no longer a regular file; no files were removed.");
  }
  for (const name of ownedRootFiles) {
    const target = join(options.installDir, name);
    await noLinks(target);
    const info = await stat(target);
    if (info && !info.isFile()) fail("INSTALL_OWNER_INVALID", "A managed program file was replaced by a directory; no files were removed.");
  }
  for (const name of state.payloadFiles) await removeOwnedFile(appDir, name);
  await pruneEmptyDirectories(appDir, state.payloadFiles);
  for (const name of ownedRootFiles) await removeOwnedFile(options.installDir, name);
  await unlink(join(options.installDir, markerName));
  return { dataRetained: true, dataDir: options.dataDir };
}

async function main(args) {
  if (process.platform !== "win32") fail("WINDOWS_INSTALL_REQUIRED", "This helper only installs native Windows payloads on Windows.");
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    "install-dir": { type: "string" }, "data-dir": { type: "string" }, "payload-dir": { type: "string" },
    "payload-manifest": { type: "string" }, version: { type: "string" },
  } });
  if (positionals.length !== 1 || !values["install-dir"] || !values["data-dir"])
    fail("INSTALL_INPUT_INVALID", "Expected one installer operation and explicit program/data directories.");
  const options = { installDir: values["install-dir"], dataDir: values["data-dir"] };
  let result;
  if (positionals[0] === "preflight") result = await preflight(options);
  else if (positionals[0] === "uninstall") result = await uninstallApplication(options);
  else if (positionals[0] === "install" && values["payload-dir"] && values["payload-manifest"] && values.version)
    result = await installApplication({ ...options, payloadDir: values["payload-dir"],
      payloadManifest: JSON.parse(await readFile(values["payload-manifest"], "utf8")), version: values.version });
  else fail("INSTALL_INPUT_INVALID", "Unsupported or incomplete installer operation.");
  console.log(JSON.stringify({ ok: true, operation: positionals[0], dataRetained: true, version: result?.version }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message?.startsWith("INSTALL_") || error.message?.startsWith("WINDOWS_") ? error.message : "INSTALL_FAILED: Preserve the program/data directories and retry a reviewed installer; no daemon was terminated.");
    process.exitCode = /INSTALL_(?:BUSY|DAEMON_LOCKED)/.test(error.message) ? 20 : 21;
  });
