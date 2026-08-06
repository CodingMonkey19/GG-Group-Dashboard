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
      </div>
      <dl className="provenance-row__fields">
        <dt>Order</dt>
        <dd>{row.order_code}</dd>
        <dt>Website</dt>
        <dd>{row.website ?? '—'}</dd>
        <dt>Anchor text</dt>
        <dd>{row.anchor_text ?? '—'}</dd>
        <dt>Target URL</dt>
        <dd>{renderExternalLink(row.target_url, 'Open target page')}</dd>
        <dt>Live link</dt>
        <dd>{renderExternalLink(row.live_url, 'Open live link')}</dd>
        <dt>Invoice date</dt>
        <dd>{row.invoice_date ? dayLabel(row.invoice_date) : `Undated (date_source=${row.date_source})`}</dd>
        <dt>Our price</dt>
        <dd>{row.eur_amount !== null ? fmtEur(row.eur_amount) : '—'}</dd>
        <dt>PressWhizz price</dt>
        <dd>{row.presswhizz_price_eur === null ? '—' : fmtEur(row.presswhizz_price_eur)}</dd>
        <dt>Saved</dt>
        <dd>{fmtEur(row.savings_eur)}</dd>
      </dl>
    </li>
  );
}

function renderExternalLink(value: string | null | undefined, label: string): JSX.Element {
  if (value == null || value.trim().length === 0) return <span>—</span>;
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let href: string | null = null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') href = candidate;
  } catch {
    href = null;
  }
  if (href === null) return <span>{value}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="provenance-row__link"
      title={value}
    >
      {label}
    </a>
  );
}
