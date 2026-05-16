/**
 * GwsWrapper interface — the SOLE adapter between the pipeline and the
 * Google Workspace CLI (`gws`).
 *
 * Constitution Principle III: "All sheet ingestion MUST flow through the GWS
 * CLI authenticated as faredwrites@gmail.com." No other module imports a
 * Google library directly. There is no `googleapis` dependency in v1
 * (research.md Decision 2 + Codex review #4 from branch bjk1d7p3j).
 *
 * Drive PDF metadata is also routed through this wrapper (`driveFileMetadata`)
 * so the dashboard owns zero Google credentials and there is exactly one
 * Google trust path.
 *
 * The pipeline depends on the interface, not the implementation. Tests use
 * `FixtureGws` (reads pre-recorded JSON from disk) so they stay
 * offline-deterministic. The real `gws-subprocess.ts` is exercised only by
 * a smoke test gated behind `GG_LIVE_GWS=1`.
 */

export interface RawRow {
  /** 1-based row number in the source tab — matches what the user sees in Sheets. */
  row_index: number;
  /** Indexed by column 0..N — column letter A → cells[0]. */
  cells: string[];
}

export interface DriveFileMetadata {
  id: string;
  name: string;
  mime_type: string;
  /** ISO-8601 UTC, or null if not present. */
  created_time: string | null;
  /** ISO-8601 UTC, or null if not present. */
  modified_time: string | null;
}

export interface FolderSpreadsheet {
  id: string;
  name: string;
}

export interface GwsWrapper {
  /**
   * List spreadsheet files directly inside a Drive folder.
   * Used by the live dashboard source mode so refreshes discover copied
   * workbooks from the audit folder instead of trusting a static sheet list.
   */
  listFolderSpreadsheets(folderId: string): Promise<FolderSpreadsheet[]>;

  /**
   * List every tab name in a spreadsheet.
   * Used by the operator workflow to validate config/sheets.json `tabs`
   * against the actual tabs on the sheet.
   */
  listTabs(spreadsheetId: string): Promise<string[]>;

  /**
   * Pull every row of one tab as a 2D array of cell values.
   * Empty trailing rows are stripped; empty leading/middle rows are preserved
   * with empty cells[] so that row_index always equals the actual sheet row
   * number — provenance per Principle II.
   */
  pullSheet(spreadsheetId: string, tab: string): Promise<RawRow[]>;

  /**
   * Optional efficient range read for callers that only need part of a tab.
   * `a1Range` is relative to the tab, e.g. "A1:O1".
   */
  pullSheetRange?(spreadsheetId: string, tab: string, a1Range: string): Promise<RawRow[]>;

  /**
   * Optional efficient batch header read. Returns tab name → A1:O1 rows.
   * Used by dynamic folder discovery to avoid one API request per tab.
   */
  pullSheetHeaders?(spreadsheetId: string, tabs: string[]): Promise<Map<string, RawRow[]>>;

  /**
   * Optional: fetch metadata for a Drive file by URL.
   * Used by extract/drive-pdf.ts for the date-resolution fallback.
   * Returns null if the URL is not a Drive URL.
   */
  driveFileMetadata(url: string): Promise<DriveFileMetadata | null>;

  /**
   * Fetch the raw bytes of a Drive file by URL or fileId.
   * Used by GET /api/artifact/:source_row_key (T082) to proxy `drive_pdf`
   * artifacts to the CEO's browser without requiring a re-auth.
   *
   * Returns the bytes as a Buffer. Throws GwsNotFoundError when the file
   * is missing, GwsAuthError when the wrapper's session has expired, and
   * GwsError for any other upstream failure.
   *
   * v1 returns Buffer (small invoice PDFs). If artifact sizes ever exceed
   * tens of MB, refactor to a streaming Readable.
   */
  driveFileBytes(url: string): Promise<Buffer>;
}

/* ----------------------------------------------------------------------- */
/* Typed errors so the pipeline can decide retry vs flag-as-failure.        */
/* ----------------------------------------------------------------------- */

export class GwsError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GwsError';
  }
}

export class GwsAuthError extends GwsError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'GwsAuthError';
  }
}

export class GwsNotFoundError extends GwsError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'GwsNotFoundError';
  }
}
