/**
 * T041 — Contract test for POST /api/refresh SSE (strict).
 *
 * Boots Fastify with a FixtureGws + a no-network ecbSeeder injected via
 * ServerOptions, POSTs /api/refresh, parses the SSE response body, and
 * asserts the FULL contract from contracts/api-refresh.md:
 *
 *   • event ordering: started → source_progress (×N) → phase (×5) → completed
 *   • phase events in order: ingest, extract, normalize, audit, store
 *   • completed.counters has every required key
 *   • status === 'success' on the clean fixture (no error fallback path)
 *   • counter invariant: rows_total === rows_done + rows_excluded_by_status
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { upsertEcbRate } from '../../src/pipeline/normalize/ecb-cache.js';
import { FixtureGws } from '../fixtures/gws/FixtureGws.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const FIXTURES_ROOT = resolve(__dirname, '../fixtures/sheets');

interface ParsedSseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseSseStream(raw: string): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = [];
  for (const frame of raw.split('\n\n')) {
    if (frame.trim().length === 0) continue;
    let eventName: string | null = null;
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (eventName === null || dataLines.length === 0) continue;
    try {
      events.push({
        event: eventName,
        data: JSON.parse(dataLines.join('\n')) as Record<string, unknown>,
      });
    } catch {
      // Skip malformed.
    }
  }
  return events;
}

describe('POST /api/refresh SSE contract (T041 — strict)', () => {
  let dataDir: string;
  let configPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(resolve(tmpdir(), 'gg-spend-refresh-test-'));
    configPath = resolve(dataDir, 'sheets.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        sheets: [
          {
            spreadsheet_id: 'HAPPY',
            order_code: 'HAPPY',
            tabs: ['Previous Orders'],
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

  it('emits started → source_progress → phase[5] → completed in order; counters complete; status=success', async () => {
    const app = await buildServer({
      dataDir,
      sheetsConfigPath: configPath,
      gwsFactory: () => new FixtureGws({ fixturesRoot: FIXTURES_ROOT }),
      ecbSeeder: async (db) => {
        upsertEcbRate(db, '2026-04-15', 'EUR', 1.0);
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/refresh',
        headers: { Accept: 'text/event-stream' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/event-stream/);

      const events = parseSseStream(res.body);
      expect(events.length).toBeGreaterThan(0);

      const eventNames = events.map((e) => e.event);

      // Strict ordering. Realistic flow:
      //   started → phase[ingest] → source_progress (×N) → phase[extract,
      //   normalize, audit, store] → completed
      // (source_progress events happen DURING the ingest phase, so phase[ingest]
      //  precedes them.)
      const firstStarted = eventNames.indexOf('started');
      const firstSourceProgress = eventNames.indexOf('source_progress');
      const firstCompleted = eventNames.indexOf('completed');
      const phaseIndices = events
        .map((e, i) => (e.event === 'phase' ? { i, phase: e.data.phase as string } : null))
        .filter((x): x is { i: number; phase: string } => x !== null);
      const ingestIdx = phaseIndices.find((p) => p.phase === 'ingest')?.i ?? -1;
      const extractIdx = phaseIndices.find((p) => p.phase === 'extract')?.i ?? -1;

      expect(firstStarted, '`started` must be the first event').toBe(0);
      expect(ingestIdx, '`phase: ingest` must come after `started`').toBeGreaterThan(firstStarted);
      expect(
        firstSourceProgress,
        '`source_progress` must come after `phase: ingest`',
      ).toBeGreaterThan(ingestIdx);
      expect(extractIdx, '`phase: extract` must come after first `source_progress`').toBeGreaterThan(
        firstSourceProgress,
      );
      expect(firstCompleted, '`completed` must be the LAST event').toBe(events.length - 1);

      // No error event on the success path.
      expect(eventNames, 'no error event on success path').not.toContain('error');

      // Exactly 5 phase events in the documented order.
      const phaseNames = phaseIndices.map((p) => p.phase);
      expect(phaseNames).toEqual(['ingest', 'extract', 'normalize', 'audit', 'store']);

      // completed event payload (NON-NEGOTIABLE per contracts/api-refresh.md).
      const completed = events[firstCompleted]?.data;
      expect(completed).toBeDefined();
      if (!completed) return;
      expect(completed.status).toBe('success');
      expect(completed.refresh_id).toBeTypeOf('number');
      expect(completed.completed_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
      );
      expect(completed.duration_ms).toBeTypeOf('number');

      // Counters object includes EVERY required key.
      const counters = completed.counters as Record<string, unknown>;
      expect(counters).toBeDefined();
      for (const k of [
        'rows_total',
        'rows_done',
        'rows_excluded_by_status',
        'rows_undated',
        'rows_out_of_ecb_currency',
        'duplicate_invoice_groups',
      ]) {
        expect(counters, `counters missing key ${k}`).toHaveProperty(k);
        expect(counters[k]).toBeTypeOf('number');
      }

      // Counter invariant.
      expect(counters.rows_total).toBe(
        (counters.rows_done as number) + (counters.rows_excluded_by_status as number),
      );
    } finally {
      await app.close();
    }
  });

  it('uses the started refresh ID when report_source fails after allocation', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        report_source: {
          spreadsheet_id: 'REPORT_2026',
          data_tab: 'Clean Data',
          monthly_summary_tab: 'Monthly Spending',
          order_summary_tab: 'Order Summary',
          reporting_year: 2026,
          headers: {
            order: 'Order',
            source_tab: 'Source Tab',
            source_row: 'Source Row',
            invoice_date: 'Invoice Date',
            reporting_month: 'Month',
            link_builder: 'Link Builder',
            website: 'Website',
            target_url: 'Target URL',
            anchor: 'Anchor',
            spend_eur: 'Price (EUR)',
            presswhizz_price_eur: 'PressWhizz Price (EUR)',
            invoice_url: 'Invoice',
            live_url: 'Live URL',
            invoice_status: 'Invoice Status',
            included: 'Included in Reporting Period',
            data_quality_issue: 'Data Quality Issue',
            savings_eur: 'Saving (EUR)',
          },
        },
      }),
    );
    const app = await buildServer({
      dataDir,
      sheetsConfigPath: configPath,
      gwsFactory: () => new FixtureGws({
        fixturesRoot: FIXTURES_ROOT,
        failures: { authErrors: new Set(['REPORT_2026']) },
      }),
      ecbSeeder: async () => {
        // no-op
      },
    });

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/refresh',
        headers: { Accept: 'text/event-stream' },
      });
      const events = parseSseStream(res.body);
      const started = events.find((event) => event.event === 'started');
      const error = events.find((event) => event.event === 'error');

      expect(started).toBeDefined();
      expect(error).toBeDefined();
      expect(started?.data.refresh_id).toBeTypeOf('number');
      expect(started?.data.refresh_id).toBeGreaterThan(0);
      expect(error?.data.refresh_id).toBe(started?.data.refresh_id);
      expect(events.some((event) => event.event === 'completed')).toBe(false);
    } finally {
      await app.close();
    }
  });
});
