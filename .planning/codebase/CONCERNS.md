# Codebase Concerns

**Analysis Date:** 2026-03-14

---

## Security Considerations

**Hardcoded Supabase credentials committed to source:**
- Risk: Supabase URL and publishable key are hardcoded in `src/lib/utils.ts` lines 46–47 (`SUPABASE_URL` and `SUPABASE_KEY`). While the anon key is technically "publishable," hardcoding it in source means it's committed to git and never rotatable without a code change.
- Files: `src/lib/utils.ts`, `src/lib/supabase.ts`
- Current mitigation: The key is `sb_publishable_*` (anon key), not a service role key. RLS policies in Supabase are the real guard.
- Recommendations: Move to `import.meta.env.VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` so the values are configurable without code changes. Add a comment that this is intentionally a publishable anon key.

**Wildcard CORS on all API routes:**
- Risk: All API routes set `Access-Control-Allow-Origin: *`. While the app is not multi-tenant, any origin can call the ORATS/scoring endpoints which consume paid API quota.
- Files: `api/strategy-recommend.js`, `api/scan-options.js`, `api/option-prices.js`, `api/earnings.js`, `api/cron-iv.js`, `api/check-alerts.js`, `api/daily-recap.js`, `vercel.json`
- Current mitigation: None. The public endpoints call paid external APIs (ORATS, Tiingo) on every request.
- Recommendations: Restrict `Access-Control-Allow-Origin` to the production domain (`https://your-app.vercel.app`). At minimum add a shared secret header check for the scanner endpoint.

**Nasdaq API access with User-Agent spoofing:**
- Risk: `fetchRV30FromNasdaq()` and `fetchEarnings()` use browser-mimicking User-Agent strings to access `api.nasdaq.com` without an API key. This is a TOS violation and the API may block Vercel IP ranges without warning.
- Files: `api/strategy-recommend.js` lines 241–246, 282–288
- Current mitigation: ORATS cores and Tiingo provide the primary RV30 data — Nasdaq is a tertiary fallback.
- Recommendations: Remove Nasdaq fallback entirely or replace with a licensed data source (ORATS already provides `orHv30d`). Document that `rv30 == null` is an acceptable degraded state.

**CBOE scraping with spoofed headers in dev server:**
- Risk: `vite.config.ts` dev middleware fetches `cdn.cboe.com` with spoofed `Referer` and `Origin` headers. CBOE delayed quotes are intended for browser use; server-to-server use may violate TOS.
- Files: `vite.config.ts` lines 122–128, 460–466
- Current mitigation: Only in development (Vite middleware, not production paths). Production uses ORATS.
- Recommendations: Acceptable for local development; ensure `DATA_SOURCE=ORATS` is set in all production Vercel env vars.

**Debug filesystem write in serverless function:**
- Risk: `api/strategy-recommend.js` lines 38–42 contain `_dbg()` which calls `fs.appendFileSync` to write to `.cursor/debug.log` inside the Lambda. On Vercel, `/tmp` is the only writable path — writes to `process.cwd()` will silently fail or throw. More importantly, the function is exported and called throughout the file, adding unnecessary I/O overhead.
- Files: `api/strategy-recommend.js` lines 36–43
- Current mitigation: The write is wrapped in `try/catch` so failure is silently ignored.
- Recommendations: Remove `_dbg()` entirely or gate it behind a `DEBUG=1` env var check.

---

## Tech Debt

**Dual-file scoring synchronization (highest risk):**
- Issue: `src/lib/oss-core.ts` (TypeScript) and `lib/_shared/scoring.cjs` (CommonJS) must be kept manually in sync. Any scoring change requires editing both files. The 307 parity tests enforce correctness but do not prevent divergence during rapid iteration.
- Files: `src/lib/oss-core.ts`, `lib/_shared/scoring.cjs`
- Impact: A missed sync causes scoring differences between the frontend scanner and the API recommendation engine — users see different scores for the same option depending on which path they use.
- Fix approach: Long-term: generate `scoring.cjs` from `oss-core.ts` via a build script. Short-term: add a CI step that diffs key function signatures between the two files.

**`vite.config.ts` contains ~900 lines of duplicated scoring + mock API logic:**
- Issue: The Vite dev server plugin in `vite.config.ts` duplicates the LOQ scoring algorithm (lines 24–95), a full CBOE option scanner, earnings fetcher, and multiple thin-shim handlers for `backtest-candles`, `backtest-iv`, and `cron-iv-backfill` that reference API files (`api/backtest-candles.js`, `api/backtest-iv.js`, `api/cron-iv-backfill.js`) which do not exist in the `api/` directory.
- Files: `vite.config.ts`
- Impact: The inline scoring in `vite.config.ts` diverges from `oss-core.ts`. Dev server behavior for `/api/scan-options` uses CBOE while production uses ORATS — different data, different scores.
- Fix approach: The shim handlers should import from actual api files (as `strategy-recommend` shim already does correctly). Remove the inline scoring duplication.

**References to non-existent API files in dev shims:**
- Issue: `vite.config.ts` shim handlers at lines 777, 824, 869 reference `api/backtest-candles.js`, `api/backtest-iv.js`, and `api/cron-iv-backfill.js`. None of these files exist in `api/`. The unified endpoint is `api/backtest-data.js` with `?type=candles` / `?type=iv`.
- Files: `vite.config.ts` lines 769–904
- Impact: Any developer using local dev and hitting `/api/backtest-candles` or `/api/backtest-iv` gets a 500 error.
- Fix approach: Update shim paths to point to `api/backtest-data.js` and pass the `type` query param.

**`api/strategy-recommend.js` is 1,966 lines — monolith API handler:**
- Issue: The strategy recommendation handler is a single 1,966-line file combining: BSM helpers, scoring loader, RV computation, earnings fetching, Nasdaq scraping, regime detection, spread selection, score calculation, hysteresis, snapshot persistence, and signal history. Cyclomatic complexity is very high.
- Files: `api/strategy-recommend.js`
- Impact: Any change risks unintended side effects. Error paths are inconsistent (some catch blocks swallow errors silently at lines 98, 1276, 1289). Very hard to test individual components.
- Fix approach: Extract RV/earnings data fetching into `lib/market-data.js`, regime detection into `lib/regime.js`. The handler itself should be <400 lines of orchestration.

**`src/lib/types.ts` uses `tech_data?: any` for position technical data:**
- Issue: `src/lib/types.ts` line 32 declares `tech_data?: any` on the `Position` interface. This type is used across `PositionCard.tsx`, portfolio logic, and scoring integration but carries no schema guarantees.
- Files: `src/lib/types.ts`, `src/components/PositionCard.tsx`
- Impact: TypeScript provides no safety for tech data access. Runtime crashes if field shape changes.
- Fix approach: Define a `TechData` interface in `src/lib/types.ts` matching the shape returned by `api/batch-refresh-tech.func`.

**CSQ scoring framework is partially dead code:**
- Issue: `calculateCSQRaw` is defined in `src/lib/oss-core.ts` and `lib/_shared/scoring.cjs` but is only called from `api/scan-options.js` — never from `api/strategy-recommend.js` which uses `calculateUnifiedScore` with inline credit spread scoring instead. The `CSQ_WEIGHTS` constant and related helpers (`CSQ_VEGA_PENALTY_WEIGHT`) serve only the scanner.
- Files: `src/lib/oss-core.ts` lines 662–690, `lib/_shared/scoring.cjs`, `api/scan-options.js`
- Impact: Confusing dual-path scoring for credit strategies. CSQ in scanner uses different weights than credit scoring in strategy-recommend.
- Fix approach: Decide whether scanner should use `calculateUnifiedScore` or keep CSQ. Document the divergence explicitly.

**`@deprecated` functions still exported in `oss-core.ts`:**
- Issue: `src/lib/oss-core.ts` lines 602–604 export two deprecated constants/functions with JSDoc `@deprecated` tags. They remain in the public API surface.
- Files: `src/lib/oss-core.ts`
- Impact: Low — just pollutes the API surface and confuses the 307 parity tests.
- Fix approach: Check if any consumer still imports them; remove after verifying no usage.

**`_scoringLoaded` singleton is not thread-safe across concurrent requests:**
- Issue: `api/strategy-recommend.js` uses module-level `_scoringLoaded` boolean to lazily load `scoring.cjs`. On cold start with concurrent requests, multiple calls to `ensureScoring()` may race. If the first import throws, `_scoringLoaded` stays `false` but module-level vars remain partially populated.
- Files: `api/strategy-recommend.js` lines 52–102
- Impact: Rare — only on cold starts with concurrent bursts. Could cause `TypeError: X is not a function` on one request.
- Fix approach: Replace `_scoringLoaded` flag with a `Promise` singleton: `let scoringPromise = null; ... scoringPromise = scoringPromise || loadScoring();`.

---

## Performance Bottlenecks

**`strategy-recommend.js` makes 4–6 serial external API calls per request:**
- Problem: The handler sequentially fetches: ORATS chain, ORATS cores, ORATS earnings/impliedMove, Tiingo candles (fallback), candidate_snapshots (hysteresis), then writes snapshots and signal history. With 15s Vercel timeout, slow ORATS responses near the limit will time out.
- Files: `api/strategy-recommend.js` lines 1140–1900
- Cause: Chains, cores, and earnings/impliedMove calls are mostly serial despite being independent.
- Improvement path: Parallelize `getCores`, `getEarnings`, `getImpliedMove` with `Promise.all()` — these are independent reads. Current partial parallelism exists (line ~1178) but chains are still sequential.

**Portfolio page fetches bulk option prices on every manual refresh:**
- Problem: `Portfolio.tsx` `refreshAllPrices()` triggers a `/api/option-prices-bulk` POST for all active position legs simultaneously. With 10+ positions each having 2 legs, this is 20+ chain lookups per refresh.
- Files: `src/pages/Portfolio.tsx` lines 192–270
- Cause: No incremental refresh — all or nothing. Results are stored in component state (`bulkData`), not React Query cache, so React Query's deduplication doesn't apply.
- Improvement path: Move bulk price data into a React Query query with a sensible staleTime (30s) so manual refreshes are rate-limited.

**SQLite chain cache in backtest runs on main thread during dev:**
- Problem: `src/lib/backtest/chain-cache.ts` uses `better-sqlite3` (synchronous, blocking API). The optimizer worker runs in a Web Worker thread, but the chain-cache is imported there too. `better-sqlite3` is a native Node module and will fail in a browser Web Worker context.
- Files: `src/lib/backtest/chain-cache.ts`, `src/lib/backtest/optimizer.worker.ts`
- Cause: `better-sqlite3` requires Node.js — it cannot run in the browser or browser Web Workers.
- Improvement path: Chain cache is only used for backtest scripts (not the browser backtest engine). Ensure `chain-cache.ts` is never imported from `optimizer.worker.ts` or browser code paths.

---

## Fragile Areas

**`oss-core.ts` / `scoring.cjs` parity — 307 tests are the only guard:**
- Files: `src/lib/oss-core.ts`, `lib/_shared/scoring.cjs`, `src/test/parity/`
- Why fragile: Any refactor of `oss-core.ts` that doesn't immediately update `scoring.cjs` passes TypeScript/lint but fails 307 parity tests. The dual-maintenance burden means parity drift is a constant risk during rapid development.
- Safe modification: Always run `npm test` immediately after any change to either file. The parity test suite is the single most important safety net.
- Test coverage: 307 parity tests cover numerical outputs but not all edge cases (e.g., `null` inputs, boundary DTE values).

**Cron jobs managed externally at cronjobs.org — no in-repo visibility:**
- Files: `api/cron-signal-scan.js`, `api/cron-trade-outcomes.js`, `api/check-alerts.js`, `api/daily-recap.js`
- Why fragile: 4 of 5 cron jobs are triggered by cronjobs.org, not Vercel. Only `cron-iv?job=backfill` is in `vercel.json`. If the cronjobs.org account lapses, expires, or the webhook URL changes after a Vercel redeploy, all signal scanning and trade outcome computation silently stops. There is no alerting if a cron fails.
- Safe modification: Document the exact cronjobs.org schedule in `CLAUDE.md`. Add a heartbeat check — each cron should write a `last_run_at` timestamp to `app_settings` so the frontend can warn if stale.

**Hysteresis query in `strategy-recommend.js` uses raw SQL-style filter string interpolation:**
- Files: `api/strategy-recommend.js` lines 1430–1465
- Why fragile: The hysteresis read builds a Supabase REST filter by interpolating `upperTicker` and date strings directly into URL query params. If `upperTicker` contains special characters (e.g., `BRK.B`, `BF.B`), the URL may be malformed. Error is caught and logged as non-critical but silently degrades hysteresis.
- Safe modification: URL-encode all interpolated values. Test with dot-containing tickers.

**`PositionCard.tsx` is 999 lines with interleaved fetch and render logic:**
- Files: `src/components/PositionCard.tsx`
- Why fragile: Option price fetching, score display, Greeks history, and mutation handlers are all inline in a single component. The `initialData?: any[]` prop carries untyped bulk data from the parent.
- Test coverage: No component tests for PositionCard — only indirect coverage via integration.
- Safe modification: Extract data fetching into `usePositionCardData` hook before adding new price/score logic.

---

## Known Bugs

**`console.log` left in production code path:**
- Symptoms: Browser console shows `[Card] Using Bulk Data for {ticker}` on every portfolio load.
- Files: `src/components/PositionCard.tsx` line 171
- Trigger: Any position with bulk data present.
- Workaround: Cosmetic only — no functional impact.

**Vite shim references non-existent `api/backtest-candles.js`:**
- Symptoms: `/api/backtest-candles` returns 500 in local dev. Backtest candle fetch fails silently in dev environment.
- Files: `vite.config.ts` line 777
- Trigger: Running `npm run dev` and opening the Backtest tab.
- Workaround: Use `vercel dev` instead of `npm run dev` for full backtest testing.

---

## Scaling Limits

**Vercel Hobby plan: 12-function limit:**
- Current capacity: 12 deployed Serverless Functions (enforced by Vercel Hobby). Current count is near the limit (13 `.func` directories in `.vercel/output/functions/api/` including stale deployed artifacts).
- Limit: Adding any new `api/*.js` file without consolidating an existing one will breach the limit and block deployments.
- Scaling path: Merge related endpoints (e.g., `check-alerts` and `daily-recap` share identical Supabase setup boilerplate) or upgrade to Vercel Pro.

**ORATS API token — single shared key for all endpoints:**
- Current capacity: `ORATS_API_TOKEN` is a single token used by `lib/orats-client.js` for all chain, cores, earnings, and IV snapshot fetches.
- Limit: ORATS has per-plan rate limits. High-frequency scan usage (Scanner page with 27 tickers × multiple API calls) can exhaust the daily quota.
- Scaling path: Add request-level caching in `lib/orats-client.js` using an in-memory TTL cache (or `orats_iv_cache` table already present in the DB) before making ORATS API calls.

---

## Missing Critical Features

**No authentication on public API endpoints:**
- Problem: All API routes (`/api/strategy-recommend`, `/api/scan-options`, `/api/option-prices`, `/api/analytics`) are publicly accessible. No user authentication is required to trigger ORATS/Tiingo calls.
- Blocks: Prevents multi-user deployment. Any scraperbot can exhaust the ORATS quota by hitting `/api/scan-options?ticker=SPY` in a loop.

**No error monitoring / alerting:**
- Problem: There is no Sentry, Datadog, or equivalent error tracking. API 500 errors surface only in Vercel function logs (accessible only via Vercel dashboard).
- Blocks: Silent failures in cron jobs (signal scan, trade outcomes) go undetected until a user notices stale data.

---

## Test Coverage Gaps

**No tests for `api/` route handlers:**
- What's not tested: All 12 Vercel API route handlers in `api/` have zero test coverage. Only the shared scoring library (`lib/_shared/scoring.cjs` via parity) and frontend utilities are tested.
- Files: `api/strategy-recommend.js`, `api/scan-options.js`, `api/option-prices.js`, `api/analytics.js`, `api/cron-signal-scan.js`, `api/cron-iv.js`
- Risk: Regressions in regime detection, spread selection, or IV snapshot logic go undetected until they surface in production.
- Priority: High

**No tests for `src/pages/` components:**
- What's not tested: `Portfolio.tsx`, `Scanner.tsx`, `Signals.tsx`, `StrategyRecommender.tsx`, `Backtest.tsx` have no React Testing Library tests.
- Files: `src/pages/` directory
- Risk: UI regressions in core user flows (adding positions, viewing recommendations, running backtest).
- Priority: Medium

**`src/lib/scoring.ts` (frontend scorer) not in parity test suite:**
- What's not tested: `src/lib/scoring.ts` wraps `oss-core.ts` and provides `calculateCreditSpreadScore`, `calculateDebitSpreadScore`, `calculateSingleLOQWithFactors`. These wrapper functions are not in the 307 parity tests — only the raw `oss-core` functions are.
- Files: `src/lib/scoring.ts`
- Risk: `scoring.ts` could drift from `oss-core.ts` without parity failures.
- Priority: Medium

---

*Concerns audit: 2026-03-14*
