/**
 * T041e — Contract test for route allowlist (FR-026).
 *
 * The dashboard is read-only on invoices (Constitution Principle I).
 * Boots Fastify and asserts that ONLY the four expected routes are
 * mounted; any other path returns 404. This catches future regressions
 * where a developer adds an unintended write endpoint.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';

describe('Route allowlist contract (T041e, FR-026)', () => {
  let dataDir: string;
  let configPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(resolve(tmpdir(), 'gg-spend-allowlist-'));
    configPath = resolve(dataDir, 'sheets.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        sheets: [
          {
            spreadsheet_id: 'X',
            order_code: 'X',
            tabs: ['April 2026'],
            column_mapping: { status: 'A', price: 'B' },
          },
        ],
      }),
    );
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('exposes ONLY GET /healthz, GET /api/data, POST /api/refresh, GET /api/artifact/:source_row_key', async () => {
    const app = await buildServer({ dataDir, sheetsConfigPath: configPath });
    try {
      // Allowed routes — should NOT 404.
      const allowed: Array<{ method: 'GET' | 'POST'; url: string; expectNot404: true }> = [
        { method: 'GET', url: '/healthz', expectNot404: true },
        { method: 'GET', url: '/api/data', expectNot404: true },
        // POST /api/refresh starts an SSE refresh; we just verify the route is
        // mounted (status !== 404) — full SSE behavior covered by T041.
        { method: 'POST', url: '/api/refresh', expectNot404: true },
        // GET /api/artifact/:source_row_key with a 16-hex-char placeholder
        // — should return 400/404/501 (whatever the handler decides),
        // NEVER 404 from the router.
        { method: 'GET', url: '/api/artifact/0123456789abcdef', expectNot404: true },
      ];
      for (const route of allowed) {
        const res = await app.inject({ method: route.method, url: route.url });
        expect(
          res.statusCode,
          `${route.method} ${route.url} should be ROUTED (not 404), got ${res.statusCode}`,
        ).not.toBe(404);
      }

      // Forbidden routes — should 404 (no write endpoints, no admin routes).
      const forbidden: Array<{ method: string; url: string }> = [
        { method: 'POST', url: '/api/data' },
        { method: 'PUT', url: '/api/data' },
        { method: 'DELETE', url: '/api/data' },
        { method: 'PATCH', url: '/api/data' },
        { method: 'GET', url: '/api/refresh' }, // refresh is POST-only
        { method: 'PUT', url: '/api/refresh' },
        { method: 'DELETE', url: '/api/refresh' },
        { method: 'POST', url: '/api/artifact/0123456789abcdef' },
        { method: 'PUT', url: '/api/artifact/0123456789abcdef' },
        { method: 'DELETE', url: '/api/artifact/0123456789abcdef' },
        { method: 'POST', url: '/api/invoices' },
        { method: 'POST', url: '/api/invoices/123' },
        { method: 'PUT', url: '/api/invoices/123' },
        { method: 'GET', url: '/api/invoices' },
        { method: 'POST', url: '/api/orders' },
        { method: 'POST', url: '/api/audit' },
        { method: 'POST', url: '/admin' },
        { method: 'GET', url: '/admin' },
        { method: 'GET', url: '/random/path' },
        { method: 'POST', url: '/healthz' },
      ];
      for (const route of forbidden) {
        const res = await app.inject({
          method: route.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
          url: route.url,
        });
        expect(
          res.statusCode,
          `${route.method} ${route.url} should be 404 (not routed), got ${res.statusCode}`,
        ).toBe(404);
      }
    } finally {
      await app.close();
    }
  });
});
