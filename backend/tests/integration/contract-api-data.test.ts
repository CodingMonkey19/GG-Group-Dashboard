/**
 * T040 — Contract test for GET /api/data envelope.
 *
 * Boots the Fastify server against a tmp data dir, runs consolidate to
 * populate the store, then issues GET /api/data and zod-validates the
 * response against ApiDataResponse.
 *
 * Asserts:
 *   • zod parse succeeds (envelope shape matches contracts/api-data.md)
 *   • Every audit category key is present (FR-022), even when empty
 *   • excluded_order_codes is always an array
 *   • Every InvoiceRow source_row_key matches the 16-char hex pattern
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { consolidate } from '../../src/pipeline/consolidate.js';
import {
  ApiDataResponse,
  AUDIT_CATEGORIES_ALL,
} from '../../src/shared/contracts.js';
import { upsertEcbRate } from '../../src/pipeline/normalize/ecb-cache.js';
import { openStagingStore } from '../../src/pipeline/store/db.js';
import { FixtureGws } from '../fixtures/gws/FixtureGws.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const FIXTURES_ROOT = resolve(__dirname, '../fixtures/sheets');

describe('GET /api/data contract (T040)', () => {
  let dataDir: string;
  let configPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(resolve(tmpdir(), 'gg-spend-test-'));
    configPath = resolve(dataDir, 'sheets.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        sheets: [
          {
            spreadsheet_id: 'HAPPY',
            order_code: 'HAPPY',
            tabs: ['Previous Orders', 'April 2026'],
            column_mapping: {
              status: 'A',
              link_builder: 'B',
              website: 'C',
              price: 'D',
              invoice_date: 'E',
              invoice_url: 'F',
              invoice_status: 'G',
            },
          },
        ],
      }),
    );
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns 503 never_refreshed when no consolidation has run', async () => {
    const app = await buildServer({ dataDir, sheetsConfigPath: configPath });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/data' });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toEqual({ error: 'never_refreshed' });
    } finally {
      await app.close();
    }
  });

  it('returns a zod-valid ApiDataResponse after consolidation; every audit category key present', async () => {
    // Pre-seed the staging file with ECB rates so consolidate doesn't hit
    // the network (and so this test is offline-deterministic).
    const stagingPath = resolve(dataDir, 'consolidated.sqlite.new');
    {
      const seed = openStagingStore(stagingPath);
      try {
        upsertEcbRate(seed, '2026-04-15', 'EUR', 1.0);
      } finally {
        seed.close();
      }
    }

    await consolidate({
      configPath,
      dataDir,
      pdfRoot: '/tmp/never-used',
      gwsFactory: () => new FixtureGws({ fixturesRoot: FIXTURES_ROOT }),
      ecbSeeder: async (db) => {
        // No-op: the staging file we pre-seeded was discarded by consolidate
        // (it deletes any leftover .new) — re-seed in the seeder hook so the
        // EUR rate is present in the actual store consolidate uses.
        upsertEcbRate(db, '2026-04-15', 'EUR', 1.0);
      },
    });
    expect(existsSync(resolve(dataDir, 'consolidated.sqlite'))).toBe(true);

    const app = await buildServer({ dataDir, sheetsConfigPath: configPath });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/data' });
      expect(res.statusCode).toBe(200);

      const parsed = ApiDataResponse.safeParse(JSON.parse(res.body));
      if (!parsed.success) {
        // Surface the zod issues on failure so the test message is actionable.
        // eslint-disable-next-line no-console
        console.error(JSON.stringify(parsed.error.issues, null, 2));
      }
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const data = parsed.data;
      expect(data.schema_version).toBe(1);
      expect(data.refresh_status).toBe('success');
      expect(Array.isArray(data.excluded_order_codes)).toBe(true);
      expect(data.excluded_order_codes).toEqual([]);

      // Counters invariant.
      expect(data.counters.rows_total).toBe(
        data.counters.rows_done + data.counters.rows_excluded_by_status,
      );

      // Every audit category key MUST be present (FR-022), even with [].
      for (const cat of AUDIT_CATEGORIES_ALL) {
        expect(data.audit_findings_by_category).toHaveProperty(cat);
        expect(Array.isArray(data.audit_findings_by_category[cat])).toBe(true);
      }

      // Every InvoiceRow has a 16-char hex source_row_key.
      for (const row of data.invoices) {
        expect(row.source_row_key).toMatch(/^[0-9a-f]{16}$/);
      }
    } finally {
      await app.close();
    }
  });
});
