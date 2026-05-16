/**
 * Status="Done" row-eligibility derivation (FR-031).
 *
 * ONLY rows whose work-status column equals exactly "Done" after trimming
 * whitespace can enter the dashboard. Folder-source refreshes drop every
 * other row before database write, so this function should normally return
 * true for all stored rows.
 *
 * Pure function. Returns `is_done` as a boolean; the caller writes it as
 * INTEGER 0/1 to SQLite.
 */

const DONE_TOKEN = 'Done';

/**
 * Returns true iff the work-status column value equals "Done"
 * (case-sensitive, whitespace-trimmed).
 *
 * @param rawCell  Sheet cell value, or undefined when the status column
 *                 isn't mapped for this sheet (in which case the row is
 *                 categorically NOT Done — operator hasn't told us how to
 *                 read work status).
 */
export function isDone(rawCell: string | undefined): boolean {
  if (rawCell === undefined) return false;
  return rawCell.trim() === DONE_TOKEN;
}
