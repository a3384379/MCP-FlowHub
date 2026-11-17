import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const { connectionFile, validateConnection, readConnection, configure } =
  await import(pathToFileURL(resolve("scripts/flowhub-plugin.mjs")).href);
const { stagePlugin, verifyPlugin } = await import(
  pathToFileURL(resolve("scripts/package-plugin.mjs")).href
);

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "FlowHub 插件 test "));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    file: connectionFile({ CODEX_HOME: join(root, "codex") }),
    dataDir: join(root, "data"),
  };
}

test("plugin config defaults without creating state; invalid settings fail closed", async (t) => {
  const { root, file, dataDir } = await fixture(t);
  assert.deepEqual(await readConnection(file, dataDir), {
    version: 1,
    dataDir,
  });
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(
    readConnection(file, "relative-default"),
    /PLUGIN_CONFIG_INVALID/,
  );
  for (const value of [
    null,
    [],
    { version: 2, dataDir },
    { version: 1, dataDir: "relative" },
    { version: 1, dataDir, tokenFile: "relative" },
    { version: 1, dataDir, token: "PRIVATE_SENTINEL" },
  ]) {
    assert.throws(() => validateConnection(value), /PLUGIN_CONFIG_INVALID/);
  }
  await mkdir(join(root, "codex", "flowhub"), { recursive: true });
  for (const text of [
    "{broken PRIVATE_SENTINEL",
    JSON.stringify({ version: 1, dataDir, token: "PRIVATE_SENTINEL" }),
  ]) {
    await writeFile(file, text);
    await assert.rejects(readConnection(file, dataDir), (error) => {
      assert.match(String(error), /PLUGIN_CONFIG_INVALID/);
      assert.doesNotMatch(String(error), /PRIVATE_SENTINEL/);
      return true;
    });
  }
});

test("plugin config keeps restricted identity and only writes references outside the package", async (t) => {
  const { root, file, dataDir } = await fixture(t);
  const tokenFile = join(root, "client.token");
  await writeFile(tokenFile, "PRIVATE_SENTINEL");
  const previous = { version: 1, dataDir, tokenFile };
  assert.deepEqual(
    await configure(file, previous, { "data-dir": dataDir }),
    previous,
  );
  assert.doesNotMatch(await readFile(file, "utf8"), /PRIVATE_SENTINEL/);
  if (process.platform !== "win32")
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(root, "codex", "flowhub")), [
    "connection.json",
  ]);
  await assert.rejects(
    configure(file, previous, { "data-dir": join(root, "other") }),
    /PLUGIN_IDENTITY_REQUIRED/,
  );
  assert.deepEqual(await readConnection(file, dataDir), previous);
  await assert.rejects(
    configure(file, previous, { personal: true, "token-file": tokenFile }),
    /PLUGIN_INPUT_INVALID/,
  );
  await assert.rejects(configure(file, previous, {}), /PLUGIN_INPUT_INVALID/);
  assert.deepEqual(await configure(file, previous, { personal: true }), {
    version: 1,
    dataDir,
  });
});

test("plugin config rejects links instead of silently changing identity", async (t) => {
  const { root, file, dataDir } = await fixture(t);
  await mkdir(join(root, "codex", "flowhub"), { recursive: true });
  const original = join(root, "original.json");
  await writeFile(original, JSON.stringify({ version: 1, dataDir }));
  await link(original, file);
  await assert.rejects(readConnection(file, dataDir), /PLUGIN_CONFIG_INVALID/);
  await rm(file);
  // Symlink creation on Windows can require an unavailable OS privilege.
  if (process.platform !== "win32") {
    await symlink(original, file);
    await assert.rejects(
      readConnection(file, dataDir),
      /PLUGIN_CONFIG_INVALID/,
    );
  }
});

test(
  "plugin entry runs through a symlinked parent directory",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root } = await fixture(t);
    await symlink(resolve("scripts"), join(root, "linked scripts"), "dir");
    const { stdout } = await promisify(execFile)(process.execPath, [
      join(root, "linked scripts", "flowhub-plugin.mjs"),
      "--help",
    ]);
    assert.match(stdout, /FlowHub Codex 插件/);
  },
);

test("native plugin staging includes portable manifests, skills and marketplace; tamper is rejected", async (t) => {
  const { root } = await fixture(t);
  for (const platform of ["darwin", "linux", "win32"]) {
    const bundle = join(root, platform);
    await stagePlugin(bundle, resolve("."), platform);
    await verifyPlugin(bundle, platform);
    await assert.rejects(
      verifyPlugin(bundle, platform, "stale-version"),
      /Plugin and application versions must match/,
    );
    const mcp = JSON.parse(await readFile(join(bundle, "mcp.json"), "utf8"));
    assert.equal(
      mcp.mcpServers.flowhub.command,
      "./runtime/" + (platform === "win32" ? "node.exe" : "node"),
    );
    assert.doesNotMatch(
      JSON.stringify(mcp),
      new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    mcp.mcpServers.flowhub.args.push("--personal");
    await writeFile(join(bundle, "mcp.json"), JSON.stringify(mcp));
    await assert.rejects(verifyPlugin(bundle, platform));
  }
});
