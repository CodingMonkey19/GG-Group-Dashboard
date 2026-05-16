/**
 * T070 — Unit test for canonicalizeWebsite (Phase 6 US4).
 *
 * The canonical form is what we group by in the per-website current-price
 * selector. Cosmetic variations (https vs http, www., trailing slash,
 * mixed case in the host) MUST collapse to the same canonical so the
 * dashboard doesn't show "example.com" and "EXAMPLE.com/" as two
 * different websites with split spend.
 */

import { describe, expect, it } from 'vitest';
import { canonicalizeWebsite } from '../../../src/pipeline/normalize/website.js';

describe('canonicalizeWebsite', () => {
  describe('null / empty / whitespace', () => {
    for (const raw of [null, undefined, '', '   ', '\t\n']) {
      it(`returns null for ${JSON.stringify(raw)}`, () => {
        expect(canonicalizeWebsite(raw)).toBeNull();
      });
    }
  });

  describe('strips scheme', () => {
    for (const [raw, expected] of [
      ['https://example.com', 'example.com'],
      ['http://example.com', 'example.com'],
      ['ftp://example.com', 'example.com'],
      ['HTTPS://Example.COM', 'example.com'],
    ] as Array<[string, string]>) {
      it(`${JSON.stringify(raw)} → ${expected}`, () => {
        expect(canonicalizeWebsite(raw)).toBe(expected);
      });
    }
  });

  describe('strips leading www.', () => {
    for (const [raw, expected] of [
      ['www.example.com', 'example.com'],
      ['https://www.example.com', 'example.com'],
      ['WWW.EXAMPLE.com', 'example.com'],
    ] as Array<[string, string]>) {
      it(`${JSON.stringify(raw)} → ${expected}`, () => {
        expect(canonicalizeWebsite(raw)).toBe(expected);
      });
    }
  });

  describe('strips trailing slash', () => {
    for (const [raw, expected] of [
      ['example.com/', 'example.com'],
      ['https://example.com/', 'example.com'],
      ['example.com/path/', 'example.com/path'],
    ] as Array<[string, string]>) {
      it(`${JSON.stringify(raw)} → ${expected}`, () => {
        expect(canonicalizeWebsite(raw)).toBe(expected);
      });
    }
  });

  describe('lowercases the host but PRESERVES path casing', () => {
    it('host lowercased', () => {
      expect(canonicalizeWebsite('https://Example.COM/SomeArticle')).toBe('example.com/SomeArticle');
    });
    it('path slug case preserved (some publishers are case-sensitive)', () => {
      expect(canonicalizeWebsite('example.com/Article-Slug-CASE')).toBe('example.com/Article-Slug-CASE');
    });
  });

  describe('cosmetic-variation collapse', () => {
    it('all variants collapse to the same canonical', () => {
      const canonical = canonicalizeWebsite('example.com');
      for (const variant of [
        'http://example.com',
        'https://example.com',
        'https://www.example.com',
        'WWW.example.com',
        'example.com/',
        'https://Example.COM/',
        'EXAMPLE.com',
      ]) {
        expect(canonicalizeWebsite(variant)).toBe(canonical);
      }
    });
  });

  describe('strips empty trailing query/fragment', () => {
    for (const raw of ['example.com?', 'example.com#', 'example.com?#']) {
      it(`${JSON.stringify(raw)} → 'example.com'`, () => {
        expect(canonicalizeWebsite(raw)).toBe('example.com');
      });
    }
  });

  describe('returns null when nothing meaningful is left', () => {
    for (const raw of ['https://', 'www.', '/']) {
      it(`${JSON.stringify(raw)} → null`, () => {
        expect(canonicalizeWebsite(raw)).toBeNull();
      });
    }
  });
});
