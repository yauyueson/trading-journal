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
- `check-alerts.js` (60s) — DTE5: SL 2.5x credit alert + trailing lock 50% profit notification → Discord webhook. Non-DTE5: legacy 1.5x SL / 0.5x TP.
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
- `option-sim.ts` — credit spread simulator (BSM on ORATS chains), all exit types (`PROFIT_TARGET`, `STOP_LOSS`, `MAX_LOSS_STOP`, `DELTA_STOP`, `TRAILING_LOCK`, `TIME_STOP`, `EXPIRATION`, `NO_CHAIN`), bid/ask fills. `SimConfig` defines all strategy parameters. `EntrySignal` carries per-signal delta/regime data.
- `credit-spread-exit.ts` — exit logic module: `computeCreditSpreadThresholds()`, `resolveTriggeredCreditExitCost()`, `buildCreditSpreadTrade()`. Conservative SL pricing uses market spread cost, not threshold (gamma can gap past SL at DTE 2-7).
- `chain-cache.ts` — SQLite cache for ORATS chain data, `findContractDirect()` O(1) PK lookup, `findSpreadStrikes()` for delta-targeted spreads
- `bsm-pricing.ts` — BSM pricing, delta, O-U IV evolution, rolling HV
- `wfa-options.ts` — rolling window WFA engine, `buildWFAWindows()`, `evaluateConfiguredSignalsWithConstraints()`, `computePortfolioDailyMetrics()`
- `slippage.ts` — dynamic slippage model
- `portfolio-stress.ts` — correlated drawdown using dailyMtM

### WFA Study Scripts

Located in `scripts/`:
- `wfa-dte5-tp-sl-study.ts` — Main DTE5 TP/SL study orchestrator (8 phases, 198 configs). CLI: `npx tsx scripts/wfa-dte5-tp-sl-study.ts --phase 1|2a|2b|3|3r|4|5|7|8`
- `wfa-dte5-tp-sl-worker.ts` — Worker thread for DTE5 study. Supports per-signal delta (`signal.configuredDelta`), all exit mechanisms, override signals per work item.
- `wfa-pipeline-swing.ts` / `wfa-pipeline-short.ts` — Archived swing/short-term pipelines (retired strategies)

Study results go in `backtesting history/credit-spread/reports/dte5-tp-sl-study/` with phase JSON files + README.

### Risk Sizing

`src/lib/riskSizing.ts` — position sizing uses stop-out level (not full max loss) as risk. 0.25 Kelly fraction. `getPositionRiskAtStopOutDollars()` for per-position risk, capped by `maxRiskPerTrade` from AppSettings.

### Testing

Vitest configured in `vite.config.ts` (not a separate config). Tests in two locations:
- `tests/` — integration/parity tests (scoring parity, BSM, WFA, option-sim, migration)
- `src/lib/__tests__/` — unit tests (oss-core, riskSizing)

Test environment: jsdom with globals enabled. Setup file: `src/test/setup.ts`.

## Critical Rules

- **Backtest trust gotchas**: Before making any claim about a strategy's performance, read `docs/backtest-trust-gotchas.md`. It catalogues every simulator bug and trap that has produced fake results in this project. Any new gotcha found must be added there. The runner enforces `MAX_SANE_OOS_SHARPE = 3.0` — anything higher is almost always a structural bug.
- **Scoring parity**: `oss-core.ts` ↔ `scoring.cjs` must match. Run `npx vitest run tests/scoring-parity.test.ts` after any scoring change.
- **All tests must pass**: 743+ tests. Never merge with failures.
- **Backtesting reports**: Must go in `backtesting history/credit-spread/reports/<study-name>/`. Each study folder gets a `README.md` plus data outputs. Never scatter results across `data/`, `scripts/`, or project root.
- **ESLint**: Lints only `src/**/*.{ts,tsx}`. Ignores `api/`, `lib/`, `*.cjs`. Max 25 warnings.
- **API route pattern**: `api/strategy-recommend.js` uses raw `fetch()` for Supabase REST (env: `SUPABASE_URL`/`SUPABASE_ANON_KEY`). `api/cron-iv.js` uses `@supabase/supabase-js` createClient.
- **Paper trading**: Positions have `is_paper` boolean. Paper and live positions coexist; filter via the portfolio's paper/live toggle.
- **Strategy config consistency**: When changing strategy parameters (EMA gate, SL, TL, tickers), update ALL of: `data/strategy-config.json`, `src/lib/strategyProfiles.ts`, `api/cron-signal-scan.js`, `api/check-alerts.js`, `src/pages/Signals.tsx`, `src/pages/Dashboard.tsx`, `lib/_shared/strategyConfig.js`, `src/lib/types/settings.ts`, and `CLAUDE.md`. Run `npx tsc --noEmit && npm run build` to verify.
- **ORATS data quirk**: `orats_iv_cache.hv30d` is always NULL — ORATS `/hist/cores` doesn't provide `clsHv30d` (skips from 20d to 60d). Use `hv20d` for VRP computation (IV30² - HV20²).

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
