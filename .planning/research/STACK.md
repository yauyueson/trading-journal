# Technology Stack

**Project:** WFA-Driven Workflow Integration
**Researched:** 2026-03-14
**Milestone:** Signal-to-spread-builder workflow, IV rank filtering, exit automation pre-fill

---

## Executive Decision

**No new dependencies are needed.** The existing stack already provides every primitive required for this milestone. The work is entirely about wiring together what already exists: URL params for signal context, `strategyProfiles.ts` for parameter definitions, `AppSettingsContext` for global state, and extending the API's query param handling. Introducing new libraries (Zustand, nuqs, etc.) would add complexity without benefit for a 5-feature milestone on a mature codebase.

---

## Recommended Stack

### Signal Context Transport: URL Search Params (existing)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `react-router-dom` `useSearchParams` | ^6.30.3 (already installed) | Pass signal metadata (ticker, direction, score, streak, signal type) from Signals page to StrategyRecommender | Already partially implemented — `/selector?ticker=SPY&direction=CALL&strategy=swing` exists. Adding `score`, `streak`, `signalType` is a 2-line change on both ends. Survives page refresh, shareable URL, no new deps. |

**Decision rationale:** The codebase already uses `navigate('/selector?ticker=...&direction=...&strategy=...')` in Signals.tsx (line 706) and reads those params via `useSearchParams` in StrategyRecommender.tsx (line 72). Extending to `score`, `streak`, and `signalType` follows the established pattern with zero new infrastructure.

**Alternative rejected: `location.state` via `navigate()`** — Does not survive page refresh. If the user reloads `/selector`, the signal context vanishes. URL params are the right choice for this use case.

**Alternative rejected: Zustand store** — Overkill for 5 fields passed in one navigation. Adds a dependency and a new abstraction layer that future maintainers must learn.

**Alternative rejected: nuqs** — Type-safe URL param library with good DX, but introduces a dependency for functionality that `useSearchParams` already handles. Worth considering only if the app adds many filter screens.

### Strategy Profile System: Existing `strategyProfiles.ts`

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `src/lib/strategyProfiles.ts` | (in-repo, not versioned) | Single source of truth for swing/shortTerm DTE, delta, width, TP, ivRankMin | Already complete. `STRATEGY_PROFILES.swing.ivRankMin = 30`, `profitTarget = 0.30`. API routes need to import this (via `lib/_shared/` CJS mirror or inline the values). |

**Gap to address:** `api/strategy-recommend.js` does not currently read `strategy` from query params. It must be extended to accept `?strategy=swing|shortTerm` and apply profile-specific ivRankMin, defaultDelta, spreadWidth, and profitTarget. This is a pure API change, no new library.

### IV Rank Filter: ORATS `ivPercentile` (existing data flow)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| ORATS `getCores()` → `ivPercentile` field | (external API) | Gate candidates below strategy-specific IV rank threshold | Already fetched and returned as `result.regime.ivPercentile` in StrategyRecommender. The filter logic goes in the API layer before returning candidates, not in the frontend. Backend filtering is correct — sending filtered data is cheaper than sending everything and hiding rows. |

**Implementation note:** Add `ivRankMin` enforcement in `api/strategy-recommend.js`: if `ivPercentile < profile.ivRankMin / 100`, return a `LOW_IV_GATE` error with the threshold clearly stated. Frontend renders this as an inline warning, not a crash.

### Profit Target Pre-Fill: Strategy Profile + Form Init (existing)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `strategyProfiles.profitTarget` + existing position open form state | (in-repo) | Auto-populate TP field when opening position from spread builder | `StrategyRecommender.tsx` already has `openPosPrice` state. Adding a `profitTarget` pre-fill is a one-liner: read `getProfile(activeStrategy).profitTarget` and initialize. No library needed. |

### Global Strategy Toggle: `AppSettingsContext` (existing)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `src/context/AppSettingsContext.tsx` | (in-repo) | Persist `activeStrategy` (swing/shortTerm) across sessions | Already implemented. `activeStrategy` is stored in `localStorage` under `'trading-journal-active-strategy'` and exposed via `useAppSettings()`. The toggle widget just needs to be surfaced in the spread builder header. |

### State Persistence: localStorage (existing)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `localStorage` (native browser API) | N/A | Persist strategy toggle selection across browser sessions | Already in use for `activeStrategy`. sessionStorage was considered but is tab-isolated and clears on close — not appropriate for a preference the user sets once and expects to persist. |

### Testing: Vitest + Testing Library (existing)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `vitest` | ^4.0.18 | Test signal context parsing, IV rank filter logic, profit target pre-fill | Already at 488 tests. New features need: (1) unit tests for URL param parsing helpers, (2) integration tests for IV rank gate in API handler, (3) strategy profile defaults assertion. No framework change. |

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Signal context transport | URL search params (existing) | `location.state` via navigate() | Does not survive page refresh; state lost on direct URL access |
| Signal context transport | URL search params (existing) | Zustand store | No install required for 5 fields; adds dependency with zero benefit at this scale |
| Signal context transport | URL search params (existing) | nuqs | Type safety benefit not worth new dependency; `useSearchParams` already works |
| IV rank filtering | API-side filter | Frontend hide/gray-out | Sends unnecessary data to client; filtering server-side is correct; user sees the reason (LOW_IV_GATE) |
| Strategy params in API | Extend existing `strategy-recommend.js` | New dedicated endpoint | Single endpoint with strategy param is simpler; consistent with existing `?strategy=swing|shortTerm` param already used in frontend URL |
| TP pre-fill | Read from `strategyProfiles.ts` | Hardcode 30%/40% | Profiles are the single source of truth; hardcoding creates drift if WFA re-validates new targets |
| Global strategy toggle | Extend existing `AppSettingsContext` | New Context or Zustand | Context already works; adding another store is pure overhead |

---

## What Does NOT Change

- **React 18** — no upgrade needed
- **Vite 5** — no config changes
- **React Query v5** — no new queries; `strategy-recommend` is already a fetch-based hook, not a React Query query
- **Supabase** — no new tables (constraint from PROJECT.md)
- **`oss-core.ts` / `scoring.cjs`** — no scoring changes in this milestone; signal context display is pure UI
- **307 parity tests** — unaffected; no scoring logic changes
- **Tailwind CSS 3** — all new UI uses existing dark dashboard conventions already established in `Signals.tsx` and `StrategyRecommender.tsx`

---

## API Layer Changes (No New Deps)

The API routes are Vercel ESM `.js` files. Changes needed:

```javascript
// api/strategy-recommend.js — additions only
const strategy = req.query.strategy ?? 'swing';
const ivRankMin = strategy === 'shortTerm' ? 0.40 : 0.30;
const profitTarget = strategy === 'shortTerm' ? 0.40 : 0.30;
const defaultWidth = strategy === 'shortTerm' ? 2.5 : 15;

// Early exit if IV rank below threshold
if (ivPercentile < ivRankMin) {
  return res.status(200).json({ error: 'LOW_IV_GATE', ivPercentile, ivRankMin, strategy });
}
```

No new imports, no new files. The strategy parameter already flows from the frontend (`url` in `handleAnalyze()` includes `&strategy=${activeStrategy}`).

---

## URL Param Schema

Signal context to carry from Signals → StrategyRecommender:

| Param | Values | Notes |
|-------|--------|-------|
| `ticker` | `SPY`, `NVDA`, etc. | Already implemented |
| `direction` | `BULL`, `BEAR` | Already implemented (maps from CALL/PUT in Signals) |
| `strategy` | `swing`, `shortTerm` | Already implemented |
| `score` | integer 0-100 | New — numeric, no encoding needed |
| `streak` | integer ≥ 1 | New — numeric |
| `signalType` | `EMA`, `MOM` | New — short string, no encoding needed |

Full URL example: `/selector?ticker=NVDA&direction=BULL&strategy=swing&score=94&streak=3&signalType=EMA`

---

## Sources

- React Router v6 `useSearchParams` docs: https://reactrouter.com/api/hooks/useSearchParams
- URL state best practices (LogRocket, 2025): https://blog.logrocket.com/url-state-usesearchparams/
- State Management in 2025 comparison: https://dev.to/hijazi313/state-management-in-2025-when-to-use-context-redux-zustand-or-jotai-2d2k
- Zustand vs Context (tkdodo, authoritative): https://tkdodo.eu/blog/zustand-and-react-context
- React Router v6 `navigate()` state limitations: https://reactrouter.com/api/hooks/useNavigate

---

## Confidence Levels

| Area | Confidence | Notes |
|------|------------|-------|
| URL params for signal context | HIGH | Existing pattern in codebase; React Router v6 docs confirm; no ambiguity |
| `strategyProfiles.ts` as single source | HIGH | File exists, fully populated, already drives StrategyRecommender |
| API `?strategy` param extension | HIGH | Frontend already sends it; API just needs to read and branch |
| IV rank filter in API layer | HIGH | `ivPercentile` already in ORATS response, already surfaced in UI |
| TP pre-fill from profile | HIGH | `profitTarget` field already in `StrategyProfile` interface |
| No new dependencies needed | HIGH | All primitives verified present in `package.json` and codebase |
