import {
  cp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  chmod,
} from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { verifyBundle } from "./verify-release.mjs";
import {
  assertSourceUnchanged,
  createSourceSnapshot,
} from "./source-snapshot.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (process.argv.includes("--windows") && process.platform !== "win32") {
  throw new Error(
    "WINDOWS_BUILD_REQUIRED: run package:windows in native Windows CI. Linux cannot certify a Windows bundle.",
  );
}
if (process.versions.node !== pkg.engines.node)
  throw new Error(`Use pinned Node ${pkg.engines.node}.`);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const name = `flowhub-${pkg.version}-${process.platform}-${process.arch}-${stamp}`;
const bundle = join(root, "artifacts", name);
await mkdir(bundle, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const runNpm = async (args) => {
  if (!process.env.npm_execpath)
    throw new Error("Run via npm run package:local or package:windows.");
  return exec(process.execPath, [process.env.npm_execpath, ...args], {
    cwd: bundle,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
};
try {
  const snapshot = await createSourceSnapshot(root, bundle);
  for (const path of [
    "package.json",
    "package-lock.json",
    "contracts",
    "examples",
    "templates",
    "README.md",
    "web-dist",
    "docs/LOCAL_VALIDATION.md",
    "docs/HOST_INTEGRATION.md",
    "docs/V2_USER_GUIDE.md",
    "docs/V2_MIGRATION.md",
    "docs/V2_ACCEPTANCE.md",
    "docs/generated/openapi.json",
    "docs/third-party/Node-24.19.0-LICENSE.txt",
  ]) {
    await mkdir(dirname(join(bundle, path)), { recursive: true });
    await cp(
      join(path === "web-dist" ? root : join(bundle, "source"), path),
      join(bundle, path),
      { recursive: true },
    );
  }
  for (const path of ["apps", "packages"])
    await cp(join(root, "dist", path), join(bundle, "dist", path), {
      recursive: true,
    });
  await mkdir(join(bundle, "runtime"));
  const runtime = join(
    bundle,
    "runtime",
    process.platform === "win32" ? "node.exe" : "node",
  );
  await cp(process.execPath, runtime);
  await chmod(runtime, 0o755);
  // Frozen install in a clean staging directory, preserving TLS and lock integrity.
  const installed = await runNpm([
    "ci",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
  ]);
  console.log(installed.stdout.trim());
  // The distributed product has no development lifecycle. npm sbom in npm 11
  // otherwise treats omitted devDependencies as missing, even with --omit=dev.
  const productionManifest = { ...pkg, scripts: {} };
  delete productionManifest.devDependencies;
  await writeFile(
    join(bundle, "package.json"),
    JSON.stringify(productionManifest, null, 2),
  );
  const productionLock = JSON.parse(
    await readFile(join(bundle, "package-lock.json"), "utf8"),
  );
  delete productionLock.packages[""].devDependencies;
  for (const [path, entry] of Object.entries(productionLock.packages)) {
    if (entry.dev === true) delete productionLock.packages[path];
  }
  await writeFile(
    join(bundle, "package-lock.json"),
    JSON.stringify(productionLock, null, 2),
  );
  // CLI shims are unnecessary: launchers use the included runtime directly.
  await rm(join(bundle, "node_modules", ".bin"), {
    recursive: true,
    force: true,
  });
  const sbom = await runNpm([
    "sbom",
    "--sbom-format",
    "cyclonedx",
    "--omit=dev",
  ]);
  JSON.parse(sbom.stdout);
  await writeFile(join(bundle, "SBOM.cdx.json"), sbom.stdout);

  const components = [];
  async function inventory(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        await inventory(path);
        continue;
      }
      if (!entry.isDirectory()) continue;
      const metadata = JSON.parse(
        await readFile(join(path, "package.json"), "utf8"),
      );
      components.push({
        name: metadata.name,
        version: metadata.version,
        license: metadata.license ?? "REVIEW_REQUIRED",
        path: relative(bundle, path).replaceAll("\\", "/"),
      });
      try {
        await inventory(join(path, "node_modules"));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
  }
  await inventory(join(bundle, "node_modules"));
  components.sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(
    join(bundle, "THIRD_PARTY_NOTICES.json"),
    JSON.stringify(
      {
        notice:
          "Package LICENSE/NOTICE files are retained. MCP SDK LICENSE describes Apache-2.0/MIT transition; do not rely on SPDX metadata alone. Node license is in docs/third-party. This inventory is not legal clearance.",
        components,
      },
      null,
      2,
    ),
  );

  await writeFile(
    join(bundle, "flowhub.cmd"),
    '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0dist\\apps\\daemon\\src\\cli.js" %*\r\n',
  );
  await writeFile(
    join(bundle, "flowhub"),
    '#!/bin/sh\nFLOWHUB_PROGRAM_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$FLOWHUB_PROGRAM_DIR/runtime/node" "$FLOWHUB_PROGRAM_DIR/dist/apps/daemon/src/cli.js" "$@"\n',
    { mode: 0o755 },
  );

  let gitSha = null;
  let dirty = true;
  try {
    gitSha = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim();
    dirty = Boolean(
      (
        await exec("git", ["status", "--porcelain"], { cwd: root })
      ).stdout.trim(),
    );
  } catch {
    /* A source archive can be packaged, but cannot claim a Git SHA. */
  }
  async function collect(path, files, base) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(
          `Symlink not allowed in bundle: ${relative(base, target)}`,
        );
      if (entry.isDirectory()) await collect(target, files, base);
      else
        files[relative(base, target).replaceAll("\\", "/")] = hash(
          await readFile(target),
        );
    }
  }
  await assertSourceUnchanged(root, snapshot.files);
  await writeFile(
    join(bundle, "build-info.json"),
    JSON.stringify(
      {
        version: pkg.version,
        phase: pkg.version.includes("-alpha.") ? "ALPHA" : "RC",
        syntheticOnly: false,
        builtAt: new Date().toISOString(),
        gitSha,
        dirty,
        sourceTreeSha256: snapshot.sourceTreeSha256,
        sourceSnapshot: snapshot.sourceSnapshot,
        os: process.platform,
        arch: process.arch,
        node: process.versions.node,
        runtimeSha256: hash(await readFile(runtime)),
        windowsValidated: false,
        companyValidated: false,
      },
      null,
      2,
    ),
  );
  const files = {};
  await collect(bundle, files, bundle);
  await writeFile(
    join(bundle, "manifest.sha256.json"),
    JSON.stringify(files, null, 2),
  );
  await verifyBundle(bundle);

  const archive = `${bundle}${process.platform === "win32" ? ".zip" : ".tar.gz"}`;
  if (process.platform === "win32") {
    await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Compress-Archive -LiteralPath $env:FLOWHUB_BUNDLE_DIR -DestinationPath $env:FLOWHUB_ARCHIVE_PATH",
      ],
      {
        env: {
          ...process.env,
          FLOWHUB_BUNDLE_DIR: bundle,
          FLOWHUB_ARCHIVE_PATH: archive,
        },
      },
    );
  } else {
    await exec("tar", ["-czf", archive, "-C", dirname(bundle), name]);
  }
  const archiveSha256 = hash(await readFile(archive));
  await writeFile(
    `${archive}.sha256`,
    `${archiveSha256}  ${name}${process.platform === "win32" ? ".zip" : ".tar.gz"}\n`,
  );
  await writeFile(
    join(root, "artifacts", "latest-package.json"),
    JSON.stringify({ bundle, archive, archiveSha256 }, null, 2),
  );
  console.log(
    JSON.stringify(
      { bundle, archive, archiveSha256, components: components.length },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    `Packaging failed. Partial output retained for diagnosis: ${bundle}`,
  );
  throw error;
}
