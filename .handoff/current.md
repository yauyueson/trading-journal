---
task: Switch quote route back from ORATS to CBOE + fix portal quote access
stage: done
owner: user
from: gemini
timestamp: 2026-09-20T11:25:00-04:00
---

## Objective

Switch the portal quote route back to CBOE following expiration of the ORATS subscription. Fix quote failures in both local development (Vite dev server) and production (Vercel serverless API), optimize CBOE bulk quote fetching performance, and ensure graceful fallback across all option endpoints.

## Context

- **ORATS Subscription Status**: ORATS API calls return HTTP 403 Forbidden (`User is not authorized to access this resource`).
- **CBOE API Status**: CBOE delayed quotes (`https://cdn.cboe.com/api/global/delayed_quotes/options/{TICKER}.json`) are fully functional (HTTP 200, 10,400+ options per index ticker, with bid/ask/Greeks/IV).
- **Tiingo Status**: Tiingo stock candles and IEX live prices (`api/live-prices.js`) are fully active (HTTP 200).
- Relevant files:
  - `lib/_shared/config.js` (line 4: `DATA_SOURCE`)
  - `api/option-prices.js` (lines 91–272: `handler`, `handleORATS`, `handleCBOE`)
  - `api/scan-options.js` (lines 85–150: data source branching)
  - `api/strategy-recommend.js` (lines 1161–1368: CBOE path)
  - `api/check-alerts.js` (lines 96–150) & `api/daily-recap.js` (lines 78–130)
  - `vite.config.ts` (lines 102–185: `localApiPlugin` middleware)
  - `.env`, `.env.local`, `.env.development.local`

## Work Done

### Gemini (The Analyst) — 2026-09-20T11:18:00-04:00
Identified the root causes of portal quote failure and verified CBOE connectivity:
1. **ORATS 403 Unhandled in `api/option-prices.js`**: `lib/_shared/config.js` and `.env.local` set `DATA_SOURCE=ORATS`. When `handleORATS` receives a 403 error, it does not fall back to CBOE; it throws HTTP 500 or 404, breaking marks in `Dashboard.tsx` and `Portfolio.tsx`.
2. **Missing Bulk Endpoint in `vite.config.ts`**: `localApiPlugin()` in Vite only hooks `/api/option-price` (single GET). Requests to `/api/option-prices-bulk` (multi-leg POST used by `useOptionPrices.ts`) return HTTP 404 on Vite dev server.
3. **CBOE Bulk Inefficiency in `api/option-prices.js`**: `handleCBOE()` sequentially downloads the full ~4.6 MB JSON file per leg. For 4 legs on QQQ, that is ~18 MB downloaded serially, risking Vercel 15s timeout.
4. **Fallback check bug in `check-alerts.js` / `daily-recap.js`**: `if (dataSource === 'CBOE' || Object.keys(optionChains).length === 0)` fails to trigger CBOE fallback when ORATS assigns `optionChains[ticker] = []` because `Object.keys()` is non-zero.

Authored comprehensive implementation plan in `implementation_plan.md`.

## Artifacts

- `implementation_plan.md`: Comprehensive plan covering configuration update, CBOE caching/optimization, ORATS fallback, and Vite dev server middleware fixes.

## Next Action

Claude / Builder to implement the proposed changes in `implementation_plan.md`:
1. Update `lib/_shared/config.js` default `DATA_SOURCE` to `'CBOE'`.
2. Update `.env.local`, `.env.development.local`, `.env` to `DATA_SOURCE=CBOE`.
3. Optimize `api/option-prices.js` `handleCBOE` with in-request ticker caching and fuzzy OCC matching; wrap `handleORATS` with CBOE fallback.
4. Harden `api/scan-options.js`, `api/check-alerts.js`, `api/daily-recap.js` fallback paths.
5. Update `vite.config.ts` to support `/api/option-prices-bulk` and `/api/option-prices`.
6. Run verification tests.
