import { describe, expect, it } from 'vitest';
import { distinctMonths, isAggregable, monthlyTotal } from '../../src/lib/selectors';
import type { ApiDataResponse, InvoiceRow, PaymentStatus } from '../../src/lib/contracts';

function row(source_row_key: string, month: string, amount: number | null, status: PaymentStatus, is_done = true): InvoiceRow {
  return {
    source_row_key, invoice_id: null, order_code: 'CGLT', spreadsheet_id: 's1', tab_name: month,
    tab_name_raw: month, row_index: 2, work_status: is_done ? 'Done' : 'In Progress', is_done,
    payment_status: status, invoice_type: 'pdf', artifact_ref: 'inv.pdf', artifact_status: 'reachable',
    website: 'a.com', website_raw: 'a.com', target_url: null, anchor_text: null,
    native_amount: amount, native_currency: 'EUR', eur_amount: amount,
    presswhizz_price_eur: amount === null ? null : amount * 1.1,
    savings_eur: amount === null ? 0 : amount / 10, ecb_rate: 1,
    ecb_rate_as_of: `${month}-01`, conversion_status: amount === null ? 'out_of_ecb_currency' : 'converted',
    invoice_date: `${month}-15`, invoice_month: month, date_source: 'sheet', audit_flags: [],
  };
}

function envelope(invoices: InvoiceRow[]): ApiDataResponse {
  return {
    schema_version: 3, reporting_year: 2026, last_refreshed_at: '2026-05-12T10:00:00Z',
    refresh_status: 'success', duration_ms: 0, per_source: [],
    counters: { rows_total: invoices.length, rows_done: invoices.filter((invoice) => invoice.is_done).length, rows_excluded_by_status: invoices.filter((invoice) => !invoice.is_done).length, rows_undated: 0, rows_out_of_ecb_currency: 0, duplicate_invoice_groups: 0 },
    excluded_order_codes: [], invoices,
    audit_findings_by_category: { non_done_row: [], missing_price: [], unparseable_amount: [], missing_currency: [], missing_invoice_url: [], missing_date: [], unknown_payment_status: [], missing_payment_status: [], duplicate_invoice_id: [], out_of_ecb_currency: [], future_dated_invoice: [], artifact_unreachable: [], pdf_extraction_failed: [], paypal_verification_mismatch: [] },
  };
}

describe('monthly 2026 aggregation', () => {
  const invoices = [
    row('a000000000000001', '2026-02', 100, 'paid'),
    row('a000000000000002', '2026-02', 50, 'unpaid'),
    row('a000000000000003', '2026-02', 999, 'paid', false),
    row('b000000000000001', '2026-03', 200, 'paid'),
    row('b000000000000002', '2026-03', 75, 'paid'),
    row('b000000000000003', '2026-03', 25, 'unknown'),
    row('b000000000000004', '2026-03', null, 'paid'),
    row('c000000000000001', '2026-04', 300, 'missing'),
  ];
  const snapshot = envelope(invoices);

  it('rounds payment spend buckets before deriving the spend headline', () => {
    const feb = monthlyTotal(snapshot, '2026-02');
    expect(feb.spend_eur).toBe(150);
    expect(feb.savings_eur).toBe(15);
    expect(feb.by_status.paid).toEqual({ spend_eur: 100, count: 1 });
    expect(feb.by_status.unpaid).toEqual({ spend_eur: 50, count: 1 });
    const bucketSpend = (['paid', 'unpaid', 'unknown', 'missing'] satisfies PaymentStatus[])
      .reduce((sum, status) => sum + feb.by_status[status].spend_eur, 0);
    expect(bucketSpend).toBe(feb.spend_eur);
  });

  it('excludes non-Done and non-converted rows while retaining all 2026 months', () => {
    expect(monthlyTotal(snapshot, '2026-03')).toMatchObject({ spend_eur: 300, count: 3 });
    expect(monthlyTotal(snapshot, '2026-04')).toMatchObject({ spend_eur: 300, count: 1 });
    expect(invoices.filter(isAggregable)).toHaveLength(6);
    expect(distinctMonths(snapshot)).toEqual(['2026-04', '2026-03', '2026-02']);
  });
});
