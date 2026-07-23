import { afterEach, describe, expect, it } from 'vitest';
import { normalizeRow } from '../../../src/pipeline/normalize/index.js';
import type { AdapterRow } from '../../../src/pipeline/ingest/sheet-adapter.js';
import { FixtureGws } from '../../fixtures/gws/FixtureGws.js';
import { openTestDb } from '../../helpers/db.js';

function reportRow(invoice_url: string): AdapterRow {
  return {
    spreadsheet_id: 'REPORT_2026', order_code: 'ORDER-A', tab_name: 'Clean Data',
    tab_name_raw: 'Clean Data', row_index: 2, source_row_key: '0000000000000001',
    status: 'Done', website: 'example.com', price: '100', currency: 'EUR',
    invoice_date: '2026-01-15', invoice_url, invoice_status: 'Paid', savings_eur: 10.005,
    source_mode: 'report', data_quality_issue: undefined, link_builder: undefined,
    target_url: undefined, anchor: undefined, live_url: undefined,
  };
}

describe('normalizeRow — report artifacts', () => {
  const db = openTestDb();
  afterEach(() => db.exec('DELETE FROM ecb_rates'));

  it('preserves PDF/Drive artifact routing but never extracts or reads report artifacts', async () => {
    const gws = new FixtureGws();
    let metadataCalls = 0;
    let bytesCalls = 0;
    gws.driveFileMetadata = async () => {
      metadataCalls += 1;
      throw new Error('report normalization must not read Drive metadata');
    };
    gws.driveFileBytes = async () => {
      bytesCalls += 1;
      throw new Error('report normalization must not read Drive bytes');
    };

    const [pdf, drive] = await Promise.all([
      normalizeRow(reportRow('missing-report.pdf'), { gws, db, pdfRoot: '/tmp/never-used' }),
      normalizeRow(reportRow('https://drive.google.com/file/d/report-pdf/view'), { gws, db, pdfRoot: '/tmp/never-used' }),
    ]);

    expect(pdf).toMatchObject({
      invoice_type: 'pdf', artifact_ref: 'missing-report.pdf', artifact_status: 'not_attempted',
      artifact_unreachable_reason: null, invoice_date: '2026-01-15', date_source: 'sheet',
    });
    expect(drive).toMatchObject({
      invoice_type: 'drive_pdf', artifact_ref: 'https://drive.google.com/file/d/report-pdf/view',
      artifact_status: 'not_attempted', artifact_unreachable_reason: null,
    });
    expect(metadataCalls).toBe(0);
    expect(bytesCalls).toBe(0);
  });
});
