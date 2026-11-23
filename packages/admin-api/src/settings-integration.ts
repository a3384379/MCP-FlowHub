import { fileURLToPath } from "node:url";
import { isAbsolute, win32 } from "node:path";

export type LocalCommand = { command: string; args: string[] };

export const localCliPath = fileURLToPath(
  new URL("../../../apps/daemon/src/cli.js", import.meta.url),
);

// JSON string escapes are also valid TOML basic-string escapes. TOML additionally
// forbids a literal DEL character, which JSON.stringify leaves unchanged.
export function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\u007f/g, "\\u007F");
}

export function hostIntegration(paths: {
  runtimePath: string;
  cliPath: string;
  dataDir: string;
  tokenFile: string;
}) {
  for (const path of Object.values(paths)) {
    if (!(isAbsolute(path) || win32.isAbsolute(path)))
      throw new Error("Host integration requires absolute local paths.");
  }
  const command: LocalCommand = {
    command: paths.runtimePath,
    args: [
      paths.cliPath,
      "mcp",
      "--stdio",
      "--data-dir",
      paths.dataDir,
      "--token-file",
      paths.tokenFile,
    ],
  };
  return {
    ...command,
    tokenFile: paths.tokenFile,
    codexToml: [
      "[mcp_servers.flowhub]",
      "command = " + tomlString(command.command),
      "args = [" + command.args.map(tomlString).join(", ") + "]",
      "",
    ].join("\n"),
    claudeJson: JSON.stringify({ mcpServers: { flowhub: command } }, null, 2),
  };
}

function shellArgument(value: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? "'" + value.replace(/'/g, "''") + "'"
    : "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

export function offlineRestoreInstructions(paths: {
  runtimePath: string;
  cliPath: string;
  dataDir: string;
  backupPath: string;
  platform?: NodeJS.Platform;
}) {
  const platform = paths.platform ?? process.platform;
  const command = (args: string[]) =>
    (platform === "win32" ? "& " : "") +
    [paths.runtimePath, paths.cliPath, ...args]
      .map((value) => shellArgument(value, platform))
      .join(" ");
  return {
    shell: platform === "win32" ? "PowerShell" : "POSIX shell",
    daemonPid: process.pid,
    restoreCommand: command([
      "restore",
      "--data-dir",
      paths.dataDir,
      "--backup",
      paths.backupPath,
    ]),
    steps: [
      "先保存此说明和命令；停止所有宿主薄桥，避免继续发起请求。",
      "在启动当前 daemon 的终端按 Ctrl+C，等待进程退出和管理页面断开；若通过服务启动，先停止对应服务。",
      "确认当前 daemon 进程已退出，且数据目录的 daemon.lock 已由正常关闭移除。锁仍存在时先核实记录的 PID，勿在运行中删除锁。",
      "在本机终端执行恢复命令。CLI 会再次验证备份、取得独占锁并保存被替换数据库的备份；不要复制覆盖在线数据库或其 WAL 文件。",
      "使用原启动方式与同一个 --data-dir 重启 daemon，再启动宿主薄桥。凭据会自动读取。若从需要口令的旧版备份恢复并看到迁移提示，使用备份时的原口令。程序与 execution token 文件不包含在数据库备份中。",
    ],
    notice:
      "这里只读检查备份，不执行恢复。检查通过不保证未来恢复成功；离线 CLI 会重新检查文件与迁移兼容性。",
  };
}
