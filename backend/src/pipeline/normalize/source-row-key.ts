/**
 * Stable cross-refresh source-row identity (position + content).
 *
 * Per research.md Decision 14, refined twice:
 *
 *   source_row_key = first 16 hex chars of
 *                    sha256(spreadsheet_id + US + tab_name_raw + US +
 *                           row_index + US + cells.join(US))
 *
 *   where US = U+001F (ASCII unit separator — chosen because it doesn't
 *   appear in spreadsheet cell values).
 *
 * Why position AND content together:
 *
 *   • Codex review of branch 15c079b → bx9xhrgzu (Finding #3): the
 *     original position-only key (sha(spreadsheet+tab+row_index)) silently
 *     retargeted bookmarked URLs after row insertion. So I went content-only.
 *
 *   • Codex review of branch 363b776 → bzj921whd (Finding #3): a content-
 *     only key collides on byte-identical duplicate rows (UNIQUE constraint
 *     aborts the entire refresh). Plus there's no defense against legitimate
 *     duplicates (FR-007 says "all rows remain in totals; duplicates are
 *     audit-only").
 *
 * The right answer is BOTH:
 *   • Different content + same row_index → different key. Edited row IS a
 *     different invoice; the bookmarked URL fails closed (404), the user
 *     re-opens drill-down to get the new URL.
 *   • Same content + different row_index → different key. Row movement
 *     also makes the URL fail closed; same UX as edit.
 *   • Byte-identical duplicate rows → different keys (because they have
 *     different row_index values), so the UNIQUE constraint never trips.
 *     Both rows go into the store; duplicate_invoice_id audit category
 *     surfaces the duplication for operator review.
 *
 * Pure function. Deterministic in its four inputs.
 */

import { createHash } from 'node:crypto';

// U+001F — ASCII unit separator. Use String.fromCharCode so the source
// file is portable across editors and the byte cannot be silently stripped
// by tooling that normalizes control characters.
const UNIT_SEP = String.fromCharCode(0x1f);

export function sourceRowKey(
  spreadsheetId: string,
  tabNameRaw: string,
  rowIndex: number,
  cells: readonly string[],
): string {
  if (!spreadsheetId) throw new Error('sourceRowKey: spreadsheetId is required');
  if (!tabNameRaw) throw new Error('sourceRowKey: tabNameRaw is required');
  if (!Number.isInteger(rowIndex) || rowIndex < 1) {
    throw new Error(`sourceRowKey: rowIndex must be a positive integer (got ${rowIndex})`);
  }
  if (!Array.isArray(cells)) {
    throw new Error('sourceRowKey: cells must be an array of strings');
  }
  const input = [spreadsheetId, tabNameRaw, String(rowIndex), cells.join(UNIT_SEP)].join(UNIT_SEP);
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
}
