/**
 * Website canonicalization (T072 — Phase 6 US4 dependency).
 *
 * Normalizes a website cell value into a stable identifier so the per-website
 * view can group rows that came in with cosmetic variations
 * (https://, http://, trailing slash, mixed case).
 *
 * Rules:
 *   • Trim whitespace.
 *   • Strip http://, https://, ftp://, mailto:, etc. (any "scheme://" prefix).
 *   • Strip leading "www." for the canonical form.
 *   • Lowercase the host portion. Keep path/casing intact (some publishers
 *     are case-sensitive about article slugs).
 *   • Strip trailing slash and trailing query/fragment if empty.
 *   • If the result is empty after stripping, return null.
 *
 * Pure function. The original cell value is preserved separately as
 * `website_raw` for provenance.
 */

export function canonicalizeWebsite(rawCell: string | null | undefined): string | null {
  if (rawCell == null) return null;
  let s = rawCell.trim();
  if (s.length === 0) return null;

  // Strip scheme.
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');

  // Lowercase the part up to the first '/' (host); keep the path as-is.
  const slash = s.indexOf('/');
  if (slash === -1) {
    s = s.toLowerCase();
  } else {
    s = s.slice(0, slash).toLowerCase() + s.slice(slash);
  }

  // Strip leading www.
  if (s.startsWith('www.')) s = s.slice(4);

  // Strip trailing slash.
  if (s.endsWith('/')) s = s.slice(0, -1);

  // Strip empty query/fragment.
  s = s.replace(/[?#]+$/, '');

  return s.length === 0 ? null : s;
}
