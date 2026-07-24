/**
 * GG Spend Dashboard — App shell (HANDOFF v2 §5).
 *
 * State is the three-axis filter (year / month / order) plus refresh-bar
 * state inlined from the deleted FreshnessBar. SpendView and
 * WebsitesContent are local sub-components that consume the snapshot via
 * the new selectors.
 *
 * The Audit tab was removed per operator request — data-quality findings
 * are technical-developer concerns reviewed outside the dashboard. The
 * audit pipeline still emits findings to the SQLite store; they're just
 * not surfaced in the UI. The Websites view keeps the existing
 * WebsiteTable / ProvenanceDrawer drill-down flow (Constitution
 * Principle II — every number traceable).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, fetchData, subscribeRefresh } from './lib/api';
import type { ApiDataResponse, InvoiceRow } from './lib/contracts';
import {
  distinctOrderCodes,
  drillRowsForScope,
  drillRowsForWebsite,
  MIN_VISIBLE_YEAR_ROWS,
  monthlyBreakdowns,
  monthsInYear,
  rowsDoneSeries,
  spendInScope,
  websiteCurrentPrices,
  type SpendScope,
} from './lib/selectors';
import {
  fmtEur,
  fmtNum,
  monthShortLabel,
  relativeTime,
  scopeLabelFor,
} from './lib/format';
import { Briefing } from './components/Briefing';
import { DonutChart } from './components/DonutChart';
import { KpiCard } from './components/KpiCard';
import { LineChart } from './components/LineChart';
import { MonthSelector } from './components/MonthSelector';
import { OrderFilter } from './components/OrderFilter';
import { Panel } from './components/Panel';
import { ProvenanceDrawer } from './components/ProvenanceDrawer';
import { RankedBars } from './components/RankedBars';
import { ScopeToggle, type Scope } from './components/ScopeToggle';
import { StackedBars } from './components/StackedBars';
import { ViewToggle, type View } from './components/ViewToggle';
import { WebsiteTable } from './components/WebsiteTable';

const REPORTING_YEAR = '2026';

interface DrawerState {
  title: string;
  rows: InvoiceRow[];
}

/**
 * Today's ISO date (YYYY-MM-DD) in UTC. Computed in this component
 * because [lib/format.ts](lib/format.ts) and
 * [lib/selectors.ts](lib/selectors.ts) are locked against `Date.now` /
 * `new Date(` per the FR-024 grep guard. Passing the date into selectors
 * keeps the bucket-derivation rule intact while still letting the UI hide
 * future-dated typos.
 */
function todayIsoDateUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'never_refreshed' }
  | { kind: 'ready'; data: ApiDataResponse }
  | { kind: 'error'; message: string };

export function App(): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [view, setView] = useState<View>('spend');
  const [scope, setScope] = useState<Scope>('month');
  const [month, setMonth] = useState<string>('');
  const [order, setOrder] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);

  // Refresh-state (formerly useFreshnessRefresh) inlined.
  const [refreshing, setRefreshing] = useState(false);
  const [refreshPhase, setRefreshPhase] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const refreshAbortRef = useRef<AbortController | null>(null);

  const load = useCallback((): void => {
    fetchData()
      .then((d) => {
        if (d === null) setState({ kind: 'never_refreshed' });
        else setState({ kind: 'ready', data: d });
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 501) {
          setState({ kind: 'never_refreshed' });
          return;
        }
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, []);

  // Initial load.
  useEffect(() => {
    load();
  }, [load]);

  // Tick every 20s so "Updated X ago" stays current.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(id);
  }, []);

  // Cancel any in-flight refresh on unmount.
  useEffect(
    () => () => {
      refreshAbortRef.current?.abort();
    },
    [],
  );

  const startRefresh = useCallback((): void => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshPhase('starting');
    setRefreshError(null);
    refreshAbortRef.current = subscribeRefresh({
      onStarted: () => setRefreshPhase('starting'),
      onPhase: (e) => setRefreshPhase(e.phase),
      onSourceProgress: () => {},
      onCompleted: () => {
        setRefreshing(false);
        setRefreshPhase(null);
        setNow(Date.now());
        load();
      },
      onError: (e) => {
        setRefreshing(false);
        setRefreshPhase(null);
        setRefreshError(e.error);
      },
      onTransportError: (err) => {
        setRefreshing(false);
        setRefreshPhase(null);
        setRefreshError(err.message);
      },
    });
  }, [refreshing, load]);

  const data = state.kind === 'ready' ? state.data : null;

  // Today, recomputed when the "Updated X ago" tick advances. Drives the
  // future-date filter for every selector that consumes it, so a typo like
  // `2026-11-02` (when today is `2026-05-15`) doesn't pollute the year /
  // month dropdowns or the line / bar charts. Audit panel still surfaces
  // those rows under `future_dated_invoice` — this is purely a UI hide.
  const today = useMemo(() => todayIsoDateUtc(), [now]);

  const monthOptions = useMemo(
    () =>
      data !== null
        ? monthsInYear(data, REPORTING_YEAR, today, MIN_VISIBLE_YEAR_ROWS)
        : [],
    [data, today],
  );
  const selectedMonth = monthOptions.includes(month)
    ? month
    : (monthOptions.at(-1) ?? '01');
  const orders = useMemo(() => (data !== null ? distinctOrderCodes(data) : []), [data]);

  // Open on the latest available 2026 month and retain valid selections.
  useEffect(() => {
    if (monthOptions.length > 0 && !monthOptions.includes(month)) {
      setMonth(monthOptions.at(-1) ?? '01');
    }
  }, [month, monthOptions]);

  // Reset selected order if it disappears from the snapshot.
  useEffect(() => {
    if (order !== null && data !== null && !orders.includes(order)) {
      setOrder(null);
    }
  }, [order, data, orders]);

  const updatedLabel =
    data !== null ? `Updated ${relativeTime(data.last_refreshed_at, now)}` : 'No snapshot loaded';

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="brand">
          <div className="brand__mark">GG</div>
          <div className="brand__meta">
            <div className="brand__name">Off-page Operations</div>
            <div className="brand__sub">CEO dashboard</div>
          </div>
        </div>

        {data !== null && (
          <div className="topbar__filters">
            <MonthSelector
              months={monthOptions}
              value={selectedMonth}
              onChange={setMonth}
              disabled={scope === 'year'}
            />
            <OrderFilter orders={orders} value={order} onChange={setOrder} />
          </div>
        )}

        <div className="topbar__refresh">
          <button
            className="btn btn--primary"
            type="button"
            onClick={startRefresh}
            disabled={data === null || refreshing}
            title={
              refreshing
                ? `Refreshing — ${refreshPhase ?? 'starting'}`
                : 'Trigger a full refresh'
            }
          >
            <span
              className={`btn__icon ${refreshing ? 'btn__icon--spin' : ''}`}
              aria-hidden="true"
            >
              ↻
            </span>
            {refreshing ? `Refreshing… (${refreshPhase ?? 'starting'})` : 'Refresh'}
            {data !== null && (
              <FailedSourcePill count={countFailedSources(data)} />
            )}
          </button>
          <span className="topbar__updated">{updatedLabel}</span>
        </div>
      </header>

      {data !== null && (
        <div className="view-toggle-row">
          <ViewToggle value={view} onChange={setView} />
          {view === 'spend' && <ScopeToggle value={scope} onChange={setScope} />}
        </div>
      )}

      <main className="app-main">
        {renderMain({
          state,
          view,
          scope,
          month: selectedMonth,
          order,
          orders,
          today,
          refreshError,
          onDrillDown: setDrawer,
        })}
      </main>

      {drawer !== null && (
        <ProvenanceDrawer
          title={drawer.title}
          rows={drawer.rows}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  );
}

function FailedSourcePill({ count }: { count: number }): JSX.Element | null {
  if (count <= 0) return null;
  return <span className="btn__pill">{count}</span>;
}

function countFailedSources(data: ApiDataResponse): number {
  let n = 0;
  for (const s of data.per_source) if (s.status === 'failure') n += 1;
  return n;
}

function renderMain({
  state,
  view,
  scope,
  month,
  order,
  orders,
  today,
  refreshError,
  onDrillDown,
}: {
  state: LoadState;
  view: View;
  scope: Scope;
  month: string;
  order: string | null;
  orders: string[];
  today: string;
  refreshError: string | null;
  onDrillDown: (d: DrawerState) => void;
}): JSX.Element {
  switch (state.kind) {
    case 'loading':
      return <p>Loading…</p>;

    case 'never_refreshed':
      return (
        <>
          <Briefing
            eyebrow="SETUP"
            title="No consolidated snapshot yet"
            lede="Run the consolidation pipeline to populate the local store, then refresh this page."
          />
          <div className="empty-state">
            <h2>Next action</h2>
            <p>
              Run <code>./scripts/consolidate</code> to populate the store, then click Refresh.
            </p>
          </div>
        </>
      );

    case 'error':
      return (
        <>
          <Briefing
            eyebrow="ERROR"
            title="Dashboard data could not load"
            lede="The frontend could not read the current consolidated snapshot from the API."
          />
          <div className="empty-state">
            <h2>API error</h2>
            <p>{state.message}</p>
          </div>
        </>
      );

    case 'ready': {
      if (view === 'websites') {
        return <WebsitesContent data={state.data} today={today} onDrillDown={onDrillDown} />;
      }
      return (
        <SpendView
          data={state.data}
          scopeMode={scope}
          month={month}
          order={order}
          orders={orders}
          today={today}
          refreshError={refreshError}
          onDrillDown={onDrillDown}
        />
      );
    }
  }
}

/* ----------------------------------------------------------------------- */
/* SpendView — HANDOFF §5 layout.                                            */
/* ----------------------------------------------------------------------- */

interface SpendViewProps {
  data: ApiDataResponse;
  scopeMode: Scope;
  month: string;
  order: string | null;
  orders: string[];
  today: string;
  refreshError: string | null;
  onDrillDown: (d: DrawerState) => void;
}

function SpendView({
  data,
  scopeMode,
  month,
  order,
  orders,
  today,
  refreshError,
  onDrillDown,
}: SpendViewProps): JSX.Element {
  const scope: SpendScope = {
    year: REPORTING_YEAR,
    month: scopeMode === 'year' ? 'all' : month,
    orderCode: order,
  };

  const summary = useMemo(
    () => spendInScope(data, scope, today, MIN_VISIBLE_YEAR_ROWS),
    [data, scope.year, scope.month, scope.orderCode, today],
  );
  const breakdowns = useMemo(
    () => monthlyBreakdowns(data, scope, today, MIN_VISIBLE_YEAR_ROWS),
    [data, scope.year, scope.month, scope.orderCode, today],
  );
  const ranked = useMemo(() => {
    const totals = new Map<string, number>();
    for (const b of breakdowns) {
      for (const p of b.byProject) {
        totals.set(p.code, (totals.get(p.code) ?? 0) + p.value);
      }
    }
    return Array.from(totals.entries())
      .map(([code, eur]) => ({ code, eur: Math.round(eur * 100) / 100 }))
      .filter((p) => p.eur > 0)
      .sort((a, b) => {
        if (a.eur !== b.eur) return b.eur - a.eur;
        return a.code === b.code ? 0 : a.code < b.code ? -1 : 1;
      });
  }, [breakdowns]);
  const rowsSeries = useMemo(
    () => rowsDoneSeries(data, order, today, MIN_VISIBLE_YEAR_ROWS),
    [data, order, today],
  );

  const isSingleProj = order !== null;
  const periodLabel = scopeMode === 'year'
    ? '2026 Total'
    : scopeLabelFor({ year: REPORTING_YEAR, month });
  const scopeLabel = order !== null ? `${order} · ${periodLabel}` : periodLabel;
  const linksInScope = summary.count;
  const activeCount = isSingleProj ? 1 : ranked.length;
  const outstandingEur = summary.by_status.unpaid.spend_eur
    + summary.by_status.unknown.spend_eur
    + summary.by_status.missing.spend_eur;
  const outstandingCount = summary.by_status.unpaid.count
    + summary.by_status.unknown.count
    + summary.by_status.missing.count;
  const drawerRows = useMemo(
    () => drillRowsForScope(
      data,
      order,
      scopeMode === 'year' ? null : `${REPORTING_YEAR}-${month}`,
    ),
    [data, order, scopeMode, month],
  );
  const openHeadlineRows = (): void => {
    onDrillDown({ title: `${scopeLabel} — contributing rows`, rows: drawerRows });
  };

  const failedSources = data.per_source.filter((s) => s.status === 'failure');

  return (
    <>
      <Briefing
        eyebrow={`BRIEFING · ${scopeLabel.toUpperCase()}`}
        title={scopeMode === 'year' ? '2026 total in review' : `${periodLabel} in review`}
        lede={`${scopeLabel} includes ${fmtNum(linksInScope)} completed rows, ${fmtEur(summary.eur)} in spend, and ${fmtEur(summary.savings_eur)} in savings${isSingleProj ? '.' : ` across ${fmtNum(activeCount)} projects.`}`}
      />

      {failedSources.length > 0 && (
        <div className="empty-state" role="alert">
          <h2>{fmtNum(failedSources.length)} source(s) failed to refresh</h2>
          <p>{failedSources.map((s) => s.order_code).join(', ')} — aggregates that would have included these orders visibly drop.</p>
        </div>
      )}

      {refreshError !== null && (
        <div className="empty-state" role="alert">
          <h2>Refresh error</h2>
          <p>{refreshError}</p>
        </div>
      )}

      <section className="hero-row" aria-label={`${scopeLabel} totals`}>
        <KpiCard
          label="Total Spend"
          tooltip="Click to see the contributing 2026 invoices."
          value={fmtEur(summary.eur)}
          sub={scopeLabel}
          onClick={openHeadlineRows}
        />
        <KpiCard
          label="Savings"
          accent="paid"
          tooltip="Click to see the same contributing 2026 invoices."
          value={fmtEur(summary.savings_eur)}
          sub={scopeLabel}
          onClick={openHeadlineRows}
        />
      </section>

      <section className="kpi-row" aria-label={`${scopeLabel} supporting metrics`}>
        <KpiCard
          label="Rows Done"
          tooltip="Converted Done rows included in this 2026 scope."
          value={fmtNum(linksInScope)}
          sub={scopeLabel}
        />
        <KpiCard
          label="Paid"
          accent="paid"
          tooltip="Spend on rows marked paid in this 2026 scope."
          value={fmtEur(summary.by_status.paid.spend_eur)}
          sub={`${fmtNum(summary.by_status.paid.count)} rows`}
        />
        <KpiCard
          label="Outstanding"
          accent="unpaid"
          tooltip="Unpaid, unknown, or missing payment status in this 2026 scope."
          value={fmtEur(outstandingEur)}
          sub={`${fmtNum(outstandingCount)} rows`}
        />
      </section>

      <section className="grid-2">
        <Panel
          title="Links built per month"
          subtitle={`${rowsSeries.months.length} months${isSingleProj && order !== null ? ` · ${order}` : ''}`}
        >
          <LineChart
            data={rowsSeries.counts}
            labels={rowsSeries.months.map((m) => monthShortLabel(m))}
          />
        </Panel>
        <Panel
          title="Spend per month"
          subtitle={`EUR · ${scopeLabel}`}
        >
          <StackedBars data={breakdowns} />
        </Panel>
      </section>

      {!isSingleProj && ranked.length > 1 && (
        <section className="grid-2">
          <Panel
            title="Projects by spend"
            subtitle={`${fmtNum(ranked.length)} active · ${scopeLabel}`}
          >
            <RankedBars
              rows={ranked.map((p) => ({ label: p.code, value: p.eur, sub: '' }))}
              accent="blue"
              formatValue={fmtEur}
            />
          </Panel>
          <Panel title="Spend distribution" subtitle={`Share of total · ${scopeLabel}`}>
            <DonutChart slices={ranked.map((p) => ({ label: p.code, value: p.eur }))} />
          </Panel>
        </section>
      )}

      {/* orders is consumed by App for the filter; keep the reference so this
          stays available for downstream extensions. */}
      <span hidden>{orders.length}</span>
    </>
  );
}

/* ----------------------------------------------------------------------- */
/* WebsitesContent + AuditContent — keep existing drill-down flow.           */
/* ----------------------------------------------------------------------- */

function WebsitesContent({
  data,
  today,
  onDrillDown,
}: {
  data: ApiDataResponse;
  today: string;
  onDrillDown: (d: DrawerState) => void;
}): JSX.Element {
  const rows = useMemo(
    // requireLiveUrl=true → publishers whose latest dated row has no
    // live URL value are dropped from the view (avoids showing a bare
    // homepage as if it were a live URL).
    () => websiteCurrentPrices(data, today, MIN_VISIBLE_YEAR_ROWS, true),
    [data, today],
  );
  return (
    <>
      <Briefing
        eyebrow="LIVE URLS · CURRENT PRICES"
        title="Per-link pricing"
        lede="Most recent dated invoice per live URL, with history. Click any row to drill into its full invoice history; click a URL to open the article in a new tab."
      />
      <Panel title="Live URLs" subtitle={`${fmtNum(rows.length)} tracked`}>
        <WebsiteTable
          rows={rows}
          onDrillDown={(website) =>
            onDrillDown({
              title: `${website} — full invoice history`,
              rows: drillRowsForWebsite(data, website, today, MIN_VISIBLE_YEAR_ROWS),
            })
          }
        />
      </Panel>
    </>
  );
}
