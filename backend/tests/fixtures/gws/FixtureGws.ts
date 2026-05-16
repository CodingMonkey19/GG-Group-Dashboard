/**
 * FixtureGws — fully-deterministic GwsWrapper for tests.
 *
 * Reads pre-recorded JSON from disk so pipeline integration tests stay
 * offline-deterministic. The real GwsSubprocess is exercised only by the
 * smoke test gated behind GG_LIVE_GWS=1.
 *
 * Layout:
 *   tests/fixtures/sheets/
 *     <spreadsheet_id>/
 *       __tabs.json       → ["Tab 1", "Previous Orders", ...]
 *       <tab>.json        → { rows: string[][] }   (one file per tab)
 *
 * If a spreadsheet_id has no fixture, calls reject with GwsNotFoundError.
 * If a specific tab has no fixture, listTabs may still return its name but
 * pullSheet rejects with GwsNotFoundError.
 *
 * Failure-injection: pass `failures` to construct a wrapper that throws
 * GwsAuthError or GwsError for specific spreadsheet IDs — used by
 * partial-refresh tests.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GwsAuthError,
  GwsError,
  GwsNotFoundError,
  type DriveFileMetadata,
  type FolderSpreadsheet,
  type GwsWrapper,
  type RawRow,
} from '../../../src/pipeline/ingest/gws.js';

export interface FixtureGwsFailures {
  /** spreadsheet_ids that should reject with GwsAuthError on listTabs/pullSheet. */
  authErrors?: Set<string>;
  /** spreadsheet_ids that should reject with a generic GwsError. */
  genericErrors?: Map<string, string>;
  /** Drive URLs that should reject with a generic GwsError when fetching metadata. */
  driveMetadataErrors?: Set<string>;
  /** Drive URLs that should reject with GwsNotFoundError (file deleted / no access). */
  driveMetadataNotFound?: Set<string>;
  /** Drive URLs that should reject with a generic GwsError when fetching bytes. */
  driveBytesErrors?: Set<string>;
  /** Drive URLs that should reject with GwsNotFoundError when fetching bytes. */
  driveBytesNotFound?: Set<string>;
  /** Drive folder IDs that should reject with GwsAuthError when listing files. */
  folderAuthErrors?: Set<string>;
  /** Drive folder IDs that should reject with generic GwsError when listing files. */
  folderErrors?: Set<string>;
}

export interface FixtureGwsOptions {
  fixturesRoot?: string;
  failures?: FixtureGwsFailures;
  /** Map URL → DriveFileMetadata. Anything else returns null (per real wrapper). */
  driveMetadata?: Map<string, DriveFileMetadata>;
  /** Map URL → file bytes for the artifact-proxy contract tests. */
  driveBytes?: Map<string, Buffer>;
  /** Map folderId → spreadsheet files for dynamic folder-source tests. */
  folderSpreadsheets?: Map<string, FolderSpreadsheet[]>;
}

const DEFAULT_FIXTURES_ROOT = resolve(import.meta.dirname, '../sheets');

export class FixtureGws implements GwsWrapper {
  private readonly fixturesRoot: string;
  private readonly failures: FixtureGwsFailures;
  private readonly driveMetadata: Map<string, DriveFileMetadata>;
  private readonly driveBytes: Map<string, Buffer>;
  private readonly folderSpreadsheets: Map<string, FolderSpreadsheet[]>;

  constructor(opts: FixtureGwsOptions = {}) {
    this.fixturesRoot = opts.fixturesRoot ?? DEFAULT_FIXTURES_ROOT;
    this.failures = opts.failures ?? {};
    this.driveMetadata = opts.driveMetadata ?? new Map();
    this.driveBytes = opts.driveBytes ?? new Map();
    this.folderSpreadsheets = opts.folderSpreadsheets ?? new Map();
  }

  private throwIfInjectedFailure(spreadsheetId: string): void {
    if (this.failures.authErrors?.has(spreadsheetId)) {
      throw new GwsAuthError(`fixture: auth failure for ${spreadsheetId}`);
    }
    const generic = this.failures.genericErrors?.get(spreadsheetId);
    if (generic !== undefined) {
      throw new GwsError(`fixture: ${generic}`);
    }
  }

  async listTabs(spreadsheetId: string): Promise<string[]> {
    this.throwIfInjectedFailure(spreadsheetId);
    const tabsPath = resolve(this.fixturesRoot, spreadsheetId, '__tabs.json');
    if (!existsSync(tabsPath)) {
      throw new GwsNotFoundError(`fixture: no __tabs.json for ${spreadsheetId}`);
    }
    const raw = readFileSync(tabsPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === 'string')) {
      throw new GwsError(`fixture: malformed __tabs.json for ${spreadsheetId}`);
    }
    return parsed;
  }

  async listFolderSpreadsheets(folderId: string): Promise<FolderSpreadsheet[]> {
    if (this.failures.folderAuthErrors?.has(folderId)) {
      throw new GwsAuthError(`fixture: folder auth failure for ${folderId}`);
    }
    if (this.failures.folderErrors?.has(folderId)) {
      throw new GwsError(`fixture: folder list failure for ${folderId}`);
    }
    return [...(this.folderSpreadsheets.get(folderId) ?? [])];
  }

  async pullSheet(spreadsheetId: string, tab: string): Promise<RawRow[]> {
    this.throwIfInjectedFailure(spreadsheetId);
    const tabPath = resolve(this.fixturesRoot, spreadsheetId, `${tab}.json`);
    if (!existsSync(tabPath)) {
      throw new GwsNotFoundError(`fixture: no fixture for ${spreadsheetId}/${tab}`);
    }
    const raw = readFileSync(tabPath, 'utf8');
    const parsed = JSON.parse(raw) as { rows?: unknown };
    if (!Array.isArray(parsed.rows)) {
      throw new GwsError(`fixture: ${spreadsheetId}/${tab}.json missing 'rows' array`);
    }
    return parsed.rows.map((cells, idx) => {
      if (!Array.isArray(cells)) {
        throw new GwsError(
          `fixture: ${spreadsheetId}/${tab}.json row ${idx + 1} is not an array`,
        );
      }
      return {
        row_index: idx + 1,
        cells: cells.map((c) => (typeof c === 'string' ? c : String(c ?? ''))),
      };
    });
  }

  async pullSheetRange(spreadsheetId: string, tab: string, a1Range: string): Promise<RawRow[]> {
    const rows = await this.pullSheet(spreadsheetId, tab);
    const rowMatch = /[A-Z]+(\d+)/i.exec(a1Range);
    const startRow = rowMatch ? Number.parseInt(rowMatch[1]!, 10) : 1;
    const endMatch = /:[A-Z]+(\d+)/i.exec(a1Range);
    const endRow = endMatch ? Number.parseInt(endMatch[1]!, 10) : startRow;
    return rows.filter((row) => row.row_index >= startRow && row.row_index <= endRow);
  }

  async pullSheetHeaders(spreadsheetId: string, tabs: string[]): Promise<Map<string, RawRow[]>> {
    const result = new Map<string, RawRow[]>();
    for (const tab of tabs) {
      result.set(tab, await this.pullSheetRange(spreadsheetId, tab, 'A1:O1'));
    }
    return result;
  }

  async driveFileMetadata(url: string): Promise<DriveFileMetadata | null> {
    if (this.failures.driveMetadataNotFound?.has(url)) {
      throw new GwsNotFoundError(`fixture: drive file not found for ${url}`);
    }
    if (this.failures.driveMetadataErrors?.has(url)) {
      throw new GwsError(`fixture: drive metadata failure for ${url}`);
    }
    return this.driveMetadata.get(url) ?? null;
  }

  async driveFileBytes(url: string): Promise<Buffer> {
    if (this.failures.driveBytesNotFound?.has(url)) {
      throw new GwsNotFoundError(`fixture: drive bytes not found for ${url}`);
    }
    if (this.failures.driveBytesErrors?.has(url)) {
      throw new GwsError(`fixture: drive bytes fetch failed for ${url}`);
    }
    const buf = this.driveBytes.get(url);
    if (buf === undefined) {
      throw new GwsNotFoundError(`fixture: no drive bytes registered for ${url}`);
    }
    return buf;
  }
}
