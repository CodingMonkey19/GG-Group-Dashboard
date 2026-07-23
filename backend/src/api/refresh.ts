/**
 * POST /api/refresh handler with SSE progress (T056).
 *
 * Acquires the data/.refresh.lock; if held → 409 Conflict. Otherwise
 * starts an SSE stream and invokes consolidate() with the onEvent
 * callback writing each phase / source_progress / completed event to
 * the wire.
 *
 * Atomic-replace happens inside consolidate() — by the time we emit
 * `completed`, the new store is already live and `/api/data` will
 * see it.
 */

import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';
import { acquireRefreshLock, RefreshInProgressError } from './lock.js';
import { consolidate } from '../pipeline/consolidate.js';
import { logger } from '../shared/logger.js';
import { sanitizeErrorMessage } from '../shared/sanitize.js';
import type { RefreshSseEvent } from '../shared/contracts.js';

export function registerRefreshRoute(app: FastifyInstance): void {
  // QA review H14: reject any non-empty body up front so a malicious internal
  // client can't tie up bodyLimit-worth of memory before the handler drops
  // the payload. POST /api/refresh takes no parameters.
  const emptyBodySchema = {
    body: {
      anyOf: [{ type: 'object', additionalProperties: false }, { type: 'null' }],
    },
  };
  app.post('/api/refresh', { schema: emptyBodySchema }, async (req, reply) => {
    const dataDir = app.appOptions.dataDir;
    const sheetsConfigPath = app.appOptions.sheetsConfigPath;
    if (dataDir === undefined || sheetsConfigPath === undefined) {
      reply.code(500);
      return { error: 'data_dir_or_config_not_configured' };
    }

    // Acquire the refresh lock up front. If held → 409.
    let releaseLock: (() => Promise<void>) | null = null;
    try {
      const handle = await acquireRefreshLock(dataDir);
      releaseLock = handle.release;
    } catch (err) {
      if (err instanceof RefreshInProgressError) {
        reply.code(409);
        return { error: 'refresh_in_progress' };
      }
      throw err;
    }

    // Open the SSE stream.
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-cache',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    reply.hijack();

    // QA review C6: detect client disconnect so we can stop writing into a
    // dead socket and surface the wasted-work signal in the operator log.
    // We don't yet abort the in-flight pipeline (that's a v2 refactor that
    // requires threading an AbortSignal through every async I/O), but the
    // observability + early lock-release on close is the meaningful gain.
    let clientGone = false;
    req.raw.on('close', () => {
      if (!clientGone) {
        clientGone = true;
        logger.warn(
          'SSE client disconnected mid-refresh; pipeline continues to completion. ' +
            'Lock will release when the run finishes.',
        );
      }
    });

    let activeRefreshId = 0;
    const writeEvent = (event: RefreshSseEvent): void => {
      if (event.event === 'started') {
        activeRefreshId = event.data.refresh_id;
      }
      if (clientGone) return; // skip writes to a dead socket
      try {
        reply.raw.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
      } catch (err) {
        // EPIPE / ERR_STREAM_DESTROYED → mark the client as gone so we
        // don't loop on every event.
        clientGone = true;
        logger.warn(
          { err: { name: (err as Error).name, message: (err as Error).message } },
          'failed to write SSE event; treating client as disconnected',
        );
      }
    };

    try {
      await consolidate({
        configPath: sheetsConfigPath,
        dataDir,
        pdfRoot: resolve(dataDir, 'pdfs'),
        onEvent: writeEvent,
        // Test-only injections; production never sets these.
        ...(app.appOptions.gwsFactory !== undefined
          ? { gwsFactory: app.appOptions.gwsFactory }
          : {}),
        ...(app.appOptions.ecbSeeder !== undefined
          ? { ecbSeeder: app.appOptions.ecbSeeder }
          : {}),
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // Log the unsanitized form server-side for operator diagnostics; only
      // the sanitized form leaves the process.
      logger.error(
        { err: { name: err instanceof Error ? err.name : 'Error', message: raw } },
        'refresh failed before completion',
      );
      writeEvent({
        event: 'error',
        data: {
          // refresh_id may legitimately be 0 here when the pipeline threw
          // before allocateRefreshEvent could run (e.g., ECB seeder + DB
          // open failures). Once `started` is emitted, preserve its ID for
          // every terminal event in that refresh.
          refresh_id: activeRefreshId,
          error: sanitizeErrorMessage(raw),
        },
      });
    } finally {
      try {
        await releaseLock();
      } catch {
        // best-effort
      }
      try {
        reply.raw.end();
      } catch {
        // already closed
      }
    }

    return reply;
  });
}
