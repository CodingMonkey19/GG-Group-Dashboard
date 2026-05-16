/**
 * HANDOFF v2 §3.7 — redesign selector tests (NON-NEGOTIABLE per the plan).
 *
 * Covers the new three-axis scope selector battery added in src/lib/selectors.ts:
 *   isAggregableInScope · spendInScope · monthlyBreakdowns · rowsDoneSeries
 *   distinctYears · monthsInYear · lifetimeRowsDoneFor
 *
 * Fixture spans two years, three orders, one undated row, one audit-only
 * row — enough to exercise every branch.
 */

import { describe, it, expect } from 'vitest';
import {
  distinctYears,
  isAggregableInScope,
  lifetimePerOrder,
  lifetimeRowsDoneFor,
  lifetimeTotal,
  monthlyBreakdowns,
  monthsInYear,
  rowsDonePerMonth,
  rowsDoneSeries,
  spendByMonth,
  spendInScope,
  type SpendScope,
} from '../../src/lib/selectors';
import type { ApiDataResponse, InvoiceRow } from '../../src/lib/contracts';

function row(partial: Partial<InvoiceRow> & {
  source_row_key: string;
  invoice_month: string | null;
  is_done: boolean;
}): InvoiceRow {
  const eur = partial.eur_amount ?? (partial.is_done ? 100 : null);
  return {
    invoice_id: null,
    order_code: partial.order_code ?? 'CGLT',
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
      rows_undated: rows.filter((r) => r.is_done && r.invoice_month === null).length,
      rows_out_of_ecb_currency: rows.filter(
        (r) => r.is_done && r.conversion_status === 'out_of_ecb_currency',
      ).length,
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

// Fixture: 2 years × 3 orders × 1 undated × 1 audit-only.
//   2025-11  CGLT  100
//   2026-01  CGLT  200
//   2026-01  LGLT  300
//   2026-02  CGLT  150
//   2026-02  POKER  50
//   2026-03  LGLT  400
//   2026-03  LGLT  (audit-only, eur=null, out_of_ecb_currency) — excluded
//   2026-03  CGLT  (non-Done) — excluded
//   Undated  CGLT  75  (Done + converted, but invoice_month=null)
const fixtureRows: InvoiceRow[] = [
  row({ source_row_key: '0000000000000001', invoice_month: '2025-11', is_done: true, order_code: 'CGLT',  eur_amount: 100 }),
  row({ source_row_key: '0000000000000002', invoice_month: '2026-01', is_done: true, order_code: 'CGLT',  eur_amount: 200 }),
  row({ source_row_key: '0000000000000003', invoice_month: '2026-01', is_done: true, order_code: 'LGLT',  eur_amount: 300 }),
  row({ source_row_key: '0000000000000004', invoice_month: '2026-02', is_done: true, order_code: 'CGLT',  eur_amount: 150 }),
  row({ source_row_key: '0000000000000005', invoice_month: '2026-02', is_done: true, order_code: 'POKER', eur_amount: 50 }),
  row({ source_row_key: '0000000000000006', invoice_month: '2026-03', is_done: true, order_code: 'LGLT',  eur_amount: 400 }),
  row({
    source_row_key: '0000000000000007',
    invoice_month: '2026-03',
    is_done: true,
    order_code: 'LGLT',
    eur_amount: null,
    conversion_status: 'out_of_ecb_currency',
  }),
  row({ source_row_key: '0000000000000008', invoice_month: '2026-03', is_done: false, order_code: 'CGLT' }),
  row({ source_row_key: '0000000000000009', invoice_month: null,      is_done: true, order_code: 'CGLT', eur_amount: 75 }),
];
const data = envelope(fixtureRows);

const allScope: SpendScope = { year: 'all', month: 'all', orderCode: null };

describe('HANDOFF §3.7 — redesign selectors', () => {
  it('1. spendInScope on an empty envelope returns { eur: 0, count: 0 }', () => {
    const empty = envelope([]);
    expect(spendInScope(empty, allScope)).toEqual({ eur: 0, count: 0 });
  });

  it('2. spendInScope(all, all, null).eur equals lifetimeTotal(data).eur', () => {
    expect(spendInScope(data, allScope).eur).toBe(lifetimeTotal(data).eur);
  });

  it('3. spendInScope with orderCode equals lifetimePerOrder(data, code).eur', () => {
    for (const code of ['CGLT', 'LGLT', 'POKER']) {
      const scope: SpendScope = { year: 'all', month: 'all', orderCode: code };
      expect(spendInScope(data, scope).eur).toBe(lifetimePerOrder(data, code).eur);
    }
  });

  it('4. monthlyBreakdowns(data, allScope) per-month totals match spendByMonth (paid+outstanding)', () => {
    const breakdowns = monthlyBreakdowns(data, allScope);
    const legacy = spendByMonth(data);

    expect(breakdowns.map((b) => b.m)).toEqual(legacy.map((p) => p.m));
    for (let i = 0; i < breakdowns.length; i += 1) {
      const b = breakdowns[i]!;
      const p = legacy[i]!;
      // Rounded-cents tolerance: both sides round currency identically,
      // so they should be exactly equal.
      expect(b.total).toBe(p.paid + p.outstanding);
    }
  });

  it('5. monthlyBreakdowns honours orderCode — every byProject array contains only that code', () => {
    const scope: SpendScope = { year: 'all', month: 'all', orderCode: 'LGLT' };
    const breakdowns = monthlyBreakdowns(data, scope);
    expect(breakdowns.length).toBeGreaterThan(0);
    for (const b of breakdowns) {
      for (const p of b.byProject) {
        expect(p.code).toBe('LGLT');
      }
    }
  });

  it('6. rowsDoneSeries(data, null).counts matches the legacy rowsDonePerMonth(data)', () => {
    const series = rowsDoneSeries(data, null);
    expect(series.counts).toEqual(rowsDonePerMonth(data));
  });

  it("7. distinctYears returns the expected reverse-sorted year list ['2026','2025']", () => {
    expect(distinctYears(data)).toEqual(['2026', '2025']);
  });

  it("8. monthsInYear(data, '2026') returns sorted ['01','02','03']", () => {
    expect(monthsInYear(data, '2026')).toEqual(['01', '02', '03']);
  });

  it("8b. monthsInYear(data, '2025') returns ['11'] (only month with rows)", () => {
    expect(monthsInYear(data, '2025')).toEqual(['11']);
  });

  it('9. isAggregableInScope excludes Undated rows when scope.year !== "all"', () => {
    const undatedRow = fixtureRows.find((r) => r.invoice_month === null)!;
    expect(isAggregableInScope(undatedRow, allScope)).toBe(true);
    const yearScope: SpendScope = { year: '2026', month: 'all', orderCode: null };
    expect(isAggregableInScope(undatedRow, yearScope)).toBe(false);
    const monthScope: SpendScope = { year: '2026', month: '03', orderCode: null };
    expect(isAggregableInScope(undatedRow, monthScope)).toBe(false);
  });

  it('lifetimeRowsDoneFor counts every is_done row for a given order_code regardless of conversion_status', () => {
    // CGLT: 4 Done rows in the fixture (2025-11, 2026-01, 2026-02, Undated) — non-Done excluded
    expect(lifetimeRowsDoneFor(data, 'CGLT')).toBe(4);
    // LGLT: 3 Done rows (2026-01, 2026-03 converted, 2026-03 out_of_ecb — still Done)
    expect(lifetimeRowsDoneFor(data, 'LGLT')).toBe(3);
    expect(lifetimeRowsDoneFor(data, 'POKER')).toBe(1);
    expect(lifetimeRowsDoneFor(data, 'NONEXISTENT')).toBe(0);
  });

  it('spendInScope with year + month narrows to that bucket only', () => {
    const scope: SpendScope = { year: '2026', month: '01', orderCode: null };
    // 2026-01: CGLT 200 + LGLT 300 = 500
    expect(spendInScope(data, scope)).toEqual({ eur: 500, count: 2 });
  });

  it('future-dated rows are hidden from filters, line chart, and KPIs when `today` is passed', () => {
    // Add a row dated far in the future relative to TODAY (the simulated
    // current date below). With no `today` argument the selectors default
    // to a 9999 sentinel — that's the back-compat path the legacy tests
    // above rely on, so we must pass `today` explicitly here to exercise
    // the filter.
    const TODAY = '2026-05-15';
    const futureRows: InvoiceRow[] = [
      ...fixtureRows,
      row({
        source_row_key: '0000000000000099',
        invoice_month: '2099-01',
        is_done: true,
        order_code: 'FUTUREORDER',
        eur_amount: 9999,
      }),
    ];
    const futureIdx = futureRows.length - 1;
    futureRows[futureIdx] = { ...futureRows[futureIdx]!, invoice_date: '2099-01-15' };
    const futureData = envelope(futureRows);

    // distinctYears: 2099 must NOT appear when `today` is supplied.
    expect(distinctYears(futureData, TODAY)).not.toContain('2099');
    // monthsInYear('2099'): empty (every month is future).
    expect(monthsInYear(futureData, '2099', TODAY)).toEqual([]);
    // rowsDoneSeries excludes the future row.
    const series = rowsDoneSeries(futureData, null, TODAY);
    expect(series.months).not.toContain('2099-01');
    // spendInScope excludes the future row at every scope level.
    expect(spendInScope(futureData, allScope, TODAY)).toEqual(spendInScope(data, allScope, TODAY));
    // monthlyBreakdowns has no '2099-01' bucket.
    const breakdowns = monthlyBreakdowns(futureData, allScope, TODAY);
    expect(breakdowns.map((b) => b.m)).not.toContain('2099-01');
    // lifetimeRowsDoneFor on FUTUREORDER counts zero — the only row is filtered out.
    expect(lifetimeRowsDoneFor(futureData, 'FUTUREORDER', TODAY)).toBe(0);

    // Sanity: WITHOUT `today` (back-compat path), the same future row is
    // included — proving the filter is opt-in for tests.
    expect(distinctYears(futureData)).toContain('2099');
    expect(rowsDoneSeries(futureData, null).months).toContain('2099-01');
  });

  it('monthlyBreakdowns byProject orders codes by global rank (consistent palette indexing)', () => {
    // Global rank by lifetime spend: LGLT (700) > CGLT (525 incl. undated) > POKER (50)
    // For 2026-02: CGLT 150 + POKER 50; byProject should be [CGLT, POKER] (rank-ordered).
    const breakdowns = monthlyBreakdowns(data, allScope);
    const feb = breakdowns.find((b) => b.m === '2026-02');
    expect(feb).toBeDefined();
    const codes = feb!.byProject.map((p) => p.code);
    // CGLT appears before POKER in the global ranking
    expect(codes.indexOf('CGLT')).toBeLessThan(codes.indexOf('POKER'));
  });
});
