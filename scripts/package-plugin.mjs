import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

export function pluginServer(platform, compatibility = false) {
  assert.ok(["win32", "darwin", "linux"].includes(platform));
  return {
    type: "stdio",
    command: "./runtime/" + (platform === "win32" ? "node.exe" : "node"),
    args: ["${PLUGIN_ROOT}/scripts/flowhub-plugin.mjs", "mcp"],
    cwd: "${PLUGIN_ROOT}",
    ...(compatibility
      ? { env_vars: ["CODEX_HOME", "XDG_DATA_HOME", "LOCALAPPDATA"] }
      : {}),
  };
}

export async function stagePlugin(bundle, source, platform = process.platform) {
  const template = join(source, "plugins", "flowhub");
  for (const file of [
    "plugin.json",
    ".codex-plugin/plugin.json",
    "skills",
    "assets",
  ]) {
    await mkdir(dirname(join(bundle, file)), { recursive: true });
    await cp(join(template, file), join(bundle, file), { recursive: true });
  }
  const server = pluginServer(platform);
  await writeFile(
    join(bundle, "mcp.json"),
    JSON.stringify(
      {
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { flowhub: server },
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(bundle, ".mcp.json"),
    JSON.stringify(
      { mcpServers: { flowhub: pluginServer(platform, true) } },
      null,
      2,
    ) + "\n",
  );
  await mkdir(join(bundle, ".agents", "plugins"), { recursive: true });
  await cp(
    join(template, "marketplace.json"),
    join(bundle, ".agents", "plugins", "marketplace.json"),
  );
  await mkdir(join(bundle, "scripts"), { recursive: true });
  await cp(
    join(source, "scripts", "flowhub-plugin.mjs"),
    join(bundle, "scripts", "flowhub-plugin.mjs"),
  );
  await writeFile(
    join(bundle, "flowhub-plugin"),
    '#!/bin/sh\nFLOWHUB_PLUGIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$FLOWHUB_PLUGIN_DIR/runtime/node" "$FLOWHUB_PLUGIN_DIR/scripts/flowhub-plugin.mjs" "$@"\n',
    { mode: 0o755 },
  );
  await writeFile(
    join(bundle, "flowhub-plugin.cmd"),
    '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\flowhub-plugin.mjs" %*\r\n',
  );
}

export async function verifyPlugin(bundle, platform, version) {
  const load = async (file) =>
    JSON.parse(await readFile(join(bundle, file), "utf8"));
  const portable = await load("plugin.json"),
    compatibility = await load(".codex-plugin/plugin.json");
  assert.equal(portable.name, "flowhub");
  assert.equal(compatibility.name, portable.name);
  assert.equal(compatibility.version, portable.version);
  if (version !== undefined) {
    assert.equal(
      portable.version,
      version,
      "Plugin and application versions must match",
    );
    for (const file of [
      "plugin.json",
      ".codex-plugin/plugin.json",
      "assets/logo.svg",
      "skills/flowhub-setup/SKILL.md",
      "skills/flowhub-author/SKILL.md",
      "skills/flowhub-test-report/SKILL.md",
    ]) {
      assert.deepEqual(
        await readFile(join(bundle, file)),
        await readFile(join(bundle, "source/plugins/flowhub", file)),
        "Plugin differs from recoverable source: " + file,
      );
    }
    assert.deepEqual(
      await readFile(join(bundle, "scripts/flowhub-plugin.mjs")),
      await readFile(join(bundle, "source/scripts/flowhub-plugin.mjs")),
    );
    assert.deepEqual(
      await load(".agents/plugins/marketplace.json"),
      await load("source/plugins/flowhub/marketplace.json"),
    );
  }
  assert.equal(compatibility.skills, "./skills/");
  assert.equal(compatibility.mcpServers, "./.mcp.json");
  assert.deepEqual((await load("mcp.json")).mcpServers, {
    flowhub: pluginServer(platform),
  });
  assert.deepEqual((await load(".mcp.json")).mcpServers, {
    flowhub: pluginServer(platform, true),
  });
  const marketplace = await load(".agents/plugins/marketplace.json");
  assert.equal(marketplace.name, "flowhub-local");
  assert.deepEqual(
    marketplace.plugins.map((plugin) => [plugin.name, plugin.source.path]),
    [["flowhub", "./"]],
  );
  for (const name of [
    "flowhub-setup",
    "flowhub-author",
    "flowhub-test-report",
  ]) {
    const text = await readFile(
      join(bundle, "skills", name, "SKILL.md"),
      "utf8",
    );
    const frontmatterStart = text.split(/\r?\n/, 2);
    assert.deepEqual(frontmatterStart, ["---", "name: " + name]);
  }
}
