/**
 * Shared zod schemas + inferred types for the GG Spend Dashboard.
 *
 * These are the SINGLE source of truth for the on-the-wire contracts
 * (`/api/data` envelope, SSE refresh events) and for the operator config
 * (`config/sheets.json`). Both backend and frontend import from here so the
 * contract shape is enforced at runtime AND in the type system.
 *
 * Frontend imports via a relative path: `frontend/src/lib/contracts.ts` is a
 * thin re-export so the frontend bundle stays aware of breaking changes.
 */

import { z } from 'zod';

/* ----------------------------------------------------------------------- */
/* Enums (single-source taxonomies — see Constitution Principle VI).        */
/* ----------------------------------------------------------------------- */

export const PaymentStatus = z.enum(['paid', 'unpaid', 'unknown', 'missing']);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

export const InvoiceType = z.enum(['paypal', 'pdf', 'drive_pdf', 'intuit', 'text', 'missing']);
export type InvoiceType = z.infer<typeof InvoiceType>;

export const ConversionStatus = z.enum([
  'converted',
  'missing_price',
  'unparseable_amount',
  'missing_currency',
  'out_of_ecb_currency',
]);
export type ConversionStatus = z.infer<typeof ConversionStatus>;

export const ArtifactStatus = z.enum(['not_attempted', 'reachable', 'unreachable']);
export type ArtifactStatus = z.infer<typeof ArtifactStatus>;

export const DateSource = z.enum(['sheet', 'artifact', 'undated']);
export type DateSource = z.infer<typeof DateSource>;

export const RefreshStatus = z.enum(['in_progress', 'success', 'partial', 'failed']);
export type RefreshStatus = z.infer<typeof RefreshStatus>;

/**
 * Audit category enum — every key MUST be present in
 * ApiDataResponse.audit_findings_by_category, even when empty (FR-022).
 *
 * QA review H5: `unparseable_amount` and `missing_currency` get their own
 * categories so the operator can drill into "I typo'd a price" or "this
 * sheet's currency column is blank" without going through the rolled-up
 * `missing_price` view. Previously these conditions surfaced ONLY via
 * conversion_status on row drill-down, leaving the category index blind.
 */
export const AuditCategory = z.enum([
  'non_done_row',
  'missing_price',
  'unparseable_amount',
  'missing_currency',
  'missing_invoice_url',
  'missing_date',
  'unknown_payment_status',
  'missing_payment_status',
  'duplicate_invoice_id',
  'out_of_ecb_currency',
  'future_dated_invoice',
  'artifact_unreachable',
  // v2-reserved categories (always emit [] in v1):
  'pdf_extraction_failed',
  'paypal_verification_mismatch',
]);
export type AuditCategory = z.infer<typeof AuditCategory>;

export const AUDIT_CATEGORIES_V1: AuditCategory[] = [
  'non_done_row',
  'missing_price',
  'unparseable_amount',
  'missing_currency',
  'missing_invoice_url',
  'missing_date',
  'unknown_payment_status',
  'missing_payment_status',
  'duplicate_invoice_id',
  'out_of_ecb_currency',
  'future_dated_invoice',
  'artifact_unreachable',
];

export const AUDIT_CATEGORIES_V2_RESERVED: AuditCategory[] = [
  'pdf_extraction_failed',
  'paypal_verification_mismatch',
];

export const AUDIT_CATEGORIES_ALL: AuditCategory[] = [
  ...AUDIT_CATEGORIES_V1,
  ...AUDIT_CATEGORIES_V2_RESERVED,
];

/* ----------------------------------------------------------------------- */
/* config/sheets.json schema (operator-facing).                             */
/* ----------------------------------------------------------------------- */

export const ColumnMapping = z
  .object({
    /** Required: row-eligibility column (typically "A") — drives the Status="Done" filter (FR-031). */
    status: z.string().min(1),
    /** Per-row website identifier; null when this sheet has no per-row website. */
    website: z.string().min(1).nullable().optional(),
    /** Required: numeric amount column. */
    price: z.string().min(1),
    /** Currency column; omit when sheet is EUR-only (rows normalized as EUR with rate=1.0). */
    currency: z.string().min(1).optional(),
    /** Date column; null when sheet has no date (date falls back to artifact-derived for pdf/drive_pdf). */
    invoice_date: z.string().min(1).nullable().optional(),
    /** Per-row artifact link; null when sheet has no per-row artifact. */
    invoice_url: z.string().min(1).nullable().optional(),
    /** Payment-status column; omit → rows resolve to 'missing' (Principle VI). */
    invoice_status: z.string().min(1).optional(),
    /** Optional pass-through fields, surfaced in provenance only. */
    link_builder: z.string().min(1).optional(),
    target_url: z.string().min(1).optional(),
    anchor: z.string().min(1).optional(),
    live_url: z.string().min(1).optional(),
  })
  .strict();
export type ColumnMapping = z.infer<typeof ColumnMapping>;

export const SheetEntry = z
  .object({
    spreadsheet_id: z.string().min(1),
    order_code: z.string().min(1),
    region: z.string().min(1).optional(),
    tabs: z.array(z.string().min(1)).min(1),
    column_mapping: ColumnMapping,
  })
  .strict();
export type SheetEntry = z.infer<typeof SheetEntry>;

export const FolderSourceConfig = z
  .object({
    drive_folder_id: z.string().min(1),
    copy_name_suffix: z.string().min(1).optional(),
    excluded_order_codes: z.array(z.string().min(1)).optional(),
    standard_column_mapping: ColumnMapping,
  })
  .strict();
export type FolderSourceConfig = z.infer<typeof FolderSourceConfig>;

export const REPORTING_YEAR = 2026 as const;
/** Dashboard-visible reporting period. January remains in the source workbook for reconciliation. */
export const DASHBOARD_REPORTING_START_MONTH = '2026-02' as const;
export const DASHBOARD_REPORTING_END_MONTH = '2027-01' as const;
/** Version of the published, 2026-only API/store snapshot contract. */
export const API_SCHEMA_VERSION = 2 as const;

export const ReportSourceHeaderMapping = z
  .object({
    order: z.string().min(1),
    source_tab: z.string().min(1),
    source_row: z.string().min(1),
    invoice_date: z.string().min(1),
    reporting_month: z.string().min(1),
    link_builder: z.string().min(1),
    website: z.string().min(1),
    spend_eur: z.string().min(1),
    invoice_url: z.string().min(1),
    live_url: z.string().min(1),
    invoice_status: z.string().min(1),
    included: z.string().min(1),
    data_quality_issue: z.string().min(1),
    savings_eur: z.string().min(1),
  })
  .strict();
export type ReportSourceHeaderMapping = z.infer<typeof ReportSourceHeaderMapping>;

export const ReportSourceConfig = z
  .object({
    spreadsheet_id: z.string().min(1),
    data_tab: z.string().min(1),
    monthly_summary_tab: z.string().min(1),
    order_summary_tab: z.string().min(1),
    reporting_year: z.literal(REPORTING_YEAR),
    headers: ReportSourceHeaderMapping,
  })
  .strict();
export type ReportSourceConfig = z.infer<typeof ReportSourceConfig>;

export const SheetsConfig = z
  .object({
    schema_version: z.literal(1),
    /** Map canonical tab name → known misspelled variant the sheet actually uses. */
    tab_aliases: z.record(z.string().min(1), z.string().min(1)).optional(),
    report_source: ReportSourceConfig.optional(),
    folder_source: FolderSourceConfig.optional(),
    /**
     * Legacy/static source mode kept for deterministic tests and one-off
     * fixtures. Production config should use report_source so original
     * spreadsheet IDs never become the dashboard source of truth again.
     */
    sheets: z.array(SheetEntry).optional().default([]),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const sourceModeCount = Number(cfg.report_source !== undefined)
      + Number(cfg.folder_source !== undefined)
      + Number(cfg.sheets.length > 0);
    if (sourceModeCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'Exactly one source mode is required: report_source, folder_source, or non-empty sheets.',
      });
    }
    const seen = new Set<string>();
    for (let i = 0; i < cfg.sheets.length; i += 1) {
      const code = cfg.sheets[i]!.order_code;
      if (seen.has(code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sheets', i, 'order_code'],
          message: `Duplicate order_code '${code}' — order codes must be unique across sheets.`,
        });
      }
      seen.add(code);
    }
  });
export type SheetsConfig = z.infer<typeof SheetsConfig>;

/* ----------------------------------------------------------------------- */
/* InvoiceRow + AuditFinding (the core wire types).                         */
/* ----------------------------------------------------------------------- */

const Iso8601Utc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, 'must be ISO-8601 UTC');
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const IsoMonth = z.string().regex(/^\d{4}-\d{2}$/, 'must be YYYY-MM');
const SourceRowKey = z.string().regex(/^[0-9a-f]{16}$/, 'must be 16-char lowercase hex');

export const InvoiceRow = z
  .object({
    /** 16-char lowercase hex; sha256(spreadsheet_id+':'+tab_name_raw+':'+row_index) truncated. */
    source_row_key: SourceRowKey,
    /** Upstream invoice number (PayPal ID, PDF invoice number); never used as URL key. */
    invoice_id: z.string().min(1).nullable(),
    order_code: z.string().min(1),
    spreadsheet_id: z.string().min(1),
    tab_name: z.string().min(1),
    tab_name_raw: z.string().min(1),
    row_index: z.number().int().positive(),
    work_status: z.string(),
    is_done: z.boolean(),
    payment_status: PaymentStatus,
    invoice_type: InvoiceType,
    artifact_ref: z.string().nullable(),
    artifact_status: ArtifactStatus,
    website: z.string().min(1).nullable(),
    website_raw: z.string().nullable(),
    /**
     * Column L on the standard order sheet — the URL where the published
     * backlink physically lives (the article on the publisher site).
     * Optional in the wire schema so old test fixtures pre-dating this
     * field still zod-parse cleanly; production always emits it (null when
     * the cell is blank).
     */
    live_url: z.string().nullable().optional(),
    /** Conversion fields are NULLABLE — see conversion_status. */
    native_amount: z.number().nullable(),
    native_currency: z.string().min(3).max(3).nullable(),
    eur_amount: z.number().nullable(),
    /** Raw EUR savings supplied by the source report; always finite in a v2 snapshot. */
    savings_eur: z.number().finite(),
    /** ECB-native: foreign currency units per 1 EUR. EUR rows store rate=1.0. */
    ecb_rate: z.number().positive().nullable(),
    ecb_rate_as_of: IsoDate.nullable(),
    conversion_status: ConversionStatus,
    invoice_date: IsoDate,
    invoice_month: IsoMonth,
    date_source: DateSource,
    audit_flags: z.array(z.string()),
  })
  .strict();
export type InvoiceRow = z.infer<typeof InvoiceRow>;

export const AuditFinding = z
  .object({
    source_row_key: SourceRowKey.nullable(),
    category: AuditCategory,
    summary: z.string(),
    eur_amount: z.number().nullable(),
    spreadsheet_id: z.string(),
    tab_name: z.string(),
    row_index: z.number().int().positive(),
  })
  .strict();
export type AuditFinding = z.infer<typeof AuditFinding>;

/* ----------------------------------------------------------------------- */
/* Refresh metadata (root of the data envelope).                            */
/* ----------------------------------------------------------------------- */

export const PerSourceStatus = z
  .object({
    spreadsheet_id: z.string().min(1),
    order_code: z.string().min(1),
    status: z.enum(['success', 'failure']),
    rows_pulled: z.number().int().nonnegative(),
    error_msg: z.string().optional(),
  })
  .strict();
export type PerSourceStatus = z.infer<typeof PerSourceStatus>;

export const RefreshCounters = z
  .object({
    /** rows_total === rows_done + rows_excluded_by_status (always). */
    rows_total: z.number().int().nonnegative(),
    /** is_done=1 count, regardless of conversion_status. */
    rows_done: z.number().int().nonnegative(),
    rows_excluded_by_status: z.number().int().nonnegative(),
    /** Subset of rows_done where date_source='undated'. */
    rows_undated: z.number().int().nonnegative(),
    /** Subset of rows_done where conversion_status='out_of_ecb_currency'. */
    rows_out_of_ecb_currency: z.number().int().nonnegative(),
    /** Number of invoice_id groups with count > 1 (audit signal only — no rows removed). */
    duplicate_invoice_groups: z.number().int().nonnegative(),
  })
  .strict()
  .refine((c) => c.rows_total === c.rows_done + c.rows_excluded_by_status, {
    message: 'rows_total must equal rows_done + rows_excluded_by_status',
    path: ['rows_total'],
  });
export type RefreshCounters = z.infer<typeof RefreshCounters>;

/* ----------------------------------------------------------------------- */
/* GET /api/data response envelope.                                         */
/* ----------------------------------------------------------------------- */

/**
 * Audit-by-category response shape.
 *
 * Forward-compat (QA finding H7): uses `.passthrough()` instead of the
 * default strict mode so a NEWER backend that adds a category key won't
 * crash an OLDER frontend whose bundled zod schema doesn't know about
 * it. Stale tabs degrade gracefully (the new key is preserved in the
 * parsed value but the AuditPanel just doesn't render a section for it
 * until the bundle reloads). Every required v1 + v2-reserved key is
 * still validated as `array<AuditFinding>`.
 */
const AuditByCategoryShape = z
  .object(
    Object.fromEntries(
      AUDIT_CATEGORIES_ALL.map((cat) => [cat, z.array(AuditFinding)] as const),
    ) as Record<AuditCategory, z.ZodArray<typeof AuditFinding>>,
  )
  .passthrough();

export const ApiDataResponse = z
  .object({
    schema_version: z.literal(API_SCHEMA_VERSION),
    reporting_year: z.literal(REPORTING_YEAR),
    last_refreshed_at: Iso8601Utc.nullable(),
    refresh_status: z.enum(['success', 'partial', 'failed', 'never_refreshed']),
    duration_ms: z.number().int().nonnegative().nullable(),
    per_source: z.array(PerSourceStatus),
    counters: RefreshCounters,
    /** Order codes whose source failed in the latest refresh and so contributed zero rows. */
    excluded_order_codes: z.array(z.string().min(1)),
    /** Every Done row + every non-Done row (non-Done rows surface only in the Audit panel UI). */
    invoices: z.array(InvoiceRow),
    /** Every category key MUST be present (FR-022); value MAY be []. */
    audit_findings_by_category: AuditByCategoryShape,
  })
  .strict()
  .superRefine((response, ctx) => {
    for (let index = 0; index < response.invoices.length; index += 1) {
      const invoice = response.invoices[index]!;
      if (
        invoice.invoice_month < DASHBOARD_REPORTING_START_MONTH
        || invoice.invoice_month >= DASHBOARD_REPORTING_END_MONTH
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['invoices', index, 'invoice_month'],
          message: `invoice_month must be within the dashboard period starting ${DASHBOARD_REPORTING_START_MONTH}`,
        });
      }
    }
  });
export type ApiDataResponse = z.infer<typeof ApiDataResponse>;

/* ----------------------------------------------------------------------- */
/* POST /api/refresh SSE event types.                                       */
/* ----------------------------------------------------------------------- */

export const RefreshStartedEvent = z.object({
  refresh_id: z.number().int().positive(),
  started_at: Iso8601Utc,
});
export type RefreshStartedEvent = z.infer<typeof RefreshStartedEvent>;

export const RefreshSourceProgressEvent = z.object({
  refresh_id: z.number().int().positive(),
  spreadsheet_id: z.string().min(1),
  order_code: z.string().min(1),
  status: z.enum(['success', 'failure']),
  rows_pulled: z.number().int().nonnegative(),
  error_msg: z.string().nullable().optional(),
});
export type RefreshSourceProgressEvent = z.infer<typeof RefreshSourceProgressEvent>;

export const RefreshPhaseEvent = z.object({
  refresh_id: z.number().int().positive(),
  phase: z.enum(['ingest', 'extract', 'normalize', 'audit', 'store']),
});
export type RefreshPhaseEvent = z.infer<typeof RefreshPhaseEvent>;

export const RefreshCompletedEvent = z.object({
  refresh_id: z.number().int().positive(),
  completed_at: Iso8601Utc,
  duration_ms: z.number().int().nonnegative(),
  status: z.enum(['success', 'partial', 'failed']),
  counters: RefreshCounters,
});
export type RefreshCompletedEvent = z.infer<typeof RefreshCompletedEvent>;

/**
 * RefreshErrorEvent — emitted when a refresh aborts before completion.
 *
 * `refresh_id` is `nonnegative` (not `positive`) because the pipeline may
 * throw BEFORE `allocateRefreshEvent` runs (e.g., ECB seeder failure, DB
 * open failure), in which case the API layer emits `refresh_id: 0` as a
 * sentinel meaning "no refresh row was allocated for this attempt".
 * Strict `positive` would crash the frontend zod parser on the very error
 * path it's meant to surface (QA review C4).
 */
export const RefreshErrorEvent = z.object({
  refresh_id: z.number().int().nonnegative(),
  error: z.string().min(1),
});
export type RefreshErrorEvent = z.infer<typeof RefreshErrorEvent>;

/**
 * Discriminated union of every SSE event the refresh stream can emit.
 * Useful for typed consumers; the wire format is `event: <name>\ndata: <json>\n\n`.
 */
export type RefreshSseEvent =
  | { event: 'started'; data: RefreshStartedEvent }
  | { event: 'source_progress'; data: RefreshSourceProgressEvent }
  | { event: 'phase'; data: RefreshPhaseEvent }
  | { event: 'completed'; data: RefreshCompletedEvent }
  | { event: 'error'; data: RefreshErrorEvent };
