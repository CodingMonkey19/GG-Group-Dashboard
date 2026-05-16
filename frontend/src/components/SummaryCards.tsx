/**
 * SummaryCards (T057) — renders the headline EUR total + the four
 * payment-status sub-totals for a given scope.
 *
 * Per Constitution Principle VI / FR-010, every aggregate MUST display
 * the payment-status breakdown alongside the headline. This component
 * never shows a single conflated total without the breakdown.
 */

import type { ScopedTotal } from '../lib/selectors';
import { fmtEur, fmtNum } from '../lib/format';

interface Props {
  total: ScopedTotal;
  /** Optional contextual label (e.g., "Apr 2026", "CGLT × Apr 2026", "CGLT lifetime"). */
  scope?: string;
  /**
   * The current scope identifier — used to suppress the "X undated rows
   * included" hint when the scope IS the Undated bucket (otherwise the
   * hint would be redundant: every row in that scope is undated by
   * definition).
   */
  monthBucket?: string;
  /** Optional empty-state message when total.count === 0 (FR-022). */
  emptyMessage?: string;
  /**
   * Open the drill-down drawer for this scope (T086). When provided, the
   * headline EUR figure becomes a clickable button. Omit on read-only
   * surfaces (e.g., a print view) where drill-down isn't needed.
   */
  onDrillDown?: () => void;
}

export function SummaryCards({ total, scope, monthBucket, emptyMessage, onDrillDown }: Props): JSX.Element {
  if (total.count === 0) {
    return (
      <section className="summary-cards summary-cards--empty">
        <div className="summary-card summary-card--headline">
          <div className="summary-card__label">{scope ?? 'Total'}</div>
          <div className="summary-card__value summary-card__value--empty">
            {emptyMessage ?? 'No spend'}
          </div>
        </div>
      </section>
    );
  }

  // User Story 3 acceptance scenario 2 (NON-NEGOTIABLE):
  // "When the lifetime total includes Undated rows, those rows are
  //  included in the total AND the count of undated rows is visible
  //  alongside the figure."
  // The same hint also applies to monthly + order×month scopes when the
  // scope happens to include undated rows (rare but possible if the
  // current month bucket happens to be the same as the snapshot's
  // undated bucket — actually impossible since dated rows have YYYY-MM
  // and undated rows have null. So this hint mainly fires on lifetime
  // and lifetime-per-order). When the scope IS 'Undated', we suppress
  // the hint because every row is undated by definition and the scope
  // label already says so.
  const showUndatedHint = total.undated_count > 0 && monthBucket !== 'Undated';

  return (
    <section className="summary-cards" aria-label={scope ?? 'Spend summary'}>
      <div className="summary-card summary-card--headline">
        <div className="summary-card__label">{scope ?? 'Total'}</div>
        <div className="summary-card__value">
          {onDrillDown ? (
            <button
              type="button"
              className="summary-card__value-btn"
              onClick={onDrillDown}
              title="Click to see contributing invoices"
            >
              {fmtEur(total.eur)}
            </button>
          ) : (
            fmtEur(total.eur)
          )}
        </div>
        <div className="summary-card__sub">
          {fmtNum(total.count)} {total.count === 1 ? 'invoice' : 'invoices'}
          {showUndatedHint && (
            <>
              {' · '}
              <span
                className="summary-card__undated-hint"
                title="Undated invoices are included in the total. Drill down to see them."
              >
                {fmtNum(total.undated_count)} undated{' '}
                {total.undated_count === 1 ? 'row' : 'rows'} included
              </span>
            </>
          )}
        </div>
      </div>

      <StatusCard label="Paid" tone="paid" {...total.by_status.paid} />
      <StatusCard label="Unpaid" tone="unpaid" {...total.by_status.unpaid} />
      <StatusCard label="Unknown status" tone="warn" {...total.by_status.unknown} />
      <StatusCard label="No status column" tone="warn" {...total.by_status.missing} />
    </section>
  );
}

function StatusCard(props: {
  label: string;
  tone: 'paid' | 'unpaid' | 'warn';
  eur: number;
  count: number;
}): JSX.Element {
  const className = `summary-card summary-card--${props.tone}`;
  return (
    <div className={className}>
      <div className="summary-card__label">{props.label}</div>
      <div className="summary-card__value">{fmtEur(props.eur)}</div>
      <div className="summary-card__sub">
        {fmtNum(props.count)} {props.count === 1 ? 'invoice' : 'invoices'}
      </div>
    </div>
  );
}
