/**
 * Unit test for sourceRowKey (POSITION + CONTENT — final form after the
 * second Codex review of branch 363b776 → bzj921whd).
 *
 * Properties asserted:
 *   • Determinism: same inputs → same key.
 *   • Different in spreadsheet_id, tab_name_raw, row_index, OR cells → different key.
 *   • CRITICAL: byte-identical rows at different row_index values → different
 *     keys (so the SQLite UNIQUE constraint can never abort an entire
 *     refresh because of legitimate duplicates).
 *   • URL fails closed on row movement: same content at row 5 vs row 6 →
 *     different keys (the saved URL won't silently retarget).
 *   • U+001F separator prevents adjacent-field ambiguity.
 */

import { describe, expect, it } from 'vitest';
import { sourceRowKey } from '../../../src/pipeline/normalize/source-row-key.js';

describe('sourceRowKey (position + content)', () => {
  const cellsA = ['Done', 'Saras', 'example.com', '100', '2026-04-15', 'https://www.paypal.com/invoice/p/#X', 'paid'];
  const cellsB = ['Done', 'Saras', 'other.com', '200', '2026-04-15', 'https://www.paypal.com/invoice/p/#Y', 'paid'];

  it('returns a 16-char lowercase hex string', () => {
    expect(sourceRowKey('SHEET', 'April 2026', 5, cellsA)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic across calls', () => {
    const a = sourceRowKey('SHEET', 'April 2026', 5, cellsA);
    const b = sourceRowKey('SHEET', 'April 2026', 5, cellsA);
    expect(a).toBe(b);
  });

  it('produces different keys for different spreadsheet IDs', () => {
    expect(sourceRowKey('SHEET_A', 'April 2026', 5, cellsA)).not.toBe(
      sourceRowKey('SHEET_B', 'April 2026', 5, cellsA),
    );
  });

  it('produces different keys for different tab names', () => {
    expect(sourceRowKey('SHEET', 'April 2026', 5, cellsA)).not.toBe(
      sourceRowKey('SHEET', 'May 2026', 5, cellsA),
    );
  });

  it('produces different keys for different row indices (URL fails closed on row movement)', () => {
    expect(sourceRowKey('SHEET', 'April 2026', 5, cellsA)).not.toBe(
      sourceRowKey('SHEET', 'April 2026', 6, cellsA),
    );
  });

  it('produces different keys for different cell content (URL fails closed on cell edit)', () => {
    expect(sourceRowKey('SHEET', 'April 2026', 5, cellsA)).not.toBe(
      sourceRowKey('SHEET', 'April 2026', 5, cellsB),
    );
  });

  it('CRITICAL: byte-identical duplicate rows at different row_index values get DIFFERENT keys', () => {
    // Codex review of branch 363b776 → bzj921whd Finding #3:
    // Without row_index in the key, two byte-identical rows (legitimate
    // operator typo-duplicates) would collide on the UNIQUE constraint
    // and abort the entire refresh. Including row_index makes the keys
    // distinct while still being deterministic — both rows ingest, the
    // duplicate_invoice_id audit category surfaces the duplication.
    const dup1 = sourceRowKey('SHEET', 'April 2026', 5, cellsA);
    const dup2 = sourceRowKey('SHEET', 'April 2026', 6, cellsA);
    expect(dup1).not.toBe(dup2);
  });

  it('uses tab_name_raw (preserves misspellings — "Previos" vs "Previous" produce different keys)', () => {
    expect(sourceRowKey('SHEET', 'Previos Orders', 5, cellsA)).not.toBe(
      sourceRowKey('SHEET', 'Previous Orders', 5, cellsA),
    );
  });

  it('uses U+001F as the cell separator (resists adjacent-cell ambiguity)', () => {
    expect(sourceRowKey('SHEET', 'tab', 1, ['a', 'bc'])).not.toBe(
      sourceRowKey('SHEET', 'tab', 1, ['ab', 'c']),
    );
  });

  it('rejects empty spreadsheetId / tabNameRaw', () => {
    expect(() => sourceRowKey('', 'tab', 1, cellsA)).toThrow();
    expect(() => sourceRowKey('id', '', 1, cellsA)).toThrow();
  });

  it('rejects non-positive / non-integer row indices', () => {
    expect(() => sourceRowKey('id', 'tab', 0, cellsA)).toThrow();
    expect(() => sourceRowKey('id', 'tab', -1, cellsA)).toThrow();
    expect(() => sourceRowKey('id', 'tab', 1.5, cellsA)).toThrow();
    expect(() => sourceRowKey('id', 'tab', Number.NaN, cellsA)).toThrow();
  });

  it('rejects non-array cells', () => {
    expect(() => sourceRowKey('id', 'tab', 1, null as unknown as string[])).toThrow();
    expect(() => sourceRowKey('id', 'tab', 1, 'not an array' as unknown as string[])).toThrow();
  });
});
