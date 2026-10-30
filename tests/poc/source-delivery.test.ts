import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

// Packaging helpers remain executable JavaScript, outside the TypeScript dist.
const {
  createSourceSnapshot,
  verifySourceSnapshot,
  assertSourceUnchanged,
  sourceRootFiles,
  sourceDirectories,
} = await import(pathToFileURL(resolve("scripts/source-snapshot.mjs")).href);

async function put(root: string, path: string, content = "fixture\n") {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "flowhub-source-delivery-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "checkout");
  const bundle = join(base, "bundle");
  await mkdir(root);
  await mkdir(bundle);
  for (const path of sourceRootFiles as string[]) await put(root, path);
  await put(root, ".npmrc", "engine-strict=true\n");
  await put(
    root,
    "package.json",
    JSON.stringify({
      version: "fixture",
      scripts: { build: "tsc", test: "node --test" },
      devDependencies: { typescript: "fixture-pinned" },
    }),
  );
  await put(
    root,
    "package-lock.json",
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { devDependencies: { typescript: "fixture-pinned" } } },
    }),
  );
  for (const path of sourceDirectories as string[])
    await put(root, `${path}/fixture.json`, '{"synthetic":true}\n');
  await put(root, "apps/web/src/main.tsx", "export const app = 'synthetic';\n");
  await put(root, ".github/workflows/ci.yml", "name: fixture\n");
  await put(root, "templates/report.md", "# Synthetic report\n");
  await put(root, "examples/workflow.json", '{"environment":"synthetic"}\n');
  const stage = async () => {
    const snapshot = await createSourceSnapshot(root, bundle);
    for (const directory of ["contracts", "examples", "templates"])
      await cp(join(bundle, "source", directory), join(bundle, directory), {
        recursive: true,
      });
    return snapshot;
  };
  return { root, bundle, stage };
}

test("offline source snapshot preserves original build inputs and excludes local state", async (t) => {
  const { root, bundle, stage } = await fixture(t);
  for (const path of [
    ".env",
    ".aws/credentials",
    "node_modules/dependency/index.js",
    "artifacts/package.json",
    "data/local.json",
    "apps/node_modules/private.json",
    "packages/data/database.json",
    "scripts/.env.local",
    "docs/credentials.json",
    "tests/secrets.json",
    "apps/private.key",
  ])
    await put(root, path, "PRIVATE_FIXTURE_SENTINEL\n");
  const snapshot = await stage();
  await verifySourceSnapshot(bundle, snapshot);
  await assertSourceUnchanged(root, snapshot.files);
  for (const path of [
    "apps/web/src/main.tsx",
    ".github/workflows/ci.yml",
    "examples/workflow.json",
    "templates/report.md",
    "package.json",
    "package-lock.json",
    "playwright.config.ts",
  ])
    assert.ok(Object.hasOwn(snapshot.files, path), path);
  assert.equal(
    Object.keys(snapshot.files).some((path) =>
      /node_modules|artifacts|data\/|credentials|secrets|\.env|\.key$/.test(
        path,
      ),
    ),
    false,
  );
  for (const path of ["package.json", "package-lock.json"])
    assert.deepEqual(
      await readFile(join(bundle, "source", path)),
      await readFile(join(root, path)),
    );
  const manifest = JSON.parse(
    await readFile(join(bundle, "source-manifest.sha256.json"), "utf8"),
  );
  assert.deepEqual(manifest, snapshot.files);
  assert.equal(
    snapshot.sourceTreeSha256,
    createHash("sha256")
      .update(JSON.stringify(Object.entries(manifest).sort()))
      .digest("hex"),
  );
});

test("source verification rejects changed bytes and a replaced source tree identity", async (t) => {
  const { bundle, stage } = await fixture(t);
  const snapshot = await stage();
  const content = "changed synthetic workflow\n";
  await put(bundle, "source/apps/fixture.json", content);
  await assert.rejects(
    verifySourceSnapshot(bundle, snapshot),
    /Source snapshot must match every source manifest hash/,
  );
  const files = {
    ...snapshot.files,
    "apps/fixture.json": createHash("sha256").update(content).digest("hex"),
  };
  await put(bundle, "source-manifest.sha256.json", JSON.stringify(files));
  await assert.rejects(
    verifySourceSnapshot(bundle, snapshot),
    /Source tree hash mismatch/,
  );
});

test("runtime contract, example and template contents must match recoverable source", async (t) => {
  for (const directory of ["contracts", "examples", "templates"]) {
    await t.test(directory, async (child) => {
      const { bundle, stage } = await fixture(child);
      const snapshot = await stage();
      await put(bundle, `${directory}/fixture.json`, "changed runtime data\n");
      await assert.rejects(
        verifySourceSnapshot(bundle, snapshot),
        new RegExp(`Runtime ${directory} differs from source snapshot`),
      );
    });
  }
});

test("runtime file additions and source manifest path escapes are rejected", async (t) => {
  const { bundle, stage } = await fixture(t);
  const snapshot = await stage();
  await put(bundle, "examples/unlisted.json", "{}\n");
  await assert.rejects(
    verifySourceSnapshot(bundle, snapshot),
    /Runtime examples differs from source snapshot/,
  );
  await put(
    bundle,
    "source-manifest.sha256.json",
    JSON.stringify({
      ...snapshot.files,
      "apps/../../credentials.json": "0".repeat(64),
    }),
  );
  await assert.rejects(
    verifySourceSnapshot(bundle, snapshot),
    /Invalid source manifest path/,
  );
});

test("source capture refuses symlinks and credential-bearing npm configuration", async (t) => {
  await t.test("npm credentials", async (child) => {
    const { root, stage } = await fixture(child);
    await put(
      root,
      ".npmrc",
      "//registry.example.invalid/:_authToken=PRIVATE_FIXTURE_SENTINEL\n",
    );
    await assert.rejects(
      stage(),
      /Source .npmrc must not contain credential settings/,
    );
  });
  await t.test(
    "symlink",
    {
      skip:
        process.platform === "win32"
          ? "Windows symlink creation requires host privileges"
          : false,
    },
    async (child) => {
      const { root, stage } = await fixture(child);
      await symlink(
        join(root, "package.json"),
        join(root, "apps", "linked.json"),
      );
      await assert.rejects(stage(), /Symlink not allowed in source/);
    },
  );
});

test("a source edit during packaging requires a fresh candidate", async (t) => {
  const { root, stage } = await fixture(t);
  const snapshot = await stage();
  await put(root, "examples/workflow.json", '{"changed":true}\n');
  await assert.rejects(
    assertSourceUnchanged(root, snapshot.files),
    /Source changed while packaging/,
  );
});
