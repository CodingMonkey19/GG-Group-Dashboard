/**
 * Test helper — open an in-memory SQLite store with the production schema
 * and seed a small set of ECB rates so tests don't need network access.
 *
 * Used by every integration test (T034a, T035, T087a, T041b, etc.).
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertEcbRate } from '../../src/pipeline/normalize/ecb-cache.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const SCHEMA_PATH = resolve(__dirname, '../../src/pipeline/store/schema.sql');

export interface TestDbOptions {
  /** ISO YYYY-MM-DD; ECB rates seeded for this date. Default 2026-04-15. */
  ecbDate?: string;
  /** Additional ECB rates to seed (date → currency → rate). */
  extraRates?: Array<{ date: string; currency: string; rate: number }>;
}

const DEFAULT_ECB_DATE = '2026-04-15';

export function openTestDb(options: TestDbOptions = {}): Database.Database {
  const db = new Database(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));

  const date = options.ecbDate ?? DEFAULT_ECB_DATE;
  upsertEcbRate(db, date, 'USD', 1.0789);
  upsertEcbRate(db, date, 'GBP', 0.8412);
  upsertEcbRate(db, date, 'PLN', 4.281);
  upsertEcbRate(db, date, 'CHF', 0.9456);
  upsertEcbRate(db, date, 'EUR', 1.0);

  for (const r of options.extraRates ?? []) {
    upsertEcbRate(db, r.date, r.currency, r.rate);
  }
  return db;
}
