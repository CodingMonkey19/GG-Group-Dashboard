/**
 * QA finding H7 regression — wire-schema forward-compat.
 *
 * The H5 amendment promoted `unparseable_amount` + `missing_currency` from
 * rolled-up to first-class audit categories. Without forward-compat, a
 * stale frontend tab whose bundled schema predates H5 would receive the
 * new keys from a freshly-deployed backend, fail zod's strict-mode parse
 * on unknown keys, and white-screen the dashboard.
 *
 * The fix uses `.passthrough()` on the audit subobject so unknown keys
 * are preserved verbatim in the parsed value (they just don't have a
 * named slot). Required v1 + v2-reserved keys remain strictly validated
 * as `array<AuditFinding>`.
 *
 * This test simulates two failure modes the fix MUST handle gracefully:
 *   1. A future backend adds a brand-new category not in our enum.
 *      Old client code (with our current schema baked in) MUST NOT
 *      crash.
 *   2. The required v1/v2 keys are still strictly typed — a wrong value
 *      shape (e.g., a string where an array of findings belongs) MUST
 *      still fail.
 */

import { describe, it, expect } from 'vitest';
import {
  ApiDataResponse,
  AUDIT_CATEGORIES_ALL,
} from '../../../src/shared/contracts.js';

function emptyAuditByCategory(): Record<string, unknown[]> {
  return Object.fromEntries(AUDIT_CATEGORIES_ALL.map((cat) => [cat, []]));
}

function baseEnvelope() {
  return {
    schema_version: 1 as const,
    last_refreshed_at: '2026-05-12T10:00:00Z',
    refresh_status: 'success' as const,
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
    audit_findings_by_category: emptyAuditByCategory(),
  };
}

describe('H7 regression — audit_findings_by_category forward-compat', () => {
  it('parses cleanly with every current v1 + v2-reserved key present', () => {
    const parsed = ApiDataResponse.safeParse(baseEnvelope());
    expect(parsed.success).toBe(true);
  });

  it('parses cleanly when the backend emits a NEW category key our schema does not know', () => {
    // Simulate a future backend that adds a hypothetical
    // `mismatched_currency_symbol` category. Stale frontends must NOT
    // white-screen the dashboard — passthrough preserves the unknown
    // key so the panel can ignore it gracefully.
    const env = baseEnvelope();
    (env.audit_findings_by_category as Record<string, unknown[]>).mismatched_currency_symbol = [];
    const parsed = ApiDataResponse.safeParse(env);
    expect(parsed.success).toBe(true);
  });

  it('still rejects malformed values for KNOWN category keys (non-array → fail)', () => {
    const env = baseEnvelope();
    // missing_price MUST be an array of AuditFinding — a string is invalid.
    (env.audit_findings_by_category as Record<string, unknown>).missing_price = 'not an array';
    const parsed = ApiDataResponse.safeParse(env);
    expect(parsed.success).toBe(false);
  });

  it('still rejects malformed AuditFinding shapes inside a known category', () => {
    const env = baseEnvelope();
    (env.audit_findings_by_category as Record<string, unknown[]>).missing_price = [
      { not: 'a real finding' },
    ];
    const parsed = ApiDataResponse.safeParse(env);
    expect(parsed.success).toBe(false);
  });

  it('still requires every v1 + v2-reserved key to be present (FR-022 unchanged)', () => {
    const env = baseEnvelope();
    delete (env.audit_findings_by_category as Record<string, unknown[]>).missing_price;
    const parsed = ApiDataResponse.safeParse(env);
    expect(parsed.success).toBe(false);
  });
});
