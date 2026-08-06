/**
 * Frontend selectors — derive aggregate views from the ApiDataResponse
 * snapshot. The API ships everything client-side, so selectors are pure
 * derivations over `data.invoices`.
 *
 * Aggregation rule (Constitution Principle V + VI): only rows with
 *   is_done=true AND conversion_status==='converted'
 * contribute EUR amounts. Other rows surface in the Audit panel via
 * audit_findings_by_category.
 *
 * Every aggregate carries a payment-status breakdown (FR-010).
 */

import type {
  ApiDataResponse,
  InvoiceRow,
  PaymentStatus,
} from './contracts';
import {
  DASHBOARD_REPORTING_END_MONTH,
  DASHBOARD_REPORTING_START_MONTH,
} from './contracts';

export interface PaymentStatusBreakdown {
  paid: { spend_eur: number; count: number };
  unpaid: { spend_eur: number; count: number };
  unknown: { spend_eur: number; count: number };
  missing: { spend_eur: number; count: number };
}

export interface ScopedTotal {
  /** EUR spend across all aggregable rows in the scope. */
  spend_eur: number;
  /** EUR savings across all aggregable rows in the scope. */
  savings_eur: number;
  /** Number of aggregable rows in the scope. */
  count: number;
  /** Per-payment-status spend and row count (sums to the scope). */
  by_status: PaymentStatusBreakdown;
}

/** True only for rows inside the dashboard's February–December 2026 reporting boundary. */
export function isReportingYearRow(row: InvoiceRow): boolean {
  return (
    row.invoice_month >= DASHBOARD_REPORTING_START_MONTH
    && row.invoice_month < DASHBOARD_REPORTING_END_MONTH
  );
}

/** Predicate: is this 2026 row aggregable for headline EUR sums? */
export function isAggregable(row: InvoiceRow): boolean {
  return isReportingYearRow(row) && row.is_done && row.conversion_status === 'converted';
}

function emptyBreakdown(): PaymentStatusBreakdown {
  return {
    paid: { spend_eur: 0, count: 0 },
    unpaid: { spend_eur: 0, count: 0 },
    unknown: { spend_eur: 0, count: 0 },
    missing: { spend_eur: 0, count: 0 },
  };
}

function emptyTotal(): ScopedTotal {
  return { spend_eur: 0, savings_eur: 0, count: 0, by_status: emptyBreakdown() };
}

function addRow(total: ScopedTotal, row: InvoiceRow): void {
  const spend = row.eur_amount ?? 0;
  total.spend_eur += spend;
  total.savings_eur += row.savings_eur;
  total.count += 1;
  const bucket = total.by_status[row.payment_status];
  bucket.spend_eur += spend;
  bucket.count += 1;
}

/**
 * Round EUR amounts to cents on the way out so display is deterministic.
 *
 * QA review H16: the status totals are rounded before the spend headline
 * INDEPENDENTLY, which means `round(sum) !== sum(round(parts))` in the
 * general case — the headline could be 1 cent off from the displayed
 * paid/unpaid/unknown/missing total below it. Fix: round each status,
 * then derive the headline as the sum of the rounded statuses so the
 * sum-of-parts invariant always holds in the rendered display.
 */
function roundCents(total: ScopedTotal): ScopedTotal {
  let headlineSum = 0;
  for (const status of ['paid', 'unpaid', 'unknown', 'missing'] satisfies PaymentStatus[]) {
    const rounded = Math.round(total.by_status[status].spend_eur * 100) / 100;
    total.by_status[status].spend_eur = rounded;
    headlineSum += rounded;
  }
  // Re-round once after the additive accumulation so float-summation noise
  // can't push us off the cent boundary again.
  total.spend_eur = Math.round(headlineSum * 100) / 100;
  total.savings_eur = Math.round(total.savings_eur * 100) / 100;
  return total;
}

function roundCurrency(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ----------------------------------------------------------------------- */
/* Aggregate selectors.                                                     */
/* ----------------------------------------------------------------------- */

/**
 * Sum of all aggregable rows for the given month bucket (YYYY-MM).
 * Pass `'Undated'` to scope to undated rows.
 */
export function monthlyTotal(data: ApiDataResponse, month: string): ScopedTotal {
  const total = emptyTotal();
  for (const row of data.invoices) {
    if (!isAggregable(row)) continue;
    const rowMonth = row.invoice_month ?? 'Undated';
    if (rowMonth !== month) continue;
    addRow(total, row);
  }
  return roundCents(total);
}

/**
 * Sum of all aggregable rows for a given (order_code, month) pair.
 */
export function orderMonthTotal(
  data: ApiDataResponse,
  orderCode: string,
  month: string,
): ScopedTotal {
  const total = emptyTotal();
  for (const row of data.invoices) {
    if (!isAggregable(row)) continue;
    if (row.order_code !== orderCode) continue;
    const rowMonth = row.invoice_month ?? 'Undated';
    if (rowMonth !== month) continue;
    addRow(total, row);
  }
  return roundCents(total);
}

/**
 * Lifetime (all-months) sum for a given order_code.
 */
export function reportingYearPerOrder(data: ApiDataResponse, orderCode: string): ScopedTotal {
  const total = emptyTotal();
  for (const row of data.invoices) {
    if (!isAggregable(row)) continue;
    if (row.order_code !== orderCode) continue;
    addRow(total, row);
  }
  return roundCents(total);
}

/**
 * Lifetime sum across ALL orders + ALL months. Used by the UI when the
 * scope toggle is "lifetime" and no specific order is selected.
 *
 * Includes every aggregable row (is_done && conversion_status='converted'),
 * including those bucketed as `Undated`.
 */
export function reportingYearTotal(data: ApiDataResponse): ScopedTotal {
  const total = emptyTotal();
  for (const row of data.invoices) {
    if (!isAggregable(row)) continue;
    addRow(total, row);
  }
  return roundCents(total);
}

/* ----------------------------------------------------------------------- */
/* Redesign chart selectors.                                                */
/* ----------------------------------------------------------------------- */

export interface MonthlySpendPoint {
  m: string;
  paid: number;
  outstanding: number;
}

/** Monthly spend across all sheets, split by paid vs outstanding status. */
export function spendByMonth(data: ApiDataResponse): MonthlySpendPoint[] {
  const byMonth = new Map<string, MonthlySpendPoint>();

  for (const row of data.invoices) {
    if (!isAggregable(row)) continue;
    if (row.invoice_month === null) continue;

    const point = byMonth.get(row.invoice_month) ?? {
      m: row.invoice_month,
      paid: 0,
      outstanding: 0,
    };
    if (row.payment_status === 'paid') {
      point.paid += row.eur_amount ?? 0;
    } else {
      point.outstanding += row.eur_amount ?? 0;
    }
    byMonth.set(row.invoice_month, point);
  }

  return Array.from(byMonth.values())
    .map((point) => ({
      m: point.m,
      paid: roundCurrency(point.paid),
      outstanding: roundCurrency(point.outstanding),
    }))
    .sort((a, b) => (a.m === b.m ? 0 : a.m < b.m ? -1 : 1));
}

/** Rows-Done count per dated month for the line chart. */
export function rowsDonePerMonth(data: ApiDataResponse): number[] {
  const byMonth = new Map<string, number>();

  for (const row of data.invoices) {
    if (!isReportingYearRow(row) || !row.is_done) continue;
    if (row.invoice_month === null) continue;
    byMonth.set(row.invoice_month, (byMonth.get(row.invoice_month) ?? 0) + 1);
  }

  return Array.from(byMonth.entries())
    .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1))
    .map(([, count]) => count);
}

export interface ProjectSpendRank {
  code: string;
  eur: number;
  rows: number;
}

/** Order codes ranked by total converted Done EUR spend. */
export function projectsRankedBySpend(data: ApiDataResponse): ProjectSpendRank[] {
  const byOrder = new Map<string, ProjectSpendRank>();

  for (const row of data.invoices) {
    if (!isAggregable(row)) continue;
    const rank = byOrder.get(row.order_code) ?? { code: row.order_code, eur: 0, rows: 0 };
    rank.eur += row.eur_amount ?? 0;
    rank.rows += 1;
    byOrder.set(row.order_code, rank);
  }

  return Array.from(byOrder.values())
    .map((rank) => ({ ...rank, eur: roundCurrency(rank.eur) }))
    .sort((a, b) => {
      if (a.eur !== b.eur) return b.eur - a.eur;
      return a.code === b.code ? 0 : a.code < b.code ? -1 : 1;
    });
}

/* ----------------------------------------------------------------------- */
/* US4 — Per-Website Current Price.                                         */
/* ----------------------------------------------------------------------- */

export interface WebsiteCurrentPrice {
  website: string;
  /**
   * EUR amount of the website's most-recent DATED invoice; null when the
   * website has zero dated invoices ("unknown" per FR-014).
   */
  current_price_eur: number | null;
  /** Native amount of the same row (for hover / drill-down display). */
  current_price_native_amount: number | null;
  current_price_native_currency: string | null;
  /** ISO YYYY-MM-DD of the chosen invoice; null when current_price_eur is null. */
  current_price_invoice_date: string | null;
  /** Stable identifier of the chosen row, used for drill-down. */
  current_price_source_row_key: string | null;
  /**
   * Payment status of the chosen current-price row. Kept on the selector
   * for backward compat and drill-down use; the table no longer renders a
   * status chip (operator request).
   */
  current_price_payment_status: PaymentStatus | null;
  /**
   * Published article URL from the chosen current-price row. Null when
   * the row had no live_url cell or when
   * the website has only undated invoices.
   */
  current_price_live_url: string | null;
  /** Total Done+converted invoices for this website (any date). */
  history_count: number;
  /** Subset of history_count where date_source==='undated'. */
  undated_count: number;
}

/**
 * Build the per-website current-price list (US4 — FR-014).
 *
 * For each distinct website:
 *   • Among rows where is_done=true AND conversion_status='converted'
 *     AND invoice_date is parseable, pick the row with max(invoice_date).
 *     Ties broken DETERMINISTICALLY:
 *       1. highest row_index within the max-date group
 *       2. lexically-greatest source_row_key cross-sheet
 *   • If the website has zero dated rows, current_price_eur is null
 *     ("unknown" — User Story 4 acceptance scenario 2).
 *   • Undated rows count toward history_count + undated_count so the
 *     operator sees them on drill-down + Audit (FR-014).
 *
 * Returns an array sorted alphabetically by canonical website.
 */
export function websiteCurrentPrices(
  data: ApiDataResponse,
  today: string = NO_FUTURE_FILTER,
  minRowsPerYear: number = 0,
  /**
   * When true, drop rows whose `live_url` field is empty so the view
   * doesn't fall back to showing a bare publisher domain (which looks like
   * a homepage to the operator). Production passes true; legacy tests
   * with pre-`live_url` fixtures default to false so they keep passing.
   */
  requireLiveUrl: boolean = false,
): WebsiteCurrentPrice[] {
  const noise = getNoiseYears(data, today, minRowsPerYear);
  const byWebsite = new Map<string, InvoiceRow[]>();
  for (const row of data.invoices) {
    if (!isAggregable(row)) continue;
    if (!isNotFutureDated(row, today)) continue;
    if (!isVisibleYear(row, noise)) continue;
    if (row.website === null) continue;
    if (requireLiveUrl) {
      const live = row.live_url;
      if (live === null || live === undefined || live.trim() === '') continue;
    }
    const arr = byWebsite.get(row.website) ?? [];
    arr.push(row);
    byWebsite.set(row.website, arr);
  }

  const out: WebsiteCurrentPrice[] = [];
  for (const [website, rows] of byWebsite) {
    const dated = rows.filter((r) => r.invoice_date !== null);
    const undated = rows.length - dated.length;

    if (dated.length === 0) {
      out.push({
        website,
        current_price_eur: null,
        current_price_native_amount: null,
        current_price_native_currency: null,
        current_price_invoice_date: null,
        current_price_source_row_key: null,
        current_price_payment_status: null,
        current_price_live_url: null,
        history_count: rows.length,
        undated_count: undated,
      });
      continue;
    }

    // Pick max(invoice_date), tie-break by row_index desc, then
    // source_row_key desc by codepoint (NOT localeCompare — QA review H17:
    // localeCompare is host-locale-sensitive; two operators in different
    // locales could otherwise see different "current price" rows on a tie).
    dated.sort((a, b) => {
      const ad = a.invoice_date as string;
      const bd = b.invoice_date as string;
      if (ad !== bd) return ad < bd ? 1 : -1;
      if (a.row_index !== b.row_index) return b.row_index - a.row_index;
      if (a.source_row_key === b.source_row_key) return 0;
      return a.source_row_key < b.source_row_key ? 1 : -1;
    });
    // Refactor-proof: prefer an explicit guard over the non-null assertion.
    const winner = dated[0];
    if (winner === undefined) continue;

    out.push({
      website,
      current_price_eur: winner.eur_amount,
      current_price_native_amount: winner.native_amount,
      current_price_native_currency: winner.native_currency,
      current_price_invoice_date: winner.invoice_date,
      current_price_source_row_key: winner.source_row_key,
      current_price_payment_status: winner.payment_status,
      // `live_url` is .optional() on the wire schema (back-compat with
      // pre-add test fixtures), so it may be undefined here even though
      // production always emits it.
      current_price_live_url: winner.live_url ?? null,
      history_count: rows.length,
      undated_count: undated,
    });
  }

  // Codepoint sort for website ordering — same determinism reasoning as
  // above; the cross-locale risk is low for canonical hostnames but the
  // rule is uniform.
  out.sort((a, b) => (a.website === b.website ? 0 : a.website < b.website ? -1 : 1));
  return out;
}

/* ----------------------------------------------------------------------- */
/* US5 — Provenance drill-down row resolvers.                               */
/* ----------------------------------------------------------------------- */

/**
 * Return every row that contributes to a given (orderCode, monthBucket)
 * scope. Used by `<ProvenanceDrawer>` (T085) when the operator clicks a
 * spend headline. Includes audit-only rows (is_done && conversion_status
 * !== 'converted') so the drawer can explain WHY a row didn't contribute
 * EUR — never silently hide them.
 *
 * Filtering rules:
 *   • orderCode == null  → all orders for the bucket
 *   • monthBucket == null → all months (lifetime view)
 *   • monthBucket === 'Undated' → only undated rows
 *
 * Result is sorted by row_index ascending, then by source_row_key codepoint
 * (deterministic across renders).
 */
export function drillRowsForScope(
  data: ApiDataResponse,
  orderCode: string | null,
  monthBucket: string | null,
): InvoiceRow[] {
  const out: InvoiceRow[] = [];
  for (const row of data.invoices) {
    if (!isReportingYearRow(row) || !row.is_done) continue;
    if (orderCode !== null && row.order_code !== orderCode) continue;
    if (monthBucket !== null) {
      const rowMonth = row.invoice_month ?? 'Undated';
      if (rowMonth !== monthBucket) continue;
    }
    out.push(row);
  }
  out.sort((a, b) => {
    if (a.row_index !== b.row_index) return a.row_index - b.row_index;
    return a.source_row_key === b.source_row_key
      ? 0
      : a.source_row_key < b.source_row_key
        ? -1
        : 1;
  });
  return out;
}

/**
 * Return every aggregable + audit-only row for a given website. Used by
 * `<ProvenanceDrawer>` when the operator clicks a row in `<WebsiteTable>`.
 * Includes undated rows so US4 acceptance scenario 2 is visibly satisfied
 * ("undated rows are listed on drill-down").
 */
export function drillRowsForWebsite(
  data: ApiDataResponse,
  website: string,
  today: string = NO_FUTURE_FILTER,
  minRowsPerYear: number = 0,
): InvoiceRow[] {
  const noise = getNoiseYears(data, today, minRowsPerYear);
  const out: InvoiceRow[] = [];
  for (const row of data.invoices) {
    if (!isReportingYearRow(row) || !row.is_done) continue;
    if (!isNotFutureDated(row, today)) continue;
    if (!isVisibleYear(row, noise)) continue;
    if (row.website !== website) continue;
    out.push(row);
  }
  // Sort: most recent dated first, undated last; tie-break by row_index desc
  // then source_row_key codepoint desc.
  out.sort((a, b) => {
    const ad = a.invoice_date;
    const bd = b.invoice_date;
    if (ad === null && bd !== null) return 1;
    if (ad !== null && bd === null) return -1;
    if (ad !== null && bd !== null && ad !== bd) return ad < bd ? 1 : -1;
    if (a.row_index !== b.row_index) return b.row_index - a.row_index;
    if (a.source_row_key === b.source_row_key) return 0;
    return a.source_row_key < b.source_row_key ? 1 : -1;
  });
  return out;
}

/* ----------------------------------------------------------------------- */
/* US6 — Audit panel category resolver.                                     */
/* ----------------------------------------------------------------------- */

export type AuditCategoryKey =
  | 'non_done_row'
  | 'missing_price'
  | 'unparseable_amount'
  | 'missing_currency'
  | 'missing_invoice_url'
  | 'missing_date'
  | 'unknown_payment_status'
  | 'missing_payment_status'
  | 'duplicate_invoice_id'
  | 'out_of_ecb_currency'
  | 'future_dated_invoice'
  | 'artifact_unreachable'
  | 'pdf_extraction_failed'
  | 'paypal_verification_mismatch';

/**
 * Closed list of every audit category the FRONTEND knows how to render.
 * Iteration sites MUST use this — never `Object.keys(data.audit_findings_by_category)` —
 * because the H7 forward-compat fix on the wire schema uses `.passthrough()`,
 * meaning a future backend that adds a new category will leak that key
 * through into the parsed data. Counting / rendering off the runtime keys
 * would let unknown categories inflate the badge or crash a `.length` on
 * a non-array value (passthrough preserves shape verbatim).
 */
export const V1_AUDIT_CATEGORIES: AuditCategoryKey[] = [
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

/**
 * Categories the operator-facing Audit panel groups into "v2-reserved" — the
 * API always emits them as [] in v1 (FR-022); the UI shows a placeholder
 * row explaining the v2 gate.
 */
export const V2_RESERVED_AUDIT_CATEGORIES: AuditCategoryKey[] = [
  'pdf_extraction_failed',
  'paypal_verification_mismatch',
];

/**
 * Frontend selector that mirrors api/data.ts emission: every category key
 * is present, value is the array of findings (possibly empty).
 *
 * The selector is essentially an identity over `data.audit_findings_by_category`,
 * but explicit so:
 *   • the AuditPanel doesn't reach into the wire shape directly
 *   • a future schema change (renaming a category) shows up here as a
 *     compile error AND in component tests, not silently
 *   • we can stamp v2-reserved categories with an empty-by-design hint
 *     without polluting the wire schema
 */
export function auditByCategory(
  data: ApiDataResponse,
): Record<AuditCategoryKey, ApiDataResponse['audit_findings_by_category'][AuditCategoryKey]> {
  return data.audit_findings_by_category;
}

/**
 * Total number of NON-empty v1 audit categories — used for the tab badge.
 *
 * Iterates the CLOSED V1_AUDIT_CATEGORIES list, NOT Object.keys(data) — the
 * H7 passthrough on the wire schema preserves any unknown future category
 * keys verbatim, and counting them would inflate the badge for categories
 * the AuditPanel can't even render. Defensive `Array.isArray` check guards
 * against passthrough preserving a non-array value for a known key.
 */
export function nonEmptyAuditCategoryCount(data: ApiDataResponse): number {
  let n = 0;
  const cats = auditByCategory(data);
  for (const key of V1_AUDIT_CATEGORIES) {
    const findings = cats[key];
    if (Array.isArray(findings) && findings.length > 0) n += 1;
  }
  return n;
}

/* ----------------------------------------------------------------------- */
/* Catalog selectors (for filters + month selector).                        */
/* ----------------------------------------------------------------------- */

/**
 * Distinct month buckets present in the data, sorted descending (most
 * recent first). `Undated` (when present) is appended at the end.
 */
export function distinctMonths(data: ApiDataResponse): string[] {
  const set = new Set<string>();
  let hasUndated = false;
  for (const row of data.invoices) {
    if (!isAggregable(row)) continue;
    if (row.invoice_month === null) {
      hasUndated = true;
    } else {
      set.add(row.invoice_month);
    }
  }
  const months = Array.from(set).sort().reverse();
  if (hasUndated) months.push('Undated');
  return months;
}

/** Distinct order codes present in the data, sorted alphabetically. */
export function distinctOrderCodes(data: ApiDataResponse): string[] {
  const set = new Set<string>();
  for (const row of data.invoices) {
    if (!isReportingYearRow(row)) continue;
    set.add(row.order_code);
  }
  return Array.from(set).sort();
}

/* ----------------------------------------------------------------------- */
/* Redesign selectors (HANDOFF v2 §3).                                      */
/*                                                                          */
/* The filter model moves from `scope: 'month' | 'lifetime'` + a separate   */
/* selected month string to a three-axis `SpendScope { year, month,         */
/* orderCode }`. The selectors below are pure derivations over              */
/* `ApiDataResponse.invoices`. Legacy selectors above are intentionally     */
/* kept (HANDOFF §3.6) for tests + future consumers.                        */
/* ----------------------------------------------------------------------- */

export interface SpendScope {
  /** 'all' or 'YYYY'. */
  year: string;
  /** 'all' or '01'..'12'. Ignored when year === 'all'. */
  month: string;
  /** Single order_code or null for all projects. */
  orderCode: string | null;
}

export interface ScopedSummary {
  eur: number;
  savings_eur: number;
  count: number;
  by_status: PaymentStatusBreakdown;
}

/**
 * Sentinel "no filter" for the optional `today` parameter on selectors
 * below. Callers that don't pass `today` get this value, which compares
 * greater than every plausible invoice_date and therefore disables the
 * future-date filter.
 *
 * Selectors.ts is locked against `Date.now` / `new Date(` by the FR-024
 * grep guard (tests/lib/date-source.test.ts) — the locked files must
 * never derive month buckets or "today" from the client clock. That's a
 * UI concern: App.tsx (which is allowed to use `Date.now()` because it's
 * a component) generates the current date and passes it into the
 * selectors that hide future-dated rows.
 */
const NO_FUTURE_FILTER = '9999-12-31';

/**
 * The executive report's Month field is authoritative. Source invoice dates
 * can be outside 2026 after the workbook's explicit remapping, so only the
 * reporting month is compared with today.
 */
function isNotFutureDated(row: InvoiceRow, today: string): boolean {
  return row.invoice_month === null || row.invoice_month <= today.slice(0, 7);
}

/**
 * Threshold below which a year is treated as noise (operator typos) and
 * hidden from filters, charts, KPIs, and the Live URLs table. App.tsx
 * passes this to every year-aware selector; tests omit it (default 0 →
 * no filtering) so existing fixtures with single-digit-per-year rows
 * keep working.
 */
export const MIN_VISIBLE_YEAR_ROWS = 10;

/**
 * Compute the set of "noise" years — years where the aggregable row count
 * is below the threshold. Empty set when the threshold is 0.
 *
 * Note: undated rows (invoice_month === null) aren't bucketed by year so
 * they're unaffected by this filter — they show up under their own
 * "Undated" bucket as before.
 */
function getNoiseYears(
  data: ApiDataResponse,
  today: string,
  minRowsPerYear: number,
): Set<string> {
  if (minRowsPerYear <= 0) return new Set();
  const counts = new Map<string, number>();
  for (const row of data.invoices) {
    if (!isAggregable(row)) continue;
    if (!isNotFutureDated(row, today)) continue;
    if (row.invoice_month === null) continue;
    const year = row.invoice_month.slice(0, 4);
    counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [year, count] of counts) {
    if (count < minRowsPerYear) out.add(year);
  }
  return out;
}

/**
 * `true` when the row is from a "visible" year (i.e., not a noise year).
 * Undated rows pass through unaffected.
 */
function isVisibleYear(row: InvoiceRow, noise: Set<string>): boolean {
  if (noise.size === 0) return true;
  if (row.invoice_month === null) return true;
  return !noise.has(row.invoice_month.slice(0, 4));
}

export interface MonthBreakdown {
  /** YYYY-MM bucket. */
  m: string;
  /** EUR total across all aggregable rows in the month (within scope). */
  total: number;
  /** [{code, value}] in global project-rank order (NOT per-month rank). */
  byProject: Array<{ code: string; value: number }>;
}

/**
 * Per-row scope predicate. Reuses the existing `isAggregable` invariant
 * (`is_done && conversion_status === 'converted'`) and adds the three
 * filter axes on top.
 *
 * Undated rows (`invoice_month === null`): included ONLY when
 * `scope.year === 'all'`. Any year-specific query excludes them; the
 * Audit panel still surfaces them via `missing_date`.
 */
export function isAggregableInScope(
  row: InvoiceRow,
  scope: SpendScope,
  today: string = NO_FUTURE_FILTER,
  noiseYearsSet: Set<string> = new Set(),
): boolean {
  if (!isAggregable(row)) return false;
  // Hide future-dated typos from every dashboard aggregate.
  if (!isNotFutureDated(row, today)) return false;
  // Hide noise-year rows (years with too few aggregable rows — operator typos).
  if (!isVisibleYear(row, noiseYearsSet)) return false;
  if (scope.orderCode !== null && row.order_code !== scope.orderCode) return false;
  if (row.invoice_month === null) {
    return scope.year === 'all';
  }
  const parts = row.invoice_month.split('-');
  const y = parts[0];
  const m = parts[1];
  if (y === undefined || m === undefined) return false;
  if (scope.year !== 'all' && y !== scope.year) return false;
  if (scope.month !== 'all' && m !== scope.month) return false;
  return true;
}

/**
 * EUR sum + count across the scope. Drops the by-status breakdown — the
 * operator doesn't use it (see HANDOFF §0 "Payment status / outstanding").
 */
export function spendInScope(
  data: ApiDataResponse,
  scope: SpendScope,
  today: string = NO_FUTURE_FILTER,
  minRowsPerYear: number = 0,
): ScopedSummary {
  const noise = getNoiseYears(data, today, minRowsPerYear);
  const byStatus = emptyBreakdown();
  let savingsEur = 0;
  let count = 0;
  for (const row of data.invoices) {
    if (!isAggregableInScope(row, scope, today, noise)) continue;
    const spend = row.eur_amount ?? 0;
    byStatus[row.payment_status].spend_eur += spend;
    byStatus[row.payment_status].count += 1;
    savingsEur += row.savings_eur;
    count += 1;
  }
  let eur = 0;
  for (const status of ['paid', 'unpaid', 'unknown', 'missing'] satisfies PaymentStatus[]) {
    byStatus[status].spend_eur = roundCurrency(byStatus[status].spend_eur);
    eur += byStatus[status].spend_eur;
  }
  return {
    eur: roundCurrency(eur),
    savings_eur: roundCurrency(savingsEur),
    count,
    by_status: byStatus,
  };
}

/**
 * Per-month EUR breakdown sorted chronologically. Each month's `byProject`
 * is in GLOBAL project-rank order (from `projectsRankedBySpend(data)`),
 * which is what StackedBars + DonutChart palette-index against so a
 * project keeps the same colour across charts.
 *
 * Undated rows are excluded (no `invoice_month` to bucket against).
 * `scope.orderCode` narrows to a single project.
 * `scope.year` and `scope.month` filter the months that appear.
 */
export function monthlyBreakdowns(
  data: ApiDataResponse,
  scope: SpendScope,
  today: string = NO_FUTURE_FILTER,
  minRowsPerYear: number = 0,
): MonthBreakdown[] {
  const rankedCodes = projectsRankedBySpend(data).map((p) => p.code);
  const byMonth = new Map<string, Map<string, number>>();
  const noise = getNoiseYears(data, today, minRowsPerYear);

  for (const row of data.invoices) {
    if (!isAggregable(row)) continue;
    if (!isNotFutureDated(row, today)) continue;
    if (!isVisibleYear(row, noise)) continue;
    if (row.invoice_month === null) continue;
    if (scope.year !== 'all') {
      const parts = row.invoice_month.split('-');
      const y = parts[0];
      const m = parts[1];
      if (y === undefined || m === undefined) continue;
      if (y !== scope.year) continue;
      if (scope.month !== 'all' && m !== scope.month) continue;
    }
    if (scope.orderCode !== null && row.order_code !== scope.orderCode) continue;

    const bucket = byMonth.get(row.invoice_month) ?? new Map<string, number>();
    bucket.set(
      row.order_code,
      (bucket.get(row.order_code) ?? 0) + (row.eur_amount ?? 0),
    );
    byMonth.set(row.invoice_month, bucket);
  }

  return Array.from(byMonth.entries())
    .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1))
    .map(([m, perOrder]) => {
      const byProject = rankedCodes
        .map((code) => ({ code, value: roundCurrency(perOrder.get(code) ?? 0) }))
        .filter((p) => p.value > 0);
      // Defensive append: any code in the month that's missing from the
      // global ranking (shouldn't happen, but the ranking is filtered).
      for (const [code, value] of perOrder) {
        if (!rankedCodes.includes(code) && value > 0) {
          byProject.push({ code, value: roundCurrency(value) });
        }
      }
      const total = byProject.reduce((a, b) => a + b.value, 0);
      return { m, total: roundCurrency(total), byProject };
    });
}

/**
 * Rows-Done count per dated month, optionally filtered to one order.
 *
 * Year/month filters DO NOT apply — the line chart always shows the full
 * timeline so the operator can see the trend, per HANDOFF §3.4.
 *
 * Returns parallel arrays so the callsite can build labels from `months`.
 */
export function rowsDoneSeries(
  data: ApiDataResponse,
  orderCode: string | null,
  today: string = NO_FUTURE_FILTER,
  minRowsPerYear: number = 0,
): { months: string[]; counts: number[] } {
  const noise = getNoiseYears(data, today, minRowsPerYear);
  const byMonth = new Map<string, number>();
  for (const row of data.invoices) {
    if (!isReportingYearRow(row) || !row.is_done) continue;
    if (row.invoice_month === null) continue;
    if (!isNotFutureDated(row, today)) continue;
    if (!isVisibleYear(row, noise)) continue;
    if (orderCode !== null && row.order_code !== orderCode) continue;
    byMonth.set(row.invoice_month, (byMonth.get(row.invoice_month) ?? 0) + 1);
  }
  const sorted = Array.from(byMonth.entries()).sort(([a], [b]) =>
    a === b ? 0 : a < b ? -1 : 1,
  );
  return {
    months: sorted.map(([m]) => m),
    counts: sorted.map(([, c]) => c),
  };
}

/**
 * Distinct years present in the data, sorted reverse-chronological
 * (newest first) so the YearFilter dropdown opens to the most-recent year
 * at the top.
 *
 * Future years (where every row in the year is future-dated relative to
 * today UTC) are hidden so the operator can't accidentally pick a year
 * that's purely typos. The audit panel still surfaces those rows.
 */
export function distinctYears(
  data: ApiDataResponse,
  today: string = NO_FUTURE_FILTER,
  minRowsPerYear: number = 0,
): string[] {
  const noise = getNoiseYears(data, today, minRowsPerYear);
  const todayMonth = today.slice(0, 7);
  const set = new Set<string>();
  for (const m of distinctMonths(data)) {
    if (!/^\d{4}-\d{2}$/.test(m)) continue;
    if (m > todayMonth) continue;
    const year = m.slice(0, 4);
    if (noise.has(year)) continue;
    set.add(year);
  }
  return Array.from(set).sort().reverse();
}

/**
 * Months ('01'..'12') present in the data for a given year, sorted
 * ascending. Returns `[]` when the year has no dated rows.
 *
 * For the current year, only months on or before today UTC are returned —
 * future months don't appear as filter options.
 */
export function monthsInYear(
  data: ApiDataResponse,
  year: string,
  today: string = NO_FUTURE_FILTER,
  minRowsPerYear: number = 0,
): string[] {
  const noise = getNoiseYears(data, today, minRowsPerYear);
  if (noise.has(year)) return [];
  const todayMonth = today.slice(0, 7);
  return distinctMonths(data)
    .filter((m) => /^\d{4}-\d{2}$/.test(m) && m.startsWith(`${year}-`) && m <= todayMonth)
    .map((m) => m.slice(5, 7))
    .sort();
}

/**
 * Lifetime Done-row count for a single order. Counts every `is_done` row
 * regardless of `conversion_status` (so audit-only rows still count as
 * "links built"), but excludes future-dated typos so the "Links built"
 * KPI matches what's actually shipped.
 */
export function lifetimeRowsDoneFor(
  data: ApiDataResponse,
  code: string,
  today: string = NO_FUTURE_FILTER,
  minRowsPerYear: number = 0,
): number {
  const noise = getNoiseYears(data, today, minRowsPerYear);
  let n = 0;
  for (const row of data.invoices) {
    if (!isReportingYearRow(row) || !row.is_done) continue;
    if (row.order_code !== code) continue;
    if (!isNotFutureDated(row, today)) continue;
    if (!isVisibleYear(row, noise)) continue;
    n += 1;
  }
  return n;
}
