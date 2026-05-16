/**
 * PDF artifact extractor (T048).
 *
 * Owns `artifact_status` for `pdf` rows. v1 uses this only for the
 * date-resolution fallback (Decision 4) — PDF total extraction is gated to
 * v2 per Principle VI.
 *
 * Strategy: read the PDF bytes from a local path (configured `pdf_root` +
 * the artifact_ref filename), parse with pdf-parse, then pull a date out of
 * either the metadata `CreationDate` field or a regex over the first-page
 * text.
 *
 * Errors are caught and converted to `artifact_status='unreachable'` —
 * the row stays in totals using the sheet price (Principle I), and the
 * caller emits an `artifact_unreachable` Audit finding.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import pdfParse from 'pdf-parse';
import type { ArtifactStatus } from '../../shared/contracts.js';

export interface PdfExtractResult {
  /** ISO YYYY-MM-DD or null when no date could be derived. */
  date: string | null;
  artifact_status: ArtifactStatus;
  /** Reason for an unreachable status (for the Audit summary). null when reachable. */
  reason: string | null;
}

export interface PdfExtractOptions {
  /** Root directory for resolving relative `artifact_ref` paths.
   *  Used for path-escape protection (the resolved path MUST stay inside this root). */
  pdfRoot: string;
}

/**
 * Extract date metadata from a local PDF file referenced by `artifact_ref`.
 *
 * - Resolves `artifact_ref` against `pdfRoot`. Refuses paths that escape
 *   (returns `unreachable` with reason='path_escape') so a hostile sheet
 *   value can't read /etc/passwd.
 * - On any IO/parse failure: returns `{ date: null, artifact_status:
 *   'unreachable', reason: '...' }`. Never throws.
 */
export async function extractPdf(
  artifactRef: string,
  options: PdfExtractOptions,
): Promise<PdfExtractResult> {
  // Path-escape protection: resolve against pdfRoot, refuse if outside.
  // QA review H9: previous version used a literal `/` in the prefix check,
  // breaking on Windows (path.sep is `\\`), and skipped realpath resolution
  // so a symlink inside pdfRoot pointing outside would pass. Fix uses
  // path.relative + realpath of BOTH the root and the requested file —
  // realpath'ing only one side rejects legitimate symlinked roots
  // (Dropbox / iCloud / Cloud-synced pdf libraries) because the canonical
  // requested path no longer prefix-matches the symlinked root.
  const rootRaw = resolve(options.pdfRoot);
  const requestedRaw = isAbsolute(artifactRef)
    ? normalize(artifactRef)
    : resolve(rootRaw, artifactRef);
  if (!isInsideRoot(requestedRaw, rootRaw)) {
    return { date: null, artifact_status: 'unreachable', reason: 'path_escape' };
  }
  if (!existsSync(requestedRaw)) {
    return { date: null, artifact_status: 'unreachable', reason: 'file_not_found' };
  }
  // Realpath both sides so symlinked roots are honored AND symlinks INSIDE
  // the root that point outside are still caught. realpathSync throws if
  // the path doesn't exist, so we only call it after the existsSync gate
  // (and assume the root exists when files inside it do).
  let realRoot: string;
  let realRequested: string;
  try {
    realRoot = realpathSync(rootRaw);
    realRequested = realpathSync(requestedRaw);
  } catch {
    return { date: null, artifact_status: 'unreachable', reason: 'realpath_failed' };
  }
  if (!isInsideRoot(realRequested, realRoot)) {
    return { date: null, artifact_status: 'unreachable', reason: 'path_escape_via_symlink' };
  }
  // Use the realpath-resolved file path for the actual read so we never
  // open through a stale symlink chain.
  const requested = realRequested;

  let buf: Buffer;
  try {
    buf = readFileSync(requested);
  } catch (err) {
    return { date: null, artifact_status: 'unreachable', reason: `read_failed:${(err as Error).message}` };
  }

  let parsed: { info?: Record<string, unknown>; metadata?: unknown; text?: string };
  try {
    parsed = (await pdfParse(buf)) as typeof parsed;
  } catch (err) {
    return { date: null, artifact_status: 'unreachable', reason: `parse_failed:${(err as Error).message}` };
  }

  // Try metadata CreationDate first (PDF format: D:YYYYMMDDHHmmSSZ-style).
  const metaDate = pickPdfMetadataDate(parsed.info);
  if (metaDate !== null) {
    return { date: metaDate, artifact_status: 'reachable', reason: null };
  }

  // Fall back to regex over the first-page text.
  const textDate = pickFirstDateInText(parsed.text ?? '');
  return { date: textDate, artifact_status: 'reachable', reason: null };
}

/**
 * Parse the PDF info-dict CreationDate / ModDate field into ISO YYYY-MM-DD.
 *
 * PDF dates look like `D:20260415083000+02'00'` or `D:20260415083000Z`.
 * We're only interested in the YYYYMMDD prefix.
 */
export function pickPdfMetadataDate(info: Record<string, unknown> | undefined): string | null {
  if (!info) return null;
  for (const field of ['CreationDate', 'ModDate']) {
    const raw = info[field];
    if (typeof raw !== 'string') continue;
    const match = /D?:?(\d{4})(\d{2})(\d{2})/.exec(raw);
    if (!match) continue;
    const [, y, m, d] = match;
    const iso = `${y}-${m}-${d}`;
    if (isPlausibleIsoDate(iso)) return iso;
  }
  return null;
}

/**
 * Find the first plausible YYYY-MM-DD or DD.MM.YYYY in `text`.
 * Conservative — if the first page mentions multiple dates, we take the
 * first one (typical invoice layout has the issue date prominently).
 */
export function pickFirstDateInText(text: string): string | null {
  if (!text) return null;

  // ISO first.
  const iso = /(\d{4}-\d{2}-\d{2})/.exec(text);
  if (iso?.[1] && isPlausibleIsoDate(iso[1])) return iso[1];

  // EU/LT format.
  const eu = /(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(text);
  if (eu) {
    const [, d, m, y] = eu;
    const padded = `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
    if (isPlausibleIsoDate(padded)) return padded;
  }
  return null;
}

/**
 * Portable inside-root check. path.relative returns "." for the same dir,
 * "subdir/file" for descendants, and "../something" (or absolute) for paths
 * outside. We treat "" and "." as inside; anything starting with ".." is out.
 */
function isInsideRoot(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  if (rel === '' || rel === '.') return true;
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  // Defense in depth: relative should not begin with path.sep on any platform.
  return !rel.startsWith(sep);
}

function isPlausibleIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [yStr, mStr, dStr] = s.split('-');
  const y = Number.parseInt(yStr!, 10);
  const m = Number.parseInt(mStr!, 10);
  const d = Number.parseInt(dStr!, 10);
  if (!Number.isFinite(y) || y < 1990 || y > 2100) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}
