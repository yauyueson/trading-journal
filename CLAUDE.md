# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working Principles

Adapted from [andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills). Bias toward caution over speed; use judgment on trivial tasks.

1. **Think before coding.** State assumptions explicitly. If multiple interpretations exist, present them — don't pick silently. If something is unclear, stop and ask.
2. **Simplicity first.** Minimum code that solves the problem. No speculative abstractions, configurability, or error handling for impossible scenarios. If 200 lines could be 50, rewrite.
3. **Surgical changes.** Every changed line must trace to the user's request. Don't refactor adjacent code, reformat, or delete pre-existing dead code unless asked. Match existing style.
4. **Goal-driven execution.** Convert tasks to verifiable goals ("Fix bug" → "Write failing test, make it pass"). For multi-step work, state a brief plan with a verify step per item so you can loop without re-asking.

## Build & Dev Commands

```bash
npm run dev          # Vite dev server (frontend only, stub APIs) → localhost:5173
npm run build        # tsc && vite build
npm run lint         # ESLint on src/ (max 25 warnings allowed)
npm run test         # vitest run --passWithNoTests (1213 tests)
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
- **Shared utilities**: `src/lib/utils.ts` exports `getStrategyKind(position)` (returns `'credit' | 'debit' | 'diagonal' | 'single'`; reads `strategy_type` first, falls back to legacy `type` string inspection — use this instead of string-parsing `position.type`), `isCreditStrategy(typeString)` (legacy back-compat wrapper), `computePositionPnL(txns, kindOrIsCredit)` (accepts either a `PositionPnLKind` string or the legacy boolean), formatting helpers (`formatCurrency`, `formatPrice`, `formatPercent`, `formatDate`, `daysUntil`)
- **Path alias**: `@/*` → `./src/*` (tsconfig paths)
- **Dark theme only**: Custom Tailwind tokens (`text-text-primary`, `bg-bg-secondary`, `text-accent-green`, etc.) defined in `tailwind.config.js`. Never use hardcoded hex colors.

### Backend (Vercel API Routes)

All in `api/` as ESM `.js` files. Key routes:
- `strategy-recommend.js` (15s) — legacy Options Selector engine (raw `fetch()` for Supabase REST, not JS client). Not on the BCD/PMCC entry path; used by `/selector` page for manual ad-hoc picks.
- `scan-options.js` (15s) — options scanner (powers Selector page)
- `option-prices.js` (15s) — single/bulk option price lookup; rewrite `/api/option-price` → `/api/option-prices` in `vercel.json`
- `cron-trade-outcomes.js` (30s) — daily MFE/MAE computation (21:35 UTC weekdays, external cron)
- `cron-iv.js` (120s) — IV backfill (Vercel cron, 22:00 UTC weekdays via `vercel.json`)
- `backtest-data.js` (15s) — unified backtest endpoint (`?type=candles` or `?type=iv`)
- `check-alerts.js` (60s) — Discord alerts for stop-loss / trailing-lock triggers. **Filters out `strategy_type in ('bcd','pmcc')`** — those strategies use their own PT/roll rules in-UI, not the legacy DTE5 SL 2.5x / TL 50/50 path.
- `daily-recap.js` (60s) — daily summary → Discord

**Retired**: `api/cron-signal-scan.js` (782-line DTE5 EMA55 scanner) deleted 2026-04-24 when BCD adopted a 10-day manual cadence and PMCC went always-in. External cron still pointed at it returns 404 — expected no-op.

Cron routes verify `CRON_SECRET` via `Authorization: Bearer` header. Non-cron routes have no auth guard (single-user app, RLS at Supabase layer).

Data clients: `lib/orats-client.js` (ORATS), `lib/tiingo-client.js` (Tiingo)

### Scoring System (Dual-File Parity)

- `src/lib/oss-core.ts` — TypeScript source of truth (frontend)
- `lib/_shared/scoring.cjs` — CJS mirror (used by API routes)
- **These two files MUST stay in sync.** 307 parity tests in `tests/scoring-parity.test.ts` enforce this. Any scoring change requires updating both files.

### Backtesting Engine

Located in `src/lib/backtest/`:
- `engine.ts` — core simulation + V4 quality gates
- `option-sim.ts` — multi-mode simulator (BSM on ORATS chains). `SimConfig.mode` switches between `CREDIT_SPREAD` (bull put / bear call), `DEBIT_SPREAD` (BCD), `DIAGONAL` (PMCC), `LEAP`, `BUY_WRITE`. All exit types (`PROFIT_TARGET`, `STOP_LOSS`, `MAX_LOSS_STOP`, `DELTA_STOP`, `TRAILING_LOCK`, `TIME_STOP`, `EXPIRATION`, `NO_CHAIN`, `FORCE_CLOSE`), bid/ask fills. `EntrySignal` carries per-signal delta/regime data.
- `credit-spread-exit.ts` — exit logic module: `computeCreditSpreadThresholds()`, `resolveTriggeredCreditExitCost()`, `buildCreditSpreadTrade()`. Conservative SL pricing uses market spread cost, not threshold (gamma can gap past SL at DTE 2-7).
- `chain-cache.ts` — SQLite cache for ORATS chain data, `findContractDirect()` O(1) PK lookup, `findSpreadStrikes()` for delta-targeted spreads
- `bsm-pricing.ts` — BSM pricing, delta, O-U IV evolution, rolling HV
- `wfa-options.ts` — rolling window WFA engine, `buildWFAWindows()`, `evaluateConfiguredSignalsWithConstraints()`, `computePortfolioDailyMetrics()`
- `slippage.ts` — dynamic slippage model
- `portfolio-stress.ts` — correlated drawdown using dailyMtM

### Research Pipeline (Autoresearch)

Located in `scripts/autoresearch/`:
- `runner.ts` — main orchestrator. Each run reads a strategy file, runs WFA, appends an audit row + ledger entry, and stamps provenance (strategy blob SHA, pre-reg block hash, dataset manifest hash).
- `strategy-bcd-qqq-wide-f1.ts`, `strategy-pmcc-qqq-pt60-f1.ts` — singleton-anchor strategy files for the two sealed F1 adoptions. Pattern: pre-reg in `.handoff/current.md` → commit → run → seal via `scripts/evaluate-holdout.ts`.
- `lib/f0-boundary.ts` — `F0_BOUNDARY_ISO = '2026-04-23T02:20:00Z'`, `countEffectiveAttempts()`, `deflatedSharpeAt()`. Filters pre-F0 trials out of the dsrM gate calculation.
- `lib/seal-holdout.ts` — `computeStandardAdoption()` machine-enforces 6 gates; the sealer only emits a PASS seal when all six clear.
- `lib/pre-reg-gate.ts` — extracts the `## Pre-Registration` block from `.handoff/current.md` and hashes it; runner refuses to start without a committed block.

**Legacy (archived)**: `scripts/wfa-dte5-tp-sl-study.ts`, `scripts/wfa-pipeline-swing.ts`, `scripts/wfa-pipeline-short.ts` — pre-F0 WFA studies for retired strategies. Not wired into current workflow.

Study results go in `backtesting history/credit-spread/reports/<study-name>/` with a `README.md` + data outputs; sealed holdouts go in `docs/holdout-evaluations/`; audit rows in `docs/audit-rows/`.

### Risk Sizing

`src/lib/riskSizing.ts` — position sizing uses stop-out level (not full max loss) as risk. 0.25 Kelly fraction. `getPositionRiskAtStopOutDollars()` for per-position risk, capped by `maxRiskPerTrade` from AppSettings. `getPositionMaxLossDollars()` branches on `getStrategyKind(position)`: credit spread uses `(width − credit) × 100 × qty`; debit spread uses `entryPrice × 100 × qty`; diagonal uses long-LEAP debit × 100 × qty (short rolls can only reduce basis).

### Testing

Vitest configured in `vite.config.ts` (not a separate config). **1213 tests across 52 files**. Tests in two locations:
- `tests/` — integration/parity tests (scoring parity, BSM, WFA, option-sim, F0 boundary, evaluate-holdout, adoption gates, migration)
- `src/lib/__tests__/` — unit tests (oss-core, riskSizing, computePositionPnL)

Test environment: jsdom with globals enabled. Setup file: `src/test/setup.ts`.

## Critical Rules

- **Backtest trust gotchas**: Before making any claim about a strategy's performance, read `docs/backtest-trust-gotchas.md`. It catalogues every simulator bug and trap that has produced fake results in this project. Any new gotcha found must be added there. The runner enforces `MAX_SANE_OOS_SHARPE = 3.0` — anything higher is almost always a structural bug.
- **Scoring parity**: `oss-core.ts` ↔ `scoring.cjs` must match. Run `npx vitest run tests/scoring-parity.test.ts` after any scoring change.
- **All tests must pass**: 1213 tests. Never merge with failures.
- **Sealed holdout protocol**: Any new strategy adoption requires (1) pre-registration committed to `.handoff/current.md` **before** running the runner, (2) a singleton strategy file with a named anchor (no variants), (3) the sealer (`scripts/evaluate-holdout.ts`) machine-enforcing 6/6 gates. See `docs/sealed-holdout.md` + `docs/phase-f0-clean-slate-declaration.md`.
- **Backtesting reports**: Must go in `backtesting history/credit-spread/reports/<study-name>/`. Each study folder gets a `README.md` plus data outputs. Never scatter results across `data/`, `scripts/`, or project root.
- **ESLint**: Lints only `src/**/*.{ts,tsx}`. Ignores `api/`, `lib/`, `*.cjs`. Max 25 warnings.
- **API route pattern**: `api/strategy-recommend.js` uses raw `fetch()` for Supabase REST (env: `SUPABASE_URL`/`SUPABASE_ANON_KEY`). `api/cron-iv.js` uses `@supabase/supabase-js` createClient.
- **Paper trading**: Positions have `is_paper` boolean. Paper and live positions coexist; filter via the portfolio's paper/live toggle.
- **Strategy config consistency**: When changing strategy parameters (deltas, DTE, PT/SL, tickers), update ALL of: `data/strategy-config.json`, `src/lib/strategyProfiles.ts`, `lib/_shared/strategyConfig.js`, `src/lib/types/settings.ts`, `src/pages/Signals.tsx`, `src/pages/Dashboard.tsx`, `src/components/PositionCard.tsx`, `src/components/BCDEntryModal.tsx` / `src/components/PMCCEntryModal.tsx` (if entry defaults move), `api/check-alerts.js`, and `CLAUDE.md`. Run `npx tsc --noEmit && npm run test && npm run build` to verify.
- **ORATS data quirk**: `orats_iv_cache.hv30d` is always NULL — ORATS `/hist/cores` doesn't provide `clsHv30d` (skips from 20d to 60d). Use `hv20d` for VRP computation (IV30² - HV20²).

## Env Vars

`ORATS_API_TOKEN`, `TIINGO_API_TOKEN`, `DATA_SOURCE=ORATS`, `DISCORD_WEBHOOK_URL`, `CRON_SECRET`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`

## Database Tables

Core: `positions`, `transactions`, `position_greeks_history`, `ticker_iv_snapshots`, `app_settings`
Analytics: `candidate_snapshots`, `stock_candles`, `signal_history`, `orats_iv_cache`, `score_history`, `trade_outcomes`

Migrations in `supabase/migrations/` as raw SQL (no ORM).

## Active Strategies

Two F1 sealed adoptions (post-F0 clean-slate, 2026-04-23) run concurrently — different capital tiers, both QQQ-only:

**BCD QQQ wide** (`strategy_type: 'bcd'`, `$2K` tier): bull call debit spread. Long call δ 0.50 / short call δ 0.20, same expiry, DTE 30-60, profit target 50%, bid/ask fills. Entered every 10 trading days when flat (10-day emission + `maxPositions=1` flat gate — not a strict cadence). Seal: [docs/holdout-evaluations/2026-04-23-25880326cfe1.md](docs/holdout-evaluations/2026-04-23-25880326cfe1.md) — oosSharpe 0.97, holdoutSharpe 1.22, holdoutSpyIR +0.40, dsrM (F0-eff N=30) +0.065 (all 6 gates pass).

**PMCC QQQ pt60** (`strategy_type: 'pmcc'`, `$10K+` tier): diagonal. Long LEAP call δ 0.70–0.80, DTE 240-300; short monthly call δ 0.20-0.30, DTE 30-45. Long PT 60%, short PT 50%, long SL 35%, roll short when underlying within 2% of short strike. Always-in (enter when flat). Seal: [docs/holdout-evaluations/2026-04-23-7e9c2026f3df.md](docs/holdout-evaluations/2026-04-23-7e9c2026f3df.md) — oosSharpe 1.72, holdoutSharpe 1.63, holdoutSpyIR +0.15, dsrM (F0-eff N=25) +0.845.

`STRATEGY_PROFILES` in [src/lib/strategyProfiles.ts](src/lib/strategyProfiles.ts) defines five types. `ACTIVE_STRATEGIES = ['bcd', 'pmcc']`; `RETIRED_STRATEGIES = {'swing', 'shortTerm', 'dte5'}`. Retired rows remain viewable under the "Legacy" filter on Portfolio / Stats; their code paths are untouched.

**Entry flow**: manual via `BCDEntryModal` / `PMCCEntryModal` on the Signals page. No cron-driven signal emission — the old `api/cron-signal-scan.js` (DTE5 EMA55 daily scanner) was retired on 2026-04-24. `api/check-alerts.js` explicitly skips BCD/PMCC positions (the DTE5 SL 2.5x / TL 50/50 rules don't apply).

**Retired DTE5 Bull Put Credit Spread (historical reference)**: short delta 0.30 / long delta 0.20, DTE 2-7, EMA55 gate, SL 2.5x credit, trailing lock 50/50, hold-to-expiry. Sealed FAIL under F0 (window-artifact loss to 2024-2026 QQQ rally). Still in `STRATEGY_PROFILES` for back-compat with existing DB rows.

## Ticker Watchlist

**Research universe (30 tradable tickers, expanded 2026-04-18):**
- Core (12): IWM, AAPL, MSFT, GOOG, AMZN, META, JPM, GS, COST, NFLX, NVDA, TSLA
- Growth (9): AMD, AVGO, BA, COIN, HOOD, LULU, MSTR, PLTR, UBER
- Dow (1): CRM
- AI / growth / hot (8): ORCL, CRWD, SHOP, PANW, ANET, VRT, ARM, NOW

**Benchmarks (MarketContext, not tradable):** SPY, QQQ

**Legacy (retained in cache for reproducibility, not in active universe):** GLD, UNH, IREN, CRWV, GOOGL

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
