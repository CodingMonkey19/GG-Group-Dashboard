/**
 * Reconcile the executive workbook's summary tabs against Clean Data.
 *
 * Summary cells arrive through an UNFORMATTED_VALUE range read. Never use
 * operator-formatted currency strings here: Clean Data retains values such as
 * 10.005 that are valid source precision even when the sheet displays €10.01.
 */

import type { RawRow } from './gws.js';
import type { NormalizedRow } from '../normalize/index.js';
import { parseDateCell } from '../normalize/date-resolution.js';

const TOLERANCE = 0.0051;
const START = '2026-01-01';
const END = '2027-01-01';

type Aggregate = { spend: number; savings: number };
type SummaryKind = 'monthly' | 'order';

export class ReportReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportReconciliationError';
  }
}

/**
 * Assert that both executive summary surfaces exactly describe the eligible
 * normalized report rows. Throws before findings/counters/store publication.
 */
export function reconcileReportSource(
  rows: readonly NormalizedRow[],
  monthly: readonly RawRow[],
  orders: readonly RawRow[],
): void {
  const byMonth = aggregateRows(rows, (row) => row.invoice_month!);
  const byOrder = aggregateRows(rows, (row) => row.order_code);

  reconcileSurface(monthly, 'monthly', byMonth);
  reconcileSurface(orders, 'order', byOrder);
}

function aggregateRows(
  rows: readonly NormalizedRow[],
  keyOf: (row: NormalizedRow) => string,
): Map<string, Aggregate> {
  const totals = new Map<string, Aggregate>();
  for (const row of rows) {
    if (!isEligible2026NormalizedRow(row)) continue;
    const spend = rawReportSpend(row);
    const existing = totals.get(keyOf(row)) ?? { spend: 0, savings: 0 };
    existing.spend += spend;
    existing.savings += row.savings_eur;
    totals.set(keyOf(row), existing);
  }
  return totals;
}

function isEligible2026NormalizedRow(row: NormalizedRow): boolean {
  return row.is_done && row.invoice_date !== null &&
    row.invoice_date >= START && row.invoice_date < END && row.invoice_month !== null;
}

function rawReportSpend(row: NormalizedRow): number {
  // Report rows are EUR, and native_amount is the raw Clean Data number. The
  // converted amount may be display-rounded by the currency layer.
  const amount = row.native_currency === 'EUR' ? row.native_amount : row.eur_amount;
  if (amount === null || !Number.isFinite(amount)) {
    throw new ReportReconciliationError(
      `normalized report row ${row.source_row_key} has no reconcilable Spend value`,
    );
  }
  if (!Number.isFinite(row.savings_eur)) {
    throw new ReportReconciliationError(
      `normalized report row ${row.source_row_key} has no reconcilable Savings value`,
    );
  }
  return amount;
}

function reconcileSurface(
  rows: readonly RawRow[],
  kind: SummaryKind,
  expected: Map<string, Aggregate>,
): void {
  if (rows.length === 0) {
    throw new ReportReconciliationError(`${kind} summary has no header row`);
  }

  const keyHeader = kind === 'monthly' ? 'Month' : 'Order';
  const columns = resolveColumns(rows[0]!, keyHeader, kind);
  const actual = new Map<string, Aggregate>();
  const totalRows: Array<{ rowIndex: number; aggregate: Aggregate }> = [];

  for (const row of rows.slice(1)) {
    if (isBlankRow(row)) continue;
    const rawKey = cell(row, columns.key).trim();
    const aggregate = {
      spend: parseSummaryNumber(cell(row, columns.spend), kind, row.row_index, 'Spend'),
      savings: parseSummaryNumber(cell(row, columns.savings), kind, row.row_index, 'Savings'),
    };
    if (rawKey.toLowerCase() === 'total') {
      totalRows.push({ rowIndex: row.row_index, aggregate });
      continue;
    }
    const key = kind === 'monthly'
      ? normalizeSummaryMonth(rawKey, row.row_index)
      : rawKey;
    if (key.length === 0) {
      throw new ReportReconciliationError(`${kind} summary row ${row.row_index} has a blank ${keyHeader}`);
    }
    if (actual.has(key)) {
      throw new ReportReconciliationError(`${kind} summary has duplicate ${keyHeader} ${key}`);
    }
    actual.set(key, aggregate);
  }

  assertKeys(kind, keyHeader, expected, actual);
  for (const [key, expectedAggregate] of expected) {
    const actualAggregate = actual.get(key)!;
    assertAggregate(kind, key, expectedAggregate, actualAggregate);
  }

  const detailTotal = sumAggregates(actual.values());
  const expectedTotal = sumAggregates(expected.values());
  // This comparison is deliberately separate: it detects a malformed Total
  // even if a future change broadens the detail-key checks above.
  assertAggregate(kind, 'detail rows', expectedTotal, detailTotal);
  for (const total of totalRows) {
    assertAggregate(kind, `Total row ${total.rowIndex}`, detailTotal, total.aggregate);
  }
}

function resolveColumns(
  header: RawRow,
  keyHeader: string,
  kind: SummaryKind,
): { key: number; spend: number; savings: number } {
  return {
    key: exactHeaderIndex(header.cells, keyHeader, kind),
    spend: exactHeaderIndex(header.cells, 'Spend (EUR)', kind),
    savings: exactHeaderIndex(header.cells, 'Savings (EUR)', kind),
  };
}

function exactHeaderIndex(cells: readonly string[], expected: string, kind: SummaryKind): number {
  const matches: number[] = [];
  for (let index = 0; index < cells.length; index += 1) {
    if (cells[index] === expected) matches.push(index);
  }
  if (matches.length !== 1) {
    const reason = matches.length === 0 ? 'missing' : 'duplicate';
    throw new ReportReconciliationError(`${kind} summary ${reason} required header ${expected}`);
  }
  return matches[0]!;
}

function parseSummaryNumber(
  value: string,
  kind: SummaryKind,
  rowIndex: number,
  field: 'Spend' | 'Savings',
): number {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (trimmed.length === 0 || !Number.isFinite(parsed)) {
    throw new ReportReconciliationError(`${kind} summary row ${rowIndex} has invalid ${field} (EUR)`);
  }
  return parsed;
}

function normalizeSummaryMonth(value: string, rowIndex: number): string {
  const date = parseDateCell(value);
  if (date === null || date < START || date >= END) {
    throw new ReportReconciliationError(`monthly summary row ${rowIndex} has invalid Month ${value}`);
  }
  return date.slice(0, 7);
}

function assertKeys(
  kind: SummaryKind,
  keyHeader: string,
  expected: Map<string, Aggregate>,
  actual: Map<string, Aggregate>,
): void {
  for (const key of expected.keys()) {
    if (!actual.has(key)) {
      throw new ReportReconciliationError(`${kind} summary is missing ${keyHeader} ${key}`);
    }
  }
  for (const key of actual.keys()) {
    if (!expected.has(key)) {
      throw new ReportReconciliationError(`${kind} summary has unexpected ${keyHeader} ${key}`);
    }
  }
}

function assertAggregate(
  kind: SummaryKind,
  label: string,
  expected: Aggregate,
  actual: Aggregate,
): void {
  assertNear(kind, label, 'Spend', expected.spend, actual.spend);
  assertNear(kind, label, 'Savings', expected.savings, actual.savings);
}

function assertNear(
  kind: SummaryKind,
  label: string,
  field: 'Spend' | 'Savings',
  expected: number,
  actual: number,
): void {
  if (Math.abs(expected - actual) > TOLERANCE) {
    throw new ReportReconciliationError(
      `${kind} summary ${label} ${field} mismatch: expected ${expected}, got ${actual}`,
    );
  }
}

function sumAggregates(aggregates: Iterable<Aggregate>): Aggregate {
  let spend = 0;
  let savings = 0;
  for (const aggregate of aggregates) {
    spend += aggregate.spend;
    savings += aggregate.savings;
  }
  return { spend, savings };
}

function cell(row: RawRow, index: number): string {
  return row.cells[index] ?? '';
}

function isBlankRow(row: RawRow): boolean {
  return row.cells.every((value) => value.trim().length === 0);
}
