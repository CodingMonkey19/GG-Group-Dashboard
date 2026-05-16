/**
 * T077–T081 + T081a — Contract tests for GET /api/artifact/:source_row_key.
 *
 * Per contracts/api-artifact.md:
 *   T077 pdf success            → 200 application/pdf
 *   T078 path-escape            → 400
 *   T079 drive_pdf success      → 200 application/pdf (via stubbed gws)
 *   T080 paypal                 → 409 use_direct_url
 *   T081 missing                → 404
 *   T081a refresh stability     → source_row_key remains valid across refresh;
 *                                 a removed row → 404 after re-ingest.
 *
 * The handler is exercised with `app.inject` rather than a real socket so the
 * tests stay offline and fast. Rows are seeded directly into a staging SQLite
 * store with the same schema the pipeline writes; we then fsync-rename it
 * into place via commitStaging so the API sees a real live store.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseT } from 'better-sqlite3';
import { buildServer } from '../../src/api/server.js';
import { commitStaging } from '../../src/pipeline/store/atomic-replace.js';
import { openStagingStore } from '../../src/pipeline/store/db.js';
import type { GwsWrapper } from '../../src/pipeline/ingest/gws.js';
import { FixtureGws } from '../fixtures/gws/FixtureGws.js';

interface SeedRow {
  source_row_key: string;
  invoice_type: 'paypal' | 'pdf' | 'drive_pdf' | 'intuit' | 'text' | 'missing';
  artifact_ref: string | null;
  order_code?: string;
  row_index?: number;
}

function seedInvoice(db: DatabaseT, partial: SeedRow): void {
  db.prepare(
    `INSERT INTO invoices (
       source_row_key, invoice_id, order_code, spreadsheet_id, tab_name,
       tab_name_raw, row_index, work_status, is_done, payment_status,
       invoice_type, artifact_ref, artifact_status, website, website_raw,
       native_amount, native_currency, eur_amount, ecb_rate, ecb_rate_as_of,
       conversion_status, invoice_date, invoice_month, date_source,
       audit_flags, ingested_at
     ) VALUES (
       @source_row_key, NULL, @order_code, 'sheet-1', 'April 2026',
       'April 2026', @row_index, 'Done', 1, 'paid',
       @invoice_type, @artifact_ref, 'reachable', 'example.com', 'example.com',
       100, 'EUR', 100, 1.0, '2026-04-01',
       'converted', '2026-04-01', '2026-04', 'sheet',
       '[]', '2026-04-01T00:00:00Z'
     )`,
  ).run({
    source_row_key: partial.source_row_key,
    invoice_type: partial.invoice_type,
    artifact_ref: partial.artifact_ref,
    order_code: partial.order_code ?? 'CGLT',
    row_index: partial.row_index ?? 2,
  });
}

function seedRefreshEvent(db: DatabaseT): void {
  db.prepare(
    `INSERT INTO refresh_events (started_at, completed_at, duration_ms, status, triggered_by)
     VALUES ('2026-04-01T00:00:00Z', '2026-04-01T00:00:01Z', 1000, 'success', 'manual')`,
  ).run();
}

/** Stand up a live consolidated store seeded with the given rows. */
function buildLiveStore(dataDir: string, rows: SeedRow[]): void {
  const stagingPath = resolve(dataDir, 'consolidated.sqlite.new');
  const livePath = resolve(dataDir, 'consolidated.sqlite');
  const db = openStagingStore(stagingPath);
  try {
    seedRefreshEvent(db);
    for (const r of rows) seedInvoice(db, r);
  } finally {
    db.close();
  }
  commitStaging(stagingPath, livePath);
}

describe('GET /api/artifact/:source_row_key (T077–T081 + T081a)', () => {
  let dataDir: string;
  let configPath: string;
  let pdfRoot: string;

  beforeEach(() => {
    dataDir = mkdtempSync(resolve(tmpdir(), 'artifact-test-'));
    pdfRoot = resolve(dataDir, 'pdfs');
    mkdirSync(pdfRoot);
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

  it('rejects malformed source_row_key with 400 (FR-026)', async () => {
    buildLiveStore(dataDir, []);
    const app = await buildServer({ dataDir, sheetsConfigPath: configPath, pdfRoot });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/artifact/not-hex' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid_source_row_key' });
    } finally {
      await app.close();
    }
  });

  it('returns 404 not_found when source_row_key has no row in the snapshot', async () => {
    buildLiveStore(dataDir, []);
    const app = await buildServer({ dataDir, sheetsConfigPath: configPath, pdfRoot });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/artifact/0000000000000000' });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    } finally {
      await app.close();
    }
  });

  // T077 — pdf success.
  it('streams a local PDF for invoice_type=pdf (200 application/pdf, byte-equal)', async () => {
    const pdfPath = resolve(pdfRoot, 'invoice.pdf');
    const bytes = Buffer.from('%PDF-1.4\n%fake pdf bytes for test\n%%EOF\n');
    writeFileSync(pdfPath, bytes);

    buildLiveStore(dataDir, [
      {
        source_row_key: '00000000000000aa',
        invoice_type: 'pdf',
        artifact_ref: 'invoice.pdf',
      },
    ]);

    const app = await buildServer({ dataDir, sheetsConfigPath: configPath, pdfRoot });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/artifact/00000000000000aa' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toMatch(/^inline; filename=/);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.from(res.rawPayload)).toEqual(bytes);
    } finally {
      await app.close();
    }
  });

  // T078 — path escape.
  it('returns 400 path_escape when artifact_ref resolves outside pdf_root', async () => {
    buildLiveStore(dataDir, [
      {
        source_row_key: '00000000000000bb',
        invoice_type: 'pdf',
        artifact_ref: '../../etc/passwd',
      },
    ]);

    const app = await buildServer({ dataDir, sheetsConfigPath: configPath, pdfRoot });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/artifact/00000000000000bb' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'path_escape' });
    } finally {
      await app.close();
    }
  });

  // T079 — drive_pdf success (stubbed gws).
  it('proxies drive_pdf bytes via the gws wrapper (200 application/pdf)', async () => {
    const driveUrl = 'https://drive.google.com/file/d/abc123/view';
    const bytes = Buffer.from('%PDF-1.4\n%drive pdf body\n%%EOF\n');
    buildLiveStore(dataDir, [
      {
        source_row_key: '00000000000000cc',
        invoice_type: 'drive_pdf',
        artifact_ref: driveUrl,
      },
    ]);

    const stubGws: () => GwsWrapper = () =>
      new FixtureGws({
        driveBytes: new Map([[driveUrl, bytes]]),
      });

    const app = await buildServer({
      dataDir,
      sheetsConfigPath: configPath,
      pdfRoot,
      gwsFactory: stubGws,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/artifact/00000000000000cc' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(Buffer.from(res.rawPayload)).toEqual(bytes);
    } finally {
      await app.close();
    }
  });

  // T080 — paypal returns 409 use_direct_url.
  it('returns 409 use_direct_url for invoice_type=paypal', async () => {
    const paypalUrl = 'https://www.paypal.com/invoice/p/#PAYINV-1';
    buildLiveStore(dataDir, [
      {
        source_row_key: '00000000000000dd',
        invoice_type: 'paypal',
        artifact_ref: paypalUrl,
      },
    ]);
    const app = await buildServer({ dataDir, sheetsConfigPath: configPath, pdfRoot });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/artifact/00000000000000dd' });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: 'use_direct_url', url: paypalUrl });
    } finally {
      await app.close();
    }
  });

  it('returns 409 use_direct_url for invoice_type=intuit (same pattern as paypal)', async () => {
    const intuitUrl = 'https://intuit.example/invoice/123';
    buildLiveStore(dataDir, [
      {
        source_row_key: '00000000000000ee',
        invoice_type: 'intuit',
        artifact_ref: intuitUrl,
      },
    ]);
    const app = await buildServer({ dataDir, sheetsConfigPath: configPath, pdfRoot });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/artifact/00000000000000ee' });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: 'use_direct_url', url: intuitUrl });
    } finally {
      await app.close();
    }
  });

  it('returns 409 no_artifact_to_proxy with the text body for invoice_type=text', async () => {
    buildLiveStore(dataDir, [
      {
        source_row_key: '00000000000000ff',
        invoice_type: 'text',
        artifact_ref: 'paid in cash 2026-04',
      },
    ]);
    const app = await buildServer({ dataDir, sheetsConfigPath: configPath, pdfRoot });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/artifact/00000000000000ff' });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body)).toEqual({
        error: 'no_artifact_to_proxy',
        text: 'paid in cash 2026-04',
      });
    } finally {
      await app.close();
    }
  });

  // T081 — missing invoice type.
  it('returns 404 no_artifact for invoice_type=missing', async () => {
    buildLiveStore(dataDir, [
      {
        source_row_key: '0000000000000abc',
        invoice_type: 'missing',
        artifact_ref: null,
      },
    ]);
    const app = await buildServer({ dataDir, sheetsConfigPath: configPath, pdfRoot });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/artifact/0000000000000abc' });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'no_artifact' });
    } finally {
      await app.close();
    }
  });

  // T081a — refresh stability.
  it('source_row_key resolves the same row across refreshes; removed row → 404 after re-ingest', async () => {
    const pdfPath = resolve(pdfRoot, 'first.pdf');
    writeFileSync(pdfPath, Buffer.from('%PDF-1.4\nfirst\n%%EOF'));

    // Refresh #1: row exists.
    buildLiveStore(dataDir, [
      {
        source_row_key: '0000000000001111',
        invoice_type: 'pdf',
        artifact_ref: 'first.pdf',
      },
    ]);
    {
      const app = await buildServer({ dataDir, sheetsConfigPath: configPath, pdfRoot });
      try {
        const res = await app.inject({ method: 'GET', url: '/api/artifact/0000000000001111' });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    }

    // Refresh #2: same row + a new row. Existing row's source_row_key still resolves.
    writeFileSync(resolve(pdfRoot, 'second.pdf'), Buffer.from('%PDF-1.4\nsecond\n%%EOF'));
    buildLiveStore(dataDir, [
      {
        source_row_key: '0000000000001111',
        invoice_type: 'pdf',
        artifact_ref: 'first.pdf',
      },
      {
        source_row_key: '0000000000002222',
        invoice_type: 'pdf',
        artifact_ref: 'second.pdf',
      },
    ]);
    {
      const app = await buildServer({ dataDir, sheetsConfigPath: configPath, pdfRoot });
      try {
        const a = await app.inject({ method: 'GET', url: '/api/artifact/0000000000001111' });
        expect(a.statusCode).toBe(200);
        const b = await app.inject({ method: 'GET', url: '/api/artifact/0000000000002222' });
        expect(b.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    }

    // Refresh #3: original row removed (source row deleted from sheet).
    // Its source_row_key no longer resolves → 404, never a wrong-document.
    buildLiveStore(dataDir, [
      {
        source_row_key: '0000000000002222',
        invoice_type: 'pdf',
        artifact_ref: 'second.pdf',
      },
    ]);
    {
      const app = await buildServer({ dataDir, sheetsConfigPath: configPath, pdfRoot });
      try {
        const a = await app.inject({ method: 'GET', url: '/api/artifact/0000000000001111' });
        expect(a.statusCode).toBe(404);
        const b = await app.inject({ method: 'GET', url: '/api/artifact/0000000000002222' });
        expect(b.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    }
  });

  it('honors ?disposition=attachment by setting Content-Disposition: attachment', async () => {
    const pdfPath = resolve(pdfRoot, 'invoice.pdf');
    writeFileSync(pdfPath, Buffer.from('%PDF-1.4\nzz\n%%EOF'));
    buildLiveStore(dataDir, [
      {
        source_row_key: '00000000000033cc',
        invoice_type: 'pdf',
        artifact_ref: 'invoice.pdf',
      },
    ]);
    const app = await buildServer({ dataDir, sheetsConfigPath: configPath, pdfRoot });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/artifact/00000000000033cc?disposition=attachment',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename=/);
    } finally {
      await app.close();
    }
  });

  it('returns 502 when gws auth fails on a drive_pdf fetch', async () => {
    const driveUrl = 'https://drive.google.com/file/d/badauth/view';
    buildLiveStore(dataDir, [
      {
        source_row_key: '0000000000004444',
        invoice_type: 'drive_pdf',
        artifact_ref: driveUrl,
      },
    ]);
    // Note: FixtureGws lacks an "auth error on bytes" injection; reuse the
    // generic-error path which maps to 502 via the same branch.
    const failingGws: () => GwsWrapper = () =>
      new FixtureGws({
        failures: { driveBytesErrors: new Set([driveUrl]) },
      });
    const app = await buildServer({
      dataDir,
      sheetsConfigPath: configPath,
      pdfRoot,
      gwsFactory: failingGws,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/artifact/0000000000004444' });
      expect(res.statusCode).toBe(502);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('drive_fetch_failed');
    } finally {
      await app.close();
    }
  });

  it('returns 404 drive_not_found when gws reports the Drive file is missing', async () => {
    const driveUrl = 'https://drive.google.com/file/d/missing/view';
    buildLiveStore(dataDir, [
      {
        source_row_key: '0000000000005555',
        invoice_type: 'drive_pdf',
        artifact_ref: driveUrl,
      },
    ]);
    const missingGws: () => GwsWrapper = () =>
      new FixtureGws({
        failures: { driveBytesNotFound: new Set([driveUrl]) },
      });
    const app = await buildServer({
      dataDir,
      sheetsConfigPath: configPath,
      pdfRoot,
      gwsFactory: missingGws,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/artifact/0000000000005555' });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'drive_not_found' });
    } finally {
      await app.close();
    }
  });
});
