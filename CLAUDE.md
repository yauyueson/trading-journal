# Trading Journal — Claude Code Context

Options trading journal with React 18 + Vite 5 + React Router v6 + React Query v5 frontend, Vercel API routes (ESM .js), Supabase DB.

## Key Architecture

- **Routing**: React Router v6, lazy-loaded pages (`src/router.tsx`). Active routes: `/portfolio`, `/scanner`, `/history`, `/stats`, `/selector`, `/academy`, `/settings`, `/signals`, `/backtest`
- **Data**: React Query v5 (staleTime 30s, gcTime 5min). Pages fetch via hooks, no prop drilling.
- **Mutations**: `src/hooks/usePositionMutations.ts` — 11 mutation hooks, auto-invalidate on success
- **Realtime**: Supabase channels → `useRealtimeInvalidation` → `queryClient.invalidateQueries`
- **Contexts**: AuthContext, BuyModalContext, AppSettingsContext
- **Crons**: Triggered externally via cronjobs.org (NOT Vercel). `vercel.json` has no `crons` array.
- **Data providers**: ORATS (options chains/Greeks/IV/cores/earnings/impliedMove) + Tiingo (stock candles)
- **Env vars**: `ORATS_API_TOKEN`, `TIINGO_API_TOKEN`, `DATA_SOURCE=ORATS`, `DISCORD_WEBHOOK_URL`

## Critical Rules

- `src/lib/oss-core.ts` and `lib/_shared/scoring.cjs` **MUST stay in sync** — 307 parity tests enforce this. Any scoring change requires updating both files.
- `api/strategy-recommend.js` uses raw `fetch()` for Supabase REST (no JS client), env vars: `SUPABASE_URL`/`SUPABASE_ANON_KEY`
- `api/cron-iv.js` uses `@supabase/supabase-js` createClient
- All 488 existing tests must keep passing after any change.

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

## Testing

488 Vitest tests (307 parity + 48 oss-core + 19 riskSizing + 10 tech-parity + 33 backtest + 32 bsm + others). CI: GitHub Actions lint→build→test.

## Database Tables

- `positions`, `transactions`, `greeks_history`, `ticker_iv_snapshots`, `app_settings` (existing)
- `candidate_snapshots` (007), `stock_candles` (011), `signal_history` (012), `orats_iv_cache` (013)
- `score_history` (008 — PENDING), `trade_outcomes` (014)

## Ticker Watchlist

SPY, QQQ, GOOG, JPM, META, TSLA, MSFT, NFLX, AAPL, NVDA, AMD, COST, IREN, BA, AMZN, HOOD, CRWV, COIN, MSTR, PLTR, AVGO, LULU, UBER, GS, UNH, IWM, GLD

---

## Credit Spread Strategy (Production Config)

Validated via 4-phase backtest (~7,000 portfolio replays). Full report: `optimization report/credit-spread-optimization-report.md`

| Setting | Value | Reason |
|---------|-------|--------|
| Signal | **EMA** or **MOM** | Only signals that improve IS→OOS |
| DTE | **45–65d** (target 55d) | OOS validated sweet spot |
| Spread width | **$15** | Linear scaling, 64% capital utilization |
| IV Rank filter | **≥ 30%** | +58% IS Sharpe, consistent across all signals |
| Take Profit | **30%** | Slight edge over 50% |
| Stop Loss | **None** | Defined risk makes stops unnecessary; SL 2× destroys returns |
| Max positions | **5–10** | 5-pos has best Sharpe, 10-pos more diversification |

Key findings:
- SL 2× is broken (0.04 avg Sharpe) — tight stops on credit spreads destroy profitability
- Score-based exits hurt — high win rate means "score drops" recover; se50/se60 go negative OOS
- OI filters hurt — over-filter kills diversification
- Best WFA config: `ema iv30plus std30 mpt5` → OOS Sharpe 2.14, WR 88%, DD 4.9%

## WFA Results Viewer

Live at `/backtest` tab. Loads from `data/wfa-results.json` (5556 OOS trades, 12 windows, 14 tickers). Derived data files `data/viewer-signals.json` and `data/viewer-configs.json` built by `scripts/_build-viewer-data.cjs` from `backtesting history/credit-spread/results/`.

Overall WFA metrics: OOS Sharpe 1.275, WR 89.52%, Max DD 4.64%, PnL $613,248, WF Efficiency 0.885.

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

Uncommitted worker scripts in `scripts/`: `.credit-worker.mjs`, `.eval-worker.mjs`, `.experiment-worker.mjs`, `.portfolio-sim.mjs`, `.portfolio-worker.mjs`

---

## Scoring System Notes

Full research: `memory/scoring-overhaul-research.md` (in Claude memory dir, not repo).

Key gaps identified (not yet addressed):
- ~50% of fetched ORATS data is display-only (never affects score)
- No vol edge detection — `orFcst20d` used as minor ±0.3 adjustment, should be primary signal
- Using noisy `midIv` instead of ORATS `smvVol` (smoothed vol) everywhere
- VRP measured as ratio (`iv/rv`) not variance (`IV² - RV²`)
- CSQ framework is dead code — credit spreads use inline scoring
- `riskFreeRate` unused in BSM (material for DTE > 60)

ORATS `getCores()` provides (all fetched, not all used): RV30, IV percentile, daysToNextErn, impliedMove, contango, put-call volumes, slope, deriv, orFcst20d, fcstR2, ivHvXernRatio, avgOptVolu20d, tkOver.

`normalizeORATSStrike` sets `probabilityITM = |delta|` (BSM approximation).
