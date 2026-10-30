import Database from "better-sqlite3";
import {
  mkdir,
  rename,
  unlink,
  stat,
  chmod,
  lstat,
  copyFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  prepareDataDir,
  acquireLock,
} from "../../../apps/daemon/src/local-config.js";
import { ensure, HubError } from "../../contracts/src/domain.js";
import { validateMigrations } from "./repository.js";
import {
  restoreJournalPath,
  persistRestoreJournal,
  syncFile,
  syncDirectory,
} from "./restore-journal.js";

/** Validate without migrating or writing business state. Callers control paths. */
function validateBackup(input: Database.Database) {
  ensure(
    input.pragma("integrity_check", { simple: true }) === "ok",
    "BACKUP_INVALID",
    "Backup integrity check failed.",
  );
  const requiredTables = [
    "settings",
    "workflows",
    "schema_migrations",
    "runs",
    "poc_meta",
  ];
  const existingTables = new Set(
    (
      input
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[]
    ).map((row) => row.name),
  );
  ensure(
    requiredTables.every((table) => existingTables.has(table)),
    "BACKUP_INVALID",
    "This is not a FlowHub backup.",
  );
  input.prepare("SELECT key, value FROM poc_meta LIMIT 0").all();
  try {
    validateMigrations(input);
  } catch {
    throw new HubError(
      "BACKUP_INCOMPATIBLE",
      "Backup schema or migration history is incompatible with this program.",
    );
  }
}

/** Read-only inspection; the management API passes an isolated temporary copy. */
export function inspectBackup(source: string) {
  let input: Database.Database | undefined;
  try {
    input = new Database(resolve(source), {
      readonly: true,
      fileMustExist: true,
    });
    validateBackup(input);
    return { compatible: true as const, integrity: "ok" as const };
  } catch (error) {
    return {
      compatible: false as const,
      errorCode: error instanceof HubError ? error.code : "BACKUP_INVALID",
      message:
        error instanceof HubError
          ? error.message
          : "Backup could not be read as a valid FlowHub database.",
    };
  } finally {
    input?.close();
  }
}

export async function restoreBackup(dataDir: string, source: string) {
  const dir = await prepareDataDir(dataDir),
    release = await acquireLock(dir),
    target = join(dir, "flowhub.sqlite"),
    journal = restoreJournalPath(target),
    operation = randomUUID();
  let input: Database.Database | undefined;
  let staged: string | undefined;
  let journalWritten = false;
  try {
    ensure(
      resolve(source) !== resolve(target),
      "RESTORE_INVALID",
      "Backup must differ from active database.",
    );
    input = new Database(resolve(source), {
      readonly: true,
      fileMustExist: true,
    });
    validateBackup(input);
    staged = join(dir, "restore-" + operation + ".sqlite");
    await input.backup(staged);
    await chmod(staged, 0o600);
    input.close();
    input = undefined;
    // Validate the exact staged snapshot before touching the current database.
    const snapshot = new Database(staged, {
      fileMustExist: true,
    });
    try {
      // Make the snapshot self-contained before its file is renamed.
      snapshot.pragma("wal_checkpoint(TRUNCATE)");
      snapshot.pragma("journal_mode = DELETE");
      ensure(
        snapshot.pragma("integrity_check", { simple: true }) === "ok",
        "BACKUP_INVALID",
        "Staged backup integrity check failed.",
      );
      validateMigrations(snapshot);
    } finally {
      snapshot.close();
    }
    await syncFile(staged);
    let previousBackup: string | null = null;
    let oldPath: string | undefined;
    try {
      await stat(target);
      const current = new Database(target, { readonly: true });
      try {
        const backups = join(dir, "backups");
        await mkdir(backups, { recursive: true, mode: 0o700 });
        previousBackup = join(backups, "pre-restore-" + operation + ".sqlite");
        await current.backup(previousBackup);
        await chmod(previousBackup, 0o600);
        await syncFile(previousBackup);
        await syncDirectory(backups);
        oldPath = join(dir, "replaced-" + operation + ".sqlite");
      } finally {
        current.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    let previousJournal: string | null = null;
    try {
      const existing = await lstat(journal);
      ensure(
        existing.isFile(),
        "RESTORE_INCOMPLETE",
        "The restore marker must be preserved and inspected before retrying.",
      );
      const backups = join(dir, "backups");
      await mkdir(backups, { recursive: true, mode: 0o700 });
      previousJournal = join(
        backups,
        "interrupted-restore-" + operation + ".json",
      );
      await copyFile(journal, previousJournal);
      await chmod(previousJournal, 0o600);
      await syncFile(previousJournal);
      await syncDirectory(backups);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Durable before deleting any old WAL or moving the active database. An
    // explicit retry may replace this marker, but archives the previous one.
    await persistRestoreJournal(journal, {
      version: 1,
      operation,
      target,
      staged,
      oldPath: oldPath ?? null,
      previousBackup,
      previousJournal,
    });
    journalWritten = true;
    for (const suffix of ["-wal", "-shm"])
      try {
        await unlink(target + suffix);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    // Preserve the current database before replacing; Windows rename cannot overwrite.
    if (oldPath) {
      await rename(target, oldPath);
      await syncDirectory(dir);
    }
    try {
      await rename(staged, target);
      staged = undefined;
    } catch (e) {
      if (oldPath) await rename(oldPath, target);
      throw e;
    }
    await syncFile(target);
    await syncDirectory(dir);
    await unlink(journal);
    await syncDirectory(dir);
    return {
      restored: true,
      previousBackup,
      replacedDatabase: oldPath ?? null,
      previousJournal,
      notice:
        "Execution token and program files remain separate. Restart daemon; vault remains locked.",
    };
  } finally {
    input?.close();
    if (staged && !journalWritten) await unlink(staged).catch(() => {});
    await release();
  }
}
