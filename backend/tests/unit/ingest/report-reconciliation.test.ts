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
  month: '01' | '07',
  spend: number,
  savings: number,
): NormalizedRow {
  const invoice_date = `2026-${month}-15`;
  return {
    source_row_key, invoice_id: null, order_code, spreadsheet_id: 'REPORT_2026',
    tab_name: 'Clean Data', tab_name_raw: 'Clean Data', row_index: 2,
    work_status: 'Done', is_done: true, payment_status: 'paid', invoice_type: 'text',
    artifact_ref: 'receipt', artifact_status: 'not_attempted', artifact_unreachable_reason: null,
    website: null, website_raw: null, live_url: null, native_amount: spend, native_currency: 'EUR',
    eur_amount: Math.round(spend * 100) / 100, savings_eur: savings, ecb_rate: 1,
    ecb_rate_as_of: invoice_date, conversion_status: 'converted', invoice_date,
    invoice_month: invoice_date.slice(0, 7), date_source: 'sheet', audit_flags: [],
  };
}

function sheet(rows: string[][]): RawRow[] {
  return rows.map((cells, index) => ({ row_index: index + 1, cells }));
}

const rows = [
  row('0000000000000001', 'ORDER-A', '01', 100, 10.005),
  row('0000000000000002', 'ORDER-A', '07', 200, 20),
  row('0000000000000003', 'ORDER-B', '07', 50.25, 5.125),
  { ...row('0000000000000004', 'HISTORICAL', '01', 999, 99), invoice_date: '2025-12-31', invoice_month: '2025-12' },
];

function monthly(): RawRow[] {
  return sheet([
    ['Month', 'Spend (EUR)', 'Saving (EUR)'],
    ['46023', '100', '10.005'], ['46204', '250.25', '25.125'], ['Total', '350.25', '35.13'],
  ]);
}

function orders(): RawRow[] {
  return sheet([
    [
      'Order', 'January 2026 Spend (EUR)', 'July 1-22, 2026 Spend (EUR)',
      'Total Spend through July 22, 2026', 'Link to Order tab', 'Total Saving (EUR)',
    ],
    ['ORDER-A', '100', '200', '300', 'https://order/a', '30.005'],
    ['ORDER-B', '0', '50.25', '50.25', 'https://order/b', '5.125'],
    ['Total', '100', '250.25', '350.25', '', '35.13'],
  ]);
}

function clone(rowsToClone: RawRow[]): RawRow[] {
  return rowsToClone.map((entry) => ({ ...entry, cells: [...entry.cells] }));
}

describe('reconcileReportSource', () => {
  it('reconciles serial monthly values and a partial July order header', () => {
    expect(() => reconcileReportSource(rows, monthly(), orders())).not.toThrow();
  });

  it.each([
    ['monthly Spend', () => { const value = monthly(); value[1]!.cells[1] = '101'; return [value, orders()] as const; }],
    ['monthly Saving', () => { const value = monthly(); value[1]!.cells[2] = '11'; return [value, orders()] as const; }],
    ['order monthly Spend', () => { const value = orders(); value[1]!.cells[1] = '101'; return [monthly(), value] as const; }],
    ['order Total Spend', () => { const value = orders(); value[1]!.cells[3] = '301'; return [monthly(), value] as const; }],
    ['order Total Saving', () => { const value = orders(); value[1]!.cells[5] = '31'; return [monthly(), value] as const; }],
  ])('rejects a mismatched %s value', (_name, mutate) => {
    const [monthlyRows, orderRows] = mutate();
    expect(() => reconcileReportSource(rows, monthlyRows, orderRows)).toThrow(ReportReconciliationError);
  });

  it('rejects missing or unexpected keys and missing or duplicate Total rows', () => {
    const missingMonth = monthly().filter((entry) => entry.cells[0] !== '46204');
    expect(() => reconcileReportSource(rows, missingMonth, orders())).toThrow('missing Month 2026-07');

    const unexpectedOrder = orders();
    unexpectedOrder.splice(3, 0, { row_index: 4, cells: ['ORDER-X', '0', '0', '0', '', '0'] });
    expect(() => reconcileReportSource(rows, monthly(), unexpectedOrder)).toThrow('unexpected Order ORDER-X');

    const unexpectedMonth = monthly();
    unexpectedMonth.splice(3, 0, { row_index: 4, cells: ['46235', '0', '0'] });
    expect(() => reconcileReportSource(rows, unexpectedMonth, orders())).toThrow('unexpected Month 2026-08');

    expect(() => reconcileReportSource(rows, monthly().filter((entry) => entry.cells[0] !== 'Total'), orders())).toThrow('monthly summary is missing Total row');

    const duplicateOrderTotal = clone(orders());
    duplicateOrderTotal.push({ row_index: 5, cells: [...duplicateOrderTotal[3]!.cells] });
    expect(() => reconcileReportSource(rows, monthly(), duplicateOrderTotal)).toThrow('order summary has duplicate Total row');
  });

  it('rejects total/detail disagreement and invalid or duplicate order month headers', () => {
    const badMonthlyTotal = monthly();
    badMonthlyTotal[3]!.cells[1] = '351';
    expect(() => reconcileReportSource(rows, badMonthlyTotal, orders())).toThrow('monthly summary Total row Spend mismatch');

    const badOrderTotal = orders();
    badOrderTotal[3]!.cells[3] = '351';
    expect(() => reconcileReportSource(rows, monthly(), badOrderTotal)).toThrow('order summary Total row Total Spend mismatch');

    const duplicateHeader = orders();
    duplicateHeader[0]!.cells[2] = 'January 2026 Spend (EUR)';
    expect(() => reconcileReportSource(rows, monthly(), duplicateHeader)).toThrow('duplicate Month 2026-01');

    const oldHeader = orders();
    oldHeader[0]!.cells[1] = 'January 2025 Spend (EUR)';
    expect(() => reconcileReportSource(rows, monthly(), oldHeader)).toThrow('non-2026 month Spend header');
  });
});
