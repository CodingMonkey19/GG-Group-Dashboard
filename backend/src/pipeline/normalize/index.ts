/**
 * Normalize orchestrator (T051).
 *
 * Composes every pure normalize fn + the extract handoff into a single
 * row mapper:
 *
 *   AdapterRow + GwsWrapper + SQLite (for ECB cache lookups)
 *     → NormalizedRow (matches InvoiceRow zod schema except `id` and
 *                      `ingested_at`, which the store layer adds at insert).
 *
 * Per Constitution Principle V + research.md Decision 15, audit-only rows
 * (missing_price / unparseable_amount / missing_currency / out_of_ecb_currency)
 * still get admitted to the store with conversion fields NULL — they show
 * up in the Audit panel via the source_row_key reference.
 *
 * Per FR-031, the Status="Done" filter is applied via the `is_done` flag
 * (the row stays in the store, but aggregation queries filter on
 * `is_done=1 AND conversion_status='converted'`).
 */

import type { Database as DatabaseT } from 'better-sqlite3';
import type {
  ConversionStatus,
  PaymentStatus,
  InvoiceType,
  ArtifactStatus,
  DateSource,
} from '../../shared/contracts.js';
import { extractDrivePdf } from '../extract/drive-pdf.js';
import { extractPdf } from '../extract/pdf.js';
import { extractPaypal } from '../extract/paypal.js';
import type { GwsWrapper } from '../ingest/gws.js';
import type { AdapterRow } from '../ingest/sheet-adapter.js';
import { parsePriceCell, priceReasonToConversionStatus } from './conversion-status.js';
import { toEur, EcbRateUnavailableError } from './currency.js';
import { parseDateCell, resolveDate } from './date-resolution.js';
import { classifyInvoiceType } from './invoice-type.js';
import { classifyPaymentStatus } from './payment-status.js';
import { isDone } from './status-filter.js';
import { canonicalizeWebsite } from './website.js';

export interface NormalizedRow {
  source_row_key: string;
  invoice_id: string | null;
  order_code: string;
  spreadsheet_id: string;
  tab_name: string;
  tab_name_raw: string;
  row_index: number;
  work_status: string;
  is_done: boolean;
  payment_status: PaymentStatus;
  invoice_type: InvoiceType;
  artifact_ref: string | null;
  artifact_status: ArtifactStatus;
  /** Reason an artifact was unreachable (for the audit summary). null when reachable / not_attempted. */
  artifact_unreachable_reason: string | null;
  website: string | null;
  website_raw: string | null;
  target_url: string | null;
  anchor_text: string | null;
  /** Column L value (the published article URL); null when blank. */
  live_url: string | null;
  native_amount: number | null;
  native_currency: string | null;
  eur_amount: number | null;
  /** Raw EUR savings supplied by the executive report; legacy rows use zero. */
  savings_eur: number;
  /** Raw PressWhizz comparison price supplied by the report; null when blank. */
  presswhizz_price_eur: number | null;
  ecb_rate: number | null;
  ecb_rate_as_of: string | null;
  conversion_status: ConversionStatus;
  invoice_date: string | null;
  invoice_month: string | null;
  date_source: DateSource;
  audit_flags: string[];
}

export interface NormalizeOptions {
  gws: GwsWrapper;
  db: DatabaseT;
  /** Local PDF root for extract/pdf.ts. Required when any sheet has `pdf` rows. */
  pdfRoot: string;
}

/**
 * Global dashboard boundary. Every ingestion mode must apply this before a
 * row can reach normalization, counters, audits, or storage.
 */
export function isDashboardEligibleRow(
  row: Pick<AdapterRow, 'status' | 'invoice_date'>,
): boolean {
  const invoiceDate = parseDateCell(row.invoice_date);
  return isDone(row.status) && invoiceDate !== null &&
    invoiceDate >= '2026-01-01' && invoiceDate < '2027-01-01';
}

/**
 * Normalize one AdapterRow into a NormalizedRow ready to be inserted.
 *
 * Every row is admitted (no row is dropped at this layer); the
 * `conversion_status` field tells downstream whether to count the EUR
 * amount or treat it as audit-only.
 */
export async function normalizeRow(
  row: AdapterRow,
  options: NormalizeOptions,
): Promise<NormalizedRow> {
  const work_status = row.status ?? '';
  const done = isDone(row.status);
  const payment_status = classifyPaymentStatus(row.invoice_status);
  const invoice_type = classifyInvoiceType(row.invoice_url);
  const artifact_ref =
    row.invoice_url !== undefined && row.invoice_url.trim() !== '' ? row.invoice_url.trim() : null;
  const website_raw = row.website !== undefined && row.website !== '' ? row.website : null;
  const website = canonicalizeWebsite(row.website);

  const audit_flags: string[] = [];
  const isReportRow = row.source_mode === 'report';

  // ---- Extract step (per invoice_type). Owns artifact_status. ----
  let artifact_status: ArtifactStatus = 'not_attempted';
  let artifact_unreachable_reason: string | null = null;
  let artifact_invoice_id: string | null = null;
  let artifact_date: string | null = null;

  // Clean Data's validated invoice date is authoritative for report rows.
  // Still classify and retain the artifact reference for the artifact route,
  // but never inspect PDF/Drive metadata during a report refresh.
  if (!isReportRow) {
    if (invoice_type === 'paypal' && artifact_ref !== null) {
      const r = extractPaypal(artifact_ref);
      artifact_invoice_id = r.invoice_id;
      artifact_status = r.artifact_status; // always 'not_attempted' in v1
    } else if (invoice_type === 'pdf' && artifact_ref !== null) {
      const r = await extractPdf(artifact_ref, { pdfRoot: options.pdfRoot });
      artifact_status = r.artifact_status;
      artifact_unreachable_reason = r.reason;
      artifact_date = r.date;
      if (artifact_status === 'unreachable') audit_flags.push('artifact_unreachable');
    } else if (invoice_type === 'drive_pdf' && artifact_ref !== null) {
      const r = await extractDrivePdf(artifact_ref, options.gws);
      artifact_status = r.artifact_status;
      artifact_unreachable_reason = r.reason;
      artifact_date = r.date;
      if (artifact_status === 'unreachable') audit_flags.push('artifact_unreachable');
    }
  }
  // intuit / text / missing → artifact_status stays 'not_attempted'.

  // ---- Date-resolution chain (sheet → artifact → undated). ----
  const reportDate = isReportRow ? parseDateCell(row.invoice_date) : null;
  const dateResolution = isReportRow
    ? reportDate === null
      ? { invoice_date: null, invoice_month: null, date_source: 'undated' as const }
      : {
          invoice_date: reportDate,
          invoice_month: row.reporting_month ?? reportDate.slice(0, 7),
          date_source: 'sheet' as const,
        }
    : resolveDate({
        sheetCell: row.invoice_date,
        artifactDate: artifact_date,
        invoice_type,
      });

  // ---- Conversion (price + currency → EUR). ----
  const priceParse = parsePriceCell(row.price);
  let conversion_status: ConversionStatus = 'converted';
  let native_amount: number | null = null;
  let native_currency: string | null = null;
  let eur_amount: number | null = null;
  let ecb_rate: number | null = null;
  let ecb_rate_as_of: string | null = null;

  const priceFailure = priceReasonToConversionStatus(priceParse.reason);
  if (priceFailure !== null) {
    conversion_status = priceFailure;
    audit_flags.push(priceFailure);
  } else {
    native_amount = priceParse.native_amount; // non-null when reason==='parsed'
    // Determine native_currency. Resolution order (Principle V):
    //   1. Explicit currency column on the sheet (e.g. "USD") — wins.
    //   2. ISO code or symbol detected INSIDE the price cell itself
    //      (e.g. "$70.00 USD" → USD, "£40 GBP" → GBP). This is the path
    //      that operator sheets use when there's no dedicated currency
    //      column but the price cell carries the indicator inline.
    //   3. Default to EUR when no indicator anywhere (per FR-004 — sheet
    //      records an EUR amount with no currency column).
    if (row.currency === undefined) {
      native_currency = priceParse.detected_currency ?? 'EUR';
    } else {
      const trimmed = row.currency.trim().toUpperCase();
      if (trimmed.length === 0) {
        // Currency column is mapped but the cell is blank — fall back to
        // any inline indicator before flagging the row as audit-only.
        if (priceParse.detected_currency !== null) {
          native_currency = priceParse.detected_currency;
        } else {
          conversion_status = 'missing_currency';
          audit_flags.push('missing_currency');
        }
      } else {
        native_currency = trimmed;
      }
    }

    if (conversion_status === 'converted' && native_currency !== null && native_amount !== null) {
      // Use the resolved invoice_date for ECB lookup; if undated, use today
      // — the ECB rate-as-of will record the actual date used so the audit
      // trail is honest. (Undated rows still convert; aggregation just
      // doesn't bucket them by month.)
      const lookupDate = dateResolution.invoice_date ?? todayIsoDate();
      try {
        const conv = toEur(options.db, native_amount, native_currency, lookupDate);
        eur_amount = conv.eur_amount;
        ecb_rate = conv.ecb_rate;
        ecb_rate_as_of = conv.ecb_rate_as_of;
      } catch (err) {
        if (err instanceof EcbRateUnavailableError) {
          conversion_status = 'out_of_ecb_currency';
          audit_flags.push('out_of_ecb_currency');
          // QA review H8: stash the reason so the audit emitter can vary the
          // summary text — `currency_unknown` ("XPT not in ECB set") vs
          // `no_rate_on_or_before_date` ("USD invoice from 1998-09, ECB
          // coverage begins later"). Both map to the same conversion_status.
          audit_flags.push(`ecb_reason:${err.reason}`);
          // Reset conversion fields to null per the audit-only-row contract.
          eur_amount = null;
          ecb_rate = null;
          ecb_rate_as_of = null;
        } else {
          throw err;
        }
      }
    }
  }

  // ---- Audit flags for missing artifact reference + missing date. ----
  if (artifact_ref === null) audit_flags.push('missing_invoice_url');
  if (dateResolution.date_source === 'undated') audit_flags.push('missing_date');
  if (!done) audit_flags.push('non_done_row');
  if (payment_status === 'unknown') audit_flags.push('unknown_payment_status');
  if (payment_status === 'missing') audit_flags.push('missing_payment_status');
  const sourceIssue = row.data_quality_issue?.trim();
  if (isReportRow && sourceIssue !== undefined && sourceIssue.length > 0) {
    audit_flags.push(`source_data_quality_issue:${sourceIssue}`);
  }
  // QA review H10: gate future_dated_invoice on is_done to match the audit
  // emitter (audit/findings.ts), otherwise the row's audit_flags JSON and
  // the canonical audit_findings table disagree.
  if (done && dateResolution.invoice_date !== null && dateResolution.invoice_date > todayIsoDate()) {
    audit_flags.push('future_dated_invoice');
  }
  // QA review H3: when a non-EUR undated row gets converted (the lookup
  // used today's date because the invoice has none), flag the row so the
  // operator can see the EUR figure was rate-approximated. EUR rows
  // short-circuit with rate=1.0 so no approximation applies.
  if (
    done &&
    dateResolution.date_source === 'undated' &&
    conversion_status === 'converted' &&
    native_currency !== null &&
    native_currency !== 'EUR'
  ) {
    audit_flags.push('undated_rate_approximated');
  }

  return {
    source_row_key: row.source_row_key,
    invoice_id: artifact_invoice_id,
    order_code: row.order_code,
    spreadsheet_id: row.spreadsheet_id,
    tab_name: row.tab_name,
    tab_name_raw: row.tab_name_raw,
    row_index: row.row_index,
    work_status,
    is_done: done,
    payment_status,
    invoice_type,
    artifact_ref,
    artifact_status,
    artifact_unreachable_reason,
    website,
    website_raw,
    target_url: trimmedOrNull(row.target_url),
    anchor_text: trimmedOrNull(row.anchor),
    live_url: row.live_url !== undefined && row.live_url.trim() !== '' ? row.live_url.trim() : null,
    native_amount,
    native_currency,
    eur_amount,
    savings_eur: isReportRow ? row.savings_eur : 0,
    presswhizz_price_eur: isReportRow ? row.presswhizz_price_eur : null,
    ecb_rate,
    ecb_rate_as_of,
    conversion_status,
    invoice_date: dateResolution.invoice_date,
    invoice_month: dateResolution.invoice_month,
    date_source: dateResolution.date_source,
    audit_flags,
  };
}

function trimmedOrNull(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Today's date in ISO YYYY-MM-DD UTC. Used for ECB lookup of undated rows
 *  and for future-dated detection. Not exposed to the frontend (FR-024
 *  requires server-supplied buckets). */
function todayIsoDate(): string {
  const d = new Date();
  return `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}
