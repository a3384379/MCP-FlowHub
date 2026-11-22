import {
  mkdir,
  realpath,
  readFile,
  writeFile,
  open,
  unlink,
  chmod,
  lstat,
  mkdtemp,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

function locked(): Error {
  return new Error(
    "DAEMON_ALREADY_RUNNING: data directory is locked by a live or unverifiable owner.",
  );
}

async function readLock(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 1024) throw locked();
  const contents = await readFile(path, "utf8");
  let pid: unknown, createdAt: unknown;
  try {
    ({ pid, createdAt } = JSON.parse(contents));
  } catch {
    throw locked();
  }
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff ||
      typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) throw locked();
  return { info, contents, pid };
}

function readLockIfPresent(path: string) {
  return readLock(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

function lockRecord(): string {
  return JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    id: randomBytes(16).toString("hex"),
  });
}

function requireExited(pid: number): void {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw locked();
  }
  throw locked();
}

async function claimRecovery(path: string, contents: string) {
  const hash = createHash("sha256").update(contents).digest("hex").slice(0, 24);
  const root = path + ".reclaim-" + hash;
  const staging = await mkdtemp(join(dirname(path), ".reclaim-"));
  let claim = root;
  try {
    // Rename publishes the complete owner record. A nonempty directory
    // cannot replace another nonempty claim on Unix or Windows.
    await writeFile(join(staging, "owner.json"), lockRecord(), { mode: 0o600 });
    for (;;) {
      try {
        await rename(staging, claim);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(code ?? "")) throw error;
        const info = await lstat(claim).catch((statError: NodeJS.ErrnoException) => {
          if (statError.code === "ENOENT") throw locked();
          throw statError;
        });
        if (!info.isDirectory()) throw locked();
        const owner = await readLockIfPresent(join(claim, "owner.json"));
        if (!owner) throw locked();
        requireExited(owner.pid);
        // Leave the departed owner's claim in place so observers of this
        // generation all contend for the same next slot.
        claim = join(claim, "next");
      }
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return async (retireGeneration: boolean) => {
    // Hide the claim atomically before deleting its contents. After the old
    // daemon lock is gone, all claims for its generation can be retired.
    try {
      await rename(retireGeneration ? root : claim, staging);
    } catch {
      return;
    }
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  };
}

async function openDaemonLock(path: string) {
  try {
    return await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const observed = await readLockIfPresent(path);
  if (observed) requireExited(observed.pid);
  const release = observed && await claimRecovery(path, observed.contents);
  let retired = false;
  try {
    if (observed) {
      const current = await readLockIfPresent(path);
      if (current) {
        if (current.info.dev !== observed.info.dev || current.info.ino !== observed.info.ino ||
            current.contents !== observed.contents) throw locked();
        requireExited(current.pid);
        await unlink(path);
      }
      retired = true;
    }
    return await open(path, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw locked();
      throw error;
    });
  } finally {
    await release?.(retired);
  }
}

export async function acquireLock(dir: string): Promise<() => Promise<void>> {
  const path = join(dir, "daemon.lock");
  const lock = await openDaemonLock(path);
  try {
    await lock.writeFile(lockRecord());
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
