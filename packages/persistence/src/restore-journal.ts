import { lstatSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const restoreJournalPath = (database: string) =>
  join(dirname(resolve(database)), "restore-pending.json");

/** Presence alone blocks startup, including an incomplete or corrupt journal. */
export function assertRestoreComplete(database: string) {
  try {
    lstatSync(restoreJournalPath(database));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    "RESTORE_INCOMPLETE: A restore was interrupted. Preserve restore-pending.json, replaced databases and backups. With the daemon stopped, rerun flowhub restore using a verified backup; do not delete the restore marker to initialize a new database.",
  );
}

export async function syncFile(path: string) {
  const file = await open(path, "r+");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function syncDirectory(path: string) {
  let directory;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    // Windows does not expose directory fsync through Node. File contents are
    // flushed separately; a surviving marker always keeps startup fail closed.
    if (
      process.platform !== "win32" ||
      !["EISDIR", "EPERM", "EINVAL", "ENOTSUP"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
  } finally {
    await directory?.close();
  }
}

export async function persistRestoreJournal(path: string, value: unknown) {
  const file = await open(path, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(path));
}
