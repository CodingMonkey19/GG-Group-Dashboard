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

## Run (macOS / Linux)

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

## Run (Windows)

The `scripts/` directory contains POSIX shell scripts. On Windows you have
three options — pick whichever fits your workflow:

### Option A — PowerShell (recommended, no extra tools)

Run the underlying commands directly. Open **PowerShell** in the repo root:

```powershell
# Install dependencies (one-time)
cd backend
npm install
cd ..\frontend
npm install
cd ..

# One-shot consolidation (~6 min against the live folder)
npx --prefix backend tsx backend/src/pipeline/consolidate.ts

# Build the frontend bundle
cd frontend
npm run build
cd ..

# Start the API server (binds 127.0.0.1:8080 by default)
$env:PORT = "8080"
$env:HOST = "127.0.0.1"
$env:DATA_DIR = "$PWD\data"
$env:SHEETS_CONFIG = "$PWD\config\sheets.json"
$env:PDF_ROOT = "$PWD\data\pdfs"
npx --prefix backend tsx backend/src/api/server.ts

# In a separate browser window:
start http://127.0.0.1:8080
```

For local dev with hot-reload, open **two** PowerShell windows:

```powershell
# Window 1 — backend with watch
cd backend
$env:PORT = "8080"; $env:HOST = "127.0.0.1"
npx tsx watch src/api/server.ts

# Window 2 — Vite dev server (proxies /api to :8080)
cd frontend
npx vite
# then open http://localhost:5173
```

### Option B — Git Bash

If [Git for Windows](https://gitforwindows.org/) is installed, the bash
scripts in `scripts/` run unchanged:

```bash
./scripts/consolidate
./scripts/serve
./scripts/dev
```

### Option C — WSL 2

Inside WSL Ubuntu the macOS / Linux instructions above work as-is. This
is the most-tested path if you also intend to develop on the codebase.

### Windows prerequisites

- **Node.js 20 LTS** for Windows from <https://nodejs.org/>.
- **`gws` CLI** installed and authenticated. The CLI itself runs on
  Windows; the dashboard's pipeline shells out to it via
  `child_process.spawn`. Verify with `gws auth status` from PowerShell.
- **Build tools for `better-sqlite3`** (a native module): install the
  Windows Build Tools once via `npm install --global windows-build-tools`
  (run PowerShell as Administrator), or install Visual Studio Build
  Tools 2022 with the "Desktop development with C++" workload. Without
  this, `npm install` in `backend/` will fail compiling the SQLite
  binding.

## Test

```bash
(cd backend  && npm test)       # 280 unit + integration tests
(cd frontend && npm test)       # 84 unit + a11y + perf tests
(cd backend  && npx tsc --noEmit)
(cd frontend && npx tsc --noEmit)
```

On Windows / PowerShell, drop the parentheses:

```powershell
cd backend; npm test; cd ..
cd frontend; npm test; cd ..
```

## Deploy to a VPS

> ⚠️ **Security note.** v1 has **no in-app authentication**. The dashboard
> was designed for LAN-only deployment with network-level access control.
> Exposing it to the public internet from a VPS requires a reverse-proxy
> layer (Basic Auth + TLS) as a stop-gap until in-app auth ships in v2.
> Don't put this behind only HTTP on a public IP.

### 1. VPS prerequisites (Ubuntu 22.04 / 24.04 LTS)

```bash
# As root or with sudo
apt update && apt install -y curl git build-essential nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v          # should be v20.x
```

### 2. Install + authenticate `gws` on the VPS

The pipeline shells out to `gws` on every consolidate, so the CLI must
be present and authenticated as the operator account that has access to
the Drive folder. Follow the operator's `gws` install + auth steps.
Verify:

```bash
gws auth status  # must show the operator email, e.g. faredwrites@gmail.com
```

### 3. Application user + clone

```bash
adduser --system --group --home /opt/gg-dashboard dashboard
sudo -u dashboard -H bash <<'EOF'
cd /opt/gg-dashboard
git clone https://github.com/CodingMonkey19/GG-Group-Dashboard.git app
cd app
(cd backend  && npm ci)
(cd frontend && npm ci)
(cd frontend && npm run build)
EOF
```

### 4. First consolidation

```bash
sudo -u dashboard -H bash -c 'cd /opt/gg-dashboard/app && ./scripts/consolidate'
```

This pulls every sheet via `gws`, writes
`/opt/gg-dashboard/app/data/consolidated.sqlite` (~25 MB), and the
backend has data to serve.

### 5. systemd unit for the API server

Create `/etc/systemd/system/gg-dashboard.service`:

```ini
[Unit]
Description=GG Group Dashboard API
After=network.target

[Service]
Type=simple
User=dashboard
Group=dashboard
WorkingDirectory=/opt/gg-dashboard/app
Environment=PORT=8080
Environment=HOST=127.0.0.1
Environment=NODE_ENV=production
Environment=DATA_DIR=/opt/gg-dashboard/app/data
Environment=SHEETS_CONFIG=/opt/gg-dashboard/app/config/sheets.json
Environment=PDF_ROOT=/opt/gg-dashboard/app/data/pdfs
ExecStart=/usr/bin/env -- /usr/bin/node /opt/gg-dashboard/app/backend/node_modules/.bin/tsx /opt/gg-dashboard/app/backend/src/api/server.ts
Restart=on-failure
RestartSec=5
# Hardening
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=/opt/gg-dashboard/app/data /opt/gg-dashboard/logs

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now gg-dashboard
systemctl status gg-dashboard      # confirm "active (running)"
curl -fsS http://127.0.0.1:8080/healthz
```

### 6. nginx reverse proxy + TLS + Basic Auth

Generate the htpasswd (replace `ceo` with the operator's username):

```bash
apt install -y apache2-utils
htpasswd -c /etc/nginx/.htpasswd ceo
```

Create `/etc/nginx/sites-available/gg-dashboard`:

```nginx
server {
  listen 80;
  server_name dashboard.example.com;
  # Let's Encrypt http-01 challenge lives here; everything else redirects
  location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
  location / { return 301 https://$host$request_uri; }
}

server {
  listen 443 ssl http2;
  server_name dashboard.example.com;

  ssl_certificate     /etc/letsencrypt/live/dashboard.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/dashboard.example.com/privkey.pem;

  # Stop-gap auth until v2 in-app auth ships.
  auth_basic            "GG Dashboard";
  auth_basic_user_file  /etc/nginx/.htpasswd;

  # SSE: disable proxy buffering, raise read timeout — consolidate can
  # take ~6 minutes and the /api/refresh stream needs to flow live.
  proxy_buffering         off;
  proxy_read_timeout      1h;
  proxy_send_timeout      1h;

  client_max_body_size    2m;

  location / {
    proxy_pass         http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto https;
  }
}
```

Enable + reload:

```bash
ln -s /etc/nginx/sites-available/gg-dashboard /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

Get a TLS certificate via certbot:

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d dashboard.example.com
```

### 7. Firewall

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

### 8. Scheduled daily consolidation

Add a cron job for the `dashboard` user:

```bash
sudo -u dashboard crontab -e
```

```cron
# Every day at 06:00 UTC, refresh the consolidated store from the Drive folder.
0 6 * * * cd /opt/gg-dashboard/app && ./scripts/consolidate >> /opt/gg-dashboard/logs/consolidate.log 2>&1
```

```bash
mkdir -p /opt/gg-dashboard/logs
chown dashboard:dashboard /opt/gg-dashboard/logs
```

### 9. Backup

The whole store is one SQLite file. Back it up nightly with a simple cron:

```cron
30 6 * * * sqlite3 /opt/gg-dashboard/app/data/consolidated.sqlite ".backup '/opt/gg-dashboard/backups/store-$(date +\%Y-\%m-\%d).sqlite'"
```

Rotate older than 30 days as needed.

### 10. Deploy updates

```bash
sudo -u dashboard -H bash <<'EOF'
cd /opt/gg-dashboard/app
git pull --ff-only
(cd backend  && npm ci)
(cd frontend && npm ci && npm run build)
EOF
systemctl restart gg-dashboard   # @fastify/static caches the dist file
                                 # list at registration; a restart is
                                 # required after every frontend rebuild.
```

### Things to verify after deploy

1. `https://dashboard.example.com/healthz` → `{"status":"ok"}`
2. Basic Auth prompt appears before the page loads.
3. After signing in, the dashboard renders with the latest snapshot.
4. Click **Refresh** — SSE stream completes without the proxy buffering it.
5. Open browser DevTools, **Network** tab → no mixed-content warnings,
   HSTS enabled, all assets over HTTPS.

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
