/**
 * GET /api/data handler (T055).
 *
 * Reads the consolidated store and returns the ApiDataResponse envelope
 * mirroring the prod data.json shape (Constitution Principle IV).
 *
 * Returns 503 with body `{ error: 'never_refreshed' }` when no refresh has
 * ever produced a writable store (FR-016 / contracts/api-data.md).
 *
 * Per FR-022 every audit category key is always present in
 * `audit_findings_by_category`, even when empty.
 */

import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { openStore, storeHasAnyRow } from '../pipeline/store/db.js';
import {
  AUDIT_CATEGORIES_ALL,
  type ApiDataResponse,
  type AuditCategory,
  type AuditFinding,
  type InvoiceRow,
  type PerSourceStatus,
  type RefreshCounters,
} from '../shared/contracts.js';

interface RefreshEventRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  status: 'in_progress' | 'success' | 'partial' | 'failed';
  per_source: string;
  counters: string;
}

interface InvoiceDbRow {
  source_row_key: string;
  invoice_id: string | null;
  order_code: string;
  spreadsheet_id: string;
  tab_name: string;
  tab_name_raw: string;
  row_index: number;
  work_status: string;
  is_done: number;
  payment_status: 'paid' | 'unpaid' | 'unknown' | 'missing';
  invoice_type: 'paypal' | 'pdf' | 'drive_pdf' | 'intuit' | 'text' | 'missing';
  artifact_ref: string | null;
  artifact_status: 'not_attempted' | 'reachable' | 'unreachable';
  website: string | null;
  website_raw: string | null;
  live_url: string | null;
  native_amount: number | null;
  native_currency: string | null;
  eur_amount: number | null;
  ecb_rate: number | null;
  ecb_rate_as_of: string | null;
  conversion_status:
    | 'converted'
    | 'missing_price'
    | 'unparseable_amount'
    | 'missing_currency'
    | 'out_of_ecb_currency';
  invoice_date: string | null;
  invoice_month: string | null;
  date_source: 'sheet' | 'artifact' | 'undated';
  audit_flags: string;
}

interface AuditFindingDbRow {
  category: AuditCategory;
  source_row_key: string | null;
  summary: string;
  eur_amount: number | null;
  spreadsheet_id: string;
  tab_name: string;
  row_index: number;
}

/**
 * Build the ApiDataResponse envelope from a path to the consolidated store.
 * Returns null when the store doesn't exist yet OR exists but has no rows
 * (the never-refreshed and first-ever-all-failed cases per FR-020a +
 * api-data.md).
 */
export function buildDataResponse(storePath: string): ApiDataResponse | null {
  if (!existsSync(storePath)) return null;
  const db = openStore(storePath);
  try {
    if (!storeHasAnyRow(db)) return null;

    const refresh = db
      .prepare(
        `SELECT id, started_at, completed_at, duration_ms, status, per_source, counters
           FROM refresh_events
          ORDER BY id DESC
          LIMIT 1`,
      )
      .get() as RefreshEventRow | undefined;

    const perSource: PerSourceStatus[] = refresh ? safeJsonArray(refresh.per_source) : [];
    const counters: RefreshCounters = refresh
      ? (safeJson(refresh.counters) as RefreshCounters)
      : zeroCounters();

    const excluded_order_codes = perSource
      .filter((s) => s.status === 'failure')
      .map((s) => s.order_code);

    const invoiceRows = db.prepare('SELECT * FROM invoices').all() as InvoiceDbRow[];
    const invoices: InvoiceRow[] = invoiceRows.map(toInvoiceRow);

    const findingsRows = db
      .prepare(
        `SELECT af.category, af.source_row_key, af.summary, af.eur_amount,
                COALESCE(i.spreadsheet_id, '') AS spreadsheet_id,
                COALESCE(i.tab_name, '')      AS tab_name,
                COALESCE(i.row_index, 0)      AS row_index
           FROM audit_findings af
           LEFT JOIN invoices i ON i.source_row_key = af.source_row_key
          WHERE af.refresh_id = (SELECT MAX(id) FROM refresh_events)`,
      )
      .all() as AuditFindingDbRow[];

    // Initialize every category key to [] so FR-022 "always emit every key"
    // is satisfied even when the store has zero findings.
    const audit_findings_by_category = Object.fromEntries(
      AUDIT_CATEGORIES_ALL.map((cat) => [cat, [] as AuditFinding[]]),
    ) as Record<AuditCategory, AuditFinding[]>;

    for (const f of findingsRows) {
      audit_findings_by_category[f.category].push({
        source_row_key: f.source_row_key,
        category: f.category,
        summary: f.summary,
        eur_amount: f.eur_amount,
        spreadsheet_id: f.spreadsheet_id,
        tab_name: f.tab_name,
        row_index: f.row_index,
      });
    }

    const refresh_status =
      refresh === undefined
        ? ('never_refreshed' as const)
        : (refresh.status === 'in_progress' ? 'failed' : refresh.status);

    return {
      schema_version: 1,
      last_refreshed_at: refresh?.completed_at ?? null,
      refresh_status,
      duration_ms: refresh?.duration_ms ?? null,
      per_source: perSource,
      counters,
      excluded_order_codes,
      invoices,
      audit_findings_by_category,
    };
  } finally {
    db.close();
  }
}

function toInvoiceRow(r: InvoiceDbRow): InvoiceRow {
  return {
    source_row_key: r.source_row_key,
    invoice_id: r.invoice_id,
    order_code: r.order_code,
    spreadsheet_id: r.spreadsheet_id,
    tab_name: r.tab_name,
    tab_name_raw: r.tab_name_raw,
    row_index: r.row_index,
    work_status: r.work_status,
    is_done: r.is_done === 1,
    payment_status: r.payment_status,
    invoice_type: r.invoice_type,
    artifact_ref: r.artifact_ref,
    artifact_status: r.artifact_status,
    website: r.website,
    website_raw: r.website_raw,
    live_url: r.live_url,
    native_amount: r.native_amount,
    native_currency: r.native_currency,
    eur_amount: r.eur_amount,
    ecb_rate: r.ecb_rate,
    ecb_rate_as_of: r.ecb_rate_as_of,
    conversion_status: r.conversion_status,
    invoice_date: r.invoice_date,
    invoice_month: r.invoice_month,
    date_source: r.date_source,
    audit_flags: safeJsonStringArray(r.audit_flags),
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function safeJsonArray(s: string): never[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as never[]) : [];
  } catch {
    return [];
  }
}

function safeJsonStringArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function zeroCounters(): RefreshCounters {
  return {
    rows_total: 0,
    rows_done: 0,
    rows_excluded_by_status: 0,
    rows_undated: 0,
    rows_out_of_ecb_currency: 0,
    duplicate_invoice_groups: 0,
  };
}

/**
 * Register the GET /api/data route on a Fastify instance.
 * Reads `app.appOptions.dataDir` to find the store path.
 */
export function registerDataRoute(app: FastifyInstance): void {
  app.get('/api/data', async (_req, reply) => {
    const dataDir = app.appOptions.dataDir;
    if (dataDir === undefined) {
      reply.code(500);
      return { error: 'data_dir_not_configured' };
    }
    const storePath = `${dataDir.replace(/\/$/, '')}/consolidated.sqlite`;
    const response = buildDataResponse(storePath);
    if (response === null) {
      reply.code(503);
      return { error: 'never_refreshed' };
    }
    return response;
  });
}
