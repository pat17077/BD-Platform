# BD-Platform

Internal sales-trading platform for fixed income — real-time market color, spread analytics, new-issue feed, and a client-facing yield site. All data is live (no dummy values): FRED for rates and OAS, TreasuryDirect for auctions, FHLB Office of Finance + FFCB for agency new issues, ECB SDW for Eurozone curve, BBC/CNBC/MarketWatch/WSJ RSS for news, and Anthropic Claude for synthesis.

## Two front ends, one server

| URL | Audience | What it has |
|---|---|---|
| `/` | Internal sales desk | Inventory with markup analytics, offer-price → YTM, money-market converter, markup simulator, real TRACE log, NIM2 new-issue feed, full market color & central-bank outlook |
| `/client` | End clients | Same market color, indicative yields, real per-CUSIP offerings, money-market converter — markup info stripped |

A "Client view ↗" button in the internal nav opens the client page in a new tab.

## Requirements

- **Node.js 20+** (works on 18+ but 20 is what's deployed; uses `node-fetch` v2)
- A free **FRED API key** — https://fred.stlouisfed.org/docs/api/api_key.html
- An **Anthropic API key** for the AI market-color synthesis — https://console.anthropic.com (without it, blurbs will be missing but all live data still works)
- An **internal token** — any random string used to gate `/api/internal/*` endpoints; must match the constant in `index.html` so the desk app can call those endpoints

## Run locally

```bash
# 1. Clone + install
git clone https://github.com/pat17077/BD-Platform.git
cd BD-Platform
npm install

# 2. Configure secrets — copy the template and fill in your keys
cp .env.example .env
# Edit .env and set FRED_API_KEY, ANTHROPIC_API_KEY, INTERNAL_TOKEN

# 3. Make sure index.html's INTERNAL_TOKEN matches the one in .env
#    (search index.html for `const INTERNAL_TOKEN = '...'`)

# 4. Launch
./start.sh
```

`start.sh` handles the annoying parts for you:
- Loads `.env`
- Finds Node even when nvm isn't in your shell PATH
- Frees port 3001 if a previous server is still bound to it
- Verifies the `INTERNAL_TOKEN` env var matches the constant in `index.html` before booting (catches the silent-401 bug)
- Prints a startup banner so you can see what was loaded

If you'd rather run node directly:

```bash
FRED_API_KEY=… ANTHROPIC_API_KEY=… INTERNAL_TOKEN=… node server.js
```

Server starts on `http://localhost:3001` and logs the data-source startup sequence:

```
[startup] Loading initial data...
[curve] Updated: 11 points
[econ] Updated: 7 indicators
[spreads] Updated: 7 series
[quality] Updated: 7 buckets
[policy] Updated: 5 rates
[ecb-curve] Updated: 5 tenors
[foreign] Updated: 4 benchmarks
[cb-news] Updated: fed=6 ecb=6 boe=6
[news] Updated: <N> headlines from 6 sources
[risk] Updated: 5 indicators
[outlook] Generated successfully
[startup] Ready.
```

Then open:
- **Internal**: http://localhost:3001/
- **Client**:   http://localhost:3001/client

Login on the internal page is `desk` / `demo123` (placeholder demo creds — swap before sharing).

> ⚠️ The `INTERNAL_TOKEN` you set as the env var **must** match the constant near the top of `index.html` (look for `const INTERNAL_TOKEN = '...'`). If they differ, you'll get 401 errors on the desk app.

## Run with auto-reload during development

```bash
npm run dev
```

Uses `nodemon` to restart the server on file changes.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `FRED_API_KEY` | yes | FRED economic data |
| `ANTHROPIC_API_KEY` | optional | Claude AI synthesis (market color blurbs); platform works without it but blurbs will be empty |
| `INTERNAL_TOKEN` | yes | Auth gate for `/api/internal/*`; must match the value baked into `index.html` |
| `PORT` | optional | Default `3001`; Render injects this automatically |

## Project layout

```
.
├── server.js          Express backend — all data fetchers + endpoints + cron
├── index.html         Internal desk app (markup, simulator, NIM2, market color)
├── client.html        Client-facing site (no markup info)
├── package.json
└── .gitignore
```

Both HTML files are served by the Express app — there's no separate front-end build step.

## Endpoints

**Public (no auth)**
- `GET /api/curve` — Treasury yield curve
- `GET /api/econ` — economic indicators (CPI, PCE, NFP, GDP, etc.)
- `GET /api/outlook` — long-form weekly AI outlook
- `GET /api/public/inventory` — products + per-CUSIP offerings (markup stripped)
- `GET /api/public/market-color` — per-asset-class blurbs, central-bank outlook, cross-border, headlines
- `GET /api/public/money-market` — sub-1yr inventory in DR / MMY / BEY conventions
- `POST /api/mm/convert` — discount-note math (DR ↔ Price ↔ MMY ↔ BEY)
- `POST /api/yield/calculate` — bond YTM / YTC / YTW solver

**Internal (`x-internal-token` header required)**
- `GET /api/internal/products` — full inventory with markup, dealer cost, street ranges
- `GET /api/internal/new-issues` — combined FHLB / FFCB / Treasury new issues
- `GET /api/internal/trace` — TRACE-style prints (real Treasury auctions + live OAS-derived corp)
- `GET /api/internal/econ/full` — full economic dataset
- `POST /api/internal/outlook/refresh` — force-regenerate the long outlook
- `POST /api/internal/market-color/refresh` — force-regenerate the synthesized market color

## Deploy to Render

The repo is set up to deploy as-is. On https://dashboard.render.com:

1. **New** → **Web Service** → connect this GitHub repo
2. Build command: `npm install`, Start command: `node server.js`
3. Add the four env vars (`FRED_API_KEY`, `ANTHROPIC_API_KEY`, `INTERNAL_TOKEN`, `NODE_VERSION=20`) — do NOT set `PORT`, Render injects it
4. Plan: Free is fine to demo; the free tier sleeps after 15 min of inactivity (use UptimeRobot to keep awake or upgrade to $7/mo)

After deploy you'll get `https://<your-service>.onrender.com/` (internal) and `/client` (client view).

## Data refresh

Hourly cron in-process refreshes everything quantitative (curve, OAS, news, risk indicators). The Claude-generated market color blurbs refresh once daily at 7am ET to control API cost; the long AI outlook refreshes weekly. Both have manual force-refresh endpoints listed above.

## Troubleshooting

| Problem | Fix |
|---|---|
| `bash: node: command not found` | nvm isn't loaded in your shell. On macOS, `nvm` lives in `~/.bashrc` but Terminal loads `~/.bash_profile`. Either run `source ~/.bashrc` in the current shell, or add `[[ -f ~/.bashrc ]] && source ~/.bashrc` to `~/.bash_profile` so it auto-loads |
| `Cannot reach backend` on the page | Server isn't running on the expected port, or `INTERNAL_TOKEN` mismatch — check both env var and the constant in `index.html` |
| Blurbs empty / "Outlook unavailable" | `ANTHROPIC_API_KEY` not set or invalid — quantitative data still works without it |
| `[fred] <SERIES> error` in logs | FRED rate limit or transient error; the server retries 3× with backoff. Persistent errors usually mean a wrong key |
| Cold start takes ~30s on Render free tier | Expected — free tier sleeps. Upgrade plan or ping with UptimeRobot |
