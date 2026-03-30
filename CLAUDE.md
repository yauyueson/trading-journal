# Trading Journal — Claude Code Context

Options trading journal with React 18 + Vite 5 + React Router v6 + React Query v5 frontend, Vercel API routes (ESM .js), Supabase DB.

## Key Architecture

- **Routing**: React Router v6, lazy-loaded pages (`src/router.tsx`). Active routes: `/portfolio`, `/scanner`, `/history`, `/stats`, `/selector`, `/academy`, `/settings`, `/signals`, `/backtest`
- **Data**: React Query v5 (staleTime 30s, gcTime 5min). Pages fetch via hooks, no prop drilling.
- **Mutations**: `src/hooks/usePositionMutations.ts` — 11 mutation hooks, auto-invalidate on success
- **Realtime**: Supabase channels → `useRealtimeInvalidation` → `queryClient.invalidateQueries`
- **Contexts**: AuthContext, BuyModalContext, AppSettingsContext
- **Crons**: Most crons triggered externally via cronjobs.org. Exception: `cron-iv` uses Vercel cron (`vercel.json` `crons` array, 22:00 UTC weekdays).
- **Data providers**: ORATS (options chains/Greeks/IV/cores/earnings/impliedMove) + Tiingo (stock candles)
- **Env vars**: `ORATS_API_TOKEN`, `TIINGO_API_TOKEN`, `DATA_SOURCE=ORATS`, `DISCORD_WEBHOOK_URL`

## Critical Rules

- `src/lib/oss-core.ts` and `lib/_shared/scoring.cjs` **MUST stay in sync** — 307 parity tests enforce this. Any scoring change requires updating both files.
- `api/strategy-recommend.js` uses raw `fetch()` for Supabase REST (no JS client), env vars: `SUPABASE_URL`/`SUPABASE_ANON_KEY`
- `api/cron-iv.js` uses `@supabase/supabase-js` createClient
- All 683 existing tests must keep passing after any change.
- **Backtesting results & reports** must go in `backtesting history/credit-spread/reports/` — one subfolder per study (e.g., `130m-vs-4h-study/`). Each study folder should contain a `README.md` summarizing findings plus any JSON/data outputs. Never scatter result files across `data/`, `scripts/`, or project root.

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/oss-core.ts` | TypeScript scoring source (frontend) |
| `lib/_shared/scoring.cjs` | CJS mirror of oss-core.ts (API) |
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
| `src/lib/riskSizing.ts` | Risk sizing + portfolio Greeks utility |
| `src/lib/types.ts` | Shared TypeScript interfaces |
| `src/hooks/useSignalScanner.ts` | Signal scanner hook (130M + approxTickers) |
| `scripts/prefetch-130m.mjs` | 130M candle prefetch for Supabase stock_candles |
| `scripts/wfa-pipeline-short.ts` | Short-term 130M WFA pipeline (worker threads) |
| `tests/migration-130m.test.ts` | 130M migration validation (38 tests) |

## Testing

683 Vitest tests across 18 files (307 parity + 48 oss-core + 19 riskSizing + 10 tech-parity + 33 backtest + 32 bsm + 38 migration-130m + others). CI: GitHub Actions lint→build→test.

## Database Tables

- `positions`, `transactions`, `position_greeks_history`, `ticker_iv_snapshots`, `app_settings` (existing)
- `candidate_snapshots` (007), `stock_candles` (011), `signal_history` (012), `orats_iv_cache` (013)
- `score_history` (008), `trade_outcomes` (014)

## Ticker Watchlist

SPY, QQQ, GOOGL, JPM, META, TSLA, MSFT, NFLX, AAPL, NVDA, AMD, COST, IREN, BA, AMZN, HOOD, CRWV, COIN, MSTR, PLTR, AVGO, LULU, UBER, GS, UNH, IWM, GLD

---

## Credit Spread Strategy (Production Config)

### Validated: DTE5 Bull Put Credit Spread (QQQ only)

**Config:** QQQ bull put spread, short delta 0.25 / long delta 0.15 (~$10 width), DTE 2-7 (target 5), EMA34 gate (close > EMA34), hold-to-expiry, $0 commissions (Robinhood).

**Validation:** 4-stage WFA re-examination (518 runs), hold-out validation (train 2020-2024H1, test 2024H2-2026), adversarial audit (all 11 checks PASS). WFA OOS Sharpe ~1.09, hold-out Sharpe ~1.17, 84% win rate, not correlated to buy-and-hold (R²=3.9%).

**Live config:** Paper trading at $1K capital, 1 contract per trade, max 1 concurrent position. Strategy type `'dte5'` in `src/lib/strategyProfiles.ts`. Daily signal via `cron-signal-scan.js` EMA34 gate check.

### Retired Strategies (kept in type system for DB compat, hidden from UI)

**Swing (45-65 DTE):** Retired 2026-03-28 — phantom expiration profits inflated OOS Sharpe.
**Short-Term (7-21 DTE):** Retired 2026-03-28 — Sharpe -0.96 with honest pricing.

## WFA Results Viewer

Live at `/backtest` tab. Loads from `data/wfa-results.json` — **STALE, pre-fix results, do not treat as validated.**

---

## Completed Work — WFA Engine Overhaul

All phases implemented and tested:

- **Phase 0**: Daily MTM infrastructure — `dailyMtM` on `OptionTrade`, `purgeGapDays` default fixed (5 → 65)
- **Phase 1**: Execution reality — `src/lib/backtest/slippage.ts` (dynamic slippage), bid/ask fills via `applyFill()` in option-sim.ts
- **Phase 2**: Rolling WFA loop — `src/lib/backtest/wfa-options.ts` (rolling window engine). Worker thread (`wfa-worker.ts`) not yet in src/
- **Phase 3**: Portfolio stress — `src/lib/backtest/portfolio-stress.ts` (correlated drawdown using dailyMtM)
- `findContractDirect()` in chain-cache.ts — O(1) PK index lookup
- `DELTA_STOP` exit type + `creditDeltaStop` config param in option-sim.ts
- Max DD sort fix in `computeOptionAnalytics`
- **130M Migration** (2026-03-23): Tiingo IEX 10-min bars → 130M aggregation (3 bars/day = 390min session), Supabase `stock_candles` cache with block-encoded timeframe (`130M_0/1/2`), cache-first pattern with 1H fallback (approx, UI warning), `cron-signal-scan.js` handles daily 130M top-up
- **Multicore WFA** (2026-03-23): Worker cap changed from `Math.min(4, cpus-2)` to `Math.max(1, cpus-2)` in wfa-run.ts and wfa-run-unified.ts
- **Scoring Phase 1** (2026-03-23): VRP (IV²-RV²) ±10pt adjustment in strategy-recommend.js credit/debit builders, `orFcst20d` clamp widened ±0.8→±2.0 in oss-core.ts and scoring.cjs

Uncommitted worker scripts in `scripts/`: `.credit-worker.mjs`, `.eval-worker.mjs`, `.experiment-worker.mjs`, `.portfolio-sim.mjs`, `.portfolio-worker.mjs`

---

## Scoring System Notes

Full research: `memory/scoring-overhaul-research.md` (in Claude memory dir, not repo).

### Fixed (Scoring Overhaul Phase 1, 2026-03-23)
- VRP now uses variance form (IV²-RV²) and feeds ±10pt into credit/debit builder scoring in `strategy-recommend.js`
- `orFcst20d` clamp widened from ±0.8 to ±2.0 (with ×8 builder multiplier → max ±16pt impact). Modulated by R² quality.
- `smvVol` already fetched and used in chain-cache.ts (line 225: `iv: callSmvVol || row.callMidIv`)
- `riskFreeRate` already set to 0.04 in types.ts and intraday-monitor.ts
- IV-normalized distance (sigma-unit) already used in both builder and standalone scoring paths

### Remaining Gaps
- ~50% of fetched ORATS data is display-only (never affects score)
- `smvVol` used in backtest path but live API path (`strategy-recommend.js`) still uses `midIv`
- CSQ framework is dead code — credit spreads use inline scoring
- exitMultiplier=0.92 unvalidated against `trade_outcomes` table
- Unified score overwrites LOQ z-scores (8→4 dimension reduction)

ORATS `getCores()` provides (all fetched, not all used): RV30, IV percentile, daysToNextErn, impliedMove, contango, put-call volumes, slope, deriv, orFcst20d, fcstR2, ivHvXernRatio, avgOptVolu20d, tkOver.

`normalizeORATSStrike` sets `probabilityITM = |delta|` (BSM approximation).

---

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
