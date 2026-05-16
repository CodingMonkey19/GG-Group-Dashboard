/**
 * ECB daily reference rate cache (Constitution Principle V, FR-004).
 *
 * Convention (NON-NEGOTIABLE — see research.md Decision 6 + data-model.md):
 *   ECB publishes rates as foreign currency units per 1 EUR. We store the
 *   value verbatim. Conversion DIVIDES:
 *
 *       eur_amount = native_amount / ecb_rate
 *
 *   For native EUR rows, ecb_rate=1.0 and the identity reduces to identity.
 *
 * Lookup rule: for an invoice on date D in currency C, return the ECB rate
 * for (D, C). If there is no row for that exact date (weekend / holiday),
 * fall back to the most recent prior date and record the as-of date used.
 *
 * Population: `fetchEcbDailyXml` pulls the ECB's eurofxref-daily XML feed
 * once per consolidate.ts run and inserts any new (date, currency) rows.
 * Currencies absent from the ECB feed are out of scope per Principle V —
 * the caller flags them as `out_of_ecb_currency` and excludes from totals.
 */

import type { Database as DatabaseT } from 'better-sqlite3';

const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const ECB_90D_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';
/**
 * Full ECB historical reference rates from 1999 to today.
 * Codex review of branch 363b776 → bzj921whd Finding #4: the 90-day feed
 * silently dropped invoices older than 90 days as out_of_ecb_currency.
 * For an all-time spend dashboard we need the full history.
 *
 * The full file is ~1-2 MB; fetched on every refresh. The
 * INSERT OR REPLACE PK on (date, currency) means repeated fetches are
 * idempotent — no DB growth from re-ingesting the same data.
 */
const ECB_HIST_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml';

export interface EcbRateLookup {
  rate: number;
  /** ISO date YYYY-MM-DD of the ECB publication actually used (may be earlier than the invoice date). */
  rate_as_of: string;
}

/** Why the rate lookup failed. Both map to conversion_status='out_of_ecb_currency'
 * for v1, but the audit summary text distinguishes them so the operator can
 * tell a misspelled currency from a date-out-of-coverage row (QA review H8).
 */
export type EcbRateUnavailableReason = 'currency_unknown' | 'no_rate_on_or_before_date';

export class EcbRateUnavailableError extends Error {
  override readonly name = 'EcbRateUnavailableError';
  constructor(
    public readonly currency: string,
    public readonly invoiceDate: string,
    public readonly reason: EcbRateUnavailableReason,
  ) {
    super(
      reason === 'currency_unknown'
        ? `Currency '${currency}' is not in the ECB reference set`
        : `No ECB rate available for ${currency} on or before ${invoiceDate} ` +
            `(currency exists in the feed but coverage starts after this date)`,
    );
  }
}

/**
 * Look up the ECB rate for `currency` on or before `invoiceDate`.
 * Returns { rate, rate_as_of } or throws EcbRateUnavailableError. The
 * error's `reason` field distinguishes:
 *   • 'currency_unknown' — currency appears nowhere in the ecb_rates table
 *   • 'no_rate_on_or_before_date' — currency exists, but earliest entry is
 *     after invoiceDate (e.g., a pre-1999 invoice in a currency the feed
 *     started covering later)
 *
 * The caller maps both to conversion_status='out_of_ecb_currency' but
 * emits different audit summaries.
 */
export function getRateForDate(
  db: DatabaseT,
  currency: string,
  invoiceDate: string,
): EcbRateLookup {
  // Most-recent rate for this currency on or before invoiceDate.
  const row = db
    .prepare(
      `SELECT rate, date FROM ecb_rates
        WHERE currency = ? AND date <= ?
        ORDER BY date DESC
        LIMIT 1`,
    )
    .get(currency, invoiceDate) as { rate: number; date: string } | undefined;

  if (row) return { rate: row.rate, rate_as_of: row.date };

  // No row found. Distinguish: is the currency entirely absent, or just
  // not yet covered as of invoiceDate?
  const anyRow = db
    .prepare(`SELECT 1 FROM ecb_rates WHERE currency = ? LIMIT 1`)
    .get(currency) as { 1: number } | undefined;
  throw new EcbRateUnavailableError(
    currency,
    invoiceDate,
    anyRow ? 'no_rate_on_or_before_date' : 'currency_unknown',
  );
}

/**
 * Insert one ECB daily rate (used by tests and by fetchEcbDailyXml).
 */
export function upsertEcbRate(
  db: DatabaseT,
  date: string,
  currency: string,
  rate: number,
): void {
  if (rate <= 0 || !Number.isFinite(rate)) {
    throw new Error(`Invalid ECB rate for ${currency} on ${date}: ${rate}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO ecb_rates (date, currency, rate, fetched_at)
     VALUES (?, ?, ?, ?)`,
  ).run(date, currency, rate, new Date().toISOString());
}

/**
 * Fetch the ECB daily reference rates XML (one date) and insert any new rows.
 * Idempotent — repeated calls within the same day are no-ops.
 */
export async function fetchEcbDailyXml(db: DatabaseT, fetcher: typeof fetch = fetch): Promise<{
  date: string | null;
  rates_inserted: number;
}> {
  const res = await fetcher(ECB_DAILY_URL);
  if (!res.ok) {
    throw new Error(`ECB daily feed returned HTTP ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  return parseAndUpsertEcbXml(db, xml);
}

/**
 * Fetch the ECB 90-day historical rates XML.
 * Retained for tests + as a smaller-payload fallback. The default seeder
 * uses fetchEcbHistoricalXml() instead so the cache covers ALL invoice
 * dates back to 1999 (Codex review of branch 363b776 → bzj921whd Finding #4).
 */
export async function fetchEcb90DayXml(db: DatabaseT, fetcher: typeof fetch = fetch): Promise<{
  rates_inserted: number;
}> {
  const res = await fetcher(ECB_90D_URL);
  if (!res.ok) {
    throw new Error(`ECB 90-day feed returned HTTP ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  return parseAndUpsertEcbHistoricalXml(db, xml);
}

/**
 * Fetch the ECB FULL historical rates XML (all dates from 1999-01-04 to
 * today, ~30 currencies, ~1-2 MB payload). Idempotent on the
 * (date, currency) primary key.
 *
 * Codex review of branch 363b776 → bzj921whd Finding #4: a spend dashboard
 * holding the operator's full invoice history needs ECB coverage matching
 * that history, not the last 90 days. Default seeder calls this on every
 * refresh; the live store accumulates rates across runs anyway, so the
 * actual DB growth from this is paid only once.
 */
export async function fetchEcbHistoricalXml(
  db: DatabaseT,
  fetcher: typeof fetch = fetch,
): Promise<{ rates_inserted: number }> {
  const res = await fetcher(ECB_HIST_URL);
  if (!res.ok) {
    throw new Error(`ECB historical feed returned HTTP ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  return parseAndUpsertEcbHistoricalXml(db, xml);
}

/**
 * Copy every (date, currency, rate) entry from `srcDb.ecb_rates` into
 * `destDb.ecb_rates`. Used at the start of consolidate.ts to preserve
 * historical rates across staging-file lifecycles — without this, every
 * refresh would start with an empty rate cache and silently drop any
 * non-EUR invoice older than the current daily fetch (Codex Finding #1).
 *
 * Idempotent — INSERT OR REPLACE on the (date, currency) primary key.
 */
export function copyEcbRates(srcDb: DatabaseT, destDb: DatabaseT): { rates_copied: number } {
  const rows = srcDb
    .prepare('SELECT date, currency, rate, fetched_at FROM ecb_rates')
    .all() as Array<{ date: string; currency: string; rate: number; fetched_at: string }>;
  if (rows.length === 0) return { rates_copied: 0 };

  const insert = destDb.prepare(
    `INSERT OR REPLACE INTO ecb_rates (date, currency, rate, fetched_at) VALUES (?, ?, ?, ?)`,
  );
  const tx = destDb.transaction(() => {
    for (const r of rows) {
      insert.run(r.date, r.currency, r.rate, r.fetched_at);
    }
  });
  tx();
  return { rates_copied: rows.length };
}

/**
 * Parse the ECB daily XML shape (one date) and insert rows.
 * Shape:
 *   <Cube>
 *     <Cube time="2026-05-12">
 *       <Cube currency="USD" rate="1.0789"/>
 *       ...
 *     </Cube>
 *   </Cube>
 */
export function parseAndUpsertEcbXml(
  db: DatabaseT,
  xml: string,
): { date: string | null; rates_inserted: number } {
  const dateMatch = /<Cube\s+time="(\d{4}-\d{2}-\d{2})"/.exec(xml);
  const date = dateMatch?.[1] ?? null;
  if (date === null) {
    return { date: null, rates_inserted: 0 };
  }

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const { currency, rate } of parseCubeRates(xml)) {
      upsertEcbRate(db, date, currency, rate);
      inserted += 1;
    }
    // EUR is implicitly 1.0; insert it so callers don't special-case.
    upsertEcbRate(db, date, 'EUR', 1.0);
    inserted += 1;
  });
  tx();
  return { date, rates_inserted: inserted };
}

/**
 * Pull every `<Cube currency="X" rate="Y" />` from a Cube subtree (single-day
 * XML or one day-block of the historical feed). Tolerant of attribute order
 * but strict on the rate format (QA review H4):
 *
 *   • rate MUST be `\d+(?:\.\d+)?` — previously `[0-9.]+` accepted `"1.2.3"`
 *     and parseFloat silently truncated to 1.2, producing wrong conversions
 *     on feed-format drift.
 *   • currency MUST be exactly 3 ASCII uppercase letters.
 *   • Non-numeric rate or non-positive rate → skip + don't count, do NOT
 *     coerce to 0 (would explode division later).
 */
function* parseCubeRates(xml: string): Iterable<{ currency: string; rate: number }> {
  // Self-closing Cube element with currency + rate attributes in either order.
  const elemRe = /<Cube\s+([^/>]+)\/>/g;
  const attrRe = /(\w+)="([^"]*)"/g;
  const STRICT_RATE = /^\d+(?:\.\d+)?$/;
  const STRICT_CURRENCY = /^[A-Z]{3}$/;

  let elem: RegExpExecArray | null = elemRe.exec(xml);
  while (elem !== null) {
    const attrStr = elem[1]!;
    let currency: string | undefined;
    let rateStr: string | undefined;
    attrRe.lastIndex = 0;
    let attr: RegExpExecArray | null = attrRe.exec(attrStr);
    while (attr !== null) {
      const name = attr[1]!;
      const value = attr[2]!;
      if (name === 'currency') currency = value;
      else if (name === 'rate') rateStr = value;
      attr = attrRe.exec(attrStr);
    }
    if (
      currency !== undefined &&
      rateStr !== undefined &&
      STRICT_CURRENCY.test(currency) &&
      STRICT_RATE.test(rateStr)
    ) {
      const rate = Number.parseFloat(rateStr);
      if (Number.isFinite(rate) && rate > 0) {
        yield { currency, rate };
      }
    }
    elem = elemRe.exec(xml);
  }
}

/**
 * Parse the ECB 90-day XML shape (multiple dates) and insert all rows.
 * Shape:
 *   <Cube>
 *     <Cube time="2026-05-12"> ... rates ... </Cube>
 *     <Cube time="2026-05-09"> ... rates ... </Cube>
 *     ...
 *   </Cube>
 */
export function parseAndUpsertEcbHistoricalXml(
  db: DatabaseT,
  xml: string,
): { rates_inserted: number } {
  // Split into date-blocks. Each block starts at <Cube time="YYYY-MM-DD"> and
  // contains the day's currency rows up to the closing </Cube> for that block.
  const dayBlockRe = /<Cube\s+time="(\d{4}-\d{2}-\d{2})"\s*>([\s\S]*?)<\/Cube>/g;
  let inserted = 0;
  const tx = db.transaction(() => {
    let dayMatch: RegExpExecArray | null = dayBlockRe.exec(xml);
    while (dayMatch !== null) {
      const date = dayMatch[1]!;
      const dayXml = dayMatch[2]!;
      for (const { currency, rate } of parseCubeRates(dayXml)) {
        upsertEcbRate(db, date, currency, rate);
        inserted += 1;
      }
      upsertEcbRate(db, date, 'EUR', 1.0);
      inserted += 1;
      dayMatch = dayBlockRe.exec(xml);
    }
  });
  tx();
  return { rates_inserted: inserted };
}
