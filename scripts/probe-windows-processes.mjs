import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execWithoutInput, inspectWindowsProcesses } from "../installer/windows/install-helper.mjs";
import { windowsAutostart } from "../installer/windows/autostart.mjs";
import { windowsTestEnvironment } from "./windows-test-environment.mjs";

assert.equal(process.platform, "win32", "This probe requires native Windows.");
async function main() {
const started = Date.now();
const records = await inspectWindowsProcesses();
assert.ok(records.some(record => record.ProcessId === process.pid));
console.log(JSON.stringify({ nativeProcessInspection: "PASS", environment: "ambient", count: records.length, elapsedMs: Date.now() - started }));

// Match the installer smoke's environment before its runtime directory exists.
// The child gets neither a global Node/npm PATH nor inherited PSModulePath.
const env = windowsTestEnvironment(join(tmpdir(), `flowhub-empty-probe-path-${process.pid}`));
if (process.env.FLOWHUB_INSTALLER_DIAGNOSTICS) env.FLOWHUB_INSTALLER_DIAGNOSTICS = process.env.FLOWHUB_INSTALLER_DIAGNOSTICS;
const helper = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "../installer/windows/install-helper.mjs")).href;
const code = `import assert from 'node:assert/strict';import {inspectWindowsProcesses} from ${JSON.stringify(helper)};const started=Date.now();const records=await inspectWindowsProcesses();assert.ok(records.some(record=>record.ProcessId===process.pid));console.log(JSON.stringify({nativeProcessInspection:'PASS',environment:'installer-restricted',count:records.length,elapsedMs:Date.now()-started}));`;
const result = await execWithoutInput(process.execPath, ["--input-type=module", "-e", code], { env, windowsHide: true, timeout: 65_000 });
const restricted = JSON.parse(result.stdout);
assert.equal(restricted.nativeProcessInspection, "PASS");
assert.equal(restricted.environment, "installer-restricted");
console.log(JSON.stringify(restricted));

const temporary = await mkdtemp(join(tmpdir(), "FlowHub Unicode 快捷方式 "));
try {
  const folder = join(temporary, "程序 files");
  await mkdir(folder);
  const target = join(folder, "目标.exe"), entry = join(folder, "入口.js"), shortcutPath = join(temporary, "启动.lnk");
  await writeFile(target, "Synthetic shortcut target; never executed.");
  await writeFile(entry, "Synthetic shortcut argument; never executed.");
  const argumentsText = `"${entry}" serve`;
  const script = await readFile(new URL("windows-shell-link.ps1", import.meta.url), "utf8");
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const link = await execWithoutInput(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script,"utf16le").toString("base64")], {
    env: { ...env, FLOWHUB_SHORTCUT_PATH: shortcutPath, FLOWHUB_SHORTCUT_CREATE_TARGET: target, FLOWHUB_SHORTCUT_CREATE_ARGUMENTS: argumentsText }, windowsHide: true, timeout: 60_000,
  });
  const actual = JSON.parse(Buffer.from(link.stdout.trim(),"base64").toString("utf16le"));
  assert.equal((await realpath(actual.target)).toLowerCase(), (await realpath(target)).toLowerCase());
  assert.equal(actual.arguments, argumentsText);
  console.log(JSON.stringify({ nativeUnicodeShellLink: "PASS", interface: "IShellLinkW", targetAndArgumentsVerified: true }));
  const taskFixture = { programDir: folder, dataDir: join(temporary, "测试数据") };
  try {
    assert.equal((await windowsAutostart("status", taskFixture)).state, "disabled");
    const enabled = await windowsAutostart("enable", taskFixture);
    assert.equal(enabled.state, "registered");
    assert.equal((await windowsAutostart("status", taskFixture)).taskName, enabled.taskName);
    assert.equal((await windowsAutostart("enable", taskFixture)).taskName, enabled.taskName);
  } finally {
    await windowsAutostart("disable", taskFixture);
  }
  assert.equal((await windowsAutostart("status", taskFixture)).state, "disabled");
  console.log(JSON.stringify({ nativeLogonTask: "PASS", scope: "isolated", unregistered: true }));
} finally { await rm(temporary, {recursive:true,force:true}); }
}
await main().catch(async error => {
  if (process.env.FLOWHUB_INSTALLER_DIAGNOSTICS) for (const suffix of [".node.log", ".powershell.log"]) {
    console.error(await readFile(process.env.FLOWHUB_INSTALLER_DIAGNOSTICS + suffix, "utf8").catch(() => "No phase log"));
  }
  throw error;
});
