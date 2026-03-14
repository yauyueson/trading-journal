# Domain Pitfalls

**Domain:** WFA-Driven Workflow Integration — Signal context propagation, IV filtering, exit automation on an existing options trading platform
**Project:** Trading Journal — WFA-Driven Workflow Integration milestone
**Researched:** 2026-03-14

---

## Critical Pitfalls

Mistakes that cause rewrites, broken parity tests, or silent behavioral divergence.

---

### Pitfall 1: Scoring Parity Drift — Changing Logic in One File Only

**What goes wrong:**
Any function touched in `src/lib/oss-core.ts` must be identically updated in `lib/_shared/scoring.cjs`. The 307 parity tests in `tests/scoring-parity.test.ts` catch function-level divergence but they only test what is explicitly tested — if a new constant (e.g. a per-strategy IV rank threshold) is added to oss-core.ts but not to scoring.cjs, the API silently uses a stale value while the frontend uses the new one.

**Why it happens:**
The two files are manually maintained mirrors. There is no code-generation step. Developer focus is on the TypeScript file; the CJS mirror is an afterthought. The parity tests also only cover exported functions that were known at test-write time — new exports added mid-milestone are not automatically included.

**Consequences:**
- Strategy-specific IV rank minimums (swing: 30%, shortTerm: 40%) differ between API and frontend
- Profit target auto-fill on the UI reads from `oss-core.ts`/`strategyProfiles.ts`; the API reads from `scoring.cjs`. If they diverge the position is opened with a different TP than the UI displays
- Silently wrong scoring for 100% of trades opened in a given session, with no runtime error

**Prevention:**
- Any scoring constant that varies by strategy MUST be added to both files in the same commit
- After adding a new export to oss-core.ts, immediately add a parity test for it before writing the implementation
- Strategy threshold constants (ivRankMin, profitTarget) belong in `strategyProfiles.ts`, not in scoring files, so there is a single source that both the UI and API can read at build time via import — this avoids the duplication problem entirely for these values

**Detection warning signs:**
- PR touches oss-core.ts but not scoring.cjs (or vice versa)
- New constant defined inside an if-block that parity tests don't cover
- API returns different IV rank gate than what the signals page displays

**Phase:** Applies to every phase that modifies scoring logic or adds strategy-specific constants

---

### Pitfall 2: URL Parameter Signal Context Lost on Re-Analyze

**What goes wrong:**
`StrategyRecommender.tsx` seeds ticker/direction/strategy from URL params on mount (lines 79–90) and runs `handleAnalyze()` once via `didAutoAnalyze.current` guard. Signal context (score, streak, signal type) passes through URL params from `Signals.tsx`. If the user clicks "Analyze" a second time — which happens routinely when they change DTE or spread width — the signal context is gone: `searchParams` still has the original values, but the component has no memory of the original signal metadata beyond what the URL carries.

**Why it happens:**
URL params carry `ticker`, `direction`, `strategy` — the three fields `Signals.tsx` populates (line 706–713). `score`, `streak`, `firstFired`, and `signal` type are NOT in the URL. They were never added because the signals page only recently added CTAs. The spreader has no awareness of which signal triggered it.

**Consequences:**
- Signal context banner (the "this was triggered by EMA score 94 on AAPL, streak 3d" display) becomes blank after the first re-analyze
- The IV rank gate in the UI cannot show "this ticker fails the gate for the active strategy" because the strategy context is in the URL but the IV value isn't
- If signal context is stored in React state (not URL), a page refresh loses it entirely

**Prevention:**
- Extend the navigation URL from `Signals.tsx` to include `score`, `streak`, `signal` as query params when building the `/selector` URL: `/selector?ticker=AAPL&direction=BULL&strategy=swing&score=94&streak=3&signal=ema`
- In `StrategyRecommender.tsx`, read these additional params into `useRef` values (not useState — they are read-only context, not mutable form state)
- Signal context should be displayed in a locked banner section, not as editable form fields — this eliminates the "lost on re-analyze" problem because the banner re-reads from the URL params directly

**Detection warning signs:**
- Signal info panel shows correct data on first load, blank after any form interaction
- URL for `/selector` navigation only has 3 params (`ticker`, `direction`, `strategy`)

**Phase:** Phase that adds signal context display (likely Phase 1)

---

### Pitfall 3: IV Rank Filter Bypassed Via Direct URL Entry

**What goes wrong:**
The IV rank hard filter is planned as a UI-level gate in the spread builder — candidates below the strategy threshold are hidden or shown with a blocking overlay. A user who navigates directly to `/selector?ticker=LOW_IV_TICKER&direction=BULL&strategy=swing` bypasses the signals page entirely and lands in the spread builder without any gate applied. The API (`strategy-recommend.js`) does not enforce IV rank as a hard filter — it uses `ivRank` as a scoring adjustment (soft penalty) not a blocker.

**Why it happens:**
`scan-options.js` reads `profileStrategy` (line 47) but only uses it for DTE range defaults. `strategy-recommend.js` uses `ivRank` in `getIVRankAdjustment()` as a scoring weight, not a filter. The IV gate only exists on the signals page dashboard as a `LOW_IV` status badge. There is no server-side enforcement.

**Consequences:**
- User bookmarks a ticker URL and re-uses it days later when IV has dropped below threshold — the spread builder shows results without any warning
- Positions opened via direct URL have no IV enforcement, undermining the "IV >= 30% is +58% Sharpe" rule
- Auto-analyze on mount (the `didAutoAnalyze` path) fires immediately before any IV check is displayed

**Prevention:**
- The API should return `ivRankGate: { pass: boolean, threshold: number, actual: number }` in the response payload so the frontend can show a consistent gate UI regardless of how the page was reached
- The spread builder's result display should check `ivRankGate.pass` before showing spread cards — failed gate = blocked UI with explanation, not hidden cards (hidden is confusing; blocked with "IV rank 24% is below 30% threshold for Swing strategy" is actionable)
- This must be implemented at the API response level, not only as frontend state, so any entry point is covered

**Detection warning signs:**
- IV rank check is only performed in `Signals.tsx` computeStatus() and nowhere else in the call chain
- Spread builder shows recommendations for a ticker the user knows has low IV

**Phase:** IV rank filter phase

---

### Pitfall 4: profitTarget Auto-Fill Overwrites a User-Edited Value

**What goes wrong:**
The spread builder has a `useEffect` that resets DTE and spread width when `activeStrategy` changes (lines 109–114 of `StrategyRecommender.tsx`). A similar effect for auto-filling `profitTarget` on position open (the planned feature) risks overwriting a value the user intentionally changed. The existing pattern uses `localStorage` to persist `direction`, `targetDte`, and `spreadWidth` across sessions — adding `profitTarget` to this persistence without care means a user's manual override survives navigation, but the auto-fill fires on every new recommendation and clobbers it.

**Why it happens:**
Auto-fill is straightforward when there is only one trigger (strategy change). With two triggers (strategy change AND new recommendation result), the interaction order matters: the recommendation comes back, auto-fill fires, then if the user edits the field, a subsequent strategy switch fires the reset again.

**Consequences:**
- User adjusts TP from 30% to 25% for a specific trade; strategy toggle resets it to 30%; position is opened at wrong target
- Alternatively: auto-fill never fires when it should because a stale `localStorage` value takes precedence

**Prevention:**
- Store `profitTarget` as derived state: `const profitTarget = profile.profitTarget` unless the user has explicitly overridden it in the current session (use a `userOverriddenTP` boolean flag in component state, reset to false on strategy change and on new recommendation result)
- The auto-fill should only write to the position-open form fields at the moment of "Open Position" click, not as persistent component state — this is the "simplest intervention at highest-leverage point (entry)" decision already in PROJECT.md
- Do not add `profitTarget` to the `LS_KEY` localStorage object; it should always be derived from the active strategy profile at time of opening

**Detection warning signs:**
- `profitTarget` appears in the `LS_KEY` localStorage save effect
- A `useEffect` depends on both `activeStrategy` and `result` and writes to `profitTarget` state

**Phase:** Exit auto-fill phase

---

### Pitfall 5: AppSettings creditSpread Namespace Conflicts with strategyProfiles

**What goes wrong:**
`AppSettings` already has a `creditSpread` namespace (`src/lib/types/settings.ts` lines 43–50) with `minIVRank: 30`, `profitTarget: 30`, `dteLow: 45`, `dteHigh: 65`, `spreadWidth: 15`. The new `strategyProfiles.ts` defines the same parameters per-strategy. There are now two authoritative sources for the same values. `AppSettingsContext` loads from Supabase and localStorage, overwriting with user-persisted values; `strategyProfiles.ts` has hardcoded WFA-validated values. If both sources exist, code that reads `settings.creditSpread.minIVRank` instead of `getProfile(activeStrategy).ivRankMin` will use the old non-strategy-aware value.

**Why it happens:**
`creditSpread` was added in a previous phase as a single-strategy settings object before the swing/shortTerm split. `strategyProfiles.ts` was created after, with per-strategy params. Neither was fully deprecated in favor of the other. `DEFAULT_APP_SETTINGS.creditSpread.minIVRank = 30` matches swing but not shortTerm (40%).

**Consequences:**
- Short-term strategy positions are opened with IV gate 30% instead of 40%
- Any component that reads `settings.creditSpread` instead of `getProfile(activeStrategy)` is implicitly using swing-only parameters for both strategies
- Supabase-persisted `creditSpread` settings from before the strategy split override WFA-validated profile values

**Prevention:**
- Audit every reference to `settings.creditSpread.*` and decide: does this need to be strategy-aware? If yes, replace with `getProfile(activeStrategy).*`. If no, keep it
- Treat `strategyProfiles.ts` as the authoritative source for all per-strategy parameters (DTE, delta, width, TP, IV rank) — `AppSettings.creditSpread` should either be deprecated or reduced to only portfolio-level overrides the user explicitly set
- Document this decision in a comment in `AppSettingsContext.tsx` so future developers don't recreate the ambiguity

**Detection warning signs:**
- Code reads `settings.creditSpread.minIVRank` in any file that also reads `activeStrategy`
- Short-term IV filter behaves identically to swing IV filter (both at 30%)
- `getProfile(activeStrategy).ivRankMin` is 30 for swing and 40 for shortTerm, but `shortTerm.ivRankMin` in `strategyProfiles.ts` is currently set to 30 (line 72) — this is itself a discrepancy vs PROJECT.md which states shortTerm IV min is 40%

**Phase:** Strategy profile and IV filter phases

---

### Pitfall 6: shortTerm ivRankMin Mismatch Between strategyProfiles.ts and PROJECT.md

**What goes wrong:**
`strategyProfiles.ts` line 72 sets `ivRankMin: 30` for the shortTerm profile. `PROJECT.md` specifies shortTerm IV Rank Min as 40%. This is a pre-existing discrepancy in the codebase today. Any phase that builds the IV filter using the profile value will implement the wrong threshold for short-term trades.

**Why it happens:**
`strategyProfiles.ts` was likely created using the swing profile as a template and the shortTerm-specific IV minimum was not updated.

**Consequences:**
- Short-term trades with IV rank 30-39% are allowed through when they should be gated
- WFA benefit (+58% Sharpe from IV >= 40% for short-term) is not captured
- The IV gate UI shows the wrong threshold to the user

**Prevention:**
- Fix `ivRankMin: 30` to `ivRankMin: 40` in the shortTerm profile in `strategyProfiles.ts` as a prerequisite step before any IV filter phase work
- Verify the fix against the WFA results in `data/wfa-results-short.json` — shortTerm OOS Sharpe 4.77 was achieved with IV >= 40% filter

**Detection warning signs:**
- `strategyProfiles.ts` shortTerm.ivRankMin !== 40
- IV filter phase accepts IV 35% for a shortTerm strategy position without warning

**Phase:** Must fix before Phase 1 begins

---

## Moderate Pitfalls

---

### Pitfall 7: Auto-Analyze Race Condition on URL-Seeded State

**What goes wrong:**
`StrategyRecommender.tsx` has a two-step mount sequence: first `useEffect` seeds state from URL params, second `useEffect` watches `ticker` state and fires `handleAnalyze()` when it matches the URL value (lines 93–102). This pattern works when `setTicker` triggers a re-render before the second effect runs. But `setActiveStrategy` in `AppSettingsContext` writes to localStorage synchronously and updates context state — if the context update resolves after the `ticker` effect fires, the analyze call uses the previous strategy's defaults (DTE, width) even though `activeStrategy` was set to the URL value.

**Why it happens:**
React batches state updates within effects in React 18 (automatic batching), but context updates from a separate provider are not batched with local state updates from the same effect. The `urlStrategy` effect calls `setActiveStrategy` (context) and `setTicker` (local state) in the same effect, creating a potential render-order dependency.

**Consequences:**
- Spread builder analyzes SPY for swing strategy even when URL says `strategy=shortTerm`
- Results show swing DTE (55d) when shortTerm (10d) was requested
- Only reproducible on first load from the signals page CTA — hard to notice

**Prevention:**
- The `handleAnalyze` call should explicitly pass the strategy from the URL ref, not read from context state: `handleAnalyze({ strategyOverride: urlStrategy })`
- Alternatively, delay `handleAnalyze` until after a `useLayoutEffect` that confirms context has settled — but this is more fragile
- The cleanest fix: derive all strategy-dependent params from URL params directly within `handleAnalyze` when URL params are present, bypassing context for the auto-analyze call

**Detection warning signs:**
- Opening `/selector?ticker=SPY&direction=BULL&strategy=shortTerm` shows DTE options for swing profile on initial load
- `activeStrategy` in DevTools context shows 'shortTerm' but the API call has `strategy=swing`

**Phase:** Signal context propagation phase

---

### Pitfall 8: IV Source Inconsistency Between Signals Page and Spread Builder

**What goes wrong:**
The signals page uses `ivMap` from `useWatchlistIV()` which returns `iv30` from `orats_iv_cache` (the `smvVol` field via the cron). The spread builder's API (`strategy-recommend.js`) recomputes IV from the live ORATS chain at request time, using `getCleanATM_IV()`. These two values can differ significantly — the cron value is from last night's snapshot; the live value is current. A ticker can show IV 32% on the signals dashboard (triggering GO status) but return IV 28% in the spread builder (below the 30% gate), or vice versa.

**Why it happens:**
The signals page fetches cached IV (low latency, batch); the spread builder fetches live IV (accurate, per-ticker). Neither is wrong — they serve different purposes. But the user sees "GO" on signals, clicks through, and the spread builder gates them out. This creates a confusing UX: "why is it blocked here when it was green there?"

**Consequences:**
- User confusion when signals page says GO but spread builder's IV gate blocks
- Worse: if spread builder uses a softer IV check (just a scoring adjustment, not a hard gate) while signals page uses a hard gate, inconsistency in both directions is possible

**Prevention:**
- The IV rank gate in the spread builder should use the same source as the signal — display the cached IV prominently alongside the live IV with a note "Signal IV: 32% (cached 21:00 UTC) | Live IV: 28%"
- Accept the discrepancy as intended behavior and explain it to the user rather than trying to unify the data sources
- The gate decision should use live IV (from the API call) since that is what will be filled at execution, but display both values

**Detection warning signs:**
- IV rank shown on signals page differs from IV rank shown in spread builder for the same ticker
- User reports "I clicked Build Spread on a GO signal and it was blocked"

**Phase:** IV rank filter phase

---

### Pitfall 9: Strategy Toggle Persistence Leaks Across Sessions

**What goes wrong:**
`activeStrategy` is persisted to localStorage under `STRATEGY_STORAGE_KEY`. This means a user who was testing shortTerm spreads yesterday will load the app today with shortTerm as the active strategy, even if they typically use swing. The signals page GO count and the spread builder defaults will be shortTerm-oriented without any explicit action. For a multi-user household (the codebase has `owner: 'Yuchen' | 'Annie'`), both users share the same localStorage.

**Why it happens:**
Persistence was chosen for convenience — the user should not have to re-select their strategy on every page load. But without any indication of which strategy is active, it is easy to open trades with the wrong DTE/width without noticing.

**Consequences:**
- Swing trade opened with shortTerm DTE (10d) because strategy was last set to shortTerm
- No visual indicator of active strategy in the header or on the signals page
- Annie opens a position with Yuchen's last-used strategy setting

**Prevention:**
- The active strategy should be visibly surfaced in the app shell (AppLayout header or TabNav) — a small badge "SWING" or "ST" that is always visible
- Consider making the strategy toggle part of the signal context URL params so switching from signals to spread builder always sets the correct strategy for that navigation, regardless of what was persisted
- This is already partially addressed: the CTA buttons (`Build Swing Spread`, `Build Short-Term Spread`) pass `strategy=` in the URL, which `setActiveStrategy` picks up on mount — but only if the user uses those CTAs, not if they navigate directly

**Detection warning signs:**
- No strategy indicator visible in the app header
- Opening positions by navigating directly to `/selector` always uses the last-persisted strategy

**Phase:** Strategy toggle / global settings phase

---

### Pitfall 10: Test Suite Fragility from IV Filter Side Effects

**What goes wrong:**
The 307 parity tests in `scoring-parity.test.ts` test scoring functions in isolation. If the IV rank hard filter is implemented as a modification to `calculateUnifiedScore` or any function inside `scoring.cjs` (e.g. returning score 0 when IV rank is below threshold), the existing parity tests will fail because they do not pass `ivRank` in their test inputs — those inputs were written before strategy-aware filtering existed.

**Why it happens:**
Parity tests use a fixed set of inputs crafted to test scoring math. Adding a conditional early return or score override based on `ivRank` changes the behavior for inputs that have no `ivRank` field — which is every existing test input.

**Consequences:**
- All 307 parity tests fail immediately
- CI blocks merge
- Developer reverts IV filter or hacks around it by making `ivRank` optional with a no-filter default, which silently breaks the filter for API calls that don't pass the param

**Prevention:**
- The IV rank hard filter must NOT be implemented inside scoring functions — it belongs in the API route handler (`strategy-recommend.js`) and in the UI layer (`StrategyRecommender.tsx`), as a pre-filter or post-filter on results
- Scoring functions score a given contract; filtering which contracts to show is a separate concern
- The test for IV filter behavior should be a new test file (`tests/iv-filter.test.ts`) that tests the filter logic independently, not mixed with parity tests

**Detection warning signs:**
- IV rank check implemented inside `calculateUnifiedScore`, `calculateSpreadScore`, or any function in `scoring.cjs`
- Running `vitest` after IV filter implementation shows parity test failures

**Phase:** IV rank filter phase

---

## Minor Pitfalls

---

### Pitfall 11: localStorage State Key Namespace Collision

**What goes wrong:**
`StrategyRecommender.tsx` persists form state under `optionSelector:state`. If a new field (e.g. `signalScore`, `signalStreak`) is added to the persisted object without updating the `loadPersistedState()` return type or adding a migration, existing users will load a stale object that is missing the new fields — the `|| defaultValue` fallback prevents crashes but means the first load after a deploy always uses default values, which can briefly show the wrong TP or DTE.

**Prevention:**
- Persist only ephemeral UI state (direction, targetDte, spreadWidth) under `LS_KEY` — never signal context, which is always fresh from URL params
- Add a version key to the persisted object; when the version doesn't match, clear and reset

**Phase:** Signal context phase

---

### Pitfall 12: API Parameter Name Mismatch (strategy vs profileStrategy)

**What goes wrong:**
`scan-options.js` reads `req.query.profileStrategy` (line 47) while `strategy-recommend.js` reads `req.query.strategy`. The frontend `StrategyRecommender.tsx` calls `strategy-recommend` with `&strategy=` (line 127). If the scan endpoint is updated to accept signal context or strategy-specific IV filtering, a developer may pass `strategy=` instead of `profileStrategy=`, causing the DTE defaults to fall back to swing for all shortTerm scans.

**Prevention:**
- Standardize on `strategy` as the parameter name across all API routes — update `scan-options.js` to accept `strategy` as the primary name (keeping `profileStrategy` as a fallback alias for backward compatibility during transition)

**Phase:** API strategy param phase

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Fix shortTerm ivRankMin | Pitfall 6 — existing bug | Fix strategyProfiles.ts before writing any IV filter logic |
| Signal context URL propagation | Pitfall 2, 7 | Extend URL params; use refs not state for signal metadata |
| IV rank hard filter (UI) | Pitfall 3, 8, 10 | Filter in UI/API handler, not scoring functions; show both cached and live IV |
| IV rank hard filter (API) | Pitfall 3, 10 | Return gate result in API response; never add gate logic inside scoring.cjs |
| Exit auto-fill (profitTarget) | Pitfall 4, 5 | Derive from profile at open-time; don't persist; fix creditSpread namespace conflict |
| Strategy profile unification | Pitfall 5 | Audit all settings.creditSpread.* reads; replace with getProfile(activeStrategy).* |
| Global strategy toggle | Pitfall 9 | Add visible strategy badge to app shell |
| Any scoring change | Pitfall 1 | Update both oss-core.ts and scoring.cjs; add parity test for new exports |

---

## Sources

- Direct inspection of `src/lib/strategyProfiles.ts`, `src/context/AppSettingsContext.tsx`, `src/lib/types/settings.ts`, `src/pages/Signals.tsx`, `src/pages/StrategyRecommender.tsx`, `api/strategy-recommend.js`, `api/scan-options.js`
- `tests/scoring-parity.test.ts` — parity test structure and coverage gaps
- `.planning/PROJECT.md` — milestone requirements and WFA-validated parameters
- `CLAUDE.md` — parity constraint documentation and 488-test requirement
