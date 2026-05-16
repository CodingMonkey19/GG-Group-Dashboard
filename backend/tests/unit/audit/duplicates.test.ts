/**
 * T087 (NON-NEGOTIABLE per Codex review #2 from branch 296d22b) — no
 * dedupe; flag duplicates only.
 *
 * Required fixture: 5 rows sharing the same `invoice_id`, same
 * `invoice_type=paypal`, same `native_amount=100`, distinct websites.
 *
 * Assertions:
 *   • Every row appears in `invoices` with its own distinct
 *     source_row_key (no removal).
 *   • Exactly one finding under `duplicate_invoice_id` lists all 5
 *     with full per-row provenance via their source_row_key references
 *     (the summary names every contributing row).
 *
 * Implementation note: PAYPAL_BUNDLE fixture matches the spec exactly
 * (distinct websites, same PayPal URL → same extracted invoice_id, same
 * sheet price). The fixture is also exercised by T087a's outcome test
 * in pipeline.test.ts and the dedicated regression in
 * paypal-amount-source.test.ts; here we focus on the no-dedupe contract.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { runConsolidation } from '../../../src/pipeline/consolidate.js';
import { FixtureGws } from '../../fixtures/gws/FixtureGws.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const FIXTURES_ROOT = resolve(__dirname, '../../fixtures/sheets');
const SCHEMA_SQL = readFileSync(
  resolve(__dirname, '../../../src/pipeline/store/schema.sql'),
  'utf8',
);

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

const EUR_ONLY_MAPPING = {
  status: 'A',
  link_builder: 'B',
  website: 'C',
  price: 'D',
  invoice_date: 'E',
  invoice_url: 'F',
  invoice_status: 'G',
};

describe('T087 — duplicate_invoice_id: no dedupe; one finding per group', () => {
  it('5 PayPal-bundle rows share an invoice_id; all 5 stay in the store, ONE finding lists every row', async () => {
    const db = openTestDb();
    const gws = new FixtureGws({ fixturesRoot: FIXTURES_ROOT });

    const result = await runConsolidation({
      config: {
        schema_version: 1,
        sheets: [
          {
            spreadsheet_id: 'PAYPAL_BUNDLE',
            order_code: 'BUNDLE',
            tabs: ['April 2026'],
            column_mapping: EUR_ONLY_MAPPING,
          },
        ],
      },
      db,
      gws,
      pdfRoot: '/tmp/never-used',
    });

    expect(result.status).toBe('success');

    // No-dedupe: every input row appears with its own source_row_key.
    const rows = db
      .prepare(
        "SELECT source_row_key, invoice_id, website, native_amount FROM invoices ORDER BY row_index",
      )
      .all() as Array<{
        source_row_key: string;
        invoice_id: string;
        website: string;
        native_amount: number;
      }>;
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.source_row_key)).size).toBe(5); // all distinct

    // All share one invoice_id.
    const ids = new Set(rows.map((r) => r.invoice_id));
    expect(ids.size).toBe(1);
    const sharedId = [...ids][0];

    // All carry sheet-price=100 (T087a guarantees this; sanity check here).
    expect(rows.every((r) => r.native_amount === 100)).toBe(true);

    // Distinct websites.
    expect(new Set(rows.map((r) => r.website)).size).toBe(5);

    // Exactly ONE duplicate_invoice_id finding for the group.
    const dupes = db
      .prepare(
        "SELECT source_row_key, summary FROM audit_findings WHERE category='duplicate_invoice_id'",
      )
      .all() as Array<{ source_row_key: string; summary: string }>;
    expect(dupes).toHaveLength(1);

    // The finding's summary names every contributing row provenance so the
    // operator can reconcile without going row-by-row.
    expect(dupes[0]!.summary).toMatch(/5 rows share invoice_id/);
    expect(dupes[0]!.summary).toContain(sharedId!);
    // Every row's tab/index appears in the summary (5 occurrences of
    // "April 2026:N").
    for (let i = 1; i <= 5; i += 1) {
      expect(dupes[0]!.summary).toContain(`April 2026:${i}`);
    }

    db.close();
  });
});
