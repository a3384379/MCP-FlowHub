import {
  mkdir,
  realpath,
  readFile,
  writeFile,
  open,
  unlink,
  chmod,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

export function defaultDataDir(): string {
  return process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? homedir(), "MCP-FlowHub")
    : join(
        process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
        "mcp-flowhub",
      );
}

export async function prepareDataDir(dir: string): Promise<string> {
  await mkdir(resolve(dir), { recursive: true, mode: 0o700 });
  const root = await realpath(resolve(dir));
  await chmod(root, 0o700);
  return root;
}

export async function acquireLock(dir: string): Promise<() => Promise<void>> {
  const path = join(dir, "daemon.lock");
  let lock;
  try {
    lock = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "DAEMON_ALREADY_RUNNING: data directory is locked. After a crash, verify the recorded PID has exited before removing daemon.lock.",
      );
    }
    throw error;
  }
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
  } catch (error) {
    await lock.close();
    await unlink(path);
    throw error;
  }
  return async () => {
    await lock.close();
    await unlink(path);
  };
}

export async function loadOrCreateToken(dir: string): Promise<string> {
  const path = join(dir, "execution-token");
  try {
    await writeFile(path, randomBytes(32).toString("hex"), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await chmod(path, 0o600);
  const token = (await readFile(path, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error(
      "TOKEN_FILE_INVALID: expected a generated local execution token.",
    );
  return token;
}
export function tokenMatches(
  authorization: string | undefined,
  token: string,
): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(authorization.slice(7)), digest(token));
}

export async function readLocalOrigin(dir: string): Promise<URL> {
  try {
    const endpoint: unknown = JSON.parse(
      await readFile(join(dir, "endpoint.json"), "utf8"),
    );
    if (
      !endpoint ||
      typeof endpoint !== "object" ||
      !("port" in endpoint) ||
      !Number.isInteger(endpoint.port) ||
      Number(endpoint.port) < 1 ||
      Number(endpoint.port) > 65535
    )
      throw new Error("invalid endpoint");
    return new URL(`http://127.0.0.1:${endpoint.port}/`);
  } catch {
    throw new Error(
      "DAEMON_UNAVAILABLE: run flowhub serve first, using the same --data-dir.",
    );
  }
}

export async function readEndpoint(
  dir: string,
  tokenFile?: string,
): Promise<{ url: string; token: string }> {
  const origin = await readLocalOrigin(dir);
  try {
    const token = (
      await readFile(tokenFile ?? join(dir, "execution-token"), "utf8")
    ).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid token");
    return { url: new URL("mcp", origin).href, token };
  } catch {
    throw new Error(
      "DAEMON_UNAVAILABLE: run flowhub serve first, using the same --data-dir.",
    );
  }
}
