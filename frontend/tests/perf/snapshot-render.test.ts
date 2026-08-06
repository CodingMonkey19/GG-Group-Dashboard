import { describe, expect, it } from 'vitest';
import {
  distinctMonths,
  distinctOrderCodes,
  drillRowsForScope,
  drillRowsForWebsite,
  isAggregable,
  monthlyTotal,
  nonEmptyAuditCategoryCount,
  orderMonthTotal,
  reportingYearPerOrder,
  reportingYearTotal,
  websiteCurrentPrices,
} from '../../src/lib/selectors';
import type { ApiDataResponse, InvoiceRow } from '../../src/lib/contracts';

function syntheticRow(i: number): InvoiceRow {
  const orders = ['CGLT', 'LGLT', 'POKERGURU', 'SPORT24', 'BINGOGURU'];
  const month = String((i % 12) + 1).padStart(2, '0');
  const day = String((i % 28) + 1).padStart(2, '0');
  const amount = 100 + (i % 250);
  return {
    source_row_key: i.toString(16).padStart(16, '0'), invoice_id: `INV-${i}`,
    order_code: orders[i % orders.length]!, spreadsheet_id: `sheet-${i % 10}`,
    tab_name: `${month} 2026`, tab_name_raw: `${month} 2026`, row_index: (i % 200) + 2,
    work_status: i % 13 === 0 ? 'In Progress' : 'Done', is_done: i % 13 !== 0,
    payment_status: i % 5 === 0 ? 'paid' : i % 5 === 1 ? 'unpaid' : i % 5 === 2 ? 'unknown' : 'missing',
    invoice_type: 'paypal', artifact_ref: `https://example.com/inv/${i}`, artifact_status: 'reachable',
    website: `site-${i % 8}.com`, website_raw: `site-${i % 8}.com`,
    target_url: `https://client.example/${i}`, anchor_text: `anchor ${i}`,
    native_amount: amount, native_currency: 'EUR', eur_amount: amount,
    presswhizz_price_eur: amount * 1.1, savings_eur: amount / 10, ecb_rate: 1,
    ecb_rate_as_of: `2026-${month}-${day}`, conversion_status: 'converted',
    invoice_date: `2026-${month}-${day}`, invoice_month: `2026-${month}`, date_source: 'sheet', audit_flags: [],
  };
}

function snapshot(invoices: InvoiceRow[]): ApiDataResponse {
  return {
    schema_version: 3, reporting_year: 2026, last_refreshed_at: '2026-05-12T10:00:00Z',
    refresh_status: 'success', duration_ms: 1234, per_source: [],
    counters: { rows_total: invoices.length, rows_done: invoices.filter((invoice) => invoice.is_done).length, rows_excluded_by_status: invoices.filter((invoice) => !invoice.is_done).length, rows_undated: 0, rows_out_of_ecb_currency: 0, duplicate_invoice_groups: 0 },
    excluded_order_codes: [], invoices,
    audit_findings_by_category: { non_done_row: [], missing_price: [], unparseable_amount: [], missing_currency: [], missing_invoice_url: [], missing_date: [], unknown_payment_status: [], missing_payment_status: [], duplicate_invoice_id: [], out_of_ecb_currency: [], future_dated_invoice: [], artifact_unreachable: [], pdf_extraction_failed: [], paypal_verification_mismatch: [] },
  };
}

describe('selector battery over a 1000-row 2026 source snapshot', () => {
  it('returns the February–December dashboard views in under 200ms', () => {
    const data = snapshot(Array.from({ length: 1000 }, (_, index) => syntheticRow(index)));
    expect(data.invoices.filter(isAggregable).length).toBeGreaterThan(800);
    expect(distinctMonths(data)).toHaveLength(11);
    const start = performance.now();
    for (let index = 0; index < 10; index += 1) {
      monthlyTotal(data, '2026-04'); orderMonthTotal(data, 'CGLT', '2026-04');
      reportingYearPerOrder(data, 'CGLT'); reportingYearTotal(data); websiteCurrentPrices(data);
      drillRowsForScope(data, 'CGLT', '2026-04'); drillRowsForWebsite(data, 'site-3.com');
      distinctMonths(data); distinctOrderCodes(data); nonEmptyAuditCategoryCount(data);
    }
    expect(performance.now() - start).toBeLessThan(200);
  });
});
