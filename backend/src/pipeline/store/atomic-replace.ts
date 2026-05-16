/**
 * Atomic-replace semantics for the consolidated store.
 *
 * Per FR-036 the dashboard MUST NOT serve stale data while a refresh is in
 * progress. Strategy:
 *   1. Pipeline writes everything to `<live>.new` (the staging file).
 *   2. We fsync the staging file to make sure bytes hit disk.
 *   3. We unlink any stale `<live>-wal`, `<live>-shm`, `<live>-journal`
 *      sidecars from a prior incarnation so they cannot be misapplied to the
 *      freshly-renamed inode.
 *   4. We rename `<live>.new` over `<live>`. POSIX rename(2) is atomic on
 *      the same filesystem — the API's read-only handle either sees the old
 *      file or the new file, never a half-written one.
 *   5. We fsync the containing directory so the rename itself is durable.
 *      Without this step, ext4/xfs/apfs can still lose the directory entry
 *      on power loss even though the staging-file bytes are durable.
 *
 * Cross-device renames (e.g., staging on tmpfs, live on a different mount)
 * fail loudly so the operator knows to fix the layout rather than silently
 * fall back to a non-atomic copy.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

export class AtomicReplaceError extends Error {
  override readonly name = 'AtomicReplaceError';
  constructor(
    message: string,
    public readonly stagingPath: string,
    public readonly livePath: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

/**
 * Fsync the staging file, then atomically rename it over the live file.
 * Both paths MUST resolve onto the same filesystem.
 */
export function commitStaging(stagingPath: string, livePath: string): void {
  const staging = resolve(stagingPath);
  const live = resolve(livePath);

  if (dirname(staging) !== dirname(live)) {
    throw new AtomicReplaceError(
      `staging and live paths must be in the same directory for atomic rename ` +
        `(staging dir=${dirname(staging)}, live dir=${dirname(live)})`,
      staging,
      live,
    );
  }

  // fsync the staging file so bytes are durable before the rename swaps it in.
  let fd: number | null = null;
  try {
    fd = openSync(staging, 'r+');
    fsyncSync(fd);
  } catch (err) {
    throw new AtomicReplaceError(
      `failed to fsync staging file: ${(err as Error).message}`,
      staging,
      live,
      err,
    );
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors after fsync
      }
    }
  }

  // Remove any pre-existing journal sidecars next to the live file.
  // Even though staging now uses journal_mode=DELETE (no sidecars), a prior
  // incarnation that opened in WAL mode may have left `<live>-wal`/`-shm`
  // behind; SQLite will misapply them to the freshly-renamed inode unless we
  // clean them up first. Best-effort: missing files are not an error.
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${live}${suffix}`;
    if (existsSync(sidecar)) {
      try {
        unlinkSync(sidecar);
      } catch {
        // ignore — at worst SQLite recovers from the sidecar harmlessly
      }
    }
  }

  try {
    renameSync(staging, live);
  } catch (err) {
    throw new AtomicReplaceError(
      `failed to rename staging over live: ${(err as Error).message}`,
      staging,
      live,
      err,
    );
  }

  // Fsync the parent directory so the rename(2) directory entry is durable.
  // POSIX requires this; otherwise a power loss between rename and the next
  // operation can revert to the prior live snapshot (or leave neither).
  let dirFd: number | null = null;
  try {
    dirFd = openSync(dirname(live), 'r');
    fsyncSync(dirFd);
  } catch (err) {
    throw new AtomicReplaceError(
      `failed to fsync parent directory after rename: ${(err as Error).message}`,
      staging,
      live,
      err,
    );
  } finally {
    if (dirFd !== null) {
      try {
        closeSync(dirFd);
      } catch {
        // ignore close errors after fsync
      }
    }
  }
}
