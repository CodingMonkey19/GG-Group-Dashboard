/**
 * T084 unit test — artifactUrl helper routes per invoice_type per contracts/api-artifact.md.
 */

import { describe, it, expect } from 'vitest';
import { artifactUrl } from '../../src/lib/artifacts';
import type { InvoiceRow } from '../../src/lib/contracts';

function row(partial: Partial<InvoiceRow> & { invoice_type: InvoiceRow['invoice_type'] }): InvoiceRow {
  return {
    source_row_key: 'aaaaaaaaaaaaaaaa',
    invoice_id: null,
    order_code: 'CGLT',
    spreadsheet_id: 's',
    tab_name: 't',
    tab_name_raw: 't',
    row_index: 1,
    work_status: 'Done',
    is_done: true,
    payment_status: 'paid',
    artifact_ref: null,
    artifact_status: 'reachable',
    website: 'a.com',
    website_raw: 'a.com',
    native_amount: 100,
    native_currency: 'EUR',
    eur_amount: 100,
    ecb_rate: 1,
    ecb_rate_as_of: '2026-04-01',
    conversion_status: 'converted',
    invoice_date: '2026-04-01',
    invoice_month: '2026-04',
    date_source: 'sheet',
    audit_flags: [],
    ...partial,
  };
}

describe('artifactUrl (T084) — routes per invoice_type per contracts/api-artifact.md', () => {
  it('pdf → /api/artifact/<source_row_key> (backend proxy, stable key)', () => {
    expect(
      artifactUrl(row({ invoice_type: 'pdf', source_row_key: 'deadbeefdeadbeef' })),
    ).toBe('/api/artifact/deadbeefdeadbeef');
  });

  it('drive_pdf → /api/artifact/<source_row_key> (backend proxy)', () => {
    expect(
      artifactUrl(row({ invoice_type: 'drive_pdf', source_row_key: 'cafef00dcafef00d' })),
    ).toBe('/api/artifact/cafef00dcafef00d');
  });

  it('paypal → row.artifact_ref (direct public URL, no proxy)', () => {
    expect(
      artifactUrl(
        row({
          invoice_type: 'paypal',
          artifact_ref: 'https://www.paypal.com/invoice/p/#PAYINV-1',
        }),
      ),
    ).toBe('https://www.paypal.com/invoice/p/#PAYINV-1');
  });

  it('intuit → row.artifact_ref (direct public URL)', () => {
    expect(
      artifactUrl(row({ invoice_type: 'intuit', artifact_ref: 'https://intuit.example/i/1' })),
    ).toBe('https://intuit.example/i/1');
  });

  it('text → null (text content rendered inline, not via opener)', () => {
    expect(artifactUrl(row({ invoice_type: 'text', artifact_ref: 'paid in cash' }))).toBeNull();
  });

  it('missing → null (drill-down renders a no-artifact hint, not a link)', () => {
    expect(artifactUrl(row({ invoice_type: 'missing', artifact_ref: null }))).toBeNull();
  });

  it('paypal with null artifact_ref → null (defensive: never construct a click target on no URL)', () => {
    // The contract says paypal/intuit always have a URL, but if upstream data
    // is malformed we surface null rather than a broken click.
    expect(artifactUrl(row({ invoice_type: 'paypal', artifact_ref: null }))).toBeNull();
  });

  /* --------------------------------------------------------------------- */
  /* QA finding C1/C2 — XSS via javascript: scheme. The helper MUST refuse */
  /* any non-http(s) external URL so the drawer never renders an exploitable */
  /* <a href="javascript:...">. Operator-owned spreadsheet cells are the   */
  /* untrusted boundary even on a LAN-only deployment.                     */
  /* --------------------------------------------------------------------- */

  it('paypal with javascript: scheme → null (XSS defense)', () => {
    expect(
      artifactUrl(
        row({
          invoice_type: 'paypal',
          artifact_ref: "javascript:fetch('/api/refresh',{method:'POST'})",
        }),
      ),
    ).toBeNull();
  });

  it('intuit with javascript: scheme → null (XSS defense)', () => {
    expect(
      artifactUrl(
        row({ invoice_type: 'intuit', artifact_ref: 'javascript:alert(1)' }),
      ),
    ).toBeNull();
  });

  it('intuit with javascript: URL whose host matches the intuit domain → null', () => {
    // The pre-fix exploit shape: classifyInvoiceType matches the URL by
    // host substring, so a "javascript://intuit.com/..." crafted string
    // could classify as intuit. The scheme check rejects it regardless.
    expect(
      artifactUrl(row({ invoice_type: 'intuit', artifact_ref: 'javascript://intuit.com/x' })),
    ).toBeNull();
  });

  it('paypal with data: scheme → null (XSS defense; same family as javascript:)', () => {
    expect(
      artifactUrl(
        row({
          invoice_type: 'paypal',
          artifact_ref: 'data:text/html,<script>alert(1)</script>',
        }),
      ),
    ).toBeNull();
  });

  it('paypal with vbscript: scheme → null (legacy IE attack vector)', () => {
    expect(
      artifactUrl(row({ invoice_type: 'paypal', artifact_ref: 'vbscript:msgbox(1)' })),
    ).toBeNull();
  });

  it('paypal with file: scheme → null (local-file disclosure)', () => {
    expect(
      artifactUrl(row({ invoice_type: 'paypal', artifact_ref: 'file:///etc/passwd' })),
    ).toBeNull();
  });

  it('paypal with malformed URL → null', () => {
    expect(
      artifactUrl(row({ invoice_type: 'paypal', artifact_ref: 'not a url at all' })),
    ).toBeNull();
  });

  it('paypal with empty / whitespace-only artifact_ref → null', () => {
    expect(artifactUrl(row({ invoice_type: 'paypal', artifact_ref: '' }))).toBeNull();
    expect(artifactUrl(row({ invoice_type: 'paypal', artifact_ref: '   ' }))).toBeNull();
  });

  it('intuit with plain http:// URL → passes through (not all operators run TLS)', () => {
    expect(
      artifactUrl(row({ invoice_type: 'intuit', artifact_ref: 'http://intuit.example/i/1' })),
    ).toBe('http://intuit.example/i/1');
  });

  it('pdf / drive_pdf proxy URL is unaffected (always same-origin /api/artifact/<key>)', () => {
    // Sanity: even if a sheet sets artifact_ref to javascript:..., pdf rows
    // route to the backend proxy by source_row_key, not the cell value.
    expect(
      artifactUrl(
        row({
          invoice_type: 'pdf',
          artifact_ref: 'javascript:alert(1)',
          source_row_key: 'deadbeefdeadbeef',
        }),
      ),
    ).toBe('/api/artifact/deadbeefdeadbeef');
  });
});
