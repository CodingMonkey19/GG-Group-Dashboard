# Dashboard Filters and Comparisons Design

## Goal

Make the Live URLs table easy to narrow by any visible column, simplify the Spend view by removing the Rows Done, Paid, and Outstanding cards, and add GA4-style period comparisons without displaying or loading 2025 data.

## Live URLs filters

Add an always-visible filter row directly below the sortable column headers:

- **Live URL:** case-insensitive text search against the displayed live URL.
- **Current price (EUR):** independent minimum and maximum numeric inputs.
- **As of:** independent from and to date inputs, bounded to 2026.
- **History:** independent minimum and maximum invoice-count inputs.

Filtering happens locally in `WebsiteTable` before the existing sort is applied. Sorting, clickable live links, row drill-down, and the full unfiltered source list remain unchanged. An active-filter summary shows `X of 699 shown`, and one **Clear filters** action resets every column. If filters match nothing, the table shows a filtered-empty message with a reset action instead of the source-data empty state.

## Spend view simplification

Remove the entire supporting-metrics row containing:

- Rows Done
- Paid
- Outstanding

The Spend and Savings hero pair remains the primary summary. The briefing, charts, project rankings, distribution, and drill-down behavior stay intact.

## 2026-only comparison control

Add one global **Compare** selector beside Month and Project on the Spend view. Options are:

- **Off**
- **Previous month** when an earlier available 2026 month exists
- **A specific 2026 month**, excluding the currently selected month

The control is available only in Month scope. It is disabled and reset to Off in 2026 Total scope because an equal previous period would cross into 2025. No comparison option, label, selector, API response, or drill-down may expose 2025.

When comparison is active, both hero cards show:

- the comparison month and its EUR value;
- the absolute EUR change;
- the percentage change when the comparison value is non-zero;
- `New` instead of an infinite percentage when the comparison value is zero.

Positive savings change is styled as favorable. Spend change uses neutral blue styling because an increase is not inherently good or bad. Comparisons respect the currently selected Project, so an AG July card compares AG July against AG June or another selected 2026 month.

The existing monthly charts already provide the full 2026 trend, so they will not receive duplicate comparison overlays.

## Component and data flow

- `App` owns comparison mode/month state and renders the Compare selector only for the Spend view.
- `SpendView` derives the comparison scope through the existing `spendInScope` selector, using the selected project and comparison month.
- `KpiCard` receives optional comparison details and renders the compact delta line.
- `WebsiteTable` owns its column-filter state and derives filtered, then sorted, rows with memoized calculations.
- Shared CSS adds compact filter controls, active-filter status, filtered-empty treatment, and hero comparison deltas while preserving the current visual system and responsive layout.

## Edge cases

- Blank filter inputs impose no bound.
- Invalid numeric input is ignored until it becomes a valid number.
- Missing prices or dates never satisfy an active price or date bound.
- January has no Previous month option unless another earlier 2026 source month exists.
- A custom comparison month that disappears after refresh resets to Off.
- Zero comparison values never produce `Infinity%` or `NaN%`.
- Source refreshes retain the hard 2026-only boundary.

## Verification

After direct implementation:

- verify each column filter individually and in combination;
- verify Clear filters restores all 699 publishers;
- verify sorting and row drill-down still work after filtering;
- verify the three supporting cards are absent;
- verify Spend and Savings comparisons for All projects and one selected project;
- verify 2026 Total disables comparison;
- verify January/zero-baseline behavior;
- run frontend typecheck, tests, production build, and a browser check against the live dashboard.
