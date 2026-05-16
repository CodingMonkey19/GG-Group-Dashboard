/**
 * T041d (NON-NEGOTIABLE per Constitution Development Workflow & Quality
 * Gates) — counter reconciliation against SC-004 ≥99% reflection.
 *
 * Fixture (108 source rows, 102 dashboard rows after hard ingest eligibility):
 *   • 100 healthy Done+converted+dated rows
 *   •   1 Done row with empty price cell → conversion_status='missing_price'
 *   •   1 Done row with currency XPT (not on ECB) → conversion_status='out_of_ecb_currency'
 *   •   1 Done row with no parseable date in sheet — dropped before DB/API
 *   •   5 non-Done rows — dropped before DB/API
 *
 * Assertions (every equality is exact):
 *   counters.rows_total === 102
 *   counters.rows_done === 102
 *   counters.rows_excluded_by_status === 0
 *   counters.rows_undated === 0
 *   counters.rows_out_of_ecb_currency === 1
 *   counters.rows_total === counters.rows_done + counters.rows_excluded_by_status
 *   audit_findings_by_category.non_done_row.length === 0
 *   audit_findings_by_category.missing_price.length === 1
 *   audit_findings_by_category.out_of_ecb_currency.length === 1
 *   audit_findings_by_category.missing_date.length === 0
 *
 * No silent loss inside eligible data: each Done+non-converted dated row maps
 * to exactly one matching-category finding. Ineligible rows are intentionally
 * absent from the dashboard store.
 *
 * Headline-aggregable count (derived, not stored):
 *   rows WHERE is_done=1 AND conversion_status='converted' === 100
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { runConsolidation } from '../../src/pipeline/consolidate.js';
import { upsertEcbRate } from '../../src/pipeline/normalize/ecb-cache.js';
import { FixtureGws } from '../fixtures/gws/FixtureGws.js';
import type { SheetsConfig } from '../../src/shared/contracts.js';

const SCHEMA_SQL = readFileSync(
  resolve(import.meta.dirname, '../../src/pipeline/store/schema.sql'),
  'utf8',
);

function openDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  // Seed an EUR + USD rate so the 100 healthy rows convert.
  upsertEcbRate(db, '2026-04-15', 'EUR', 1.0);
  upsertEcbRate(db, '2026-04-15', 'USD', 1.0789);
  return db;
}

const COL_MAPPING = {
  status: 'A',
  link_builder: 'B',
  website: 'C',
  price: 'D',
  invoice_date: 'E',
  invoice_url: 'F',
  invoice_status: 'G',
  currency: 'H',
};

/**
 * Build a fixture sheet root containing one tab whose rows match the
 * T041d shape. Returns the FIXTURES_ROOT to hand to FixtureGws.
 */
function buildFixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), 't041d-fixture-'));
  const sheetDir = resolve(root, 'COUNTER_RECON');
  mkdirSync(sheetDir, { recursive: true });
  writeFileSync(resolve(sheetDir, '__tabs.json'), JSON.stringify(['April 2026']));

  const rows: string[][] = [];
  // 100 healthy Done+converted+dated rows.
  for (let i = 0; i < 100; i += 1) {
    rows.push([
      'Done',
      'Saras',
      `site-${i}.com`,
      '100',
      '2026-04-15',
      `https://www.paypal.com/invoice/p/#PAYINV-H${i}`,
      'paid',
      'EUR',
    ]);
  }
  // 1 Done row, empty price cell → missing_price
  rows.push([
    'Done',
    'Saras',
    'missing-price.com',
    '', // ← empty price
    '2026-04-15',
    'https://www.paypal.com/invoice/p/#PAYINV-MP',
    'paid',
    'EUR',
  ]);
  // 1 Done row, currency XPT (not in ECB cache) → out_of_ecb_currency
  rows.push([
    'Done',
    'Saras',
    'xpt-currency.com',
    '500',
    '2026-04-15',
    'https://www.paypal.com/invoice/p/#PAYINV-XPT',
    'paid',
    'XPT', // ← unknown currency
  ]);
  // 1 Done row, no parseable date AND no artifact-derived date →
  // date_source='undated' but conversion_status='converted' (price+currency fine)
  rows.push([
    'Done',
    'Saras',
    'undated.com',
    '75',
    '', // ← empty date; paypal artifact never yields a date in v1
    'https://www.paypal.com/invoice/p/#PAYINV-UND',
    'paid',
    'EUR',
  ]);
  // 5 non-Done rows.
  for (let i = 0; i < 5; i += 1) {
    rows.push([
      'In Progress',
      'Saras',
      `nondone-${i}.com`,
      '999',
      '2026-04-15',
      `https://www.paypal.com/invoice/p/#PAYINV-ND${i}`,
      '',
      'EUR',
    ]);
  }

  writeFileSync(resolve(sheetDir, 'April 2026.json'), JSON.stringify({ rows }));
  return root;
}

describe('T041d — counter reconciliation (108 rows, NON-NEGOTIABLE)', () => {
  it('every counter and audit category matches the spec exactly; no silent loss', async () => {
    const fixturesRoot = buildFixture();
    let db: Database.Database | null = null;
    try {
      db = openDb();
      const config: SheetsConfig = {
        schema_version: 1,
        sheets: [
          {
            spreadsheet_id: 'COUNTER_RECON',
            order_code: 'CRECON',
            tabs: ['April 2026'],
            column_mapping: COL_MAPPING,
          },
        ],
      };

      const result = await runConsolidation({
        config,
        db,
        gws: new FixtureGws({ fixturesRoot }),
        pdfRoot: '/tmp/never-used',
      });

      // ----- counters -----
      expect(result.counters.rows_total).toBe(102);
      expect(result.counters.rows_done).toBe(102);
      expect(result.counters.rows_excluded_by_status).toBe(0);
      expect(result.counters.rows_undated).toBe(0);
      expect(result.counters.rows_out_of_ecb_currency).toBe(1);
      expect(result.counters.rows_total).toBe(
        result.counters.rows_done + result.counters.rows_excluded_by_status,
      );

      // ----- audit findings (counts per category from the DB) -----
      const findingsByCategory = db
        .prepare('SELECT category, COUNT(*) AS c FROM audit_findings GROUP BY category')
        .all() as Array<{ category: string; c: number }>;
      const map = new Map(findingsByCategory.map((r) => [r.category, r.c]));

      expect(map.get('non_done_row') ?? 0).toBe(0);
      expect(map.get('missing_price') ?? 0).toBe(1);
      expect(map.get('out_of_ecb_currency') ?? 0).toBe(1);
      expect(map.get('missing_date') ?? 0).toBe(0);

      // ----- no silent loss: every Done+non-converted has its own finding -----
      const auditOnlyDone = db
        .prepare(
          `SELECT source_row_key, conversion_status FROM invoices
           WHERE is_done = 1 AND conversion_status != 'converted'`,
        )
        .all() as Array<{ source_row_key: string; conversion_status: string }>;
      expect(auditOnlyDone).toHaveLength(2); // missing_price + out_of_ecb_currency

      for (const r of auditOnlyDone) {
        const cnt = db
          .prepare(
            `SELECT COUNT(*) AS c FROM audit_findings
             WHERE source_row_key = ? AND category = ?`,
          )
          .get(r.source_row_key, r.conversion_status) as { c: number };
        expect(cnt.c).toBe(1);
      }

      // Non-Done rows are dropped completely before store/API.
      const nonDone = db
        .prepare("SELECT source_row_key FROM invoices WHERE is_done = 0")
        .all() as Array<{ source_row_key: string }>;
      expect(nonDone).toHaveLength(0);

      // Done rows without parseable invoice dates are dropped completely.
      const undated = db
        .prepare(
          `SELECT source_row_key FROM invoices
           WHERE is_done = 1 AND date_source = 'undated'`,
        )
        .all() as Array<{ source_row_key: string }>;
      expect(undated).toHaveLength(0);

      // ----- headline-aggregable count (derived, not stored) -----
      const aggregable = db
        .prepare(
          "SELECT COUNT(*) AS c FROM invoices WHERE is_done = 1 AND conversion_status = 'converted'",
        )
        .get() as { c: number };
      expect(aggregable.c).toBe(100);
    } finally {
      try {
        db?.close();
      } catch {
        // best-effort
      }
      rmSync(fixturesRoot, { recursive: true, force: true });
    }
  });
});
