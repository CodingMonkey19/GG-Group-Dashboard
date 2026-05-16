/**
 * Writes the production folder-source config.
 *
 * This intentionally does not contain any original spreadsheet IDs. The dashboard
 * discovers copied order workbooks dynamically from the Drive folder at refresh time.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const config = {
  schema_version: 1,
  folder_source: {
    drive_folder_id: '1xKJmpTDMVKLGLLnGBsOjHdEMHxiDsdTl',
    copy_name_suffix: ' (Invoice Audit 2026-05-12)',
    excluded_order_codes: ['GG Group Status', 'Central LT'],
    standard_column_mapping: {
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
    },
  },
};

const outPath = resolve(import.meta.dirname, '../../config/sheets.json');
writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`wrote folder-source config to ${outPath}`);
