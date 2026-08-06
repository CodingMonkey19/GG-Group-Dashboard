import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseT } from 'better-sqlite3';
import { buildServer } from '../../src/api/server.js';
import { commitStaging } from '../../src/pipeline/store/atomic-replace.js';
import { openStagingStore } from '../../src/pipeline/store/db.js';

interface SeedInvoice {
  source_row_key: string;
  invoice_date?: string;
  invoice_month?: string;
  savings_eur?: number;
}

function seedRefresh(db: DatabaseT, rowCount: number): void {
  db.prepare(
    `INSERT INTO refresh_events (started_at, completed_at, duration_ms, status, triggered_by, counters)
     VALUES ('2026-04-01T00:00:00Z', '2026-04-01T00:00:01Z', 1000, 'success', 'manual',
       @counters)`,
  ).run({ counters: JSON.stringify({
    rows_total: rowCount,
    rows_done: rowCount,
    rows_excluded_by_status: 0,
    rows_undated: 0,
    rows_out_of_ecb_currency: 0,
    duplicate_invoice_groups: 0,
  }) });
}

function seedMetadata(db: DatabaseT): void {
  db.prepare(
    `INSERT INTO snapshot_metadata (
       singleton_id, schema_version, reporting_year, source_spreadsheet_id, source_tab
     ) VALUES (1, 2, 2026, 'REPORT_2026', 'Clean Data')`,
  ).run();
}

function seedInvoice(db: DatabaseT, row: SeedInvoice): void {
  const invoiceDate = row.invoice_date ?? '2026-04-01';
  db.prepare(
    `INSERT INTO invoices (
       source_row_key, invoice_id, order_code, spreadsheet_id, tab_name,
       tab_name_raw, row_index, work_status, is_done, payment_status,
       invoice_type, artifact_ref, artifact_status, website, website_raw,
       native_amount, native_currency, eur_amount, savings_eur, ecb_rate, ecb_rate_as_of,
       conversion_status, invoice_date, invoice_month, date_source, audit_flags, ingested_at
     ) VALUES (
       @source_row_key, NULL, 'ORDER-A', 'REPORT_2026', 'Clean Data',
       'Clean Data', 2, 'Done', 1, 'paid',
       'pdf', 'invoice.pdf', 'reachable', 'example.com', 'example.com',
       100, 'EUR', 100, @savings_eur, 1, '2026-04-01',
       'converted', @invoice_date, @invoice_month, 'sheet', '[]', '2026-04-01T00:00:00Z'
     )`,
  ).run({
    source_row_key: row.source_row_key,
    savings_eur: row.savings_eur ?? 10.5,
    invoice_date: invoiceDate,
    invoice_month: row.invoice_month ?? invoiceDate.slice(0, 7),
  });
}

function publishStore(
  dataDir: string,
  options: { metadata?: boolean; userVersion?: number; invoice?: SeedInvoice; ignoreChecks?: boolean },
): void {
  const stagingPath = resolve(dataDir, 'consolidated.sqlite.new');
  const livePath = resolve(dataDir, 'consolidated.sqlite');
  const db = openStagingStore(stagingPath);
  try {
    if (options.userVersion !== undefined) db.pragma(`user_version = ${options.userVersion}`);
    if (options.metadata) seedMetadata(db);
    seedRefresh(db, options.invoice === undefined ? 0 : 1);
    if (options.invoice !== undefined) {
      if (options.ignoreChecks) db.pragma('ignore_check_constraints = ON');
      seedInvoice(db, options.invoice);
      if (options.ignoreChecks) db.pragma('ignore_check_constraints = OFF');
    }
  } finally {
    db.close();
  }
  commitStaging(stagingPath, livePath);
}

describe('v2 snapshot API boundaries', () => {
  let dataDir: string;
  let configPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(resolve(tmpdir(), 'snapshot-boundary-'));
    configPath = resolve(dataDir, 'sheets.json');
    writeFileSync(configPath, JSON.stringify({
      schema_version: 1,
      sheets: [{
        spreadsheet_id: 'unused', order_code: 'ORDER-A', tabs: ['Clean Data'],
        column_mapping: { status: 'A', price: 'B' },
      }],
    }));
  });

  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('rejects a legacy v1/no-metadata snapshot without exposing invoice data', async () => {
    publishStore(dataDir, {
      userVersion: 1,
      invoice: { source_row_key: '0000000000000001' },
    });
    const app = await buildServer({ dataDir, sheetsConfigPath: configPath });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/data' });
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body)).toEqual({ error: 'incompatible_snapshot' });
      expect(response.body).not.toContain('invoices');
    } finally {
      await app.close();
    }
  });

  it('rejects a metadata-marked snapshot containing a manually injected 2025 row on data and artifact routes', async () => {
    publishStore(dataDir, {
      metadata: true,
      ignoreChecks: true,
      invoice: {
        source_row_key: '0000000000000002',
        invoice_date: '2025-12-31',
        invoice_month: '2025-12',
      },
    });
    const app = await buildServer({ dataDir, sheetsConfigPath: configPath });
    try {
      const data = await app.inject({ method: 'GET', url: '/api/data' });
      expect(data.statusCode).toBe(503);
      expect(JSON.parse(data.body)).toEqual({ error: 'incompatible_snapshot' });
      expect(data.body).not.toContain('invoices');

      const artifact = await app.inject({ method: 'GET', url: '/api/artifact/0000000000000002' });
      expect(artifact.statusCode).toBe(503);
      expect(JSON.parse(artifact.body)).toEqual({ error: 'incompatible_snapshot' });
    } finally {
      await app.close();
    }
  });

  it('rejects a metadata-marked snapshot containing a manually injected malformed date', async () => {
    publishStore(dataDir, {
      metadata: true,
      ignoreChecks: true,
      invoice: {
        source_row_key: '0000000000000004',
        invoice_date: '2026-not-a-date',
        invoice_month: '2026-not',
      },
    });
    const app = await buildServer({ dataDir, sheetsConfigPath: configPath });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/data' });
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body)).toEqual({ error: 'incompatible_snapshot' });
    } finally {
      await app.close();
    }
  });

  it('treats a metadata-marked empty v2 snapshot as refreshed rather than never_refreshed', async () => {
    publishStore(dataDir, { metadata: true });
    const app = await buildServer({ dataDir, sheetsConfigPath: configPath });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/data' });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        schema_version: 2,
        reporting_year: 2026,
        refresh_status: 'success',
        invoices: [],
      });
    } finally {
      await app.close();
    }
  });

  it('returns a valid v2 2026-only snapshot with persisted finite savings', async () => {
    publishStore(dataDir, {
      metadata: true,
      invoice: { source_row_key: '0000000000000003', savings_eur: 12.75 },
    });
    const app = await buildServer({ dataDir, sheetsConfigPath: configPath });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/data' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.schema_version).toBe(2);
      expect(body.reporting_year).toBe(2026);
      expect(body.invoices).toHaveLength(1);
      expect(body.invoices[0]).toMatchObject({ savings_eur: 12.75, invoice_date: '2026-04-01' });
      expect(body.invoices.every((row: { invoice_date: string; invoice_month: string; savings_eur: number }) =>
        row.invoice_date.startsWith('2026-') &&
        row.invoice_month.startsWith('2026-') &&
        Number.isFinite(row.savings_eur),
      )).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('publishes February onward by reporting month while retaining shifted January invoice dates', async () => {
    const stagingPath = resolve(dataDir, 'consolidated.sqlite.new');
    const livePath = resolve(dataDir, 'consolidated.sqlite');
    const db = openStagingStore(stagingPath);
    try {
      seedMetadata(db);
      seedRefresh(db, 2);
      seedInvoice(db, {
        source_row_key: '0000000000000010',
        invoice_date: '2026-01-10',
        invoice_month: '2026-01',
      });
      seedInvoice(db, {
        source_row_key: '0000000000000020',
        invoice_date: '2027-01-20',
        invoice_month: '2026-02',
      });
    } finally {
      db.close();
    }
    commitStaging(stagingPath, livePath);

    const app = await buildServer({ dataDir, sheetsConfigPath: configPath });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/data' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.invoices).toHaveLength(1);
      expect(body.invoices[0]).toMatchObject({
        source_row_key: '0000000000000020',
        invoice_date: '2027-01-20',
        invoice_month: '2026-02',
      });
    } finally {
      await app.close();
    }
  });
});
