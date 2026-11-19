import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, lstat } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";

// Deliberately enumerate source roots and build configuration. Never copy the
// checkout wholesale: it may contain local credentials, databases or artifacts.
export const sourceDirectories = [
  "apps",
  "packages",
  "scripts",
  "tests",
  "contracts",
  "examples",
  "templates",
  "installer",
  ".github",
  "docs",
  "plugins",
];
export const sourceRootFiles = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.mjs",
  "playwright.config.ts",
  ".npmrc",
  ".node-version",
  ".nvmrc",
  ".gitignore",
  "README.md",
  "AGENTS.md",
  "Build-Windows.cmd",
  "plugins/flowhub/.codex-plugin/plugin.json",
];
export const sourceSnapshot = Object.freeze({
  formatVersion: 1,
  directory: "source",
  manifest: "source-manifest.sha256.json",
});

const extensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".html",
  ".css",
  ".svg",
  ".yml",
  ".yaml",
  ".txt",
  ".sh",
  ".ps1",
  ".nsi",
  ".nsh",
  ".cmd",
]);
const excludedDirectories = new Set([
  "node_modules",
  "dist",
  "web-dist",
  "artifacts",
  "data",
  "coverage",
  "test-results",
  "playwright-report",
  "__pycache__",
]);
const excludedNames =
  /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|execution-token|endpoint\.json|daemon\.lock)$/i;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const portable = (path) => path.replaceAll("\\", "/");
const sorted = (files) => Object.fromEntries(Object.entries(files).sort());

function safePath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.includes("\\") &&
    !path.includes(":") &&
    path.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function excludedPart(part) {
  return (
    part.startsWith(".") ||
    excludedDirectories.has(part) ||
    excludedNames.test(part)
  );
}

function allowedSourcePath(path) {
  if (!safePath(path)) return false;
  if (sourceRootFiles.includes(path)) return true;
  const [root, ...parts] = path.split("/");
  return (
    sourceDirectories.includes(root) &&
    parts.length > 0 &&
    parts.every((part) => !excludedPart(part)) &&
    extensions.has(extname(parts.at(-1)).toLowerCase())
  );
}

function checkNpmConfig(bytes) {
  // npm config is needed to reconstruct the pinned install, but must never
  // carry authentication settings into an otherwise public source snapshot.
  assert.ok(
    !/^(?!\s*[#;]).*(?:_auth|_password|username\s*=|password\s*=|token\s*=)/im.test(
      bytes.toString("utf8"),
    ),
    "Source .npmrc must not contain credential settings.",
  );
}

export function sourceTreeHash(files) {
  return sha256(JSON.stringify(Object.entries(files).sort()));
}

async function readSource(root, onFile = async () => {}) {
  const files = {};
  async function file(path) {
    const target = join(root, path);
    assert.ok(
      (await lstat(target)).isFile(),
      `Source must be a regular file: ${path}`,
    );
    const bytes = await readFile(target);
    if (path === ".npmrc") checkNpmConfig(bytes);
    files[path] = sha256(bytes);
    await onFile(path, bytes);
  }
  async function directory(path) {
    assert.ok(
      (await lstat(join(root, path))).isDirectory(),
      `Source must be a directory: ${path}`,
    );
    const entries = await readdir(join(root, path), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${path}/${entry.name}`;
      if (excludedPart(entry.name)) continue;
      assert.equal(
        entry.isSymbolicLink(),
        false,
        `Symlink not allowed in source: ${child}`,
      );
      if (entry.isDirectory()) await directory(child);
      else if (allowedSourcePath(child)) await file(child);
    }
  }
  for (const path of sourceRootFiles) await file(path);
  for (const path of sourceDirectories) await directory(path);
  return sorted(files);
}

export async function createSourceSnapshot(root, bundle) {
  const destination = join(bundle, sourceSnapshot.directory);
  await mkdir(destination);
  const files = await readSource(root, async (path, bytes) => {
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await writeFile(join(destination, path), bytes);
  });
  await writeFile(
    join(bundle, sourceSnapshot.manifest),
    JSON.stringify(files, null, 2),
  );
  return { files, sourceTreeSha256: sourceTreeHash(files), sourceSnapshot };
}

export async function assertSourceUnchanged(root, files) {
  assert.deepEqual(
    await readSource(root),
    files,
    "Source changed while packaging; rebuild the candidate.",
  );
}

async function inventory(root) {
  const files = {};
  assert.ok((await lstat(root)).isDirectory(), `Expected directory: ${root}`);
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      const name = portable(relative(root, target));
      assert.equal(
        entry.isSymbolicLink(),
        false,
        `Symlink not allowed in source/runtime: ${name}`,
      );
      if (entry.isDirectory()) await walk(target);
      else {
        assert.ok(
          entry.isFile(),
          `Expected regular source/runtime file: ${name}`,
        );
        files[name] = sha256(await readFile(target));
      }
    }
  }
  await walk(root);
  return sorted(files);
}

export async function verifySourceSnapshot(bundle, build) {
  assert.deepEqual(
    build.sourceSnapshot,
    sourceSnapshot,
    "Source snapshot metadata is required.",
  );
  const files = JSON.parse(
    await readFile(join(bundle, sourceSnapshot.manifest), "utf8"),
  );
  assert.ok(
    files && typeof files === "object" && !Array.isArray(files),
    "Invalid source manifest.",
  );
  for (const [path, expected] of Object.entries(files)) {
    assert.ok(allowedSourcePath(path), `Invalid source manifest path: ${path}`);
    assert.equal(typeof expected, "string");
    assert.match(expected, /^[a-f0-9]{64}$/);
  }
  for (const path of sourceRootFiles)
    assert.ok(
      Object.hasOwn(files, path),
      `Required source file missing: ${path}`,
    );
  for (const path of sourceDirectories)
    assert.ok(
      Object.keys(files).some((file) => file.startsWith(`${path}/`)),
      `Required source directory missing: ${path}`,
    );
  const actual = await inventory(join(bundle, sourceSnapshot.directory));
  for (const path of Object.keys(actual))
    assert.ok(
      allowedSourcePath(path),
      `Disallowed source snapshot path: ${path}`,
    );
  assert.deepEqual(
    actual,
    sorted(files),
    "Source snapshot must match every source manifest hash.",
  );
  checkNpmConfig(
    await readFile(join(bundle, sourceSnapshot.directory, ".npmrc")),
  );
  assert.equal(
    sourceTreeHash(actual),
    build.sourceTreeSha256,
    "Source tree hash mismatch.",
  );
  // These are live runtime inputs, not merely documentation. Their full file
  // sets and bytes must match the recoverable source tree, including new files.
  for (const directory of ["contracts", "examples", "templates"]) {
    const expected = Object.fromEntries(
      Object.entries(actual)
        .filter(([path]) => path.startsWith(`${directory}/`))
        .map(([path, digest]) => [path.slice(directory.length + 1), digest]),
    );
    assert.deepEqual(
      await inventory(join(bundle, directory)),
      expected,
      `Runtime ${directory} differs from source snapshot.`,
    );
  }
}
