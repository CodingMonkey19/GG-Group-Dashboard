/**
 * Unit test for parsePriceCell + priceReasonToConversionStatus.
 *
 * Covers the audit-only-row admission semantics from research.md Decision 15:
 * a Done row with a missing or unparseable price still gets admitted to the
 * store with conversion_status set to the appropriate audit-only value, so
 * the Audit panel can surface it (not silently dropped).
 */

import { describe, expect, it } from 'vitest';
import {
  detectCurrencyFromCell,
  parsePriceCell,
  priceReasonToConversionStatus,
} from '../../../src/pipeline/normalize/conversion-status.js';

describe('parsePriceCell', () => {
  describe('missing_price', () => {
    it('returns missing_price for undefined cell (no column mapped)', () => {
      const r = parsePriceCell(undefined);
      expect(r.native_amount).toBeNull();
      expect(r.reason).toBe('missing_price');
    });
    it('returns missing_price for empty string', () => {
      expect(parsePriceCell('').reason).toBe('missing_price');
    });
    it('returns missing_price for whitespace-only', () => {
      expect(parsePriceCell('   ').reason).toBe('missing_price');
      expect(parsePriceCell('\t\n').reason).toBe('missing_price');
    });
  });

  describe('parsed', () => {
    const cases: Array<[string, number]> = [
      ['100', 100],
      ['100.5', 100.5],
      ['100.50', 100.5],
      ['1000.50', 1000.5],
      ['1,000.50', 1000.5], // US thousands + decimal
      ['1.000,50', 1000.5], // EU thousands + decimal
      ['1 000,50', 1000.5], // EU spaces + decimal
      ['100,50', 100.5], // LT/EU comma decimal
      ['€100.50', 100.5],
      ['100.50 €', 100.5],
      ['100 EUR', 100],
      ['$100', 100],
      ['  250  ', 250],
      ['0', 0],
      ['0.00', 0],
      ['-50', -50],
      // Codex review of branch 15c079b Finding #2 — these were silently
      // 1000× understated by the previous parser. Each must round-trip.
      ['1.000', 1000],         // EU thousands, no decimal
      ['1.500', 1500],
      ['12.345', 12345],
      ['1.000.500', 1000500],  // multiple-dot thousands
      ['12.345.678', 12345678],
      ['1.000.50', 1000.5],    // mixed: prior dots thousands, last is decimal
      ['1,000', 1000],         // US thousands, no decimal (already worked)
      ['1,500', 1500],
      ['12,345,678', 12345678],
      ['1,000,000.50', 1000000.5], // US thousands + decimal
      ['1.000.000,50', 1000000.5], // EU thousands + decimal
      ['€1.000,50', 1000.5],   // currency-prefixed EU
      ['€1,000.50', 1000.5],   // currency-prefixed US
    ];
    for (const [raw, expected] of cases) {
      it(`parses ${JSON.stringify(raw)} → ${expected}`, () => {
        const r = parsePriceCell(raw);
        expect(r.reason).toBe('parsed');
        expect(r.native_amount).toBeCloseTo(expected, 2);
      });
    }
  });

  describe('unparseable_amount', () => {
    for (const raw of ['abc', 'paid', '€', '$$$', 'TBD', 'see invoice', '12.34.56', 'NaN']) {
      it(`returns unparseable_amount for ${JSON.stringify(raw)}`, () => {
        const r = parsePriceCell(raw);
        expect(r.reason).toBe('unparseable_amount');
        expect(r.native_amount).toBeNull();
      });
    }
  });
});

describe('priceReasonToConversionStatus', () => {
  it('maps missing_price → missing_price', () => {
    expect(priceReasonToConversionStatus('missing_price')).toBe('missing_price');
  });
  it('maps unparseable_amount → unparseable_amount', () => {
    expect(priceReasonToConversionStatus('unparseable_amount')).toBe('unparseable_amount');
  });
  it('returns null for parsed (caller proceeds with conversion)', () => {
    expect(priceReasonToConversionStatus('parsed')).toBeNull();
  });
});

describe('detectCurrencyFromCell + parsePriceCell.detected_currency (Principle V)', () => {
  // Operator sheets sometimes carry the currency inline in the price cell
  // (e.g. "$70.00 USD") rather than in a separate currency column. Before
  // this fix the pipeline stripped the indicator and silently treated the
  // amount as EUR, mis-classifying USD/GBP rows.

  describe('ISO code detection', () => {
    const isoCases: Array<[string, string]> = [
      ['$70.00 USD', 'USD'],
      ['70 USD', 'USD'],
      ['100.00 EUR', 'EUR'],
      ['£40.00 GBP', 'GBP'],
      ['40 GBP', 'GBP'],
      ['1000 JPY', 'JPY'],
      ['400 PLN', 'PLN'],
      ['50 CHF', 'CHF'],
      ['200 SEK', 'SEK'],
      ['200 NOK', 'NOK'],
      ['200 DKK', 'DKK'],
      ['200 CZK', 'CZK'],
      ['200 CAD', 'CAD'],
      ['200 AUD', 'AUD'],
      ['100 usd', 'USD'], // case-insensitive
    ];
    for (const [cell, iso] of isoCases) {
      it(`detects ${iso} from ${JSON.stringify(cell)}`, () => {
        expect(detectCurrencyFromCell(cell)).toBe(iso);
        expect(parsePriceCell(cell).detected_currency).toBe(iso);
      });
    }
  });

  describe('symbol-only detection (falls back when no ISO code)', () => {
    const symbolCases: Array<[string, string]> = [
      ['€100', 'EUR'],
      ['100€', 'EUR'],
      ['£40', 'GBP'],
      ['¥1000', 'JPY'],
      ['50 zł', 'PLN'],
      ['$70', 'USD'],
      ['70$', 'USD'],
    ];
    for (const [cell, iso] of symbolCases) {
      it(`detects ${iso} from ${JSON.stringify(cell)}`, () => {
        expect(detectCurrencyFromCell(cell)).toBe(iso);
        expect(parsePriceCell(cell).detected_currency).toBe(iso);
      });
    }
  });

  describe('no indicator → null (caller defaults to EUR)', () => {
    it('plain number has no detected currency', () => {
      expect(detectCurrencyFromCell('100')).toBeNull();
      expect(parsePriceCell('100').detected_currency).toBeNull();
      expect(parsePriceCell('100').native_amount).toBe(100);
    });
    it('thousands-grouped plain number has no detected currency', () => {
      expect(parsePriceCell('1,000.50').detected_currency).toBeNull();
    });
    it('empty / missing cell has null detected currency', () => {
      expect(parsePriceCell(undefined).detected_currency).toBeNull();
      expect(parsePriceCell('').detected_currency).toBeNull();
    });
  });

  describe('ISO code wins over ambiguous symbol', () => {
    it('"$70.00 USD" → USD (not just $ → USD; explicit code wins)', () => {
      // Both indicators present; ISO takes priority. (Functionally same
      // outcome here but the priority matters for hypothetical "C$" → CAD
      // vs $ → USD cases.)
      expect(detectCurrencyFromCell('$70.00 USD')).toBe('USD');
    });
    it('"100 CAD" detected as CAD even with no symbol', () => {
      expect(detectCurrencyFromCell('100 CAD')).toBe('CAD');
    });
  });

  describe('amount is parsed correctly when currency indicator is present', () => {
    it('"$70.00 USD" → amount 70, currency USD', () => {
      const r = parsePriceCell('$70.00 USD');
      expect(r.native_amount).toBe(70);
      expect(r.detected_currency).toBe('USD');
      expect(r.reason).toBe('parsed');
    });
    it('"£40.00 GBP" → amount 40, currency GBP', () => {
      const r = parsePriceCell('£40.00 GBP');
      expect(r.native_amount).toBe(40);
      expect(r.detected_currency).toBe('GBP');
    });
    it('"50 zł" → amount 50, currency PLN', () => {
      const r = parsePriceCell('50 zł');
      expect(r.native_amount).toBe(50);
      expect(r.detected_currency).toBe('PLN');
    });
    it('"100,50 €" (EU decimal) → amount 100.5, currency EUR', () => {
      const r = parsePriceCell('100,50 €');
      expect(r.native_amount).toBe(100.5);
      expect(r.detected_currency).toBe('EUR');
    });
  });
});
