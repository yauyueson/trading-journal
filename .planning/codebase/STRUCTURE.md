# Codebase Structure

**Analysis Date:** 2026-03-14

## Directory Layout

```
trading-journal/
├── api/                    # Vercel serverless functions (ESM .js)
├── lib/                    # Server-side shared utilities (Node/CJS)
│   ├── _shared/            # Cross-route CJS modules (scoring, IV history, Supabase REST)
│   ├── orats-client.js     # ORATS options data client
│   ├── tiingo-client.js    # Tiingo stock candle client
│   ├── tech-analysis.js    # Technical analysis (server-side JS)
│   └── indicators.js       # Indicator calculations (server-side JS)
├── src/                    # React frontend (TypeScript)
│   ├── main.tsx            # App entry point
│   ├── router.tsx          # React Router v6 config
│   ├── App.tsx             # (legacy shell, not used in routing)
│   ├── index.css           # Global CSS + Tailwind base
│   ├── layouts/            # Route shell components
│   ├── pages/              # Top-level route components (lazy-loaded)
│   ├── components/         # Shared UI components
│   ├── context/            # React context providers
│   ├── hooks/              # React Query hooks (data fetching + mutations)
│   ├── lib/                # Pure TS logic, types, scoring
│   │   ├── backtest/       # Backtest engine subsystem
│   │   ├── __tests__/      # Co-located unit tests for lib
│   │   ├── types/          # Sub-type modules (settings)
│   │   └── *.ts            # Core modules (oss-core, riskSizing, bsm, etc.)
│   └── test/               # Test setup files
├── tests/                  # Integration + parity test suite (Vitest)
├── data/                   # Static + generated data files
│   ├── option-chains.sqlite # SQLite cache for ORATS chain data (backtest)
│   ├── wfa-results.json    # WFA backtest output (5556 OOS trades)
│   ├── viewer-signals.json # Pre-built viewer data
│   └── viewer-configs.json # Pre-built viewer configs
├── scripts/                # Offline analysis + backtest runner scripts (TS/CJS)
├── supabase/               # Supabase config + SQL migrations
│   └── migrations/         # Numbered SQL migration files
├── .github/workflows/      # GitHub Actions CI (lint → build → test)
├── .planning/              # GSD planning documents
├── backtesting history/    # Historical backtest result archives
├── docs/                   # Documentation + superpowers
├── index.html              # Vite HTML entry point
├── vite.config.ts          # Vite build + dev server config
├── vercel.json             # Vercel deployment config (routes, function timeouts, crons)
├── tsconfig.json           # TypeScript config
├── tailwind.config.js      # Tailwind CSS config
├── eslint.config.js        # ESLint flat config
└── package.json            # Dependencies + npm scripts
```

## Directory Purposes

**`api/`:**
- Purpose: Vercel serverless function handlers, one file per endpoint
- Contains: ESM `.js` files each exporting `default async function handler(req, res)`
- Key files:
  - `api/strategy-recommend.js`: Main strategy recommendation (ORATS + scoring)
  - `api/scan-options.js`: Options scanner (LOQ/CSQ scoring)
  - `api/cron-signal-scan.js`: Daily signal cron (21:00 UTC weekdays)
  - `api/cron-trade-outcomes.js`: Daily MFE/MAE cron (21:35 UTC weekdays)
  - `api/cron-iv.js`: IV snapshot cron (Vercel-managed, 22:00 UTC weekdays)
  - `api/backtest-data.js`: Backtest data proxy (?type=candles or ?type=iv)
  - `api/option-prices.js`: Live option price lookup

**`lib/`:**
- Purpose: Server-side modules shared across API routes; NOT imported by `src/`
- Contains: External API clients, technical indicator implementations
- Key files:
  - `lib/orats-client.js`: `getOptionChain()`, `getUnderlyingPrice()`, `getCores()`, `checkQuoteFreshness()`
  - `lib/tiingo-client.js`: `getCandles()` for stock OHLCV data
  - `lib/_shared/scoring.cjs`: CJS mirror of `src/lib/oss-core.ts` — MUST stay in sync
  - `lib/_shared/tech-analysis.cjs`: CJS mirror of `src/lib/tech-analysis.ts`
  - `lib/_shared/ivHistory.cjs`: IV snapshot persistence helpers
  - `lib/_shared/supabase-rest.js`: Raw `fetch()` helper for Supabase REST (no JS client)
  - `lib/_shared/config.js`: `SCAN_TICKERS` watchlist constant

**`src/pages/`:**
- Purpose: One component per route, lazy-loaded by router
- Contains: `Portfolio.tsx`, `Scanner.tsx`, `StrategyRecommender.tsx`, `History.tsx`, `Stats.tsx`, `Signals.tsx`, `Backtest.tsx`, `Academy.tsx`, `AppSettings.tsx`, `Login.tsx`, `Watchlist.tsx`
- Pattern: Each page imports its own hooks and composition components. Pages accept optional props for testing but default to React Query hooks.

**`src/components/`:**
- Purpose: Reusable UI components shared across pages
- Contains: `PositionCard.tsx`, `BuyModal.tsx`, `RollModal.tsx`, `TabNav.tsx`, `LoadingSpinner.tsx`, `DataFooter.tsx`, `ScoreFactorsView.tsx`, `ScoreValidation.tsx`, `Tooltip.tsx`, `WatchlistItem.tsx`, `PortfolioSettingsForm.tsx`, `GreeksHistoryChart.tsx`
- Sub-directories:
  - `components/stats/`: Stats-specific charts (`EquityCurve.tsx`, `MFEMAEChart.tsx`, `MonthlyHeatmap.tsx`, `DisciplineCard.tsx`)
  - `components/strategy/`: `PayoffDiagram.tsx`

**`src/hooks/`:**
- Purpose: All async data access — queries and mutations
- Contains: One file per domain or logical grouping
- Key files:
  - `usePositions.ts`, `useTransactions.ts`: Core Supabase reads
  - `usePositionMutations.ts`: 11 mutation hooks (add, close, roll, delete, update score/price/target/stop/owner, move-to-active, add-to-watchlist)
  - `useRealtimeInvalidation.ts`: Supabase channel → query invalidation
  - `useStrategyRecommend.ts`: Calls `/api/strategy-recommend`
  - `useSignalScanner.ts`: Calls `/api/scan-options`
  - `useBacktest.ts`: Orchestrates backtest engine
  - `useSignalHistory.ts`, `useTradeOutcomes.ts`, `useEarnings.ts`, `useBulkOptionPrices.ts`

**`src/context/`:**
- Purpose: Global React state not managed by React Query
- Contains:
  - `AuthContext.tsx`: Supabase session, `isAuthenticated`, `logout()`
  - `AppSettingsContext.tsx`: Portfolio settings (accountSize, riskPct, etc.), `activeStrategy` toggle, localStorage cache
  - `BuyModalContext.tsx`: BuyModal open/close state

**`src/lib/`:**
- Purpose: Pure TypeScript logic, no React dependencies
- Key files:
  - `types.ts`: All shared domain interfaces (`Position`, `Transaction`, `StrategyResult`, etc.)
  - `oss-core.ts`: Canonical scoring — LOQ (long options quality), CSQ (credit spread quality), spread scoring. **Any change requires updating `lib/_shared/scoring.cjs` in sync.**
  - `riskSizing.ts`: Position sizing, max-loss and stop-out dollar calculations, portfolio Greeks aggregation
  - `bsm.ts`: Black-Scholes pricing utilities
  - `tech-analysis.ts`: `calculateTechScore()` — EMA/MOM signal detection (TypeScript, mirrors `lib/_shared/tech-analysis.cjs`)
  - `indicators.ts`: ATR, ADX, RVOL, EMA, squeeze detection
  - `scoring.ts`: Score factor types used by `oss-core.ts`
  - `strategyProfiles.ts`: Strategy profile definitions (`swing`, `shortTerm`)
  - `queryClient.ts`: Singleton React Query client (staleTime 30s, gcTime 5min)
  - `queryKeys.ts`: Centralized cache key definitions
  - `supabase.ts`: Supabase JS client singleton
  - `utils.ts`: `formatDate()`, `formatCurrency()`, `CONTRACT_MULTIPLIER`, `SUPABASE_URL`, `SUPABASE_KEY`
  - `greeksHistory.ts`: Greeks history data helpers

**`src/lib/backtest/`:**
- Purpose: In-browser backtest simulation subsystem
- Key files:
  - `engine.ts`: Core walk-forward signal quality simulator
  - `option-sim.ts`: Credit spread simulator using BSM on ORATS chains; `applyFill()`, `DELTA_STOP` exit type
  - `wfa-options.ts`: Rolling WFA loop engine
  - `bsm-pricing.ts`: BSM pricing, delta, Ornstein-Uhlenbeck IV evolution, rolling HV
  - `chain-cache.ts`: SQLite cache for ORATS chain data; `findContractDirect()` O(1) PK index
  - `slippage.ts`: Dynamic slippage model (spread width, OI, DTE)
  - `portfolio-stress.ts`: Correlated drawdown using daily MTM
  - `analytics.ts`: `computeOptionAnalytics()`, `computeAnalytics()`
  - `sweep.ts`: Parameter sweep orchestration
  - `optimizer.worker.ts`: Web worker for non-blocking optimization runs
  - `types.ts`: All backtest-specific TypeScript interfaces

**`tests/`:**
- Purpose: Vitest integration and parity tests — run in CI
- Contains: 8 test files covering scoring parity (307 tests), BSM, option sim fills, WFA, portfolio stress, slippage, backtest audit, tech analysis parity

**`src/lib/__tests__/`:**
- Purpose: Unit tests co-located with lib code
- Contains: `oss-core.test.ts` (48 tests), `riskSizing.test.ts` (19 tests)

**`scripts/`:**
- Purpose: Offline analysis, backtesting, and data-prep scripts — not deployed
- Contains: TypeScript runner scripts (`wfa-run.ts`, `credit-sweep.ts`, `portfolio-sim.ts`, etc.) and CJS data inspection tools (`_build-viewer-data.cjs`, `_analyze-cache.cjs`, etc.)

**`data/`:**
- Purpose: Static data files consumed by browser and scripts
- Contains: `option-chains.sqlite` (SQLite chain cache), `wfa-results.json` (WFA output), `viewer-signals.json`, `viewer-configs.json`

**`supabase/migrations/`:**
- Purpose: SQL migration files applied to Supabase
- Pattern: Filename format `YYYYMMDD_NNN_description.sql`

## Key File Locations

**Entry Points:**
- `src/main.tsx`: Browser app bootstrap
- `src/router.tsx`: Route definitions and `TAB_PATHS` mapping
- `src/layouts/AppLayout.tsx`: Auth gate and app shell
- `index.html`: Vite HTML template

**Configuration:**
- `vercel.json`: Deployment routes, function timeouts, Vercel-managed cron
- `vite.config.ts`: Build config, path aliases, Vitest config
- `tsconfig.json`: TypeScript strict settings
- `tailwind.config.js`: Theme tokens (colors, typography)
- `eslint.config.js`: Linting rules
- `lib/_shared/config.js`: `SCAN_TICKERS` watchlist (27 tickers)

**Core Logic:**
- `src/lib/oss-core.ts`: Canonical scoring (LOQ + CSQ) — single source of truth
- `lib/_shared/scoring.cjs`: CJS mirror — must be kept in sync with `oss-core.ts`
- `src/lib/tech-analysis.ts`: `calculateTechScore()` — EMA / MOM signal detection
- `src/lib/riskSizing.ts`: Portfolio risk and position sizing
- `src/lib/backtest/engine.ts`: Walk-forward simulation core
- `src/lib/backtest/option-sim.ts`: Credit spread simulator

**Testing:**
- `tests/scoring-parity.test.ts`: 307 parity tests (oss-core.ts ↔ scoring.cjs)
- `tests/bsm-pricing.test.ts`: 32 BSM tests
- `tests/backtest-audit.test.ts`: 33 backtest engine tests
- `src/lib/__tests__/oss-core.test.ts`: 48 scoring unit tests
- `src/test/setup.ts`: Vitest global setup

## Naming Conventions

**Files:**
- React components: `PascalCase.tsx` (e.g., `PositionCard.tsx`, `AppLayout.tsx`)
- React hooks: `camelCase.ts` prefixed with `use` (e.g., `usePositions.ts`)
- Pure TS modules: `kebab-case.ts` (e.g., `oss-core.ts`, `risk-sizing.ts` → actually `riskSizing.ts`, mixed)
- API routes: `kebab-case.js` matching URL path (e.g., `scan-options.js` → `/api/scan-options`)
- Shared CJS modules: `kebab-case.cjs` (e.g., `scoring.cjs`, `tech-analysis.cjs`)
- Test files: `*.test.ts` (both in `tests/` and `src/lib/__tests__/`)

**Directories:**
- Lowercase kebab-case for all directories
- `_shared/` prefix indicates files not directly served, only imported

**Exports:**
- Pages use named exports: `export const PortfolioPage: React.FC = ...`
- Hooks use named exports: `export function usePositions() {...}`
- `src/lib/` modules use named exports throughout

## Where to Add New Code

**New Route/Page:**
- Add lazy import in `src/router.tsx` under the `AppLayout` children array
- Add `TAB_PATHS` entry in `src/router.tsx`
- Add `TabNav` entry in `src/components/TabNav.tsx`
- Create page component: `src/pages/NewPage.tsx` with named export

**New Data Query:**
- Add query key to `src/lib/queryKeys.ts`
- Create hook: `src/hooks/useNewData.ts` using `useQuery` from React Query
- Query fn should call either Supabase directly or a `/api/` endpoint via `fetch()`

**New Mutation:**
- Add to `src/hooks/usePositionMutations.ts` if position-related, or create new hook file
- Call `useInvalidatePositionsAndTransactions()` in `onSuccess` if positions data changes

**New Serverless Endpoint:**
- Create `api/new-endpoint.js` with `export default async function handler(req, res)`
- Add to `vercel.json` `functions` block if non-default timeout needed
- Import scoring from `lib/_shared/scoring.cjs` via `createRequire` if scoring needed

**New Scoring Logic:**
- Update BOTH `src/lib/oss-core.ts` AND `lib/_shared/scoring.cjs`
- Add parity test in `tests/scoring-parity.test.ts`

**New Type:**
- Add interface/type to `src/lib/types.ts` (domain types) or `src/lib/backtest/types.ts` (backtest types)

**Utilities:**
- Frontend helpers: `src/lib/utils.ts`
- API shared helpers: `lib/_shared/utils.js`
- Backtest helpers: `src/lib/backtest/analytics.ts` or new file in `src/lib/backtest/`

**Database Schema Change:**
- Add SQL file to `supabase/migrations/` with format `YYYYMMDD_NNN_description.sql`

## Special Directories

**`.planning/`:**
- Purpose: GSD planning documents (phases, codebase analysis)
- Generated: No
- Committed: Yes

**`data/`:**
- Purpose: SQLite chain cache + WFA result JSON files consumed by browser and scripts
- Generated: Partially (WFA JSON files generated by `scripts/wfa-run.ts`)
- Committed: Yes (`wfa-results.json`, `viewer-*.json` committed; `.sqlite-shm`/`.sqlite-wal` not committed)

**`scripts/`:**
- Purpose: Offline analysis scripts; not deployed to Vercel
- Generated: No
- Committed: Yes (named scripts); dot-prefixed variants (`.credit-worker.mjs`) are uncommitted in progress

**`dist/`:**
- Purpose: Vite production build output
- Generated: Yes
- Committed: No (in `.gitignore`)

**`supabase/migrations/`:**
- Purpose: SQL migration history
- Generated: No
- Committed: Yes

---

*Structure analysis: 2026-03-14*
