/**
 * T041c — 40-sheet scale (FR-030 + SC-009).
 *
 * Synthesize 40 minimal FixtureGws sheets each with 25 rows; run
 * runConsolidation; assert:
 *   (a) the run completes without error in under 30s on developer hardware
 *       (loose ceiling, just to catch O(N²) blowups)
 *   (b) every sheet appears in per_source with status: 'success'
 *   (c) counters.rows_total === 1000
 *
 * Operationally, the runbook step "edit config/sheets.json, run
 * ./scripts/consolidate, confirm new order appears" is documented in
 * quickstart.md — that's a quickstart entry, not an automated test.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { runConsolidation } from '../../src/pipeline/consolidate.js';
import { upsertEcbRate } from '../../src/pipeline/normalize/ecb-cache.js';
import { FixtureGws } from '../fixtures/gws/FixtureGws.js';
import type { SheetsConfig } from '../../src/shared/contracts.js';

const SCHEMA_SQL = readFileSync(
  resolve(import.meta.dirname, '../../src/pipeline/store/schema.sql'),
  'utf8',
);

const COL_MAPPING = {
  status: 'A',
  link_builder: 'B',
  website: 'C',
  price: 'D',
  invoice_date: 'E',
  invoice_url: 'F',
  invoice_status: 'G',
};

function buildFixture(): { fixturesRoot: string; config: SheetsConfig } {
  const root = mkdtempSync(resolve(tmpdir(), 't041c-fixture-'));
  const sheets: SheetsConfig['sheets'] = [];
  for (let s = 0; s < 40; s += 1) {
    const id = `SHEET-${String(s).padStart(2, '0')}`;
    const dir = resolve(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, '__tabs.json'), JSON.stringify(['April 2026']));

    const rows: string[][] = [];
    for (let r = 0; r < 25; r += 1) {
      rows.push([
        'Done',
        'Saras',
        `s${s}-r${r}.com`,
        '100',
        '2026-04-15',
        `https://www.paypal.com/invoice/p/#PAYINV-${s}-${r}`,
        'paid',
      ]);
    }
    writeFileSync(resolve(dir, 'April 2026.json'), JSON.stringify({ rows }));
    sheets.push({
      spreadsheet_id: id,
      order_code: `ORDER${s}`,
      tabs: ['April 2026'],
      column_mapping: COL_MAPPING,
    });
  }
  return { fixturesRoot: root, config: { schema_version: 1, sheets } };
}

describe('T041c — 40 sheets × 25 rows = 1000 rows scale smoke', () => {
  it('completes in under 30s; every sheet succeeds; counters.rows_total === 1000', async () => {
    const { fixturesRoot, config } = buildFixture();
    let db: Database.Database | null = null;
    try {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      db.exec(SCHEMA_SQL);
      upsertEcbRate(db, '2026-04-15', 'EUR', 1.0);

      const start = Date.now();
      const result = await runConsolidation({
        config,
        db,
        gws: new FixtureGws({ fixturesRoot }),
        pdfRoot: '/tmp/never-used',
      });
      const elapsedMs = Date.now() - start;

      expect(elapsedMs).toBeLessThan(30_000);
      expect(result.status).toBe('success');
      expect(result.per_source).toHaveLength(40);
      for (const src of result.per_source) {
        expect(src.status).toBe('success');
        expect(src.rows_pulled).toBe(25);
      }
      expect(result.counters.rows_total).toBe(1000);
      expect(result.counters.rows_done).toBe(1000);
      expect(result.counters.rows_excluded_by_status).toBe(0);
      expect(result.excluded_order_codes).toEqual([]);
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
