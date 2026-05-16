/**
 * SQLite store wrapper for the GG Spend Dashboard consolidated store.
 *
 * Two entry points:
 *   - openStore(path)        : read-only handle for the API layer.
 *   - openStagingStore(path) : writable handle that applies schema.sql; used
 *                              by the consolidation pipeline to build the
 *                              `consolidated.sqlite.new` staging file.
 *
 * Atomic replacement is handled by `atomic-replace.ts`, not here.
 */

import Database, { type Database as DatabaseT } from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, 'schema.sql');

/**
 * Open the live consolidated store read-only. Throws if the file is missing —
 * the API layer turns that into the `never_refreshed` 503 response.
 */
export function openStore(path: string): DatabaseT {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Open (creating if needed) a writable staging database and apply schema.sql.
 * Idempotent — safe to call against an existing file (CREATE IF NOT EXISTS).
 *
 * The pipeline writes to a `.new` path, then atomic-renames over the live
 * file via `atomic-replace.ts`.
 */
export function openStagingStore(path: string): DatabaseT {
  const db = new Database(path);
  // Pragmas must be set before any DDL.
  // DELETE journal (NOT WAL) so the staging file is a single-file DB; otherwise
  // `<live>.new-wal` / `-shm` sidecars get stranded across renameSync, and a
  // stale `<live>-wal` from a prior crashed run can be misapplied to the
  // freshly-renamed inode on the next reader open.
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');

  const ddl = readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(ddl);
  return db;
}

/**
 * Return true iff the consolidated store has at least one row.
 * Used by the API layer to distinguish 'never_refreshed' from a deliberately
 * empty store after a partial refresh that excluded every source.
 */
export function storeHasAnyRow(db: DatabaseT): boolean {
  const row = db.prepare('SELECT COUNT(*) AS c FROM invoices').get() as { c: number };
  return row.c > 0;
}
