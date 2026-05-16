/**
 * T087a (NON-NEGOTIABLE per Codex review of branch 001-spend-dashboard,
 * Finding #2) — sheet price wins for multi-row PayPal bundles.
 *
 * This is the dedicated home for the regression that catches any future
 * implementer who reintroduces PayPal-as-amount-source (e.g., by wiring
 * the extractor to fetch the invoice total). The pipeline.test.ts copy
 * exercises the OUTCOME (€500, not €2500); this file ALSO asserts the
 * SHAPE of every extract/paypal.ts return so a regression that adds
 * monetary fields fails LOUDLY at the source, not just via the
 * bottom-line EUR total.
 *
 * Fixture: PAYPAL_BUNDLE — 5 rows × price=100, all referencing the same
 * PayPal URL whose hypothetical "true total" is €500 (or some other
 * fictional figure). The right answer is always 5 × sheet price.
 *
 * NOTE on the spy strategy: under ESM, `vi.spyOn` against a module
 * binding the consumer imported at parse-time does not intercept the
 * call site (the binding is bound, not re-resolved). So instead of
 * spying mid-pipeline, we (a) assert the OUTCOME via the headline EUR
 * total + duplicate_invoice_id finding, and (b) call extractPaypal
 * directly with the fixture URL and assert its return shape contains
 * EXACTLY {invoice_id, artifact_status} — no monetary keys. Together
 * these lock the contract at both ends.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { runConsolidation } from '../../src/pipeline/consolidate.js';
import { FixtureGws } from '../fixtures/gws/FixtureGws.js';
import { extractPaypal } from '../../src/pipeline/extract/paypal.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const FIXTURES_ROOT = resolve(__dirname, '../fixtures/sheets');
const SCHEMA_SQL = readFileSync(
  resolve(__dirname, '../../src/pipeline/store/schema.sql'),
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

describe('T087a — PayPal multi-row bundle: sheet price wins', () => {
  it('5 rows × €100 sum to €500 (sheet price authoritative, never the invoice total)', async () => {
    const db = openTestDb();
    const gws = new FixtureGws({ fixturesRoot: FIXTURES_ROOT });
    const config = {
      schema_version: 1 as const,
      sheets: [
        {
          spreadsheet_id: 'PAYPAL_BUNDLE',
          order_code: 'BUNDLE',
          tabs: ['April 2026'],
          column_mapping: EUR_ONLY_MAPPING,
        },
      ],
    };

    const result = await runConsolidation({
      config,
      db,
      gws,
      pdfRoot: '/tmp/never-used',
    });

    expect(result.status).toBe('success');
    expect(result.counters.rows_done).toBe(5);

    // Headline: 5 rows × €100 = €500. NOT 5 × invoice total.
    const total = db
      .prepare(
        "SELECT SUM(eur_amount) AS total FROM invoices WHERE is_done=1 AND conversion_status='converted'",
      )
      .get() as { total: number };
    expect(total.total).toBe(500);

    // Sanity: the duplicate_invoice_id finding fires (5 rows share invoice_id).
    const dupe = db
      .prepare("SELECT COUNT(*) AS c FROM audit_findings WHERE category='duplicate_invoice_id'")
      .get() as { c: number };
    expect(dupe.c).toBe(1);

    db.close();
  });

  it('extract/paypal.ts return shape is EXACTLY {invoice_id, artifact_status} — never carries monetary fields', () => {
    // Direct contract assertion against the same fixture URL the bundle
    // rows use. If a future PR adds native_amount / native_currency / any
    // monetary key to PaypalExtractResult, Object.keys.sort changes and
    // this fails — at the source, before the value can poison totals.
    const fixtureUrl = 'https://www.paypal.com/invoice/p/#PAYINV-BUNDLE-XYZ';
    const out = extractPaypal(fixtureUrl);
    expect(Object.keys(out).sort()).toEqual(['artifact_status', 'invoice_id']);
    expect(out.artifact_status).toBe('not_attempted');
    expect(out.invoice_id).toBe('PAYINV-BUNDLE-XYZ');

    // Same assertion for null / blank / non-PayPal URLs — all must obey
    // the same shape.
    for (const input of [null, '', '   ', 'https://example.com/no-paypal']) {
      const r = extractPaypal(input);
      expect(Object.keys(r).sort()).toEqual(['artifact_status', 'invoice_id']);
      expect(r).not.toHaveProperty('native_amount');
      expect(r).not.toHaveProperty('native_currency');
      expect(r).not.toHaveProperty('eur_amount');
    }
  });
});
