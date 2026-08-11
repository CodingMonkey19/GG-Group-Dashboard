# Custom Date-Range Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inclusive calendar date ranges for viewing and comparing dashboard spend, savings, links, projects, and charts.

**Architecture:** App owns primary and comparison `DateRange` state. A small date-range utility validates, labels, and filters the immutable API snapshot; existing selectors then calculate every KPI and breakdown from the filtered snapshots. Custom comparisons render two aggregate chart points labeled Selected and Comparison so arbitrary partial periods remain directly comparable.

**Tech Stack:** React 18, TypeScript, native date inputs, existing selector and SVG chart components.

---

### Task 1: Date-range model and controls

**Files:**
- Create: `frontend/src/lib/dateRanges.ts`
- Create: `frontend/src/components/DateRangeControls.tsx`
- Modify: `frontend/src/components/ScopeToggle.tsx`
- Modify: `frontend/src/components/CompareSelector.tsx`
- Modify: `frontend/src/styles.css`

- [ ] Add `DateRange { from: string; to: string }`, inclusive validation, a concise display label, previous-equal-period calculation, and immutable API snapshot filtering by `invoice_date`.
- [ ] Extend `Scope` with `range` and render a `Custom period` scope button.
- [ ] Extend `ComparisonSelection` with `custom`; in range mode show only `Off` and `Custom period`.
- [ ] Render primary From/To native date fields and comparison From/To fields only when comparison is enabled. Constrain all fields to `2026-01-01` through `2026-07-31`.
- [ ] Style the date row to match the existing filter controls and wrap cleanly on narrow screens.

### Task 2: Apply exact ranges to dashboard calculations

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] Initialize the primary range from the selected month and initialize comparison to the immediately preceding equal-length period.
- [ ] Filter the API snapshot before `renderMain` when custom scope is selected; keep the original snapshot for refresh/source status.
- [ ] Pass optional filtered comparison data and concise range labels into Spend and Savings views.
- [ ] Use `SpendScope { year: 'all', month: 'all', orderCode }` for range-filtered snapshots so every existing KPI, ranking, and drill-down selector consumes the same exact rows.
- [ ] In custom comparison mode, turn each range's monthly breakdowns into one aggregate chart point (`Selected`, `Comparison`) and use the same filtered row counts for the links chart.
- [ ] Preserve existing month comparisons and the `2026 Overall` view unchanged.

### Task 3: Verify and deploy

**Files:**
- Modify: `docs/superpowers/plans/2026-08-11-custom-date-range-comparison.md`

- [ ] Run `npm run typecheck` in `frontend`; expect exit code 0.
- [ ] Run `npm run build` in `frontend`; expect a successful Vite production build.
- [ ] Confirm source contains no stale `Feb–Dec 2026` or `Jan–Jul 2026` visible labels.
- [ ] Commit and push the feature to `main`.
- [ ] Rebuild and recreate the production `gg-dashboard` container with `docker compose -f docker-compose.vps.yml build` and `up -d`.
- [ ] Verify the container is healthy, deployed commit matches `main`, the bundle contains `Custom period`, and `/api/data` still contains only January–July 2026 source rows.
