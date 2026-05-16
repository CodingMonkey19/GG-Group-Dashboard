/**
 * T033 — Unit test for the date-resolution chain.
 *
 * Covers:
 *   • All branches of resolveDate (sheet → artifact → undated)
 *   • Per FR-033 + revised Decision 5: paypal/intuit SKIP the artifact step
 *     in v1, even when an artifactDate is supplied (defensive).
 *   • parseDateCell across ISO / EU / US-ish / Sheets-serial / unparseable.
 */

import { describe, expect, it } from 'vitest';
import { parseDateCell, resolveDate } from '../../../src/pipeline/normalize/date-resolution.js';

describe('parseDateCell', () => {
  describe('ISO format', () => {
    it('parses YYYY-MM-DD', () => {
      expect(parseDateCell('2026-04-15')).toBe('2026-04-15');
    });
    it('parses YYYY-MM-DDTHH:MM:SSZ (uses date portion)', () => {
      expect(parseDateCell('2026-04-15T08:30:00Z')).toBe('2026-04-15');
    });
  });

  describe('EU format (DD.MM.YYYY / DD/MM/YYYY)', () => {
    it('parses 15.04.2026', () => {
      expect(parseDateCell('15.04.2026')).toBe('2026-04-15');
    });
    it('parses 15/04/2026', () => {
      expect(parseDateCell('15/04/2026')).toBe('2026-04-15');
    });
    it('parses single-digit days/months', () => {
      expect(parseDateCell('5.4.2026')).toBe('2026-04-05');
      expect(parseDateCell('5/4/2026')).toBe('2026-04-05');
    });
  });

  describe('YYYY/MM/DD', () => {
    it('parses 2026/04/15', () => {
      expect(parseDateCell('2026/04/15')).toBe('2026-04-15');
    });
  });

  describe('Google Sheets date serial', () => {
    it('parses 46127 → 2026-04-15 (days since 1899-12-30)', () => {
      // 2026-04-15 is 46127 days after 1899-12-30.
      expect(parseDateCell('46127')).toBe('2026-04-15');
    });
  });

  describe('rejects', () => {
    for (const raw of [
      '',
      '   ',
      'today',
      '2026-13-01', // invalid month
      '2026-02-31', // invalid day-of-month
      '32.04.2026',
      'Apr 15, 2026',
      'see invoice',
    ]) {
      it(`returns null for ${JSON.stringify(raw)}`, () => {
        expect(parseDateCell(raw)).toBeNull();
      });
    }
    it('returns null for undefined cell (no column mapped)', () => {
      expect(parseDateCell(undefined)).toBeNull();
    });
  });
});

describe('resolveDate (the chain)', () => {
  it("step 1: sheet date wins → date_source='sheet'", () => {
    const r = resolveDate({
      sheetCell: '2026-04-15',
      artifactDate: '2026-04-10',
      invoice_type: 'pdf',
    });
    expect(r.invoice_date).toBe('2026-04-15');
    expect(r.invoice_month).toBe('2026-04');
    expect(r.date_source).toBe('sheet');
  });

  it("step 2 (pdf): no sheet date, artifact provides → date_source='artifact'", () => {
    const r = resolveDate({
      sheetCell: undefined,
      artifactDate: '2026-04-10',
      invoice_type: 'pdf',
    });
    expect(r.invoice_date).toBe('2026-04-10');
    expect(r.invoice_month).toBe('2026-04');
    expect(r.date_source).toBe('artifact');
  });

  it("step 2 (drive_pdf): no sheet date, artifact provides → date_source='artifact'", () => {
    const r = resolveDate({
      sheetCell: '',
      artifactDate: '2026-03-20',
      invoice_type: 'drive_pdf',
    });
    expect(r.invoice_date).toBe('2026-03-20');
    expect(r.date_source).toBe('artifact');
  });

  it('step 2 SKIPPED for paypal in v1 even when artifactDate is supplied (defensive)', () => {
    const r = resolveDate({
      sheetCell: undefined,
      artifactDate: '2026-04-10', // ignored — paypal is not fetched in v1
      invoice_type: 'paypal',
    });
    expect(r.invoice_date).toBeNull();
    expect(r.invoice_month).toBeNull();
    expect(r.date_source).toBe('undated');
  });

  it('step 2 SKIPPED for intuit in v1 (same reason)', () => {
    const r = resolveDate({
      sheetCell: '',
      artifactDate: '2026-04-10',
      invoice_type: 'intuit',
    });
    expect(r.date_source).toBe('undated');
  });

  it('step 2 SKIPPED for text', () => {
    const r = resolveDate({
      sheetCell: undefined,
      artifactDate: '2026-04-10',
      invoice_type: 'text',
    });
    expect(r.date_source).toBe('undated');
  });

  it('step 2 SKIPPED for missing', () => {
    const r = resolveDate({
      sheetCell: undefined,
      artifactDate: '2026-04-10',
      invoice_type: 'missing',
    });
    expect(r.date_source).toBe('undated');
  });

  it("step 3: both fail → undated, both fields null, date_source='undated'", () => {
    const r = resolveDate({
      sheetCell: 'see invoice',
      artifactDate: null,
      invoice_type: 'pdf',
    });
    expect(r.invoice_date).toBeNull();
    expect(r.invoice_month).toBeNull();
    expect(r.date_source).toBe('undated');
  });

  it('rejects malformed artifactDate (not YYYY-MM-DD) — falls through to undated', () => {
    const r = resolveDate({
      sheetCell: undefined,
      artifactDate: '04/15/2026',
      invoice_type: 'pdf',
    });
    expect(r.date_source).toBe('undated');
  });
});
