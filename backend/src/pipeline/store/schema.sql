-- GG Spend Dashboard — consolidated store schema (SQLite, v2).
-- See specs/001-spend-dashboard/data-model.md for the authoritative description.
-- Aggregation queries MUST filter `WHERE is_done=1 AND conversion_status='converted'`.

-- Connection-level pragmas (journal_mode, synchronous, foreign_keys) are owned
-- by openStore / openStagingStore in db.ts and intentionally NOT set here so
-- the staging file uses journal_mode=DELETE (single-file DB; no WAL sidecars
-- to strand across renameSync).
PRAGMA foreign_keys = ON;
PRAGMA user_version = 2;

-- ---------------------------------------------------------------------------
-- snapshot_metadata : exactly one row, proving this is a v2 2026 snapshot.
-- A refresh writes this in the same transaction as invoices/findings/completion.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS snapshot_metadata (
  singleton_id          INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  schema_version        INTEGER NOT NULL CHECK (schema_version = 2),
  reporting_year        INTEGER NOT NULL CHECK (reporting_year = 2026),
  source_spreadsheet_id TEXT    NOT NULL CHECK (length(trim(source_spreadsheet_id)) > 0),
  source_tab            TEXT    NOT NULL CHECK (length(trim(source_tab)) > 0)
);

-- ---------------------------------------------------------------------------
-- invoices : every ingested row that survived ingest (Done + non-Done).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Stable cross-refresh identity. Sole legal URL key for /api/artifact.
  source_row_key      TEXT    NOT NULL UNIQUE,
  invoice_id          TEXT,
  order_code          TEXT    NOT NULL,
  spreadsheet_id      TEXT    NOT NULL,
  tab_name            TEXT    NOT NULL,
  tab_name_raw        TEXT    NOT NULL,
  row_index           INTEGER NOT NULL,
  work_status         TEXT    NOT NULL,
  is_done             INTEGER NOT NULL CHECK (is_done IN (0, 1)),
  payment_status      TEXT    NOT NULL CHECK (payment_status IN ('paid','unpaid','unknown','missing')),
  invoice_type        TEXT    NOT NULL CHECK (invoice_type IN ('paypal','pdf','drive_pdf','intuit','text','missing')),
  artifact_ref        TEXT,
  artifact_status     TEXT    NOT NULL CHECK (artifact_status IN ('not_attempted','reachable','unreachable')),
  website             TEXT,
  website_raw         TEXT,
  -- Column L on the standard order sheet: where the published backlink
  -- lives on the publisher site. Nullable when the sheet has no value.
  live_url            TEXT,
  -- Conversion fields are NULLABLE — see conversion_status.
  native_amount       REAL,
  native_currency     TEXT,
  eur_amount          REAL,
  savings_eur         REAL    NOT NULL,
  ecb_rate            REAL,
  ecb_rate_as_of      TEXT,
  conversion_status   TEXT    NOT NULL CHECK (conversion_status IN (
                          'converted','missing_price','unparseable_amount',
                          'missing_currency','out_of_ecb_currency'
                        )),
  invoice_date        TEXT    NOT NULL CHECK (
                          invoice_date >= '2026-01-01' AND invoice_date < '2027-01-01'
                        ),
  invoice_month       TEXT    NOT NULL CHECK (
                          invoice_month GLOB '2026-0[1-9]'
                          OR invoice_month GLOB '2026-1[0-2]'
                        ),
  date_source         TEXT    NOT NULL CHECK (date_source IN ('sheet','artifact','undated')),
  audit_flags         TEXT    NOT NULL DEFAULT '[]',
  ingested_at         TEXT    NOT NULL
);

-- Indexes (per data-model.md):
CREATE INDEX IF NOT EXISTS idx_invoices_aggregable_month
  ON invoices (is_done, conversion_status, invoice_month);
CREATE INDEX IF NOT EXISTS idx_invoices_aggregable_order_month
  ON invoices (is_done, conversion_status, order_code, invoice_month);
CREATE INDEX IF NOT EXISTS idx_invoices_aggregable_order
  ON invoices (is_done, conversion_status, order_code);
CREATE INDEX IF NOT EXISTS idx_invoices_aggregable_website_date
  ON invoices (is_done, conversion_status, website, invoice_date);
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_id
  ON invoices (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoices_audit_status
  ON invoices (conversion_status, artifact_status);

-- ---------------------------------------------------------------------------
-- refresh_events : one row per consolidate.ts run.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT    NOT NULL,
  completed_at    TEXT,
  duration_ms     INTEGER,
  status          TEXT    NOT NULL CHECK (status IN ('in_progress','success','partial','failed')),
  triggered_by    TEXT    NOT NULL DEFAULT 'manual',
  per_source      TEXT    NOT NULL DEFAULT '[]',
  counters        TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_refresh_events_completed_at
  ON refresh_events (completed_at);

-- ---------------------------------------------------------------------------
-- audit_findings : data-quality findings emitted during the most-recent refresh.
-- Always emit every category key in the API layer (FR-022), even if zero rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_findings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  refresh_id      INTEGER NOT NULL REFERENCES refresh_events(id) ON DELETE CASCADE,
  category        TEXT    NOT NULL CHECK (category IN (
                      'non_done_row','missing_price','unparseable_amount','missing_currency',
                      'missing_invoice_url','missing_date',
                      'unknown_payment_status','missing_payment_status',
                      'duplicate_invoice_id','out_of_ecb_currency','future_dated_invoice',
                      'artifact_unreachable',
                      'pdf_extraction_failed','paypal_verification_mismatch'
                    )),
  source_row_key  TEXT    REFERENCES invoices(source_row_key) ON DELETE SET NULL,
  summary         TEXT    NOT NULL,
  eur_amount      REAL
);

CREATE INDEX IF NOT EXISTS idx_audit_findings_category
  ON audit_findings (category);
CREATE INDEX IF NOT EXISTS idx_audit_findings_refresh_id
  ON audit_findings (refresh_id);

-- ---------------------------------------------------------------------------
-- ecb_rates : local cache of ECB daily reference rates.
-- Convention: rate is units of `currency` per 1 EUR (ECB-native).
-- Conversion divides: eur_amount = native_amount / rate.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ecb_rates (
  date            TEXT    NOT NULL,
  currency        TEXT    NOT NULL,
  rate            REAL    NOT NULL CHECK (rate > 0),
  fetched_at      TEXT    NOT NULL,
  PRIMARY KEY (date, currency)
);

-- ---------------------------------------------------------------------------
-- v_website_current_price : derived view for the per-website current-price selector.
-- Returns one or more rows per distinct aggregable website:
--   • If the website has at least one dated Done+converted invoice, returns
--     every row tied at MAX(invoice_date) — the application picks the
--     deterministic winner per FR-014 (max row_index, then lexically-greatest
--     source_row_key).
--   • If the website has ONLY undated Done+converted invoices, returns ONE
--     row with all i.* columns NULL — the API surfaces the website with
--     current_price_eur=null ("unknown" per FR-014 / US4 acceptance scenario 2).
--
-- QA review H1 fix: previous version inner-joined the max-date subquery,
-- which silently dropped undated-only websites from the view entirely (T073
-- claimed pass without an integration test catching this). The LEFT JOIN
-- below preserves them.
-- ---------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS v_website_current_price AS
WITH website_set AS (
  SELECT DISTINCT website
  FROM invoices
  WHERE is_done = 1 AND conversion_status = 'converted' AND website IS NOT NULL
),
max_dates AS (
  SELECT website, MAX(invoice_date) AS max_date
  FROM invoices
  WHERE is_done = 1
    AND conversion_status = 'converted'
    AND website IS NOT NULL
    AND invoice_date IS NOT NULL
  GROUP BY website
)
SELECT
  ws.website,
  i.source_row_key,
  i.invoice_date,
  i.row_index,
  i.eur_amount,
  i.native_amount,
  i.native_currency
FROM website_set ws
LEFT JOIN max_dates md ON md.website = ws.website
LEFT JOIN invoices i
       ON i.website = ws.website
      AND i.is_done = 1
      AND i.conversion_status = 'converted'
      AND i.invoice_date IS NOT NULL
      AND i.invoice_date = md.max_date;
