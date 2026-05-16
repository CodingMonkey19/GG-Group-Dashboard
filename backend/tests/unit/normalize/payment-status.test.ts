/**
 * T031 — Unit test for classifyPaymentStatus.
 *
 * The most load-bearing rule (Principle VI): an empty / blank cell MUST
 * NEVER coerce to 'paid'. This is the failure mode that would let the
 * dashboard imply unpaid invoices have been settled.
 */

import { describe, expect, it } from 'vitest';
import { classifyPaymentStatus } from '../../../src/pipeline/normalize/payment-status.js';

describe('classifyPaymentStatus', () => {
  describe('missing vs unknown', () => {
    it("returns 'missing' when the column is not mapped (undefined)", () => {
      expect(classifyPaymentStatus(undefined)).toBe('missing');
    });
    it("returns 'unknown' when the column is mapped but cell is empty string", () => {
      expect(classifyPaymentStatus('')).toBe('unknown');
    });
    it("returns 'unknown' when the cell is whitespace only", () => {
      expect(classifyPaymentStatus('   ')).toBe('unknown');
      expect(classifyPaymentStatus('\t\n')).toBe('unknown');
    });
  });

  describe("blank cell MUST NEVER coerce to 'paid' (NON-NEGOTIABLE Principle VI)", () => {
    for (const raw of ['', '   ', '\t', '\n', '  \n  ', undefined]) {
      it(`returns missing/unknown (NOT paid) for ${JSON.stringify(raw)}`, () => {
        const result = classifyPaymentStatus(raw);
        expect(result).not.toBe('paid');
        expect(['missing', 'unknown']).toContain(result);
      });
    }
  });

  describe('paid lexicon', () => {
    for (const token of ['paid', 'PAID', 'Paid', '  paid  ', 'yes', 'YES', 'y', 'true', '✓', 'ok']) {
      it(`classifies ${JSON.stringify(token)} as paid`, () => {
        expect(classifyPaymentStatus(token)).toBe('paid');
      });
    }
  });

  describe('unpaid lexicon', () => {
    for (const token of [
      'unpaid',
      'UNPAID',
      'Unpaid',
      'no',
      'n',
      'false',
      'pending',
      'due',
      'overdue',
    ]) {
      it(`classifies ${JSON.stringify(token)} as unpaid`, () => {
        expect(classifyPaymentStatus(token)).toBe('unpaid');
      });
    }
  });

  describe('unrecognized values', () => {
    for (const token of ['?', 'tbd', 'see notes', 'partial', 'paid via PayPal']) {
      it(`classifies ${JSON.stringify(token)} as unknown (NOT paid)`, () => {
        const result = classifyPaymentStatus(token);
        expect(result).toBe('unknown');
        expect(result).not.toBe('paid');
      });
    }
  });
});
