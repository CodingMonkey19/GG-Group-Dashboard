import { useMemo, useState } from 'react';
import type { InvoiceRow } from '../lib/contracts';
import { fmtEur, fmtNum } from '../lib/format';

interface Props {
  rows: InvoiceRow[];
  onDrillDown?: (row: InvoiceRow) => void;
}

type SortColumn = 'website' | 'presswhizz' | 'ours' | 'saved' | 'rate';
type SortDirection = 'asc' | 'desc';

function safeExternalHref(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

function compactUrl(value: string): string {
  return value.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

function savingRate(row: InvoiceRow): number | null {
  const presswhizz = row.presswhizz_price_eur;
  return presswhizz === null || presswhizz === 0 ? null : row.savings_eur / presswhizz;
}

export function SavingsTable({ rows, onDrillDown }: Props): JSX.Element {
  const [query, setQuery] = useState('');
  const [sortColumn, setSortColumn] = useState<SortColumn>('saved');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const displayedRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = normalizedQuery.length === 0
      ? [...rows]
      : rows.filter((row) => [row.website, row.live_url, row.target_url, row.anchor_text]
          .some((value) => value?.toLowerCase().includes(normalizedQuery) ?? false));

    filtered.sort((a, b) => {
      let comparison = 0;
      if (sortColumn === 'website') {
        const left = (a.website ?? '').toLowerCase();
        const right = (b.website ?? '').toLowerCase();
        comparison = left < right ? -1 : left > right ? 1 : 0;
      } else {
        const left = sortColumn === 'presswhizz'
          ? a.presswhizz_price_eur
          : sortColumn === 'ours'
            ? a.eur_amount
            : sortColumn === 'saved'
              ? a.savings_eur
              : savingRate(a);
        const right = sortColumn === 'presswhizz'
          ? b.presswhizz_price_eur
          : sortColumn === 'ours'
            ? b.eur_amount
            : sortColumn === 'saved'
              ? b.savings_eur
              : savingRate(b);
        if (left === null && right === null) comparison = 0;
        else if (left === null) comparison = sortDirection === 'asc' ? 1 : -1;
        else if (right === null) comparison = sortDirection === 'asc' ? -1 : 1;
        else comparison = left - right;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return filtered;
  }, [query, rows, sortColumn, sortDirection]);

  const changeSort = (column: SortColumn): void => {
    if (column === sortColumn) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection(column === 'website' ? 'asc' : 'desc');
    }
  };

  const sortMark = (column: SortColumn): string =>
    column === sortColumn ? (sortDirection === 'asc' ? ' ▲' : ' ▼') : '';

  if (rows.length === 0) {
    return (
      <div className="empty-state">
        <h2>No completed links in this selection</h2>
        <p>Change the month or order to see link-level savings.</p>
      </div>
    );
  }

  return (
    <section className="data-table savings-table" aria-label="Savings by completed link">
      <div className="data-table__toolbar">
        <span>{fmtNum(displayedRows.length)} of {fmtNum(rows.length)} links</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search website, URL, or anchor"
          aria-label="Search savings links"
        />
      </div>
      <table>
        <thead>
          <tr>
            <th><button type="button" onClick={() => changeSort('website')}>Website{sortMark('website')}</button></th>
            <th><button type="button" onClick={() => changeSort('presswhizz')}>PressWhizz Price{sortMark('presswhizz')}</button></th>
            <th><button type="button" onClick={() => changeSort('ours')}>Our Price{sortMark('ours')}</button></th>
            <th><button type="button" onClick={() => changeSort('saved')}>Saved{sortMark('saved')}</button></th>
            <th><button type="button" onClick={() => changeSort('rate')}>Saving %{sortMark('rate')}</button></th>
            <th>Live URL</th>
          </tr>
        </thead>
        <tbody>
          {displayedRows.length === 0 ? (
            <tr><td className="data-table__empty" colSpan={6}>No links match this search.</td></tr>
          ) : displayedRows.map((row) => {
            const rate = savingRate(row);
            const liveUrl = row.live_url ?? null;
            const href = safeExternalHref(liveUrl);
            return (
              <tr
                key={row.source_row_key}
                className={onDrillDown === undefined ? undefined : 'data-table__row--clickable'}
                onClick={onDrillDown === undefined ? undefined : () => onDrillDown(row)}
              >
                <td className="data-table__strong">{row.website ?? '—'}</td>
                <td>{row.presswhizz_price_eur === null ? '—' : fmtEur(row.presswhizz_price_eur)}</td>
                <td>{row.eur_amount === null ? '—' : fmtEur(row.eur_amount)}</td>
                <td className="savings-table__saved">{fmtEur(row.savings_eur)}</td>
                <td>
                  {rate === null ? '—' : (
                    <span className="savings-table__rate">{(rate * 100).toFixed(1)}%</span>
                  )}
                </td>
                <td className="data-table__url">
                  {href === null || liveUrl === null ? '—' : (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={liveUrl}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {compactUrl(liveUrl)}
                    </a>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
