/**
 * Refresh-lock helper backed by proper-lockfile.
 *
 * Per FR-036 / research.md Decision 13, only one consolidate.ts run may be
 * in progress at a time. The HTTP layer acquires the lock at refresh-start;
 * a second concurrent /api/refresh request returns 409 with the in-progress
 * refresh_id rather than queueing or racing on the .new file.
 */

import lockfile from 'proper-lockfile';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_LOCK_FILENAME = '.refresh.lock';

export class RefreshInProgressError extends Error {
  override readonly name = 'RefreshInProgressError';
}

export interface RefreshLockHandle {
  release(): Promise<void>;
}

/**
 * Acquire the refresh lock for the directory containing `dataPath`.
 * Throws RefreshInProgressError when the lock is already held.
 *
 * The lock file is created if missing — proper-lockfile insists on the
 * target file existing, so we touch it before locking.
 */
export async function acquireRefreshLock(dataDir: string): Promise<RefreshLockHandle> {
  const dir = resolve(dataDir);
  const lockTarget = resolve(dir, DEFAULT_LOCK_FILENAME);

  // Touch the lock target with O_CREAT|O_EXCL semantics so two racing
  // requests cannot both pass an existsSync check then both try to create.
  // openSync(path, 'a') is "append-or-create" and returns a valid fd in
  // either case; that's atomic at the syscall level. We immediately close —
  // proper-lockfile owns the actual locking semantics.
  // (QA review H12: previous existsSync→writeFileSync pattern had a TOCTOU
  // window on the create side.)
  try {
    closeSync(openSync(lockTarget, 'a'));
  } catch (err) {
    throw new Error(
      `failed to ensure lock target ${lockTarget}: ${(err as Error).message}`,
    );
  }

  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(lockTarget, {
      retries: 0,
      // Stale lock recovery — if a previous refresh died without releasing.
      stale: 5 * 60 * 1000,
      realpath: false,
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes('Lock file is already being held') || err.message.includes('ELOCKED'))
    ) {
      throw new RefreshInProgressError(`refresh already in progress at ${lockTarget}`);
    }
    throw err;
  }

  return { release };
}

/**
 * Run `fn` while holding the refresh lock. Releases the lock even if `fn`
 * throws.
 */
export async function withRefreshLock<T>(
  dataDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const handle = await acquireRefreshLock(dataDir);
  try {
    return await fn();
  } finally {
    try {
      await handle.release();
    } catch {
      // Best-effort: a release failure shouldn't mask the underlying error.
    }
  }
}

/**
 * Resolve the lock-file path for tests / introspection.
 */
export function refreshLockPath(dataDir: string): string {
  return resolve(dataDir, DEFAULT_LOCK_FILENAME);
}

/**
 * Ensure the data directory exists for callers that don't want to manage it.
 * Returns the resolved path so calls can be chained.
 */
export function ensureDataDir(dataDir: string): string {
  const dir = resolve(dataDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}
