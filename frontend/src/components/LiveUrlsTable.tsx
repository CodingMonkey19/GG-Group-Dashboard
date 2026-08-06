import { useMemo, useState } from 'react';
import type { InvoiceRow } from '../lib/contracts';
import { dayLabel, fmtEur, fmtNum } from '../lib/format';

interface Props {
  rows: InvoiceRow[];
  onDrillDown?: (row: InvoiceRow) => void;
}

type SortColumn = 'target' | 'anchor' | 'website' | 'live' | 'price' | 'date';
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

function optionalNumber(value: string): number | null {
  if (value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function textFor(row: InvoiceRow, column: SortColumn): string {
  if (column === 'target') return row.target_url ?? '';
  if (column === 'anchor') return row.anchor_text ?? '';
  if (column === 'website') return row.website ?? '';
  if (column === 'live') return row.live_url ?? '';
  if (column === 'date') return row.invoice_date;
  return '';
}

export function LiveUrlsTable({ rows, onDrillDown }: Props): JSX.Element {
  const [sortColumn, setSortColumn] = useState<SortColumn>('date');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [targetFilter, setTargetFilter] = useState('');
  const [anchorFilter, setAnchorFilter] = useState('');
  const [websiteFilter, setWebsiteFilter] = useState('');
  const [liveFilter, setLiveFilter] = useState('');
  const [priceMin, setPriceMin] = useState('');
  const [priceMax, setPriceMax] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const displayedRows = useMemo(() => {
    const target = targetFilter.trim().toLowerCase();
    const anchor = anchorFilter.trim().toLowerCase();
    const website = websiteFilter.trim().toLowerCase();
    const live = liveFilter.trim().toLowerCase();
    const minimum = optionalNumber(priceMin);
    const maximum = optionalNumber(priceMax);
    const filtered = rows.filter((row) => {
      if (target !== '' && !(row.target_url ?? '').toLowerCase().includes(target)) return false;
      if (anchor !== '' && !(row.anchor_text ?? '').toLowerCase().includes(anchor)) return false;
      if (website !== '' && !(row.website ?? '').toLowerCase().includes(website)) return false;
      if (live !== '' && !(row.live_url ?? '').toLowerCase().includes(live)) return false;
      if (minimum !== null && (row.eur_amount === null || row.eur_amount < minimum)) return false;
      if (maximum !== null && (row.eur_amount === null || row.eur_amount > maximum)) return false;
      if (dateFrom !== '' && row.invoice_date < dateFrom) return false;
      if (dateTo !== '' && row.invoice_date > dateTo) return false;
      return true;
    });
    filtered.sort((a, b) => {
      let comparison = 0;
      if (sortColumn === 'price') {
        const left = a.eur_amount;
        const right = b.eur_amount;
        if (left === null && right === null) comparison = 0;
        else if (left === null) comparison = sortDirection === 'asc' ? 1 : -1;
        else if (right === null) comparison = sortDirection === 'asc' ? -1 : 1;
        else comparison = left - right;
      } else {
        const left = textFor(a, sortColumn).toLowerCase();
        const right = textFor(b, sortColumn).toLowerCase();
        comparison = left < right ? -1 : left > right ? 1 : 0;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return filtered;
  }, [anchorFilter, dateFrom, dateTo, liveFilter, priceMax, priceMin, rows, sortColumn, sortDirection, targetFilter, websiteFilter]);

  const filtersActive = [targetFilter, anchorFilter, websiteFilter, liveFilter, priceMin, priceMax, dateFrom, dateTo]
    .some((value) => value.trim().length > 0);
  const clearFilters = (): void => {
    setTargetFilter('');
    setAnchorFilter('');
    setWebsiteFilter('');
    setLiveFilter('');
    setPriceMin('');
    setPriceMax('');
    setDateFrom('');
    setDateTo('');
  };
  const changeSort = (column: SortColumn): void => {
    if (column === sortColumn) setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    else {
      setSortColumn(column);
      setSortDirection(column === 'price' || column === 'date' ? 'desc' : 'asc');
    }
  };
  const sortMark = (column: SortColumn): string =>
    column === sortColumn ? (sortDirection === 'asc' ? ' ▲' : ' ▼') : '';

  if (rows.length === 0) {
    return (
      <div className="empty-state">
        <h2>No live URLs in this selection</h2>
        <p>Change the month or order to see completed links with a Live URL.</p>
      </div>
    );
  }

  return (
    <section className="data-table live-urls-table" aria-label="Completed live URLs">
      <div className="data-table__toolbar">
        <span>{fmtNum(displayedRows.length)} of {fmtNum(rows.length)} links</span>
        {filtersActive && <button type="button" onClick={clearFilters}>Clear filters</button>}
      </div>
      <table>
        <thead>
          <tr>
            <th><button type="button" onClick={() => changeSort('target')}>Target URL{sortMark('target')}</button></th>
            <th><button type="button" onClick={() => changeSort('anchor')}>Anchor Text{sortMark('anchor')}</button></th>
            <th><button type="button" onClick={() => changeSort('website')}>Website{sortMark('website')}</button></th>
            <th><button type="button" onClick={() => changeSort('live')}>Live URL{sortMark('live')}</button></th>
            <th><button type="button" onClick={() => changeSort('price')}>Price{sortMark('price')}</button></th>
            <th><button type="button" onClick={() => changeSort('date')}>Date{sortMark('date')}</button></th>
          </tr>
          <tr className="data-table__filters">
            <th><input type="search" value={targetFilter} onChange={(event) => setTargetFilter(event.target.value)} placeholder="Filter target" aria-label="Filter Target URL" /></th>
            <th><input type="search" value={anchorFilter} onChange={(event) => setAnchorFilter(event.target.value)} placeholder="Filter anchor" aria-label="Filter Anchor Text" /></th>
            <th><input type="search" value={websiteFilter} onChange={(event) => setWebsiteFilter(event.target.value)} placeholder="Filter website" aria-label="Filter Website" /></th>
            <th><input type="search" value={liveFilter} onChange={(event) => setLiveFilter(event.target.value)} placeholder="Filter live URL" aria-label="Filter Live URL" /></th>
            <th><div className="data-table__range"><input type="number" min="0" step="0.01" value={priceMin} onChange={(event) => setPriceMin(event.target.value)} placeholder="Min" aria-label="Minimum Price" /><input type="number" min="0" step="0.01" value={priceMax} onChange={(event) => setPriceMax(event.target.value)} placeholder="Max" aria-label="Maximum Price" /></div></th>
            <th><div className="data-table__range"><input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} aria-label="Date from" /><input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} aria-label="Date to" /></div></th>
          </tr>
        </thead>
        <tbody>
          {displayedRows.length === 0 ? (
            <tr><td className="data-table__empty" colSpan={6}>No live URLs match these filters.</td></tr>
          ) : displayedRows.map((row) => {
            const targetHref = safeExternalHref(row.target_url);
            const liveUrl = row.live_url ?? null;
            const liveHref = safeExternalHref(liveUrl);
            return (
              <tr
                key={row.source_row_key}
                className={onDrillDown === undefined ? undefined : 'data-table__row--clickable'}
                onClick={onDrillDown === undefined ? undefined : () => onDrillDown(row)}
              >
                <td className="data-table__url">{targetHref === null || row.target_url === null ? '—' : <a href={targetHref} target="_blank" rel="noopener noreferrer" title={row.target_url} onClick={(event) => event.stopPropagation()}>{compactUrl(row.target_url)}</a>}</td>
                <td>{row.anchor_text ?? '—'}</td>
                <td className="data-table__strong">{row.website ?? '—'}</td>
                <td className="data-table__url">{liveHref === null || liveUrl === null ? '—' : <a href={liveHref} target="_blank" rel="noopener noreferrer" title={liveUrl} onClick={(event) => event.stopPropagation()}>{compactUrl(liveUrl)}</a>}</td>
                <td>{row.eur_amount === null ? '—' : fmtEur(row.eur_amount)}</td>
                <td className="data-table__date">{dayLabel(row.invoice_date)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
