/**
 * Subprocess implementation of GwsWrapper.
 *
 * Spawns the `gws` binary (Google Workspace CLI) via `child_process.spawn`
 * — NOT `exec` — so spreadsheet IDs and tab names cannot be interpreted as
 * shell metacharacters. All arguments (including the JSON `--params`
 * payload) are passed as separate argv entries.
 *
 * Auth state is owned entirely by the `gws` binary; the dashboard owns no
 * Google credentials (Constitution Principle III).
 *
 * The real `gws` CLI (verified against the brew install at
 * /opt/homebrew/bin/gws on 2026-05-12) uses Google API endpoint shapes:
 *   gws sheets spreadsheets get        --params '{"spreadsheetId": "...", "fields": "sheets.properties.title"}'
 *   gws sheets spreadsheets values get --params '{"spreadsheetId": "...", "range": "<tab>", "valueRenderOption": "FORMATTED_VALUE"}'
 *   gws drive files get                --params '{"fileId": "...", "fields": "id,name,mimeType,createdTime,modifiedTime"}'
 *   gws drive files get                --params '{"fileId": "...", "alt": "media"}'
 *
 * All four return verbatim Google API JSON (or raw bytes for alt=media).
 * This module translates them into the simpler GwsWrapper interface
 * (string[] of tab names, RawRow[] of cells, DriveFileMetadata, Buffer)
 * so the rest of the pipeline stays decoupled from the CLI shape.
 *
 * If your `gws` build uses different subcommands, adapt the argv strings here
 * and ONLY here. The pipeline depends on `GwsWrapper`, not on this module.
 */

import { spawn } from 'node:child_process';
import {
  GwsAuthError,
  GwsError,
  GwsNotFoundError,
  type DriveFileMetadata,
  type FolderSpreadsheet,
  type GwsWrapper,
  type PullSheetOptions,
  type RawRow,
} from './gws.js';

// GwsNotFoundError is intentionally re-exported via a type-only reference here
// — it's THROWN by runGws when the gws subprocess reports not-found, and that
// throw propagates through driveFileMetadata so the caller (extract/drive-pdf.ts)
// can catch it and mark the row as artifact_unreachable.
void GwsNotFoundError;

const DEFAULT_GWS_BIN = process.env.GWS_BIN ?? 'gws';
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.GWS_TIMEOUT_MS ?? '60000', 10);
const DEFAULT_QUOTA_RETRIES = Number.parseInt(process.env.GWS_QUOTA_RETRIES ?? '5', 10);
const DEFAULT_QUOTA_BACKOFF_MS = Number.parseInt(process.env.GWS_QUOTA_BACKOFF_MS ?? '65000', 10);

interface SpawnOptions {
  binary?: string;
  timeoutMs?: number;
}

/**
 * Run `gws` with the given argv and return stdout. Rejects with a typed
 * error on non-zero exit or timeout. Stdout is captured as utf8 (used for
 * JSON-returning subcommands).
 */
function runGws(argv: string[], options: SpawnOptions = {}): Promise<string> {
  return runGwsBytes(argv, options).then((buf) => buf.toString('utf8'));
}

/**
 * Run `gws` with the given argv and return stdout as raw bytes.
 * Used for binary downloads (e.g., Drive PDFs in the artifact proxy).
 */
async function runGwsBytes(argv: string[], options: SpawnOptions = {}): Promise<Buffer> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runGwsBytesOnce(argv, options);
    } catch (err) {
      if (err instanceof GwsQuotaError && attempt < DEFAULT_QUOTA_RETRIES) {
        await sleep(DEFAULT_QUOTA_BACKOFF_MS);
        continue;
      }
      throw err;
    }
  }
}

function runGwsBytesOnce(argv: string[], options: SpawnOptions = {}): Promise<Buffer> {
  const binary = options.binary ?? DEFAULT_GWS_BIN;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(binary, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // shell: false is the default for spawn — explicit for clarity.
      shell: false,
    });

    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new GwsError(`spawn ${binary} failed: ${err.message}`, err));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new GwsError(`gws timed out after ${timeoutMs}ms`));
        return;
      }
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks));
        return;
      }
      const lower = stderr.toLowerCase();
      if (lower.includes('quota')) {
        reject(new GwsQuotaError(`gws quota exceeded: ${stderr.trim()}`));
        return;
      }
      if (lower.includes('auth') || lower.includes('login') || lower.includes('credential')) {
        reject(new GwsAuthError(`gws auth failure: ${stderr.trim()}`));
        return;
      }
      if (lower.includes('not found') || lower.includes('does not exist') || code === 2) {
        reject(new GwsNotFoundError(`gws not found: ${stderr.trim()}`));
        return;
      }
      reject(new GwsError(`gws exit ${code}: ${stderr.trim() || stdoutChunks.toString().slice(0, 200)}`));
    });
  });
}

class GwsQuotaError extends GwsError {
  constructor(message: string) {
    super(message);
    this.name = 'GwsQuotaError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson<T>(stdout: string, context: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (err) {
    throw new GwsError(
      `gws returned non-JSON output for ${context}: ${(err as Error).message}`,
      err,
    );
  }
}

/**
 * Real `gws` CLI uses the standard Google API endpoint shape:
 *   gws <service> <resource> [sub-resource] <method> [--params <JSON>]
 *
 * Each method accepts query/path params as a JSON object via `--params`.
 * Responses are the verbatim Google API JSON. We translate them into the
 * simpler GwsWrapper interface (string[] of tab names, RawRow[] of cells,
 * DriveFileMetadata, Buffer of file bytes) so the rest of the pipeline
 * stays decoupled from the CLI shape.
 *
 * Endpoints used:
 *   sheets.spreadsheets.get        — listTabs (returns sheets[].properties.title)
 *   sheets.spreadsheets.values.get — pullSheet (returns values[][])
 *   drive.files.get                — driveFileMetadata + driveFileBytes
 */

const DRIVE_ID_RE = /[-\w]{25,}/;

function extractDriveFileId(urlOrId: string): string | null {
  // Accepts a bare fileId, /file/d/<id>/, /d/<id>/, /open?id=<id>, /uc?id=<id>.
  const trimmed = urlOrId.trim();
  if (!trimmed) return null;
  if (!trimmed.includes('/') && !trimmed.includes('?')) {
    return DRIVE_ID_RE.test(trimmed) ? trimmed : null;
  }
  const dMatch = /\/(?:file\/)?d\/([-\w]{25,})/.exec(trimmed);
  if (dMatch) return dMatch[1] ?? null;
  const idMatch = /[?&]id=([-\w]{25,})/.exec(trimmed);
  if (idMatch) return idMatch[1] ?? null;
  return null;
}

function quoteSheetName(tab: string): string {
  return tab.includes("'") || /[!: ]/.test(tab) ? `'${tab.replace(/'/g, "''")}'` : tab;
}

function formatSheetRange(tab: string, a1Range?: string): string {
  const sheet = quoteSheetName(tab);
  return a1Range === undefined ? sheet : `${sheet}!${a1Range}`;
}

function firstRowIndex(a1Range?: string): number {
  if (a1Range === undefined) return 1;
  const match = /[A-Z]+(\d+)/i.exec(a1Range);
  return match ? Number.parseInt(match[1]!, 10) : 1;
}

export class GwsSubprocess implements GwsWrapper {
  constructor(private readonly options: SpawnOptions = {}) {}

  async listFolderSpreadsheets(folderId: string): Promise<FolderSpreadsheet[]> {
    const params = JSON.stringify({
      q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
      fields: 'files(id,name)',
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const stdout = await runGws(
      ['drive', 'files', 'list', '--params', params],
      this.options,
    );
    const parsed = parseJson<{ files?: Array<{ id?: string; name?: string }> }>(
      stdout,
      `listFolderSpreadsheets(${folderId})`,
    );
    return (parsed.files ?? [])
      .filter((f): f is { id: string; name: string } =>
        typeof f.id === 'string' && f.id.length > 0 &&
        typeof f.name === 'string' && f.name.length > 0,
      )
      .map((f) => ({ id: f.id, name: f.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listTabs(spreadsheetId: string): Promise<string[]> {
    const params = JSON.stringify({
      spreadsheetId,
      fields: 'sheets.properties.title',
    });
    const stdout = await runGws(
      ['sheets', 'spreadsheets', 'get', '--params', params],
      this.options,
    );
    const parsed = parseJson<{ sheets?: Array<{ properties?: { title?: string } }> }>(
      stdout,
      `listTabs(${spreadsheetId})`,
    );
    if (!parsed.sheets) {
      throw new GwsError(`gws sheets.spreadsheets.get returned no 'sheets' for ${spreadsheetId}`);
    }
    return parsed.sheets
      .map((s) => s.properties?.title)
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
  }

  async pullSheet(spreadsheetId: string, tab: string): Promise<RawRow[]> {
    return this.pullSheetInternal(spreadsheetId, tab);
  }

  async pullSheetRange(
    spreadsheetId: string,
    tab: string,
    a1Range: string,
    options?: PullSheetOptions,
  ): Promise<RawRow[]> {
    return this.pullSheetInternal(spreadsheetId, tab, a1Range, options);
  }

  async pullSheetHeaders(spreadsheetId: string, tabs: string[]): Promise<Map<string, RawRow[]>> {
    if (tabs.length === 0) return new Map();
    const params = JSON.stringify({
      spreadsheetId,
      ranges: tabs.map((tab) => formatSheetRange(tab, 'A1:O1')),
      valueRenderOption: 'FORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    const stdout = await runGws(
      ['sheets', 'spreadsheets', 'values', 'batchGet', '--params', params],
      this.options,
    );
    const parsed = parseJson<{ valueRanges?: Array<{ values?: unknown[][] }> }>(
      stdout,
      `pullSheetHeaders(${spreadsheetId})`,
    );
    const result = new Map<string, RawRow[]>();
    for (let i = 0; i < tabs.length; i += 1) {
      const values = parsed.valueRanges?.[i]?.values ?? [];
      result.set(tabs[i]!, values.map((cells, idx) => ({
        row_index: idx + 1,
        cells: (Array.isArray(cells) ? cells : []).map((c) =>
          typeof c === 'string' ? c : String(c ?? ''),
        ),
      })));
    }
    return result;
  }

  private async pullSheetInternal(
    spreadsheetId: string,
    tab: string,
    a1Range?: string,
    options: PullSheetOptions = {},
  ): Promise<RawRow[]> {
    const range = formatSheetRange(tab, a1Range);
    const params = JSON.stringify({
      spreadsheetId,
      range,
      // Defaults to operator-facing strings. Report ingestion explicitly
      // requests UNFORMATTED_VALUE for money cells to retain source precision.
      valueRenderOption: options.valueRenderOption ?? 'FORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    const stdout = await runGws(
      ['sheets', 'spreadsheets', 'values', 'get', '--params', params],
      this.options,
    );
    const parsed = parseJson<{ values?: unknown[][] }>(
      stdout,
      `pullSheet(${spreadsheetId}, ${tab})`,
    );
    const values = parsed.values ?? [];
    const rowOffset = firstRowIndex(a1Range);
    return values.map((cells, idx) => ({
      row_index: rowOffset + idx,
      cells: (Array.isArray(cells) ? cells : []).map((c) =>
        typeof c === 'string' ? c : String(c ?? ''),
      ),
    }));
  }

  async driveFileBytes(url: string): Promise<Buffer> {
    const fileId = extractDriveFileId(url);
    if (fileId === null) {
      throw new GwsNotFoundError(`gws driveFileBytes: not a Drive URL (no fileId): ${url}`);
    }
    // alt=media tells the Drive API to return the file bytes (not metadata).
    // Errors propagate as GwsAuthError / GwsNotFoundError per runGws's
    // stderr classifier so the artifact handler can map → 502/404.
    const params = JSON.stringify({ fileId, alt: 'media' });
    return runGwsBytes(
      ['drive', 'files', 'get', '--params', params],
      this.options,
    );
  }

  async driveFileMetadata(url: string): Promise<DriveFileMetadata | null> {
    if (!/drive\.google\.com|docs\.google\.com/.test(url)) return null;
    const fileId = extractDriveFileId(url);
    if (fileId === null) return null;
    const params = JSON.stringify({
      fileId,
      fields: 'id,name,mimeType,createdTime,modifiedTime',
    });
    const stdout = await runGws(
      ['drive', 'files', 'get', '--params', params],
      this.options,
    );
    const parsed = parseJson<{
      id: string;
      name: string;
      mimeType: string;
      createdTime?: string | null;
      modifiedTime?: string | null;
    }>(stdout, `driveFileMetadata(${url})`);
    return {
      id: parsed.id,
      name: parsed.name,
      mime_type: parsed.mimeType,
      created_time: parsed.createdTime ?? null,
      modified_time: parsed.modifiedTime ?? null,
    };
  }
}
