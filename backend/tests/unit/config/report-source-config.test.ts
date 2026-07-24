import { describe, expect, it } from 'vitest';
import {
  REPORTING_YEAR,
  ReportSourceConfig,
  SheetsConfig,
} from '../../../src/shared/contracts.js';

const REPORT_CONFIG = {
  schema_version: 1,
  report_source: {
    spreadsheet_id: 'REPORT_2026',
    data_tab: 'Clean Data',
    monthly_summary_tab: 'Monthly Spending',
    order_summary_tab: 'Order Summary',
    reporting_year: 2026,
    headers: {
      order: 'Order',
      source_tab: 'Source Tab',
      source_row: 'Source Row',
      invoice_date: 'Invoice Date',
      reporting_month: 'Month',
      link_builder: 'Link Builder',
      website: 'Website',
      spend_eur: 'Price (EUR)',
      invoice_url: 'Invoice',
      live_url: 'Live URL',
      invoice_status: 'Invoice Status',
      included: 'Included in Reporting Period',
      data_quality_issue: 'Data Quality Issue',
      savings_eur: 'Saving (EUR)',
    },
  },
};

const FOLDER_SOURCE = {
  drive_folder_id: 'FOLDER',
  standard_column_mapping: {
    status: 'A',
    price: 'G',
  },
};

const STATIC_SHEET = {
  spreadsheet_id: 'STATIC',
  order_code: 'ORDER-A',
  tabs: ['January'],
  column_mapping: {
    status: 'A',
    price: 'G',
  },
};

function cloneReportConfig(): typeof REPORT_CONFIG {
  return structuredClone(REPORT_CONFIG);
}

describe('report-source configuration contract', () => {
  it('parses a valid 2026 report source', () => {
    const parsed = SheetsConfig.safeParse(REPORT_CONFIG);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.report_source?.reporting_year).toBe(REPORTING_YEAR);
    }
  });

  it('allows only the 2026 reporting year', () => {
    const valid = cloneReportConfig().report_source;
    expect(ReportSourceConfig.safeParse(valid).success).toBe(true);

    expect(ReportSourceConfig.safeParse({ ...valid, reporting_year: 2025 }).success).toBe(false);
  });

  it('requires every Clean Data header mapping to be non-empty', () => {
    for (const header of Object.keys(REPORT_CONFIG.report_source.headers)) {
      const config = cloneReportConfig();
      delete (config.report_source.headers as Record<string, string>)[header];

      expect(ReportSourceConfig.safeParse(config.report_source).success).toBe(false);
    }
  });

  it('requires the Clean Data and reconciliation tab names', () => {
    for (const tabName of ['data_tab', 'monthly_summary_tab', 'order_summary_tab'] as const) {
      const config = cloneReportConfig();
      config.report_source[tabName] = '';

      expect(ReportSourceConfig.safeParse(config.report_source).success).toBe(false);
    }
  });

  it('rejects report source combined with folder source', () => {
    const config = {
      ...cloneReportConfig(),
      folder_source: FOLDER_SOURCE,
    };

    expect(SheetsConfig.safeParse(config).success).toBe(false);
  });

  it('rejects report source combined with non-empty static sheets', () => {
    const config = {
      ...cloneReportConfig(),
      sheets: [STATIC_SHEET],
    };

    expect(SheetsConfig.safeParse(config).success).toBe(false);
  });

  it('continues to parse static sheets and folder-source configurations', () => {
    expect(SheetsConfig.safeParse({ schema_version: 1, sheets: [STATIC_SHEET] }).success).toBe(true);
    expect(SheetsConfig.safeParse({ schema_version: 1, folder_source: FOLDER_SOURCE }).success).toBe(true);
  });
});
