/**
 * T034b (regression-locks Codex review #5 from branch bjk1d7p3j) —
 * sheet-fatal vs row-level artifact failure semantics.
 *
 * Configure two sheets:
 *   • Sheet A reads fine but contains 2 rows whose `pdf` artifacts cannot
 *     be opened (file missing on disk). v1 doesn't fetch PayPal — see
 *     revised research.md Decision 5 — so we deliberately use `pdf` rows
 *     here, not `paypal`.
 *   • Sheet B errors on `pullSheet` (GwsAuthError).
 *
 * Assertions:
 *   • Sheet B's order_code appears in `excluded_order_codes` with zero
 *     rows in totals (path A — whole-sheet exclusion).
 *   • Sheet A's totals INCLUDE the 2 artifact-failure rows because the
 *     sheet price is authoritative (Principle I: artifacts are
 *     verification, never source-of-truth for monetary values).
 *   • Each artifact-failure row appears in Audit `artifact_unreachable`.
 *
 * This is the canonical "two failure modes are NOT the same" lock — a
 * future PR that decides to drop artifact-failure rows from totals (or
 * conversely, decides to admit Sheet B's rows somehow) breaks here.
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

function buildFixture(): { fixturesRoot: string; pdfRoot: string; config: SheetsConfig } {
  const root = mkdtempSync(resolve(tmpdir(), 't034b-fixture-'));
  const pdfRoot = resolve(root, 'pdfs');
  mkdirSync(pdfRoot, { recursive: true });
  // Sheet A — reads fine; 2 broken-pdf rows (file missing on disk →
  // extractPdf returns artifact_status='unreachable'). The contract
  // we're locking is that those rows STAY in totals using the sheet
  // price even though the artifact didn't open.
  const sheetADir = resolve(root, 'SHEET_A');
  mkdirSync(sheetADir, { recursive: true });
  writeFileSync(resolve(sheetADir, '__tabs.json'), JSON.stringify(['April 2026']));
  writeFileSync(
    resolve(sheetADir, 'April 2026.json'),
    JSON.stringify({
      rows: [
        ['Done', 'Saras', 'broken-1.com', '50', '2026-04-15', resolve(pdfRoot, 'missing-1.pdf'), 'paid'],
        ['Done', 'Saras', 'broken-2.com', '75', '2026-04-15', resolve(pdfRoot, 'missing-2.pdf'), 'paid'],
      ],
    }),
  );

  // Sheet B — pullSheet throws GwsAuthError (failure injection).
  const sheetBDir = resolve(root, 'SHEET_B');
  mkdirSync(sheetBDir, { recursive: true });
  writeFileSync(resolve(sheetBDir, '__tabs.json'), JSON.stringify(['April 2026']));
  writeFileSync(
    resolve(sheetBDir, 'April 2026.json'),
    JSON.stringify({
      rows: [
        ['Done', 'Saras', 'sheet-b.com', '999', '2026-04-15', '', 'paid'],
      ],
    }),
  );

  return {
    fixturesRoot: root,
    pdfRoot,
    config: {
      schema_version: 1,
      sheets: [
        {
          spreadsheet_id: 'SHEET_A',
          order_code: 'ORDER_A',
          tabs: ['April 2026'],
          column_mapping: COL_MAPPING,
        },
        {
          spreadsheet_id: 'SHEET_B',
          order_code: 'ORDER_B',
          tabs: ['April 2026'],
          column_mapping: COL_MAPPING,
        },
      ],
    },
  };
}

describe('T034b — sheet-fatal vs row-level artifact failure (regression lock)', () => {
  it('Sheet B excluded entirely; Sheet A row-level artifact failures STAY in totals + emit audit', async () => {
    const { fixturesRoot, pdfRoot, config } = buildFixture();
    let db: Database.Database | null = null;
    try {
      db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      db.exec(SCHEMA_SQL);
      upsertEcbRate(db, '2026-04-15', 'EUR', 1.0);

      const result = await runConsolidation({
        config,
        db,
        gws: new FixtureGws({
          fixturesRoot,
          failures: { authErrors: new Set(['SHEET_B']) },
        }),
        pdfRoot,
      });

      // ----- Sheet B: whole-sheet exclusion -----
      expect(result.excluded_order_codes).toEqual(['ORDER_B']);
      const sheetB = result.per_source.find((s) => s.spreadsheet_id === 'SHEET_B');
      expect(sheetB?.status).toBe('failure');
      expect(sheetB?.rows_pulled).toBe(0);

      // No SHEET_B rows landed in invoices.
      const sheetBRowCount = db
        .prepare("SELECT COUNT(*) AS c FROM invoices WHERE spreadsheet_id='SHEET_B'")
        .get() as { c: number };
      expect(sheetBRowCount.c).toBe(0);

      // ----- Sheet A: success; both broken-pdf rows present + INCLUDED in totals -----
      const sheetA = result.per_source.find((s) => s.spreadsheet_id === 'SHEET_A');
      expect(sheetA?.status).toBe('success');
      expect(sheetA?.rows_pulled).toBe(2);

      const sheetARows = db
        .prepare("SELECT artifact_status, eur_amount FROM invoices WHERE spreadsheet_id='SHEET_A' ORDER BY row_index")
        .all() as Array<{ artifact_status: string; eur_amount: number }>;
      expect(sheetARows).toHaveLength(2);

      // Both rows: artifact unreachable, but sheet price wins → still in totals.
      expect(sheetARows[0]!.artifact_status).toBe('unreachable');
      expect(sheetARows[0]!.eur_amount).toBe(50);
      expect(sheetARows[1]!.artifact_status).toBe('unreachable');
      expect(sheetARows[1]!.eur_amount).toBe(75);

      // Headline-aggregable EUR for Sheet A INCLUDES the artifact-failure rows.
      const totalA = db
        .prepare(
          "SELECT SUM(eur_amount) AS t FROM invoices WHERE spreadsheet_id='SHEET_A' AND is_done=1 AND conversion_status='converted'",
        )
        .get() as { t: number };
      expect(totalA.t).toBe(125); // 50 + 75 — sheet price authoritative even though both PDFs unreachable

      // ----- Audit: each artifact-failure row gets exactly one artifact_unreachable finding -----
      const unreachable = db
        .prepare("SELECT source_row_key FROM audit_findings WHERE category='artifact_unreachable'")
        .all() as Array<{ source_row_key: string }>;
      expect(unreachable).toHaveLength(2);
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
