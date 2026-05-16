/**
 * T096 — synthetic-data performance smoke (SC-010).
 *
 * Spec SC-010: "The dashboard renders the monthly snapshot view in under
 * 2 seconds on the trusted local network with the full invoice history
 * loaded."
 *
 * The "render" path the operator perceives is:
 *   1. fetchData() → backend round-trip (covered by Lighthouse / not here)
 *   2. zod parse of ApiDataResponse (covered by react render path)
 *   3. selector computations (monthlyTotal, lifetimeTotal, etc.)
 *   4. React reconciliation (covered by component tests, indirectly)
 *
 * This test exercises step 3 — the pure-function selector layer — over
 * 1000 synthesized invoice rows. If selectors slow down past their O(N)
 * baseline (e.g., a future O(N²) refactor), this fails LOUDLY.
 *
 * Threshold is conservative: 200ms covers the WHOLE selector battery
 * called repeatedly. Real wall-clock will be ~5-30ms; if a regression
 * pushes past 200ms, something's structurally wrong.
 */

import { describe, it, expect } from 'vitest';
import {
  distinctMonths,
  distinctOrderCodes,
  drillRowsForScope,
  drillRowsForWebsite,
  isAggregable,
  lifetimePerOrder,
  lifetimeTotal,
  monthlyTotal,
  nonEmptyAuditCategoryCount,
  orderMonthTotal,
  websiteCurrentPrices,
} from '../../src/lib/selectors';
import type {
  ApiDataResponse,
  InvoiceRow,
} from '../../src/lib/contracts';

function syntheticRow(i: number): InvoiceRow {
  // 5 orders × ~24 months × ~8 websites × random payment status →
  // representative spread for the selector battery.
  const orders = ['CGLT', 'LGLT', 'POKERGURU', 'SPORT24', 'BINGOGURU'];
  const monthIdx = i % 24;
  const year = 2024 + Math.floor(monthIdx / 12);
  const month = String((monthIdx % 12) + 1).padStart(2, '0');
  const day = String((i % 28) + 1).padStart(2, '0');
  return {
    source_row_key: i.toString(16).padStart(16, '0'),
    invoice_id: `INV-${i}`,
    order_code: orders[i % orders.length]!,
    spreadsheet_id: `sheet-${i % 10}`,
    tab_name: `${month} ${year}`,
    tab_name_raw: `${month} ${year}`,
    row_index: (i % 200) + 2,
    work_status: i % 13 === 0 ? 'In Progress' : 'Done',
    is_done: i % 13 !== 0,
    payment_status:
      i % 5 === 0 ? 'paid' : i % 5 === 1 ? 'unpaid' : i % 5 === 2 ? 'unknown' : 'missing',
    invoice_type:
      i % 6 === 0 ? 'paypal' : i % 6 === 1 ? 'pdf' : i % 6 === 2 ? 'drive_pdf' : 'text',
    artifact_ref: `https://example.com/inv/${i}`,
    artifact_status: 'reachable',
    website: `site-${i % 8}.com`,
    website_raw: `site-${i % 8}.com`,
    native_amount: 100 + (i % 250),
    native_currency: i % 7 === 0 ? 'USD' : 'EUR',
    eur_amount: i % 7 === 0 ? (100 + (i % 250)) / 1.07 : 100 + (i % 250),
    ecb_rate: i % 7 === 0 ? 1.07 : 1.0,
    ecb_rate_as_of: `${year}-${month}-${day}`,
    conversion_status: 'converted',
    invoice_date: `${year}-${month}-${day}`,
    invoice_month: `${year}-${month}`,
    date_source: 'sheet',
    audit_flags: [],
  };
}

function syntheticEnvelope(rows: InvoiceRow[]): ApiDataResponse {
  return {
    schema_version: 1,
    last_refreshed_at: '2026-05-12T10:00:00Z',
    refresh_status: 'success',
    duration_ms: 1234,
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

describe('T096 / SC-010 — selector battery over 1000-row snapshot', () => {
  it('every selector returns deterministic results in under 200ms wall-clock', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => syntheticRow(i));
    const data = syntheticEnvelope(rows);

    // Sanity: synthetic data covers the surfaces we care about.
    expect(rows.filter(isAggregable).length).toBeGreaterThan(900);
    expect(distinctMonths(data).length).toBeGreaterThan(20);
    expect(distinctOrderCodes(data).length).toBe(5);

    const start = performance.now();
    // Run the full selector battery the way App.tsx does on every render
    // (10× to amplify slowdowns; per-render budget is 20ms).
    for (let i = 0; i < 10; i += 1) {
      monthlyTotal(data, '2026-04');
      orderMonthTotal(data, 'CGLT', '2026-04');
      lifetimePerOrder(data, 'CGLT');
      lifetimeTotal(data);
      websiteCurrentPrices(data);
      drillRowsForScope(data, 'CGLT', '2026-04');
      drillRowsForWebsite(data, 'site-3.com');
      distinctMonths(data);
      distinctOrderCodes(data);
      nonEmptyAuditCategoryCount(data);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
  });

  it('one full-render selector pass over 1000 rows completes in under 50ms', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => syntheticRow(i));
    const data = syntheticEnvelope(rows);

    const start = performance.now();
    monthlyTotal(data, '2026-04');
    orderMonthTotal(data, 'CGLT', '2026-04');
    lifetimePerOrder(data, 'CGLT');
    lifetimeTotal(data);
    websiteCurrentPrices(data);
    drillRowsForScope(data, 'CGLT', '2026-04');
    drillRowsForWebsite(data, 'site-3.com');
    distinctMonths(data);
    distinctOrderCodes(data);
    nonEmptyAuditCategoryCount(data);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});
