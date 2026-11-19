import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyBundle } from "./verify-release.mjs";
import { execWithoutInput } from "../installer/windows/install-helper.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function assertWindowsBuild(platform = process.platform, arch = process.arch) {
  if (platform !== "win32" || arch !== "x64")
    throw new Error("WINDOWS_BUILD_REQUIRED: Build the x64 installer on native Windows x64 with native Windows Node/SQLite. Linux cannot produce or certify this installer.");
}

export function peMachine(bytes) {
  assert.ok(bytes.length >= 64 && bytes.toString("ascii", 0, 2) === "MZ", "Expected a native Windows PE executable.");
  const offset = bytes.readUInt32LE(0x3c);
  assert.ok(offset <= bytes.length - 6 && bytes.toString("binary", offset, offset + 4) === "PE\0\0", "Invalid Windows PE header.");
  return bytes.readUInt16LE(offset + 4);
}

export async function verifyPinnedToolchain(archive, pin) {
  assert.equal(pin.name, "NSIS");
  assert.equal(pin.version, "3.11", "NSIS compiler version must be pinned.");
  assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  assert.equal(hash(await readFile(archive)), pin.sha256, "NSIS archive SHA-256 mismatch. Use the reviewed toolchain ZIP; do not substitute an installed compiler.");
}

export async function verifyLoadedNativeModules(bundle, loadedPaths) {
  const files = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.name.endsWith(".node")) files.push(target);
    }
  }
  await walk(join(bundle, "node_modules"));
  assert.ok(Array.isArray(loadedPaths) && loadedPaths.length > 0 &&
    loadedPaths.every((path) => typeof path === "string" && isAbsolute(path)),
  "The real SQLite query must report its actually loaded native binding paths.");
  const key = (path) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  const inventory = new Map(files.map((path) => [key(path), path]));
  const loaded = [...new Set(loadedPaths.map(key))];
  for (const path of loaded) {
    assert.ok(inventory.has(path), `Loaded native binding must belong to the verified bundle: ${path}`);
    assert.equal(peMachine(await readFile(inventory.get(path))), 0x8664, `Actually loaded binding must be Windows x64 PE: ${path}`);
  }
  const sqliteRoot = join(bundle, "node_modules/better-sqlite3");
  assert.ok(loaded.some((path) => {
    const value = relative(key(sqliteRoot), path);
    return value && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
  }), "The real SQLite query must actually load the bundled better-sqlite3 native binding.");
  // better-sqlite3 13 ships all supported platform prebuilds in the same locked
  // npm package. Verify the binding Node actually used, and enumerate unused
  // prebuilds without claiming they are Windows executables or executing them.
  const portable = (path) => relative(resolve(bundle), path).replaceAll("\\", "/");
  return {
    loaded: loaded.map((path) => portable(inventory.get(path))),
    unused: files.filter((path) => !loaded.includes(key(path))).map(portable),
  };
}

const nsisString = (value) => {
  assert.ok(!/[\r\n"]/.test(value), "Invalid NSIS build definition.");
  return value.replaceAll("$", "$$");
};

export async function buildWindowsInstaller({ bundle, archive, outputDir = join(root, "artifacts") }) {
  assertWindowsBuild();
  await verifyBundle(bundle);
  const sourceRoot = join(bundle, "source");
  const pkg = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  assert.equal(hash(await readFile(fileURLToPath(import.meta.url))), hash(await readFile(join(sourceRoot, "scripts/windows-installer.mjs"))),
    "The installer builder must match the bundle's recoverable source; rebuild the offline bundle after source changes.");
  assert.equal(process.versions.node, pkg.engines.node, "Use the pinned Node runtime for the native Windows build.");
  assert.match(pkg.version, /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/);
  const pin = JSON.parse(await readFile(join(sourceRoot, "installer/windows/toolchain.json"), "utf8"));
  await verifyPinnedToolchain(archive, pin);
  const build = JSON.parse(await readFile(join(bundle, "build-info.json"), "utf8"));
  assert.equal(build.os, "win32", "Use a native Windows bundle; never reuse Linux node_modules.");
  assert.equal(build.arch, "x64");
  assert.equal(build.node, pkg.engines.node);
  assert.equal(build.version, pkg.version);
  const runtime = join(bundle, "runtime/node.exe");
  assert.equal(peMachine(await readFile(runtime)), 0x8664, "Bundled Node must be Windows x64.");
  const { stdout: nativeSmoke } = await exec(runtime, ["--input-type=commonjs", "-e",
    "const assert=require('node:assert/strict');assert.equal(process.platform,'win32');assert.equal(process.arch,'x64');const DB=require('better-sqlite3');const db=new DB(':memory:');assert.equal(db.prepare('select 42 as value').get().value,42);db.close();console.log(JSON.stringify({os:process.platform,arch:process.arch,node:process.versions.node,sqlite:true,nativeModules:Object.keys(require.cache).filter(path=>path.endsWith('.node'))}));"],
  { cwd: bundle, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  const nativeResult = JSON.parse(nativeSmoke);
  assert.equal(nativeResult.os, "win32");
  assert.equal(nativeResult.arch, "x64");
  assert.equal(nativeResult.node, pkg.engines.node);
  assert.equal(nativeResult.sqlite, true);
  const modules = await verifyLoadedNativeModules(bundle, nativeResult.nativeModules);

  const temporary = await mkdtemp(join(tmpdir(), "flowhub-windows-installer-"));
  try {
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    // Expand only the exact reviewed archive into a new private staging path.
    // No downloads, system NSIS installation, PATH lookup or package manager.
    await execWithoutInput(powershell, ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:FLOWHUB_NSIS_ARCHIVE -DestinationPath $env:FLOWHUB_NSIS_STAGE"],
    { env: { ...process.env, FLOWHUB_NSIS_ARCHIVE: resolve(archive), FLOWHUB_NSIS_STAGE: temporary }, windowsHide: true, timeout: 60_000 });
    const nsisDir = join(temporary, pin.directory);
    const compiler = join(nsisDir, "makensis.exe");
    assert.ok((await lstat(compiler)).isFile());
    const { stdout: compilerVersion } = await exec(compiler, ["/VERSION"], { windowsHide: true });
    assert.equal(compilerVersion.trim(), `v${pin.version}`);
    const manifest = JSON.parse(await readFile(join(bundle, "manifest.sha256.json"), "utf8"));
    manifest["manifest.sha256.json"] = hash(await readFile(join(bundle, "manifest.sha256.json")));
    const manifestPath = join(temporary, "payload-manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    // Generic setup/install/update names trigger unsafe Windows compatibility
    // shims and NSIS warning 9000. Keep /WX and use a product/version name.
    const stagedOutput = join(temporary, `flowhub-${pkg.version}-candidate.exe`);
    assert.ok(!["setup.exe", "install.exe", "update.exe"].includes(basename(stagedOutput).toLowerCase()),
      "NSIS compiler output must use a product/version-specific filename.");
    const definitions = {
      FLOWHUB_VERSION: pkg.version,
      FLOWHUB_OUTPUT: stagedOutput,
      FLOWHUB_BUNDLE: resolve(bundle),
      FLOWHUB_HELPER: join(sourceRoot, "installer/windows/install-helper.mjs"),
      FLOWHUB_AUTOSTART: join(sourceRoot, "installer/windows/autostart.mjs"),
      FLOWHUB_MANIFEST: manifestPath,
      FLOWHUB_LAUNCHER: join(sourceRoot, "installer/windows/flowhub.cmd"),
      FLOWHUB_NSIS_LICENSE: join(nsisDir, "COPYING"),
      FLOWHUB_NSIS_NOTICE: join(sourceRoot, "installer/windows/NSIS-NOTICE.txt"),
    };
    const definesPath = join(temporary, "flowhub-defines.nsh");
    await writeFile(definesPath, Object.entries(definitions).map(([name, value]) => `!define ${name} "${nsisString(value)}"`).join("\n") + "\n");
    const { stdout, stderr } = await exec(compiler, ["/V3", "/WX", "/NOCD", "/INPUTCHARSET", "UTF8", `/DFLOWHUB_DEFINES=${definesPath}`, join(sourceRoot, "installer/windows/FlowHub.nsi")],
    { cwd: root, env: { ...process.env, NSISDIR: nsisDir }, windowsHide: true, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
    console.log(stdout.trim());
    if (stderr.trim()) console.log(stderr.trim());
    // Reject concurrent source-bundle modifications during compiler input reads.
    await verifyBundle(bundle);
    const bytes = await readFile(stagedOutput);
    assert.ok([0x014c, 0x8664].includes(peMachine(bytes)), "NSIS must produce a genuine Windows installer executable.");
    await mkdir(outputDir, { recursive: true });
    const installer = join(outputDir, `flowhub-${pkg.version}-windows-x64-setup.exe`);
    await cp(stagedOutput, installer, { force: true });
    const installerSha256 = hash(bytes);
    await writeFile(`${installer}.sha256`, `${installerSha256}  ${installer.split(/[\\/]/).at(-1)}\n`);
    const metadata = {
      formatVersion: 1, version: pkg.version, installer, installerSha256, bundle: resolve(bundle),
      builtAt: new Date().toISOString(), os: "win32", arch: "x64", node: pkg.engines.node,
      sourceTreeSha256: build.sourceTreeSha256, nativeWindowsBuild: true, windowsValidated: false, companyValidated: false,
      signed: false, nsis: { version: pin.version, archiveSha256: pin.sha256 },
      nativeModules: modules.loaded,
      unusedNativeModules: modules.unused,
      nativeModulePolicy: "Only the bindings actually loaded by the successful Windows x64 SQLite query were executed and verified as Windows x64 PE. Unused platform prebuilds remain as shipped in the locked npm package and are not Windows validation evidence.",
      dataPolicy: "Per-user installation; independent %LOCALAPPDATA%\\MCP-FlowHub data is retained on uninstall.",
    };
    await writeFile(`${installer}.build-info.json`, JSON.stringify(metadata, null, 2));
    await writeFile(join(outputDir, "latest-installer.json"), JSON.stringify(metadata, null, 2));
    console.log(JSON.stringify(metadata, null, 2));
    return metadata;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assertWindowsBuild();
  const { values } = parseArgs({ options: {
    bundle: { type: "string" }, "nsis-archive": { type: "string" }, "output-dir": { type: "string" },
  } });
  if (!values["nsis-archive"]) throw new Error("NSIS_ARCHIVE_REQUIRED: Supply the local reviewed NSIS ZIP with --nsis-archive. The builder never downloads tools.");
  const latest = values.bundle ? null : JSON.parse(await readFile(join(root, "artifacts/latest-package.json"), "utf8"));
  await buildWindowsInstaller({ bundle: resolve(values.bundle ?? latest.bundle), archive: resolve(values["nsis-archive"]),
    ...(values["output-dir"] ? { outputDir: resolve(values["output-dir"]) } : {}) });
}
