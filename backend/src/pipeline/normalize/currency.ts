/**
 * EUR conversion (Constitution Principle V — NON-NEGOTIABLE).
 *
 * Convention: ECB rates are stored ECB-native (foreign currency units per
 * 1 EUR). Conversion DIVIDES:
 *
 *     eur_amount = native_amount / ecb_rate
 *
 * For native EUR rows, ecb_rate=1.0 and the identity reduces to
 *     eur_amount = native_amount.
 *
 * The function takes a SQLite Database handle to consult the cached ECB
 * rates (with weekend/holiday fallback). Throws EcbRateUnavailableError
 * via the cache module if the currency is not in the ECB reference set —
 * the caller (normalize/index.ts) catches it and records the row as
 * conversion_status='out_of_ecb_currency'.
 *
 * Tests cover ≥3 currencies (USD, GBP, PLN — see SC-007 and the regression
 * test for Codex review #1 from branch 7c9b3fb).
 */

import type { Database as DatabaseT } from 'better-sqlite3';
import { getRateForDate, EcbRateUnavailableError } from './ecb-cache.js';

export interface ToEurResult {
  eur_amount: number;
  ecb_rate: number;
  ecb_rate_as_of: string;
}

/**
 * Convert a native amount into EUR using the ECB cache.
 *
 * @param db                 Open SQLite handle (writable or read-only)
 * @param nativeAmount       Amount in `nativeCurrency`
 * @param nativeCurrency     ISO 4217 code (e.g., "USD", "EUR", "GBP")
 * @param invoiceDate        ISO YYYY-MM-DD; the ECB rate for this date (or
 *                           the most recent prior business day) is used.
 *
 * Throws EcbRateUnavailableError when the currency is unknown to ECB or
 * no rate exists on/before invoiceDate (the caller flags the row).
 */
export function toEur(
  db: DatabaseT,
  nativeAmount: number,
  nativeCurrency: string,
  invoiceDate: string,
): ToEurResult {
  if (!Number.isFinite(nativeAmount)) {
    throw new Error(`toEur: nativeAmount must be a finite number (got ${nativeAmount})`);
  }
  const cur = nativeCurrency.toUpperCase();

  if (cur === 'EUR') {
    return {
      eur_amount: roundCents(nativeAmount),
      ecb_rate: 1.0,
      ecb_rate_as_of: invoiceDate,
    };
  }

  const { rate, rate_as_of } = getRateForDate(db, cur, invoiceDate);
  // ECB-native: rate is foreign units per 1 EUR. Divide to get EUR.
  const eur = nativeAmount / rate;
  return {
    eur_amount: roundCents(eur),
    ecb_rate: rate,
    ecb_rate_as_of: rate_as_of,
  };
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

// Re-export the unavailable error so callers can `catch (err) { if (err instanceof EcbRateUnavailableError) ... }`.
export { EcbRateUnavailableError };
