/**
 * Unit test for the v1 PayPal URL-string parser.
 *
 * Two load-bearing assertions (both regression-test Codex review of branch
 * 001-spend-dashboard, Findings #1 + #2):
 *
 *   1. The extractor returns invoice_id pulled from the URL STRING (regex)
 *      — no HTTP fetch is ever issued. We don't even import `fetch`/`undici`
 *      in this module.
 *
 *   2. The return type contains NO monetary fields. Even when an
 *      implementer is tempted to "just add native_amount from the page
 *      total", the contract makes that impossible — the return shape is
 *      { invoice_id, artifact_status } only.
 */

import { describe, expect, it } from 'vitest';
import { extractPaypal, type PaypalExtractResult } from '../../../src/pipeline/extract/paypal.js';

describe('extractPaypal', () => {
  it("returns artifact_status='not_attempted' for every input (v1: no fetch)", () => {
    expect(extractPaypal('https://www.paypal.com/invoice/p/#PAYINV-ABC').artifact_status).toBe(
      'not_attempted',
    );
    expect(extractPaypal('').artifact_status).toBe('not_attempted');
    expect(extractPaypal(null).artifact_status).toBe('not_attempted');
  });

  describe('invoice_id extraction', () => {
    it('extracts the id from a fragment-routed URL', () => {
      expect(extractPaypal('https://www.paypal.com/invoice/p/#PAYINV-ABCDE12345').invoice_id).toBe(
        'PAYINV-ABCDE12345',
      );
    });

    it('extracts the id from a path-based URL', () => {
      expect(extractPaypal('https://www.paypal.com/invoice/p/PAYINV-XYZ123').invoice_id).toBe(
        'PAYINV-XYZ123',
      );
    });

    it('extracts the id from the older payerView form', () => {
      expect(
        extractPaypal('https://www.paypal.com/invoice/payerView/details/INV-456').invoice_id,
      ).toBe('INV-456');
    });

    it('extracts the id from a query-string variant', () => {
      expect(
        extractPaypal('https://www.paypal.com/somepath?invoice=INV-Q-789&foo=bar').invoice_id,
      ).toBe('INV-Q-789');
    });

    it('returns null for paypal.me URLs (no invoice id present)', () => {
      expect(extractPaypal('https://paypal.me/somebody/100').invoice_id).toBeNull();
    });

    it('returns null for non-paypal URLs', () => {
      expect(extractPaypal('https://drive.google.com/file/d/abc/view').invoice_id).toBeNull();
    });

    it('returns null for null / empty / whitespace input', () => {
      expect(extractPaypal(null).invoice_id).toBeNull();
      expect(extractPaypal(undefined).invoice_id).toBeNull();
      expect(extractPaypal('').invoice_id).toBeNull();
      expect(extractPaypal('   ').invoice_id).toBeNull();
    });

    it('extracts case-insensitively but preserves the id casing as found', () => {
      const lower = extractPaypal('https://WWW.PayPal.com/invoice/p/#payinv-mixed');
      expect(lower.invoice_id).toBe('payinv-mixed');
    });
  });

  describe('contract shape — no monetary fields (Codex Finding #2 regression)', () => {
    it("the return type contains exactly { invoice_id, artifact_status } — no native_amount, no native_currency", () => {
      const res: PaypalExtractResult = extractPaypal(
        'https://www.paypal.com/invoice/p/#PAYINV-XYZ',
      );
      // Compile-time: PaypalExtractResult has no monetary keys (would be a
      // type error to access res.native_amount). Runtime: confirm the only
      // keys present are the two we expect.
      const keys = Object.keys(res).sort();
      expect(keys).toEqual(['artifact_status', 'invoice_id']);
    });
  });
});
