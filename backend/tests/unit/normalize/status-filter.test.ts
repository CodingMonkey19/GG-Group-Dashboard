/**
 * T030 — Unit test for isDone (Status="Done" row eligibility, FR-031).
 *
 * The match is case-sensitive and whitespace-trimmed. The dashboard source
 * rule is literal: only "Done" enters the stored dataset.
 */

import { describe, expect, it } from 'vitest';
import { isDone } from '../../../src/pipeline/normalize/status-filter.js';

describe('isDone (T030)', () => {
  describe('matches literal Done with optional outer whitespace', () => {
    for (const raw of ['Done', '  Done  ', '\tDone\n']) {
      it(`returns true for ${JSON.stringify(raw)}`, () => {
        expect(isDone(raw)).toBe(true);
      });
    }
  });

  describe('does NOT match near-misses', () => {
    for (const raw of [
      '',
      '   ',
      'In Progress',
      'done',
      'DONE',
      'doNe',
      'pending',
      'Done!', // trailing punctuation — not exact
      'DONE ✓', // trailing emoji — not exact
      'done x',
      'doneish',
      'completed',
      '✓',
      'yes',
      undefined,
    ]) {
      it(`returns false for ${JSON.stringify(raw)}`, () => {
        expect(isDone(raw)).toBe(false);
      });
    }
  });

  it('returns false when the status column is not mapped (undefined)', () => {
    expect(isDone(undefined)).toBe(false);
  });
});
