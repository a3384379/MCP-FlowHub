import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { appendFile, copyFile, lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { windowsAutostart } from "./autostart.mjs";

const exec = promisify(execFile);
export function execWithoutInput(executable, args, options) {
  const execution = exec(executable, args, options);
  // No installer probe consumes input. An open pipe can leave Windows
  // PowerShell waiting for EOF even with -NonInteractive and -Command.
  execution.child.stdin?.end();
  return execution;
}
const product = "MCP-FlowHub";
const markerName = ".flowhub-install.json";
const ownedRootFiles = ["flowhub.cmd", "installer-helper.mjs", "NSIS-COPYING.txt", "NSIS-NOTICE.txt"];
const autostartPayload = "scripts/windows-autostart.mjs";
const normalize = (path) => resolve(path).toLowerCase();
const contains = (parent, child) => {
  const value = relative(normalize(parent), normalize(child));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
};
function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}
async function diagnostic(event, detail = {}) {
  const path = process.env.FLOWHUB_INSTALLER_DIAGNOSTICS;
  if (!path) return;
  // Only explicit phase/status fields, never process command lines or inventory.
  await appendFile(`${path}.node.log`, JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + "\n").catch(() => {});
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
  let info = null;
  for (const part of full.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    info = await stat(current);
    if (!info) return null;
    if (info.isSymbolicLink()) fail("INSTALL_PATH_UNSAFE", "Junctions and symbolic links are not supported in managed program paths.");
  }
  return info;
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
    normalize(state.installDir ?? "") !== normalize(installDir) ||
    !Array.isArray(state.payloadFiles) || state.payloadFiles.some((name) => !safeRelative(name)) ||
    new Set(state.payloadFiles).size !== state.payloadFiles.length)
    fail("INSTALL_OWNER_INVALID", "This directory is not a valid managed FlowHub installation.");
  return state;
}

export async function inspectWindowsProcesses() {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const system32 = join(systemRoot, "System32");
  const powershellHome = join(system32, "WindowsPowerShell", "v1.0");
  const powershell = join(powershellHome, "powershell.exe");
  const probeEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !["PATH", "PSMODULEPATH"].includes(key.toUpperCase())));
  probeEnv.PATH = [system32, systemRoot, powershellHome].join(";");
  probeEnv.PSModulePath = join(powershellHome, "Modules");
  const started = Date.now();
  await diagnostic("process-inspection-start");
  try {
    const command = "$ErrorActionPreference='Stop'; function Write-Phase($phase) { if($env:FLOWHUB_INSTALLER_DIAGNOSTICS) { try { [IO.File]::AppendAllText($env:FLOWHUB_INSTALLER_DIAGNOSTICS+'.powershell.log',[DateTime]::UtcNow.ToString('o')+' '+$phase+[Environment]::NewLine) } catch {} } }; Write-Phase 'started'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Write-Phase 'query-start'; $records=@(Get-CimInstance -Query 'SELECT ProcessId,ExecutablePath,CommandLine FROM Win32_Process' -ErrorAction Stop | Select-Object ProcessId,ExecutablePath,CommandLine); Write-Phase 'query-complete'; $records | ConvertTo-Json -Compress; Write-Phase 'output-complete'";
    const execution = execWithoutInput(powershell, ["-NoProfile", "-NonInteractive", "-InputFormat", "None", "-OutputFormat", "Text", "-Command", command],
    { windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
      // Installer smoke deliberately removes global Node/npm from PATH. Give
      // only this OS probe the Windows utilities and built-in CIM module path.
      env: probeEnv });
    execution.child.once("exit", (code, signal) => { void diagnostic("process-inspection-exit", { code, signal, elapsedMs: Date.now() - started }); });
    const { stdout } = await execution;
    const records = JSON.parse(stdout);
    const result = records === null ? [] : Array.isArray(records) ? records : [records];
    if (result.some((p) => !Number.isInteger(p.ProcessId))) throw new Error("Invalid process inventory");
    await diagnostic("process-inspection-complete", { count: result.length, elapsedMs: Date.now() - started });
    return result;
  } catch (error) {
    await diagnostic("process-inspection-failed", { elapsedMs: Date.now() - started, code: typeof error.code === "number" ? error.code : /^[A-Z_]+$/.test(error.code ?? "") ? error.code : "INVALID_OUTPUT", signal: error.signal ?? null, killed: error.killed === true, stdoutBytes: Buffer.byteLength(error.stdout ?? ""), stderrBytes: Buffer.byteLength(error.stderr ?? "") });
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

async function stoppedDaemonLock(dataDir) {
  const path = join(dataDir, "daemon.lock");
  const info = await stat(path);
  if (!info) return null;
  const unknownOwner = "The daemon lock owner could not be verified. Close FlowHub and Codex, then verify the recorded process before retrying.";
  if (!info.isFile() || info.nlink !== 1 || info.size > 1024)
    fail("INSTALL_DAEMON_LOCKED", unknownOwner);
  let contents, owner;
  try {
    contents = await readFile(path, "utf8");
    owner = JSON.parse(contents);
  } catch {
    fail("INSTALL_DAEMON_LOCKED", unknownOwner);
  }
  const pid = owner?.pid;
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff ||
      typeof owner.createdAt !== "string" || !Number.isFinite(Date.parse(owner.createdAt)))
    fail("INSTALL_DAEMON_LOCKED", unknownOwner);
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return { contents, pid, info };
    fail("INSTALL_DAEMON_LOCKED", unknownOwner);
  }
  fail("INSTALL_DAEMON_LOCKED", "The PID recorded in daemon.lock is still present. Close FlowHub and Codex before retrying.");
}

export async function preflight({ installDir, dataDir, processInspector = inspectWindowsProcesses, requireInstalled = false }) {
  if (process.platform === "win32") validateWindowsPaths(installDir, dataDir);
  else if (!isAbsolute(installDir) || !isAbsolute(dataDir) || contains(installDir, dataDir) || contains(dataDir, installDir))
    fail("INSTALL_PATH_UNSAFE", "Program and data directories must be separate absolute directories.");
  await noLinks(installDir);
  await noLinks(dataDir);
  const state = await stateAt(installDir);
  if (requireInstalled && !state) fail("INSTALL_OWNER_INVALID", "The managed installation marker is missing; no files were removed.");
  if (!state && await stat(installDir) && (await readdir(installDir)).length > 0)
    fail("INSTALL_DIRECTORY_NOT_EMPTY", "Choose an empty directory or the existing managed FlowHub installation. Unrelated files will not be overwritten.");
  if (state && normalize(state.dataDir ?? "") !== normalize(dataDir))
    fail("INSTALL_OWNER_INVALID", "The recorded data directory differs from the expected independent data directory.");
  if (!requireInstalled && state && !state.payloadFiles.includes(autostartPayload) && await stat(join(installDir, "autostart.mjs")))
    fail("INSTALL_FILE_COLLISION", "An unmanaged file conflicts with the Windows autostart helper.");
  const observed = await stoppedDaemonLock(dataDir);
  const records = await processInspector();
  assertProcessesStopped(records, installDir);
  const current = await stoppedDaemonLock(dataDir);
  if (current && (!observed || current.contents !== observed.contents ||
      current.info.ino !== observed.info.ino || current.info.dev !== observed.info.dev ||
      records.some(record => record.ProcessId === current.pid)))
    fail("INSTALL_DAEMON_LOCKED", "The daemon lock changed or its PID appeared during process inspection. Keep FlowHub and Codex closed and retry.");
  if (current) await diagnostic("stale-daemon-lock-retained");
  return state;
}

async function checkPayloadFiles(root, fileList, progress) {
  if (!Array.isArray(fileList) || !fileList.length || fileList.some(name => !safeRelative(name)))
    fail("INSTALL_PAYLOAD_INVALID", "The embedded file list is invalid.");
  const expected = new Set(fileList);
  if (new Set(fileList.map(name => name.toLowerCase())).size !== fileList.length)
    fail("INSTALL_PAYLOAD_INVALID", "The embedded file list contains duplicate paths.");
  await noLinks(root);
  let checked = 0;
  const emptyDirectories = [];
  await progress?.("Checking extracted files", checked, fileList.length);
  async function walk(path) {
    const start = checked;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      const name = relative(root, target).replaceAll("\\", "/");
      if (!safeRelative(name) || entry.isSymbolicLink()) fail("INSTALL_PAYLOAD_INVALID", "Unsafe payload path.");
      if (entry.isDirectory()) await walk(target);
      else {
        if (!entry.isFile() || !expected.delete(name))
          fail("INSTALL_PAYLOAD_INVALID", "An unexpected entry was found in the extracted files.");
        checked += 1;
        await progress?.("Checking extracted files", checked, fileList.length);
      }
    }
    if (checked === start && path !== root) emptyDirectories.push(path);
  }
  await walk(root);
  if (expected.size) fail("INSTALL_PAYLOAD_INVALID", "Some embedded files could not be extracted.");
  return emptyDirectories;
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
async function installFile(source, target, consumePayload) {
  const parent = dirname(target);
  if (!await noLinks(parent)) await mkdir(parent, { recursive: true });
  const destination = await stat(target);
  if (destination && !destination.isFile())
    fail("INSTALL_PATH_UNSAFE", "A program file destination is no longer a regular file.");
  if (consumePayload) {
    try { await rename(source, target); return; }
    catch (error) { if (!["EXDEV", "EPERM", "EACCES"].includes(error.code)) throw error; }
  }
  const temporary = `${target}.flowhub-${randomBytes(8).toString("hex")}.tmp`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await rename(temporary, target);
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
  const { installDir, dataDir, payloadDir, payloadFiles, version, consumePayload, progress } = options;
  if (contains(payloadDir, installDir) || contains(payloadDir, dataDir) ||
      contains(installDir, payloadDir) || contains(dataDir, payloadDir))
    fail("INSTALL_PATH_UNSAFE", "The extracted files must be separate from program and user data directories.");
  await progress?.("Checking FlowHub processes and directories");
  const previous = await preflight(options);
  const emptyDirectories = await checkPayloadFiles(payloadDir, payloadFiles, progress);
  const appDir = join(installDir, "app");
  const oldFiles = new Set(previous?.payloadFiles ?? []);
  const newFiles = [...payloadFiles].sort();
  const newFileSet = new Set(newFiles);
  const obsolete = [...oldFiles].filter(name => !newFileSet.has(name));
  const canMoveTree = consumePayload && !await stat(appDir);
  if (!canMoveTree) {
    const checkedDirectories = new Set();
    let checked = 0;
    await progress?.("Checking program file destinations", checked, newFiles.length);
    for (const name of newFiles) {
      const path = join(appDir, ...name.split("/"));
      const parent = dirname(path);
      if (!checkedDirectories.has(parent)) {
        await noLinks(parent);
        checkedDirectories.add(parent);
      }
      const current = await stat(path);
      if (current?.isSymbolicLink())
        fail("INSTALL_PATH_UNSAFE", "Junctions and symbolic links are not supported in managed program paths.");
      if (current && (!oldFiles.has(name) || !current.isFile()))
        fail("INSTALL_FILE_COLLISION", "An extra file conflicts with this release. Preserve it outside the program directory and retry.");
      checked += 1;
      await progress?.("Checking program file destinations", checked, newFiles.length);
    }
  }
  // Record ownership before copying, so an interrupted installation can be
  // repaired or removed without broad recursive deletion. User data is untouched.
  await stoppedDaemonLock(dataDir);
  const state = { formatVersion: 1, product, version, installDir: resolve(installDir), dataDir: resolve(dataDir),
    phase: "installing", payloadFiles: [...new Set([...oldFiles, ...newFiles])].sort() };
  await atomicWrite(join(installDir, markerName), JSON.stringify(state, null, 2));
  let movedTree = false;
  await progress?.("Writing program files", 0, newFiles.length);
  if (canMoveTree) {
    await noLinks(appDir);
    if (await stat(appDir)) fail("INSTALL_FILE_COLLISION", "The program destination appeared during installation.");
    for (const dir of emptyDirectories) await rmdir(dir);
    try { await rename(payloadDir, appDir); movedTree = true; }
    catch (error) { if (!["EXDEV", "EPERM", "EACCES"].includes(error.code)) throw error; }
  }
  if (movedTree) await progress?.("Writing program files", newFiles.length, newFiles.length);
  else {
    // A bounded group overlaps filesystem waits. Always wait for every file in
    // the group before reporting failure, so cleanup cannot race pending writes.
    const batchSize = 8;
    for (let start = 0; start < newFiles.length; start += batchSize) {
      const batch = newFiles.slice(start, start + batchSize);
      const results = await Promise.allSettled(batch.map(name => {
        const parts = name.split("/");
        return installFile(join(payloadDir, ...parts), join(appDir, ...parts), consumePayload && !canMoveTree);
      }));
      const written = start + results.filter(result => result.status === "fulfilled").length;
      const failed = results.find(result => result.status === "rejected");
      await progress?.("Writing program files", written, newFiles.length);
      if (failed) throw failed.reason;
    }
  }
  await progress?.("Removing obsolete program files", 0, obsolete.length);
  let removed = 0;
  for (const name of obsolete) {
    await removeOwnedFile(appDir, name);
    removed += 1;
    await progress?.("Removing obsolete program files", removed, obsolete.length);
  }
  if (obsolete.length) await pruneEmptyDirectories(appDir, obsolete);
  await progress?.("Recording completed installation");
  state.phase = "installed";
  state.payloadFiles = newFiles;
  await atomicWrite(join(installDir, markerName), JSON.stringify(state, null, 2));
  return state;
}

export async function uninstallApplication(options) {
  const state = await preflight({ ...options, requireInstalled: true });
  const appDir = join(options.installDir, "app");
  const hasAutostart = state.payloadFiles.includes(autostartPayload);
  const rootFiles = hasAutostart ? [...ownedRootFiles, "autostart.mjs"] : ownedRootFiles;
  // Validate every target before the first deletion. Never follow junctions or
  // remove an unlisted file, including files added by the user after installation.
  for (const name of state.payloadFiles) {
    const target = join(appDir, ...name.split("/"));
    await noLinks(target);
    const info = await stat(target);
    if (info && !info.isFile()) fail("INSTALL_OWNER_INVALID", "A managed file is no longer a regular file; no files were removed.");
  }
  for (const name of rootFiles) {
    const target = join(options.installDir, name);
    await noLinks(target);
    const info = await stat(target);
    if (info && !info.isFile()) fail("INSTALL_OWNER_INVALID", "A managed program file was replaced by a directory; no files were removed.");
  }
  await stoppedDaemonLock(options.dataDir);
  if (process.platform === "win32" && hasAutostart) {
    await windowsAutostart("disable", { programDir: appDir, dataDir: options.dataDir });
  }
  for (const name of state.payloadFiles) await removeOwnedFile(appDir, name);
  await pruneEmptyDirectories(appDir, state.payloadFiles);
  for (const name of rootFiles) await removeOwnedFile(options.installDir, name);
  await unlink(join(options.installDir, markerName));
  return { dataRetained: true, dataDir: options.dataDir };
}

async function main(args) {
  if (process.platform !== "win32") fail("WINDOWS_INSTALL_REQUIRED", "This helper only installs native Windows payloads on Windows.");
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    "install-dir": { type: "string" }, "data-dir": { type: "string" }, "payload-dir": { type: "string" },
    "payload-files": { type: "string" }, "status-file": { type: "string" }, "log-file": { type: "string" },
    version: { type: "string" },
  } });
  const operation = positionals[0];
  let previousPhase, previousLabel, lastOutput = 0;
  const report = async (message) => {
    console.log(message);
    if (values["status-file"]) await writeFile(values["status-file"], message + "\r\n").catch(() => {});
    if (values["log-file"]) await appendFile(values["log-file"], `${new Date().toISOString()} [${operation}] ${message}\r\n`).catch(() => {});
  };
  const progress = async (phase, completed, total) => {
    const time = Date.now();
    if (phase === previousPhase && completed !== total && time - lastOutput < 3000) return;
    previousPhase = phase;
    lastOutput = time;
    previousLabel = total === undefined ? phase : `${phase} (${completed}/${total})`;
    await report(previousLabel);
  };
  try {
    await diagnostic("operation-start", { operation: ["preflight", "install", "uninstall"].includes(operation) ? operation : "invalid" });
    if (positionals.length !== 1 || !values["install-dir"] || !values["data-dir"])
      fail("INSTALL_INPUT_INVALID", "Expected one installer operation and explicit program/data directories.");
    const options = { installDir: values["install-dir"], dataDir: values["data-dir"] };
    if (operation === "preflight") {
      await progress("Checking FlowHub processes and directories");
      await preflight(options);
    } else if (operation === "uninstall") {
      await progress("Checking FlowHub and removing managed program files");
      await uninstallApplication(options);
    } else if (operation === "install" && values["payload-dir"] && values["payload-files"] && values.version) {
      const payloadFiles = JSON.parse(await readFile(values["payload-files"], "utf8"));
      await installApplication({ ...options, payloadDir: values["payload-dir"], payloadFiles,
        version: values.version, consumePayload: true, progress });
    } else fail("INSTALL_INPUT_INVALID", "Unsupported or incomplete installer operation.");
    await report("Completed.");
  } catch (error) {
    await diagnostic("operation-failed", { code: /^(INSTALL|WINDOWS)_[A-Z_]+:/.exec(error.message ?? "")?.[0].slice(0, -1) ?? "INSTALL_FAILED" });
    const details = {
      ENOSPC: "INSTALL_DISK_FULL: Free some space on the program or temporary drive, then retry.",
      EACCES: "INSTALL_ACCESS_DENIED: Windows denied access to a program file or directory.",
      EPERM: "INSTALL_ACCESS_DENIED: Windows denied access to a program file or directory.",
      EBUSY: "INSTALL_FILE_IN_USE: Windows reports that a program file is in use.",
      ENOENT: "INSTALL_FILE_MISSING: Windows could no longer find a staged file or destination.",
      EIO: "INSTALL_DISK_IO_FAILED: Windows reported a disk read or write error.",
    };
    const reason = /^(INSTALL|WINDOWS)_[A-Z_]+:/.test(error.message) ? error.message
      : details[error.code] ?? "INSTALL_FAILED: Windows could not complete this phase.";
    await report(previousLabel ? `${previousLabel} - ${reason}` : reason);
    process.exitCode = /^INSTALL_(?:BUSY|DAEMON_LOCKED):/.test(reason) ? 20 : 21;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main(process.argv.slice(2)).catch(() => {
    console.error("INSTALL_INPUT_INVALID: The installation helper could not be started with these arguments.");
    process.exitCode = 21;
  });
