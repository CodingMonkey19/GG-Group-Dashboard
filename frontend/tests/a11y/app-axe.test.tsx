/**
 * T097 — axe-core accessibility smoke.
 *
 * Renders the App shell in jsdom with a synthesized ApiDataResponse,
 * then asks axe-core to scan the resulting DOM for WCAG 2.1 AA
 * violations. The test fails LOUDLY on any violation so a future PR
 * that, say, drops a label off the MonthSelector or removes the
 * aria-modal on ProvenanceDrawer can't merge silently.
 *
 * Why only axe and not full Lighthouse: axe is fast (sub-second per
 * page), self-contained, and catches every WCAG rule that's
 * mechanically checkable on a static DOM. The rules it CAN'T check
 * (color contrast on dynamic backgrounds, focus visibility under user
 * styling, screen-reader reading order beyond mechanical structure)
 * are covered by the manual T101 quickstart walk in Phase 9.
 *
 * Scope: the two top-level views (Spend, Websites). The Audit view was
 * removed from the dashboard — data-quality is a developer-side concern,
 * not on the CEO surface. The Provenance drawer opens as a child of the
 * Spend / Websites views and is exercised inline.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { App } from '../../src/App';
import type { ApiDataResponse } from '../../src/lib/contracts';

function syntheticEnvelope(): ApiDataResponse {
  return {
    schema_version: 2,
    reporting_year: 2026,
    last_refreshed_at: '2026-05-12T10:00:00Z',
    refresh_status: 'success',
    duration_ms: 1234,
    per_source: [
      { spreadsheet_id: 'CGLT', order_code: 'CGLT', status: 'success', rows_pulled: 3 },
    ],
    counters: {
      rows_total: 3,
      rows_done: 3,
      rows_excluded_by_status: 0,
      rows_undated: 0,
      rows_out_of_ecb_currency: 0,
      duplicate_invoice_groups: 0,
    },
    excluded_order_codes: [],
    invoices: [
      {
        source_row_key: '0000000000000001',
        invoice_id: 'INV-1',
        order_code: 'CGLT',
        spreadsheet_id: 'CGLT',
        tab_name: 'April 2026',
        tab_name_raw: 'April 2026',
        row_index: 2,
        work_status: 'Done',
        is_done: true,
        payment_status: 'paid',
        invoice_type: 'pdf',
        artifact_ref: 'inv.pdf',
        artifact_status: 'reachable',
        website: 'site-a.com',
        website_raw: 'site-a.com',
        native_amount: 100,
        native_currency: 'EUR',
        eur_amount: 100,
        savings_eur: 10,
        ecb_rate: 1,
        ecb_rate_as_of: '2026-04-01',
        conversion_status: 'converted',
        invoice_date: '2026-04-01',
        invoice_month: '2026-04',
        date_source: 'sheet',
        audit_flags: [],
      },
      {
        source_row_key: '0000000000000002',
        invoice_id: 'INV-2',
        order_code: 'CGLT',
        spreadsheet_id: 'CGLT',
        tab_name: 'April 2026',
        tab_name_raw: 'April 2026',
        row_index: 3,
        work_status: 'Done',
        is_done: true,
        payment_status: 'unpaid',
        invoice_type: 'paypal',
        artifact_ref: 'https://www.paypal.com/invoice/p/#INV2',
        artifact_status: 'not_attempted',
        website: 'site-b.com',
        website_raw: 'site-b.com',
        native_amount: 200,
        native_currency: 'EUR',
        eur_amount: 200,
        savings_eur: 20,
        ecb_rate: 1,
        ecb_rate_as_of: '2026-04-01',
        conversion_status: 'converted',
        invoice_date: '2026-04-10',
        invoice_month: '2026-04',
        date_source: 'sheet',
        audit_flags: [],
      },
      {
        source_row_key: '0000000000000003',
        invoice_id: null,
        order_code: 'LGLT',
        spreadsheet_id: 'LGLT',
        tab_name: 'April 2026',
        tab_name_raw: 'April 2026',
        row_index: 2,
        work_status: 'Done',
        is_done: true,
        payment_status: 'paid',
        invoice_type: 'pdf',
        artifact_ref: 'inv2.pdf',
        artifact_status: 'reachable',
        website: 'site-c.com',
        website_raw: 'site-c.com',
        native_amount: 50,
        native_currency: 'EUR',
        eur_amount: 50,
        savings_eur: 5,
        ecb_rate: 1,
        ecb_rate_as_of: '2026-04-15',
        conversion_status: 'converted',
        invoice_date: '2026-04-15',
        invoice_month: '2026-04',
        date_source: 'sheet',
        audit_flags: [],
      },
    ],
    audit_findings_by_category: {
      non_done_row: [],
      missing_price: [],
      unparseable_amount: [],
      missing_currency: [],
      missing_invoice_url: [],
      missing_date: [],
      unknown_payment_status: [],
      missing_payment_status: [],
      duplicate_invoice_id: [],
      out_of_ecb_currency: [],
      future_dated_invoice: [],
      artifact_unreachable: [],
      pdf_extraction_failed: [],
      paypal_verification_mismatch: [],
    },
  };
}

async function scan(): Promise<axe.Result[]> {
  // Run axe with WCAG 2.1 AA tags. Returns the array of violations.
  const result = await axe.run(document.body, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
  });
  return result.violations;
}

function summarize(violations: axe.Result[]): string {
  return violations
    .map(
      (v) =>
        `[${v.impact}] ${v.id}: ${v.help} — ${v.nodes.length} node(s)\n` +
        v.nodes.map((n) => `    ${n.html.slice(0, 200)}`).join('\n'),
    )
    .join('\n\n');
}

describe('T097 — axe-core WCAG 2.1 AA scan', () => {
  beforeEach(() => {
    // Stub fetch so the App's load() resolves to our synthetic snapshot.
    const env = syntheticEnvelope();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(env), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    cleanup();
  });

  it('Spend view (default mount) has no WCAG 2.1 AA violations', async () => {
    render(<App />);
    // Wait for fetchData to settle.
    await waitFor(() => {
      expect(document.body.textContent).not.toContain('Loading…');
    });
    const violations = await scan();
    if (violations.length > 0) {
      // eslint-disable-next-line no-console
      console.error('\nA11y violations (Spend):\n', summarize(violations));
    }
    expect(violations).toEqual([]);
  });

  it('Live URLs view has no WCAG 2.1 AA violations', async () => {
    render(<App />);
    await waitFor(() => {
      expect(document.body.textContent).not.toContain('Loading…');
    });
    fireEvent.click(screen.getByRole('tab', { name: /live urls/i }));
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/Per-link pricing|No live URLs/);
    });
    const violations = await scan();
    if (violations.length > 0) {
      // eslint-disable-next-line no-console
      console.error('\nA11y violations (Live URLs):\n', summarize(violations));
    }
    expect(violations).toEqual([]);
  });

  it('Audit tab is not exposed in the navigation (removed per operator)', async () => {
    render(<App />);
    await waitFor(() => {
      expect(document.body.textContent).not.toContain('Loading…');
    });
    // The only top-level tabs should be Spend and Live URLs (was "Websites"
    // before the operator-requested rename).
    const tabs = screen.getAllByRole('tab').map((el) => el.textContent ?? '');
    expect(tabs.some((t) => /audit/i.test(t))).toBe(false);
    expect(tabs.some((t) => /spend/i.test(t))).toBe(true);
    expect(tabs.some((t) => /live urls/i.test(t))).toBe(true);
  });
});
