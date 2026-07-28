/**
 * ProvenanceDrawer (T085) — drill-down panel for any clickable EUR figure.
 *
 * Per FR-015 + contracts/api-artifact.md, every contributing row is shown
 * with full provenance:
 *   • source_row_key (16-char hex; stable across refreshes)
 *   • sheet (spreadsheet_id), tab_name_raw, row_index
 *   • native amount + currency
 *   • EUR amount + ECB rate + rate_as_of
 *   • payment_status, invoice_type
 *   • conversion_status — so audit-only rows visibly display *why* eur_amount
 *     is null (NOT identical to converted rows)
 *   • artifact_status — so the operator sees whether the artifact was
 *     reachable during the last refresh
 *   • artifact link via artifactUrl() — type-routed:
 *       pdf/drive_pdf  → /api/artifact/<key> (backend proxy)
 *       paypal/intuit  → row.artifact_ref (direct public URL)
 *       text           → text rendered inline, no link
 *       missing        → no link, hint to Audit panel's missing_invoice_url
 *
 * UX: a slide-in side panel; close on Esc or backdrop click.
 */

import { useEffect } from 'react';
import type { InvoiceRow } from '../lib/contracts';
import { dayLabel } from '../lib/format';
import { artifactUrl } from '../lib/artifacts';
import { fmtEur, fmtEurDec, fmtNum } from '../lib/format';

interface Props {
  title: string;
  rows: InvoiceRow[];
  onClose: () => void;
}

export function ProvenanceDrawer({ title, rows, onClose }: Props): JSX.Element {
  // Esc closes.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [onClose]);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer__header">
          <h2 id="drawer-title" className="drawer__title">{title}</h2>
          <button
            type="button"
            className="drawer__close"
            onClick={onClose}
            aria-label="Close drawer"
          >
            ×
          </button>
        </header>
        <div className="drawer__meta">
          {fmtNum(rows.length)} {rows.length === 1 ? 'row' : 'rows'}
        </div>
        <div className="drawer__body">
          {rows.length === 0 ? (
            <p className="drawer__empty">No contributing rows.</p>
          ) : (
            <ul className="drawer__list">
              {rows.map((row) => (
                <ProvenanceRow key={row.source_row_key} row={row} />
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

function ProvenanceRow({ row }: { row: InvoiceRow }): JSX.Element {
  const link = artifactUrl(row);
  const isAuditOnly = row.conversion_status !== 'converted';
  return (
    <li className={`provenance-row ${isAuditOnly ? 'provenance-row--audit' : ''}`}>
      <div className="provenance-row__head">
        <span className="provenance-row__eur">
          {row.eur_amount !== null ? (
            fmtEurDec(row.eur_amount)
          ) : (
            <span
              className="provenance-row__eur--null"
              title={`No EUR amount: conversion_status=${row.conversion_status}`}
            >
              — ({row.conversion_status})
            </span>
          )}
        </span>
        <span className={`provenance-row__status provenance-row__status--${row.payment_status}`}>
          {row.payment_status}
        </span>
        <span className={`provenance-row__type provenance-row__type--${row.invoice_type}`}>
          {row.invoice_type}
        </span>
      </div>
      <dl className="provenance-row__fields">
        <dt>Sheet</dt>
        <dd>
          <code>{row.spreadsheet_id}</code> · {row.tab_name_raw} · row {row.row_index}
        </dd>
        <dt>Source row key</dt>
        <dd><code>{row.source_row_key}</code></dd>
        <dt>Order</dt>
        <dd>{row.order_code}</dd>
        <dt>Website</dt>
        <dd>{row.website ?? '—'}</dd>
        <dt>Native</dt>
        <dd>
          {row.native_amount !== null && row.native_currency !== null
            ? `${row.native_amount.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })} ${row.native_currency}`
            : '—'}
        </dd>
        <dt>ECB rate</dt>
        <dd>
          {row.ecb_rate !== null
            ? `${row.ecb_rate} ${row.native_currency ?? ''}/EUR (as of ${dayLabel(row.ecb_rate_as_of)})`
            : '—'}
        </dd>
        <dt>Invoice date</dt>
        <dd>{row.invoice_date ? dayLabel(row.invoice_date) : `Undated (date_source=${row.date_source})`}</dd>
        <dt>Spend</dt>
        <dd>{row.eur_amount !== null ? fmtEur(row.eur_amount) : '—'}</dd>
        <dt>Savings</dt>
        <dd>{fmtEur(row.savings_eur)}</dd>
        <dt>Artifact</dt>
        <dd>
          {renderArtifactCell(row, link)}
        </dd>
        {row.audit_flags.length > 0 && (
          <>
            <dt>Audit flags</dt>
            <dd>
              {row.audit_flags.map((flag, i) => (
                <span key={`${flag}-${i}`} className="provenance-row__flag">{flag}</span>
              ))}
            </dd>
          </>
        )}
      </dl>
    </li>
  );
}

function renderArtifactCell(row: InvoiceRow, link: string | null): JSX.Element {
  if (row.invoice_type === 'text') {
    return <span className="provenance-row__text-note">{row.artifact_ref ?? '—'}</span>;
  }
  if (row.invoice_type === 'missing') {
    return (
      <span
        className="provenance-row__missing"
        title="No artifact attached. See Audit → missing_invoice_url."
      >
        no artifact
      </span>
    );
  }
  if (link === null) {
    return <span>—</span>;
  }
  const label =
    row.invoice_type === 'pdf'
      ? `Open PDF (${row.artifact_status})`
      : row.invoice_type === 'drive_pdf'
        ? `Open Drive PDF (${row.artifact_status})`
        : `Open ${row.invoice_type}`;
  return (
    <a
      href={link}
      target="_blank"
      rel="noopener noreferrer"
      className="provenance-row__link"
    >
      {label}
    </a>
  );
}
