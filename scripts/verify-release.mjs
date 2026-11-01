import { readFile, readdir, lstat } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { verifySourceSnapshot } from "./source-snapshot.mjs";

export async function verifyBundle(bundle) {
  const manifest = JSON.parse(
    await readFile(join(bundle, "manifest.sha256.json"), "utf8"),
  );
  const actual = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      assert.equal(
        entry.isSymbolicLink(),
        false,
        "No symlinks permitted in offline bundle.",
      );
      if (entry.isDirectory()) await walk(path);
      else actual.push(relative(bundle, path).replaceAll("\\", "/"));
    }
  }
  await walk(bundle);
  assert.deepEqual(
    actual.filter((p) => p !== "manifest.sha256.json").sort(),
    Object.keys(manifest).sort(),
    "manifest must enumerate all files",
  );
  for (const [path, expected] of Object.entries(manifest)) {
    assert.ok(
      path &&
        !path.startsWith("/") &&
        !path.includes("..") &&
        !path.includes("\\") &&
        !path.includes(":"),
      `Invalid manifest path: ${path}`,
    );
    assert.match(String(expected), /^[a-f0-9]{64}$/);
    const bytes = await readFile(join(bundle, path));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      expected,
      `Hash mismatch: ${path}`,
    );
  }
  for (const path of actual) {
    const base = path.split("/").at(-1);
    assert.ok(
      !["execution-token", "endpoint.json", "daemon.lock", ".env"].includes(
        base,
      ),
    );
    assert.ok(!path.endsWith(".sqlite") && !path.startsWith("dist/tests/"));
    assert.ok(!path.startsWith("node_modules/typescript/"));
  }
  const sbom = JSON.parse(
    await readFile(join(bundle, "SBOM.cdx.json"), "utf8"),
  );
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.ok(sbom.components.length > 0);
  const notices = JSON.parse(
    await readFile(join(bundle, "THIRD_PARTY_NOTICES.json"), "utf8"),
  );
  assert.ok(notices.components.length > 0);
  for (const name of ["client", "server", "core"]) {
    assert.ok(
      (
        await lstat(
          join(bundle, `node_modules/@modelcontextprotocol/${name}/LICENSE`),
        )
      ).isFile(),
    );
  }
  assert.ok(
    (
      await readFile(
        join(bundle, "docs/third-party/Node-24.19.0-LICENSE.txt"),
        "utf8",
      )
    ).includes("MIT"),
  );
  assert.ok((await lstat(join(bundle, "web-dist/index.html"))).isFile());
  const build = JSON.parse(
    await readFile(join(bundle, "build-info.json"), "utf8"),
  );
  assert.equal(build.phase, build.version.includes("-alpha.") ? "ALPHA" : "RC");
  for(const file of ["docs/V2_USER_GUIDE.md","docs/V2_MIGRATION.md","dist/packages/workflow-authoring/src/index.js","dist/packages/host-discovery/src/index.js","dist/packages/assistant-core/src/index.js","dist/packages/workflow-testing/src/index.js"])assert.ok(actual.includes(file),"Required v2 runtime file missing: "+file);
  assert.equal(build.syntheticOnly, false);
  await verifySourceSnapshot(bundle, build);
  for(const file of ["README.md","docs/HOST_INTEGRATION.md","docs/V2_USER_GUIDE.md","docs/V2_MIGRATION.md"])
    assert.equal(manifest[file],manifest["source/"+file],"Runtime help differs from source snapshot: "+file);
  const sourcePackage = JSON.parse(
    await readFile(join(bundle, "source/package.json"), "utf8"),
  );
  assert.equal(sourcePackage.version, build.version);
  console.log(
    `Bundle verified: ${actual.length} files, recoverable source snapshot, ${sbom.components.length} SBOM components. Integrity checks only; no signature or enterprise validation claim.`,
  );
}

const invoked =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const { bundle, archive, archiveSha256 } = JSON.parse(
    await readFile(join(root, "artifacts/latest-package.json"), "utf8"),
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(archive))
      .digest("hex"),
    archiveSha256,
  );
  await verifyBundle(bundle);
}
