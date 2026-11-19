import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

function ensureWindowsAutostart() {
  if (process.platform !== "win32")
    throw new Error("PLUGIN_AUTOSTART_PLATFORM: this command uses the Windows Task Scheduler.");
}

async function probePlugin(root, dataDir, tokenFile) {
  const load = path => import(pathToFileURL(join(root, path)));
  const [{ locateCodex }, { readLocalOrigin }, { inspectMcpConnection }, { windowsAutostart }] = await Promise.all([
    load("dist/packages/host-discovery/src/index.js"), load("dist/apps/daemon/src/local-config.js"),
    load("dist/apps/daemon/src/cli.js"), load("scripts/windows-autostart.mjs"),
  ]);
  const [plugin, daemon, autostart, mcp] = await Promise.all([
    (async () => {
      const codexPath = await locateCodex();
      if (!codexPath) return { state: "codex_not_found" };
      try {
        const { stdout } = await exec(codexPath, ["-c", "features.remote_plugin=false", "plugin", "list"],
          { timeout: 8000, windowsHide: true });
        return { state: stdout.includes("flowhub@flowhub-local") ? "registered" : "not_listed", codexPath };
      } catch (error) {
        return { state: "unverified", codexPath, error: error.code };
      }
    })(),
    (async () => {
      try {
        const origin = await readLocalOrigin(dataDir);
        const response = await fetch(new URL("api/v1/health", origin), {
          redirect: "error", signal: AbortSignal.timeout(3000),
        });
        if (!response.ok || (await response.json()).status !== "ok") return { state: "unhealthy" };
        return { state: "healthy", origin: origin.href };
      } catch {
        return { state: "unavailable" };
      }
    })(),
    windowsAutostart("status", { programDir: root, dataDir })
      .catch(error => ({ state: "unverified", error: error.message })),
    inspectMcpConnection(dataDir, tokenFile)
      .then(info => ({ state: "connected", identity: tokenFile ? "restricted" : "personal", ...info }))
      .catch(error => ({ state: "unverified", code: String(error.code ?? "MCP_UNAVAILABLE") })),
  ]);
  return { plugin, daemon, autostart, mcp };
}

async function openDashboard(url) {
  const command = {
    darwin: ["/usr/bin/open", [url]],
    linux: ["xdg-open", [url]],
    win32: ["rundll32.exe", ["url.dll,FileProtocolHandler", url]],
  }[process.platform];
  try {
    await exec(command[0], command[1], { timeout: 5000, windowsHide: true });
  } catch {
    throw new Error(
      "PLUGIN_BROWSER_OPEN_FAILED: open the printed URL in a browser.",
    );
  }
}

export function connectionFile(env = process.env) {
  return join(
    resolve(env.CODEX_HOME || join(homedir(), ".codex")),
    "flowhub",
    "connection.json",
  );
}

export function validateConnection(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1 ||
    typeof value.dataDir !== "string" ||
    !isAbsolute(value.dataDir) ||
    (value.tokenFile !== undefined &&
      (typeof value.tokenFile !== "string" || !isAbsolute(value.tokenFile))) ||
    Object.keys(value).some(
      (key) => !["version", "dataDir", "tokenFile"].includes(key),
    )
  ) {
    throw new Error(
      "PLUGIN_CONFIG_INVALID: configure an absolute data directory and optional token-file reference.",
    );
  }
  return value;
}

export async function readConnection(file, fallbackDataDir) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT")
      return validateConnection({ version: 1, dataDir: fallbackDataDir });
    throw error;
  }
  if (!info.isFile() || info.nlink !== 1 || info.size > 65536) {
    throw new Error(
      "PLUGIN_CONFIG_INVALID: connection settings must be a regular local JSON file.",
    );
  }
  try {
    return validateConnection(JSON.parse(await readFile(file, "utf8")));
  } catch {
    throw new Error(
      "PLUGIN_CONFIG_INVALID: repair the connection settings before connecting.",
    );
  }
}

export async function configure(file, previous, values) {
  if (!values["data-dir"] && !values["token-file"] && !values.personal) {
    throw new Error(
      "PLUGIN_INPUT_INVALID: specify --data-dir, --token-file, or --personal.",
    );
  }
  if (values.personal && values["token-file"]) {
    throw new Error(
      "PLUGIN_INPUT_INVALID: choose a personal identity or a token-file identity.",
    );
  }
  const dataDir = values["data-dir"]
    ? resolve(values["data-dir"])
    : previous.dataDir;
  if (
    dataDir !== previous.dataDir &&
    previous.tokenFile &&
    !values["token-file"] &&
    !values.personal
  ) {
    throw new Error(
      "PLUGIN_IDENTITY_REQUIRED: select the token file for the new data directory, or explicitly use --personal.",
    );
  }
  const next = validateConnection({
    version: 1,
    dataDir,
    ...(!values.personal && (values["token-file"] || previous.tokenFile)
      ? {
          tokenFile: values["token-file"]
            ? resolve(values["token-file"])
            : previous.tokenFile,
        }
      : {}),
  });
  if (next.tokenFile && !(await lstat(next.tokenFile)).isFile()) {
    throw new Error(
      "PLUGIN_TOKEN_FILE_INVALID: choose the local token file generated by FlowHub.",
    );
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(file), `.connection-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(next, null, 2) + "\n");
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return next;
}

export async function main(args = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      "token-file": { type: "string" },
      personal: { type: "boolean" },
      port: { type: "string" },
      help: { type: "boolean" },
    },
  });
  const command = positionals[0];
  const taskAction = command === "autostart" ? positionals[1] : undefined;
  if (values.help || !command) {
    console.log(
      "FlowHub Codex 插件\n  flowhub-plugin start [--port 18473]\n  flowhub-plugin doctor\n  flowhub-plugin status\n  flowhub-plugin autostart enable|disable|status [--data-dir PATH] [--port 18473]\n  flowhub-plugin open\n  flowhub-plugin url\n  flowhub-plugin configure --data-dir PATH [--token-file PATH | --personal]\n  flowhub-plugin mcp\n\n可在独立终端 start，再由 Codex 连接。Windows 登录自启由当前用户显式启用。安装方法见 docs/PLUGIN_PACKAGE.md。",
    );
    return;
  }
  if (
    positionals.length !== (command === "autostart" ? 2 : 1) ||
    !["start", "doctor", "status", "autostart", "configure", "mcp", "open", "url"].includes(command) ||
    (command === "autostart" && !["enable", "disable", "status"].includes(taskAction)) ||
    (command !== "configure" &&
      (values["token-file"] || values.personal || command !== "autostart" && values["data-dir"])) ||
    (command !== "start" && taskAction !== "enable" && values.port)
  ) {
    throw new Error("PLUGIN_INPUT_INVALID: use a documented plugin command.");
  }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const build = JSON.parse(
    await readFile(join(root, "build-info.json"), "utf8"),
  );
  if (
    build.os !== process.platform ||
    build.arch !== process.arch ||
    build.node !== process.versions.node
  ) {
    throw new Error(
      "PLUGIN_PLATFORM_MISMATCH: use the offline plugin built for this operating system, architecture and Node runtime.",
    );
  }
  const { defaultDataDir, readLocalOrigin } = await import(
    pathToFileURL(join(root, "dist/apps/daemon/src/local-config.js"))
  );
  const file = connectionFile(),
    connection = await readConnection(file, defaultDataDir());
  if (command === "status") {
    console.log(JSON.stringify(await probePlugin(root, connection.dataDir, connection.tokenFile), null, 2));
    return;
  }
  if (command === "autostart") {
    ensureWindowsAutostart();
    const { windowsAutostart } = await import("./windows-autostart.mjs");
    console.log(JSON.stringify(await windowsAutostart(taskAction, {
      programDir: root, dataDir: values["data-dir"] ?? connection.dataDir, port: values.port,
    }), null, 2));
    return;
  }
  if (command === "url" || command === "open") {
    const origin = await readLocalOrigin(connection.dataDir);
    try {
      const response = await fetch(new URL("api/v1/health", origin), {
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
      const health = await response.json();
      if (
        !response.ok ||
        health?.status !== "ok" ||
        !["ALPHA", "RC"].includes(health.phase)
      )
        throw new Error();
    } catch {
      throw new Error(
        "DAEMON_UNAVAILABLE: start the configured FlowHub instance first.",
      );
    }
    console.log(origin.href);
    if (command === "open") await openDashboard(origin.href);
    return;
  }
  if (command === "configure") {
    console.log(
      JSON.stringify(
        {
          connectionFile: file,
          connection: await configure(file, connection, values),
        },
        null,
        2,
      ),
    );
    return;
  }
  const { main: flowhub } = await import(
    pathToFileURL(join(root, "dist/apps/daemon/src/cli.js"))
  );
  const forwarded = [
    command === "start" ? "serve" : command,
    "--data-dir",
    connection.dataDir,
  ];
  if (command === "mcp") forwarded.push("--stdio", "--codex-sidebar");
  if (command === "start" && values.port) forwarded.push("--port", values.port);
  if (command !== "start" && connection.tokenFile)
    forwarded.push("--token-file", connection.tokenFile);
  await flowhub(forwarded);
}

if (
  process.argv[1] &&
  pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url
) {
  main().catch((error) => {
    const message = String(error.message);
    console.error(
      /^(PLUGIN_|DAEMON_|TOKEN_|PORT_|CLI_)/.test(message)
        ? message
        : "PLUGIN_STARTUP_FAILED: check the package, connection settings and local service.",
    );
    process.exitCode = 1;
  });
}
