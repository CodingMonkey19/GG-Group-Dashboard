/**
 * Regression: nonEmptyAuditCategoryCount() must NOT count unknown future
 * category keys leaked through the H7 passthrough on the wire schema.
 *
 * Backstory: H7 added `.passthrough()` to AuditByCategoryShape so a stale
 * frontend tab doesn't white-screen when a future backend adds a new
 * category key. The downside: those unknown keys are PRESERVED in the
 * parsed value. The previous nonEmptyAuditCategoryCount() iterated
 * `Object.keys(cats)` and cast to AuditCategoryKey[] — meaning a future
 * backend that emits 2 new non-empty categories would silently inflate
 * the tab-badge count by 2, even though the AuditPanel can't render them
 * (it iterates a closed CATEGORY_LABELS list).
 *
 * Worse, with passthrough, an unknown key's value isn't constrained to
 * be an array of AuditFinding — a malformed backend could emit a string
 * there and the previous `.length` access would either return a misleading
 * char-count or crash on a non-array primitive. The fix iterates the
 * closed V1_AUDIT_CATEGORIES list and uses `Array.isArray` defensively.
 */

import { describe, it, expect } from 'vitest';
import {
  nonEmptyAuditCategoryCount,
  V1_AUDIT_CATEGORIES,
  V2_RESERVED_AUDIT_CATEGORIES,
} from '../../src/lib/selectors';
import type { ApiDataResponse } from '../../src/lib/contracts';

function envelopeWithAudit(audit: Record<string, unknown>): ApiDataResponse {
  return {
    schema_version: 2,
    reporting_year: 2026,
    last_refreshed_at: '2026-05-12T10:00:00Z',
    refresh_status: 'success',
    duration_ms: 1234,
    per_source: [],
    counters: {
      rows_total: 0,
      rows_done: 0,
      rows_excluded_by_status: 0,
      rows_undated: 0,
      rows_out_of_ecb_currency: 0,
      duplicate_invoice_groups: 0,
    },
    excluded_order_codes: [],
    invoices: [],
    // Cast: in real wire data this conforms; we deliberately probe edge
    // shapes the H7 passthrough now allows through.
    audit_findings_by_category: audit as ApiDataResponse['audit_findings_by_category'],
  };
}

function emptyKnownCategories(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [...V1_AUDIT_CATEGORIES, ...V2_RESERVED_AUDIT_CATEGORIES]) {
    out[key] = [];
  }
  return out;
}

describe('nonEmptyAuditCategoryCount — H7 passthrough leak guard', () => {
  it('returns 0 when every category is empty', () => {
    expect(nonEmptyAuditCategoryCount(envelopeWithAudit(emptyKnownCategories()))).toBe(0);
  });

  it('counts each non-empty v1 category exactly once', () => {
    const audit = emptyKnownCategories();
    audit.missing_price = [{}];
    audit.unparseable_amount = [{}, {}];
    audit.future_dated_invoice = [{}];
    expect(nonEmptyAuditCategoryCount(envelopeWithAudit(audit))).toBe(3);
  });

  it('does NOT count v2-reserved categories even when non-empty', () => {
    // v1 contract says these always emit []; if a backend bug populates
    // them, the badge should still ignore them so the operator is not
    // bombarded by gated-feature noise.
    const audit = emptyKnownCategories();
    audit.pdf_extraction_failed = [{}, {}];
    audit.paypal_verification_mismatch = [{}];
    expect(nonEmptyAuditCategoryCount(envelopeWithAudit(audit))).toBe(0);
  });

  it('does NOT count unknown future category keys leaked through passthrough', () => {
    // This is the H7 leak fix: a future backend adding new categories
    // should NOT inflate the badge — the AuditPanel can't render them
    // until the frontend bundle is updated to know about them.
    const audit = emptyKnownCategories();
    (audit as Record<string, unknown[]>).mismatched_currency_symbol = [{}, {}, {}];
    (audit as Record<string, unknown[]>).another_v2_thing = [{}];
    expect(nonEmptyAuditCategoryCount(envelopeWithAudit(audit))).toBe(0);
  });

  it('survives a non-array value on a known key without crashing', () => {
    // Defense-in-depth: a backend bug could emit a string where an array
    // belongs. Strict-mode would have rejected the parse; passthrough
    // only protects against unknown KEYS, not malformed VALUES on known
    // keys (the inner `z.array(AuditFinding)` schema still applies). But
    // the badge counter shouldn't crash if a value somehow slips through.
    const audit = emptyKnownCategories();
    (audit as Record<string, unknown>).missing_price = 'not an array';
    expect(() => nonEmptyAuditCategoryCount(envelopeWithAudit(audit))).not.toThrow();
    expect(nonEmptyAuditCategoryCount(envelopeWithAudit(audit))).toBe(0);
  });

  it('mixed scenario: v1 + v2-reserved + unknown future, only the v1 non-empty are counted', () => {
    const audit = emptyKnownCategories();
    audit.missing_price = [{}]; // v1 non-empty → counts
    audit.non_done_row = [{}, {}]; // v1 non-empty → counts
    audit.pdf_extraction_failed = [{}]; // v2-reserved → ignored
    (audit as Record<string, unknown[]>).future_made_up_category = [{}, {}]; // passthrough → ignored
    expect(nonEmptyAuditCategoryCount(envelopeWithAudit(audit))).toBe(2);
  });
});
