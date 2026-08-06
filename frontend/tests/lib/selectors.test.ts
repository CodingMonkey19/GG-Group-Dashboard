import { describe, expect, it } from 'vitest';
import type { ApiDataResponse, InvoiceRow } from '../../src/lib/contracts';
import {
  distinctMonths,
  distinctOrderCodes,
  drillRowsForScope,
  isAggregable,
  isReportingYearRow,
  monthlyTotal,
  orderMonthTotal,
  projectsRankedBySpend,
  reportingYearPerOrder,
  reportingYearTotal,
  rowsDonePerMonth,
  spendByMonth,
  websiteCurrentPrices,
} from '../../src/lib/selectors';

function row(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    source_row_key: '0123456789abcdef',
    invoice_id: null,
    order_code: 'CGLT',
    spreadsheet_id: 'SHEET',
    tab_name: 'April 2026',
    tab_name_raw: 'April 2026',
    row_index: 1,
    work_status: 'Done',
    is_done: true,
    payment_status: 'paid',
    invoice_type: 'paypal',
    artifact_ref: 'https://www.paypal.com/invoice/p/#X',
    artifact_status: 'not_attempted',
    website: 'example.com',
    website_raw: 'example.com',
    native_amount: 100,
    native_currency: 'EUR',
    eur_amount: 100,
    savings_eur: 25,
    ecb_rate: 1,
    ecb_rate_as_of: '2026-04-15',
    conversion_status: 'converted',
    invoice_date: '2026-04-15',
    invoice_month: '2026-04',
    date_source: 'sheet',
    audit_flags: [],
    ...overrides,
  };
}

function data(invoices: InvoiceRow[]): ApiDataResponse {
  return {
    schema_version: 2,
    reporting_year: 2026,
    last_refreshed_at: '2026-05-12T10:00:00Z',
    refresh_status: 'success',
    duration_ms: 1234,
    per_source: [],
    counters: {
      rows_total: invoices.length,
      rows_done: invoices.filter((invoice) => invoice.is_done).length,
      rows_excluded_by_status: invoices.filter((invoice) => !invoice.is_done).length,
      rows_undated: 0,
      rows_out_of_ecb_currency: 0,
      duplicate_invoice_groups: 0,
    },
    excluded_order_codes: [],
    invoices,
    audit_findings_by_category: {
      non_done_row: [], missing_price: [], unparseable_amount: [], missing_currency: [],
      missing_invoice_url: [], missing_date: [], unknown_payment_status: [],
      missing_payment_status: [], duplicate_invoice_id: [], out_of_ecb_currency: [],
      future_dated_invoice: [], artifact_unreachable: [], pdf_extraction_failed: [],
      paypal_verification_mismatch: [],
    },
  };
}

describe('2026 reporting selectors', () => {
  it('includes only Done, converted rows that are within the reporting year', () => {
    const valid = row();
    const januaryReporting = row({
      source_row_key: '3333333333333333',
      invoice_date: '2026-01-15',
      invoice_month: '2026-01',
    });
    const shiftedToFebruary = row({
      source_row_key: '4444444444444444',
      invoice_date: '2026-01-15',
      invoice_month: '2026-02',
    });
    const from2025 = { ...row({ source_row_key: '1111111111111111' }), invoice_date: '2025-12-31', invoice_month: '2025-12' } as InvoiceRow;
    const from2027 = { ...row({ source_row_key: '2222222222222222' }), invoice_date: '2027-01-01', invoice_month: '2027-01' } as InvoiceRow;
    expect(isReportingYearRow(valid)).toBe(true);
    expect(isReportingYearRow(januaryReporting)).toBe(false);
    expect(isReportingYearRow(shiftedToFebruary)).toBe(true);
    expect(isAggregable(valid)).toBe(true);
    expect(isAggregable(from2025)).toBe(false);
    expect(isAggregable(from2027)).toBe(false);
    expect(isAggregable(row({ is_done: false }))).toBe(false);
    expect(isAggregable(row({ conversion_status: 'missing_price', eur_amount: null }))).toBe(false);
  });

  it('returns spend, savings, count, and rounded payment spend buckets', () => {
    const snapshot = data([
      row({ source_row_key: '0000000000000001', eur_amount: 10.004, savings_eur: 1.004, payment_status: 'paid' }),
      row({ source_row_key: '0000000000000002', eur_amount: 20.005, savings_eur: 2.005, payment_status: 'unpaid' }),
      row({ source_row_key: '0000000000000003', eur_amount: 99, savings_eur: 99, is_done: false }),
    ]);
    const total = monthlyTotal(snapshot, '2026-04');
    expect(total).toEqual({
      spend_eur: 30.01,
      savings_eur: 3.01,
      count: 2,
      by_status: {
        paid: { spend_eur: 10, count: 1 },
        unpaid: { spend_eur: 20.01, count: 1 },
        unknown: { spend_eur: 0, count: 0 },
        missing: { spend_eur: 0, count: 0 },
      },
    });
  });

  it('scopes monthly and order/month totals to the exact selected month and order', () => {
    const snapshot = data([
      row({ source_row_key: '0000000000000001', order_code: 'CGLT', eur_amount: 100, savings_eur: 10 }),
      row({ source_row_key: '0000000000000002', order_code: 'LGLT', eur_amount: 200, savings_eur: 20 }),
      row({ source_row_key: '0000000000000003', order_code: 'CGLT', invoice_date: '2026-03-15', invoice_month: '2026-03', eur_amount: 300, savings_eur: 30 }),
    ]);
    expect(monthlyTotal(snapshot, '2026-04').spend_eur).toBe(300);
    expect(orderMonthTotal(snapshot, 'CGLT', '2026-04')).toMatchObject({ spend_eur: 100, savings_eur: 10, count: 1 });
  });

  it('uses the full 2026 total while preserving the selected order', () => {
    const snapshot = data([
      row({ source_row_key: '0000000000000001', order_code: 'CGLT', eur_amount: 100, savings_eur: 10 }),
      row({ source_row_key: '0000000000000002', order_code: 'CGLT', invoice_date: '2026-03-15', invoice_month: '2026-03', eur_amount: 200, savings_eur: 20 }),
      row({ source_row_key: '0000000000000003', order_code: 'LGLT', eur_amount: 300, savings_eur: 30 }),
      { ...row({ source_row_key: '0000000000000004', order_code: 'CGLT', eur_amount: 999, savings_eur: 999 }), invoice_date: '2025-12-15', invoice_month: '2025-12' } as InvoiceRow,
    ]);
    expect(reportingYearPerOrder(snapshot, 'CGLT')).toMatchObject({ spend_eur: 300, savings_eur: 30, count: 2 });
    expect(reportingYearTotal(snapshot)).toMatchObject({ spend_eur: 600, savings_eur: 60, count: 3 });
  });

  it('defensively excludes non-2026 data from every derived collection and drill', () => {
    const snapshot = data([
      row({ source_row_key: '0000000000000001', order_code: 'CGLT', website: 'current.test' }),
      { ...row({ source_row_key: '0000000000000002', order_code: 'OLD', website: 'old.test', eur_amount: 999 }), invoice_date: '2025-12-20', invoice_month: '2025-12' } as InvoiceRow,
    ]);
    expect(distinctMonths(snapshot)).toEqual(['2026-04']);
    expect(distinctOrderCodes(snapshot)).toEqual(['CGLT']);
    expect(rowsDonePerMonth(snapshot)).toEqual([1]);
    expect(spendByMonth(snapshot)).toEqual([{ m: '2026-04', paid: 100, outstanding: 0 }]);
    expect(projectsRankedBySpend(snapshot)).toEqual([{ code: 'CGLT', eur: 100, rows: 1 }]);
    expect(websiteCurrentPrices(snapshot).map((website) => website.website)).toEqual(['current.test']);
    expect(drillRowsForScope(snapshot, null, null).map((invoice) => invoice.order_code)).toEqual(['CGLT']);
  });
});
