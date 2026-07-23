/**
 * Consolidation entry point (T054).
 *
 * Two surfaces:
 *   1. `runConsolidation(db, opts)` — pure pipeline. Takes an OPEN, writable
 *      SQLite handle and produces rows + audit findings + a refresh-event
 *      row. Does NOT touch the file system. Used by:
 *        • Tests (in-memory DB)
 *        • The HTTP /api/refresh handler (writes to .new file via wrapper)
 *
 *   2. `consolidate(opts)` — CLI wrapper. Manages the staging file
 *      lifecycle: opens data/consolidated.sqlite.new, runs
 *      runConsolidation, atomic-renames over data/consolidated.sqlite.
 *
 * Sheet-level failures (GwsAuthError on listTabs/pullSheet) follow path A:
 * the failed source contributes ZERO rows; per_source records the failure;
 * excluded_order_codes lists the order. Aggregates that "would have"
 * included those rows visibly drop (FR-020).
 *
 * SSE event emission is supported via the optional `onEvent` callback.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Database as DatabaseT } from 'better-sqlite3';
import { loadSheetsConfig } from '../config/load.js';
import type {
  PerSourceStatus,
  RefreshCounters,
  RefreshSseEvent,
  RefreshStatus,
  SheetsConfig,
} from '../shared/contracts.js';
import { logger } from '../shared/logger.js';
import { GwsError, type GwsWrapper } from './ingest/gws.js';
import { prepareIngestSources } from './ingest/folder-source.js';
import { GwsSubprocess } from './ingest/gws-subprocess.js';
import { readReportSource } from './ingest/report-source.js';
import { reconcileReportSource } from './ingest/report-reconciliation.js';
import { adaptSheet } from './ingest/sheet-adapter.js';
import {
  copyEcbRates,
  fetchEcbDailyXml,
  fetchEcbHistoricalXml,
  parseAndUpsertEcbHistoricalXml,
  parseAndUpsertEcbXml,
} from './normalize/ecb-cache.js';
import {
  isDashboardEligibleRow,
  normalizeRow,
  type NormalizedRow,
} from './normalize/index.js';
import { emitFindings } from './audit/findings.js';
import { commitStaging } from './store/atomic-replace.js';
import { openStagingStore, openStore } from './store/db.js';
import { allocateRefreshEvent, writeConsolidation } from './store/write.js';
import { sanitizeErrorMessage } from '../shared/sanitize.js';

export interface RunConsolidationOptions {
  config: SheetsConfig;
  /** Open writable SQLite DB. The caller manages lifecycle (open + close). */
  db: DatabaseT;
  /** GwsWrapper instance — pass FixtureGws in tests, GwsSubprocess in CLI. */
  gws: GwsWrapper;
  /** Local PDF root for extract/pdf.ts path-escape protection. */
  pdfRoot: string;
  /** Refresh emitter for SSE; optional (CLI mode is silent except for the final summary). */
  onEvent?: (event: RefreshSseEvent) => void;
  /** ISO-8601 UTC. Defaults to new Date().toISOString() at the start of the run. */
  nowIso?: () => string;
  triggeredBy?: 'manual' | 'scheduled';
}

export interface ConsolidationResult {
  status: RefreshStatus;
  duration_ms: number;
  /** ISO-8601 UTC stamp emitted on the `completed` SSE event (after commit, in CLI wrapper). */
  completed_at: string;
  per_source: PerSourceStatus[];
  excluded_order_codes: string[];
  counters: RefreshCounters;
  invoice_rows_inserted: number;
  audit_findings_inserted: number;
  refresh_id: number;
}

/** Pure pipeline. Call this when you already have an open writable DB. */
export async function runConsolidation(
  opts: RunConsolidationOptions,
): Promise<ConsolidationResult> {
  const now = opts.nowIso ?? (() => new Date().toISOString());
  const startedAt = now();
  const startMs = Date.now();

  // Allocate the canonical refresh_id up front by inserting an in_progress
  // placeholder row. Every SSE event MUST carry this id; previously a
  // tentative `1` was reused across every refresh (QA review C3).
  const refresh_id = allocateRefreshEvent(opts.db, startedAt, opts.triggeredBy ?? 'manual');

  opts.onEvent?.({
    event: 'started',
    data: { refresh_id, started_at: startedAt },
  });

  // ----- Phase: ingest. Pull every configured tab via GwsWrapper. -----
  opts.onEvent?.({ event: 'phase', data: { refresh_id, phase: 'ingest' } });
  const perSource: PerSourceStatus[] = [];
  const excludedOrderCodes: string[] = [];
  const adaptedRows: ReturnType<typeof adaptSheet> = [];
  let reportSummaries:
    | {
        monthly: Parameters<typeof reconcileReportSource>[1];
        orders: Parameters<typeof reconcileReportSource>[2];
      }
    | undefined;

  if (opts.config.report_source !== undefined) {
    const report = await readReportSource(opts.config.report_source, opts.gws);
    const reportRows = report.rows.filter(isDashboardEligibleRow);
    adaptedRows.push(...reportRows);
    reportSummaries = { monthly: report.monthlySummary, orders: report.orderSummary };
    const sourceStatus: PerSourceStatus = {
      ...report.sourceStatus,
      rows_pulled: reportRows.length,
    };
    perSource.push(sourceStatus);
    opts.onEvent?.({
      event: 'source_progress',
      data: {
        refresh_id,
        spreadsheet_id: sourceStatus.spreadsheet_id,
        order_code: sourceStatus.order_code,
        status: 'success',
        rows_pulled: sourceStatus.rows_pulled,
      },
    });
  } else {
    const preparedSources = await prepareIngestSources(opts.config, opts.gws);
    if (preparedSources.length === 0) {
      throw new Error('ingest prepared zero sources; refusing to publish an empty snapshot');
    }

    for (const source of preparedSources) {
      const sheet = source.sheet;
      let rowsPulled = 0;
      const sheetRows: ReturnType<typeof adaptSheet> = [];
      let sheetFailed = false;
      let lastErrorMsg: string | undefined = source.failure;

      if (source.failure !== undefined) {
        sheetFailed = true;
      } else {
        for (const tab of source.tabs) {
          try {
            const raw = tab.rows ?? await opts.gws.pullSheet(sheet.spreadsheet_id, tab.tabRaw);
            const adapted = adaptSheet(sheet, tab.tabRaw, opts.config.tab_aliases, raw)
              .filter(isDashboardEligibleRow);
            rowsPulled += adapted.length;
            sheetRows.push(...adapted);
          } catch (err) {
            sheetFailed = true;
            lastErrorMsg = err instanceof Error ? err.message : String(err);
            // Stop processing this sheet — path A excludes the WHOLE sheet.
            break;
          }
        }
      }

      if (sheetFailed) {
        const entry: PerSourceStatus = {
          spreadsheet_id: sheet.spreadsheet_id,
          order_code: sheet.order_code,
          status: 'failure',
          rows_pulled: 0,
        };
        if (lastErrorMsg !== undefined) entry.error_msg = lastErrorMsg;
        perSource.push(entry);
        excludedOrderCodes.push(sheet.order_code);
        opts.onEvent?.({
          event: 'source_progress',
          data: {
            refresh_id,
            spreadsheet_id: sheet.spreadsheet_id,
            order_code: sheet.order_code,
            status: 'failure',
            rows_pulled: 0,
            error_msg: lastErrorMsg ?? null,
          },
        });
      } else {
        perSource.push({
          spreadsheet_id: sheet.spreadsheet_id,
          order_code: sheet.order_code,
          status: 'success',
          rows_pulled: rowsPulled,
        });
        adaptedRows.push(...sheetRows);
        opts.onEvent?.({
          event: 'source_progress',
          data: {
            refresh_id,
            spreadsheet_id: sheet.spreadsheet_id,
            order_code: sheet.order_code,
            status: 'success',
            rows_pulled: rowsPulled,
          },
        });
      }
    }
  }

  // ----- Phase: extract + normalize. Per-row pipeline composition. -----
  opts.onEvent?.({ event: 'phase', data: { refresh_id, phase: 'extract' } });
  opts.onEvent?.({ event: 'phase', data: { refresh_id, phase: 'normalize' } });

  const normalizedRows: NormalizedRow[] = [];
  for (const adapter of adaptedRows) {
    const normalized = await normalizeRow(adapter, {
      gws: opts.gws,
      db: opts.db,
      pdfRoot: opts.pdfRoot,
    });
    normalizedRows.push(normalized);
  }

  if (reportSummaries !== undefined) {
    reconcileReportSource(normalizedRows, reportSummaries.monthly, reportSummaries.orders);
  }

  // ----- Phase: audit. Aggregate findings across all rows. -----
  opts.onEvent?.({ event: 'phase', data: { refresh_id, phase: 'audit' } });
  const findings = emitFindings(normalizedRows);

  // ----- Phase: store. Counters + write. -----
  opts.onEvent?.({ event: 'phase', data: { refresh_id, phase: 'store' } });
  const counters = computeCounters(normalizedRows);
  const completedAt = now();
  const duration_ms = Math.max(0, Date.now() - startMs);

  let status: RefreshStatus;
  if (perSource.every((s) => s.status === 'success')) {
    status = 'success';
  } else if (perSource.some((s) => s.status === 'success')) {
    status = 'partial';
  } else {
    status = 'failed';
  }

  const writeResult = writeConsolidation(opts.db, normalizedRows, findings, {
    refresh_id,
    completed_at: completedAt,
    duration_ms,
    status,
    per_source: perSource,
    counters,
  });

  // NOTE: `completed` is NOT emitted here. The CLI wrapper consolidate()
  // emits it ONLY after commitStaging succeeds (Codex review of branch
  // 363b776 → bzj921whd Finding #1: emitting `completed` before the live
  // store is durable lets the SSE consumer race the rename and read the
  // OLD snapshot, AND tells the UI "success" even when the rename later
  // fails). runConsolidation does its work; the wrapper owns commit +
  // completion semantics.

  return {
    status,
    duration_ms,
    completed_at: completedAt,
    per_source: perSource,
    excluded_order_codes: excludedOrderCodes,
    counters,
    invoice_rows_inserted: writeResult.invoice_rows_inserted,
    audit_findings_inserted: writeResult.audit_findings_inserted,
    refresh_id: writeResult.refresh_id,
  };
}

/**
 * Compute counters from a batch of normalized rows. Always satisfies the
 * invariant `rows_total === rows_done + rows_excluded_by_status`.
 */
export function computeCounters(rows: readonly NormalizedRow[]): RefreshCounters {
  let rows_done = 0;
  let rows_excluded_by_status = 0;
  let rows_undated = 0;
  let rows_out_of_ecb_currency = 0;

  for (const row of rows) {
    if (row.is_done) {
      rows_done += 1;
      if (row.date_source === 'undated') rows_undated += 1;
      if (row.conversion_status === 'out_of_ecb_currency') rows_out_of_ecb_currency += 1;
    } else {
      rows_excluded_by_status += 1;
    }
  }

  // Duplicate invoice_id groups (Done rows only — see audit/findings.ts).
  const groups = new Map<string, number>();
  for (const row of rows) {
    if (!row.is_done || row.invoice_id === null) continue;
    groups.set(row.invoice_id, (groups.get(row.invoice_id) ?? 0) + 1);
  }
  let duplicate_invoice_groups = 0;
  for (const count of groups.values()) {
    if (count > 1) duplicate_invoice_groups += 1;
  }

  return {
    rows_total: rows.length,
    rows_done,
    rows_excluded_by_status,
    rows_undated,
    rows_out_of_ecb_currency,
    duplicate_invoice_groups,
  };
}

/* ----------------------------------------------------------------------- */
/* CLI wrapper.                                                             */
/* ----------------------------------------------------------------------- */

export interface CliConsolidateOptions {
  configPath: string;
  dataDir: string;
  pdfRoot: string;
  /** Override the GWS factory for tests. Default: GwsSubprocess. */
  gwsFactory?: () => GwsWrapper;
  /** Override the ECB seeder. Default: fetchEcbDailyXml. Passed the open DB. */
  ecbSeeder?: (db: DatabaseT) => Promise<void>;
  triggeredBy?: 'manual' | 'scheduled';
  onEvent?: (event: RefreshSseEvent) => void;
}

/**
 * CLI wrapper: open staging file, seed ECB rates, runConsolidation,
 * atomic-rename to live file. Returns the same ConsolidationResult.
 */
export async function consolidate(opts: CliConsolidateOptions): Promise<ConsolidationResult> {
  const config = loadSheetsConfig(opts.configPath);
  const dataDir = resolve(opts.dataDir);
  const livePath = resolve(dataDir, 'consolidated.sqlite');
  const stagingPath = resolve(dataDir, 'consolidated.sqlite.new');

  // Drop any leftover staging file from a previous failed run.
  if (existsSync(stagingPath)) {
    // eslint-disable-next-line no-restricted-syntax
    const { unlinkSync } = await import('node:fs');
    unlinkSync(stagingPath);
  }

  const db = openStagingStore(stagingPath);

  try {
    // Carry forward every previously-cached rate from the live store, then
    // top up with the historical + daily feeds. This satisfies Codex review
    // of branch 15c079b Finding #1.
    if (existsSync(livePath)) {
      const live = openStore(livePath);
      try {
        copyEcbRates(live, db);
      } finally {
        live.close();
      }
    }
    await (opts.ecbSeeder ?? defaultEcbSeeder)(db);
    const gws = (opts.gwsFactory ?? (() => new GwsSubprocess()))();
    const result = await runConsolidation({
      config,
      db,
      gws,
      pdfRoot: opts.pdfRoot,
      ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
      ...(opts.triggeredBy !== undefined ? { triggeredBy: opts.triggeredBy } : {}),
    });
    db.close();

    // Codex review of branch 363b776 → bzj921whd Finding #2: do NOT commit
    // a failed-everywhere refresh over the prior good snapshot. A single
    // transient GWS outage would otherwise wipe the dashboard. The prior
    // live store stays untouched; the staging file is deleted.
    if (result.status === 'failed') {
      const { unlinkSync } = await import('node:fs');
      try {
        unlinkSync(stagingPath);
      } catch {
        // best-effort
      }
      opts.onEvent?.({
        event: 'error',
        data: {
          refresh_id: result.refresh_id,
          error: 'all_sources_failed:no_commit:prior_snapshot_preserved',
        },
      });
      return result;
    }

    // Codex Finding #1 — emit `completed` ONLY after commitStaging succeeds.
    // Previously runConsolidation emitted `completed` before the wrapper
    // had a chance to commit; an SSE consumer that refetches /api/data on
    // `completed` would race the rename and read the OLD snapshot.
    try {
      commitStaging(stagingPath, livePath);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      opts.onEvent?.({
        event: 'error',
        data: {
          refresh_id: result.refresh_id,
          error: `commit_failed:${sanitizeErrorMessage(raw)}`,
        },
      });
      throw err;
    }

    opts.onEvent?.({
      event: 'completed',
      data: {
        refresh_id: result.refresh_id,
        completed_at: result.completed_at,
        duration_ms: result.duration_ms,
        // The result.status comes from runConsolidation. By the time we
        // reach here it's 'success' or 'partial' (failed was returned
        // above without committing). The cast is safe — RefreshStatus
        // narrowed by the early-return.
        status: result.status as 'success' | 'partial',
        counters: result.counters,
      },
    });
    return result;
  } catch (err) {
    try {
      db.close();
    } catch {
      // best-effort
    }
    // QA review C5: any throw out of the wrapper (ECB seeder failure,
    // runConsolidation crash, anything before/after commit) MUST clean up
    // the staging file so the next refresh starts from a known-empty state.
    // Previously a stranded staging file would survive until the start of
    // the next run, blocking openStagingStore on partially-written data.
    if (existsSync(stagingPath)) {
      try {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(stagingPath);
      } catch {
        // best-effort
      }
    }
    throw err;
  }
}

async function defaultEcbSeeder(db: DatabaseT): Promise<void> {
  // Fetch the FULL historical feed (1999 → today), then top up with today's
  // daily. Codex review of branch 363b776 → bzj921whd Finding #4: a spend
  // dashboard holding all-time invoices needs ECB coverage matching that
  // history. Both fetches are best-effort — failures are logged but don't
  // abort the run; whatever was already in cache (carried forward from the
  // live store at the start of consolidate) keeps working.
  try {
    await fetchEcbHistoricalXml(db);
  } catch (err) {
    logger.warn(
      { err: { name: (err as Error).name, message: (err as Error).message } },
      'ECB historical fetch failed; continuing with carried-forward rates',
    );
  }
  try {
    await fetchEcbDailyXml(db);
  } catch (err) {
    logger.warn(
      { err: { name: (err as Error).name, message: (err as Error).message } },
      'ECB daily fetch failed; continuing with whatever rates are already cached',
    );
  }
}

/** Re-export so tests can seed rates without going through the network. */
export { parseAndUpsertEcbXml, parseAndUpsertEcbHistoricalXml };

/* ----------------------------------------------------------------------- */
/* CLI entrypoint when run directly.                                        */
/* ----------------------------------------------------------------------- */

const isDirectRun = (() => {
  try {
    const entry = process.argv[1];
    if (entry === undefined) return false;
    return resolve(entry).endsWith('consolidate.ts') || resolve(entry).endsWith('consolidate.js');
  } catch {
    return false;
  }
})();

async function main(): Promise<void> {
  const configPath = process.env.SHEETS_CONFIG ?? resolve(process.cwd(), 'config/sheets.json');
  const dataDir = process.env.DATA_DIR ?? resolve(process.cwd(), 'data');
  const pdfRoot = process.env.PDF_ROOT ?? resolve(process.cwd(), 'data/pdfs');

  logger.info({ configPath, dataDir, pdfRoot }, 'consolidation starting');
  try {
    const result = await consolidate({ configPath, dataDir, pdfRoot });
    logger.info(
      {
        status: result.status,
        duration_ms: result.duration_ms,
        rows_total: result.counters.rows_total,
        rows_done: result.counters.rows_done,
        rows_excluded_by_status: result.counters.rows_excluded_by_status,
        rows_undated: result.counters.rows_undated,
        rows_out_of_ecb_currency: result.counters.rows_out_of_ecb_currency,
        duplicate_invoice_groups: result.counters.duplicate_invoice_groups,
        per_source: result.per_source.length,
        excluded_order_codes: result.excluded_order_codes,
      },
      'consolidation complete',
    );
    process.exit(result.status === 'failed' ? 1 : 0);
  } catch (err) {
    logger.error({ err }, 'consolidation failed');
    process.exit(2);
  }
}

if (isDirectRun) {
  void main();
}
