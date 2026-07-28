/**
 * Sheet adapter (T050).
 *
 * Bridges raw `RawRow[]` (from `GwsWrapper.pullSheet`) and the orchestrator's
 * row mapper. Per-sheet column mapping resolves which column letters carry
 * which fields; tab-alias resolution canonicalizes the tab name while
 * preserving the original spelling for provenance (FR-006).
 *
 * Output: an array of `AdapterRow`, one per source row, each carrying the
 * raw cells the normalize stage needs PLUS the sheet-level metadata
 * (spreadsheet_id, order_code, tab_name canonicalized + tab_name_raw,
 * row_index).
 *
 * Pure function. No I/O. The caller decides what to do with the produced
 * rows (typically: pass each to normalize/index.ts).
 */

import { canonicalizeTabName } from '../../config/load.js';
import type { ColumnMapping, SheetEntry, SheetsConfig } from '../../shared/contracts.js';
import { sourceRowKey } from '../normalize/source-row-key.js';
import type { RawRow } from './gws.js';

export interface AdapterRow {
  // Sheet-level metadata.
  spreadsheet_id: string;
  order_code: string;
  tab_name: string;       // canonical
  tab_name_raw: string;   // as found in the sheet (for provenance + source_row_key)
  row_index: number;
  /**
   * Stable cross-refresh content-based identity. Computed from
   * (spreadsheet_id, tab_name_raw, raw_cells). Survives row movement,
   * fails closed on cell edits. See normalize/source-row-key.ts.
   */
  source_row_key: string;
  // Cell values (may be undefined when the column isn't mapped for this sheet).
  status: string | undefined;
  website: string | undefined;
  price: string | undefined;
  currency: string | undefined;
  invoice_date: string | undefined;
  /** Dashboard bucket supplied by the executive report. Monthly source tabs may intentionally differ from invoice_date. */
  reporting_month?: string | undefined;
  invoice_url: string | undefined;
  invoice_status: string | undefined;
  /** Raw EUR savings. Legacy sheets have no savings column and use zero. */
  savings_eur: number;
  /** Distinguishes legacy tab adapters from the executive report reader. */
  source_mode: 'report' | 'legacy';
  /** Optional executive-report issue text, retained for later audit mapping. */
  data_quality_issue?: string | undefined;
  // Pass-through provenance fields (optional).
  link_builder: string | undefined;
  target_url: string | undefined;
  anchor: string | undefined;
  live_url: string | undefined;
}

export interface AdaptOptions {
  /** Defaults to the row's index in the input array; pass a callback to override (e.g., for fixtures with custom indexing). */
  rowIndexOf?: (raw: RawRow, idx: number) => number;
}

/**
 * Convert raw rows from one tab into AdapterRows.
 *
 * @param sheet         The SheetEntry from config (carries column_mapping + order_code).
 * @param tabRaw        The tab name as found in the sheet (BEFORE canonicalization).
 * @param tabAliases    Map from sheets config; passed through canonicalizeTabName.
 * @param rows          RawRow[] from GwsWrapper.pullSheet.
 *
 * Empty rows (no non-empty cells) are skipped — they're typically trailing
 * blank rows below the data and don't represent invoices.
 */
export function adaptSheet(
  sheet: SheetEntry,
  tabRaw: string,
  tabAliases: SheetsConfig['tab_aliases'],
  rows: RawRow[],
  options: AdaptOptions = {},
): AdapterRow[] {
  const tabCanonical = canonicalizeTabName(tabRaw, tabAliases);
  const m = sheet.column_mapping;

  return rows
    .map((raw, idx) => {
      const row_index = options.rowIndexOf?.(raw, idx) ?? raw.row_index;
      const cell = (col: string | null | undefined): string | undefined => {
        if (col == null) return undefined;
        return cellAt(raw.cells, col);
      };

      return {
        spreadsheet_id: sheet.spreadsheet_id,
        order_code: sheet.order_code,
        tab_name: tabCanonical,
        tab_name_raw: tabRaw,
        row_index,
        source_row_key: sourceRowKey(sheet.spreadsheet_id, tabRaw, row_index, raw.cells),
        status: cell(m.status),
        website: cell(m.website ?? null),
        price: cell(m.price),
        currency: cell(m.currency ?? null),
        invoice_date: cell(m.invoice_date ?? null),
        reporting_month: undefined,
        invoice_url: cell(m.invoice_url ?? null),
        invoice_status: cell(m.invoice_status ?? null),
        savings_eur: 0,
        source_mode: 'legacy',
        link_builder: cell(m.link_builder ?? null),
        target_url: cell(m.target_url ?? null),
        anchor: cell(m.anchor ?? null),
        live_url: cell(m.live_url ?? null),
      } satisfies AdapterRow;
    })
    .filter(isMeaningfulRow);
}

/**
 * Resolve a column reference (letter "A".."ZZ" or header label) to a cell
 * value within a row.
 *
 * v1 supports ONLY column-letter references (the dominant case). If a
 * mapping value is not a valid column letter, returns undefined — the
 * normalize stage will treat it as missing.
 */
function cellAt(cells: string[], colRef: string): string | undefined {
  if (!isColumnLetter(colRef)) return undefined;
  const idx = columnLetterToIndex(colRef);
  const v = cells[idx];
  if (v === undefined) return undefined;
  // Empty strings are kept as empty (not coerced to undefined) so the
  // normalize stage can distinguish "blank cell in a mapped column" from
  // "no column mapped".
  return v;
}

const COLUMN_LETTER_RE = /^[A-Z]{1,2}$/;

function isColumnLetter(s: string): boolean {
  return COLUMN_LETTER_RE.test(s);
}

/** "A" → 0, "B" → 1, ..., "Z" → 25, "AA" → 26, "ZZ" → 701. */
export function columnLetterToIndex(letter: string): number {
  const upper = letter.toUpperCase();
  let n = 0;
  for (let i = 0; i < upper.length; i += 1) {
    n = n * 26 + (upper.charCodeAt(i) - 64);
  }
  return n - 1;
}

/**
 * Skip rows that have no non-empty cells in any mapped position. The most
 * common case is trailing blank rows below the data block.
 *
 * "Mapped position" here is approximated by checking the four fields most
 * likely to be present: status, website, price, invoice_url. A row with
 * none of those is empty for our purposes.
 */
function isMeaningfulRow(row: AdapterRow): boolean {
  const candidates = [row.status, row.website, row.price, row.invoice_url];
  return candidates.some((v) => v !== undefined && v.trim() !== '');
}
