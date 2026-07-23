import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runConsolidation } from '../../src/pipeline/consolidate.js';
import type { SheetsConfig } from '../../src/shared/contracts.js';
import { FixtureGws } from '../fixtures/gws/FixtureGws.js';
import { openTestDb } from '../helpers/db.js';

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

function writeSheet(root: string, id: string, tabs: Record<string, string[][]>): void {
  const dir = resolve(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, '__tabs.json'), JSON.stringify(Object.keys(tabs)));
  for (const [tab, rows] of Object.entries(tabs)) {
    writeFileSync(resolve(dir, `${tab}.json`), JSON.stringify({ rows }));
  }
}

describe('runConsolidation — dynamic folder source + hard row eligibility', () => {
  it('uses only copied-folder spreadsheets, standard tabs, and Done rows with parseable invoice dates', async () => {
    const fixturesRoot = mkdtempSync(resolve(tmpdir(), 'folder-ingest-'));
    const db = openTestDb();
    try {
      writeSheet(fixturesRoot, 'COPY_AG', {
        'April 2026': [
          HEADER,
          ['Done', 'Saras', 'valid.com', '', '', '', '100', '', '', '', '', 'https://live', '1/6/2026', 'https://www.paypal.com/invoice/p/#VALID', 'paid'],
          ['done', 'Saras', 'lowercase.com', '', '', '', '200', '', '', '', '', 'https://live', '1/6/2026', 'https://www.paypal.com/invoice/p/#LOWER', 'paid'],
          ['Done', 'Saras', 'missing-date.com', '', '', '', '300', '', '', '', '', 'https://live', '', 'https://www.paypal.com/invoice/p/#NODATE', 'paid'],
          ['In Progress', 'Saras', 'wip.com', '', '', '', '400', '', '', '', '', 'https://live', '1/6/2026', 'https://www.paypal.com/invoice/p/#WIP', 'paid'],
        ],
        Blocklist: [
          ['Status', 'Website', 'Price'],
          ['Done', 'blocked.com', '999'],
        ],
      });
      writeSheet(fixturesRoot, 'COPY_CENTRAL_LT', {
        'April 2026': [
          HEADER,
          ['Done', 'Saras', 'excluded.com', '', '', '', '999', '', '', '', '', 'https://live', '1/6/2026', 'https://www.paypal.com/invoice/p/#EXCLUDED', 'paid'],
        ],
      });

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

      const result = await runConsolidation({
        config,
        db,
        gws: new FixtureGws({
          fixturesRoot,
          folderSpreadsheets: new Map([
            ['FOLDER', [
              { id: 'COPY_AG', name: 'AG (Invoice Audit 2026-05-12)' },
              { id: 'COPY_CENTRAL_LT', name: 'Central LT (Invoice Audit 2026-05-12)' },
            ]],
          ]),
        }),
        pdfRoot: '/tmp/never-used',
      });

      expect(result.status).toBe('success');
      expect(result.per_source.map((s) => s.order_code)).toEqual(['AG']);
      expect(result.per_source[0]?.spreadsheet_id).toBe('COPY_AG');
      expect(result.per_source[0]?.rows_pulled).toBe(1);
      expect(result.counters.rows_total).toBe(1);
      expect(result.counters.rows_done).toBe(1);
      expect(result.counters.rows_excluded_by_status).toBe(0);
      expect(result.counters.rows_undated).toBe(0);

      const rows = db
        .prepare('SELECT order_code, spreadsheet_id, tab_name_raw, website, invoice_date FROM invoices')
        .all() as Array<{
        order_code: string;
        spreadsheet_id: string;
        tab_name_raw: string;
        website: string;
        invoice_date: string;
      }>;
      expect(rows).toEqual([
        {
          order_code: 'AG',
          spreadsheet_id: 'COPY_AG',
          tab_name_raw: 'April 2026',
          website: 'valid.com',
          invoice_date: '2026-06-01',
        },
      ]);

      const findings = db.prepare('SELECT category FROM audit_findings').all();
      expect(findings).toEqual([]);
    } finally {
      db.close();
      rmSync(fixturesRoot, { recursive: true, force: true });
    }
  });
});
