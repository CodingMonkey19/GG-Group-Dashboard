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
  dateRangeLabel,
  filterDataByDateRange,
  isValidDateRange,
  previousEqualRange,
  rangeForMonth,
  type DateRange,
} from './lib/dateRanges';
import {
  completedRowsInScope,
  distinctOrderCodes,
  drillRowsForScope,
  liveUrlRowsInScope,
  MIN_VISIBLE_YEAR_ROWS,
  monthlyBreakdowns,
  monthsInYear,
  rowsDoneSeries,
  savingsBreakdowns,
  savingsByOrder,
  savingsInScope,
  spendInScope,
  type MonthBreakdown,
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
import {
  CompareSelector,
  resolveComparisonMonth,
  type ComparisonSelection,
} from './components/CompareSelector';
import { DateRangeControls } from './components/DateRangeControls';
import { DonutChart } from './components/DonutChart';
import { KpiCard, type KpiComparison } from './components/KpiCard';
import { LineChart } from './components/LineChart';
import { LiveUrlsTable } from './components/LiveUrlsTable';
import { MonthSelector } from './components/MonthSelector';
import { OrderFilter } from './components/OrderFilter';
import { Panel } from './components/Panel';
import { ProvenanceDrawer } from './components/ProvenanceDrawer';
import { RankedBars } from './components/RankedBars';
import type { Scope } from './components/ScopeToggle';
import { SavingsTable } from './components/SavingsTable';
import { StackedBars } from './components/StackedBars';
import { ViewToggle, type View } from './components/ViewToggle';

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
  const [comparison, setComparison] = useState<ComparisonSelection>('off');
  const [dateRange, setDateRange] = useState<DateRange>(() => rangeForMonth('07'));
  const [comparisonRange, setComparisonRange] = useState<DateRange>(() => previousEqualRange(rangeForMonth('07')));
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
  const compareMonth = resolveComparisonMonth(comparison, selectedMonth, monthOptions);
  const orders = useMemo(() => (data !== null ? distinctOrderCodes(data) : []), [data]);
  const displayData = useMemo(
    () => data !== null && scope === 'range' ? filterDataByDateRange(data, dateRange) : data,
    [data, scope, dateRange.from, dateRange.to],
  );
  const comparisonData = useMemo(
    () => data !== null && scope === 'range' && comparison === 'custom'
      ? filterDataByDateRange(data, comparisonRange)
      : null,
    [data, scope, comparison, comparisonRange.from, comparisonRange.to],
  );

  // Open on the latest available 2026 month and retain valid selections.
  useEffect(() => {
    if (monthOptions.length > 0 && !monthOptions.includes(month)) {
      setMonth(monthOptions.at(-1) ?? '01');
    }
  }, [month, monthOptions]);

  useEffect(() => {
    if (scope === 'year') {
      setComparison('off');
      return;
    }
    if (scope === 'range') {
      if (comparison !== 'off' && comparison !== 'custom') setComparison('off');
      return;
    }
    if (comparison === 'custom' || (comparison !== 'off' && compareMonth === null)) {
      setComparison('off');
    }
  }, [scope, comparison, compareMonth]);

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
              scope={view === 'websites' ? 'month' : scope}
              showScopeOptions={view !== 'websites'}
              onScopeChange={(nextScope) => {
                if (view === 'websites') return;
                if (nextScope === 'range' && scope !== 'range') {
                  const selectedRange = rangeForMonth(selectedMonth);
                  setDateRange(selectedRange);
                  setComparisonRange(previousEqualRange(selectedRange));
                  setComparison('custom');
                }
                setScope(nextScope);
              }}
            />
            <OrderFilter orders={orders} value={order} onChange={setOrder} />
            {view !== 'websites' && (
              <CompareSelector
                months={monthOptions}
                currentMonth={selectedMonth}
                value={comparison}
                onChange={setComparison}
                disabled={scope === 'year'}
                rangeMode={scope === 'range'}
              />
            )}
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

        {data !== null && view !== 'websites' && scope === 'range' && (
          <DateRangeControls
            primary={dateRange}
            onPrimaryChange={(next) => {
              if (isValidDateRange(next)) setDateRange(next);
            }}
            comparison={comparisonRange}
            onComparisonChange={(next) => {
              if (isValidDateRange(next)) setComparisonRange(next);
            }}
            showComparison={comparison === 'custom'}
          />
        )}
      </header>

      {data !== null && (
        <div className="view-toggle-row">
          <ViewToggle value={view} onChange={setView} />
        </div>
      )}

      <main className="app-main">
        {renderMain({
          state,
          view,
          scope,
          month: selectedMonth,
          compareMonth,
          displayData,
          comparisonData,
          rangeLabel: scope === 'range' ? dateRangeLabel(dateRange) : null,
          comparisonRangeLabel: scope === 'range' && comparison === 'custom'
            ? dateRangeLabel(comparisonRange)
            : null,
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
  compareMonth,
  displayData,
  comparisonData,
  rangeLabel,
  comparisonRangeLabel,
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
  compareMonth: string | null;
  displayData: ApiDataResponse | null;
  comparisonData: ApiDataResponse | null;
  rangeLabel: string | null;
  comparisonRangeLabel: string | null;
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
      const activeData = displayData ?? state.data;
      if (view === 'websites') {
        return (
          <WebsitesContent
            data={activeData}
            month={month}
            order={order}
            today={today}
            onDrillDown={onDrillDown}
          />
        );
      }
      if (view === 'savings') {
        return (
          <SavingsView
            data={activeData}
            scopeMode={scope}
            month={month}
            compareMonth={compareMonth}
            comparisonData={comparisonData}
            rangeLabel={rangeLabel}
            comparisonRangeLabel={comparisonRangeLabel}
            order={order}
            today={today}
            refreshError={refreshError}
            onDrillDown={onDrillDown}
          />
        );
      }
      return (
        <SpendView
          data={activeData}
          scopeMode={scope}
          month={month}
          compareMonth={compareMonth}
          comparisonData={comparisonData}
          rangeLabel={rangeLabel}
          comparisonRangeLabel={comparisonRangeLabel}
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

function buildKpiComparison(
  label: string,
  current: number,
  baseline: number,
  tone: KpiComparison['tone'],
): KpiComparison {
  const change = Math.round((current - baseline) * 100) / 100;
  const direction: KpiComparison['direction'] = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
  const amountPrefix = change > 0 ? '+' : change < 0 ? '-' : '';
  const signedAmount = `${amountPrefix}${fmtEur(Math.abs(change))}`;
  const percent = baseline === 0 ? null : (change / baseline) * 100;
  const percentLabel = percent === null
    ? 'New'
    : `${percent > 0 ? '+' : ''}${percent.toFixed(1).replace(/\.0$/, '')}%`;

  return {
    label: `vs ${label}`,
    value: fmtEur(baseline),
    delta: `${signedAmount} · ${percentLabel}`,
    direction,
    tone,
  };
}

function buildRateComparison(
  label: string,
  current: number | null,
  baseline: number | null,
): KpiComparison | undefined {
  if (current === null || baseline === null) return undefined;
  const changePoints = (current - baseline) * 100;
  const direction: KpiComparison['direction'] = changePoints > 0
    ? 'up'
    : changePoints < 0
      ? 'down'
      : 'flat';
  return {
    label: `vs ${label}`,
    value: `${(baseline * 100).toFixed(1)}%`,
    delta: `${changePoints > 0 ? '+' : ''}${changePoints.toFixed(1)} pts`,
    direction,
    tone: 'favorable',
  };
}

function aggregateBreakdowns(items: MonthBreakdown[], key: string): MonthBreakdown {
  const totals = new Map<string, number>();
  for (const item of items) {
    for (const project of item.byProject) {
      totals.set(project.code, (totals.get(project.code) ?? 0) + project.value);
    }
  }
  const byProject = Array.from(totals.entries())
    .map(([code, value]) => ({ code, value: Math.round(value * 100) / 100 }))
    .sort((a, b) => b.value - a.value || a.code.localeCompare(b.code));
  return {
    m: key,
    total: Math.round(byProject.reduce((sum, item) => sum + item.value, 0) * 100) / 100,
    byProject,
  };
}

function rankProjectsFromBreakdowns(items: MonthBreakdown[]): Array<{ code: string; eur: number }> {
  const totals = new Map<string, number>();
  for (const breakdown of items) {
    for (const project of breakdown.byProject) {
      totals.set(project.code, (totals.get(project.code) ?? 0) + project.value);
    }
  }
  return Array.from(totals.entries())
    .map(([code, eur]) => ({ code, eur: Math.round(eur * 100) / 100 }))
    .filter((project) => project.eur > 0)
    .sort((a, b) => b.eur - a.eur || a.code.localeCompare(b.code));
}

interface SpendViewProps {
  data: ApiDataResponse;
  comparisonData: ApiDataResponse | null;
  scopeMode: Scope;
  month: string;
  compareMonth: string | null;
  rangeLabel: string | null;
  comparisonRangeLabel: string | null;
  order: string | null;
  orders: string[];
  today: string;
  refreshError: string | null;
  onDrillDown: (d: DrawerState) => void;
}

function SpendView({
  data,
  comparisonData,
  scopeMode,
  month,
  compareMonth,
  rangeLabel,
  comparisonRangeLabel,
  order,
  orders,
  today,
  refreshError,
  onDrillDown,
}: SpendViewProps): JSX.Element {
  const scope: SpendScope = {
    year: scopeMode === 'range' ? 'all' : REPORTING_YEAR,
    month: scopeMode === 'year' || scopeMode === 'range' ? 'all' : month,
    orderCode: order,
  };
  const minVisibleRows = scopeMode === 'range' ? 0 : MIN_VISIBLE_YEAR_ROWS;

  const summary = useMemo(
    () => spendInScope(data, scope, today, minVisibleRows),
    [data, scope.year, scope.month, scope.orderCode, today, minVisibleRows],
  );
  const comparisonSummary = useMemo(
    () => comparisonData !== null
      ? spendInScope(comparisonData, { year: 'all', month: 'all', orderCode: order }, today, 0)
      : compareMonth === null
        ? null
        : spendInScope(data, {
          year: REPORTING_YEAR,
          month: compareMonth,
          orderCode: order,
        }, today, MIN_VISIBLE_YEAR_ROWS),
    [data, comparisonData, compareMonth, order, today],
  );
  const breakdowns = useMemo(
    () => monthlyBreakdowns(data, scope, today, minVisibleRows),
    [data, scope.year, scope.month, scope.orderCode, today, minVisibleRows],
  );
  const comparisonBreakdowns = useMemo(
    () => comparisonData !== null
      ? monthlyBreakdowns(comparisonData, { year: 'all', month: 'all', orderCode: order }, today, 0)
      : compareMonth === null
        ? []
        : monthlyBreakdowns(data, {
          year: REPORTING_YEAR,
          month: compareMonth,
          orderCode: order,
        }, today, MIN_VISIBLE_YEAR_ROWS),
    [data, comparisonData, compareMonth, order, today],
  );
  const chartBreakdowns = useMemo(() => {
    if (comparisonData !== null) {
      return [
        aggregateBreakdowns(comparisonBreakdowns, 'Comparison'),
        aggregateBreakdowns(breakdowns, 'Selected'),
      ];
    }
    if (compareMonth === null || scopeMode === 'year') return breakdowns;

    const currentKey = `${REPORTING_YEAR}-${month}`;
    const comparisonKey = `${REPORTING_YEAR}-${compareMonth}`;
    const byMonth = new Map<string, MonthBreakdown>();
    for (const item of [...comparisonBreakdowns, ...breakdowns]) byMonth.set(item.m, item);

    return [comparisonKey, currentKey]
      .sort()
      .map((key) => byMonth.get(key) ?? { m: key, total: 0, byProject: [] });
  }, [breakdowns, comparisonBreakdowns, comparisonData, compareMonth, month, scopeMode]);
  const ranked = useMemo(() => rankProjectsFromBreakdowns(breakdowns), [breakdowns]);
  const comparisonRanked = useMemo(
    () => rankProjectsFromBreakdowns(comparisonBreakdowns),
    [comparisonBreakdowns],
  );
  const rowsSeries = useMemo(
    () => rowsDoneSeries(data, order, today, minVisibleRows),
    [data, order, today, minVisibleRows],
  );
  const comparisonRowsSeries = useMemo(
    () => comparisonData === null ? null : rowsDoneSeries(comparisonData, order, today, 0),
    [comparisonData, order, today],
  );
  const chartRowsSeries = useMemo(() => {
    if (comparisonRowsSeries !== null) {
      return {
        months: ['Comparison', 'Selected'],
        counts: [
          comparisonRowsSeries.counts.reduce((sum, count) => sum + count, 0),
          rowsSeries.counts.reduce((sum, count) => sum + count, 0),
        ],
        currentIndex: 1,
        comparisonIndex: 0,
      };
    }
    const currentKey = `${REPORTING_YEAR}-${month}`;
    const comparisonKey = compareMonth === null ? null : `${REPORTING_YEAR}-${compareMonth}`;
    const counts = new Map(rowsSeries.months.map((item, index) => [item, rowsSeries.counts[index] ?? 0]));
    counts.set(currentKey, counts.get(currentKey) ?? 0);
    if (comparisonKey !== null) counts.set(comparisonKey, counts.get(comparisonKey) ?? 0);
    const months = Array.from(counts.keys()).sort();
    return {
      months,
      counts: months.map((item) => counts.get(item) ?? 0),
      currentIndex: months.indexOf(currentKey),
      comparisonIndex: comparisonKey === null ? null : months.indexOf(comparisonKey),
    };
  }, [rowsSeries, comparisonRowsSeries, month, compareMonth]);

  const isSingleProj = order !== null;
  const periodLabel = scopeMode === 'year'
    ? '2026 Overall'
    : scopeMode === 'range' && rangeLabel !== null
      ? rangeLabel
      : scopeLabelFor({ year: REPORTING_YEAR, month });
  const scopeLabel = order !== null ? `${order} · ${periodLabel}` : periodLabel;
  const comparisonLabel = comparisonRangeLabel ?? (compareMonth === null
    ? null
    : scopeLabelFor({ year: REPORTING_YEAR, month: compareMonth }));
  const spendComparison = comparisonSummary === null || comparisonLabel === null
    ? undefined
    : buildKpiComparison(comparisonLabel, summary.eur, comparisonSummary.eur, 'neutral');
  const savingsComparison = comparisonSummary === null || comparisonLabel === null
    ? undefined
    : buildKpiComparison(
        comparisonLabel,
        summary.savings_eur,
        comparisonSummary.savings_eur,
        'favorable',
      );
  const drawerRows = useMemo(
    () => drillRowsForScope(
      data,
      order,
      scopeMode === 'year' || scopeMode === 'range' ? null : `${REPORTING_YEAR}-${month}`,
    ),
    [data, order, scopeMode, month],
  );
  const openHeadlineRows = (): void => {
    onDrillDown({ title: `${scopeLabel} — contributing rows`, rows: drawerRows });
  };

  const failedSources = data.per_source.filter((s) => s.status === 'failure');

  return (
    <>
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
          {...(spendComparison === undefined ? {} : { comparison: spendComparison })}
          onClick={openHeadlineRows}
        />
        <KpiCard
          label="Savings"
          accent="paid"
          tooltip="Click to see the same contributing 2026 invoices."
          value={fmtEur(summary.savings_eur)}
          sub={scopeLabel}
          {...(savingsComparison === undefined ? {} : { comparison: savingsComparison })}
          onClick={openHeadlineRows}
        />
      </section>

      <section className="grid-2">
        <Panel
          title={scopeMode === 'range' && comparisonData !== null ? 'Links built comparison' : 'Links built per month'}
          subtitle={scopeMode === 'range' && comparisonData !== null
            ? `${periodLabel} vs ${comparisonLabel ?? 'comparison'}`
            : `${chartRowsSeries.months.length} months${isSingleProj && order !== null ? ` · ${order}` : ''}`}
          {...(comparisonLabel === null ? {} : {
            legend: [
              { label: periodLabel, cls: 'legend__dot--current' },
              { label: comparisonLabel, cls: 'legend__dot--comparison' },
            ],
          })}
        >
          <LineChart
            data={chartRowsSeries.counts}
            labels={chartRowsSeries.months.map((m) => monthShortLabel(m))}
            currentIndex={chartRowsSeries.currentIndex}
            comparisonIndex={chartRowsSeries.comparisonIndex}
          />
        </Panel>
        <Panel
          title={scopeMode === 'range' && comparisonData !== null ? 'Spend comparison' : 'Spend per month'}
          subtitle={comparisonLabel === null
            ? `EUR · ${scopeLabel}`
            : `EUR · ${periodLabel} vs ${comparisonLabel}`}
          {...(comparisonLabel === null ? {} : {
            legend: [
              { label: periodLabel, cls: 'legend__dot--current' },
              { label: comparisonLabel, cls: 'legend__dot--comparison' },
            ],
          })}
        >
          <StackedBars
            data={chartBreakdowns}
            currentMonth={comparisonData !== null ? 'Selected' : scopeMode === 'month' ? `${REPORTING_YEAR}-${month}` : null}
            comparisonMonth={comparisonData !== null ? 'Comparison' : compareMonth === null ? null : `${REPORTING_YEAR}-${compareMonth}`}
          />
        </Panel>
      </section>

      {!isSingleProj && ranked.length > 1 && comparisonLabel === null && (
        <section className="grid-2">
          <Panel title="Projects by spend" subtitle={`${fmtNum(ranked.length)} active · ${scopeLabel}`}>
            <RankedBars rows={ranked.map((p) => ({ label: p.code, value: p.eur, sub: '' }))} accent="blue" formatValue={fmtEur} />
          </Panel>
          <Panel title="Spend distribution" subtitle={`Share of total · ${scopeLabel}`}>
            <DonutChart slices={ranked.map((p) => ({ label: p.code, value: p.eur }))} />
          </Panel>
        </section>
      )}

      {!isSingleProj && ranked.length > 1 && comparisonLabel !== null && (
        <>
          <section className="grid-2">
            <Panel title="Projects by spend — Selected" subtitle={`${fmtNum(ranked.length)} active · ${scopeLabel}`}>
              <RankedBars rows={ranked.map((p) => ({ label: p.code, value: p.eur, sub: '' }))} accent="blue" formatValue={fmtEur} />
            </Panel>
            <Panel title="Projects by spend — Comparison" subtitle={`${fmtNum(comparisonRanked.length)} active · ${comparisonLabel}`}>
              <RankedBars rows={comparisonRanked.map((p) => ({ label: p.code, value: p.eur, sub: '' }))} accent="ink" formatValue={fmtEur} />
            </Panel>
          </section>
          <section className="grid-2">
            <Panel title="Spend distribution — Selected" subtitle={`Share of total · ${scopeLabel}`}>
              <DonutChart slices={ranked.map((p) => ({ label: p.code, value: p.eur }))} />
            </Panel>
            <Panel title="Spend distribution — Comparison" subtitle={`Share of total · ${comparisonLabel}`}>
              <DonutChart slices={comparisonRanked.map((p) => ({ label: p.code, value: p.eur }))} />
            </Panel>
          </section>
        </>
      )}

      {/* orders is consumed by App for the filter; keep the reference so this
          stays available for downstream extensions. */}
      <span hidden>{orders.length}</span>
    </>
  );
}

/* ----------------------------------------------------------------------- */
/* SavingsView — link-level source savings with executive totals.             */
/* ----------------------------------------------------------------------- */

interface SavingsViewProps {
  data: ApiDataResponse;
  comparisonData: ApiDataResponse | null;
  scopeMode: Scope;
  month: string;
  compareMonth: string | null;
  rangeLabel: string | null;
  comparisonRangeLabel: string | null;
  order: string | null;
  today: string;
  refreshError: string | null;
  onDrillDown: (d: DrawerState) => void;
}

function SavingsView({
  data,
  comparisonData,
  scopeMode,
  month,
  compareMonth,
  rangeLabel,
  comparisonRangeLabel,
  order,
  today,
  refreshError,
  onDrillDown,
}: SavingsViewProps): JSX.Element {
  const scope: SpendScope = {
    year: scopeMode === 'range' ? 'all' : REPORTING_YEAR,
    month: scopeMode === 'year' || scopeMode === 'range' ? 'all' : month,
    orderCode: order,
  };
  const minVisibleRows = scopeMode === 'range' ? 0 : MIN_VISIBLE_YEAR_ROWS;
  const comparisonScope: SpendScope | null = comparisonData !== null
    ? { year: 'all', month: 'all', orderCode: order }
    : compareMonth === null
    ? null
    : { year: REPORTING_YEAR, month: compareMonth, orderCode: order };
  const summary = useMemo(
    () => savingsInScope(data, scope, today, minVisibleRows),
    [data, scope.year, scope.month, scope.orderCode, today, minVisibleRows],
  );
  const comparisonSummary = useMemo(
    () => comparisonScope === null
      ? null
      : savingsInScope(comparisonData ?? data, comparisonScope, today, comparisonData === null ? MIN_VISIBLE_YEAR_ROWS : 0),
    [data, comparisonData, comparisonScope?.year, comparisonScope?.month, comparisonScope?.orderCode, today],
  );
  const breakdowns = useMemo(
    () => savingsBreakdowns(data, scope, today, minVisibleRows),
    [data, scope.year, scope.month, scope.orderCode, today, minVisibleRows],
  );
  const comparisonBreakdowns = useMemo(
    () => comparisonScope === null
      ? []
      : savingsBreakdowns(comparisonData ?? data, comparisonScope, today, comparisonData === null ? MIN_VISIBLE_YEAR_ROWS : 0),
    [data, comparisonData, comparisonScope?.year, comparisonScope?.month, comparisonScope?.orderCode, today],
  );
  const chartBreakdowns = useMemo(() => {
    if (comparisonData !== null) {
      return [
        aggregateBreakdowns(comparisonBreakdowns, 'Comparison'),
        aggregateBreakdowns(breakdowns, 'Selected'),
      ];
    }
    if (compareMonth === null || scopeMode === 'year') return breakdowns;
    const currentKey = `${REPORTING_YEAR}-${month}`;
    const comparisonKey = `${REPORTING_YEAR}-${compareMonth}`;
    const byMonth = new Map<string, MonthBreakdown>();
    for (const item of [...comparisonBreakdowns, ...breakdowns]) byMonth.set(item.m, item);
    return [comparisonKey, currentKey]
      .sort()
      .map((key) => byMonth.get(key) ?? { m: key, total: 0, byProject: [] });
  }, [breakdowns, comparisonBreakdowns, comparisonData, compareMonth, month, scopeMode]);
  const ranked = useMemo(
    () => savingsByOrder(data, scope, today, minVisibleRows),
    [data, scope.year, scope.month, scope.orderCode, today, minVisibleRows],
  );
  const rows = useMemo(
    () => completedRowsInScope(data, scope, today, minVisibleRows),
    [data, scope.year, scope.month, scope.orderCode, today, minVisibleRows],
  );

  const periodLabel = scopeMode === 'year'
    ? '2026 Overall'
    : scopeMode === 'range' && rangeLabel !== null
      ? rangeLabel
      : scopeLabelFor({ year: REPORTING_YEAR, month });
  const scopeLabel = order === null ? periodLabel : `${order} · ${periodLabel}`;
  const comparisonLabel = comparisonRangeLabel ?? (compareMonth === null
    ? null
    : scopeLabelFor({ year: REPORTING_YEAR, month: compareMonth }));
  const comparisonFor = (
    current: number,
    baseline: number | undefined,
    tone: KpiComparison['tone'],
  ): KpiComparison | undefined => comparisonLabel === null || baseline === undefined
    ? undefined
    : buildKpiComparison(comparisonLabel, current, baseline, tone);
  const allRowsTitle = `${scopeLabel} — completed links`;
  const openAllRows = (): void => onDrillDown({ title: allRowsTitle, rows });
  const savedComparison = comparisonFor(summary.saved_eur, comparisonSummary?.saved_eur, 'favorable');
  const pressWhizzComparison = comparisonFor(
    summary.presswhizz_eur,
    comparisonSummary?.presswhizz_eur,
    'neutral',
  );
  const ourPriceComparison = comparisonFor(
    summary.our_price_eur,
    comparisonSummary?.our_price_eur,
    'neutral',
  );
  const rateComparison = comparisonLabel === null || comparisonSummary === null
    ? undefined
    : buildRateComparison(comparisonLabel, summary.saving_rate, comparisonSummary.saving_rate);

  return (
    <>
      <Briefing
        eyebrow={`SAVINGS · ${scopeLabel.toUpperCase()}`}
        title={`${scopeLabel} savings impact`}
        lede={`${fmtNum(summary.count)} completed links saved ${fmtEur(summary.saved_eur)} against the PressWhizz comparison prices supplied by the source report.`}
      />

      {refreshError !== null && (
        <div className="empty-state" role="alert">
          <h2>Refresh error</h2>
          <p>{refreshError}</p>
        </div>
      )}

      <section className="savings-hero" aria-label={`${scopeLabel} savings totals`}>
        <KpiCard
          label="Total Saved"
          accent="paid"
          tooltip="Supplied Saving (EUR), summed for the selected completed links."
          value={fmtEur(summary.saved_eur)}
          sub={scopeLabel}
          {...(savedComparison === undefined ? {} : { comparison: savedComparison })}
          onClick={openAllRows}
        />
        <KpiCard
          label="PressWhizz Equivalent"
          tooltip="Supplied PressWhizz Price (EUR); blank comparison cells are not estimated."
          value={fmtEur(summary.presswhizz_eur)}
          sub={`${fmtNum(summary.presswhizz_count)} priced links`}
          {...(pressWhizzComparison === undefined ? {} : { comparison: pressWhizzComparison })}
          onClick={openAllRows}
        />
        <KpiCard
          label="Our Price"
          tooltip="The source report's Price (EUR) for the same completed links."
          value={fmtEur(summary.our_price_eur)}
          sub={scopeLabel}
          {...(ourPriceComparison === undefined ? {} : { comparison: ourPriceComparison })}
          onClick={openAllRows}
        />
        <KpiCard
          label="Saving Rate"
          accent="paid"
          tooltip="Total supplied savings divided by total supplied PressWhizz price."
          value={summary.saving_rate === null ? '—' : `${(summary.saving_rate * 100).toFixed(1)}%`}
          sub="of PressWhizz equivalent"
          {...(rateComparison === undefined ? {} : { comparison: rateComparison })}
          onClick={openAllRows}
        />
      </section>

      <section className="grid-2">
        <Panel
          title={scopeMode === 'range' && comparisonData !== null ? 'Savings comparison' : 'Savings by month'}
          subtitle={comparisonLabel === null ? `EUR · ${scopeLabel}` : `EUR · ${periodLabel} vs ${comparisonLabel}`}
          {...(comparisonLabel === null ? {} : {
            legend: [
              { label: periodLabel, cls: 'legend__dot--current' },
              { label: comparisonLabel, cls: 'legend__dot--comparison' },
            ],
          })}
        >
          <StackedBars
            data={chartBreakdowns}
            currentMonth={comparisonData !== null ? 'Selected' : scopeMode === 'month' ? `${REPORTING_YEAR}-${month}` : null}
            comparisonMonth={comparisonData !== null ? 'Comparison' : compareMonth === null ? null : `${REPORTING_YEAR}-${compareMonth}`}
          />
        </Panel>
        <Panel title="Savings by order" subtitle={`${fmtNum(ranked.length)} orders · ${scopeLabel}`}>
          <RankedBars
            rows={ranked.map((item) => ({
              label: item.code,
              value: item.eur,
              sub: `${fmtNum(item.rows)} links`,
            }))}
            accent="blue"
            formatValue={fmtEur}
          />
        </Panel>
      </section>

      <Panel title="Savings by completed link" subtitle={`${fmtNum(rows.length)} links · ${scopeLabel}`}>
        <SavingsTable
          rows={rows}
          onDrillDown={(row) => onDrillDown({
            title: `${row.website ?? 'Completed link'} — savings detail`,
            rows: [row],
          })}
        />
      </Panel>
    </>
  );
}

/* ----------------------------------------------------------------------- */
/* WebsitesContent — one completed live link per row.                        */
/* ----------------------------------------------------------------------- */

function WebsitesContent({
  data,
  month,
  order,
  today,
  onDrillDown,
}: {
  data: ApiDataResponse;
  month: string;
  order: string | null;
  today: string;
  onDrillDown: (d: DrawerState) => void;
}): JSX.Element {
  const scope: SpendScope = { year: REPORTING_YEAR, month, orderCode: order };
  const rows = useMemo(
    () => liveUrlRowsInScope(data, scope, today, MIN_VISIBLE_YEAR_ROWS),
    [data, scope.year, scope.month, scope.orderCode, today],
  );
  const periodLabel = scopeLabelFor({ year: REPORTING_YEAR, month });
  const scopeLabel = order === null ? periodLabel : `${order} · ${periodLabel}`;
  return (
    <>
      <Briefing
        eyebrow={`LIVE URLS · ${scopeLabel.toUpperCase()}`}
        title="Completed live links"
        lede="Target URL, anchor text, publisher, live article, source price, and invoice date for every completed link in the selected month and order."
      />
      <Panel title="Live URLs" subtitle={`${fmtNum(rows.length)} links · ${scopeLabel}`}>
        <LiveUrlsTable
          rows={rows}
          onDrillDown={(row) => onDrillDown({
            title: `${row.website ?? 'Completed link'} — link detail`,
            rows: [row],
          })}
        />
      </Panel>
    </>
  );
}
