/**
 * Store-write layer (T053).
 *
 * Batch-inserts every NormalizedRow + every AuditFindingDraft into the
 * staging SQLite database, then writes the refresh_events row that
 * carries refresh-level metadata (per_source, counters).
 *
 * Wraps everything in a single transaction so the staging file is either
 * fully written or rolled back. Atomic-replace happens AFTER this returns
 * (consolidate.ts owns the .new → live rename).
 *
 * The `is_done` column is INTEGER 0/1 in SQLite; we coerce here.
 * audit_flags is stored as a JSON string.
 */

import type { Database as DatabaseT } from 'better-sqlite3';
import type { AuditFindingDraft } from '../audit/findings.js';
import type { NormalizedRow } from '../normalize/index.js';
import { logger } from '../../shared/logger.js';
import type {
  PerSourceStatus,
  RefreshCounters,
  RefreshStatus,
} from '../../shared/contracts.js';

export interface WriteRefreshEventInput {
  /**
   * The refresh_id allocated up front by allocateRefreshEvent(). All SSE
   * events for this refresh MUST carry this id; previously a tentative `1`
   * was used for every event before the DB write (QA review C3 — SSE event
   * correlation broken across refreshes).
   */
  refresh_id: number;
  completed_at: string; // ISO-8601 UTC
  duration_ms: number;
  status: RefreshStatus;
  per_source: PerSourceStatus[];
  counters: RefreshCounters;
}

export interface WriteResult {
  refresh_id: number;
  invoice_rows_inserted: number;
  audit_findings_inserted: number;
}

/**
 * Allocate a refresh_events row up front with status='in_progress'. The
 * returned id is the canonical refresh_id used by every SSE event for the
 * remainder of this run and by writeConsolidation when it finalizes the
 * row at the end of the pipeline.
 *
 * Pre: the staging DB has been opened with openStagingStore (schema applied).
 */
export function allocateRefreshEvent(
  db: DatabaseT,
  started_at: string,
  triggered_by: 'manual' | 'scheduled' = 'manual',
): number {
  const stmt = db.prepare(`
    INSERT INTO refresh_events (started_at, status, triggered_by)
    VALUES (@started_at, 'in_progress', @triggered_by)
  `);
  const result = stmt.run({ started_at, triggered_by });
  return Number(result.lastInsertRowid);
}

/**
 * Insert rows + findings, then UPDATE the already-allocated refresh_events
 * row, all in one transaction. Returns the refresh_id (echoed back from
 * input) and counts.
 *
 * Pre: the staging DB has been opened with openStagingStore (schema applied)
 *      AND allocateRefreshEvent() has already inserted the in_progress row.
 */
export function writeConsolidation(
  db: DatabaseT,
  rows: readonly NormalizedRow[],
  findings: readonly AuditFindingDraft[],
  refreshEvent: WriteRefreshEventInput,
): WriteResult {
  // INSERT OR IGNORE so a UNIQUE collision on source_row_key (64-bit hash
  // truncation; vanishingly unlikely but possible, or duplicate-tab operator
  // mistake) does not abort the entire refresh transaction. The deterministic
  // content-hash means a colliding insert MUST already correspond to the
  // same logical row, so silently skipping is the right behavior; we count
  // how many rows were skipped and log a warning so the operator sees it.
  // (QA review H6.)
  const insertInvoice = db.prepare(`
    INSERT OR IGNORE INTO invoices (
      source_row_key, invoice_id, order_code, spreadsheet_id, tab_name,
      tab_name_raw, row_index, work_status, is_done, payment_status,
      invoice_type, artifact_ref, artifact_status, website, website_raw,
      live_url,
      native_amount, native_currency, eur_amount, ecb_rate, ecb_rate_as_of,
      conversion_status, invoice_date, invoice_month, date_source,
      audit_flags, ingested_at
    ) VALUES (
      @source_row_key, @invoice_id, @order_code, @spreadsheet_id, @tab_name,
      @tab_name_raw, @row_index, @work_status, @is_done, @payment_status,
      @invoice_type, @artifact_ref, @artifact_status, @website, @website_raw,
      @live_url,
      @native_amount, @native_currency, @eur_amount, @ecb_rate, @ecb_rate_as_of,
      @conversion_status, @invoice_date, @invoice_month, @date_source,
      @audit_flags, @ingested_at
    )
  `);

  const updateRefresh = db.prepare(`
    UPDATE refresh_events
    SET completed_at = @completed_at,
        duration_ms  = @duration_ms,
        status       = @status,
        per_source   = @per_source,
        counters     = @counters
    WHERE id = @refresh_id
  `);

  const insertFinding = db.prepare(`
    INSERT INTO audit_findings (
      refresh_id, category, source_row_key, summary, eur_amount
    ) VALUES (
      @refresh_id, @category, @source_row_key, @summary, @eur_amount
    )
  `);

  const ingestedAt = new Date().toISOString();

  const tx = db.transaction(() => {
    // 1. invoices
    let invoiceCount = 0;
    let skippedDuplicates = 0;
    for (const row of rows) {
      const result = insertInvoice.run({
        source_row_key: row.source_row_key,
        invoice_id: row.invoice_id,
        order_code: row.order_code,
        spreadsheet_id: row.spreadsheet_id,
        tab_name: row.tab_name,
        tab_name_raw: row.tab_name_raw,
        row_index: row.row_index,
        work_status: row.work_status,
        is_done: row.is_done ? 1 : 0,
        payment_status: row.payment_status,
        invoice_type: row.invoice_type,
        artifact_ref: row.artifact_ref,
        artifact_status: row.artifact_status,
        website: row.website,
        website_raw: row.website_raw,
        live_url: row.live_url,
        native_amount: row.native_amount,
        native_currency: row.native_currency,
        eur_amount: row.eur_amount,
        ecb_rate: row.ecb_rate,
        ecb_rate_as_of: row.ecb_rate_as_of,
        conversion_status: row.conversion_status,
        invoice_date: row.invoice_date,
        invoice_month: row.invoice_month,
        date_source: row.date_source,
        audit_flags: JSON.stringify(row.audit_flags),
        ingested_at: ingestedAt,
      });
      if (result.changes === 1) {
        invoiceCount += 1;
      } else {
        // UNIQUE collision on source_row_key — the prior insert already
        // covers this logical row (deterministic content hash).
        skippedDuplicates += 1;
      }
    }
    if (skippedDuplicates > 0) {
      // Surface in the per-refresh log; for v1 we don't add a dedicated
      // audit category since the collision is either operator-config (dup
      // tab) or an astronomically unlikely 64-bit hash collision. Routed
      // through pino so the constitution's redaction policy applies (T100).
      logger.warn(
        { skipped: skippedDuplicates },
        'writeConsolidation: source_row_key collision(s) skipped via INSERT OR IGNORE; ' +
          'likely cause is a duplicate tab entry in sheets config.',
      );
    }

    // 2. refresh_events — UPDATE the row allocated up front by
    //    allocateRefreshEvent() so every SSE event already emitted in this
    //    refresh carries the canonical id.
    const updateResult = updateRefresh.run({
      refresh_id: refreshEvent.refresh_id,
      completed_at: refreshEvent.completed_at,
      duration_ms: refreshEvent.duration_ms,
      status: refreshEvent.status,
      per_source: JSON.stringify(refreshEvent.per_source),
      counters: JSON.stringify(refreshEvent.counters),
    });
    if (updateResult.changes !== 1) {
      throw new Error(
        `writeConsolidation: refresh_events UPDATE matched ${updateResult.changes} rows ` +
          `(expected exactly 1 for refresh_id=${refreshEvent.refresh_id}). Did allocateRefreshEvent run first?`,
      );
    }
    const refresh_id = refreshEvent.refresh_id;

    // 3. audit_findings (FK to the refresh row + source_row_key on invoices)
    let findingCount = 0;
    for (const f of findings) {
      insertFinding.run({
        refresh_id,
        category: f.category,
        source_row_key: f.source_row_key,
        summary: f.summary,
        eur_amount: f.eur_amount,
      });
      findingCount += 1;
    }

    return { refresh_id, invoice_rows_inserted: invoiceCount, audit_findings_inserted: findingCount };
  });

  return tx();
}
