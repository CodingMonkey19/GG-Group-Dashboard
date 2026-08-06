# Savings and Live URLs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an executive Savings view and rebuild the Live URLs view while preserving the source sheet's supplied numbers exactly.

**Architecture:** Extend the existing report-source pipeline and snapshot contract with target URL, anchor text, and PressWhizz price. Build the new views from completed snapshot rows using the dashboard's existing month, order, January-exclusion, and LiveSportsOdds-exclusion rules. Keep all calculations additive and derived only from supplied EUR fields.

**Tech Stack:** TypeScript, React, Express, SQLite, Vitest, Docker Compose

---

## Task 1: Carry the required source fields into the API snapshot

**Files:**
- Modify: `config/sheets.json`
- Modify: `backend/src/shared/contracts.ts`
- Modify: `backend/src/pipeline/ingest/sheet-adapter.ts`
- Modify: `backend/src/pipeline/ingest/report-source.ts`
- Modify: `backend/src/pipeline/normalize/index.ts`
- Modify: `backend/src/pipeline/store/schema.sql`
- Modify: `backend/src/pipeline/store/write.ts`
- Modify: `backend/src/pipeline/store/db.ts`
- Modify: `backend/src/api/data.ts`
- Modify: affected backend fixtures and assertions

- [x] Map `Target URL`, `Anchor`, and `PressWhizz Price (EUR)` from Clean Data.
- [x] Preserve blank PressWhizz prices as `null`; do not estimate them.
- [x] Store and expose the three fields on every invoice row.
- [x] Bump the snapshot/API schema so stale snapshots fail closed until refreshed.
- [x] Update affected fixtures and verify backend build/tests.

## Task 2: Add scoped selectors for Savings and Live URLs

**Files:**
- Modify: `frontend/src/lib/selectors.ts`
- Modify: affected selector tests

- [x] Add a shared completed-row selector respecting Month, Order, February-onward, and LiveSportsOdds exclusions.
- [x] Calculate Total Saved, PressWhizz Equivalent, Our Spend, and Saving Rate from the supplied source values.
- [x] Produce monthly and order savings breakdowns without recalculating source prices.
- [x] Produce link-level Savings rows and Live URL rows for the selected filters.
- [x] Verify the selector results against controlled fixtures.

## Task 3: Build the Savings tab

**Files:**
- Modify: `frontend/src/components/ViewToggle.tsx`
- Create: `frontend/src/components/SavingsTable.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`

- [x] Add `Savings` between Spend and Live URLs.
- [x] Add the executive Savings hero with the four approved values.
- [x] Add Savings by Month and Savings by Order charts using existing visual conventions.
- [x] Add the link-level table: Website, PressWhizz Price, Our Price, Saved, Saving %, Live URL.
- [x] Show blanks for missing PressWhizz price or an unavailable percentage.
- [x] Apply Month, Order, comparison, and scope controls to the Savings view where applicable.

## Task 4: Rebuild the Live URLs view

**Files:**
- Create: `frontend/src/components/LiveUrlsTable.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles.css`

- [x] Replace the publisher-history table with one completed link per row.
- [x] Use the exact column order: Target URL, Anchor Text, Website, Live URL, Price, Date.
- [x] Apply the global Month and Order filters.
- [x] Add useful column filters for URLs/text, price, and date.
- [x] Keep missing-live-URL rows out of this tab only.

## Task 5: Simplify the CEO drill-down

**Files:**
- Modify: `frontend/src/components/ProvenanceDrawer.tsx`
- Modify: affected component tests

- [x] Remove ECB Rate, Artifact, Sheet, and Source Row Key.
- [x] Add clickable Live Link and readable Anchor Text.
- [x] Retain only useful invoice context and safe fallbacks for missing values.

## Task 6: Verify, publish, and deploy

**Files:**
- Modify: `/Users/fared/.Codex/primer.md`

- [x] Run the backend and frontend verification suites and production builds.
- [x] Confirm totals remain identical to the current source-backed Feb–Jul snapshot.
- [x] Confirm January and LiveSportsOdds are absent.
- [x] Commit and push the implementation to `origin/main`.
- [x] Back up the live snapshot, rebuild the container, and re-consolidate from the Google Sheet.
- [x] Verify the live API contains the new fields and preserves all approved totals.
- [x] Check the live dashboard views and controls in the browser.
- [x] Update the handoff primer with the exact deployed state.
