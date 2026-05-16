/**
 * T029 — NON-NEGOTIABLE per Constitution Principle V.
 *
 * Required fixtures (3 currencies — Codex review #1 regression + SC-007):
 *   • EUR row with ecb_rate=1.0 → eur_amount === native_amount
 *   • USD row, native=100, ecb_rate=1.0789 → eur_amount ≈ 92.69 (±0.01)
 *   • GBP row, native=100, ecb_rate=0.8412 → eur_amount ≈ 118.88
 *   • PLN row, native=400, ecb_rate=4.2810 → eur_amount ≈ 93.44
 *
 * The non-EUR fixtures are load-bearing: they catch FX-direction inversion
 * (a EUR-only suite would pass with eur = native * rate AND eur = native /
 * rate because ecb_rate is always 1.0 for EUR rows).
 *
 * The test creates an in-memory SQLite store, seeds the ecb_rates table
 * with known rates for a fixed date, then calls toEur and asserts the
 * computed EUR amount matches the hand-computed value within ±0.01.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toEur, EcbRateUnavailableError } from '../../../src/pipeline/normalize/currency.js';
import { upsertEcbRate } from '../../../src/pipeline/normalize/ecb-cache.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const SCHEMA_PATH = resolve(__dirname, '../../../src/pipeline/store/schema.sql');

const TEST_DATE = '2026-04-15';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  // Seed ECB rates for the test date (foreign units per 1 EUR).
  upsertEcbRate(db, TEST_DATE, 'USD', 1.0789);
  upsertEcbRate(db, TEST_DATE, 'GBP', 0.8412);
  upsertEcbRate(db, TEST_DATE, 'PLN', 4.281);
  upsertEcbRate(db, TEST_DATE, 'EUR', 1.0);
  return db;
}

describe('toEur (T029 — NON-NEGOTIABLE)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it('EUR row: eur_amount === native_amount, rate=1.0', () => {
    const result = toEur(db, 250.5, 'EUR', TEST_DATE);
    expect(result.eur_amount).toBe(250.5);
    expect(result.ecb_rate).toBe(1.0);
    expect(result.ecb_rate_as_of).toBe(TEST_DATE);
  });

  it('USD row: 100 USD ÷ 1.0789 ≈ 92.69 (FX direction regression)', () => {
    const result = toEur(db, 100, 'USD', TEST_DATE);
    expect(result.eur_amount).toBeCloseTo(92.69, 2);
    expect(result.ecb_rate).toBe(1.0789);
    expect(result.ecb_rate_as_of).toBe(TEST_DATE);
  });

  it('GBP row: 100 GBP ÷ 0.8412 ≈ 118.88', () => {
    const result = toEur(db, 100, 'GBP', TEST_DATE);
    expect(result.eur_amount).toBeCloseTo(118.88, 2);
    expect(result.ecb_rate).toBe(0.8412);
  });

  it('PLN row: 400 PLN ÷ 4.281 ≈ 93.44', () => {
    const result = toEur(db, 400, 'PLN', TEST_DATE);
    expect(result.eur_amount).toBeCloseTo(93.44, 2);
    expect(result.ecb_rate).toBe(4.281);
  });

  it('case-insensitive on currency code (lowercase usd works)', () => {
    const result = toEur(db, 100, 'usd', TEST_DATE);
    expect(result.eur_amount).toBeCloseTo(92.69, 2);
  });

  it('falls back to most recent prior ECB date for weekend/holiday', () => {
    // ECB published on TEST_DATE = 2026-04-15 (Wednesday). Invoice date
    // is two days later (Friday) — there's no rate yet for 04-17, so we
    // expect the lookup to use 2026-04-15 as rate_as_of.
    const result = toEur(db, 100, 'USD', '2026-04-17');
    expect(result.eur_amount).toBeCloseTo(92.69, 2);
    expect(result.ecb_rate_as_of).toBe(TEST_DATE);
  });

  it('throws EcbRateUnavailableError for currency not in ECB cache', () => {
    expect(() => toEur(db, 100, 'XPT', TEST_DATE)).toThrow(EcbRateUnavailableError);
  });

  it('throws on non-finite nativeAmount', () => {
    expect(() => toEur(db, Number.NaN, 'USD', TEST_DATE)).toThrow();
    expect(() => toEur(db, Number.POSITIVE_INFINITY, 'USD', TEST_DATE)).toThrow();
  });

  it('rounds EUR amounts to cents', () => {
    // 12.345 EUR → 12.35 (banker's? No — Math.round half-up).
    const result = toEur(db, 12.345, 'EUR', TEST_DATE);
    expect(result.eur_amount).toBe(12.35);
  });
});
