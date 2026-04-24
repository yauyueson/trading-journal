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
| `api/cron-trade-outcomes.js` | Daily MFE/MAE computation cron (21:35 UTC weekdays) |
| `src/components/BCDEntryModal.tsx` | Manual BCD debit-spread entry (F1 adopted) |
| `src/components/PMCCEntryModal.tsx` | Manual PMCC diagonal entry — separate LEAP + short expiries (F1 adopted) |
| `api/backtest-data.js` | Unified backtest endpoint (?type=candles or ?type=iv) |
| `src/lib/backtest/engine.ts` | Core simulation + V4 quality gates |
| `src/lib/backtest/option-sim.ts` | Credit spread simulator (BSM on ORATS chains) |
| `src/lib/backtest/chain-cache.ts` | SQLite cache for ORATS chain data |
| `src/lib/backtest/bsm-pricing.ts` | BSM pricing, delta, O-U IV evolution, rolling HV |
| `src/lib/backtest/wfa-options.ts` | Rolling WFA loop engine |
| `src/lib/riskSizing.ts` | Risk sizing + portfolio Greeks |
| `src/lib/types.ts` | Shared TypeScript interfaces |
| `src/lib/strategyProfiles.ts` | `STRATEGY_PROFILES` (BCD, PMCC active; DTE5/swing/shortTerm retired), `ACTIVE_STRATEGIES`, `RETIRED_STRATEGIES`, `kind` discriminator |
| `scripts/prefetch-130m.mjs` | 130M candle prefetch for Supabase stock_candles (historical backtests) |
| `scripts/wfa-pipeline-short.ts` | Short-term 130M WFA pipeline — archived, strategy retired |
| `tests/migration-130m.test.ts` | 130M migration validation (data-path invariants; Signals scanner describe collapsed) |

### Critical Rules

- `src/lib/oss-core.ts` and `lib/_shared/scoring.cjs` **MUST stay in sync** — 307 parity tests enforce this
- `api/strategy-recommend.js` uses raw `fetch()` for Supabase REST (no JS client)
- All 1213 existing tests must keep passing after any change
- Crons: `cron-iv` uses Vercel cron (22:00 UTC weekdays); `cron-trade-outcomes` still runs externally. `cron-signal-scan` was retired on 2026-04-24 (F1 revamp — BCD uses manual 10-day cadence, PMCC is always-in)
- **Backtesting results & reports** must go in `backtesting history/credit-spread/reports/` — one subfolder per study with a `README.md` + data files. Never scatter results across `data/`, `scripts/`, or root.
- **Active F1 strategies (2026-04-23)**: BCD QQQ wide (`strategy_type='bcd'`, $2K, debit spread) and PMCC QQQ pt60 (`strategy_type='pmcc'`, $10K+, diagonal). DTE5/swing/shortTerm are retired (viewable under Legacy filter)

### Database Tables

- `positions`, `transactions`, `position_greeks_history`, `ticker_iv_snapshots`, `app_settings`
- `candidate_snapshots`, `stock_candles`, `signal_history`, `orats_iv_cache`
- `score_history`, `trade_outcomes`

### Env Vars

`ORATS_API_TOKEN`, `TIINGO_API_TOKEN`, `DATA_SOURCE=ORATS`, `DISCORD_WEBHOOK_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`

### Ticker Watchlist

SPY, QQQ, GOOGL, JPM, META, TSLA, MSFT, NFLX, AAPL, NVDA, AMD, COST, IREN, BA, AMZN, HOOD, CRWV, COIN, MSTR, PLTR, AVGO, LULU, UBER, GS, UNH, IWM, GLD

### Testing

1213 Vitest tests across 52 files (307 parity + 48 oss-core + 21 riskSizing + 23 computePositionPnL + backtest + bsm + migration-130m data-path invariants + F0 boundary + holdout-eval + others). CI: GitHub Actions lint -> build -> test.

### Recent Major Changes

**2026-04-24 — Post-F1 cleanup (PR #16, #17)**
- Retired `api/cron-signal-scan.js` (782 lines) and `src/hooks/useSignalScanner.ts` (153 lines) after the F1 revamp orphaned them.
- Removed dead `SpreadPickerModal`, pruned unused exports from `src/lib/strategyConfig.ts`, deduped `LEGACY_STRATEGIES` → use shared `RETIRED_STRATEGIES` Set.
- ~1,400 lines of DTE5/shortTerm dead code removed cumulatively.

**2026-04-23 — Phase F0 clean-slate + Phase F1 platform revamp (PR #14, #15)**
- **F0 declaration**: one-time reset of effective attempt counter (boundary `2026-04-23T02:20:00Z`). Pre-F0 trials excluded from dsrM gating. Binding commitments in `docs/phase-f0-clean-slate-declaration.md`.
- **F1 adoptions** (sealed 6/6 gates each):
  - PMCC QQQ pt60 — `strategy_type='pmcc'`, $10K+ tier, long LEAP δ 0.70-0.80 + short δ 0.20-0.30, long PT 60%, roll trigger moneyness 2%.
  - BCD QQQ wide — `strategy_type='bcd'`, $2K tier, long call δ 0.50 / short δ 0.20, DTE 30-60, PT 50%.
- **Platform revamp**: 5 phases wiring BCD + PMCC as concurrent active strategies; DTE5 retired to Legacy filter. New `BCDEntryModal` / `PMCCEntryModal` for manual entry. `api/check-alerts.js` skips BCD/PMCC (legacy DTE5 SL 2.5x / TL 50/50 rules don't apply).

**2026-03-23 — 130M Migration (retired UI, preserved data path)**
- Short-term strategy replaced 4H with 130M timeframe (3×130min bars = exact 390min regular session). Cache layout + `backtest-data.js` 130M paths preserved for historical backtests, but the live signal scanner and Signals board were removed in the F1 revamp.
- **Scoring Overhaul Phase 1**: VRP (IV²-RV²) ±10pt into credit/debit builder scoring. `orFcst20d` clamp widened ±0.8→±2.0.
- **WFA Results Viewer**: Live at `/backtest`, loads from `data/wfa-results.json`.
