# External Integrations

**Analysis Date:** 2026-03-23

## APIs & External Services

**Options Data (Primary):**
- ORATS Data API — options chains, Greeks, IV, IV percentiles, earnings, implied moves, historical cores
  - SDK/Client: `lib/orats-client.js` (custom ESM client, no SDK)
  - Base URL: `https://api.orats.io/datav2`
  - Auth: `ORATS_API_TOKEN` query param
  - Rate limit: 1000 RPM (configurable via `ORATS_RATE_LIMIT_RPM`)
  - Features: in-memory cache (60s general, 10min historical), in-flight dedup, rate limiter
  - Endpoints used: `/strikes` (chains), `/hist/strikes` (historical), `/cores` (summary metrics)

**Stock Candle Data:**
- Tiingo API — OHLCV daily candles + IEX intraday candles
  - SDK/Client: `lib/tiingo-client.js` (custom ESM client, no SDK)
  - Base URL: `https://api.tiingo.com` (daily), `https://api.tiingo.com/iex` (intraday)
  - Auth: `TIINGO_API_TOKEN` bearer header
  - Rate limit: 50 RPM free tier (configurable via `TIINGO_RATE_LIMIT_RPM`)
  - Free tier limits: 50 req/hr, 1000/day, 500 unique symbols/month, **2000 ticks/request** (intraday)
  - Features: in-flight dedup, rate limiter
  - Functions: `getDailyCandles()`, `get5MinCandles()`, `getIntradayNMinCandles()` (10/15/30-min bars)
  - **130M aggregation**: 10-min IEX bars aggregated to 3×130-minute blocks per session via `aggregate5MinTo130M()` / `aggregateMinuteTo130M()` in `api/backtest-data.js` and `api/cron-signal-scan.js`
  - **Supabase cache**: 130M candles cached in `stock_candles` table with block-encoded timeframe (`130M_0`, `130M_1`, `130M_2`). Cache-first pattern: check Supabase → 10-min top-up if stale → 1H fallback (approximate, `source: 'tiingo-iex-130m-approx'`)

**Options Quotes (Dev/Fallback):**
- CBOE Delayed Quotes — used in Vite dev server shims and `api/check-alerts.js`, `api/daily-recap.js`
  - No auth required (public endpoint)
  - Base URL: `https://cdn.cboe.com/api/global/delayed_quotes/options/{TICKER}.json`
  - Used directly via `fetch()` with spoofed `User-Agent`/`Referer` headers

**Earnings Data (Dev only):**
- Nasdaq API — earnings date scraping in Vite dev server shim for `/api/earnings`
  - No auth required
  - Base URL: `https://api.nasdaq.com/api/quote/{SYMBOL}/info?assetclass=stocks`

## Data Storage

**Databases:**
- Supabase (PostgreSQL) — primary application database
  - Connection (frontend): hardcoded URL + anon key in `src/lib/utils.ts`; also `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
  - Connection (API routes): `SUPABASE_URL` + `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`
  - Client (frontend): `@supabase/supabase-js` createClient in `src/lib/supabase.ts`
  - Client (most API routes): raw `fetch()` against Supabase REST API with `apikey` header
  - Client (cron-iv): `@supabase/supabase-js` createClient in `api/cron-iv.js`
  - Tables: `positions`, `transactions`, `position_greeks_history`, `ticker_iv_snapshots`, `app_settings`, `candidate_snapshots`, `stock_candles`, `signal_history`, `orats_iv_cache`, `score_history`, `trade_outcomes`
  - Migrations: `supabase/migrations/` (6 migration files covering tables 008–015)
  - Local dev: Supabase CLI config at `supabase/config.toml` (project_id: trading-journal)

**File Storage (SQLite):**
- `better-sqlite3` local SQLite at `data/option-chains.sqlite`
  - Used by: `src/lib/backtest/chain-cache.ts`
  - Purpose: immutable cache for ORATS historical option chains (backtesting only)
  - Dev-only: not available in Vercel serverless environment

**Caching:**
- In-memory Map caches in `lib/orats-client.js` (60s TTL general, 10min TTL historical)
- SQLite at `data/option-chains.sqlite` for ORATS chain data (persistent, immutable once cached)

## Authentication & Identity

**Auth Provider:**
- Supabase Auth — session-based authentication
  - Implementation: `src/context/AuthContext.tsx` wraps `supabase.auth.getSession()` and `supabase.auth.onAuthStateChange()`
  - Session exposed via `useAuth()` hook throughout frontend
  - Logout: `supabase.auth.signOut()`

**Cron Security:**
- `CRON_SECRET` — bearer token checked by cron endpoints to prevent unauthorized triggers
  - Used in: `api/check-alerts.js`, `api/daily-recap.js`, `api/cron-signal-scan.js`, `api/cron-trade-outcomes.js`

## Monitoring & Observability

**Error Tracking:**
- None (no Sentry or similar)

**Logs:**
- `console.log` / `console.warn` / `console.error` throughout API routes (visible in Vercel function logs)
- Debug append-log at `.cursor/debug.log` via `_dbg()` in `api/strategy-recommend.js` (dev artifact)

## CI/CD & Deployment

**Hosting:**
- Vercel — production deployment
  - Config: `vercel.json` (framework: vite, outputDirectory: dist)
  - SPA rewrite: all non-asset paths → `index.html`
  - URL rewrites: `/api/option-price` → `/api/option-prices`, `/api/option-prices-bulk` → `/api/option-prices`
  - Function timeouts: 10–120s depending on endpoint (longest: `api/cron-iv.js` at 120s)

**CI Pipeline:**
- GitHub Actions — `.github/workflows/ci.yml`
  - Triggers: push and pull_request
  - Steps: `npm ci` → `npm run lint` → `npm run build` → `npm run test`
  - Node.js 20, npm cache enabled

## Environment Configuration

**Required env vars:**
- `ORATS_API_TOKEN` — ORATS Data API authentication
- `TIINGO_API_TOKEN` — Tiingo stock data authentication
- `SUPABASE_URL` — Supabase project URL (API routes)
- `SUPABASE_ANON_KEY` — Supabase anon key (API routes + fallback frontend)
- `SUPABASE_SERVICE_ROLE_KEY` — elevated key for write operations in crons
- `DISCORD_WEBHOOK_URL` — Discord webhook for alerts and daily recap
- `CRON_SECRET` — bearer token for cron endpoint authentication
- `DATA_SOURCE` — set to `ORATS` to use ORATS (vs legacy CBOE path)

**Optional env vars:**
- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — frontend-exposed Supabase credentials
- `ORATS_RATE_LIMIT_RPM` — override ORATS rate limit (default 1000)
- `TIINGO_RATE_LIMIT_RPM` — override Tiingo rate limit (default 50)

**Secrets location:**
- `.env` and `.env.local` (both gitignored); `.env.local` takes precedence in `lib/` clients
- Note: `SUPABASE_URL` and anon key are also hardcoded in `src/lib/utils.ts` as public fallbacks

## Webhooks & Callbacks

**Incoming (Cron triggers):**
- `GET /api/cron-iv?job=backfill` — Vercel cron at `0 22 * * 1-5` (22:00 UTC weekdays)
- `GET /api/cron-signal-scan` — external cronjobs.org at 21:00 UTC weekdays
- `GET /api/cron-trade-outcomes` — external cronjobs.org at 21:35 UTC weekdays
- `GET /api/check-alerts` — external cronjobs.org (every ~15 minutes during market hours)
- `GET /api/daily-recap` — external cronjobs.org at 21:30 UTC weekdays

**Outgoing:**
- Discord webhook (`DISCORD_WEBHOOK_URL`) — POSTed by `api/check-alerts.js`, `api/daily-recap.js`, `api/cron-signal-scan.js`

**Realtime:**
- Supabase Realtime channels — subscribed in frontend via `useRealtimeInvalidation` hook; triggers `queryClient.invalidateQueries` on DB changes

---

*Integration audit: 2026-03-23*
