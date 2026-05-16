/**
 * PayPal artifact extractor — v1: pure URL-string parser, NO HTTP fetch.
 *
 * Per FR-003 + research.md Decision 5 (revised after Codex adversarial review
 * of branch 001-spend-dashboard, Finding #1):
 *
 *   PayPal's modern invoice viewer is a fragment-routed SPA
 *   (https://www.paypal.com/invoice/p/#XXXX). URL fragments are NEVER sent
 *   over HTTP per RFC 3986, so a server-side fetch of that URL gets a
 *   generic SPA shell with zero invoice data.
 *
 *   v1 sidesteps the problem entirely: we extract the PayPal invoice
 *   identifier from the URL STRING (regex over both fragment and path
 *   forms), and use it solely for duplicate-detection grouping (FR-007).
 *
 *   The CEO's browser opens the public PayPal page directly via the existing
 *   /api/artifact/:source_row_key 409-with-direct-URL flow.
 *
 * MUST NOT return native_amount or native_currency (Codex Finding #2 —
 * monetary fields here become an attractive nuisance that can let PayPal
 * totals override sheet prices, multiplying multi-row invoices N×).
 */

import type { ArtifactStatus } from '../../shared/contracts.js';

export interface PaypalExtractResult {
  /** PayPal invoice identifier extracted from the URL string, or null if none found. */
  invoice_id: string | null;
  /** Always 'not_attempted' in v1 — there's no fetch outcome to record. */
  artifact_status: ArtifactStatus;
}

// Known PayPal invoice URL forms (case-insensitive):
//   1. https://www.paypal.com/invoice/p/#<id>          (fragment SPA — most common today)
//   2. https://www.paypal.com/invoice/p/<id>           (path-based; some flows still emit this)
//   3. https://www.paypal.com/invoice/payerView/details/<id>  (older path-based)
//   4. https://paypal.me/...                           (no invoice ID — returns null)
//
// The id is captured as the longest run of [A-Z0-9-_] (PayPal's invoice IDs
// look like PAYINV-ABCDEFGHIJ1234 or 12-character base32-ish strings).
const PAYPAL_FRAGMENT_RE = /paypal\.com\/invoice\/p\/#([A-Z0-9_-]+)/i;
const PAYPAL_PATH_RE = /paypal\.com\/invoice\/p\/([A-Z0-9_-]+)/i;
const PAYPAL_PAYERVIEW_RE = /paypal\.com\/invoice\/payerView\/details\/([A-Z0-9_-]+)/i;
const PAYPAL_QUERY_RE = /paypal\.com\/[^?]*\?[^#]*?\binvoice=([A-Z0-9_-]+)/i;

export function extractPaypal(artifactRef: string | null | undefined): PaypalExtractResult {
  const result: PaypalExtractResult = { invoice_id: null, artifact_status: 'not_attempted' };
  if (artifactRef == null) return result;
  const trimmed = artifactRef.trim();
  if (trimmed.length === 0) return result;

  // Try each known form. Order matters: fragment first (most common), then
  // path-based variants, then query-string fallback.
  for (const re of [PAYPAL_FRAGMENT_RE, PAYPAL_PATH_RE, PAYPAL_PAYERVIEW_RE, PAYPAL_QUERY_RE]) {
    const match = re.exec(trimmed);
    if (match?.[1]) {
      result.invoice_id = match[1];
      return result;
    }
  }
  return result;
}
