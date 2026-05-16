/**
 * Classify an invoice artifact reference into the 6-value taxonomy
 * mandated by Constitution Principle VI:
 *
 *   paypal     — any URL on www.paypal.com / paypal.me
 *   pdf        — local file (no scheme, ends with .pdf)
 *   drive_pdf  — Google Drive / Docs URL hosting a PDF
 *   intuit     — any URL on intuit.com / quickbooks.com hosting an invoice
 *   text       — any other non-empty value (free-form note from the operator)
 *   missing    — null / empty
 *
 * Pure function. No I/O. No URL fetching (PayPal v1 is URL-string-only per
 * revised research.md Decision 5).
 */

import type { InvoiceType } from '../../shared/contracts.js';

const PAYPAL_HOSTS = /(?:^|\.)paypal\.(?:com|me)\b/i;
const DRIVE_HOSTS = /(?:^|\.)(?:drive|docs)\.google\.com\b/i;
const INTUIT_HOSTS = /(?:^|\.)(?:intuit|quickbooks)\.com\b/i;
const PDF_LOCAL_RE = /^[^:]+\.pdf$/i; // no URL scheme, ends with .pdf

export function classifyInvoiceType(artifactRef: string | null | undefined): InvoiceType {
  if (artifactRef == null) return 'missing';
  const trimmed = artifactRef.trim();
  if (trimmed.length === 0) return 'missing';

  const lower = trimmed.toLowerCase();

  // URL-based classification first.
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    let host = '';
    try {
      host = new URL(trimmed).hostname;
    } catch {
      // Malformed URL — fall through to text.
      return 'text';
    }
    if (PAYPAL_HOSTS.test(host)) return 'paypal';
    if (INTUIT_HOSTS.test(host)) return 'intuit';
    if (DRIVE_HOSTS.test(host)) return 'drive_pdf';
    return 'text';
  }

  // Local PDF file (no scheme).
  if (PDF_LOCAL_RE.test(trimmed)) return 'pdf';

  // Anything else with content is a free-form note.
  return 'text';
}
