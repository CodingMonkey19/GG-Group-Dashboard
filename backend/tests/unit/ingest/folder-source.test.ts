import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hasStandardOrderHeader,
  prepareIngestSources,
  stripCopySuffix,
} from '../../../src/pipeline/ingest/folder-source.js';
import type { SheetsConfig } from '../../../src/shared/contracts.js';
import { FixtureGws } from '../../fixtures/gws/FixtureGws.js';

const STANDARD_MAPPING = {
  status: 'A',
  link_builder: 'B',
  website: 'C',
  price: 'G',
  target_url: 'I',
  anchor: 'J',
  live_url: 'L',
  invoice_date: 'M',
  invoice_url: 'N',
  invoice_status: 'O',
};

const HEADER = [
  'Status',
  'LB',
  'Website',
  'Niche',
  'DR',
  'Traffic',
  'Price ',
  'Country/Lang',
  'Target URL',
  'Anchor',
  'Content URL',
  'Live URL',
  'Invoice Date',
  'Invoice',
  'Invoice Status',
];

function writeSheet(root: string, id: string, tabs: Record<string, string[][]>): void {
  const dir = resolve(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, '__tabs.json'), JSON.stringify(Object.keys(tabs)));
  for (const [tab, rows] of Object.entries(tabs)) {
    writeFileSync(resolve(dir, `${tab}.json`), JSON.stringify({ rows }));
  }
}

describe('folder-source helpers', () => {
  it('strips the audit-copy suffix from copied sheet names', () => {
    expect(stripCopySuffix('CGLT (Invoice Audit 2026-05-12)')).toBe('CGLT');
    expect(stripCopySuffix('CGLT')).toBe('CGLT');
  });

  it('accepts only the standard order header shape', () => {
    expect(hasStandardOrderHeader(HEADER)).toBe(true);
    expect(hasStandardOrderHeader(['Status', '', '', '', '', '', 'Price'])).toBe(false);
  });
});

describe('prepareIngestSources — folder mode', () => {
  it('discovers copied spreadsheets, excludes configured names, and keeps only standard-header tabs', async () => {
    const fixturesRoot = mkdtempSync(resolve(tmpdir(), 'folder-source-'));
    try {
      writeSheet(fixturesRoot, 'COPY_CGLT', {
        Good: [
          HEADER,
          ['Done', 'Saras', 'example.com', '', '', '', '100', '', '', '', '', 'https://live', '1/6/2025', 'https://invoice', 'paid'],
        ],
        BadHeader: [
          ['Status', 'Website', 'Price'],
          ['Done', 'example.com', '100'],
        ],
        'Audit Log': [['Tab', 'Row']],
      });
      writeSheet(fixturesRoot, 'COPY_CENTRAL_LT', { Good: [HEADER] });

      const config: SheetsConfig = {
        schema_version: 1,
        sheets: [],
        folder_source: {
          drive_folder_id: 'FOLDER',
          copy_name_suffix: ' (Invoice Audit 2026-05-12)',
          excluded_order_codes: ['Central LT'],
          standard_column_mapping: STANDARD_MAPPING,
        },
      };
      const gws = new FixtureGws({
        fixturesRoot,
        folderSpreadsheets: new Map([
          ['FOLDER', [
            { id: 'COPY_CGLT', name: 'CGLT (Invoice Audit 2026-05-12)' },
            { id: 'COPY_CENTRAL_LT', name: 'Central LT (Invoice Audit 2026-05-12)' },
          ]],
        ]),
      });

      const sources = await prepareIngestSources(config, gws);

      expect(sources.map((s) => s.sheet.order_code)).toEqual(['CGLT']);
      expect(sources[0]?.sheet.spreadsheet_id).toBe('COPY_CGLT');
      expect(sources[0]?.sheet.tabs).toEqual(['Good']);
      expect(sources[0]?.tabs[0]?.rows?.map((r) => r.row_index)).toEqual([2]);
    } finally {
      rmSync(fixturesRoot, { recursive: true, force: true });
    }
  });
});
