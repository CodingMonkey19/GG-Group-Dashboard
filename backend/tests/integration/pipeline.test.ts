/**
 * Pipeline integration tests — composes the whole consolidate pipeline
 * against FixtureGws + an in-memory SQLite store.
 *
 * Covers:
 *   T035  — happy path end-to-end (2 sheets, 4 eligible rows; non-Done is dropped)
 *   T034a — audit-only row admission (missing_price, unparseable_amount,
 *           out_of_ecb_currency stay in the store, NULL conversion fields)
 *   T087a — PayPal multi-row sheet-price-wins regression (NON-NEGOTIABLE
 *           per Codex review of branch 001-spend-dashboard, Finding #2):
 *           5 rows × €100 sharing one PayPal URL → totals === €500, NOT
 *           5 × hypothetical PayPal total
 *   T041b — tab-alias resolution (FR-006): `Previos Orders` resolves to
 *           canonical `Previous Orders` while `tab_name_raw` preserves
 *           the original spelling for provenance.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runConsolidation } from '../../src/pipeline/consolidate.js';
import type { ColumnMapping, SheetEntry, SheetsConfig } from '../../src/shared/contracts.js';
import { FixtureGws } from '../fixtures/gws/FixtureGws.js';
import { openTestDb } from '../helpers/db.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const FIXTURES_ROOT = resolve(__dirname, '../fixtures/sheets');

// Column letters used by every fixture above.
const EUR_ONLY_MAPPING: ColumnMapping = {
  status: 'A',
  link_builder: 'B',
  website: 'C',
  price: 'D',
  invoice_date: 'E',
  invoice_url: 'F',
  invoice_status: 'G',
};

const WITH_CURRENCY_MAPPING: ColumnMapping = {
  status: 'A',
  link_builder: 'B',
  website: 'C',
  price: 'D',
  currency: 'E',
  invoice_date: 'F',
  invoice_url: 'G',
  invoice_status: 'H',
};

function buildConfig(sheets: SheetEntry[], aliases?: Record<string, string>): SheetsConfig {
  const config: SheetsConfig = {
    schema_version: 1,
    sheets,
  } as SheetsConfig;
  if (aliases !== undefined) {
    (config as { tab_aliases?: Record<string, string> }).tab_aliases = aliases;
  }
  return config;
}

describe('runConsolidation — happy path (T035)', () => {
  it('ingests 2 sheets, classifies + normalizes + writes; counters reconcile', async () => {
    const db = openTestDb();
    const gws = new FixtureGws({ fixturesRoot: FIXTURES_ROOT });

    const config = buildConfig([
      {
        spreadsheet_id: 'HAPPY',
        order_code: 'HAPPY',
        tabs: ['Previous Orders', 'April 2026'],
        column_mapping: EUR_ONLY_MAPPING,
      },
    ]);

    const result = await runConsolidation({
      config,
      db,
      gws,
      pdfRoot: '/tmp/never-used',
    });

    // Status: every source succeeded.
    expect(result.status).toBe('success');
    expect(result.per_source).toHaveLength(1);
    expect(result.per_source[0]?.status).toBe('success');
    expect(result.excluded_order_codes).toEqual([]);

    // Counters: 4 eligible rows. The In Progress row is dropped before store/API.
    expect(result.counters.rows_total).toBe(4);
    expect(result.counters.rows_done).toBe(4);
    expect(result.counters.rows_excluded_by_status).toBe(0);
    expect(result.counters.rows_total).toBe(
      result.counters.rows_done + result.counters.rows_excluded_by_status,
    );

    // Sum of EUR for Done+converted rows: 150+100 (March) + 200+250 (April) = 700.
    const headlineRow = db
      .prepare(
        "SELECT SUM(eur_amount) AS total FROM invoices WHERE is_done=1 AND conversion_status='converted'",
      )
      .get() as { total: number };
    expect(headlineRow.total).toBe(700);

    // The non-Done row is not present in the dashboard store.
    const nonDoneCount = db
      .prepare('SELECT COUNT(*) AS c FROM invoices WHERE is_done=0')
      .get() as { c: number };
    expect(nonDoneCount.c).toBe(0);

    // Dropped rows do not create dashboard audit findings.
    const auditCount = db
      .prepare("SELECT COUNT(*) AS c FROM audit_findings WHERE category='non_done_row'")
      .get() as { c: number };
    expect(auditCount.c).toBe(0);

    db.close();
  });
});

describe('runConsolidation — audit-only row admission (T034a)', () => {
  it('keeps missing_price / unparseable_amount / out_of_ecb_currency rows in the store with NULL conversion fields', async () => {
    const db = openTestDb();
    const gws = new FixtureGws({ fixturesRoot: FIXTURES_ROOT });

    const config = buildConfig([
      {
        spreadsheet_id: 'AUDIT_ONLY',
        order_code: 'AUDIT_ORDER',
        tabs: ['April 2026'],
        column_mapping: WITH_CURRENCY_MAPPING,
      },
    ]);

    const result = await runConsolidation({
      config,
      db,
      gws,
      pdfRoot: '/tmp/never-used',
    });

    expect(result.counters.rows_total).toBe(4);
    expect(result.counters.rows_done).toBe(4); // all Done; conversion fails for 3
    expect(result.counters.rows_out_of_ecb_currency).toBe(1);

    // Aggregable rows: only the EUR row converted successfully.
    const aggregable = db
      .prepare(
        "SELECT COUNT(*) AS c FROM invoices WHERE is_done=1 AND conversion_status='converted'",
      )
      .get() as { c: number };
    expect(aggregable.c).toBe(1);

    // The 3 audit-only rows are present in the store with NULL conversion fields.
    const auditOnlyRows = db
      .prepare(
        `SELECT website, conversion_status, eur_amount, ecb_rate
           FROM invoices
          WHERE conversion_status != 'converted'
          ORDER BY website`,
      )
      .all() as Array<{
      website: string;
      conversion_status: string;
      eur_amount: number | null;
      ecb_rate: number | null;
    }>;
    expect(auditOnlyRows).toHaveLength(3);
    for (const row of auditOnlyRows) {
      expect(row.eur_amount).toBeNull();
      expect(row.ecb_rate).toBeNull();
    }

    // Each audit-only row has a matching audit_finding referencing its source_row_key.
    const findingsByCategory = db
      .prepare('SELECT category, COUNT(*) AS c FROM audit_findings GROUP BY category')
      .all() as Array<{ category: string; c: number }>;
    const map = new Map(findingsByCategory.map((r) => [r.category, r.c]));
    // Post-H5: missing_price + unparseable_amount are distinct audit categories.
    expect(map.get('missing_price') ?? 0).toBe(1); // empty cell
    expect(map.get('unparseable_amount') ?? 0).toBe(1); // "abc"
    // One out_of_ecb_currency finding (XPT).
    expect(map.get('out_of_ecb_currency') ?? 0).toBe(1);

    db.close();
  });
});

describe('runConsolidation — PayPal multi-row sheet-price-wins regression (T087a, NON-NEGOTIABLE)', () => {
  it('5 rows sharing one PayPal URL each contribute their per-row sheet price (€500), NOT the invoice total', async () => {
    const db = openTestDb();
    const gws = new FixtureGws({ fixturesRoot: FIXTURES_ROOT });

    const config = buildConfig([
      {
        spreadsheet_id: 'PAYPAL_BUNDLE',
        order_code: 'BUNDLE',
        tabs: ['April 2026'],
        column_mapping: EUR_ONLY_MAPPING,
      },
    ]);

    const result = await runConsolidation({
      config,
      db,
      gws,
      pdfRoot: '/tmp/never-used',
    });

    expect(result.status).toBe('success');
    expect(result.counters.rows_done).toBe(5);

    // Total spend == sum of per-row prices (5 × €100), NOT 5 × hypothetical
    // €500 invoice total. If a future implementer wires the PayPal extractor
    // to return native_amount, this assertion fails immediately.
    const total = db
      .prepare(
        "SELECT SUM(eur_amount) AS total FROM invoices WHERE is_done=1 AND conversion_status='converted'",
      )
      .get() as { total: number };
    expect(total.total).toBe(500);

    // All 5 rows are present (no removal-by-dedupe).
    const rowCount = db.prepare('SELECT COUNT(*) AS c FROM invoices').get() as { c: number };
    expect(rowCount.c).toBe(5);

    // Exactly one duplicate_invoice_id finding (group of 5 sharing PAYINV-BUNDLE-XYZ).
    const dupe = db
      .prepare("SELECT COUNT(*) AS c FROM audit_findings WHERE category='duplicate_invoice_id'")
      .get() as { c: number };
    expect(dupe.c).toBe(1);

    // duplicate_invoice_groups counter reflects this.
    expect(result.counters.duplicate_invoice_groups).toBe(1);

    db.close();
  });
});

describe('runConsolidation — tab alias resolution (T041b, FR-006)', () => {
  it('canonicalizes "Previos Orders" → "Previous Orders" while preserving tab_name_raw', async () => {
    const db = openTestDb();
    const gws = new FixtureGws({ fixturesRoot: FIXTURES_ROOT });

    const config = buildConfig(
      [
        {
          spreadsheet_id: 'ALIAS_TAB',
          order_code: 'ALIAS',
          tabs: ['Previos Orders'], // misspelled — sheet uses this exact tab name
          column_mapping: EUR_ONLY_MAPPING,
        },
      ],
      { 'Previous Orders': 'Previos Orders' }, // canonical: variant
    );

    const result = await runConsolidation({
      config,
      db,
      gws,
      pdfRoot: '/tmp/never-used',
    });

    expect(result.status).toBe('success');
    expect(result.counters.rows_total).toBe(1);

    const row = db
      .prepare('SELECT tab_name, tab_name_raw FROM invoices')
      .get() as { tab_name: string; tab_name_raw: string };
    expect(row.tab_name).toBe('Previous Orders');
    expect(row.tab_name_raw).toBe('Previos Orders');

    db.close();
  });
});

describe('runConsolidation — historical FX rates (Codex Finding #1 regression)', () => {
  it('converts a prior-month USD invoice using its historical ECB rate', async () => {
    // Seed a USD rate for 2026-03-15 (one month before today's fixture data).
    const db = openTestDb({
      ecbDate: '2026-04-15',
      extraRates: [{ date: '2026-03-15', currency: 'USD', rate: 1.0625 }],
    });
    const gws = new FixtureGws({ fixturesRoot: FIXTURES_ROOT });

    // Build a tiny inline fixture: 1 USD row dated 2026-03-15.
    // Rather than write a new disk fixture, use the existing AUDIT_ONLY
    // sheet shape but override with a single Done USD row via a custom
    // adapter. Simpler: build the row in-memory by calling normalizeRow
    // directly is overkill; spinning up a dedicated fixture file is cheaper.
    // We use HISTORICAL_USD fixture (added below).
    const config = buildConfig([
      {
        spreadsheet_id: 'HISTORICAL_USD',
        order_code: 'HIST',
        tabs: ['Previous Orders'],
        column_mapping: WITH_CURRENCY_MAPPING,
      },
    ]);

    const result = await runConsolidation({
      config,
      db,
      gws,
      pdfRoot: '/tmp/never-used',
    });

    expect(result.status).toBe('success');
    expect(result.counters.rows_done).toBe(1);
    expect(result.counters.rows_out_of_ecb_currency).toBe(0);

    const row = db
      .prepare(
        "SELECT eur_amount, ecb_rate, ecb_rate_as_of, conversion_status FROM invoices",
      )
      .get() as {
      eur_amount: number;
      ecb_rate: number;
      ecb_rate_as_of: string;
      conversion_status: string;
    };
    expect(row.conversion_status).toBe('converted');
    expect(row.ecb_rate).toBe(1.0625);
    expect(row.ecb_rate_as_of).toBe('2026-03-15');
    // 100 USD ÷ 1.0625 ≈ 94.12
    expect(row.eur_amount).toBeCloseTo(94.12, 2);

    db.close();
  });
});

describe('runConsolidation — Drive PDF not found (Codex Finding #4 regression)', () => {
  it('marks artifact_status=unreachable + emits artifact_unreachable finding for a deleted Drive file', async () => {
    const db = openTestDb();
    const driveUrl = 'https://drive.google.com/file/d/DELETED/view';
    const gws = new FixtureGws({
      fixturesRoot: FIXTURES_ROOT,
      failures: { driveMetadataNotFound: new Set([driveUrl]) },
    });

    const config = buildConfig([
      {
        spreadsheet_id: 'DRIVE_DELETED',
        order_code: 'DRIVE',
        tabs: ['April 2026'],
        column_mapping: EUR_ONLY_MAPPING,
      },
    ]);

    const result = await runConsolidation({
      config,
      db,
      gws,
      pdfRoot: '/tmp/never-used',
    });

    expect(result.status).toBe('success');
    expect(result.counters.rows_done).toBe(1);

    // Row stays in totals using the sheet price (Principle I).
    const row = db
      .prepare(
        "SELECT eur_amount, artifact_status, conversion_status FROM invoices WHERE invoice_type='drive_pdf'",
      )
      .get() as {
      eur_amount: number;
      artifact_status: string;
      conversion_status: string;
    };
    expect(row.conversion_status).toBe('converted');
    expect(row.eur_amount).toBe(100);
    expect(row.artifact_status).toBe('unreachable');

    // Audit finding emitted under artifact_unreachable.
    const finding = db
      .prepare(
        "SELECT category, summary FROM audit_findings WHERE category='artifact_unreachable'",
      )
      .get() as { category: string; summary: string };
    expect(finding.category).toBe('artifact_unreachable');
    expect(finding.summary).toMatch(/drive_pdf/);

    db.close();
  });
});

describe('runConsolidation — duplicate-row content collision (Codex bzj921whd Finding #3)', () => {
  it('two byte-identical rows in the same sheet both ingest with distinct source_row_key values', async () => {
    // Build a 2-row fixture inline by directly invoking adaptSheet then
    // normalizeRow. Simplest path: write a fixture file for a sheet that
    // has two byte-identical rows, run consolidate, assert both rows
    // appear in the store.
    const db = openTestDb();
    const gws = new FixtureGws({ fixturesRoot: FIXTURES_ROOT });

    const config = buildConfig([
      {
        spreadsheet_id: 'IDENTICAL_DUPES',
        order_code: 'DUPES',
        tabs: ['April 2026'],
        column_mapping: EUR_ONLY_MAPPING,
      },
    ]);

    const result = await runConsolidation({
      config,
      db,
      gws,
      pdfRoot: '/tmp/never-used',
    });

    expect(result.status).toBe('success');
    expect(result.counters.rows_done).toBe(2);

    // Both rows admitted; UNIQUE constraint did NOT abort the refresh.
    const rows = db
      .prepare('SELECT source_row_key, row_index FROM invoices ORDER BY row_index')
      .all() as Array<{ source_row_key: string; row_index: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.source_row_key).not.toBe(rows[1]?.source_row_key);

    db.close();
  });
});

describe('runConsolidation — sheet-fatal failure (T034b path A subset)', () => {
  it('a failed sheet contributes ZERO rows; appears in excluded_order_codes; status=partial', async () => {
    const db = openTestDb();
    const gws = new FixtureGws({
      fixturesRoot: FIXTURES_ROOT,
      failures: { authErrors: new Set(['BROKEN_SHEET']) },
    });

    const config = buildConfig([
      {
        spreadsheet_id: 'HAPPY',
        order_code: 'HAPPY',
        tabs: ['Previous Orders'],
        column_mapping: EUR_ONLY_MAPPING,
      },
      {
        spreadsheet_id: 'BROKEN_SHEET',
        order_code: 'BROKEN',
        tabs: ['April 2026'],
        column_mapping: EUR_ONLY_MAPPING,
      },
    ]);

    const result = await runConsolidation({
      config,
      db,
      gws,
      pdfRoot: '/tmp/never-used',
    });

    expect(result.status).toBe('partial');
    expect(result.excluded_order_codes).toEqual(['BROKEN']);

    const happyRows = db
      .prepare("SELECT COUNT(*) AS c FROM invoices WHERE order_code='HAPPY'")
      .get() as { c: number };
    expect(happyRows.c).toBe(2);

    const brokenRows = db
      .prepare("SELECT COUNT(*) AS c FROM invoices WHERE order_code='BROKEN'")
      .get() as { c: number };
    expect(brokenRows.c).toBe(0);

    const brokenStatus = result.per_source.find((s) => s.order_code === 'BROKEN');
    expect(brokenStatus?.status).toBe('failure');
    expect(brokenStatus?.rows_pulled).toBe(0);

    db.close();
  });
});
