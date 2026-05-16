/**
 * Integration tests for the consolidate() CLI wrapper, covering:
 *
 *   • Codex review of branch 363b776 → bzj921whd Finding #1 (SSE timing):
 *     `completed` event MUST fire AFTER commitStaging, not before.
 *
 *   • Codex review of branch 363b776 → bzj921whd Finding #2 (all-failed
 *     wipe): a refresh where every source fails MUST NOT overwrite the
 *     prior good live store. The staging file is deleted; the live file
 *     stays untouched.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { consolidate } from '../../src/pipeline/consolidate.js';
import { upsertEcbRate } from '../../src/pipeline/normalize/ecb-cache.js';
import type { RefreshSseEvent } from '../../src/shared/contracts.js';
import { FixtureGws } from '../fixtures/gws/FixtureGws.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const FIXTURES_ROOT = resolve(__dirname, '../fixtures/sheets');

interface TestEnv {
  dataDir: string;
  configPath: string;
  livePath: string;
  stagingPath: string;
}

function makeConfig(spreadsheetId: string, orderCode: string, tabs: string[]): string {
  return JSON.stringify({
    schema_version: 1,
    sheets: [
      {
        spreadsheet_id: spreadsheetId,
        order_code: orderCode,
        tabs,
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
  });
}

function setup(): TestEnv {
  const dataDir = mkdtempSync(resolve(tmpdir(), 'gg-spend-wrapper-'));
  const configPath = resolve(dataDir, 'sheets.json');
  return {
    dataDir,
    configPath,
    livePath: resolve(dataDir, 'consolidated.sqlite'),
    stagingPath: resolve(dataDir, 'consolidated.sqlite.new'),
  };
}

function teardown(env: TestEnv): void {
  rmSync(env.dataDir, { recursive: true, force: true });
}

describe('consolidate() — SSE timing (Codex bzj921whd Finding #1)', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setup();
    writeFileSync(env.configPath, makeConfig('HAPPY', 'HAPPY', ['Previous Orders', 'April 2026']));
  });
  afterEach(() => teardown(env));

  it('emits `completed` ONLY AFTER the live file is durable on disk', async () => {
    const events: Array<{ name: string; liveExists: boolean }> = [];
    const onEvent = (event: RefreshSseEvent): void => {
      events.push({ name: event.event, liveExists: existsSync(env.livePath) });
    };

    await consolidate({
      configPath: env.configPath,
      dataDir: env.dataDir,
      pdfRoot: '/tmp/never-used',
      gwsFactory: () => new FixtureGws({ fixturesRoot: FIXTURES_ROOT }),
      ecbSeeder: async (db) => {
        upsertEcbRate(db, '2026-04-15', 'EUR', 1.0);
      },
      onEvent,
    });

    // Find the `completed` event — it MUST be present and MUST have been
    // observed AFTER the live file existed.
    const completed = events.find((e) => e.name === 'completed');
    expect(completed).toBeDefined();
    expect(completed?.liveExists).toBe(true);

    // Sanity: source_progress events are emitted BEFORE the live file
    // exists (the rename hasn't happened yet at that point).
    const firstProgress = events.find((e) => e.name === 'source_progress');
    expect(firstProgress).toBeDefined();
    expect(firstProgress?.liveExists).toBe(false);
  });
});

describe('consolidate() — partial refresh (T036, T037)', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => teardown(env));

  function partialConfig(): string {
    return JSON.stringify({
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
        {
          spreadsheet_id: 'BROKEN',
          order_code: 'BROKEN',
          tabs: ['April 2026'],
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
    });
  }

  it('T037 — first-ever partial: live store IS created with successful sources only; failed source appears in excluded_order_codes', async () => {
    expect(existsSync(env.livePath)).toBe(false);
    writeFileSync(env.configPath, partialConfig());

    const events: RefreshSseEvent[] = [];
    const result = await consolidate({
      configPath: env.configPath,
      dataDir: env.dataDir,
      pdfRoot: '/tmp/never-used',
      gwsFactory: () =>
        new FixtureGws({
          fixturesRoot: FIXTURES_ROOT,
          failures: { authErrors: new Set(['BROKEN']) },
        }),
      ecbSeeder: async (db) => {
        upsertEcbRate(db, '2026-04-15', 'EUR', 1.0);
      },
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe('partial');
    expect(result.excluded_order_codes).toEqual(['BROKEN']);
    // Live store IS created (partial is honest data; only `failed` blocks commit).
    expect(existsSync(env.livePath)).toBe(true);
    // SSE: completed event (status=partial), no error.
    const completedEvents = events.filter((e) => e.event === 'completed');
    expect(completedEvents).toHaveLength(1);
    expect(events.some((e) => e.event === 'error')).toBe(false);
  });

  it('T036 — partial refresh with existing store: live store updated; HAPPY data present, BROKEN absent; per_source includes the failure', async () => {
    // First run: full success against HAPPY only.
    writeFileSync(
      env.configPath,
      makeConfig('HAPPY', 'HAPPY', ['Previous Orders', 'April 2026']),
    );
    await consolidate({
      configPath: env.configPath,
      dataDir: env.dataDir,
      pdfRoot: '/tmp/never-used',
      gwsFactory: () => new FixtureGws({ fixturesRoot: FIXTURES_ROOT }),
      ecbSeeder: async (db) => {
        upsertEcbRate(db, '2026-04-15', 'EUR', 1.0);
      },
    });
    expect(existsSync(env.livePath)).toBe(true);

    // Second run: switch to a 2-sheet config where one fails.
    writeFileSync(env.configPath, partialConfig());
    const result = await consolidate({
      configPath: env.configPath,
      dataDir: env.dataDir,
      pdfRoot: '/tmp/never-used',
      gwsFactory: () =>
        new FixtureGws({
          fixturesRoot: FIXTURES_ROOT,
          failures: { authErrors: new Set(['BROKEN']) },
        }),
      ecbSeeder: async (db) => {
        upsertEcbRate(db, '2026-04-15', 'EUR', 1.0);
      },
    });

    expect(result.status).toBe('partial');
    expect(result.excluded_order_codes).toEqual(['BROKEN']);
    // per_source includes both sheets (HAPPY success, BROKEN failure).
    const perSourceByCode = new Map(result.per_source.map((s) => [s.order_code, s]));
    expect(perSourceByCode.get('HAPPY')?.status).toBe('success');
    expect(perSourceByCode.get('BROKEN')?.status).toBe('failure');
    expect(perSourceByCode.get('BROKEN')?.rows_pulled).toBe(0);
  });
});

describe('consolidate() — atomic replacement under concurrent reads (T039 — strict)', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setup();
    writeFileSync(env.configPath, makeConfig('HAPPY', 'HAPPY', ['Previous Orders']));
  });
  afterEach(() => teardown(env));

  it('mid-refresh /api/data serves the OLD snapshot until commit; serves the NEW snapshot after', async () => {
    // First refresh: populate the live store with a known snapshot.
    await consolidate({
      configPath: env.configPath,
      dataDir: env.dataDir,
      pdfRoot: '/tmp/never-used',
      gwsFactory: () => new FixtureGws({ fixturesRoot: FIXTURES_ROOT }),
      ecbSeeder: async (db) => {
        upsertEcbRate(db, '2026-04-15', 'EUR', 1.0);
      },
    });
    const bytesBefore = readFileSync(env.livePath);
    expect(bytesBefore.length).toBeGreaterThan(0);

    // Second refresh: pause the seeder so we can read the live file
    // mid-flight, BEFORE commitStaging has run.
    let releasePauseSeeder!: () => void;
    const seederPaused = new Promise<void>((release) => {
      releasePauseSeeder = release;
    });

    const refreshPromise = consolidate({
      configPath: env.configPath,
      dataDir: env.dataDir,
      pdfRoot: '/tmp/never-used',
      gwsFactory: () => new FixtureGws({ fixturesRoot: FIXTURES_ROOT }),
      ecbSeeder: async (db) => {
        upsertEcbRate(db, '2026-04-15', 'EUR', 1.0);
        // Hold the consolidate at this point. runConsolidation hasn't run
        // yet → the staging file is still empty + commit hasn't happened.
        await seederPaused;
      },
    });

    // Yield the event loop so consolidate enters the seeder.
    await new Promise<void>((r) => setTimeout(r, 50));

    // CRITICAL: live file MUST exist with the OLD bytes. The .new staging
    // file may exist alongside, but the LIVE path is unchanged because
    // commitStaging hasn't run yet.
    expect(existsSync(env.livePath)).toBe(true);
    const bytesMidRefresh = readFileSync(env.livePath);
    expect(
      bytesMidRefresh.equals(bytesBefore),
      'mid-refresh: live store MUST be unchanged until commitStaging',
    ).toBe(true);

    // Release the seeder; refresh proceeds through runConsolidation,
    // commitStaging atomically renames staging → live.
    releasePauseSeeder();
    await refreshPromise;

    // After commit: live exists, bytes have changed (new ingested_at).
    expect(existsSync(env.livePath)).toBe(true);
    const bytesAfter = readFileSync(env.livePath);
    expect(
      bytesAfter.equals(bytesBefore),
      'after commit: live store MUST be replaced (different bytes)',
    ).toBe(false);

    // Staging cleaned up.
    expect(existsSync(env.stagingPath)).toBe(false);
    // Staging file cleaned up.
    expect(existsSync(env.stagingPath)).toBe(false);
  });
});

describe('consolidate() — all-source-failed must not wipe prior snapshot (Codex bzj921whd Finding #2)', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setup();
    writeFileSync(env.configPath, makeConfig('FAILS', 'FAILS', ['April 2026']));
  });
  afterEach(() => teardown(env));

  it('first-ever all-failed: no live store created; staging file deleted; SSE emits error', async () => {
    expect(existsSync(env.livePath)).toBe(false);

    const events: RefreshSseEvent[] = [];
    const result = await consolidate({
      configPath: env.configPath,
      dataDir: env.dataDir,
      pdfRoot: '/tmp/never-used',
      gwsFactory: () =>
        new FixtureGws({
          fixturesRoot: FIXTURES_ROOT,
          failures: { authErrors: new Set(['FAILS']) },
        }),
      ecbSeeder: async () => {
        // no-op
      },
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe('failed');
    expect(existsSync(env.livePath)).toBe(false); // never created
    expect(existsSync(env.stagingPath)).toBe(false); // cleaned up

    // SSE must emit `error`, NOT `completed`.
    expect(events.some((e) => e.event === 'error')).toBe(true);
    expect(events.some((e) => e.event === 'completed')).toBe(false);
  });

  it('existing-store all-failed: prior live store stays untouched; bytes unchanged', async () => {
    // First run: succeed against HAPPY to populate the live store.
    writeFileSync(
      env.configPath,
      makeConfig('HAPPY', 'HAPPY', ['Previous Orders', 'April 2026']),
    );
    await consolidate({
      configPath: env.configPath,
      dataDir: env.dataDir,
      pdfRoot: '/tmp/never-used',
      gwsFactory: () => new FixtureGws({ fixturesRoot: FIXTURES_ROOT }),
      ecbSeeder: async (db) => {
        upsertEcbRate(db, '2026-04-15', 'EUR', 1.0);
      },
    });
    expect(existsSync(env.livePath)).toBe(true);
    const goodBytesBefore = readFileSync(env.livePath);

    // Second run: switch the config to a sheet that fails entirely.
    writeFileSync(env.configPath, makeConfig('FAILS', 'FAILS', ['April 2026']));
    const events: RefreshSseEvent[] = [];
    const result = await consolidate({
      configPath: env.configPath,
      dataDir: env.dataDir,
      pdfRoot: '/tmp/never-used',
      gwsFactory: () =>
        new FixtureGws({
          fixturesRoot: FIXTURES_ROOT,
          failures: { authErrors: new Set(['FAILS']) },
        }),
      ecbSeeder: async () => {
        // no-op
      },
      onEvent: (e) => events.push(e),
    });

    expect(result.status).toBe('failed');
    // Live store byte-equal to before — proves the rename did NOT happen.
    const goodBytesAfter = readFileSync(env.livePath);
    expect(goodBytesAfter.equals(goodBytesBefore)).toBe(true);
    // Staging cleaned up.
    expect(existsSync(env.stagingPath)).toBe(false);
    // SSE: error, no completed.
    expect(events.some((e) => e.event === 'error')).toBe(true);
    expect(events.some((e) => e.event === 'completed')).toBe(false);
  });
});
