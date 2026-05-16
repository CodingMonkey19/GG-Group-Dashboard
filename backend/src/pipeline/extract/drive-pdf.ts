/**
 * Drive PDF artifact extractor (T049).
 *
 * Owns `artifact_status` for `drive_pdf` rows. NEVER imports `googleapis` —
 * all Drive access flows through `GwsWrapper.driveFileMetadata`, the sole
 * Google trust path (Constitution Principle III + research.md Decision 2 +
 * Codex review #4 from branch bjk1d7p3j).
 *
 * Strategy:
 *   1. Ask the GWS wrapper for Drive metadata (`createdTime`/`modifiedTime`).
 *   2. If metadata gives us a date → reachable, date returned.
 *   3. If metadata returns null OR a non-date payload → reachable but no
 *      date (caller falls through to undated; v1 doesn't actually download
 *      Drive PDF bytes for content extraction — that's a v2 step).
 *   4. Any GWS error → unreachable.
 *
 * v1 DOES NOT download the PDF bytes for parsing. That's a v2 enhancement
 * (similar to PayPal API verification — it would let us cross-check totals
 * against the sheet, which is gated by the constitution).
 */

import { GwsError, type GwsWrapper } from '../ingest/gws.js';
import type { ArtifactStatus } from '../../shared/contracts.js';

export interface DrivePdfExtractResult {
  /** ISO YYYY-MM-DD or null when no date could be derived. */
  date: string | null;
  artifact_status: ArtifactStatus;
  /** Reason for an unreachable status (for the Audit summary). null when reachable. */
  reason: string | null;
}

export async function extractDrivePdf(
  artifactRef: string,
  gws: GwsWrapper,
): Promise<DrivePdfExtractResult> {
  // Per Codex review of branch 15c079b Finding #4: GwsNotFoundError now
  // propagates from the wrapper (it used to be swallowed → null → silent
  // "reachable"). Any GwsError → artifact_status='unreachable'; the
  // extractor's caller emits an audit_unreachable finding.
  let metadata;
  try {
    metadata = await gws.driveFileMetadata(artifactRef);
  } catch (err) {
    const reason = err instanceof GwsError ? `gws_${err.name}:${err.message}` : `gws_error:${(err as Error).message}`;
    return { date: null, artifact_status: 'unreachable', reason };
  }

  if (metadata === null) {
    // null is reserved for "the wrapper didn't recognize this as a Drive
    // URL". This shouldn't happen in production (the orchestrator only
    // calls extractDrivePdf for invoice_type='drive_pdf'), but defend
    // anyway: treat as unreachable so the operator notices the misclassification.
    return {
      date: null,
      artifact_status: 'unreachable',
      reason: 'not_a_drive_url',
    };
  }

  // Prefer createdTime (when the invoice was issued); fall back to modifiedTime.
  const candidate = metadata.created_time ?? metadata.modified_time;
  if (candidate === null || candidate === undefined) {
    // Reachable, just no date metadata available. Caller's date chain will
    // fall through to undated. Not an audit issue per se.
    return { date: null, artifact_status: 'reachable', reason: null };
  }
  const isoDate = isoToDate(candidate);
  return { date: isoDate, artifact_status: 'reachable', reason: null };
}

/** ISO-8601 timestamp (UTC) → YYYY-MM-DD. Returns null when parsing fails. */
export function isoToDate(iso: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  const [, y, m, d] = match;
  return `${y}-${m}-${d}`;
}
