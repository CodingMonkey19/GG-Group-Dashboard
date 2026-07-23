import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { consolidate } from '../../src/pipeline/consolidate.js';
import { readReportSource } from '../../src/pipeline/ingest/report-source.js';
import { openStore } from '../../src/pipeline/store/db.js';
import { FixtureGws } from '../fixtures/gws/FixtureGws.js';

const FIXTURES_ROOT = resolve(import.meta.dirname, '../fixtures/sheets');

function reportConfig(): string {
  return JSON.stringify({
    schema_version: 1,
    report_source: {
      spreadsheet_id: 'REPORT_2026',
      data_tab: 'Clean Data',
      monthly_summary_tab: 'Monthly Spending',
      order_summary_tab: 'Order Summary',
      reporting_year: 2026,
      headers: {
        order: 'Order', source_tab: 'Source Tab', source_row: 'Source Row',
        invoice_date: 'Invoice Date', reporting_month: 'Month', link_builder: 'Link Builder',
        website: 'Website', spend_eur: 'Price (EUR)', invoice_url: 'Invoice',
        invoice_status: 'Invoice Status', included: 'Included in Reporting Period',
        data_quality_issue: 'Data Quality Issue', savings_eur: 'Saving (EUR)',
      },
    },
  });
}

function rawTotals(rows: Awaited<ReturnType<typeof readReportSource>>['rows']): Record<string, number> {
  const spend = rows.reduce((total, row) => total + Number(row.price), 0);
  const savings = rows.reduce((total, row) => total + row.savings_eur, 0);
  const january = rows.filter((row) => row.invoice_date?.slice(0, 7) === '2026-01');
  const february = rows.filter((row) => row.invoice_date?.slice(0, 7) === '2026-02');
  const orderA = rows.filter((row) => row.order_code === 'ORDER-A');
  const orderB = rows.filter((row) => row.order_code === 'ORDER-B');
  return {
    spend,
    savings,
    januarySpend: january.reduce((total, row) => total + Number(row.price), 0),
    januarySavings: january.reduce((total, row) => total + row.savings_eur, 0),
    februarySpend: february.reduce((total, row) => total + Number(row.price), 0),
    februarySavings: february.reduce((total, row) => total + row.savings_eur, 0),
    orderASpend: orderA.reduce((total, row) => total + Number(row.price), 0),
    orderASavings: orderA.reduce((total, row) => total + row.savings_eur, 0),
    orderBSpend: orderB.reduce((total, row) => total + Number(row.price), 0),
    orderBSavings: orderB.reduce((total, row) => total + row.savings_eur, 0),
    orderAJanuarySpend: Number(orderA.find((row) => row.invoice_date?.slice(0, 7) === '2026-01')?.price),
    orderAFebruarySpend: Number(orderA.find((row) => row.invoice_date?.slice(0, 7) === '2026-02')?.price),
    orderBFebruarySpend: Number(orderB.find((row) => row.invoice_date?.slice(0, 7) === '2026-02')?.price),
  };
}

describe('report source consolidation', () => {
  let dataDir: string;
  let configPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(resolve(tmpdir(), 'report-source-pipeline-'));
    configPath = resolve(dataDir, 'sheets.json');
    writeFileSync(configPath, reportConfig());
  });

  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('publishes only the three eligible 2026 rows and reconciles raw Spend/Savings', async () => {
    const gws = new FixtureGws({ fixturesRoot: FIXTURES_ROOT });
    const batch = await readReportSource(JSON.parse(reportConfig()).report_source, gws);
    expect(batch.rows).toHaveLength(3);
    const expectedTotals = {
      spend: 350.25, savings: 35.13,
      januarySpend: 100, januarySavings: 10.005,
      februarySpend: 250.25, februarySavings: 25.125,
      orderASpend: 300, orderASavings: 30.005,
      orderBSpend: 50.25, orderBSavings: 5.125,
      orderAJanuarySpend: 100, orderAFebruarySpend: 200, orderBFebruarySpend: 50.25,
    };
    for (const [key, expected] of Object.entries(expectedTotals)) {
      expect(rawTotals(batch.rows)[key]).toBeCloseTo(expected, 10);
    }

    const result = await consolidate({
      configPath, dataDir, pdfRoot: '/tmp/never-used', gwsFactory: () => gws,
      ecbSeeder: async () => {},
    });
    expect(result.status).toBe('success');
    expect(result.per_source).toEqual([{
      spreadsheet_id: 'REPORT_2026', order_code: '2026 Spending Report', status: 'success', rows_pulled: 3,
    }]);
    expect(result.counters).toMatchObject({ rows_total: 3, rows_done: 3, rows_undated: 0 });

    const db = openStore(resolve(dataDir, 'consolidated.sqlite'));
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM invoices').get()).toEqual({ count: 3 });
      const issue = db.prepare("SELECT audit_flags FROM invoices WHERE order_code='ORDER-B'").get() as { audit_flags: string };
      expect(JSON.parse(issue.audit_flags)).toContain('source_data_quality_issue:needs receipt');
      expect(db.prepare('SELECT COUNT(*) AS count FROM audit_findings').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('rejects a reconciliation mismatch, cleans staging, and preserves the prior live snapshot', async () => {
    const livePath = resolve(dataDir, 'consolidated.sqlite');
    const stagingPath = resolve(dataDir, 'consolidated.sqlite.new');
    await consolidate({
      configPath, dataDir, pdfRoot: '/tmp/never-used',
      gwsFactory: () => new FixtureGws({ fixturesRoot: FIXTURES_ROOT }), ecbSeeder: async () => {},
    });
    const before = readFileSync(livePath);

    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'report-source-mismatch-'));
    try {
      const source = resolve(FIXTURES_ROOT, 'REPORT_2026');
      const target = resolve(fixtureRoot, 'REPORT_2026');
      mkdirSync(target, { recursive: true });
      // Avoid shell file copying so the test remains portable.
      const files = ['Clean Data.json', 'Monthly Spending.json', 'Order Summary.json'];
      for (const file of files) {
        const contents = JSON.parse(readFileSync(resolve(source, file), 'utf8')) as { unformatted_rows?: unknown[][] };
        if (file === 'Monthly Spending.json') contents.unformatted_rows![1]![1] = 999;
        writeFileSync(resolve(target, file), JSON.stringify(contents));
      }

      await expect(consolidate({
        configPath, dataDir, pdfRoot: '/tmp/never-used',
        gwsFactory: () => new FixtureGws({ fixturesRoot: fixtureRoot }), ecbSeeder: async () => {},
      })).rejects.toThrow('monthly summary 2026-01 Spend mismatch');
      expect(readFileSync(livePath).equals(before)).toBe(true);
      expect(existsSync(stagingPath)).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
