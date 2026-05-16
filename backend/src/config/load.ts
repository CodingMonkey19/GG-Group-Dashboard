/**
 * Loader for `config/sheets.json` — the operator-facing per-sheet config.
 *
 * Validates with the SheetsConfig zod schema (FR-005, FR-014). Any invalid
 * config is a hard fail with a line-number-quality message, because shipping
 * with a broken config would either drop sources silently or pull garbage.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { SheetsConfig, type SheetsConfig as SheetsConfigT } from '../shared/contracts.js';

export class SheetsConfigError extends Error {
  override readonly name = 'SheetsConfigError';
  constructor(
    message: string,
    public readonly path: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

/**
 * Read + parse + validate `config/sheets.json`. Returns the parsed config or
 * throws SheetsConfigError on any failure.
 */
export function loadSheetsConfig(configPath: string): SheetsConfigT {
  const absolutePath = resolve(configPath);

  let raw: string;
  try {
    raw = readFileSync(absolutePath, 'utf8');
  } catch (err) {
    throw new SheetsConfigError(
      `Cannot read sheets config at ${absolutePath}: ${(err as Error).message}`,
      absolutePath,
      err,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SheetsConfigError(
      `sheets config at ${absolutePath} is not valid JSON: ${(err as Error).message}`,
      absolutePath,
      err,
    );
  }

  const result = SheetsConfig.safeParse(parsed);
  if (!result.success) {
    throw new SheetsConfigError(formatZodError(result.error, absolutePath), absolutePath, result.error);
  }
  return result.data;
}

function formatZodError(error: z.ZodError, path: string): string {
  const issues = error.issues
    .map((issue) => {
      const loc = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `  • at ${loc}: ${issue.message}`;
    })
    .join('\n');
  return `sheets config at ${path} failed schema validation:\n${issues}`;
}

/**
 * Resolve a tab name through the config's `tab_aliases` map, if present.
 *
 * Per FR-006, sheets often have spelling-variant tabs (e.g., "Previos Orders"
 * vs "Previous Orders"). The config maps canonical → known variant; this
 * helper looks up the canonical for a given raw tab name found in the sheet.
 *
 * Returns the canonical name when found, otherwise the raw tab unchanged.
 */
export function canonicalizeTabName(
  rawTab: string,
  tabAliases: SheetsConfigT['tab_aliases'],
): string {
  if (!tabAliases) return rawTab;
  for (const [canonical, variant] of Object.entries(tabAliases)) {
    if (variant === rawTab || canonical === rawTab) return canonical;
  }
  return rawTab;
}
