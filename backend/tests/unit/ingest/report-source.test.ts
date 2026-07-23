import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readReportSource,
  ReportSourceError,
} from '../../../src/pipeline/ingest/report-source.js';
import { adaptSheet } from '../../../src/pipeline/ingest/sheet-adapter.js';
import { sourceRowKey } from '../../../src/pipeline/normalize/source-row-key.js';
import type { ReportSourceConfig, SheetEntry } from '../../../src/shared/contracts.js';
import { FixtureGws } from '../../fixtures/gws/FixtureGws.js';

const REPORT_CONFIG: ReportSourceConfig = {
  spreadsheet_id: 'REPORT_2026',
  data_tab: 'Clean Data',
  monthly_summary_tab: 'Monthly Spending',
  order_summary_tab: 'Order Summary',
  reporting_year: 2026,
  headers: {
    order: 'Order',
    source_tab: 'Source Tab',
    source_row: 'Source Row',
    invoice_date: 'Invoice Date',
    reporting_month: 'Month',
    link_builder: 'Link Builder',
    website: 'Website',
    spend_eur: 'Price (EUR)',
    invoice_url: 'Invoice',
    invoice_status: 'Invoice Status',
    included: 'Included in Reporting Period',
    data_quality_issue: 'Data Quality Issue',
    savings_eur: 'Saving (EUR)',
  },
};

type FixtureFile = { rows: unknown[][]; unformatted_rows?: unknown[][] };

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function reportFixture(
  mutate?: (clean: FixtureFile) => void,
): { gws: FixtureGws; clean: FixtureFile } {
  const root = mkdtempSync(resolve(tmpdir(), 'report-source-'));
  tempRoots.push(root);
  const source = resolve(import.meta.dirname, '../../fixtures/sheets/REPORT_2026');
  const clean = JSON.parse(readFileSync(resolve(source, 'Clean Data.json'), 'utf8')) as FixtureFile;
  mutate?.(clean);
  const reportDir = resolve(root, 'REPORT_2026');
  mkdirSync(reportDir, { recursive: true });
  // FixtureGws only needs ordinary JSON files, which keeps every invalid
  // fixture local to the test that exercises it.
  writeFileSync(resolve(root, 'REPORT_2026', '__tabs.json'), readFileSync(resolve(source, '__tabs.json')));
  writeFileSync(resolve(root, 'REPORT_2026', 'Clean Data.json'), JSON.stringify(clean));
  writeFileSync(resolve(root, 'REPORT_2026', 'Monthly Spending.json'), readFileSync(resolve(source, 'Monthly Spending.json')));
  writeFileSync(resolve(root, 'REPORT_2026', 'Order Summary.json'), readFileSync(resolve(source, 'Order Summary.json')));
  return { gws: new FixtureGws({ fixturesRoot: root }), clean };
}

describe('readReportSource', () => {
  it('keeps legacy adapter rows explicit about zero savings', () => {
    const sheet: SheetEntry = {
      spreadsheet_id: 'LEGACY',
      order_code: 'ORDER-LEGACY',
      tabs: ['January'],
      column_mapping: { status: 'A', price: 'B' },
    };
    const [row] = adaptSheet(sheet, 'January', undefined, [{
      row_index: 2,
      cells: ['Done', '100'],
    }]);
    expect(row).toMatchObject({ savings_eur: 0, source_mode: 'legacy' });
  });

  it('reads only included 2026 rows with raw savings precision and raw summaries', async () => {
    const { gws } = reportFixture();
    const calls: Array<{ tab: string; option: string | undefined }> = [];
    const original = gws.pullSheetRange.bind(gws);
    gws.pullSheetRange = async (id, tab, range, options) => {
      calls.push({ tab, option: options?.valueRenderOption });
      return original(id, tab, range, options);
    };

    const batch = await readReportSource(REPORT_CONFIG, gws);

    expect(batch.rows.every((row) => row.invoice_date?.startsWith('2026-'))).toBe(true);
    expect(batch.rows.map((row) => row.order_code)).toEqual(['ORDER-A', 'ORDER-A', 'ORDER-B']);
    expect(batch.rows[0]?.savings_eur).toBe(10.005);
    expect(batch.rows[0]).toMatchObject({
      status: 'Done',
      currency: 'EUR',
      invoice_status: 'Paid',
      tab_name: 'January 2026',
      row_index: 5,
      source_mode: 'report',
    });
    expect(batch.rows[0]?.source_row_key).toBe(sourceRowKey(
      'REPORT_2026',
      'Clean Data',
      4,
      ['ORDER-A', 'January 2026', '5', '15/01/2026', 'January 2026', 'Ada', 'alpha.example', '€100.00', 'https://invoice/a-jan', 'Paid', 'TRUE', '', '€10.01'],
    ));
    expect(batch.monthlySummary[1]?.cells).toEqual(['January 2026', '100', '10.005']);
    expect(batch.orderSummary[1]?.cells).toEqual(['ORDER-A', '300', '30.005']);
    expect(batch.sourceStatus).toMatchObject({ status: 'success', rows_pulled: 3 });
    expect(calls).toEqual([
      { tab: 'Clean Data', option: 'FORMATTED_VALUE' },
      { tab: 'Clean Data', option: 'UNFORMATTED_VALUE' },
      { tab: 'Monthly Spending', option: 'UNFORMATTED_VALUE' },
      { tab: 'Order Summary', option: 'UNFORMATTED_VALUE' },
    ]);
  });

  it('fails for missing or duplicate required headers', async () => {
    const missing = reportFixture((clean) => { clean.rows[0]![0] = 'Order Code'; });
    await expect(readReportSource(REPORT_CONFIG, missing.gws)).rejects.toThrow('missing required header Order');

    const duplicate = reportFixture((clean) => { clean.rows[0]!.push('Order'); });
    await expect(readReportSource(REPORT_CONFIG, duplicate.gws)).rejects.toThrow('duplicate required header Order');
  });

  it('fails when paired formatted and unformatted rows are misaligned', async () => {
    const { gws } = reportFixture();
    const original = gws.pullSheetRange.bind(gws);
    gws.pullSheetRange = async (id, tab, range, options) => {
      const rows = await original(id, tab, range, options);
      if (tab === 'Clean Data' && options?.valueRenderOption === 'UNFORMATTED_VALUE') {
        return rows.slice(0, -1);
      }
      return rows;
    };
    await expect(readReportSource(REPORT_CONFIG, gws)).rejects.toThrow('formatted/unformatted row count mismatch');
  });

  it('fails for an included undated row, invalid 2026 money, and a month mismatch', async () => {
    const undated = reportFixture((clean) => { clean.rows[7]![10] = 'TRUE'; });
    await expect(readReportSource(REPORT_CONFIG, undated.gws)).rejects.toThrow('invalid or missing Invoice Date');

    const invalidSpend = reportFixture((clean) => { clean.unformatted_rows![3]![7] = 'not-a-number'; });
    await expect(readReportSource(REPORT_CONFIG, invalidSpend.gws)).rejects.toThrow('invalid Price (EUR)');

    const invalidSavings = reportFixture((clean) => { clean.unformatted_rows![3]![12] = 'Infinity'; });
    await expect(readReportSource(REPORT_CONFIG, invalidSavings.gws)).rejects.toThrow('invalid Saving (EUR)');

    const monthMismatch = reportFixture((clean) => { clean.rows[3]![4] = 'February 2026'; });
    await expect(readReportSource(REPORT_CONFIG, monthMismatch.gws)).rejects.toThrow('Month does not match Invoice Date');
  });

  it('fails for a blank order, invalid source row, or duplicate source identity', async () => {
    const blankOrder = reportFixture((clean) => { clean.rows[3]![0] = ''; });
    await expect(readReportSource(REPORT_CONFIG, blankOrder.gws)).rejects.toThrow('blank Order');

    const invalidSourceRow = reportFixture((clean) => { clean.rows[3]![2] = '5.5'; });
    await expect(readReportSource(REPORT_CONFIG, invalidSourceRow.gws)).rejects.toThrow('invalid Source Row');

    const duplicateIdentity = reportFixture((clean) => {
      clean.rows[4]![1] = 'January 2026';
      clean.rows[4]![2] = '5';
    });
    await expect(readReportSource(REPORT_CONFIG, duplicateIdentity.gws)).rejects.toThrow('duplicate source identity');
  });

  it('enforces the 5,000 data-row cap before parsing report data', async () => {
    const { gws, clean } = reportFixture((fixture) => {
      const data = fixture.rows[3]!;
      while (fixture.rows.length <= 5_001) fixture.rows.push([...data]);
      while (fixture.unformatted_rows!.length <= 5_001) fixture.unformatted_rows!.push([...fixture.unformatted_rows![3]!]);
    });
    const formattedRows = clean.rows.map((cells, idx) => ({ row_index: idx + 1, cells: cells.map(String) }));
    gws.pullSheetRange = async (_id, tab) => {
      if (tab === 'Clean Data') return formattedRows;
      return [];
    };
    await expect(readReportSource(REPORT_CONFIG, gws)).rejects.toThrow('exceeds 5000 data rows');
  });

  it('throws the explicit reader error when efficient range reads are unavailable', async () => {
    const { gws } = reportFixture();
    const withoutRange = { ...gws, pullSheetRange: undefined } as unknown as typeof gws;
    await expect(readReportSource(REPORT_CONFIG, withoutRange)).rejects.toBeInstanceOf(ReportSourceError);
  });
});
