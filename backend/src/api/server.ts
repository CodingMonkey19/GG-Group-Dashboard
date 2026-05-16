/**
 * Fastify bootstrap for the GG Spend Dashboard backend.
 *
 * Routes (handlers land in subsequent phases):
 *   GET  /healthz                            — liveness probe
 *   GET  /api/data                           — consolidated snapshot envelope
 *   POST /api/refresh                        — trigger consolidation + SSE stream
 *   GET  /api/artifact/:source_row_key       — PDF/Drive PDF proxy
 *
 * Static: serves frontend/dist when present (production deployment).
 *
 * Constitution: LAN-only deployment in v1 (FR-027). The bind address comes
 * from PORT/HOST env vars; deployment runbook should constrain HOST to the
 * LAN interface or 127.0.0.1.
 */

import type { Database as DatabaseT } from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import type { GwsWrapper } from '../pipeline/ingest/gws.js';
import { logger } from '../shared/logger.js';
import { registerArtifactRoute } from './artifact.js';
import { registerDataRoute } from './data.js';
import { registerRefreshRoute } from './refresh.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = resolve(__dirname, '../../../frontend/dist');

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Path to the data directory (consolidated.sqlite + ECB cache live here). */
  dataDir?: string;
  /** Path to config/sheets.json. */
  sheetsConfigPath?: string;
  /**
   * Local PDF root for `pdf` artifact resolution (T083). Required by
   * GET /api/artifact/:source_row_key for `invoice_type='pdf'` rows.
   * Defaults to <dataDir>/pdfs when omitted.
   */
  pdfRoot?: string;
  /**
   * Test-only injection of a GwsWrapper factory. Production main() never
   * passes this; the refresh handler defaults to GwsSubprocess. Tests pass
   * FixtureGws so the API path doesn't depend on a `gws` binary on PATH.
   */
  gwsFactory?: () => GwsWrapper;
  /**
   * Test-only injection of an ECB seeder. Production main() never passes
   * this; the refresh handler defaults to fetching the ECB historical XML.
   * Tests pre-seed in-memory rates so the API path doesn't hit the network.
   */
  ecbSeeder?: (db: DatabaseT) => Promise<void>;
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // we attach our pino instance manually so redaction policy is enforced
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });

  // Decorate options FIRST so route handlers can read them.
  app.decorate('appOptions', options);

  // QA review H13: defense-in-depth security headers on every response.
  // LAN-only deployment is the primary access control (per Constitution
  // Data Integration Constraints), but headers cost nothing.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  // ----- /healthz -----
  app.get('/healthz', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  // ----- /api/data (T055) -----
  registerDataRoute(app);

  // ----- /api/refresh (T056) -----
  registerRefreshRoute(app);

  // ----- /api/artifact/:source_row_key (T082) -----
  registerArtifactRoute(app);

  // ----- static frontend (production) -----
  if (existsSync(FRONTEND_DIST)) {
    // Lazy-import so dev mode doesn't pull in the static module unnecessarily.
    const fastifyStatic = await import('@fastify/static').catch(() => null);
    if (fastifyStatic !== null) {
      await app.register(fastifyStatic.default, {
        root: FRONTEND_DIST,
        prefix: '/',
        wildcard: false,
      });
    } else {
      logger.warn(
        { dir: FRONTEND_DIST },
        '@fastify/static not installed; skipping static frontend serving',
      );
    }
  } else {
    logger.info({ dir: FRONTEND_DIST }, 'frontend/dist not present; static serving skipped');
  }

  // log unhandled errors via pino with redaction
  app.setErrorHandler((err, req, reply) => {
    logger.error({ err: { name: err.name, message: err.message }, route: req.url }, 'request error');
    reply.code(500);
    return { error: 'internal_server_error' };
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    appOptions: ServerOptions;
  }
}

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? '8080', 10);
  const host = process.env.HOST ?? '0.0.0.0';
  const dataDir = process.env.DATA_DIR ?? resolve(process.cwd(), 'data');
  const sheetsConfigPath =
    process.env.SHEETS_CONFIG ?? resolve(process.cwd(), 'config/sheets.json');

  const pdfRoot = process.env.PDF_ROOT ?? resolve(dataDir, 'pdfs');
  const app = await buildServer({ port, host, dataDir, sheetsConfigPath, pdfRoot });

  try {
    await app.listen({ port, host });
    logger.info(
      { port, host, dataDir, sheetsConfigPath },
      'GG Spend Dashboard backend listening (LAN-only per FR-027)',
    );
  } catch (err) {
    logger.error({ err }, 'failed to start backend');
    process.exit(1);
  }
}

// Run main when executed directly (not when imported by tests).
const isDirectRun = (() => {
  try {
    const entry = process.argv[1];
    if (entry === undefined) return false;
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main();
}
