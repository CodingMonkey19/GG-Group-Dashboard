/**
 * GET /api/artifact/:source_row_key (T082).
 *
 * Per contracts/api-artifact.md: serves invoice artifacts to the CEO's
 * browser without requiring re-authentication to Google. The backend already
 * holds the authenticated `gws` context; the proxy reuses it to fetch
 * `drive_pdf` rows. Local `pdf` rows resolve under a configured pdf_root.
 *
 * URL key: 16-char lowercase hex `source_row_key` (stable across refreshes).
 * Per Codex review #2 (branch bjk1d7p3j) the SQLite AUTOINCREMENT id is
 * NEVER exposed — it would silently re-target a different row after re-ingest.
 *
 * Behavior matrix (FR-026 + spec):
 *   pdf       → 200 application/pdf, streamed from <pdf_root>/<artifact_ref>
 *   drive_pdf → 200 application/pdf, fetched via gws.driveFileBytes
 *   paypal    → 409 use_direct_url
 *   intuit    → 409 use_direct_url
 *   text      → 409 no_artifact_to_proxy + the text content
 *   missing   → 404 no_artifact
 *
 * Headers always set: Cache-Control: private, no-store; X-Content-Type-Options: nosniff.
 *
 * Logging discipline (Constitution Principle II + V): logs the source_row_key,
 * invoice_type, and outcome at INFO. NEVER logs upstream URL with file ID,
 * file contents, or operator-PII path strings (sanitized via sanitizeErrorMessage).
 */

import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import type { Database as DatabaseT } from 'better-sqlite3';
import { GwsAuthError, GwsNotFoundError, type GwsWrapper } from '../pipeline/ingest/gws.js';
import { GwsSubprocess } from '../pipeline/ingest/gws-subprocess.js';
import {
  openStore,
  readSnapshotMetadata,
  snapshotInvoicesAreCompatible,
} from '../pipeline/store/db.js';
import { logger } from '../shared/logger.js';
import { sanitizeErrorMessage } from '../shared/sanitize.js';
import type { InvoiceType } from '../shared/contracts.js';

interface ArtifactRow {
  source_row_key: string;
  invoice_type: InvoiceType;
  artifact_ref: string | null;
  order_code: string;
  row_index: number;
}

const KEY_FORMAT = /^[0-9a-f]{16}$/;

export function registerArtifactRoute(app: FastifyInstance): void {
  app.get<{
    Params: { source_row_key: string };
    Querystring: { disposition?: string };
  }>('/api/artifact/:source_row_key', async (req, reply) => {
    const key = req.params.source_row_key;
    if (!KEY_FORMAT.test(key)) {
      reply.code(400);
      return { error: 'invalid_source_row_key' };
    }

    const dataDir = app.appOptions.dataDir;
    if (dataDir === undefined) {
      reply.code(500);
      return { error: 'data_dir_not_configured' };
    }
    const livePath = resolve(dataDir, 'consolidated.sqlite');
    if (!existsSync(livePath)) {
      reply.code(503);
      return { error: 'never_refreshed' };
    }

    let row: ArtifactRow | undefined;
    let db: DatabaseT | undefined;
    try {
      db = openStore(livePath);
      // Check the entire snapshot before looking up an artifact key. A valid
      // metadata row is not enough if a manual mutation introduced a legacy,
      // malformed, or mixed-year invoice alongside it.
      if (readSnapshotMetadata(db) === null || !snapshotInvoicesAreCompatible(db)) {
        reply.code(503);
        return { error: 'incompatible_snapshot' };
      }
      row = db
        .prepare(
          `SELECT source_row_key, invoice_type, artifact_ref, order_code, row_index
             FROM invoices
            WHERE source_row_key = ?
              AND invoice_date >= '2026-01-01'
              AND invoice_date < '2027-01-01'
              AND invoice_month = substr(invoice_date, 1, 7)`,
        )
        .get(key) as ArtifactRow | undefined;
    } catch {
      reply.code(503);
      return { error: 'incompatible_snapshot' };
    } finally {
      try {
        db?.close();
      } catch {
        // best-effort
      }
    }

    if (!row) {
      reply.code(404);
      return { error: 'not_found' };
    }

    // Always-on response headers per contract.
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Content-Type-Options', 'nosniff');

    const disposition = req.query.disposition === 'attachment' ? 'attachment' : 'inline';
    const filename = sanitizeFilename(`${row.order_code}_row${row.row_index}.pdf`);

    logger.info(
      { source_row_key: row.source_row_key, invoice_type: row.invoice_type, disposition },
      'artifact proxy request',
    );

    switch (row.invoice_type) {
      case 'paypal':
      case 'intuit':
        // Frontend opens the public URL directly; the proxy refuses on purpose
        // so misuse is loud rather than silent.
        reply.code(409);
        return { error: 'use_direct_url', url: row.artifact_ref };

      case 'text':
        reply.code(409);
        return { error: 'no_artifact_to_proxy', text: row.artifact_ref };

      case 'missing':
        reply.code(404);
        return { error: 'no_artifact' };

      case 'pdf':
        return servePdf(row, app.appOptions.pdfRoot, dataDir, reply, disposition, filename);

      case 'drive_pdf': {
        const gws = (app.appOptions.gwsFactory ?? (() => new GwsSubprocess()))();
        return serveDrivePdf(row, gws, reply, disposition, filename);
      }
    }
  });
}

async function servePdf(
  row: ArtifactRow,
  configuredPdfRoot: string | undefined,
  dataDir: string,
  reply: import('fastify').FastifyReply,
  disposition: 'inline' | 'attachment',
  filename: string,
): Promise<unknown> {
  if (row.artifact_ref === null) {
    reply.code(404);
    return { error: 'no_artifact_ref' };
  }

  const root = resolve(configuredPdfRoot ?? resolve(dataDir, 'pdfs'));
  const requestedRaw = isAbsolute(row.artifact_ref)
    ? normalize(row.artifact_ref)
    : resolve(root, row.artifact_ref);

  if (!isInsideRoot(requestedRaw, root)) {
    reply.code(400);
    return { error: 'path_escape' };
  }
  if (!existsSync(requestedRaw)) {
    reply.code(404);
    return { error: 'file_not_found' };
  }

  // Realpath both sides so symlinked roots (Dropbox / iCloud / mounted SSDs)
  // are honored AND symlinks INSIDE the root pointing OUTSIDE are still
  // caught. Same pattern as extract/pdf.ts (QA review H9).
  let realRoot: string;
  let realRequested: string;
  try {
    realRoot = realpathSync(root);
    realRequested = realpathSync(requestedRaw);
  } catch {
    reply.code(404);
    return { error: 'realpath_failed' };
  }
  if (!isInsideRoot(realRequested, realRoot)) {
    reply.code(400);
    return { error: 'path_escape_via_symlink' };
  }

  let size: number;
  try {
    size = statSync(realRequested).size;
  } catch {
    reply.code(404);
    return { error: 'stat_failed' };
  }

  reply.header('Content-Type', 'application/pdf');
  reply.header('Content-Length', String(size));
  reply.header('Content-Disposition', `${disposition}; filename="${filename}"`);
  return reply.send(createReadStream(realRequested));
}

async function serveDrivePdf(
  row: ArtifactRow,
  gws: GwsWrapper,
  reply: import('fastify').FastifyReply,
  disposition: 'inline' | 'attachment',
  filename: string,
): Promise<unknown> {
  if (row.artifact_ref === null) {
    reply.code(404);
    return { error: 'no_artifact_ref' };
  }
  let bytes: Buffer;
  try {
    bytes = await gws.driveFileBytes(row.artifact_ref);
  } catch (err) {
    if (err instanceof GwsNotFoundError) {
      logger.warn({ source_row_key: row.source_row_key }, 'drive artifact not found');
      reply.code(404);
      return { error: 'drive_not_found' };
    }
    if (err instanceof GwsAuthError) {
      logger.warn({ source_row_key: row.source_row_key }, 'gws auth failure during artifact fetch');
      reply.code(502);
      return { error: 'gws_auth_failure', detail: 'operator must re-authenticate gws' };
    }
    const raw = err instanceof Error ? err.message : String(err);
    logger.warn(
      { source_row_key: row.source_row_key, err: { message: raw } },
      'drive artifact fetch failed',
    );
    reply.code(502);
    return { error: 'drive_fetch_failed', detail: sanitizeErrorMessage(raw) };
  }

  reply.header('Content-Type', 'application/pdf');
  reply.header('Content-Length', String(bytes.length));
  reply.header('Content-Disposition', `${disposition}; filename="${filename}"`);
  return reply.send(bytes);
}

/** path.relative-based inside-root check; same pattern as extract/pdf.ts. */
function isInsideRoot(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  if (rel === '' || rel === '.') return true;
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  return !rel.startsWith(sep);
}

/** Conservative filename sanitizer for Content-Disposition. */
function sanitizeFilename(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
}
