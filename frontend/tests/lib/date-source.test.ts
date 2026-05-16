/**
 * T041a — FR-024 grep guard (frontend half).
 *
 * FR-024 says: "UI labels MAY be human-formatted but MUST derive from
 * server-supplied buckets, never the client clock." This guard pins the
 * rule into the test suite by making it impossible to merge code that
 * regrows a Date.now()/new Date() call inside the modules where bucket
 * derivation actually happens:
 *
 *   • frontend/src/lib/format.ts    — month / EUR / count formatters
 *   • frontend/src/lib/selectors.ts — every aggregator over invoice rows
 *   • frontend/src/lib/contracts.ts — re-export of the wire schema
 *
 * Components (e.g., FreshnessIndicator) MAY use Date.now() for relative-time
 * labels — that's UX, not bucket derivation. Adding a forbidden call inside
 * the locked files fails this test even before TypeScript runs.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const FORBIDDEN = [/Date\.now\s*\(/, /new\s+Date\s*\(/];

const LOCKED_FILES = [
  'src/lib/format.ts',
  'src/lib/selectors.ts',
  'src/lib/contracts.ts',
];

describe('FR-024 grep guard (T041a) — bucket derivation must come from snapshot, not client clock', () => {
  for (const relPath of LOCKED_FILES) {
    it(`${relPath} contains no Date.now() / new Date() calls`, () => {
      const abs = resolve(__dirname, '..', '..', relPath);
      const src = readFileSync(abs, 'utf8');
      // Strip comments to avoid false positives on documentation. We only
      // check executable code: a line is "code" if its first non-whitespace
      // is not `*` or `//`. Multi-line block comments are stripped first.
      const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, '');
      const codeOnly = noBlockComments
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*)/.test(line))
        .join('\n');
      for (const pattern of FORBIDDEN) {
        expect(
          codeOnly,
          `${relPath} must not contain ${pattern} (FR-024). ` +
            `If you need a relative-time label, do that in a component, not here.`,
        ).not.toMatch(pattern);
      }
    });
  }
});
