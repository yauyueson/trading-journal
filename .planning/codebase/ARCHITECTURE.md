# Architecture

**Analysis Date:** 2026-03-14

## Pattern Overview

**Overall:** Full-stack SPA with Serverless API Functions

**Key Characteristics:**
- React 18 SPA deployed on Vercel with colocated serverless API routes in `api/`
- Supabase as the sole persistent data store (PostgreSQL + auth + realtime channels)
- React Query v5 as the client-side data layer — no Redux or custom state manager
- Scoring logic maintained in two synchronized mirrors: TypeScript (`src/lib/oss-core.ts`) and CJS (`lib/_shared/scoring.cjs`)
- Backtest engine runs entirely in-browser (TypeScript), pulling ORATS chain data via a SQLite cache

## Layers

**Frontend — UI Layer:**
- Purpose: Render pages, respond to user actions
- Location: `src/pages/`
- Contains: Page components (lazy-loaded via React Router), composition of hooks + components
- Depends on: React Query hooks (`src/hooks/`), UI components (`src/components/`), contexts (`src/context/`)
- Used by: Router (`src/router.tsx`)

**Frontend — Hooks Layer:**
- Purpose: Encapsulate all data fetching and mutations; no prop drilling
- Location: `src/hooks/`
- Contains: `useQuery` wrappers for read operations, `useMutation` wrappers for writes, realtime subscription
- Depends on: `src/lib/supabase.ts`, `src/lib/queryKeys.ts`, Vercel API endpoints via `fetch()`
- Used by: Pages

**Frontend — Context Layer:**
- Purpose: Global app state that is not server data
- Location: `src/context/`
- Contains: `AuthContext.tsx` (Supabase session), `AppSettingsContext.tsx` (portfolio config, strategy toggle), `BuyModalContext.tsx` (modal open/close)
- Depends on: `src/lib/supabase.ts`
- Used by: `AppLayout`, pages, hooks

**Frontend — Library Layer:**
- Purpose: Pure logic, types, and utilities with no side effects
- Location: `src/lib/`
- Contains: `types.ts` (all shared TypeScript interfaces), `oss-core.ts` (canonical scoring), `riskSizing.ts`, `bsm.ts`, `indicators.ts`, `tech-analysis.ts`, `queryClient.ts`, `queryKeys.ts`, `strategyProfiles.ts`, `utils.ts`
- Depends on: Nothing (pure functions + types)
- Used by: Hooks, pages, backtest engine

**Frontend — Backtest Subsystem:**
- Purpose: In-browser walk-forward analysis engine
- Location: `src/lib/backtest/`
- Contains: `engine.ts` (signal quality simulator), `option-sim.ts` (credit spread simulator), `wfa-options.ts` (rolling WFA loop), `bsm-pricing.ts` (Black-Scholes + HV), `chain-cache.ts` (SQLite ORATS cache), `slippage.ts`, `portfolio-stress.ts`, `analytics.ts`, `sweep.ts`, `types.ts`
- Depends on: `src/lib/tech-analysis.ts`, `src/lib/indicators.ts`, ORATS data via `api/backtest-data.js`
- Used by: `src/pages/Backtest.tsx` and `src/lib/backtest/optimizer.worker.ts` (web worker)

**API Layer — Serverless Functions:**
- Purpose: Serve computed data to the frontend; call external APIs (ORATS, Tiingo); write to Supabase
- Location: `api/`
- Contains: ESM `.js` files, each exported as `default async function handler(req, res)`
- Depends on: `lib/orats-client.js`, `lib/tiingo-client.js`, `lib/_shared/scoring.cjs`, `lib/_shared/tech-analysis.cjs`, `lib/_shared/ivHistory.cjs`, `lib/_shared/supabase-rest.js`
- Used by: Frontend hooks, external cronjob triggers (cronjobs.org)

**Shared Library Layer:**
- Purpose: Common utilities reusable across API routes; CJS mirror of frontend scoring
- Location: `lib/` and `lib/_shared/`
- Contains: `orats-client.js` (ORATS API wrapper), `tiingo-client.js` (Tiingo candle client), `tech-analysis.js`, `indicators.js`, `_shared/scoring.cjs` (CJS mirror of `oss-core.ts`), `_shared/ivHistory.cjs`, `_shared/supabase-rest.js` (raw `fetch()` REST helper), `_shared/config.js` (SCAN_TICKERS), `_shared/tech-analysis.cjs`
- Depends on: External APIs, `ORATS_API_TOKEN`, `TIINGO_API_TOKEN`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`
- Used by: API routes

## Data Flow

**Frontend Read (Positions):**

1. `src/main.tsx` mounts `QueryClientProvider` → `AppSettingsProvider` → `AuthProvider` → `RouterProvider`
2. Route lazy-loads page component (e.g., `Portfolio.tsx`)
3. Page calls `usePositions()` hook → `useQuery` with key `['positions']`
4. Query fn calls `supabase.from('positions').select('*')` (direct JS client, no API route)
5. React Query caches result for 30s (`staleTime`) / 5 min (`gcTime`)
6. Supabase realtime channel (`rq-positions`) fires `queryClient.invalidateQueries` on DB change via `useRealtimeInvalidation` (mounted in `AppLayout`)

**Frontend Write (Position Mutation):**

1. User action in page → calls mutation hook (e.g., `usePositionAction()`)
2. Mutation fn writes directly to Supabase via JS client
3. `onSuccess` calls `queryClient.invalidateQueries` for `positions` and `transactions` keys
4. React Query refetches → UI updates

**API Request Flow (Scanner / Strategy Recommender):**

1. Page calls `useSignalScanner()` or `useStrategyRecommend()` → `useQuery` fires `fetch('/api/scan-options?...')` or `fetch('/api/strategy-recommend?...')`
2. Vercel serverless function receives request
3. Handler fetches ORATS chain data via `lib/orats-client.js` (ORATS REST API)
4. Scoring logic imported from `lib/_shared/scoring.cjs`
5. Handler returns ranked JSON results
6. React Query caches result, page renders

**Cron Flow (Signal Scan):**

1. cronjobs.org hits `GET /api/cron-signal-scan` at 21:00 UTC weekdays
2. Handler fetches candles from Tiingo via `lib/tiingo-client.js`
3. Runs `calculateTechScore` from `lib/_shared/tech-analysis.cjs`
4. Upserts signals to `signal_history` table via `lib/_shared/supabase-rest.js` (raw fetch, no JS client)
5. Sends Discord embed via `DISCORD_WEBHOOK_URL`

**State Management:**
- Server data: React Query v5 (cache, invalidation, stale-time)
- Auth state: `AuthContext` (Supabase session)
- App settings: `AppSettingsContext` (Supabase `app_settings` table + localStorage cache, 5-minute TTL)
- Modal state: `BuyModalContext`
- Backtest results: local React state in `Backtest.tsx`

## Key Abstractions

**Position:**
- Purpose: Core domain object representing an options trade (watchlist / active / closed)
- Examples: `src/lib/types.ts` → `Position` interface
- Pattern: Status enum (`watchlist | active | closed`) drives display in `Portfolio.tsx`

**React Query Key Registry:**
- Purpose: Centralized cache key definitions prevent cache key typos and enable targeted invalidation
- Examples: `src/lib/queryKeys.ts`
- Pattern: All queries and mutations reference `queryKeys.*` constants

**Mutation Hook Pattern:**
- Purpose: Each write operation is a named hook that encapsulates mutation fn + invalidation
- Examples: `src/hooks/usePositionMutations.ts` — 11 exported hooks
- Pattern: Each hook calls `useInvalidatePositionsAndTransactions()` helper in `onSuccess`

**Scoring Dual-Mirror:**
- Purpose: Same scoring algorithm runs in browser (TypeScript) and in serverless API (CJS)
- Examples: `src/lib/oss-core.ts` ↔ `lib/_shared/scoring.cjs`
- Pattern: 307 parity tests in `tests/scoring-parity.test.ts` enforce both files stay in sync

**Strategy Profile:**
- Purpose: Named config bundle (DTE range, delta range, spread width) selected via header toggle
- Examples: `src/lib/strategyProfiles.ts`, `AppSettingsContext` `activeStrategy`
- Pattern: `swing` vs `shortTerm` profiles; active profile passed as `profileStrategy` query param to API routes

## Entry Points

**Browser SPA:**
- Location: `src/main.tsx`
- Triggers: Browser load, Vercel static file serving
- Responsibilities: Mounts React root, wraps with `QueryClientProvider`, context providers, `RouterProvider`

**App Shell:**
- Location: `src/layouts/AppLayout.tsx`
- Triggers: All authenticated routes render through this
- Responsibilities: Auth gate (redirects to `LoginPage` if not authenticated), sticky header, strategy toggle, `TabNav`, mounts `useRealtimeInvalidation`

**Router:**
- Location: `src/router.tsx`
- Triggers: URL changes
- Responsibilities: Maps paths to lazy-loaded page components, root redirects to `/portfolio`

**Serverless Handler:**
- Location: `api/*.js` (e.g., `api/scan-options.js`)
- Triggers: HTTP requests from frontend or cron
- Responsibilities: Parse query params, call external APIs, run scoring, return JSON

## Error Handling

**Strategy:** Errors handled at query/mutation boundary; no global error boundary

**Patterns:**
- React Query mutations: errors surface via `mutation.error` state; pages display inline error messages
- API routes: try/catch wraps handler body; `res.status(500).json({ error, message })` on failure
- Supabase queries: `if (error) throw error` pattern in query functions; React Query catches and stores in `query.error`
- ORATS/Tiingo failures in cron jobs: logged to console, Discord notification skipped silently

## Cross-Cutting Concerns

**Logging:** `console.log` / `console.error` in API routes; no structured logger
**Validation:** Input validation inline in API handlers (query param checks, missing ticker → 400)
**Authentication:** `AuthContext` manages Supabase session; `AppLayout` enforces auth gate for all routes; API routes do not validate auth (public endpoints, no JWT check)
**Realtime:** `useRealtimeInvalidation` subscribes to `positions` and `transactions` Postgres changes on mount in `AppLayout`

---

*Architecture analysis: 2026-03-14*
