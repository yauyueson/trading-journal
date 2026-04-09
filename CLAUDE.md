# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
npm run dev          # Vite dev server (frontend only, stub APIs) → localhost:5173
npm run build        # tsc && vite build
npm run lint         # ESLint on src/ (max 25 warnings allowed)
npm run test         # vitest run --passWithNoTests (all 695+ tests)
npm run test:watch   # vitest in watch mode
vercel dev           # Full-stack local dev (real API routes + env vars)
```

`npm run dev` serves frontend with Vite middleware stubs for `/api/option-price*`. Use `vercel dev` when you need real API routes hitting ORATS/Tiingo/Supabase.

Run a single test file:
```bash
npx vitest run tests/scoring-parity.test.ts
npx vitest run src/lib/__tests__/oss-core.test.ts
```

Run tests matching a pattern:
```bash
npx vitest run -t "delta stop"
```

Backtest scripts (tsx runner):
```bash
npx tsx scripts/short-put-1dte.ts
```

CI pipeline (GitHub Actions): `lint → build → test` on every push/PR.

## Architecture

**Stack**: React 18 + Vite 5 + TypeScript + Tailwind CSS frontend, Vercel serverless API routes (ESM `.js`), Supabase PostgreSQL + Realtime, ORATS + Tiingo data providers.

### Frontend

- **Provider chain**: `QueryClientProvider → AppSettingsProvider → AuthProvider → ErrorBoundary → Suspense → RouterProvider`
- **Routing**: React Router v6 with lazy-loaded pages (`src/router.tsx`). Routes: `/dashboard`, `/portfolio`, `/signals`, `/history`, `/stats`, `/selector`, `/academy`, `/settings`, `/backtest`
- **Data fetching**: React Query v5 (staleTime 30s, gcTime 5min, retry 1, refetchOnWindowFocus false). Query key factory in `src/lib/queryKeys.ts`. Pages fetch via hooks in `src/hooks/`, no prop drilling.
- **Mutations**: `src/hooks/usePositionMutations.ts` — 11 mutation hooks, auto-invalidate `queryKeys.positions` + `queryKeys.transactions` on success
- **Realtime**: Supabase channels → `useRealtimeInvalidation` → `queryClient.invalidateQueries`
- **Contexts**: AuthContext (session/auth state), AppSettingsContext (portfolio config, active strategy, derived risk limits), BuyModalContext
- **Settings persistence**: localStorage with 5-min TTL, backed by Supabase `app_settings` table (id=1, JSON blob)
- **Types**: Core types in `src/lib/types.ts` (Position, Transaction, LiveData), settings types in `src/lib/types/settings.ts`
- **Shared utilities**: `src/lib/utils.ts` exports `isCreditStrategy(type)` (single source of truth for credit vs debit detection), `computePositionPnL(transactions, isCredit)` (realized P&L), formatting helpers (`formatCurrency`, `formatPrice`, `formatPercent`, `formatDate`, `daysUntil`)
- **Path alias**: `@/*` → `./src/*` (tsconfig paths)
- **Dark theme only**: Custom Tailwind tokens (`text-text-primary`, `bg-bg-secondary`, `text-accent-green`, etc.) defined in `tailwind.config.js`. Never use hardcoded hex colors.

### Backend (Vercel API Routes)

All in `api/` as ESM `.js` files. Key routes:
- `strategy-recommend.js` (15s) — main recommendation engine (raw `fetch()` for Supabase REST, not JS client)
- `scan-options.js` (15s) — options scanner
- `option-prices.js` (15s) — single/bulk option price lookup; rewrite `/api/option-price` → `/api/option-prices` in `vercel.json`
- `cron-signal-scan.js` (60s) — daily signal scanner (21:00 UTC weekdays, external cron)
- `cron-trade-outcomes.js` (30s) — daily MFE/MAE computation (21:35 UTC weekdays, external cron)
- `cron-iv.js` (120s) — IV backfill (Vercel cron, 22:00 UTC weekdays via `vercel.json`)
- `backtest-data.js` (15s) — unified backtest endpoint (`?type=candles` or `?type=iv`)
- `check-alerts.js` (60s) — stop loss/target price alerts → Discord webhook
- `daily-recap.js` (60s) — daily summary → Discord

Cron routes verify `CRON_SECRET` via `Authorization: Bearer` header. Non-cron routes have no auth guard (single-user app, RLS at Supabase layer).

Data clients: `lib/orats-client.js` (ORATS), `lib/tiingo-client.js` (Tiingo)

### Scoring System (Dual-File Parity)

- `src/lib/oss-core.ts` — TypeScript source of truth (frontend)
- `lib/_shared/scoring.cjs` — CJS mirror (used by API routes)
- **These two files MUST stay in sync.** 307 parity tests in `tests/scoring-parity.test.ts` enforce this. Any scoring change requires updating both files.

### Backtesting Engine

Located in `src/lib/backtest/`:
- `engine.ts` — core simulation + V4 quality gates
- `option-sim.ts` — credit spread simulator (BSM on ORATS chains), `DELTA_STOP` exit, bid/ask fills
- `chain-cache.ts` — SQLite cache for ORATS chain data, `findContractDirect()` O(1) PK lookup
- `bsm-pricing.ts` — BSM pricing, delta, O-U IV evolution, rolling HV
- `wfa-options.ts` — rolling window WFA engine
- `slippage.ts` — dynamic slippage model
- `portfolio-stress.ts` — correlated drawdown using dailyMtM

### Risk Sizing

`src/lib/riskSizing.ts` — position sizing uses stop-out level (not full max loss) as risk. 0.25 Kelly fraction. `getPositionRiskAtStopOutDollars()` for per-position risk, capped by `maxRiskPerTrade` from AppSettings.

### Testing

Vitest configured in `vite.config.ts` (not a separate config). Tests in two locations:
- `tests/` — integration/parity tests (scoring parity, BSM, WFA, option-sim, migration)
- `src/lib/__tests__/` — unit tests (oss-core, riskSizing)

Test environment: jsdom with globals enabled. Setup file: `src/test/setup.ts`.

## Critical Rules

- **Scoring parity**: `oss-core.ts` ↔ `scoring.cjs` must match. Run `npx vitest run tests/scoring-parity.test.ts` after any scoring change.
- **All tests must pass**: 695+ tests. Never merge with failures.
- **Backtesting reports**: Must go in `backtesting history/credit-spread/reports/<study-name>/`. Each study folder gets a `README.md` plus data outputs. Never scatter results across `data/`, `scripts/`, or project root.
- **ESLint**: Lints only `src/**/*.{ts,tsx}`. Ignores `api/`, `lib/`, `*.cjs`. Max 25 warnings.
- **API route pattern**: `api/strategy-recommend.js` uses raw `fetch()` for Supabase REST (env: `SUPABASE_URL`/`SUPABASE_ANON_KEY`). `api/cron-iv.js` uses `@supabase/supabase-js` createClient.
- **Paper trading**: Positions have `is_paper` boolean. Paper and live positions coexist; filter via the portfolio's paper/live toggle.

## Env Vars

`ORATS_API_TOKEN`, `TIINGO_API_TOKEN`, `DATA_SOURCE=ORATS`, `DISCORD_WEBHOOK_URL`, `CRON_SECRET`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`

## Database Tables

Core: `positions`, `transactions`, `position_greeks_history`, `ticker_iv_snapshots`, `app_settings`
Analytics: `candidate_snapshots`, `stock_candles`, `signal_history`, `orats_iv_cache`, `score_history`, `trade_outcomes`

Migrations in `supabase/migrations/` as raw SQL (no ORM).

## Active Strategy

**DTE5 Bull Put Credit Spread (QQQ only)**: short delta 0.30 / long delta 0.20, DTE 2-7, EMA55 gate, SL 2.5x credit, trailing lock 50/50, hold-to-expiry. WFA-validated: OOS Sharpe 1.44, Holdout +0.84, MaxDD 11.8%. Strategy type `'dte5'` in `src/lib/strategyProfiles.ts`. Live testing at $1K, 10% risk per trade.

`STRATEGY_PROFILES` in `strategyProfiles.ts` defines three types (`swing`, `shortTerm`, `dte5`) — only `dte5` is active. Retired strategies kept for backward compat with existing DB data.

## Ticker Watchlist

SPY, QQQ, GOOGL, JPM, META, TSLA, MSFT, NFLX, AAPL, NVDA, AMD, COST, IREN, BA, AMZN, HOOD, CRWV, COIN, MSTR, PLTR, AVGO, LULU, UBER, GS, UNH, IWM, GLD

## Multi-AI Team Protocol

You are **The Executor** in a two-engine team. Read `.handoff/TEAM.md` for full protocol.

Before starting any task:
1. Check `.handoff/current.md` — if it exists and is assigned to you, that's your task
2. Read the Objective, Context, and Work Done sections before acting
3. When done, update `current.md` with your work in the Work Done section

When implementing from a Gemini plan:
- Validate the plan against the actual codebase before building
- Flag implementation concerns in current.md rather than silently working around them
- You own the final quality — if the plan has gaps, fill them

When you complete a task:
- Set `stage: done` and summarize what you did in Work Done
- List all modified files in Artifacts
