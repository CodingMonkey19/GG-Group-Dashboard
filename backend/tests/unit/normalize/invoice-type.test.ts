/**
 * T032 — Unit test for classifyInvoiceType.
 *
 * Covers all six values of the taxonomy + edge cases (whitespace, malformed
 * URLs, mixed case). The 'paypal' branch is exercised against multiple URL
 * shapes including the fragment-routed form that v1's URL-string parser
 * (T047) handles without HTTP fetch.
 */

import { describe, expect, it } from 'vitest';
import { classifyInvoiceType } from '../../../src/pipeline/normalize/invoice-type.js';

describe('classifyInvoiceType', () => {
  describe('missing', () => {
    it('classifies null as missing', () => {
      expect(classifyInvoiceType(null)).toBe('missing');
    });
    it('classifies undefined as missing', () => {
      expect(classifyInvoiceType(undefined)).toBe('missing');
    });
    it('classifies empty string as missing', () => {
      expect(classifyInvoiceType('')).toBe('missing');
    });
    it('classifies whitespace-only as missing', () => {
      expect(classifyInvoiceType('   ')).toBe('missing');
      expect(classifyInvoiceType('\t\n')).toBe('missing');
    });
  });

  describe('paypal', () => {
    it('classifies fragment-routed paypal URL as paypal', () => {
      expect(classifyInvoiceType('https://www.paypal.com/invoice/p/#PAYINV-ABC')).toBe('paypal');
    });
    it('classifies path-based paypal URL as paypal', () => {
      expect(
        classifyInvoiceType('https://www.paypal.com/invoice/payerView/details/INV-123'),
      ).toBe('paypal');
    });
    it('classifies paypal.me as paypal', () => {
      expect(classifyInvoiceType('https://paypal.me/somebody/100')).toBe('paypal');
    });
    it('matches case-insensitively on host', () => {
      expect(classifyInvoiceType('https://WWW.PayPal.com/invoice/p/#X')).toBe('paypal');
    });
  });

  describe('drive_pdf', () => {
    it('classifies drive.google.com URL as drive_pdf', () => {
      expect(classifyInvoiceType('https://drive.google.com/file/d/abc123/view')).toBe('drive_pdf');
    });
    it('classifies docs.google.com URL as drive_pdf', () => {
      expect(classifyInvoiceType('https://docs.google.com/document/d/xyz/edit')).toBe('drive_pdf');
    });
  });

  describe('intuit', () => {
    it('classifies intuit.com URL as intuit', () => {
      expect(classifyInvoiceType('https://connect.intuit.com/invoice/123')).toBe('intuit');
    });
    it('classifies quickbooks.com URL as intuit', () => {
      expect(classifyInvoiceType('https://quickbooks.intuit.com/payment/abc')).toBe('intuit');
      expect(classifyInvoiceType('https://app.quickbooks.com/v/path')).toBe('intuit');
    });
  });

  describe('pdf (local file)', () => {
    it('classifies a bare .pdf filename as pdf', () => {
      expect(classifyInvoiceType('invoice_2026-04.pdf')).toBe('pdf');
      expect(classifyInvoiceType('invoices/cglt/2026-04.pdf')).toBe('pdf');
    });
    it('classifies .PDF (uppercase ext) as pdf', () => {
      expect(classifyInvoiceType('Invoice.PDF')).toBe('pdf');
    });
    it('does NOT classify a https://...pdf URL as pdf (would be text/drive_pdf depending on host)', () => {
      expect(classifyInvoiceType('https://example.com/invoice.pdf')).toBe('text');
    });
  });

  describe('text', () => {
    it('classifies non-URL non-pdf text as text', () => {
      expect(classifyInvoiceType('paid via bank transfer 2026-04-12')).toBe('text');
      expect(classifyInvoiceType('see attachment in email')).toBe('text');
    });
    it('classifies an unknown HTTP host as text', () => {
      expect(classifyInvoiceType('https://example.com/random/path')).toBe('text');
    });
    it('classifies a malformed URL as text (not paypal even if it contains "paypal")', () => {
      expect(classifyInvoiceType('not a real url://paypal.com/x')).toBe('text');
    });
  });
});
