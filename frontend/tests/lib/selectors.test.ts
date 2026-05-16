/**
 * T042 — Unit test for the frontend selectors (monthly aggregation +
 * status breakdown derivation from the snapshot).
 *
 * Validates the same is_done && conversion_status==='converted' filter as
 * the SQL aggregable indexes (Constitution Principle V + VI), and that the
 * payment-status breakdown sums to the headline.
 */

import { describe, expect, it } from 'vitest';
import type { ApiDataResponse, InvoiceRow } from '../../src/lib/contracts';
import {
  distinctMonths,
  distinctOrderCodes,
  isAggregable,
  lifetimePerOrder,
  lifetimeTotal,
  monthlyTotal,
  orderMonthTotal,
  projectsRankedBySpend,
  rowsDonePerMonth,
  spendByMonth,
  websiteCurrentPrices,
} from '../../src/lib/selectors';

function makeRow(overrides: Partial<InvoiceRow>): InvoiceRow {
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
    ecb_rate: 1.0,
    ecb_rate_as_of: '2026-04-15',
    conversion_status: 'converted',
    invoice_date: '2026-04-15',
    invoice_month: '2026-04',
    date_source: 'sheet',
    audit_flags: [],
    ...overrides,
  };
}

function makeData(invoices: InvoiceRow[]): ApiDataResponse {
  return {
    schema_version: 1,
    last_refreshed_at: '2026-05-12T10:00:00Z',
    refresh_status: 'success',
    duration_ms: 1234,
    per_source: [],
    counters: {
      rows_total: invoices.length,
      rows_done: invoices.filter((r) => r.is_done).length,
      rows_excluded_by_status: invoices.filter((r) => !r.is_done).length,
      rows_undated: 0,
      rows_out_of_ecb_currency: 0,
      duplicate_invoice_groups: 0,
    },
    excluded_order_codes: [],
    invoices,
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

describe('isAggregable', () => {
  it('returns true only for is_done=true AND conversion_status=converted', () => {
    expect(isAggregable(makeRow({}))).toBe(true);
    expect(isAggregable(makeRow({ is_done: false }))).toBe(false);
    expect(
      isAggregable(makeRow({ conversion_status: 'missing_price', eur_amount: null })),
    ).toBe(false);
    expect(
      isAggregable(makeRow({ conversion_status: 'out_of_ecb_currency', eur_amount: null })),
    ).toBe(false);
  });
});

describe('monthlyTotal', () => {
  it('sums aggregable rows for a given month and produces a payment-status breakdown', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), invoice_month: '2026-04', eur_amount: 100, payment_status: 'paid' }),
      makeRow({ source_row_key: '02' + '0'.repeat(14), invoice_month: '2026-04', eur_amount: 200, payment_status: 'unpaid' }),
      makeRow({ source_row_key: '03' + '0'.repeat(14), invoice_month: '2026-04', eur_amount: 50, payment_status: 'unknown' }),
      // Different month — excluded.
      makeRow({ source_row_key: '04' + '0'.repeat(14), invoice_month: '2026-03', eur_amount: 999 }),
      // Non-Done — excluded.
      makeRow({ source_row_key: '05' + '0'.repeat(14), invoice_month: '2026-04', eur_amount: 75, is_done: false }),
      // Audit-only (missing_price) — excluded.
      makeRow({
        source_row_key: '06' + '0'.repeat(14),
        invoice_month: '2026-04',
        eur_amount: null,
        conversion_status: 'missing_price',
      }),
    ]);

    const total = monthlyTotal(data, '2026-04');

    expect(total.eur).toBe(350); // 100 + 200 + 50
    expect(total.count).toBe(3);
    expect(total.by_status.paid.eur).toBe(100);
    expect(total.by_status.paid.count).toBe(1);
    expect(total.by_status.unpaid.eur).toBe(200);
    expect(total.by_status.unpaid.count).toBe(1);
    expect(total.by_status.unknown.eur).toBe(50);
    expect(total.by_status.unknown.count).toBe(1);
    expect(total.by_status.missing.count).toBe(0);

    // Breakdown sums to headline.
    const sum =
      total.by_status.paid.eur +
      total.by_status.unpaid.eur +
      total.by_status.unknown.eur +
      total.by_status.missing.eur;
    expect(sum).toBe(total.eur);
  });

  it('returns zero total when no rows match the scope', () => {
    const data = makeData([makeRow({ invoice_month: '2026-04', eur_amount: 100 })]);
    const total = monthlyTotal(data, '2026-05');
    expect(total.count).toBe(0);
    expect(total.eur).toBe(0);
  });

  it('buckets undated rows under "Undated" scope', () => {
    const data = makeData([
      makeRow({
        source_row_key: '01' + '0'.repeat(14),
        invoice_date: null,
        invoice_month: null,
        date_source: 'undated',
        eur_amount: 75,
      }),
    ]);
    const total = monthlyTotal(data, 'Undated');
    expect(total.eur).toBe(75);
    expect(total.count).toBe(1);
  });
});

describe('orderMonthTotal (T062, T063 — Phase 4 US2)', () => {
  it('filters by both order_code and month', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), order_code: 'CGLT', invoice_month: '2026-04', eur_amount: 100 }),
      makeRow({ source_row_key: '02' + '0'.repeat(14), order_code: 'LGLT', invoice_month: '2026-04', eur_amount: 200 }),
      makeRow({ source_row_key: '03' + '0'.repeat(14), order_code: 'CGLT', invoice_month: '2026-03', eur_amount: 999 }),
    ]);
    const cglt = orderMonthTotal(data, 'CGLT', '2026-04');
    expect(cglt.eur).toBe(100);
    expect(cglt.count).toBe(1);
  });

  it('returns count=0 for an order/month with no matching rows (US2 acceptance scenario 2)', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), order_code: 'CGLT', invoice_month: '2026-04' }),
    ]);
    // Existing order, different month → count=0 (frontend renders the "No spend" empty state).
    const noSpend = orderMonthTotal(data, 'CGLT', '2026-05');
    expect(noSpend.eur).toBe(0);
    expect(noSpend.count).toBe(0);
    // Non-existent order → also count=0.
    const unknownOrder = orderMonthTotal(data, 'UNKNOWN', '2026-04');
    expect(unknownOrder.eur).toBe(0);
    expect(unknownOrder.count).toBe(0);
  });

  it("buckets undated rows under 'Undated' for the order×month scope (US2 acceptance scenario 3)", () => {
    const data = makeData([
      makeRow({
        source_row_key: '01' + '0'.repeat(14),
        order_code: 'CGLT',
        invoice_date: null,
        invoice_month: null,
        date_source: 'undated',
        eur_amount: 75,
      }),
    ]);
    expect(orderMonthTotal(data, 'CGLT', 'Undated').eur).toBe(75);
    expect(orderMonthTotal(data, 'CGLT', '2026-04').count).toBe(0);
  });

  it('preserves the payment-status breakdown (FR-010)', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), order_code: 'CGLT', invoice_month: '2026-04', eur_amount: 100, payment_status: 'paid' }),
      makeRow({ source_row_key: '02' + '0'.repeat(14), order_code: 'CGLT', invoice_month: '2026-04', eur_amount: 200, payment_status: 'unpaid' }),
    ]);
    const total = orderMonthTotal(data, 'CGLT', '2026-04');
    expect(total.eur).toBe(300);
    expect(total.by_status.paid.eur).toBe(100);
    expect(total.by_status.unpaid.eur).toBe(200);
    // Sum invariant.
    const sum =
      total.by_status.paid.eur +
      total.by_status.unpaid.eur +
      total.by_status.unknown.eur +
      total.by_status.missing.eur;
    expect(sum).toBe(total.eur);
  });
});

describe('lifetimePerOrder', () => {
  it('sums every aggregable row for an order across all months', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), order_code: 'CGLT', invoice_month: '2026-04', eur_amount: 100 }),
      makeRow({ source_row_key: '02' + '0'.repeat(14), order_code: 'CGLT', invoice_month: '2026-03', eur_amount: 200 }),
      makeRow({ source_row_key: '03' + '0'.repeat(14), order_code: 'LGLT', invoice_month: '2026-04', eur_amount: 999 }),
    ]);
    const cglt = lifetimePerOrder(data, 'CGLT');
    expect(cglt.eur).toBe(300);
    expect(cglt.count).toBe(2);
  });

  it('includes undated rows in lifetime totals', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), order_code: 'CGLT', invoice_month: '2026-04', eur_amount: 100 }),
      makeRow({
        source_row_key: '02' + '0'.repeat(14),
        order_code: 'CGLT',
        invoice_date: null,
        invoice_month: null,
        date_source: 'undated',
        eur_amount: 50,
      }),
    ]);
    const cglt = lifetimePerOrder(data, 'CGLT');
    expect(cglt.eur).toBe(150);
    expect(cglt.count).toBe(2);
  });
});

describe('undated_count surfacing (US3 acceptance scenario 2 — stop-gate fix)', () => {
  it('lifetimePerOrder reports undated_count alongside the headline (CGLT only)', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), order_code: 'CGLT', invoice_month: '2026-04', eur_amount: 100 }),
      makeRow({ source_row_key: '02' + '0'.repeat(14), order_code: 'CGLT', invoice_month: '2026-03', eur_amount: 200 }),
      makeRow({
        source_row_key: '03' + '0'.repeat(14),
        order_code: 'CGLT',
        invoice_date: null,
        invoice_month: null,
        date_source: 'undated',
        eur_amount: 50,
      }),
      // Different order's undated row — must NOT count toward CGLT.
      makeRow({
        source_row_key: '04' + '0'.repeat(14),
        order_code: 'LGLT',
        invoice_date: null,
        invoice_month: null,
        date_source: 'undated',
        eur_amount: 999,
      }),
    ]);
    const cglt = lifetimePerOrder(data, 'CGLT');
    expect(cglt.eur).toBe(350);
    expect(cglt.count).toBe(3);
    expect(cglt.undated_count).toBe(1);
  });

  it('lifetimeTotal reports undated_count across all orders', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), order_code: 'A', invoice_month: '2026-04', eur_amount: 100 }),
      makeRow({
        source_row_key: '02' + '0'.repeat(14),
        order_code: 'A',
        invoice_date: null,
        invoice_month: null,
        date_source: 'undated',
        eur_amount: 50,
      }),
      makeRow({
        source_row_key: '03' + '0'.repeat(14),
        order_code: 'B',
        invoice_date: null,
        invoice_month: null,
        date_source: 'undated',
        eur_amount: 25,
      }),
    ]);
    const total = lifetimeTotal(data);
    expect(total.eur).toBe(175);
    expect(total.count).toBe(3);
    expect(total.undated_count).toBe(2);
  });

  it('monthlyTotal for a dated month reports undated_count === 0', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), invoice_month: '2026-04', eur_amount: 100 }),
      makeRow({
        source_row_key: '02' + '0'.repeat(14),
        invoice_date: null,
        invoice_month: null,
        date_source: 'undated',
        eur_amount: 50,
      }),
    ]);
    const apr = monthlyTotal(data, '2026-04');
    expect(apr.count).toBe(1);
    expect(apr.undated_count).toBe(0);
  });

  it("monthlyTotal scope='Undated' reports undated_count === count", () => {
    const data = makeData([
      makeRow({
        source_row_key: '01' + '0'.repeat(14),
        invoice_date: null,
        invoice_month: null,
        date_source: 'undated',
        eur_amount: 50,
      }),
    ]);
    const undated = monthlyTotal(data, 'Undated');
    expect(undated.count).toBe(1);
    expect(undated.undated_count).toBe(1);
  });

  it('orderMonthTotal: undated_count is 0 for dated months, equals count for Undated scope', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), order_code: 'CGLT', invoice_month: '2026-04' }),
      makeRow({
        source_row_key: '02' + '0'.repeat(14),
        order_code: 'CGLT',
        invoice_date: null,
        invoice_month: null,
        date_source: 'undated',
      }),
    ]);
    expect(orderMonthTotal(data, 'CGLT', '2026-04').undated_count).toBe(0);
    expect(orderMonthTotal(data, 'CGLT', 'Undated').undated_count).toBe(1);
  });
});

describe('lifetimeTotal (T067 — Phase 5 US3, no-order-selected lifetime)', () => {
  it('sums every aggregable row across all orders + all months', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), order_code: 'CGLT', invoice_month: '2026-04', eur_amount: 100 }),
      makeRow({ source_row_key: '02' + '0'.repeat(14), order_code: 'CGLT', invoice_month: '2026-03', eur_amount: 200 }),
      makeRow({ source_row_key: '03' + '0'.repeat(14), order_code: 'LGLT', invoice_month: '2026-04', eur_amount: 300 }),
      makeRow({
        source_row_key: '04' + '0'.repeat(14),
        order_code: 'POKERGURU',
        invoice_date: null,
        invoice_month: null,
        date_source: 'undated',
        eur_amount: 50,
      }),
      // Non-Done — excluded.
      makeRow({ source_row_key: '05' + '0'.repeat(14), order_code: 'CGLT', invoice_month: '2026-04', eur_amount: 999, is_done: false }),
      // Audit-only — excluded.
      makeRow({
        source_row_key: '06' + '0'.repeat(14),
        order_code: 'CGLT',
        invoice_month: '2026-04',
        eur_amount: null,
        conversion_status: 'missing_price',
      }),
    ]);
    const total = lifetimeTotal(data);
    expect(total.eur).toBe(650); // 100 + 200 + 300 + 50
    expect(total.count).toBe(4);
  });

  it('returns zero when no aggregable rows exist', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), is_done: false }),
    ]);
    const total = lifetimeTotal(data);
    expect(total.eur).toBe(0);
    expect(total.count).toBe(0);
  });

  it('preserves the payment-status breakdown (FR-010)', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), eur_amount: 100, payment_status: 'paid' }),
      makeRow({ source_row_key: '02' + '0'.repeat(14), eur_amount: 200, payment_status: 'unpaid' }),
      makeRow({ source_row_key: '03' + '0'.repeat(14), eur_amount: 50, payment_status: 'unknown' }),
    ]);
    const total = lifetimeTotal(data);
    expect(total.eur).toBe(350);
    expect(total.by_status.paid.eur).toBe(100);
    expect(total.by_status.unpaid.eur).toBe(200);
    expect(total.by_status.unknown.eur).toBe(50);
  });
});

describe('websiteCurrentPrices (T071 — Phase 6 US4 / FR-014)', () => {
  it('most-recent dated invoice wins (US4 acceptance scenario 1)', () => {
    const data = makeData([
      makeRow({
        source_row_key: '01' + '0'.repeat(14),
        website: 'a.com',
        invoice_date: '2026-04-15',
        invoice_month: '2026-04',
        eur_amount: 200,
      }),
      makeRow({
        source_row_key: '02' + '0'.repeat(14),
        website: 'a.com',
        invoice_date: '2026-03-10',
        invoice_month: '2026-03',
        eur_amount: 150,
      }),
    ]);
    const list = websiteCurrentPrices(data);
    expect(list).toHaveLength(1);
    expect(list[0]?.website).toBe('a.com');
    expect(list[0]?.current_price_eur).toBe(200);
    expect(list[0]?.current_price_invoice_date).toBe('2026-04-15');
    expect(list[0]?.history_count).toBe(2);
    expect(list[0]?.undated_count).toBe(0);
  });

  it('tie-break: same date → higher row_index wins (FR-014 deterministic rule)', () => {
    const data = makeData([
      makeRow({
        source_row_key: '01' + '0'.repeat(14),
        website: 'a.com',
        invoice_date: '2026-04-15',
        invoice_month: '2026-04',
        eur_amount: 100,
        row_index: 5,
      }),
      makeRow({
        source_row_key: '02' + '0'.repeat(14),
        website: 'a.com',
        invoice_date: '2026-04-15',
        invoice_month: '2026-04',
        eur_amount: 200,
        row_index: 7, // higher row_index — wins
      }),
    ]);
    const list = websiteCurrentPrices(data);
    expect(list[0]?.current_price_eur).toBe(200);
  });

  it('tie-break: same date AND same row_index → lex-greatest source_row_key wins', () => {
    const data = makeData([
      makeRow({
        source_row_key: 'aaaaaaaaaaaaaaaa',
        website: 'a.com',
        invoice_date: '2026-04-15',
        invoice_month: '2026-04',
        eur_amount: 100,
        row_index: 5,
      }),
      makeRow({
        source_row_key: 'ffffffffffffffff',
        website: 'a.com',
        invoice_date: '2026-04-15',
        invoice_month: '2026-04',
        eur_amount: 200,
        row_index: 5,
      }),
    ]);
    const list = websiteCurrentPrices(data);
    expect(list[0]?.current_price_source_row_key).toBe('ffffffffffffffff');
    expect(list[0]?.current_price_eur).toBe(200);
  });

  it("undated-only website → current_price_eur is null ('unknown') AND undated_count is shown (US4 acceptance scenario 2)", () => {
    const data = makeData([
      makeRow({
        source_row_key: '01' + '0'.repeat(14),
        website: 'undated-only.com',
        invoice_date: null,
        invoice_month: null,
        date_source: 'undated',
        eur_amount: 75,
      }),
    ]);
    const list = websiteCurrentPrices(data);
    expect(list).toHaveLength(1);
    expect(list[0]?.website).toBe('undated-only.com');
    expect(list[0]?.current_price_eur).toBeNull();
    expect(list[0]?.current_price_invoice_date).toBeNull();
    expect(list[0]?.history_count).toBe(1);
    expect(list[0]?.undated_count).toBe(1);
  });

  it("dated + undated mix: max-date row wins; undated_count flagged (US4 acceptance scenario 2 mid case)", () => {
    const data = makeData([
      makeRow({
        source_row_key: '01' + '0'.repeat(14),
        website: 'mix.com',
        invoice_date: '2026-04-15',
        invoice_month: '2026-04',
        eur_amount: 100,
      }),
      makeRow({
        source_row_key: '02' + '0'.repeat(14),
        website: 'mix.com',
        invoice_date: null,
        invoice_month: null,
        date_source: 'undated',
        eur_amount: 999, // SHOULD NOT win — undated rows excluded from current-price selection
      }),
    ]);
    const list = websiteCurrentPrices(data);
    expect(list[0]?.current_price_eur).toBe(100);
    expect(list[0]?.history_count).toBe(2);
    expect(list[0]?.undated_count).toBe(1);
  });

  it('non-EUR most-recent invoice exposes native amount + currency (US4 acceptance scenario 4)', () => {
    const data = makeData([
      makeRow({
        source_row_key: '01' + '0'.repeat(14),
        website: 'us-vendor.com',
        invoice_date: '2026-04-15',
        invoice_month: '2026-04',
        native_amount: 100,
        native_currency: 'USD',
        eur_amount: 92.69,
        ecb_rate: 1.0789,
      }),
    ]);
    const list = websiteCurrentPrices(data);
    expect(list[0]?.current_price_eur).toBe(92.69);
    expect(list[0]?.current_price_native_amount).toBe(100);
    expect(list[0]?.current_price_native_currency).toBe('USD');
  });

  it('rows with null website are skipped entirely', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), website: null }),
      makeRow({ source_row_key: '02' + '0'.repeat(14), website: 'real.com', invoice_date: '2026-04-15', invoice_month: '2026-04' }),
    ]);
    const list = websiteCurrentPrices(data);
    expect(list).toHaveLength(1);
    expect(list[0]?.website).toBe('real.com');
  });

  it('returns websites sorted alphabetically', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), website: 'zebra.com', invoice_date: '2026-04-15', invoice_month: '2026-04' }),
      makeRow({ source_row_key: '02' + '0'.repeat(14), website: 'alpha.com', invoice_date: '2026-04-15', invoice_month: '2026-04' }),
      makeRow({ source_row_key: '03' + '0'.repeat(14), website: 'mango.com', invoice_date: '2026-04-15', invoice_month: '2026-04' }),
    ]);
    const list = websiteCurrentPrices(data);
    expect(list.map((w) => w.website)).toEqual(['alpha.com', 'mango.com', 'zebra.com']);
  });

  it('non-aggregable rows (non-Done, audit-only) excluded entirely', () => {
    const data = makeData([
      makeRow({
        source_row_key: '01' + '0'.repeat(14),
        website: 'real.com',
        invoice_date: '2026-04-15',
        invoice_month: '2026-04',
        eur_amount: 100,
      }),
      // Non-Done — excluded.
      makeRow({
        source_row_key: '02' + '0'.repeat(14),
        website: 'real.com',
        is_done: false,
        invoice_date: '2026-05-01',
        invoice_month: '2026-05',
        eur_amount: 999,
      }),
      // Audit-only — excluded.
      makeRow({
        source_row_key: '03' + '0'.repeat(14),
        website: 'real.com',
        invoice_date: '2026-05-15',
        invoice_month: '2026-05',
        conversion_status: 'missing_price',
        eur_amount: null,
      }),
    ]);
    const list = websiteCurrentPrices(data);
    expect(list).toHaveLength(1);
    // The non-Done 2026-05-01 row would have been the most-recent if
    // it counted. The audit-only 2026-05-15 same. Neither is included,
    // so 2026-04-15 wins.
    expect(list[0]?.current_price_invoice_date).toBe('2026-04-15');
    expect(list[0]?.current_price_eur).toBe(100);
    expect(list[0]?.history_count).toBe(1);
  });
});

describe('distinctMonths', () => {
  it('returns sorted descending months, with Undated appended at the end', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), invoice_month: '2026-03' }),
      makeRow({ source_row_key: '02' + '0'.repeat(14), invoice_month: '2026-04' }),
      makeRow({ source_row_key: '03' + '0'.repeat(14), invoice_month: '2026-04' }),
      makeRow({
        source_row_key: '04' + '0'.repeat(14),
        invoice_date: null,
        invoice_month: null,
        date_source: 'undated',
      }),
    ]);
    expect(distinctMonths(data)).toEqual(['2026-04', '2026-03', 'Undated']);
  });
});

describe('distinctOrderCodes', () => {
  it('returns sorted unique order codes', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), order_code: 'LGLT' }),
      makeRow({ source_row_key: '02' + '0'.repeat(14), order_code: 'CGLT' }),
      makeRow({ source_row_key: '03' + '0'.repeat(14), order_code: 'LGLT' }),
      makeRow({ source_row_key: '04' + '0'.repeat(14), order_code: 'POKERGURU' }),
    ]);
    expect(distinctOrderCodes(data)).toEqual(['CGLT', 'LGLT', 'POKERGURU']);
  });
});

describe('spendByMonth', () => {
  it('aggregates converted Done rows by month with unpaid, unknown, and missing status as outstanding', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), invoice_month: '2026-03', eur_amount: 100, payment_status: 'paid' }),
      makeRow({ source_row_key: '02' + '0'.repeat(14), invoice_month: '2026-03', eur_amount: 30, payment_status: 'unpaid' }),
      makeRow({ source_row_key: '03' + '0'.repeat(14), invoice_month: '2026-04', eur_amount: 200, payment_status: 'paid' }),
      makeRow({ source_row_key: '04' + '0'.repeat(14), invoice_month: '2026-04', eur_amount: 40, payment_status: 'unknown' }),
      makeRow({ source_row_key: '05' + '0'.repeat(14), invoice_month: '2026-04', eur_amount: 10, payment_status: 'missing' }),
      makeRow({ source_row_key: '06' + '0'.repeat(14), invoice_month: '2026-04', eur_amount: 999, is_done: false }),
      makeRow({
        source_row_key: '07' + '0'.repeat(14),
        invoice_month: '2026-04',
        eur_amount: null,
        conversion_status: 'missing_price',
      }),
      makeRow({
        source_row_key: '08' + '0'.repeat(14),
        invoice_date: null,
        invoice_month: null,
        date_source: 'undated',
        eur_amount: 75,
        payment_status: 'paid',
      }),
    ]);

    expect(spendByMonth(data)).toEqual([
      { m: '2026-03', paid: 100, outstanding: 30 },
      { m: '2026-04', paid: 200, outstanding: 50 },
    ]);
  });
});

describe('rowsDonePerMonth', () => {
  it('counts every Done row with a dated month, including audit-only Done rows', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), invoice_month: '2026-03' }),
      makeRow({ source_row_key: '02' + '0'.repeat(14), invoice_month: '2026-03', conversion_status: 'missing_price', eur_amount: null }),
      makeRow({ source_row_key: '03' + '0'.repeat(14), invoice_month: '2026-03', is_done: false }),
      makeRow({ source_row_key: '04' + '0'.repeat(14), invoice_month: '2026-04' }),
      makeRow({
        source_row_key: '05' + '0'.repeat(14),
        invoice_date: null,
        invoice_month: null,
        date_source: 'undated',
      }),
    ]);

    expect(rowsDonePerMonth(data)).toEqual([2, 1]);
  });
});

describe('projectsRankedBySpend', () => {
  it('ranks order codes by converted Done EUR spend and breaks ties by code', () => {
    const data = makeData([
      makeRow({ source_row_key: '01' + '0'.repeat(14), order_code: 'BETA', eur_amount: 100 }),
      makeRow({ source_row_key: '02' + '0'.repeat(14), order_code: 'BETA', eur_amount: 50 }),
      makeRow({ source_row_key: '03' + '0'.repeat(14), order_code: 'ALPHA', eur_amount: 150 }),
      makeRow({ source_row_key: '04' + '0'.repeat(14), order_code: 'GAMMA', eur_amount: 80 }),
      makeRow({ source_row_key: '05' + '0'.repeat(14), order_code: 'GAMMA', eur_amount: 999, is_done: false }),
      makeRow({
        source_row_key: '06' + '0'.repeat(14),
        order_code: 'GAMMA',
        eur_amount: null,
        conversion_status: 'missing_price',
      }),
    ]);

    expect(projectsRankedBySpend(data)).toEqual([
      { code: 'ALPHA', eur: 150, rows: 1 },
      { code: 'BETA', eur: 150, rows: 2 },
      { code: 'GAMMA', eur: 80, rows: 1 },
    ]);
  });
});
