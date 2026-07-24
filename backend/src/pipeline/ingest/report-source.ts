/**
 * Strict reader for the executive 2026 workbook.
 *
 * Clean Data is read twice: formatted cells retain operator-facing text and
 * provenance, while unformatted cells preserve the full source precision of
 * Spend and Savings. This module intentionally stops at ingestion; report
 * reconciliation and pipeline wiring are separate checkpoints.
 */

import type { ReportSourceConfig } from '../../shared/contracts.js';
import type { PerSourceStatus } from '../../shared/contracts.js';
import {
  detectNumericDateOrder,
  parseDateCell,
  type NumericDateOrder,
} from '../normalize/date-resolution.js';
import { isDashboardEligibleRow } from '../normalize/index.js';
import { sourceRowKey } from '../normalize/source-row-key.js';
import type { AdapterRow } from './sheet-adapter.js';
import type { GwsWrapper, RawRow } from './gws.js';

const REPORT_RANGE = 'A1:Z5001';
// Start the probe inside the sheet grid. Google rejects a range whose first
// row is beyond the current grid size, even though a larger end row is safe.
const OVERFLOW_PROBE_RANGE = 'A1:Z5002';
const MAX_DATA_ROWS = 5_000;

export interface ReportSourceBatch {
  rows: AdapterRow[];
  monthlySummary: RawRow[];
  orderSummary: RawRow[];
  sourceStatus: PerSourceStatus;
}

export class ReportSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportSourceError';
  }
}

/** Read and validate the report source without wiring it into consolidation. */
export async function readReportSource(
  config: ReportSourceConfig,
  gws: GwsWrapper,
): Promise<ReportSourceBatch> {
  if (gws.pullSheetRange === undefined) {
    throw new ReportSourceError('report source requires GwsWrapper.pullSheetRange');
  }

  const [formattedRows, unformattedRows, monthlySummary, orderSummary, overflowRows] = await Promise.all([
    gws.pullSheetRange(config.spreadsheet_id, config.data_tab, REPORT_RANGE, {
      valueRenderOption: 'FORMATTED_VALUE',
    }),
    gws.pullSheetRange(config.spreadsheet_id, config.data_tab, REPORT_RANGE, {
      valueRenderOption: 'UNFORMATTED_VALUE',
    }),
    gws.pullSheetRange(config.spreadsheet_id, config.monthly_summary_tab, REPORT_RANGE, {
      valueRenderOption: 'UNFORMATTED_VALUE',
    }),
    gws.pullSheetRange(config.spreadsheet_id, config.order_summary_tab, REPORT_RANGE, {
      valueRenderOption: 'UNFORMATTED_VALUE',
    }),
    gws.pullSheetRange(config.spreadsheet_id, config.data_tab, OVERFLOW_PROBE_RANGE, {
      valueRenderOption: 'FORMATTED_VALUE',
    }),
  ]);

  validatePairAlignment(formattedRows, unformattedRows, config.data_tab);
  if (formattedRows.length === 0) {
    throw new ReportSourceError(`report data tab ${config.data_tab} has no header row`);
  }
  if (formattedRows.length - 1 > MAX_DATA_ROWS) {
    throw new ReportSourceError(`report data tab exceeds ${MAX_DATA_ROWS} data rows`);
  }

  const columns = resolveRequiredColumns(formattedRows[0]!.cells, config);
  validatePairIdentities(formattedRows, unformattedRows, columns);
  if (overflowRows.some((row) => row.row_index > MAX_DATA_ROWS + 1 && hasNonBlankCell(row))) {
    throw new ReportSourceError(`report data tab exceeds ${MAX_DATA_ROWS} data rows`);
  }

  const rows: AdapterRow[] = [];
  const seenSourceIdentities = new Set<string>();
  const numericDateOrders = inferNumericDateOrders(formattedRows, columns);

  for (let index = 1; index < formattedRows.length; index += 1) {
    const formatted = formattedRows[index]!;
    const unformatted = unformattedRows[index]!;
    const included = formattedCell(formatted, columns.included);
    if (included !== 'TRUE') continue;

    const invoiceDate = parseDateCell(
      formattedCell(formatted, columns.invoice_date),
      numericDateOrders.get(sourceGroupKey(formatted, columns)) ?? 'ambiguous',
    );
    if (invoiceDate === null) {
      throw rowError(formatted, 'included row has an invalid or missing Invoice Date');
    }
    if (!isDashboardEligibleRow({ status: 'Done', invoice_date: invoiceDate })) continue;

    const orderCode = formattedCell(formatted, columns.order).trim();
    if (orderCode.length === 0) throw rowError(formatted, 'included 2026 row has a blank Order');

    const sourceTab = formattedCell(formatted, columns.source_tab).trim();
    if (sourceTab.length === 0) throw rowError(formatted, 'included 2026 row has a blank Source Tab');
    const sourceRow = parseSourceRow(formattedCell(formatted, columns.source_row));
    if (sourceRow === null) throw rowError(formatted, 'included 2026 row has an invalid Source Row');

    const sourceIdentity = `${orderCode}\u001f${sourceTab}\u001f${sourceRow}`;
    if (seenSourceIdentities.has(sourceIdentity)) {
      throw rowError(formatted, `duplicate source identity ${sourceTab}/${sourceRow}`);
    }
    seenSourceIdentities.add(sourceIdentity);

    const spend = parseRawMoney(unformattedCell(unformatted, columns.spend_eur));
    if (spend === null) throw rowError(formatted, 'included 2026 row has invalid Price (EUR)');
    const rawSavings = unformattedCell(unformatted, columns.savings_eur);
    // The executive report intentionally leaves Savings blank when there is
    // no comparison price. Its summary formulas treat those cells as zero.
    const savings = rawSavings.trim().length === 0 ? 0 : parseRawMoney(rawSavings);
    if (savings === null) throw rowError(formatted, 'included 2026 row has invalid Saving (EUR)');

    const reportingMonth = parseReportingMonth(formattedCell(formatted, columns.reporting_month));
    if (reportingMonth === null || reportingMonth !== invoiceDate.slice(0, 7)) {
      throw rowError(formatted, `Month does not match Invoice Date ${invoiceDate}`);
    }

    rows.push({
      spreadsheet_id: config.spreadsheet_id,
      order_code: orderCode,
      // The executive tab/row identifies a report record, but provenance shown
      // to an operator remains the original source tab and source row.
      tab_name: sourceTab,
      tab_name_raw: sourceTab,
      row_index: sourceRow,
      source_row_key: sourceRowKey(
        config.spreadsheet_id,
        config.data_tab,
        formatted.row_index,
        formatted.cells,
      ),
      status: 'Done',
      website: formattedCell(formatted, columns.website),
      price: String(spend),
      currency: 'EUR',
      invoice_date: invoiceDate,
      invoice_url: formattedCell(formatted, columns.invoice_url),
      invoice_status: formattedCell(formatted, columns.invoice_status),
      savings_eur: savings,
      source_mode: 'report',
      data_quality_issue: formattedCell(formatted, columns.data_quality_issue),
      link_builder: formattedCell(formatted, columns.link_builder),
      target_url: undefined,
      anchor: undefined,
      live_url: formattedCell(formatted, columns.live_url),
    });
  }

  return {
    rows,
    monthlySummary,
    orderSummary,
    sourceStatus: {
      spreadsheet_id: config.spreadsheet_id,
      order_code: '2026 Spending Report',
      status: 'success',
      rows_pulled: rows.length,
    },
  };
}

function resolveRequiredColumns(
  headerRow: readonly string[],
  config: ReportSourceConfig,
): Record<keyof ReportSourceConfig['headers'], number> {
  const resolved = {} as Record<keyof ReportSourceConfig['headers'], number>;
  const configuredNames = new Set<string>();

  for (const [field, headerName] of Object.entries(config.headers) as Array<
    [keyof ReportSourceConfig['headers'], string]
  >) {
    if (configuredNames.has(headerName)) {
      throw new ReportSourceError(`required header ${headerName} is configured more than once`);
    }
    configuredNames.add(headerName);
    const matches: number[] = [];
    for (let i = 0; i < headerRow.length; i += 1) {
      if (headerRow[i] === headerName) matches.push(i);
    }
    if (matches.length !== 1) {
      const reason = matches.length === 0 ? 'missing' : 'duplicate';
      throw new ReportSourceError(`${reason} required header ${headerName}`);
    }
    resolved[field] = matches[0]!;
  }
  return resolved;
}

function validatePairAlignment(formatted: RawRow[], unformatted: RawRow[], tab: string): void {
  if (formatted.length !== unformatted.length) {
    throw new ReportSourceError(
      `formatted/unformatted row count mismatch for ${tab}: ${formatted.length} vs ${unformatted.length}`,
    );
  }
  for (let i = 0; i < formatted.length; i += 1) {
    if (formatted[i]!.row_index !== unformatted[i]!.row_index) {
      throw new ReportSourceError(
        `formatted/unformatted row alignment mismatch for ${tab} at index ${i}`,
      );
    }
  }
}

function validatePairIdentities(
  formatted: RawRow[],
  unformatted: RawRow[],
  columns: Record<keyof ReportSourceConfig['headers'], number>,
): void {
  for (let i = 1; i < formatted.length; i += 1) {
    const formattedRow = formatted[i]!;
    const unformattedRow = unformatted[i]!;
    const formattedIdentity = pairedIdentity(formattedRow, columns);
    const unformattedIdentity = pairedIdentity(unformattedRow, columns);
    if (formattedIdentity !== unformattedIdentity) {
      throw new ReportSourceError(
        `formatted/unformatted identity mismatch for Clean Data row ${formattedRow.row_index}`,
      );
    }
  }
}

function pairedIdentity(
  row: RawRow,
  columns: Record<keyof ReportSourceConfig['headers'], number>,
): string {
  return [
    formattedCell(row, columns.order).trim(),
    formattedCell(row, columns.source_tab).trim(),
    normalizeIdentitySourceRow(formattedCell(row, columns.source_row)),
    formattedCell(row, columns.invoice_url).trim(),
  ].join('\u001f');
}

function normalizeIdentitySourceRow(value: string): string {
  const numeric = Number(value.trim());
  return Number.isSafeInteger(numeric) && numeric > 0 ? String(numeric) : value.trim();
}

function inferNumericDateOrders(
  rows: RawRow[],
  columns: Record<keyof ReportSourceConfig['headers'], number>,
): Map<string, NumericDateOrder> {
  const datesBySource = new Map<string, string[]>();
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (formattedCell(row, columns.included) !== 'TRUE') continue;
    const key = sourceGroupKey(row, columns);
    const dates = datesBySource.get(key) ?? [];
    dates.push(formattedCell(row, columns.invoice_date));
    datesBySource.set(key, dates);
  }
  return new Map([...datesBySource].map(([key, dates]) => [key, detectNumericDateOrder(dates)]));
}

function sourceGroupKey(
  row: RawRow,
  columns: Record<keyof ReportSourceConfig['headers'], number>,
): string {
  return `${formattedCell(row, columns.order).trim()}\u001f${formattedCell(row, columns.source_tab).trim()}`;
}

function hasNonBlankCell(row: RawRow): boolean {
  return row.cells.some((cell) => cell.trim().length > 0);
}

function formattedCell(row: RawRow, column: number): string {
  return row.cells[column] ?? '';
}

function unformattedCell(row: RawRow, column: number): string {
  return row.cells[column] ?? '';
}

function parseRawMoney(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSourceRow(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseReportingMonth(value: string): string | null {
  const trimmed = value.trim();
  const numeric = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(trimmed);
  if (numeric) return `${numeric[1]}-${numeric[2]}`;

  const numericWithDay = /^(\d{4})-(0[1-9]|1[0-2])-\d{1,2}$/.exec(trimmed);
  if (numericWithDay) return `${numericWithDay[1]}-${numericWithDay[2]}`;

  const named = /^(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(\d{4}))?$/i.exec(trimmed);
  if (!named) return null;
  const month = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ].indexOf(named[1]!.toLowerCase()) + 1;
  const year = named[2] ?? '2026';
  return `${year}-${String(month).padStart(2, '0')}`;
}

function rowError(row: RawRow, message: string): ReportSourceError {
  return new ReportSourceError(`Clean Data row ${row.row_index}: ${message}`);
}
