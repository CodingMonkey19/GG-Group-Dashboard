import { describe, expect, it } from 'vitest';
import {
  reconcileReportSource,
  ReportReconciliationError,
} from '../../../src/pipeline/ingest/report-reconciliation.js';
import type { RawRow } from '../../../src/pipeline/ingest/gws.js';
import type { NormalizedRow } from '../../../src/pipeline/normalize/index.js';

function row(
  source_row_key: string,
  order_code: string,
  invoice_date: string,
  native_amount: number,
  savings_eur: number,
): NormalizedRow {
  return {
    source_row_key,
    invoice_id: null,
    order_code,
    spreadsheet_id: 'REPORT_2026',
    tab_name: 'Clean Data',
    tab_name_raw: 'Clean Data',
    row_index: 2,
    work_status: 'Done',
    is_done: true,
    payment_status: 'paid',
    invoice_type: 'text',
    artifact_ref: 'receipt',
    artifact_status: 'not_attempted',
    artifact_unreachable_reason: null,
    website: null,
    website_raw: null,
    native_amount,
    native_currency: 'EUR',
    eur_amount: Math.round(native_amount * 100) / 100,
    savings_eur,
    ecb_rate: 1,
    ecb_rate_as_of: invoice_date,
    conversion_status: 'converted',
    invoice_date,
    invoice_month: invoice_date.slice(0, 7),
    date_source: 'sheet',
    audit_flags: [],
  };
}

function sheet(rows: string[][]): RawRow[] {
  return rows.map((cells, index) => ({ row_index: index + 1, cells }));
}

const rows = [
  row('0000000000000001', 'ORDER-A', '2026-01-15', 100, 10.005),
  row('0000000000000002', 'ORDER-A', '2026-02-10', 200, 20),
  row('0000000000000003', 'ORDER-B', '2026-02-20', 50.25, 5.125),
  row('0000000000000004', 'HISTORICAL', '2025-12-31', 999, 99),
];

function monthly(totalSavings = '35.13'): RawRow[] {
  // Headers are deliberately re-ordered to prove name resolution, not index
  // assumptions. Summary values are raw, unformatted spreadsheet values.
  return sheet([
    ['Savings (EUR)', 'Month', 'Spend (EUR)'],
    ['10.005', '2026-01', '100'],
    ['25.125', '2026-02', '250.25'],
    [totalSavings, 'Total', '350.25'],
  ]);
}

function orders(): RawRow[] {
  return sheet([
    ['Order', 'Savings (EUR)', 'Spend (EUR)'],
    ['ORDER-A', '30.005', '300'],
    ['ORDER-B', '5.125', '50.25'],
    ['Total', '35.13', '350.25'],
  ]);
}

describe('reconcileReportSource', () => {
  it('reconciles 2026 Spend and raw Savings across both summary surfaces', () => {
    expect(() => reconcileReportSource(rows, monthly(), orders())).not.toThrow();
  });

  it('rejects missing or unexpected summary details and mismatched totals', () => {
    const missing = monthly().filter((entry) => entry.cells[1] !== '2026-02');
    expect(() => reconcileReportSource(rows, missing, orders())).toThrow(ReportReconciliationError);

    const unexpected = orders();
    unexpected.splice(3, 0, { row_index: 4, cells: ['ORDER-X', '1', '1'] });
    expect(() => reconcileReportSource(rows, monthly(), unexpected)).toThrow('unexpected Order ORDER-X');

    expect(() => reconcileReportSource(rows, monthly('35.14'), orders())).toThrow('Total row 4 Savings mismatch');
  });
});
