/** Reconcile the executive workbook's two source-of-truth summary layouts. */

import type { NormalizedRow } from '../normalize/index.js';
import { parseDateCell } from '../normalize/date-resolution.js';
import type { RawRow } from './gws.js';

const TOLERANCE = 0.0051;
const START = '2026-01-01';
const END = '2027-01-01';

type Aggregate = { spend: number; savings: number };
type OrderAggregate = Aggregate & { months: Map<string, number> };

export class ReportReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportReconciliationError';
  }
}

/**
 * Reconcile normalized Clean Data against the live Monthly Spending and Order
 * Summary layouts. Both sheets are UNFORMATTED_VALUE reads, so all arithmetic
 * retains source precision rather than display-rounded currency strings.
 */
export function reconcileReportSource(
  rows: readonly NormalizedRow[],
  monthly: readonly RawRow[],
  orders: readonly RawRow[],
): void {
  const expectedByMonth = new Map<string, Aggregate>();
  const expectedByOrder = new Map<string, OrderAggregate>();

  for (const row of rows) {
    if (!isEligible2026NormalizedRow(row)) continue;
    const month = row.invoice_month!;
    const spend = rawReportSpend(row);
    addAggregate(expectedByMonth, month, spend, row.savings_eur);

    const order = expectedByOrder.get(row.order_code) ?? {
      spend: 0,
      savings: 0,
      months: new Map<string, number>(),
    };
    order.spend += spend;
    order.savings += row.savings_eur;
    order.months.set(month, (order.months.get(month) ?? 0) + spend);
    expectedByOrder.set(row.order_code, order);
  }

  reconcileMonthly(monthly, expectedByMonth);
  reconcileOrders(orders, expectedByMonth, expectedByOrder);
}

function reconcileMonthly(rows: readonly RawRow[], expected: Map<string, Aggregate>): void {
  const header = requireHeader(rows, 'monthly');
  const monthColumn = exactHeaderIndex(header.cells, 'Month', 'monthly');
  const spendColumn = exactHeaderIndex(header.cells, 'Spend (EUR)', 'monthly');
  const savingsColumn = exactHeaderIndex(header.cells, 'Saving (EUR)', 'monthly');
  const actual = new Map<string, Aggregate>();
  let total: Aggregate | undefined;

  for (const row of rows.slice(1)) {
    if (isBlankRow(row)) continue;
    const key = cell(row, monthColumn).trim();
    const aggregate = {
      spend: parseNumber(cell(row, spendColumn), 'monthly', row.row_index, 'Spend'),
      savings: parseNumber(cell(row, savingsColumn), 'monthly', row.row_index, 'Saving'),
    };
    if (isTotalKey(key)) {
      if (total !== undefined) throw new ReportReconciliationError('monthly summary has duplicate Total row');
      total = aggregate;
      continue;
    }
    const month = normalizeSheetMonth(key, row.row_index);
    if (actual.has(month)) throw new ReportReconciliationError(`monthly summary has duplicate Month ${month}`);
    actual.set(month, aggregate);
  }

  requireOneTotal('monthly', total);
  assertExactKeys('monthly', 'Month', expected, actual);
  for (const [month, expectedAggregate] of expected) {
    assertAggregate('monthly', month, expectedAggregate, actual.get(month)!);
  }
  const detailTotal = sumAggregates(actual.values());
  assertAggregate('monthly', 'detail rows', sumAggregates(expected.values()), detailTotal);
  assertAggregate('monthly', 'Total row', detailTotal, total!);
}

function reconcileOrders(
  rows: readonly RawRow[],
  expectedByMonth: Map<string, Aggregate>,
  expectedByOrder: Map<string, OrderAggregate>,
): void {
  const header = requireHeader(rows, 'order');
  const orderColumn = exactHeaderIndex(header.cells, 'Order', 'order');
  const savingsColumn = exactHeaderIndex(header.cells, 'Total Saving (EUR)', 'order');
  const totalSpendColumn = totalSpendHeaderIndex(header.cells);
  const monthColumns = discoverOrderMonthColumns(header.cells);
  assertExactKeys('order', 'Month', expectedByMonth, monthColumns);

  const actual = new Map<string, OrderAggregate>();
  let total: OrderAggregate | undefined;
  for (const row of rows.slice(1)) {
    if (isBlankRow(row)) continue;
    const key = cell(row, orderColumn).trim();
    const months = new Map<string, number>();
    for (const [month, column] of monthColumns) {
      months.set(month, parseNumber(cell(row, column), 'order', row.row_index, `${month} Spend`));
    }
    const aggregate: OrderAggregate = {
      months,
      spend: parseNumber(cell(row, totalSpendColumn), 'order', row.row_index, 'Total Spend'),
      savings: parseNumber(cell(row, savingsColumn), 'order', row.row_index, 'Total Saving'),
    };
    if (isTotalKey(key)) {
      if (total !== undefined) throw new ReportReconciliationError('order summary has duplicate Total row');
      total = aggregate;
      continue;
    }
    if (key.length === 0) throw new ReportReconciliationError(`order summary row ${row.row_index} has a blank Order`);
    if (actual.has(key)) throw new ReportReconciliationError(`order summary has duplicate Order ${key}`);
    actual.set(key, aggregate);
  }

  requireOneTotal('order', total);
  assertExactKeys('order', 'Order', expectedByOrder, actual);
  for (const [order, expected] of expectedByOrder) {
    const actualOrder = actual.get(order)!;
    for (const month of monthColumns.keys()) {
      assertNear('order', `${order} ${month}`, 'Spend', expected.months.get(month) ?? 0, actualOrder.months.get(month)!);
    }
    assertNear('order', `${order}`, 'Total Spend', expected.spend, actualOrder.spend);
    assertNear('order', `${order}`, 'Total Saving', expected.savings, actualOrder.savings);
    assertNear('order', `${order}`, 'monthly Spend sum', sumNumbers(actualOrder.months.values()), actualOrder.spend);
  }

  const detailTotal = sumOrderAggregates(actual.values(), monthColumns.keys());
  const expectedTotal = sumOrderAggregates(expectedByOrder.values(), monthColumns.keys());
  for (const month of monthColumns.keys()) {
    assertNear('order', `detail rows ${month}`, 'Spend', expectedByMonth.get(month)!.spend, detailTotal.months.get(month)!);
    assertNear('order', `Total row ${month}`, 'Spend', detailTotal.months.get(month)!, total!.months.get(month)!);
  }
  assertNear('order', 'detail rows', 'Total Spend', expectedTotal.spend, detailTotal.spend);
  assertNear('order', 'detail rows', 'Total Saving', expectedTotal.savings, detailTotal.savings);
  assertNear('order', 'Total row', 'Total Spend', detailTotal.spend, total!.spend);
  assertNear('order', 'Total row', 'Total Saving', detailTotal.savings, total!.savings);
}

function requireHeader(rows: readonly RawRow[], kind: 'monthly' | 'order'): RawRow {
  const header = rows[0];
  if (header === undefined) throw new ReportReconciliationError(`${kind} summary has no header row`);
  return header;
}

function discoverOrderMonthColumns(cells: readonly string[]): Map<string, number> {
  const columns = new Map<string, number>();
  for (let index = 0; index < cells.length; index += 1) {
    const header = cells[index]!.trim();
    if (!header.endsWith('Spend (EUR)')) continue;
    const month = normalizeOrderMonthHeader(header);
    if (columns.has(month)) throw new ReportReconciliationError(`order summary has duplicate Month ${month}`);
    columns.set(month, index);
  }
  if (columns.size === 0) throw new ReportReconciliationError('order summary has no month Spend headers');
  return columns;
}

function normalizeOrderMonthHeader(header: string): string {
  const match = /^(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+\d{1,2}(?:-\d{1,2})?,?)?\s+(\d{4})\s+Spend \(EUR\)$/.exec(header);
  if (match === null) throw new ReportReconciliationError(`order summary has invalid month Spend header ${header}`);
  const year = Number(match[2]!);
  if (year !== 2026) throw new ReportReconciliationError(`order summary has non-2026 month Spend header ${header}`);
  const month = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ].indexOf(match[1]!) + 1;
  return `2026-${String(month).padStart(2, '0')}`;
}

function totalSpendHeaderIndex(cells: readonly string[]): number {
  const matches = cells.reduce<number[]>((found, header, index) => {
    if (/^Total Spend\b/.test(header.trim())) found.push(index);
    return found;
  }, []);
  if (matches.length !== 1) {
    const reason = matches.length === 0 ? 'missing' : 'duplicate';
    throw new ReportReconciliationError(`order summary ${reason} Total Spend header`);
  }
  return matches[0]!;
}

function exactHeaderIndex(cells: readonly string[], expected: string, kind: string): number {
  const matches = cells.reduce<number[]>((found, header, index) => {
    if (header === expected) found.push(index);
    return found;
  }, []);
  if (matches.length !== 1) {
    const reason = matches.length === 0 ? 'missing' : 'duplicate';
    throw new ReportReconciliationError(`${kind} summary ${reason} required header ${expected}`);
  }
  return matches[0]!;
}

function normalizeSheetMonth(value: string, rowIndex: number): string {
  const date = parseDateCell(value);
  if (date === null || date < START || date >= END) {
    throw new ReportReconciliationError(`monthly summary row ${rowIndex} has invalid Month ${value}`);
  }
  return date.slice(0, 7);
}

function isEligible2026NormalizedRow(row: NormalizedRow): boolean {
  return row.is_done && row.invoice_date !== null && row.invoice_month !== null &&
    row.invoice_date >= START && row.invoice_date < END;
}

function rawReportSpend(row: NormalizedRow): number {
  const amount = row.native_currency === 'EUR' ? row.native_amount : row.eur_amount;
  if (amount === null || !Number.isFinite(amount) || !Number.isFinite(row.savings_eur)) {
    throw new ReportReconciliationError(`normalized report row ${row.source_row_key} has invalid raw values`);
  }
  return amount;
}

function addAggregate(target: Map<string, Aggregate>, key: string, spend: number, savings: number): void {
  const aggregate = target.get(key) ?? { spend: 0, savings: 0 };
  aggregate.spend += spend;
  aggregate.savings += savings;
  target.set(key, aggregate);
}

function requireOneTotal(kind: string, total: Aggregate | undefined): void {
  if (total === undefined) throw new ReportReconciliationError(`${kind} summary is missing Total row`);
}

function assertExactKeys<T>(
  kind: string,
  label: string,
  expected: Map<string, T>,
  actual: Map<string, unknown>,
): void {
  for (const key of expected.keys()) {
    if (!actual.has(key)) throw new ReportReconciliationError(`${kind} summary is missing ${label} ${key}`);
  }
  for (const key of actual.keys()) {
    if (!expected.has(key)) throw new ReportReconciliationError(`${kind} summary has unexpected ${label} ${key}`);
  }
}

function parseNumber(value: string, kind: string, rowIndex: number, label: string): number {
  const parsed = Number(value.trim());
  if (value.trim().length === 0 || !Number.isFinite(parsed)) {
    throw new ReportReconciliationError(`${kind} summary row ${rowIndex} has invalid ${label} (EUR)`);
  }
  return parsed;
}

function assertAggregate(kind: string, label: string, expected: Aggregate, actual: Aggregate): void {
  assertNear(kind, label, 'Spend', expected.spend, actual.spend);
  assertNear(kind, label, 'Saving', expected.savings, actual.savings);
}

function assertNear(kind: string, label: string, field: string, expected: number, actual: number): void {
  if (Math.abs(expected - actual) > TOLERANCE) {
    throw new ReportReconciliationError(`${kind} summary ${label} ${field} mismatch: expected ${expected}, got ${actual}`);
  }
}

function sumAggregates(values: Iterable<Aggregate>): Aggregate {
  let spend = 0;
  let savings = 0;
  for (const value of values) {
    spend += value.spend;
    savings += value.savings;
  }
  return { spend, savings };
}

function sumOrderAggregates(values: Iterable<OrderAggregate>, months: Iterable<string>): OrderAggregate {
  const result: OrderAggregate = { spend: 0, savings: 0, months: new Map() };
  const monthList = [...months];
  for (const value of values) {
    result.spend += value.spend;
    result.savings += value.savings;
    for (const month of monthList) {
      result.months.set(month, (result.months.get(month) ?? 0) + (value.months.get(month) ?? 0));
    }
  }
  return result;
}

function sumNumbers(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function cell(row: RawRow, index: number): string {
  return row.cells[index] ?? '';
}

function isTotalKey(value: string): boolean {
  return value.toLowerCase() === 'total';
}

function isBlankRow(row: RawRow): boolean {
  return row.cells.every((value) => value.trim().length === 0);
}
