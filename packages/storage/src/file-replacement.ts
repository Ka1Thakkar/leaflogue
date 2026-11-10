import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface FileReplacement<Result> {
  readonly targetPath: string;
  readonly stagedPath: string;
  readonly recoveryPath: string;
  readonly journalPath: string;
  readonly activate: () => Result;
}

/**
 * Installs a staged file without sacrificing the last known-good target.
 * The recovery copy is deleted only after the replacement has been activated.
 */
export function replaceFileWithRollback<Result>(options: FileReplacement<Result>): Result {
  const hadOriginal = existsSync(options.targetPath);
  let originalMoved = false;
  let replacementInstalled = false;

  writeFileSync(options.journalPath, `${JSON.stringify({ version: 1, hadOriginal })}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
  syncDirectory(dirname(options.targetPath));
  try {
    if (hadOriginal) {
      renameSync(options.targetPath, options.recoveryPath);
      originalMoved = true;
    }
    renameSync(options.stagedPath, options.targetPath);
    replacementInstalled = true;

    const result = options.activate();
    rmSync(options.journalPath);
    syncDirectory(dirname(options.targetPath));
    if (originalMoved) {
      try {
        rmSync(options.recoveryPath);
        originalMoved = false;
      } catch {
        // The replacement is active. Retaining a private recovery copy is safer
        // than turning a cleanup failure into a destructive rollback.
      }
    }
    return result;
  } catch (cause) {
    const recoveryErrors: unknown[] = [];
    if (replacementInstalled) {
      try {
        rmSync(options.targetPath, { force: true });
        replacementInstalled = false;
      } catch (error) {
        recoveryErrors.push(error);
      }
    }
    if (originalMoved) {
      try {
        renameSync(options.recoveryPath, options.targetPath);
        originalMoved = false;
      } catch (error) {
        recoveryErrors.push(error);
      }
    }
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [cause, ...recoveryErrors],
        `Leaflogue could not restore the previous file. Keep the recovery copy at ${options.recoveryPath}`,
        { cause },
      );
    }
    rmSync(options.journalPath, { force: true });
    syncDirectory(dirname(options.targetPath));
    throw cause;
  }
}

export function recoverInterruptedFileReplacement(options: Omit<FileReplacement<unknown>, "activate">): void {
  if (!existsSync(options.journalPath)) {
    rmSync(options.stagedPath, { force: true });
    if (existsSync(options.targetPath)) rmSync(options.recoveryPath, { force: true });
    return;
  }
  let journal: unknown;
  try {
    journal = JSON.parse(readFileSync(options.journalPath, "utf8"));
  } catch {
    throw new Error(`Leaflogue restore recovery journal is invalid: ${options.journalPath}`);
  }
  if (typeof journal !== "object" || journal === null || Array.isArray(journal) ||
      (journal as { version?: unknown }).version !== 1 ||
      typeof (journal as { hadOriginal?: unknown }).hadOriginal !== "boolean") {
    throw new Error(`Leaflogue restore recovery journal is invalid: ${options.journalPath}`);
  }

  const hadOriginal = (journal as { hadOriginal: boolean }).hadOriginal;
  if (hadOriginal) {
    if (existsSync(options.recoveryPath)) {
      rmSync(options.targetPath, { force: true });
      renameSync(options.recoveryPath, options.targetPath);
    } else if (!existsSync(options.targetPath)) {
      throw new Error(`Leaflogue restore recovery copy is missing: ${options.recoveryPath}`);
    }
  } else {
    rmSync(options.targetPath, { force: true });
  }
  rmSync(options.stagedPath, { force: true });
  rmSync(options.journalPath);
  syncDirectory(dirname(options.targetPath));
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is unavailable on some supported filesystems/platforms.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
