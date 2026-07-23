/**
 * T088 + T089 — Audit category emission tests.
 *
 *   T088: future_dated_invoice fires when a Done row's invoice_date is
 *         later than today (UTC).
 *   T089: with a clean fixture (no failures), every audit category key
 *         is still present in the API response with [] (FR-022).
 *
 * Both tests exercise the audit emitter directly + the API envelope so
 * the empty-key invariant is locked at both ends.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { emitFindings } from '../../../src/pipeline/audit/findings.js';
import {
  AUDIT_CATEGORIES_ALL,
  AUDIT_CATEGORIES_V2_RESERVED,
} from '../../../src/shared/contracts.js';
import type { NormalizedRow } from '../../../src/pipeline/normalize/index.js';
import { buildServer } from '../../../src/api/server.js';
import { commitStaging } from '../../../src/pipeline/store/atomic-replace.js';
import { openStagingStore } from '../../../src/pipeline/store/db.js';
import { ApiDataResponse } from '../../../src/shared/contracts.js';

function todayPlusDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function row(partial: Partial<NormalizedRow>): NormalizedRow {
  return {
    source_row_key: 'aaaaaaaaaaaaaaaa',
    invoice_id: null,
    order_code: 'CGLT',
    spreadsheet_id: 'sheet-1',
    tab_name: 'April 2026',
    tab_name_raw: 'April 2026',
    row_index: 2,
    work_status: 'Done',
    is_done: true,
    payment_status: 'paid',
    invoice_type: 'pdf',
    artifact_ref: 'invoice.pdf',
    artifact_status: 'reachable',
    artifact_unreachable_reason: null,
    website: 'a.com',
    website_raw: 'a.com',
    live_url: null,
    native_amount: 100,
    native_currency: 'EUR',
    eur_amount: 100,
    savings_eur: 0,
    ecb_rate: 1,
    ecb_rate_as_of: '2026-04-01',
    conversion_status: 'converted',
    invoice_date: '2026-04-01',
    invoice_month: '2026-04',
    date_source: 'sheet',
    audit_flags: [],
    ...partial,
  };
}

describe('T088 — future_dated_invoice detection', () => {
  it('emits a future_dated_invoice finding for a Done row dated after today', () => {
    const future = todayPlusDays(30);
    const findings = emitFindings([
      row({
        source_row_key: '0000000000000001',
        invoice_date: future,
        invoice_month: future.slice(0, 7),
      }),
    ]);
    const future_dated = findings.filter((f) => f.category === 'future_dated_invoice');
    expect(future_dated).toHaveLength(1);
    expect(future_dated[0]!.summary).toMatch(/in the future/);
  });

  it('does NOT emit future_dated_invoice for a row dated today or earlier', () => {
    const yesterday = todayPlusDays(-1);
    const findings = emitFindings([
      row({ source_row_key: '0000000000000002', invoice_date: yesterday }),
      row({ source_row_key: '0000000000000003', invoice_date: todayPlusDays(0) }),
    ]);
    expect(findings.filter((f) => f.category === 'future_dated_invoice')).toHaveLength(0);
  });

  it('does NOT emit future_dated_invoice for a non-Done row even if dated in the future', () => {
    // Per QA review H10 — both audit_flags and audit_findings are gated on
    // is_done so they agree.
    const future = todayPlusDays(7);
    const findings = emitFindings([
      row({
        source_row_key: '0000000000000004',
        is_done: false,
        work_status: 'Pending',
        invoice_date: future,
      }),
    ]);
    expect(findings.filter((f) => f.category === 'future_dated_invoice')).toHaveLength(0);
  });

  it('does NOT emit future_dated_invoice for an undated row', () => {
    const findings = emitFindings([
      row({
        source_row_key: '0000000000000005',
        invoice_date: null,
        invoice_month: null,
        date_source: 'undated',
      }),
    ]);
    expect(findings.filter((f) => f.category === 'future_dated_invoice')).toHaveLength(0);
  });
});

describe('T089 — empty-category zero-count contract (FR-022)', () => {
  let dataDir: string;
  let configPath: string;
  let pdfRoot: string;

  beforeEach(() => {
    dataDir = mkdtempSync(resolve(tmpdir(), 'audit-cat-test-'));
    pdfRoot = resolve(dataDir, 'pdfs');
    configPath = resolve(dataDir, 'sheets.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        sheets: [
          {
            spreadsheet_id: 'unused',
            order_code: 'CGLT',
            tabs: ['April 2026'],
            column_mapping: { status: 'A', price: 'B' },
          },
        ],
      }),
    );
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('with a clean fixture (zero findings), the API response carries every category key with []', async () => {
    // Build a live store with one clean Done+converted row and NO findings.
    const stagingPath = resolve(dataDir, 'consolidated.sqlite.new');
    const livePath = resolve(dataDir, 'consolidated.sqlite');
    const db = openStagingStore(stagingPath);
    try {
      const counters = JSON.stringify({
        rows_total: 1,
        rows_done: 1,
        rows_excluded_by_status: 0,
        rows_undated: 0,
        rows_out_of_ecb_currency: 0,
        duplicate_invoice_groups: 0,
      });
      db.prepare(
        `INSERT INTO refresh_events (started_at, completed_at, duration_ms, status, triggered_by, per_source, counters)
         VALUES ('2026-04-01T00:00:00Z', '2026-04-01T00:00:01Z', 1000, 'success', 'manual', '[]', @counters)`,
      ).run({ counters });
      db.prepare(
        `INSERT INTO snapshot_metadata (
           singleton_id, schema_version, reporting_year, source_spreadsheet_id, source_tab
         ) VALUES (1, 2, 2026, 'REPORT_2026', 'Clean Data')`,
      ).run();
      db.prepare(
        `INSERT INTO invoices (
           source_row_key, invoice_id, order_code, spreadsheet_id, tab_name,
           tab_name_raw, row_index, work_status, is_done, payment_status,
           invoice_type, artifact_ref, artifact_status, website, website_raw,
           native_amount, native_currency, eur_amount, savings_eur, ecb_rate, ecb_rate_as_of,
           conversion_status, invoice_date, invoice_month, date_source,
           audit_flags, ingested_at
         ) VALUES (
           '0000000000c1ea11', NULL, 'CGLT', 's1', 'April 2026',
           'April 2026', 2, 'Done', 1, 'paid',
           'pdf', 'inv.pdf', 'reachable', 'a.com', 'a.com',
           100, 'EUR', 100, 0, 1.0, '2026-04-01',
           'converted', '2026-04-01', '2026-04', 'sheet',
           '[]', '2026-04-01T00:00:00Z'
         )`,
      ).run();
    } finally {
      db.close();
    }
    commitStaging(stagingPath, livePath);

    const app = await buildServer({ dataDir, sheetsConfigPath: configPath, pdfRoot });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/data' });
      expect(res.statusCode).toBe(200);
      const parsed = ApiDataResponse.safeParse(JSON.parse(res.body));
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      // Every category key MUST be present, with [].
      for (const cat of AUDIT_CATEGORIES_ALL) {
        expect(parsed.data.audit_findings_by_category).toHaveProperty(cat);
        expect(parsed.data.audit_findings_by_category[cat]).toEqual([]);
      }
      // v2-reserved categories specifically — these always emit [] in v1.
      for (const cat of AUDIT_CATEGORIES_V2_RESERVED) {
        expect(parsed.data.audit_findings_by_category[cat]).toEqual([]);
      }
    } finally {
      await app.close();
    }
  });
});
