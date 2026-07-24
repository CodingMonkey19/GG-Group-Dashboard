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
import { API_SCHEMA_VERSION, REPORTING_YEAR } from '../../shared/contracts.js';

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

export interface SnapshotMetadata {
  schema_version: typeof API_SCHEMA_VERSION;
  reporting_year: typeof REPORTING_YEAR;
  source_spreadsheet_id: string;
  source_tab: string;
}

/**
 * Read and validate the v2 snapshot marker. A missing table, old
 * `user_version`, duplicate/absent singleton row, or malformed metadata is
 * incompatible rather than a candidate for best-effort migration.
 */
export function readSnapshotMetadata(db: DatabaseT): SnapshotMetadata | null {
  try {
    const userVersion = Number(db.pragma('user_version', { simple: true }));
    if (userVersion !== API_SCHEMA_VERSION) return null;

    const rows = db.prepare(
      `SELECT schema_version, reporting_year, source_spreadsheet_id, source_tab
         FROM snapshot_metadata
        ORDER BY singleton_id
        LIMIT 2`,
    ).all() as Array<{
      schema_version: unknown;
      reporting_year: unknown;
      source_spreadsheet_id: unknown;
      source_tab: unknown;
    }>;
    if (rows.length !== 1) return null;

    const row = rows[0]!;
    if (
      row.schema_version !== API_SCHEMA_VERSION ||
      row.reporting_year !== REPORTING_YEAR ||
      typeof row.source_spreadsheet_id !== 'string' ||
      row.source_spreadsheet_id.trim() === '' ||
      typeof row.source_tab !== 'string' ||
      row.source_tab.trim() === ''
    ) {
      return null;
    }

    return {
      schema_version: API_SCHEMA_VERSION,
      reporting_year: REPORTING_YEAR,
      source_spreadsheet_id: row.source_spreadsheet_id,
      source_tab: row.source_tab,
    };
  } catch {
    return null;
  }
}

/** Return true only when every persisted invoice is a finite, matching 2026 row. */
export function snapshotInvoicesAreCompatible(db: DatabaseT): boolean {
  try {
    const rows = db.prepare(
      'SELECT savings_eur, invoice_date, invoice_month FROM invoices',
    ).all() as Array<{
      savings_eur: unknown;
      invoice_date: unknown;
      invoice_month: unknown;
    }>;
    return rows.every((row) =>
      typeof row.savings_eur === 'number' &&
      Number.isFinite(row.savings_eur) &&
      isReportingYearDate(row.invoice_date) &&
      typeof row.invoice_month === 'string' &&
      row.invoice_month === row.invoice_date.slice(0, 7),
    );
  } catch {
    return false;
  }
}

function isReportingYearDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^2026-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
