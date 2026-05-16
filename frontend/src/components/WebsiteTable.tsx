/**
 * WebsiteTable — per-publisher current-price grid (US4 / FR-014).
 *
 * Operator-facing column copy:
 *   • Live URL — most-recent dated invoice's column-L value (falls back to
 *     the canonical website domain when the cell is blank). Rendered as a
 *     clickable link that opens the article in a new tab. Row remains
 *     clickable for drill-down; the link uses `stopPropagation` so it
 *     doesn't also fire the drawer.
 *   • Current price (EUR)
 *   • As of — invoice date
 *   • History — count of Done+converted invoices for the publisher
 *
 * Removed (operator request): the "Native" amount column and the
 * payment-status chip. Both were noise on the executive surface.
 *
 * Sortable: all four columns. Click a header to toggle asc / desc.
 * Default sort = Live URL ascending.
 *
 * Layout: table-layout: fixed with 25% width per column so the grid is
 * even regardless of URL length; long URLs truncate with ellipsis and a
 * `title` tooltip carrying the full URL.
 */

import { useMemo, useState } from 'react';
import type { WebsiteCurrentPrice } from '../lib/selectors';
import { fmtEur, fmtNum } from '../lib/format';

interface Props {
  rows: WebsiteCurrentPrice[];
  /**
   * Open the drill-down drawer for the publisher's full history (T086).
   * When provided, each row becomes clickable; the link inside the row
   * stops propagation so it doesn't also open the drawer.
   */
  onDrillDown?: (website: string) => void;
}

type SortColumn = 'live_url' | 'price' | 'date' | 'history';
type SortDir = 'asc' | 'desc';

/** Strip http(s):// + trailing slash for compact display in the cell. */
function compactUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/**
 * Return a safe http(s) href to open the live URL in a new tab, or null if
 * the cell value can't be safely linked. Same XSS-defang pattern as
 * artifactUrl(): any non-http(s) URL scheme is rejected; a bare domain
 * (e.g. "example.com") is upgraded to "https://".
 */
function safeExternalHref(displayUrl: string): string | null {
  const trimmed = displayUrl.trim();
  if (trimmed.length === 0) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      return u.protocol === 'http:' || u.protocol === 'https:' ? trimmed : null;
    } catch {
      return null;
    }
  }
  // Anything that LOOKS like a scheme prefix but isn't http(s) → block
  // (defends against `javascript:` or `data:` typed into a sheet cell).
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  return `https://${trimmed}`;
}

export function WebsiteTable({ rows, onDrillDown }: Props): JSX.Element {
  const [sortCol, setSortCol] = useState<SortColumn>('live_url');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const sorted = useMemo(() => {
    const out = rows.slice();
    out.sort((a, b) => {
      let cmp = 0;
      switch (sortCol) {
        case 'live_url': {
          const av = (a.current_price_live_url ?? a.website).toLowerCase();
          const bv = (b.current_price_live_url ?? b.website).toLowerCase();
          cmp = av < bv ? -1 : av > bv ? 1 : 0;
          break;
        }
        case 'price': {
          // Unknown prices sort to the bottom in either direction.
          const av = a.current_price_eur;
          const bv = b.current_price_eur;
          if (av === null && bv === null) cmp = 0;
          else if (av === null) cmp = sortDir === 'asc' ? 1 : -1;
          else if (bv === null) cmp = sortDir === 'asc' ? -1 : 1;
          else cmp = av - bv;
          break;
        }
        case 'date': {
          const av = a.current_price_invoice_date ?? '';
          const bv = b.current_price_invoice_date ?? '';
          // Empty dates sort to the bottom regardless of direction.
          if (av === '' && bv === '') cmp = 0;
          else if (av === '') cmp = sortDir === 'asc' ? 1 : -1;
          else if (bv === '') cmp = sortDir === 'asc' ? -1 : 1;
          else cmp = av < bv ? -1 : av > bv ? 1 : 0;
          break;
        }
        case 'history': {
          cmp = a.history_count - b.history_count;
          break;
        }
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return out;
  }, [rows, sortCol, sortDir]);

  const onHeaderClick = (col: SortColumn): void => {
    if (col === sortCol) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      // Numeric / date columns default to descending; alphabetical to ascending.
      setSortDir(col === 'live_url' ? 'asc' : 'desc');
    }
  };

  const sortMark = (col: SortColumn): string =>
    col === sortCol ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const ariaSort = (col: SortColumn): 'ascending' | 'descending' | 'none' =>
    col === sortCol ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';

  if (rows.length === 0) {
    return (
      <div className="empty-state">
        <h2>No live URLs yet</h2>
        <p>
          Per-link prices will appear once the consolidated store contains at least one Done
          invoice with a live URL on column L.
        </p>
      </div>
    );
  }

  return (
    <section className="website-table website-table--fixed" aria-label="Per-publisher current prices">
      <table>
        <colgroup>
          <col className="website-table__col" />
          <col className="website-table__col" />
          <col className="website-table__col" />
          <col className="website-table__col" />
        </colgroup>
        <thead>
          <tr>
            <th aria-sort={ariaSort('live_url')}>
              <button
                type="button"
                className="website-table__sort-btn"
                onClick={() => onHeaderClick('live_url')}
              >
                Live URL{sortMark('live_url')}
              </button>
            </th>
            <th aria-sort={ariaSort('price')}>
              <button
                type="button"
                className="website-table__sort-btn"
                onClick={() => onHeaderClick('price')}
              >
                Current price (EUR){sortMark('price')}
              </button>
            </th>
            <th aria-sort={ariaSort('date')}>
              <button
                type="button"
                className="website-table__sort-btn"
                onClick={() => onHeaderClick('date')}
              >
                As of{sortMark('date')}
              </button>
            </th>
            <th aria-sort={ariaSort('history')}>
              <button
                type="button"
                className="website-table__sort-btn"
                onClick={() => onHeaderClick('history')}
              >
                History{sortMark('history')}
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const displayUrl = r.current_price_live_url ?? r.website;
            const href = safeExternalHref(displayUrl);
            const compact = compactUrl(displayUrl);
            return (
              <tr
                key={r.website}
                {...(onDrillDown
                  ? {
                      className: 'website-table__row--clickable',
                      onClick: () => onDrillDown(r.website),
                      title: "Click to see this publisher's full invoice history",
                    }
                  : {})}
              >
                <td className="website-table__td-live-url" title={displayUrl}>
                  {href !== null ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="website-table__live-url-link"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {compact}
                    </a>
                  ) : (
                    <span>{compact}</span>
                  )}
                </td>
                <td className="website-table__td-price">
                  {r.current_price_eur !== null ? (
                    fmtEur(r.current_price_eur)
                  ) : (
                    <span
                      className="website-table__unknown"
                      title="Every invoice for this publisher is Undated — current price cannot be determined. Drill down to see history."
                    >
                      unknown
                    </span>
                  )}
                </td>
                <td className="website-table__td-date">
                  {r.current_price_invoice_date ?? <span className="website-table__td-date--unknown">—</span>}
                </td>
                <td className="website-table__td-history">
                  {fmtNum(r.history_count)} {r.history_count === 1 ? 'invoice' : 'invoices'}
                  {r.undated_count > 0 && (
                    <>
                      {' '}
                      <span
                        className="website-table__undated-badge"
                        title={`${r.undated_count} of ${r.history_count} invoices are Undated.`}
                      >
                        ({fmtNum(r.undated_count)} undated)
                      </span>
                    </>
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
