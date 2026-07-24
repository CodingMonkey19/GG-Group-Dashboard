# Dashboard Filters and Comparisons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add column filters to Live URLs, remove the three supporting KPI cards, and add 2026-only GA4-style Spend/Savings comparisons.

**Architecture:** Keep table filters local to `WebsiteTable`, because they only affect the already-derived publisher rows. Keep comparison selection in `App`, resolve it to one valid 2026 month, and pass the derived comparison summary into the existing Spend/Savings cards. No backend or snapshot contract changes are required.

**Tech Stack:** React 18, TypeScript, CSS, Vitest, Testing Library, Vite.

**Method note:** The user explicitly requested direct implementation without TDD. Production changes are made first; focused tests and the full verification suite follow afterward.

---

## File map

- Create `frontend/src/components/CompareSelector.tsx`: global comparison dropdown plus month-resolution helpers.
- Modify `frontend/src/components/KpiCard.tsx`: render optional comparison value and delta.
- Modify `frontend/src/components/WebsiteTable.tsx`: own filter state, derive filtered/sorted rows, render filter row and reset states.
- Modify `frontend/src/App.tsx`: own comparison selection, remove support cards, derive comparison summaries.
- Modify `frontend/src/styles.css`: filter-row, comparison-card, and responsive styles.
- Create `frontend/tests/components/WebsiteTable.test.tsx`: verify all four filters, combinations, reset, and filtered-empty state.
- Create `frontend/tests/components/CompareSelector.test.tsx`: verify 2026-only options and month resolution.
- Create `frontend/tests/components/KpiCard.test.tsx`: verify comparison rendering and zero-baseline `New` display.

### Task 1: Add the 2026-only comparison control

**Files:**
- Create: `frontend/src/components/CompareSelector.tsx`
- Modify: `frontend/src/App.tsx`

- [x] **Step 1: Create the comparison selection contract and resolver**

```tsx
export type ComparisonSelection = 'off' | 'previous' | `month:${string}`;

export function resolveComparisonMonth(
  selection: ComparisonSelection,
  currentMonth: string,
  availableMonths: string[],
): string | null {
  if (selection === 'off') return null;
  if (selection === 'previous') {
    const currentIndex = availableMonths.indexOf(currentMonth);
    return currentIndex > 0 ? availableMonths[currentIndex - 1] ?? null : null;
  }
  const candidate = selection.slice('month:'.length);
  return candidate !== currentMonth && availableMonths.includes(candidate) ? candidate : null;
}
```

- [x] **Step 2: Render a labeled Compare dropdown**

The dropdown uses `Off`, `Previous month`, and every available 2026 month other than the current month. It receives `disabled={scope === 'year'}` and renders only on the Spend view.

```tsx
<CompareSelector
  months={monthOptions}
  currentMonth={selectedMonth}
  value={comparison}
  onChange={setComparison}
  disabled={scope === 'year'}
/>
```

- [x] **Step 3: Reset invalid comparison state**

Add an effect in `App` that sets comparison to `off` when the scope changes to year or `resolveComparisonMonth(...)` returns `null` for a non-off selection.

### Task 2: Add comparison details to Spend and Savings

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/KpiCard.tsx`
- Modify: `frontend/src/styles.css`

- [x] **Step 1: Derive the comparison summary through the existing selector**

```tsx
const comparisonSummary = useMemo(
  () => compareMonth === null
    ? null
    : spendInScope(data, {
        year: REPORTING_YEAR,
        month: compareMonth,
        orderCode: order,
      }, today, MIN_VISIBLE_YEAR_ROWS),
  [data, compareMonth, order, today],
);
```

- [x] **Step 2: Build safe comparison display data**

Use one formatter that returns the comparison label/value, signed absolute EUR change, and percentage. When baseline is zero, return `New` instead of dividing.

```ts
function comparisonDelta(current: number, baseline: number): { change: number; percent: number | null } {
  return {
    change: Math.round((current - baseline) * 100) / 100,
    percent: baseline === 0 ? null : ((current - baseline) / baseline) * 100,
  };
}
```

- [x] **Step 3: Extend `KpiCard` with optional comparison content**

```ts
interface KpiComparison {
  label: string;
  value: string;
  delta: string;
  direction: 'up' | 'down' | 'flat';
  tone: 'neutral' | 'favorable';
}
```

Render `vs Jun 2026 · €…` and the signed delta under the main KPI value. Neutral Spend uses blue; Savings uses green for increases and red for decreases.

- [x] **Step 4: Remove the supporting KPI row**

Delete the `Rows Done`, `Paid`, and `Outstanding` card section and remove now-unused `outstandingEur`/`outstandingCount` calculations. Keep the briefing counts, hero cards, charts, and drill-downs.

### Task 3: Add per-column Live URLs filters

**Files:**
- Modify: `frontend/src/components/WebsiteTable.tsx`
- Modify: `frontend/src/styles.css`

- [x] **Step 1: Add local filter state and parsing helpers**

```tsx
const [urlFilter, setUrlFilter] = useState('');
const [priceMin, setPriceMin] = useState('');
const [priceMax, setPriceMax] = useState('');
const [dateFrom, setDateFrom] = useState('');
const [dateTo, setDateTo] = useState('');
const [historyMin, setHistoryMin] = useState('');
const [historyMax, setHistoryMax] = useState('');

function optionalNumber(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
```

- [x] **Step 2: Filter before the existing sort**

The memoized row derivation performs case-insensitive URL containment, inclusive numeric/date bounds, and excludes null price/date only when their matching bounds are active. The existing deterministic sort then runs on the filtered copy.

- [x] **Step 3: Render the filter row**

Add one labeled control group per column under the header buttons: URL search, price Min/Max, date From/To, and history Min/Max. Every control gets a unique accessible label and 2026 date bounds.

- [x] **Step 4: Render result status and reset behavior**

Show `X of Y shown` and a `Clear filters` button when any filter is active. When no row matches, show `No live URLs match these filters` plus the same reset action. The source-empty state remains unchanged when the input `rows` array is empty.

### Task 4: Add focused tests after implementation

**Files:**
- Create: `frontend/tests/components/WebsiteTable.test.tsx`
- Create: `frontend/tests/components/CompareSelector.test.tsx`
- Create: `frontend/tests/components/KpiCard.test.tsx`

- [x] **Step 1: Test table filtering and reset**

Render three `WebsiteCurrentPrice` fixtures, change each control with Testing Library, assert visible/hidden live URLs, combine filters, assert the filtered-empty message, click Clear filters, and assert all three rows return.

- [x] **Step 2: Test comparison selection**

Assert `resolveComparisonMonth('previous', '04', ['01', '03', '04']) === '03'`, invalid/current custom comparisons resolve to null, and the dropdown never renders a 2025 option.

- [x] **Step 3: Test KPI comparison display**

Render one ordinary comparison and one zero-baseline comparison; assert the month/value, signed delta, percentage, direction class, and `New` output.

- [x] **Step 4: Run focused verification**

Run: `npm test -- --run tests/components/WebsiteTable.test.tsx tests/components/CompareSelector.test.tsx tests/components/KpiCard.test.tsx`

Expected: all new component tests pass.

### Task 5: Full verification, browser QA, and commit

**Files:**
- Verify all modified frontend files and the approved design requirements.

- [x] **Step 1: Run frontend checks**

Run `npm run typecheck`, `npm test`, and `npm run build` from `frontend/`.

Expected: typecheck exits 0, every frontend test passes, and Vite produces `frontend/dist`.

- [x] **Step 2: Restart the local server and verify the live UI**

Refresh `http://127.0.0.1:8080/` and verify: all 699 rows restore after Clear filters; all four column filters work; supporting cards are absent; month/project comparisons update Spend and Savings; comparison is disabled for 2026 Total; no 2025 option or data is visible.

- [x] **Step 3: Review and commit**

Run `git diff --check`, review the focused diff, stage only the planned files, and commit with:

```bash
git commit -m "feat: add dashboard filters and comparisons"
```
