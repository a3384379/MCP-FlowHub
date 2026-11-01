import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execWithoutInput, inspectWindowsProcesses } from "../installer/windows/install-helper.mjs";
import { windowsTestEnvironment } from "./windows-test-environment.mjs";

assert.equal(process.platform, "win32", "This read-only probe requires native Windows.");
const records = await inspectWindowsProcesses();
assert.ok(records.some(record => record.ProcessId === process.pid));
console.log(JSON.stringify({ nativeProcessInspection: "PASS", environment: "ambient", count: records.length }));

// Match the installer smoke's environment before its runtime directory exists.
// The child gets neither a global Node/npm PATH nor inherited PSModulePath.
const env = windowsTestEnvironment(join(tmpdir(), `flowhub-empty-probe-path-${process.pid}`));
if (process.env.FLOWHUB_INSTALLER_DIAGNOSTICS) env.FLOWHUB_INSTALLER_DIAGNOSTICS = process.env.FLOWHUB_INSTALLER_DIAGNOSTICS;
const helper = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "../installer/windows/install-helper.mjs")).href;
const code = `import assert from 'node:assert/strict';import {inspectWindowsProcesses} from ${JSON.stringify(helper)};const records=await inspectWindowsProcesses();assert.ok(records.some(record=>record.ProcessId===process.pid));console.log(JSON.stringify({nativeProcessInspection:'PASS',environment:'installer-restricted',count:records.length}));`;
const result = await execWithoutInput(process.execPath, ["--input-type=module", "-e", code], { env, windowsHide: true, timeout: 35_000 });
const restricted = JSON.parse(result.stdout);
assert.equal(restricted.nativeProcessInspection, "PASS");
assert.equal(restricted.environment, "installer-restricted");
console.log(JSON.stringify(restricted));
