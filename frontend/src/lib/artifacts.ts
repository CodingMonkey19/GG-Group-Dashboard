/**
 * artifactUrl (T084) — single source of truth for "where does this row's
 * artifact open?".
 *
 * Per contracts/api-artifact.md:
 *   pdf, drive_pdf  → backend proxy `/api/artifact/<source_row_key>` (the
 *                     stable cross-refresh key — Codex review #2 forbids
 *                     re-targeting via the AUTOINCREMENT id).
 *   paypal, intuit  → public URL on the row itself; the browser opens it
 *                     directly (no auth handoff needed).
 *   text            → no URL; the drill-down renders the text inline.
 *   missing         → no URL; the drill-down renders a "no artifact" hint
 *                     that links to the Audit panel's missing_invoice_url
 *                     category.
 *
 * Returning null is the right answer for text/missing — never construct a
 * URL pointing at the proxy for those types (the handler answers 404/409,
 * but emitting a clickable link would be misleading).
 *
 * SECURITY (QA finding C1/C2 — XSS via javascript: scheme):
 * For paypal/intuit rows we return `row.artifact_ref` verbatim, which is
 * eventually rendered as `<a href={...}>` in the ProvenanceDrawer. The
 * `rel="noopener noreferrer"` attribute does NOT defang
 * `href="javascript:..."` — clicking still executes script in the
 * dashboard origin. The artifact_ref originates from operator-owned
 * spreadsheet cells (high-trust today), but a sheet author could paste
 * a `javascript:` URL whose host part matches the intuit domain pattern
 * and ship an exec gadget. We defang here at the single source of truth:
 * non-http(s) schemes return null, the drawer renders a "blocked: unsafe
 * URL scheme" indicator, and no `<a href>` is constructed.
 */

import type { InvoiceRow } from './contracts';

const SAFE_SCHEMES = new Set(['http:', 'https:']);

/**
 * Returns the URL only if it parses cleanly with a safe http(s) scheme.
 * `javascript:`, `data:`, `vbscript:`, and any other scheme → null.
 * Relative-looking strings (e.g., the `./api/artifact/...` proxy path)
 * are treated as same-origin and pass through unchanged.
 */
function safeExternalUrl(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Same-origin proxy paths: pass through verbatim — no scheme to attack.
  if (trimmed.startsWith('/')) return trimmed;
  // Anything else MUST parse as an absolute URL with an http(s) scheme.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  return SAFE_SCHEMES.has(parsed.protocol) ? trimmed : null;
}

export function artifactUrl(row: InvoiceRow): string | null {
  switch (row.invoice_type) {
    case 'pdf':
    case 'drive_pdf':
      return `./api/artifact/${row.source_row_key}`;
    case 'paypal':
    case 'intuit':
      return safeExternalUrl(row.artifact_ref);
    case 'text':
    case 'missing':
      return null;
  }
}
