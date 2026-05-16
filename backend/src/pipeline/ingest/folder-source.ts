import type { SheetEntry, SheetsConfig } from '../../shared/contracts.js';
import type { GwsWrapper, RawRow } from './gws.js';

export interface PreparedTab {
  tabRaw: string;
  rows?: RawRow[];
}

export interface PreparedSource {
  sheet: SheetEntry;
  tabs: PreparedTab[];
  failure?: string;
}

const DEFAULT_COPY_NAME_SUFFIX = ' (Invoice Audit 2026-05-12)';
const DEFAULT_FOLDER_SOURCE_CONCURRENCY = 2;
const DEFAULT_FOLDER_SOURCE_MIN_INTERVAL_MS = 1050;
const DEFAULT_HEADER_BATCH_MAX_TABS = 10;

type GwsTaskRunner = <T>(task: () => Promise<T>) => Promise<T>;

export function stripCopySuffix(name: string, suffix = DEFAULT_COPY_NAME_SUFFIX): string {
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

export function hasStandardOrderHeader(cells: readonly string[]): boolean {
  const at = (idx: number) => (cells[idx] ?? '').trim().toLowerCase();
  return at(0) === 'status' &&
    at(6) === 'price' &&
    at(11) === 'live url' &&
    at(12) === 'invoice date' &&
    at(13) === 'invoice' &&
    at(14) === 'invoice status';
}

export async function prepareIngestSources(
  config: SheetsConfig,
  gws: GwsWrapper,
): Promise<PreparedSource[]> {
  if (config.folder_source === undefined) {
    return config.sheets.map((sheet) => ({
      sheet,
      tabs: sheet.tabs.map((tabRaw) => ({ tabRaw })),
    }));
  }

  const folder = config.folder_source;
  const excluded = new Set((folder.excluded_order_codes ?? []).map((s) => s.trim()));
  const suffix = folder.copy_name_suffix ?? DEFAULT_COPY_NAME_SUFFIX;
  const runGws = createLimiter(folderSourceConcurrency());
  const headerBatchCache = createHeaderBatchCache();
  const files = await runGws(() => gws.listFolderSpreadsheets(folder.drive_folder_id));
  const sources = await Promise.all(files.map(async (file) => {
    const orderCode = stripCopySuffix(file.name, suffix).trim();
    if (excluded.has(orderCode)) return null;

    const sheet: SheetEntry = {
      spreadsheet_id: file.id,
      order_code: orderCode,
      tabs: [],
      column_mapping: folder.standard_column_mapping,
    };
    const source: PreparedSource = { sheet, tabs: [] };

    try {
      const tabs = await runGws(() => gws.listTabs(file.id));
      const preparedTabs = await Promise.all(tabs.map(async (tabRaw) => {
        if (tabRaw === 'Audit Log') return null;
        const headerRows = await pullHeader(gws, runGws, headerBatchCache, file.id, tabRaw, tabs);
        const header = headerRows[0]?.cells ?? [];
        if (!hasStandardOrderHeader(header)) return null;
        const rawRows = gws.pullSheetRange === undefined
          ? headerRows
          : await runGws(() => gws.pullSheet(file.id, tabRaw));
        return { tabRaw, rows: rawRows.slice(1) } satisfies PreparedTab;
      }));
      source.tabs = preparedTabs.filter((tab): tab is { tabRaw: string; rows: RawRow[] } =>
        tab !== null,
      );
      sheet.tabs = source.tabs.map((tab) => tab.tabRaw);
    } catch (err) {
      source.failure = err instanceof Error ? err.message : String(err);
      source.tabs = [];
      sheet.tabs = [];
    }

    return source;
  }));

  return sources.filter((source): source is PreparedSource => source !== null);
}

async function pullHeader(
  gws: GwsWrapper,
  runGws: GwsTaskRunner,
  headerBatchCache: HeaderBatchCache,
  spreadsheetId: string,
  tabRaw: string,
  allTabs: string[],
): Promise<RawRow[]> {
  if (gws.pullSheetHeaders !== undefined && allTabs.length <= headerBatchMaxTabs()) {
    const headers = await headerBatchCache.get(spreadsheetId, () =>
      runGws(() => gws.pullSheetHeaders!(spreadsheetId, allTabs)),
    );
    return headers.get(tabRaw) ?? [];
  }
  return gws.pullSheetRange === undefined
    ? runGws(() => gws.pullSheet(spreadsheetId, tabRaw))
    : runGws(() => gws.pullSheetRange!(spreadsheetId, tabRaw, 'A1:O1'));
}

function headerBatchMaxTabs(): number {
  const parsed = Number.parseInt(
    process.env.FOLDER_SOURCE_HEADER_BATCH_MAX_TABS ?? String(DEFAULT_HEADER_BATCH_MAX_TABS),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEADER_BATCH_MAX_TABS;
}

function folderSourceConcurrency(): number {
  const parsed = Number.parseInt(
    process.env.FOLDER_SOURCE_CONCURRENCY ?? String(DEFAULT_FOLDER_SOURCE_CONCURRENCY),
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FOLDER_SOURCE_CONCURRENCY;
}

function createLimiter(limit: number): GwsTaskRunner {
  let active = 0;
  let nextStartAt = 0;
  const queue: Array<() => void> = [];
  const minIntervalMs = folderSourceMinIntervalMs();

  return async function runLimited<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      const now = Date.now();
      const waitMs = Math.max(0, nextStartAt - now);
      nextStartAt = Math.max(now, nextStartAt) + minIntervalMs;
      if (waitMs > 0) await sleep(waitMs);
      return await task();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

function folderSourceMinIntervalMs(): number {
  const parsed = Number.parseInt(
    process.env.FOLDER_SOURCE_MIN_INTERVAL_MS ?? String(DEFAULT_FOLDER_SOURCE_MIN_INTERVAL_MS),
    10,
  );
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_FOLDER_SOURCE_MIN_INTERVAL_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface HeaderBatchCache {
  get(
    spreadsheetId: string,
    load: () => Promise<Map<string, RawRow[]>>,
  ): Promise<Map<string, RawRow[]>>;
}

function createHeaderBatchCache(): HeaderBatchCache {
  const cache = new Map<string, Promise<Map<string, RawRow[]>>>();
  return {
    get(spreadsheetId, load) {
      let promise = cache.get(spreadsheetId);
      if (promise === undefined) {
        promise = load();
        cache.set(spreadsheetId, promise);
      }
      return promise;
    },
  };
}
