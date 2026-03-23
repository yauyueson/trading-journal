# Trading Journal — Gemini Context

## Multi-AI Team Protocol

You are **The Analyst** in a two-engine team. Read `.handoff/TEAM.md` for full protocol.

Before starting any task:
1. Check `.handoff/current.md` — if it exists and is assigned to you, that's your task
2. Read all sections before acting

When analyzing or planning:
- Write your output to `.handoff/current.md` using the standard schema in `.handoff/TEAM.md`
- Be specific: name files, line numbers, function names
- When proposing architecture, include trade-offs and your recommendation
- Set the next owner to `claude` if implementation is needed

When reviewing code:
- Focus on logic, architecture, and correctness
- Don't worry about style polish — Claude handles final quality

## Project Context

Options trading journal: React 18 + Vite 5 + React Router v6 + React Query v5 frontend, Vercel API routes (ESM .js), Supabase DB.

For full project context (key files, database tables, testing, architecture), read `.handoff/TEAM.md` which contains shared context both engines use. Do NOT read CLAUDE.md — it contains Claude-specific instructions.

### Key Architecture

- **Routing**: React Router v6, lazy-loaded pages (`src/router.tsx`)
- **Data**: React Query v5 (staleTime 30s, gcTime 5min). Pages fetch via hooks.
- **Mutations**: `src/hooks/usePositionMutations.ts` — 11 mutation hooks
- **Realtime**: Supabase channels -> `useRealtimeInvalidation`
- **Contexts**: AuthContext, BuyModalContext, AppSettingsContext
- **Data providers**: ORATS (options chains/Greeks/IV) + Tiingo (stock candles)

### Key Files

| File | Purpose |
|------|---------|
| `src/lib/oss-core.ts` | TypeScript scoring source (frontend) |
| `lib/_shared/scoring.cjs` | CJS mirror of oss-core.ts (API) — MUST stay in sync |
| `src/router.tsx` | React Router route config |
| `src/layouts/AppLayout.tsx` | Shell (Header + TabNav + Outlet) |
| `src/hooks/usePositionMutations.ts` | 11 mutation hooks |
| `lib/orats-client.js` | ORATS options data client |
| `lib/tiingo-client.js` | Tiingo stock candle client |
| `api/strategy-recommend.js` | Main strategy recommendation API |
| `api/scan-options.js` | Options scanner API |
| `api/cron-signal-scan.js` | Daily signal scanner cron (21:00 UTC weekdays) |
| `api/cron-trade-outcomes.js` | Daily MFE/MAE computation cron (21:35 UTC weekdays) |
| `api/backtest-data.js` | Unified backtest endpoint (?type=candles or ?type=iv) |
| `src/lib/backtest/engine.ts` | Core simulation + V4 quality gates |
| `src/lib/backtest/option-sim.ts` | Credit spread simulator (BSM on ORATS chains) |
| `src/lib/backtest/chain-cache.ts` | SQLite cache for ORATS chain data |
| `src/lib/backtest/bsm-pricing.ts` | BSM pricing, delta, O-U IV evolution, rolling HV |
| `src/lib/backtest/wfa-options.ts` | Rolling WFA loop engine |
| `src/lib/riskSizing.ts` | Risk sizing + portfolio Greeks |
| `src/lib/types.ts` | Shared TypeScript interfaces |
| `src/hooks/useSignalScanner.ts` | Signal scanner hook (130M + approxTickers) |
| `scripts/prefetch-130m.mjs` | 130M candle prefetch for Supabase stock_candles |
| `scripts/wfa-pipeline-short.ts` | Short-term 130M WFA pipeline (worker threads) |
| `tests/migration-130m.test.ts` | 130M migration validation (38 tests) |

### Critical Rules

- `src/lib/oss-core.ts` and `lib/_shared/scoring.cjs` **MUST stay in sync** — 307 parity tests enforce this
- `api/strategy-recommend.js` uses raw `fetch()` for Supabase REST (no JS client)
- All 683 existing tests must keep passing after any change
- Crons: most triggered via cronjobs.org. Exception: `cron-iv` uses Vercel cron (22:00 UTC weekdays)
- **Backtesting results & reports** must go in `backtesting history/credit-spread/reports/` — one subfolder per study with a `README.md` + data files. Never scatter results across `data/`, `scripts/`, or root.

### Database Tables

- `positions`, `transactions`, `position_greeks_history`, `ticker_iv_snapshots`, `app_settings`
- `candidate_snapshots`, `stock_candles`, `signal_history`, `orats_iv_cache`
- `score_history`, `trade_outcomes`

### Env Vars

`ORATS_API_TOKEN`, `TIINGO_API_TOKEN`, `DATA_SOURCE=ORATS`, `DISCORD_WEBHOOK_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`

### Ticker Watchlist

SPY, QQQ, GOOGL, JPM, META, TSLA, MSFT, NFLX, AAPL, NVDA, AMD, COST, IREN, BA, AMZN, HOOD, CRWV, COIN, MSTR, PLTR, AVGO, LULU, UBER, GS, UNH, IWM, GLD

### Testing

683 Vitest tests across 18 files (307 parity + 48 oss-core + 19 riskSizing + 10 tech-parity + 33 backtest + 32 bsm + 38 migration-130m + others). CI: GitHub Actions lint -> build -> test.

### Recent Major Changes (2026-03-23)

- **130M Migration**: Short-term strategy replaced 4H with 130M timeframe (3×130min bars = exact 390min regular session). Config: `em|tp50|w10|iv20|dsoff|pm2.25`. Data: Tiingo IEX 10-min → 130M aggregation, cached in Supabase `stock_candles` with block-encoded timeframe (`130M_0/1/2`). `cron-signal-scan.js` handles daily 130M top-up.
- **Scoring Overhaul Phase 1**: VRP (IV²-RV²) feeds ±10pt into credit/debit builder scoring. `orFcst20d` clamp widened ±0.8→±2.0.
- **Multicore WFA**: Worker cap removed (`Math.min(4, cpus-2)` → `Math.max(1, cpus-2)`).
- **WFA Results Viewer**: Live at `/backtest`, loads from `data/wfa-results.json`.
