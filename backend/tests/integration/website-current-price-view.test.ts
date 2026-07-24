/**
 * T073 follow-up — v_website_current_price view correctness.
 *
 * Regression test for QA review H1. v2 snapshots reject undated invoices at
 * the store boundary, while dated rows retain the selector's tie and status
 * behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStagingStore } from '../../src/pipeline/store/db.js';
import type { Database as DatabaseT } from 'better-sqlite3';

interface ViewRow {
  website: string;
  source_row_key: string | null;
  invoice_date: string | null;
  row_index: number | null;
  eur_amount: number | null;
  native_amount: number | null;
  native_currency: string | null;
}

function insertInvoice(
  db: DatabaseT,
  partial: {
    source_row_key: string;
    website: string | null;
    invoice_date: string | null;
    is_done?: 0 | 1;
    conversion_status?: string;
    eur_amount?: number | null;
    native_amount?: number | null;
    native_currency?: string | null;
    row_index?: number;
  },
): void {
  const stmt = db.prepare(`
    INSERT INTO invoices (
      source_row_key, invoice_id, order_code, spreadsheet_id, tab_name,
      tab_name_raw, row_index, work_status, is_done, payment_status,
      invoice_type, artifact_ref, artifact_status, website, website_raw,
       native_amount, native_currency, eur_amount, savings_eur, ecb_rate, ecb_rate_as_of,
      conversion_status, invoice_date, invoice_month, date_source,
      audit_flags, ingested_at
    ) VALUES (
      @source_row_key, NULL, 'CGLT', 'sheet-1', 'April 2026',
      'April 2026', @row_index, 'Done', @is_done, 'paid',
      'pdf', NULL, 'not_attempted', @website, @website,
      @native_amount, @native_currency, @eur_amount, 0, 1.0, '2026-04-01',
      @conversion_status, @invoice_date,
      CASE WHEN @invoice_date IS NULL THEN NULL ELSE substr(@invoice_date, 1, 7) END,
      CASE WHEN @invoice_date IS NULL THEN 'undated' ELSE 'sheet' END,
      '[]', '2026-04-01T00:00:00Z'
    )
  `);
  stmt.run({
    source_row_key: partial.source_row_key,
    website: partial.website,
    invoice_date: partial.invoice_date,
    is_done: partial.is_done ?? 1,
    conversion_status: partial.conversion_status ?? 'converted',
    eur_amount: partial.eur_amount ?? 100,
    native_amount: partial.native_amount ?? 100,
    native_currency: partial.native_currency ?? 'EUR',
    row_index: partial.row_index ?? 2,
  });
}

describe('v_website_current_price view (v2 snapshot dates)', () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseT;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'view-test-'));
    dbPath = join(dir, 'staging.sqlite');
    db = openStagingStore(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits one row per dated website with the max-date row populated', () => {
    insertInvoice(db, {
      source_row_key: '0000000000000001',
      website: 'a.com',
      invoice_date: '2026-04-01',
      row_index: 2,
      eur_amount: 100,
    });
    insertInvoice(db, {
      source_row_key: '0000000000000002',
      website: 'a.com',
      invoice_date: '2026-05-15',
      row_index: 3,
      eur_amount: 200,
    });

    const rows = db.prepare('SELECT * FROM v_website_current_price ORDER BY website').all() as ViewRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.website).toBe('a.com');
    expect(rows[0]!.invoice_date).toBe('2026-05-15');
    expect(rows[0]!.eur_amount).toBe(200);
  });

  it('rejects an undated invoice before it can reach the view', () => {
    expect(() => insertInvoice(db, {
      source_row_key: '0000000000000010',
      website: 'undated-only.com',
      invoice_date: null,
      row_index: 5,
      eur_amount: 50,
    })).toThrow(/NOT NULL constraint failed/);
  });

  it('emits all tied max-date rows per website (selector resolves the winner)', () => {
    insertInvoice(db, {
      source_row_key: '0000000000000020',
      website: 'tied.com',
      invoice_date: '2026-04-01',
      row_index: 2,
      eur_amount: 100,
    });
    insertInvoice(db, {
      source_row_key: '0000000000000021',
      website: 'tied.com',
      invoice_date: '2026-04-01',
      row_index: 7,
      eur_amount: 110,
    });

    const rows = db.prepare('SELECT * FROM v_website_current_price ORDER BY website, row_index DESC').all() as ViewRow[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.website === 'tied.com')).toBe(true);
    expect(rows.every((r) => r.invoice_date === '2026-04-01')).toBe(true);
  });

  it('excludes non-Done rows and non-converted rows from MAX(invoice_date) computation', () => {
    insertInvoice(db, {
      source_row_key: '0000000000000030',
      website: 'mixed.com',
      invoice_date: '2026-04-01',
      row_index: 2,
      eur_amount: 100,
      is_done: 1,
      conversion_status: 'converted',
    });
    // A LATER non-Done row — must NOT be picked as current.
    insertInvoice(db, {
      source_row_key: '0000000000000031',
      website: 'mixed.com',
      invoice_date: '2026-09-15',
      row_index: 3,
      eur_amount: null,
      native_amount: null,
      is_done: 0,
      conversion_status: 'converted',
    });
    // A LATER Done-but-out_of_ecb_currency row — must NOT be picked as current.
    insertInvoice(db, {
      source_row_key: '0000000000000032',
      website: 'mixed.com',
      invoice_date: '2026-10-15',
      row_index: 4,
      eur_amount: null,
      native_amount: 100,
      native_currency: 'XPT',
      is_done: 1,
      conversion_status: 'out_of_ecb_currency',
    });

    const rows = db.prepare("SELECT * FROM v_website_current_price WHERE website='mixed.com'").all() as ViewRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.invoice_date).toBe('2026-04-01');
    expect(rows[0]!.eur_amount).toBe(100);
  });

  it('emits zero rows when there are no aggregable rows at all', () => {
    insertInvoice(db, {
      source_row_key: '0000000000000040',
      website: 'noop.com',
      invoice_date: '2026-04-01',
      is_done: 0,
      conversion_status: 'converted',
    });

    const rows = db.prepare('SELECT * FROM v_website_current_price').all() as ViewRow[];
    expect(rows).toHaveLength(0);
  });
});
