# GG Group Dashboard

CEO-facing internal dashboard that consolidates invoice data from ~35
Google Sheets (mixed PDF + PayPal invoice artifacts) into one EUR view.

- **Frontend**: React 18 + Vite + TypeScript strict
- **Backend**: Fastify + better-sqlite3 + pdf-parse + zod, runs on Node 20
- **Source of truth**: a Drive folder of order workbooks read via the
  `gws` CLI authenticated as the operator
- **Deployment**: LAN-only; not exposed beyond the office network

## Prerequisites

1. **Node.js 20 LTS** on PATH.
2. **`gws` CLI installed and authenticated** as the operator account that
   owns / has access to the configured Drive folder. Verify with:
   ```bash
   gws auth status
   ```
3. **Network access** to `ecb.europa.eu` (daily reference rates) and to
   any PayPal / Drive PDF links referenced in your sheets.

## First-run

```bash
git clone https://github.com/CodingMonkey19/GG-Group-Dashboard.git
cd GG-Group-Dashboard

(cd backend  && npm install)
(cd frontend && npm install)
```

`config/sheets.json` already points at the production Drive folder.
Adjust if you're using a different folder.

## Run

```bash
./scripts/consolidate           # one-shot: pulls every sheet via gws,
                                # writes data/consolidated.sqlite
                                # (~6 min against the live folder)

(cd frontend && npm run build)  # produces frontend/dist/
./scripts/serve                 # Fastify on PORT (default 8080)
                                # binds to 0.0.0.0
open http://127.0.0.1:8080
```

For local hot-reload development:

```bash
./scripts/dev                   # backend watch + Vite dev server
                                # http://localhost:5173 (proxies /api to :8080)
```

## Test

```bash
(cd backend  && npm test)       # 280 unit + integration tests
(cd frontend && npm test)       # 84 unit + a11y + perf tests
(cd backend  && npx tsc --noEmit)
(cd frontend && npx tsc --noEmit)
```

## What the dashboard answers

- Monthly + lifetime spend across all orders (filterable by year × month × project)
- Per-publisher current price with full invoice history drill-down
- Click-to-drill provenance on every monetary figure
- All amounts shown in EUR, converted via ECB daily reference rates
  (sheet currency detected from cell content: `$70.00 USD`, `£40 GBP`,
  etc. are properly stamped before conversion)

## Operational rules

- **Sheets are the source of truth.** The dashboard reads sheets;
  corrections happen at the source. Refresh button re-runs the pipeline.
- **Column A = "Done"** is the only row-eligibility filter. Other status
  columns are informational.
- **Future-dated rows** (operator typos with the year set ahead) are
  hidden from the dashboard automatically but stay in the SQLite store
  for the developer to inspect.
- **Noise years** (years with fewer than 10 aggregable rows — typically
  year typos) are also hidden from filters and charts.
- **Currency**: non-EUR cells get ECB-converted via the rate published
  for the invoice's date (weekend / holiday → most recent prior rate).

## Repository layout

```
backend/                 # Fastify + pipeline
  src/
    api/                 # /api/data, /api/refresh (SSE), /api/artifact/:key
    pipeline/            # ingest → normalize → audit → store
      ingest/            # gws CLI wrapper (sole Google trust path)
      extract/           # PDF / Drive PDF / PayPal URL-string parsers
      normalize/         # currency, dates, status, source-row-key
      audit/             # data-quality finding aggregator
      store/             # SQLite schema + atomic-replace
    shared/              # zod contracts (re-exported by frontend)
  tests/

frontend/                # React 18 + Vite
  src/
    components/          # ViewToggle, KpiCard, LineChart, StackedBars,
                         # DonutChart, RankedBars, WebsiteTable,
                         # MonthSelector, OrderFilter, YearFilter,
                         # ProvenanceDrawer, Briefing, Panel, Alert
    lib/                 # api, contracts, selectors, format, palette,
                         # artifacts (XSS-defanged URL builder)
  tests/

config/
  sheets.json            # operator config: drive_folder_id + standard
                         # per-sheet column mapping

scripts/
  consolidate            # one-shot pipeline runner
  serve                  # API server (port 8080)
  dev                    # parallel backend (watch) + Vite dev

data/                    # runtime: consolidated.sqlite + ECB cache
                         # (gitignored)
```
