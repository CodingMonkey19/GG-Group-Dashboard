/**
 * Date-resolution chain (FR-033 + research.md Decision 11).
 *
 * Chain:
 *   1. Parse the sheet's date cell (locale-tolerant: ISO, DD.MM.YYYY,
 *      DD/MM/YYYY, MM/DD/YYYY, native Sheets serial as a numeric string).
 *   2. If sheet date missing/unparseable AND the row's invoice_type is
 *      `pdf` or `drive_pdf`, use the artifact-derived date the extract/
 *      stage already resolved (T048/T049). PayPal/Intuit are NOT fetched in
 *      v1 (revised Decision 5) — they skip step 2 entirely.
 *   3. If both fail, bucket as `Undated` (invoice_date=null, invoice_month=null,
 *      date_source='undated').
 *
 * Pure function. The artifact-derived date is passed in as `artifactDate`;
 * date-resolution doesn't fetch anything itself.
 *
 * Per Codex review feedback: artifact_status is OWNED by the extract/ stage
 * (T047/T048/T049) and is read-only here.
 */

import type { DateSource, InvoiceType } from '../../shared/contracts.js';

export interface ResolvedDate {
  /** ISO YYYY-MM-DD or null when undated. */
  invoice_date: string | null;
  /** YYYY-MM derived from invoice_date, or null. */
  invoice_month: string | null;
  date_source: DateSource;
}

export interface ResolveDateInput {
  /** Raw value of the sheet's date cell. Pass undefined when no date column is mapped. */
  sheetCell: string | undefined;
  /** Date derived by the extract/ stage from the artifact, or null if not available / not attempted. */
  artifactDate: string | null;
  /** Used to gate the artifact step: only pdf/drive_pdf use the artifact-derived date in v1. */
  invoice_type: InvoiceType;
}

export function resolveDate(input: ResolveDateInput): ResolvedDate {
  // Step 1 — sheet cell.
  const fromSheet = parseDateCell(input.sheetCell);
  if (fromSheet !== null) {
    return {
      invoice_date: fromSheet,
      invoice_month: fromSheet.slice(0, 7),
      date_source: 'sheet',
    };
  }

  // Step 2 — artifact-derived date, gated by invoice_type.
  // v1 only fetches pdf and drive_pdf artifacts (paypal/intuit are URL-string
  // / opener-only). For other types the artifact step is skipped.
  if (input.invoice_type === 'pdf' || input.invoice_type === 'drive_pdf') {
    if (input.artifactDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(input.artifactDate)) {
      return {
        invoice_date: input.artifactDate,
        invoice_month: input.artifactDate.slice(0, 7),
        date_source: 'artifact',
      };
    }
  }

  // Step 3 — undated.
  return { invoice_date: null, invoice_month: null, date_source: 'undated' };
}

/**
 * Parse a sheet cell into ISO YYYY-MM-DD, or return null when the cell is
 * empty / unparseable.
 *
 * Accepts:
 *   • ISO 8601 date: "2026-04-15"
 *   • ISO datetime (date-only used): "2026-04-15T08:30:00Z"
 *   • Written month date: "17-Jan-2026"
 *   • European: "15.04.2026", "15/04/2026"
 *   • US: "04/15/2026" (when day > 12 in the first slot, treated as DD/MM)
 *   • Sheets serial as a numeric string (days since 1899-12-30)
 *
 * Ambiguous formats (e.g., "03/04/2026") are interpreted DD/MM/YYYY (Lithuanian/EU
 * default) since the user is in Vilnius and most invoices use that form. If the
 * data set later shows otherwise, override here.
 */
export type NumericDateOrder = 'eu' | 'us' | 'ambiguous';

/** Infer the numeric date convention from unambiguous cells in one source tab. */
export function detectNumericDateOrder(values: readonly string[]): NumericDateOrder {
  let hasEuEvidence = false;
  let hasUsEvidence = false;

  for (const value of values) {
    const match = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(value.trim());
    if (!match) continue;
    const first = Number.parseInt(match[1]!, 10);
    const second = Number.parseInt(match[2]!, 10);
    const year = match[3]!.length === 2 ? `20${match[3]!}` : match[3]!;
    const eu = validIso(year, String(second), String(first));
    const us = validIso(year, String(first), String(second));
    if (eu !== null && us === null) hasEuEvidence = true;
    if (us !== null && eu === null) hasUsEvidence = true;
    if (hasEuEvidence && hasUsEvidence) return 'ambiguous';
  }

  return hasUsEvidence ? 'us' : 'eu';
}

export function parseDateCell(
  rawCell: string | undefined,
  numericDateOrder: NumericDateOrder = 'eu',
): string | null {
  if (rawCell === undefined) return null;
  const trimmed = rawCell.trim();
  if (trimmed.length === 0) return null;

  // Executive summaries use labels such as "Jan 2026" and
  // "July 1-22, 2026". They represent the first day of that month.
  const writtenMonth = /^([A-Za-z]+)(?:\s+\d{1,2}-\d{1,2},?)?\s+(\d{4})$/.exec(trimmed);
  if (writtenMonth) {
    const month = WRITTEN_MONTHS[writtenMonth[1]!.toLowerCase()];
    if (month !== undefined) return validIso(writtenMonth[2]!, String(month), '1');
  }

  // Google Sheets' report writer formats Clean Data dates as dd-mmm-yyyy.
  // Keep this unambiguous format separate from numeric EU/US inference.
  const writtenMonthDate = /^(\d{1,2})[-/. ]([A-Za-z]+)[-/. ](\d{4})$/.exec(trimmed);
  if (writtenMonthDate) {
    const month = WRITTEN_MONTHS[writtenMonthDate[2]!.toLowerCase()];
    if (month !== undefined) {
      return validIso(writtenMonthDate[3]!, String(month), writtenMonthDate[1]!);
    }
  }

  // ISO YYYY-MM-DD (with optional time suffix).
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return validIso(y!, m!, d!);
  }

  // DD/MM/YYYY or MM/DD/YYYY using the convention inferred per source tab.
  const numericMatch = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(trimmed);
  if (numericMatch) {
    const [, first, second, rawYear] = numericMatch;
    const year = rawYear!.length === 2 ? `20${rawYear!}` : rawYear!;
    const eu = validIso(year, second!, first!);
    const us = validIso(year, first!, second!);
    if (eu === null) return us;
    if (us === null) return eu;
    if (eu === us) return eu;
    if (numericDateOrder === 'ambiguous') return null;
    return numericDateOrder === 'eu' ? eu : us;
  }

  // YYYY/MM/DD or YYYY.MM.DD.
  const isoSlash = /^(\d{4})[./](\d{1,2})[./](\d{1,2})$/.exec(trimmed);
  if (isoSlash) {
    const [, y, m, d] = isoSlash;
    return validIso(y!, m!.padStart(2, '0'), d!.padStart(2, '0'));
  }

  // Google Sheets date serial (days since 1899-12-30).
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const serial = Number.parseFloat(trimmed);
    if (Number.isFinite(serial) && serial >= 1 && serial < 100000) {
      // Plausible date range (1900..2173). Sheets epoch is 1899-12-30.
      const epoch = Date.UTC(1899, 11, 30);
      const ms = epoch + Math.floor(serial) * 86_400_000;
      const dt = new Date(ms);
      const y = String(dt.getUTCFullYear());
      const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const d = String(dt.getUTCDate()).padStart(2, '0');
      return validIso(y, m, d);
    }
  }

  return null;
}

const WRITTEN_MONTHS: Readonly<Record<string, number>> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

function validIso(y: string, m: string, d: string): string | null {
  const yy = Number.parseInt(y, 10);
  const mm = Number.parseInt(m, 10);
  const dd = Number.parseInt(d, 10);
  if (!Number.isFinite(yy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null;
  if (mm < 1 || mm > 12) return null;
  if (dd < 1 || dd > 31) return null;
  if (yy < 1900 || yy > 2200) return null;
  // Reject impossible day-of-month (e.g., 31 Feb).
  const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  if (dd > daysInMonth) return null;
  return `${String(yy)}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
