/**
 * Audit findings aggregator (T052 + T090).
 *
 * Walks the normalized rows and emits one Audit finding per detected issue
 * per category, referencing the row by `source_row_key`. The store layer
 * inserts these into `audit_findings`.
 *
 * Categories (per FR-021 + Decision 15 + Decision 12):
 *   non_done_row              — is_done=false
 *   missing_price             — conversion_status='missing_price'
 *   missing_invoice_url       — artifact_ref is null AND invoice_type≠missing was expected by sheet config (we approximate by emitting whenever artifact_ref is null and the sheet had an invoice_url column at all — surfaced via row.audit_flags)
 *   missing_date              — date_source='undated'
 *   unknown_payment_status    — payment_status='unknown'
 *   missing_payment_status    — payment_status='missing'
 *   duplicate_invoice_id      — group of rows sharing the same non-null invoice_id (count > 1 ⇒ ONE finding per group, with N rows contributing)
 *   out_of_ecb_currency       — conversion_status='out_of_ecb_currency'
 *   future_dated_invoice      — invoice_date > today
 *   artifact_unreachable      — artifact_status='unreachable'
 *   pdf_extraction_failed     — v2-reserved (always [] in v1; emitted by the API layer)
 *   paypal_verification_mismatch — v2-reserved (always [] in v1)
 *
 * IMPORTANT (Codex review #2 from branch 7c9b3fb): duplicate_invoice_id is
 * AUDIT-ONLY. No row is removed from totals on the basis of a shared
 * invoice_id. Every Done+converted row contributes its full eur_amount.
 * The aggregator emits ONE finding per duplicate group (the first row in
 * the group); the summary names the count and the IDs so the operator can
 * reconcile.
 */

import type { AuditCategory } from '../../shared/contracts.js';
import type { NormalizedRow } from '../normalize/index.js';

export interface AuditFindingDraft {
  source_row_key: string | null;
  category: AuditCategory;
  summary: string;
  eur_amount: number | null;
  spreadsheet_id: string;
  tab_name: string;
  row_index: number;
}

/**
 * Produce all Audit findings for a batch of normalized rows.
 * Emits per-row findings AND duplicate-invoice-id group findings.
 */
export function emitFindings(rows: readonly NormalizedRow[]): AuditFindingDraft[] {
  const out: AuditFindingDraft[] = [];

  // ----- Per-row findings -----
  for (const row of rows) {
    if (!row.is_done) {
      out.push(rowFinding(row, 'non_done_row', summarizeNonDone(row)));
    }
    if (row.conversion_status === 'missing_price') {
      out.push(rowFinding(row, 'missing_price', `Done row at ${rowProvenance(row)} has no parseable price.`));
    }
    if (row.conversion_status === 'unparseable_amount') {
      // QA review H5: emit as its own category so the operator can query
      // "rows where I typo'd the amount" directly instead of via the
      // rolled-up missing_price view.
      out.push(
        rowFinding(
          row,
          'unparseable_amount',
          `Done row at ${rowProvenance(row)} has an unparseable price cell.`,
        ),
      );
    }
    if (row.conversion_status === 'missing_currency') {
      // QA review H5: emit as its own category (see above).
      out.push(
        rowFinding(
          row,
          'missing_currency',
          `Done row at ${rowProvenance(row)} has a parseable price but no currency.`,
        ),
      );
    }
    if (row.conversion_status === 'out_of_ecb_currency') {
      // QA review H8: distinguish "currency not in ECB feed at all" from
      // "currency exists but coverage begins after this invoice's date" so
      // the operator can act on each appropriately. The normalize layer
      // stashes the reason in audit_flags as `ecb_reason:<reason>`.
      const reasonFlag = row.audit_flags.find((f) => f.startsWith('ecb_reason:'));
      const reason = reasonFlag?.slice('ecb_reason:'.length) ?? 'currency_unknown';
      const currency = row.native_currency ?? 'UNKNOWN';
      const summary =
        reason === 'no_rate_on_or_before_date'
          ? `Currency ${currency} has no ECB rate on or before ${row.invoice_date ?? 'undated'} ` +
            `(currency exists in the feed but coverage begins later); row excluded from EUR totals.`
          : `Currency ${currency} is not in the ECB reference set; row excluded from EUR totals.`;
      out.push(rowFinding(row, 'out_of_ecb_currency', summary));
    }
    if (row.is_done && row.artifact_ref === null) {
      out.push(rowFinding(row, 'missing_invoice_url', `Done row at ${rowProvenance(row)} has no invoice URL.`));
    }
    if (row.is_done && row.date_source === 'undated') {
      out.push(rowFinding(row, 'missing_date', `Done row at ${rowProvenance(row)} has no parseable date.`));
    }
    if (row.payment_status === 'unknown') {
      out.push(
        rowFinding(
          row,
          'unknown_payment_status',
          `Row at ${rowProvenance(row)} has a status column but the cell is blank or unrecognized.`,
        ),
      );
    }
    if (row.payment_status === 'missing') {
      out.push(
        rowFinding(
          row,
          'missing_payment_status',
          `Sheet ${row.spreadsheet_id} (${row.order_code}) has no payment-status column mapped.`,
        ),
      );
    }
    if (row.is_done && row.invoice_date !== null && row.invoice_date > todayIsoDate()) {
      out.push(
        rowFinding(
          row,
          'future_dated_invoice',
          `Done row at ${rowProvenance(row)} has invoice_date=${row.invoice_date} in the future.`,
        ),
      );
    }
    if (row.artifact_status === 'unreachable') {
      const reason = row.artifact_unreachable_reason ?? 'unknown';
      out.push(
        rowFinding(
          row,
          'artifact_unreachable',
          `${row.invoice_type} artifact for row at ${rowProvenance(row)} could not be opened (${reason}); row remains in totals using the sheet price.`,
        ),
      );
    }
  }

  // ----- duplicate_invoice_id (group-level) -----
  const groups = new Map<string, NormalizedRow[]>();
  for (const row of rows) {
    if (row.invoice_id === null) continue;
    if (!row.is_done) continue;
    const arr = groups.get(row.invoice_id) ?? [];
    arr.push(row);
    groups.set(row.invoice_id, arr);
  }
  for (const [id, group] of groups) {
    if (group.length < 2) continue;
    const first = group[0]!;
    const ordersList = group.map((r) => `${r.order_code} ${rowProvenance(r)}`).join(', ');
    out.push({
      source_row_key: first.source_row_key,
      category: 'duplicate_invoice_id',
      summary: `${group.length} rows share invoice_id ${id}: ${ordersList}. All rows remain in totals (FR-007); investigate if duplication is unintentional.`,
      eur_amount: null,
      spreadsheet_id: first.spreadsheet_id,
      tab_name: first.tab_name,
      row_index: first.row_index,
    });
  }

  return out;
}

function rowFinding(
  row: NormalizedRow,
  category: AuditCategory,
  summary: string,
): AuditFindingDraft {
  return {
    source_row_key: row.source_row_key,
    category,
    summary,
    eur_amount: row.eur_amount,
    spreadsheet_id: row.spreadsheet_id,
    tab_name: row.tab_name,
    row_index: row.row_index,
  };
}

function rowProvenance(row: NormalizedRow): string {
  return `${row.tab_name_raw}:${row.row_index}`;
}

function summarizeNonDone(row: NormalizedRow): string {
  const status = row.work_status.trim();
  return status.length > 0
    ? `Row at ${rowProvenance(row)} has work_status="${status}" (not "Done"); excluded from totals.`
    : `Row at ${rowProvenance(row)} has no work_status (or column not mapped); excluded from totals.`;
}

function todayIsoDate(): string {
  const d = new Date();
  return `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
