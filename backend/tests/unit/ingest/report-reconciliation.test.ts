import { describe, expect, it } from 'vitest';
import {
  reconcileReportSource,
  ReportReconciliationError,
} from '../../../src/pipeline/ingest/report-reconciliation.js';
import type { RawRow } from '../../../src/pipeline/ingest/gws.js';
import type { NormalizedRow } from '../../../src/pipeline/normalize/index.js';

const SERIALS = ['46023', '46054', '46082', '46113', '46143', '46174', '46204'];

function row(
  source_row_key: string,
  order_code: string,
  month: string,
  spend: number,
  savings: number,
): NormalizedRow {
  const invoice_date = `2026-${month}-15`;
  return {
    source_row_key, invoice_id: null, order_code, spreadsheet_id: 'REPORT_2026',
    tab_name: 'Clean Data', tab_name_raw: 'Clean Data', row_index: 2,
    work_status: 'Done', is_done: true, payment_status: 'paid', invoice_type: 'text',
    artifact_ref: 'receipt', artifact_status: 'not_attempted', artifact_unreachable_reason: null,
    website: null, website_raw: null, native_amount: spend, native_currency: 'EUR',
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
  row('0000000000000002', 'ORDER-A', '02', 200, 20),
  row('0000000000000003', 'ORDER-B', '02', 50.25, 5.125),
  row('0000000000000004', 'ORDER-A', '03', 110, 11),
  row('0000000000000005', 'ORDER-A', '04', 120, 12),
  row('0000000000000006', 'ORDER-A', '05', 130, 13),
  row('0000000000000007', 'ORDER-A', '06', 140, 14),
  row('0000000000000008', 'ORDER-A', '07', 150, 15),
  { ...row('0000000000000009', 'HISTORICAL', '01', 999, 99), invoice_date: '2025-12-31', invoice_month: '2025-12' },
];

function monthly(): RawRow[] {
  return sheet([
    ['Month', 'Spend (EUR)', 'Saving (EUR)'],
    [SERIALS[0]!, '100', '10.005'], [SERIALS[1]!, '250.25', '25.125'],
    [SERIALS[2]!, '110', '11'], [SERIALS[3]!, '120', '12'], [SERIALS[4]!, '130', '13'],
    [SERIALS[5]!, '140', '14'], [SERIALS[6]!, '150', '15'], ['Total', '1000.25', '100.13'],
  ]);
}

function orders(): RawRow[] {
  return sheet([
    [
      'Order', 'January 2026 Spend (EUR)', 'February 2026 Spend (EUR)', 'March 2026 Spend (EUR)',
      'April 2026 Spend (EUR)', 'May 2026 Spend (EUR)', 'June 2026 Spend (EUR)',
      'July 1-22, 2026 Spend (EUR)', 'Total Spend through July 22, 2026',
      'Link to Order tab', 'Total Saving (EUR)',
    ],
    ['ORDER-A', '100', '200', '110', '120', '130', '140', '150', '950', 'https://order/a', '95.005'],
    ['ORDER-B', '0', '50.25', '0', '0', '0', '0', '0', '50.25', 'https://order/b', '5.125'],
    ['Total', '100', '250.25', '110', '120', '130', '140', '150', '1000.25', '', '100.13'],
  ]);
}

function clone(rowsToClone: RawRow[]): RawRow[] {
  return rowsToClone.map((entry) => ({ ...entry, cells: [...entry.cells] }));
}

describe('reconcileReportSource', () => {
  it('reconciles serial monthly values and live order month headers including a partial July label', () => {
    expect(() => reconcileReportSource(rows, monthly(), orders())).not.toThrow();
  });

  it.each([
    ['monthly Spend', () => { const value = monthly(); value[1]!.cells[1] = '101'; return [value, orders()] as const; }],
    ['monthly Saving', () => { const value = monthly(); value[1]!.cells[2] = '11'; return [value, orders()] as const; }],
    ['order monthly Spend', () => { const value = orders(); value[1]!.cells[1] = '101'; return [monthly(), value] as const; }],
    ['order Total Spend', () => { const value = orders(); value[1]!.cells[8] = '951'; return [monthly(), value] as const; }],
    ['order Total Saving', () => { const value = orders(); value[1]!.cells[10] = '96'; return [monthly(), value] as const; }],
  ])('rejects a mismatched %s value', (_name, mutate) => {
    const [monthlyRows, orderRows] = mutate();
    expect(() => reconcileReportSource(rows, monthlyRows, orderRows)).toThrow(ReportReconciliationError);
  });

  it('rejects missing or unexpected keys and missing or duplicate Total rows', () => {
    const missingMonth = monthly().filter((entry) => entry.cells[0] !== SERIALS[2]);
    expect(() => reconcileReportSource(rows, missingMonth, orders())).toThrow('missing Month 2026-03');

    const unexpectedOrder = orders();
    unexpectedOrder.splice(3, 0, { row_index: 4, cells: ['ORDER-X', '0', '0', '0', '0', '0', '0', '0', '0', '', '0'] });
    expect(() => reconcileReportSource(rows, monthly(), unexpectedOrder)).toThrow('unexpected Order ORDER-X');

    const unexpectedMonth = monthly();
    unexpectedMonth.splice(8, 0, { row_index: 9, cells: ['46235', '0', '0'] });
    expect(() => reconcileReportSource(rows, unexpectedMonth, orders())).toThrow('unexpected Month 2026-08');

    const noMonthlyTotal = monthly().filter((entry) => entry.cells[0] !== 'Total');
    expect(() => reconcileReportSource(rows, noMonthlyTotal, orders())).toThrow('monthly summary is missing Total row');

    const duplicateOrderTotal = clone(orders());
    duplicateOrderTotal.push({ row_index: 5, cells: [...duplicateOrderTotal[3]!.cells] });
    expect(() => reconcileReportSource(rows, monthly(), duplicateOrderTotal)).toThrow('order summary has duplicate Total row');

    const noOrderTotal = orders().filter((entry) => entry.cells[0] !== 'Total');
    expect(() => reconcileReportSource(rows, monthly(), noOrderTotal)).toThrow('order summary is missing Total row');

    const duplicateMonthlyTotal = clone(monthly());
    duplicateMonthlyTotal.push({ row_index: 10, cells: [...duplicateMonthlyTotal[8]!.cells] });
    expect(() => reconcileReportSource(rows, duplicateMonthlyTotal, orders())).toThrow('monthly summary has duplicate Total row');
  });

  it('rejects total/detail disagreement and invalid or duplicate order month headers', () => {
    const badMonthlyTotal = monthly();
    badMonthlyTotal[8]!.cells[1] = '1001';
    expect(() => reconcileReportSource(rows, badMonthlyTotal, orders())).toThrow('monthly summary Total row Spend mismatch');

    const badOrderTotal = orders();
    badOrderTotal[3]!.cells[8] = '1001';
    expect(() => reconcileReportSource(rows, monthly(), badOrderTotal)).toThrow('order summary Total row Total Spend mismatch');

    const duplicateHeader = orders();
    duplicateHeader[0]!.cells[2] = 'January 2026 Spend (EUR)';
    expect(() => reconcileReportSource(rows, monthly(), duplicateHeader)).toThrow('duplicate Month 2026-01');

    const oldHeader = orders();
    oldHeader[0]!.cells[1] = 'January 2025 Spend (EUR)';
    expect(() => reconcileReportSource(rows, monthly(), oldHeader)).toThrow('non-2026 month Spend header');

    const invalidHeader = orders();
    invalidHeader[0]!.cells[1] = 'January-ish Spend (EUR)';
    expect(() => reconcileReportSource(rows, monthly(), invalidHeader)).toThrow('invalid month Spend header');
  });
});
