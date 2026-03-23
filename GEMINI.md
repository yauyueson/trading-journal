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

### Critical Rules

- `src/lib/oss-core.ts` and `lib/_shared/scoring.cjs` **MUST stay in sync** — 307 parity tests enforce this
- `api/strategy-recommend.js` uses raw `fetch()` for Supabase REST (no JS client)
- All 488+ existing tests must keep passing after any change
- Crons: triggered externally via cronjobs.org (NOT Vercel)
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

488+ Vitest tests (307 parity + 48 oss-core + 19 riskSizing + 10 tech-parity + 33 backtest + 32 bsm + others). CI: GitHub Actions lint -> build -> test.
