/**
 * T034 (NON-NEGOTIABLE per Constitution Development Workflow & Quality
 * Gates) — monthly aggregation discipline.
 *
 * Spec: given a fixture with mixed Done/non-Done rows across 3 months,
 * verify the per-month aggregation:
 *   • returns one entry per month
 *   • EUR-sums ONLY rows where is_done=true AND conversion_status='converted'
 *   • payment-status breakdown sums equal the headline
 *
 * The frontend selector battery (frontend/src/lib/selectors.ts) is what
 * the dashboard actually renders from. The backend doesn't ship a
 * `monthlyTotals()` function — aggregation is intentionally client-side
 * (the snapshot ships every row and selectors derive). So this test
 * exercises the frontend selectors `monthlyTotal()` + helpers, which
 * is the live aggregation path.
 *
 * NB: a backend variant would be redundant with `pipeline.test.ts`'s
 * end-to-end happy-path assertions. This test isolates the math from
 * the pipeline composition.
 */

import { describe, it, expect } from 'vitest';
import {
  monthlyTotal,
  isAggregable,
  distinctMonths,
} from '../../src/lib/selectors';
import type {
  ApiDataResponse,
  InvoiceRow,
  PaymentStatus,
} from '../../src/lib/contracts';

function row(partial: Partial<InvoiceRow> & {
  source_row_key: string;
  invoice_month: string | null;
  is_done: boolean;
}): InvoiceRow {
  const eur = partial.eur_amount ?? (partial.is_done ? 100 : null);
  return {
    invoice_id: null,
    order_code: 'CGLT',
    spreadsheet_id: 's1',
    tab_name: partial.invoice_month ?? 'Undated',
    tab_name_raw: partial.invoice_month ?? 'Undated',
    row_index: 2,
    work_status: partial.is_done ? 'Done' : 'In Progress',
    payment_status: partial.payment_status ?? 'paid',
    invoice_type: 'pdf',
    artifact_ref: 'inv.pdf',
    artifact_status: 'reachable',
    website: 'a.com',
    website_raw: 'a.com',
    native_amount: eur,
    native_currency: 'EUR',
    eur_amount: eur,
    ecb_rate: 1,
    ecb_rate_as_of: '2026-04-01',
    conversion_status: partial.conversion_status ?? 'converted',
    invoice_date: partial.invoice_month ? `${partial.invoice_month}-15` : null,
    date_source: partial.invoice_month ? 'sheet' : 'undated',
    audit_flags: [],
    ...partial,
  };
}

function envelope(rows: InvoiceRow[]): ApiDataResponse {
  return {
    schema_version: 1,
    last_refreshed_at: '2026-05-12T10:00:00Z',
    refresh_status: 'success',
    duration_ms: 0,
    per_source: [],
    counters: {
      rows_total: rows.length,
      rows_done: rows.filter((r) => r.is_done).length,
      rows_excluded_by_status: rows.filter((r) => !r.is_done).length,
      rows_undated: 0,
      rows_out_of_ecb_currency: 0,
      duplicate_invoice_groups: 0,
    },
    excluded_order_codes: [],
    invoices: rows,
    audit_findings_by_category: {
      non_done_row: [],
      missing_price: [],
      unparseable_amount: [],
      missing_currency: [],
      missing_invoice_url: [],
      missing_date: [],
      unknown_payment_status: [],
      missing_payment_status: [],
      duplicate_invoice_id: [],
      out_of_ecb_currency: [],
      future_dated_invoice: [],
      artifact_unreachable: [],
      pdf_extraction_failed: [],
      paypal_verification_mismatch: [],
    },
  };
}

describe('T034 — monthly aggregation NON-NEGOTIABLE math', () => {
  // Fixture spanning 3 months × mixed payment status × mixed Done/non-Done +
  // an audit-only row that must NOT contribute EUR.
  const rows: InvoiceRow[] = [
    // 2026-02 — 2 Done+converted (paid + unpaid), 1 non-Done
    row({ source_row_key: 'a000000000000001', invoice_month: '2026-02', is_done: true, payment_status: 'paid', eur_amount: 100 }),
    row({ source_row_key: 'a000000000000002', invoice_month: '2026-02', is_done: true, payment_status: 'unpaid', eur_amount: 50 }),
    row({ source_row_key: 'a000000000000003', invoice_month: '2026-02', is_done: false, eur_amount: null }),

    // 2026-03 — 3 Done+converted (paid×2 + unknown), 1 audit-only Done
    row({ source_row_key: 'b000000000000001', invoice_month: '2026-03', is_done: true, payment_status: 'paid', eur_amount: 200 }),
    row({ source_row_key: 'b000000000000002', invoice_month: '2026-03', is_done: true, payment_status: 'paid', eur_amount: 75 }),
    row({ source_row_key: 'b000000000000003', invoice_month: '2026-03', is_done: true, payment_status: 'unknown', eur_amount: 25 }),
    // Audit-only: is_done but conversion_status != converted → EXCLUDED from EUR sum
    row({ source_row_key: 'b000000000000004', invoice_month: '2026-03', is_done: true, payment_status: 'paid', eur_amount: null, conversion_status: 'out_of_ecb_currency' }),

    // 2026-04 — 1 Done+converted+missing-status
    row({ source_row_key: 'c000000000000001', invoice_month: '2026-04', is_done: true, payment_status: 'missing', eur_amount: 300 }),
  ];
  const data = envelope(rows);

  it('per-month total includes ONLY rows where is_done=true AND conversion_status="converted"', () => {
    const feb = monthlyTotal(data, '2026-02');
    const mar = monthlyTotal(data, '2026-03');
    const apr = monthlyTotal(data, '2026-04');

    expect(feb.eur).toBe(150); // 100 + 50, NOT including non-Done
    expect(mar.eur).toBe(300); // 200 + 75 + 25, NOT including audit-only out_of_ecb
    expect(apr.eur).toBe(300);
  });

  it('counts reflect only aggregable rows (excludes non-Done AND audit-only)', () => {
    expect(monthlyTotal(data, '2026-02').count).toBe(2);
    expect(monthlyTotal(data, '2026-03').count).toBe(3); // 4 Done; 1 audit-only excluded
    expect(monthlyTotal(data, '2026-04').count).toBe(1);
  });

  it('payment-status breakdown sums to the headline EUR (FR-010 + Principle VI)', () => {
    for (const month of ['2026-02', '2026-03', '2026-04']) {
      const t = monthlyTotal(data, month);
      const sumOfStatuses = (['paid', 'unpaid', 'unknown', 'missing'] satisfies PaymentStatus[])
        .reduce((acc, s) => acc + t.by_status[s].eur, 0);
      expect(sumOfStatuses).toBe(t.eur);
      const sumOfCounts = (['paid', 'unpaid', 'unknown', 'missing'] satisfies PaymentStatus[])
        .reduce((acc, s) => acc + t.by_status[s].count, 0);
      expect(sumOfCounts).toBe(t.count);
    }
  });

  it('payment-status breakdown allocates each row to exactly one bucket', () => {
    const feb = monthlyTotal(data, '2026-02');
    expect(feb.by_status.paid).toEqual({ eur: 100, count: 1 });
    expect(feb.by_status.unpaid).toEqual({ eur: 50, count: 1 });
    expect(feb.by_status.unknown).toEqual({ eur: 0, count: 0 });
    expect(feb.by_status.missing).toEqual({ eur: 0, count: 0 });

    const mar = monthlyTotal(data, '2026-03');
    expect(mar.by_status.paid).toEqual({ eur: 275, count: 2 });
    expect(mar.by_status.unknown).toEqual({ eur: 25, count: 1 });

    const apr = monthlyTotal(data, '2026-04');
    expect(apr.by_status.missing).toEqual({ eur: 300, count: 1 });
  });

  it('non-Done rows are excluded from is_done-gated aggregation but visible via isAggregable predicate', () => {
    expect(rows.filter(isAggregable).length).toBe(6); // 6 Done+converted; 1 non-Done + 1 audit-only excluded
  });

  it('distinctMonths returns every aggregable month sorted descending', () => {
    expect(distinctMonths(data)).toEqual(['2026-04', '2026-03', '2026-02']);
  });

  it('months with no aggregable rows return zeroed total (never throws)', () => {
    const empty = monthlyTotal(data, '2030-01');
    expect(empty.eur).toBe(0);
    expect(empty.count).toBe(0);
    expect(empty.by_status.paid).toEqual({ eur: 0, count: 0 });
  });
});
