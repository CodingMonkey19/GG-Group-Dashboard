/**
 * Decide a row's conversion_status from the raw price + currency cells.
 *
 * Per Constitution Principle V + research.md Decision 15 (audit-only rows
 * are first-class), every Done row that survives ingest gets a row in the
 * `invoices` table even when conversion is impossible. The reason is
 * recorded in `conversion_status`, and the conversion fields go NULL.
 *
 * Aggregation queries downstream filter `WHERE conversion_status='converted'`.
 *
 * Outcomes:
 *   missing_price       — price cell is empty / blank
 *   unparseable_amount  — price cell has content but doesn't parse as a number
 *   missing_currency    — sheet has no currency column AND no implicit EUR
 *                         convention (caller decides; this function takes the
 *                         currency hint as input)
 *   out_of_ecb_currency — currency parsed but not in the ECB reference set
 *                         (caller checks against the cache and re-stamps)
 *   converted           — price parsed, currency known, ECB rate available
 *
 * This is a pure function over the parsed inputs. It does NOT touch the DB
 * — the caller (normalize/index.ts) checks the ECB cache and either calls
 * this with status='converted' (rate available) or status='out_of_ecb_currency'
 * (rate unavailable).
 */

import type { ConversionStatus } from '../../shared/contracts.js';

export interface PriceParseResult {
  /** The parsed numeric amount, or null when the price could not be parsed. */
  native_amount: number | null;
  /** Why the parse went the way it did. Used by the caller to set conversion_status. */
  reason: 'parsed' | 'missing_price' | 'unparseable_amount';
  /**
   * ISO 4217 code detected INSIDE the price cell itself (e.g. `$70.00 USD`
   * → `'USD'`, `£40 GBP` → `'GBP'`). Returned alongside the parsed amount
   * so the normalize layer can stamp the correct native_currency even when
   * the sheet has no dedicated currency column.
   *
   * Null when no currency indicator was found in the cell (caller decides
   * — typically default to EUR per Principle V).
   */
  detected_currency: string | null;
}

/**
 * Detect an ISO currency from the raw price cell. Prefers a 3-letter ISO
 * code (`USD`, `EUR`, `GBP`, …) over a bare symbol, since symbols like `$`
 * are ambiguous (USD / CAD / AUD / …). Returns null when no recognized
 * indicator is found.
 *
 * Recognized:
 *   ISO codes: EUR USD GBP JPY PLN CHF SEK NOK DKK CZK CAD AUD
 *   Symbols:   €→EUR  $→USD  £→GBP  ¥→JPY  zł→PLN  Fr→CHF
 */
export function detectCurrencyFromCell(rawCell: string): string | null {
  const isoMatch = /\b(EUR|USD|GBP|JPY|PLN|CHF|SEK|NOK|DKK|CZK|CAD|AUD)\b/i.exec(rawCell);
  if (isoMatch) {
    return isoMatch[1]!.toUpperCase();
  }
  if (/€/.test(rawCell)) return 'EUR';
  if (/£/.test(rawCell)) return 'GBP';
  if (/¥/.test(rawCell)) return 'JPY';
  if (/zł/i.test(rawCell)) return 'PLN';
  // `$` last because it's the most ambiguous; only treat as USD when no
  // other ISO code was present (already covered by the isoMatch above).
  if (/\$/.test(rawCell)) return 'USD';
  return null;
}

/**
 * Parse a sheet cell into a number (locale-tolerant), classifying the
 * outcome so the caller knows whether to record `missing_price`,
 * `unparseable_amount`, or proceed with conversion.
 *
 * Accepts:
 *   • Plain decimal: "100", "100.5", "100.50"
 *   • Comma decimal (LT/EU locale): "100,50"
 *   • Currency-symbol prefixes/suffixes: "€100.50", "100.50 €", "$100"
 *   • Currency ISO codes inline: "$70.00 USD", "£40 GBP", "100 PLN"
 *   • Thousands separators: "1,000.50", "1.000,50", "1 000,50"
 *
 * When a currency indicator is found in the cell, the ISO is returned in
 * `detected_currency` so the normalize layer can stamp the correct native
 * currency without needing a separate currency column.
 *
 * Rejects empty cells (→ missing_price) and anything that produces NaN /
 * non-finite (→ unparseable_amount).
 */
export function parsePriceCell(rawCell: string | undefined): PriceParseResult {
  if (rawCell === undefined) {
    return { native_amount: null, reason: 'missing_price', detected_currency: null };
  }
  const trimmed = rawCell.trim();
  if (trimmed.length === 0) {
    return { native_amount: null, reason: 'missing_price', detected_currency: null };
  }

  // Detect currency indicator BEFORE stripping so we can pass it back.
  const detected_currency = detectCurrencyFromCell(trimmed);

  // Strip currency symbols and ISO codes from the candidate.
  let candidate = trimmed
    .replace(/[€$£¥₣₹]/g, '')
    .replace(/\b(?:eur|usd|gbp|jpy|pln|chf|sek|nok|dkk|czk|cad|aud)\b/gi, '')
    .replace(/zł/gi, '')
    .trim();
  if (candidate.length === 0) {
    return { native_amount: null, reason: 'unparseable_amount', detected_currency };
  }

  // Drop spaces FIRST (sometimes used as thousands separator: "1 000,50").
  candidate = candidate.replace(/\s+/g, '');

  // Determine decimal separator. Codex review of branch 15c079b Finding #2
  // caught the dot-only branch silently understating "1.000" as 1.0 — the
  // rule below treats trailing-3-digits as a thousands separator (the
  // dominant LT/EU convention) and only treats trailing-1-or-2 as decimal.
  const lastComma = candidate.lastIndexOf(',');
  const lastDot = candidate.lastIndexOf('.');
  let normalized: string;

  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: the LAST one is the decimal separator; the other is thousands.
    // QA review H7 — also validate that the thousands-grouping is well-formed
    // (first group 1-3 digits, every following group exactly 3). Previously
    // "1,2,3.45" was silently accepted as 123.45 because we just stripped
    // separators without checking widths.
    if (lastComma > lastDot) {
      // Comma is decimal; dots are thousands.
      const intPart = candidate.slice(0, lastComma);
      if (!isValidIntegerWithThousands(intPart, '.')) {
        return { native_amount: null, reason: 'unparseable_amount', detected_currency };
      }
      normalized = candidate.replace(/\./g, '').replace(',', '.');
    } else {
      // Dot is decimal; commas are thousands.
      const intPart = candidate.slice(0, lastDot);
      if (!isValidIntegerWithThousands(intPart, ',')) {
        return { native_amount: null, reason: 'unparseable_amount', detected_currency };
      }
      normalized = candidate.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    // Only comma.
    const norm = normalizeWithSingleSeparator(candidate, ',');
    if (norm === null) return { native_amount: null, reason: 'unparseable_amount', detected_currency };
    normalized = norm;
  } else if (lastDot >= 0) {
    // Only dot.
    const norm = normalizeWithSingleSeparator(candidate, '.');
    if (norm === null) return { native_amount: null, reason: 'unparseable_amount', detected_currency };
    normalized = norm;
  } else {
    normalized = candidate;
  }

  if (!/^[-+]?\d+(?:\.\d+)?$/.test(normalized)) {
    return { native_amount: null, reason: 'unparseable_amount', detected_currency };
  }
  const n = Number.parseFloat(normalized);
  if (!Number.isFinite(n)) {
    return { native_amount: null, reason: 'unparseable_amount', detected_currency };
  }
  return { native_amount: n, reason: 'parsed', detected_currency };
}

/**
 * Normalize a candidate that contains ONLY one kind of separator (all
 * dots OR all commas). Returns the dot-decimal canonical form (e.g.,
 * "1.000.50" → "1000.50") or null when the structure is malformed
 * (e.g., "12.34.56" — non-thousands-conforming groups).
 *
 * Rules:
 *   • Single separator:
 *       trailing 3 digits → thousands → strip
 *       trailing 1 or 2 digits → decimal → leave (replace comma with dot)
 *       trailing 0 or 4+ → decimal → leave (replace comma with dot)
 *   • Multiple separators:
 *       Every group except possibly the last MUST be exactly 3 digits;
 *       the first group MUST be 1-3 digits. Otherwise → null (unparseable).
 *       If the last group is 3 digits → thousands → strip all separators.
 *       If the last group is 1 or 2 digits → last separator is decimal,
 *           prior separators are thousands → produce "<int><dot><frac>".
 */
function normalizeWithSingleSeparator(candidate: string, sep: ',' | '.'): string | null {
  const groups = candidate.split(sep);
  // groups.length === 1 means no separator — caller shouldn't reach here.
  if (groups.length === 1) return candidate;

  const lastGroup = groups[groups.length - 1] ?? '';
  if (!/^\d+$/.test(lastGroup)) return null;

  // Single-separator case (groups.length === 2): more permissive — the
  // integer portion can be any number of digits (US "1000.50" is valid).
  if (groups.length === 2) {
    const first = groups[0] ?? '';
    if (!/^[-+]?\d+$/.test(first)) return null;

    if (lastGroup.length === 3 && /^[-+]?\d{1,3}$/.test(first)) {
      // Ambiguous: "1.000" could be 1.0 (decimal) or 1000 (EU thousands).
      // For LT/EU sheets the thousands interpretation is correct
      // (Codex Finding #2 regression). Strip.
      return groups.join('');
    }
    // Otherwise decimal: "1000.50" → 1000.50, "100,50" → 100.50, "100.5" → 100.5.
    return `${first}.${lastGroup}`;
  }

  // Multiple separators (groups.length >= 3): must be valid thousands grouping.
  const integerGroups = groups.slice(0, -1);
  const first = integerGroups[0] ?? '';
  if (!/^[-+]?\d{1,3}$/.test(first)) return null;
  for (const g of integerGroups.slice(1)) {
    if (!/^\d{3}$/.test(g)) return null;
  }
  if (lastGroup.length === 3) {
    // Thousands continuation → strip all separators.
    return integerGroups.join('') + lastGroup;
  }
  if (lastGroup.length === 1 || lastGroup.length === 2) {
    return `${integerGroups.join('')}.${lastGroup}`;
  }
  return null;
}

/**
 * Validate that a signed integer string is well-formed thousands-grouping:
 *   first group 1-3 digits, every subsequent group exactly 3 digits.
 * Used by parsePriceCell when BOTH `,` and `.` are present, to reject
 * "1,2,3.45" (H7) without rejecting "1,234.56" or "1234.56".
 */
function isValidIntegerWithThousands(s: string, thousandsSep: ',' | '.'): boolean {
  const body = s.startsWith('-') || s.startsWith('+') ? s.slice(1) : s;
  if (body.length === 0) return false;
  if (!body.includes(thousandsSep)) return /^\d+$/.test(body);
  const groups = body.split(thousandsSep);
  if (groups.length < 2) return false;
  if (!/^\d{1,3}$/.test(groups[0]!)) return false;
  for (let i = 1; i < groups.length; i += 1) {
    if (!/^\d{3}$/.test(groups[i]!)) return false;
  }
  return true;
}

/** Map a PriceParseResult.reason to its corresponding ConversionStatus. */
export function priceReasonToConversionStatus(
  reason: PriceParseResult['reason'],
): Extract<ConversionStatus, 'missing_price' | 'unparseable_amount'> | null {
  switch (reason) {
    case 'missing_price':
      return 'missing_price';
    case 'unparseable_amount':
      return 'unparseable_amount';
    case 'parsed':
      return null;
  }
}
