import { constants, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { ensure, HubError } from "../../contracts/src/domain.js";
import { inspectBackup } from "../../persistence/src/maintenance.js";

export type LocalBackup = {
  filename: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
};

export async function backupDirectory(dataDir: string, create = false) {
  const root = await realpath(resolve(dataDir));
  const directory = join(root, "backups");
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  ensure(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      (await realpath(directory)) === directory,
    "BACKUP_PATH_INVALID",
    "The local backup directory must be a regular directory, not a link.",
  );
  return directory;
}

async function backupFile(dataDir: string, filename: unknown) {
  ensure(
    typeof filename === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*\.sqlite$/.test(filename) &&
      !filename.includes("..") &&
      basename(filename) === filename,
    "BACKUP_PATH_INVALID",
    "Select a SQLite filename from the local backup list.",
  );
  let directory: string;
  try {
    directory = await backupDirectory(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new HubError("NOT_FOUND", "No local backup directory exists.", 404);
    throw error;
  }
  const path = join(directory, filename);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new HubError(
        "NOT_FOUND",
        "The selected local backup no longer exists.",
        404,
      );
    throw error;
  }
  ensure(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.nlink === 1 &&
      dirname(await realpath(path)) === directory,
    "BACKUP_PATH_INVALID",
    "The selected backup must be a regular local file, not a link.",
  );
  return { path, info, directory };
}

export async function localBackups(dataDir: string) {
  let directory: string;
  try {
    directory = await backupDirectory(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { directory: join(await realpath(dataDir), "backups"), files: [] };
    throw error;
  }
  const files: LocalBackup[] = [];
  for (const filename of await readdir(directory)) {
    try {
      const { path, info } = await backupFile(dataDir, filename);
      files.push({
        filename,
        path,
        sizeBytes: info.size,
        modifiedAt: info.mtime.toISOString(),
      });
    } catch (error) {
      if (
        error instanceof HubError ||
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        continue;
      throw error;
    }
  }
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return { directory, files };
}

/** Read only the selected original; SQLite inspects a private disposable copy. */
export async function preflightLocalBackup(dataDir: string, filename: unknown) {
  const { path, info } = await backupFile(dataDir, filename);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      await lstat(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new HubError(
      "BACKUP_NOT_STANDALONE",
      "Backup has SQLite sidecar files; create a new consistent backup before checking it.",
    );
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let temporary: string | undefined;
  let inspectionFailed = false;
  try {
    const opened = await handle.stat();
    ensure(
      opened.isFile() &&
        opened.nlink === 1 &&
        opened.ino === info.ino &&
        opened.dev === info.dev &&
        opened.size === info.size &&
        opened.mtimeMs === info.mtimeMs,
      "BACKUP_CHANGED",
      "Backup changed while being opened. Refresh the local backup list.",
    );
    temporary = await mkdtemp(join(tmpdir(), "flowhub-backup-preflight-"));
    const snapshot = join(temporary, "snapshot.sqlite");
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      createWriteStream(snapshot, { flags: "wx", mode: 0o600 }),
    );
    const copied = await handle.stat();
    ensure(
      copied.size === opened.size && copied.mtimeMs === opened.mtimeMs,
      "BACKUP_CHANGED",
      "Backup changed during inspection. Create a new consistent backup.",
    );
    return {
      filename: basename(path),
      path,
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      ...inspectBackup(snapshot),
    };
  } catch (error) {
    inspectionFailed = true;
    throw error;
  } finally {
    // Closing the original handle and removing the private copy are independent:
    // always attempt both, including when SQLite validation or close failed.
    const cleanup = await Promise.allSettled([
      handle.close(),
      ...(temporary ? [rm(temporary, { recursive: true, force: true })] : []),
    ]);
    const failed = cleanup.find((result) => result.status === "rejected");
    // Preserve the original inspection error/code. A successful inspection must
    // still fail the request if its sensitive temporary copy could not be removed.
    if (!inspectionFailed && failed?.status === "rejected") throw failed.reason;
  }
}
