# Project Research Summary

**Project:** WFA-Driven Workflow Integration
**Domain:** Options trading journal — signal-to-execution workflow enforcement on a mature React/Supabase platform
**Researched:** 2026-03-14
**Confidence:** HIGH

## Executive Summary

This milestone closes the gap between WFA-validated trading edge and daily execution. The platform already generates EMA/MOM signals, runs a spread builder, and has a strategy profile system — but the three are not connected. A trader clicks "Build Swing Spread" on the signals page, lands in the spread builder, and must manually remember that IV rank must be 30%+, DTE should be 55d, take profit is 30%, and so on. This milestone wires those validated rules directly into the execution flow so they are enforced rather than remembered.

The recommended approach is to treat this as a pure integration task, not a feature-build. Every required primitive is already in the codebase: `strategyProfiles.ts` has the WFA-validated parameters, `AppSettingsContext` persists the active strategy, ORATS `ivPercentile` is already fetched and returned in API responses, the URL param handoff between Signals and StrategyRecommender already works for ticker/direction/strategy. The work is: extend URL params with signal context (score, streak, signalType), implement an IV rank gate in the render layer of StrategyRecommender, compute profit target from the active profile at position-open time, and surface the strategy toggle globally in AppLayout. No new dependencies, no new database tables.

The key risk is not technical complexity — it is data source inconsistencies and pre-existing config bugs creating silent behavioral errors. Specifically: `strategyProfiles.ts` has shortTerm `ivRankMin: 30` when PROJECT.md requires 40%, `AppSettings.creditSpread` is a competing source of truth for the same parameters as `strategyProfiles.ts`, and the signals page uses cached IV while the spread builder uses live IV. These must be addressed before IV filter implementation to avoid shipping a gate with the wrong threshold.

## Key Findings

### Recommended Stack

No new dependencies are needed. The existing stack — React Router v6 `useSearchParams`, `strategyProfiles.ts`, `AppSettingsContext`, and Vercel ESM API routes — provides every primitive. URL search params are the correct transport layer for ephemeral signal context between lazy-loaded pages (survives refresh, shareable URL, zero infrastructure). `location.state` was rejected because it does not survive page refresh. Zustand and nuqs were rejected as unnecessary overhead for a 5-field handoff.

**Core technologies:**
- `react-router-dom` `useSearchParams`: Signal context transport between Signals and StrategyRecommender — already partially implemented, extending is a 2-line change per end
- `src/lib/strategyProfiles.ts`: Single source of truth for all per-strategy parameters — already complete with swing and shortTerm profiles
- `AppSettingsContext`: Global `activeStrategy` state with localStorage persistence — already implemented, needs UI exposure in AppLayout
- ORATS `getCores()` `ivPercentile`: IV rank data for hard gate — already fetched and returned in API responses
- Vitest: Existing test suite at 488 tests — new features need unit tests for URL param parsing and IV gate logic

### Expected Features

**Must have (table stakes):**
- Signal source (ticker, direction, score, streak, signal type) visible in spread builder — professionals expect signal context to follow them through a workflow
- Strategy parameters (DTE, delta, width) reflected in builder defaults when strategy changes — all major platforms use order templates/presets
- IV rank displayed on candidates with gate distinction — tastytrade, thinkorswim, OptionStrat, Option Alpha all show IVR prominently
- Profit target pre-filled at position entry — E*TRADE, thinkorswim, tastytrade all provide order templates with exit plan fields
- Global strategy toggle accessible during workflow — removing navigational friction between strategy selection and execution

**Should have (differentiators):**
- Signal quality badge in spread builder showing score + direction streak — no comparable journal platform surfaces originating signal metadata in the builder
- IV rank hard gate (hidden/blocked candidates) rather than soft indicator — tastytrade shows IVR but never prevents entry; this platform uniquely enforces the discipline
- WFA-derived defaults labeled as such — differentiator is the sourcing story: 30% TP and IV 30%+ come from validated OOS Sharpe 2.14, not arbitrary templates
- Dual-strategy DTE validation in Portfolio — adjusts DTE health indicators to which strategy is active

**Defer to v2+:**
- Position card TP progress bars and monitoring alerts — entry is the highest-leverage point; monitoring UX is lower priority
- Score-based exit automation — WFA proved `se50`/`se60` go negative OOS; explicitly excluded
- Stop-loss automation — WFA proved SL 2x destroys returns (avg Sharpe 0.04); explicitly excluded
- Debit spread workflow improvements — credit spreads OOS Sharpe 2.14 vs LEAPs 0.22; debit flow improvements have negative ROI
- Third-party signal webhooks — scope creep; internal EMA/MOM signals are the validated edge

### Architecture Approach

The architecture is a unidirectional data flow from signal generation through strategy enforcement to position creation. `Signals.tsx` is the producer of signal context via URL params; `StrategyRecommender.tsx` is the consumer. `strategyProfiles.ts` is the single config authority that both the UI and API read. The IV gate lives in the render layer of StrategyRecommender (not in scoring functions), where the API response's `regime.ivRank` is compared to `profile.ivRankMin` after the API call completes. Profit target is computed as a derived value at open-time from `entry_price * (1 - profile.profitTarget)` and written to the `target_price` column in `positions`.

**Major components:**
1. `Signals.tsx` — Signal context producer; extends CTA `navigate()` URLs with `score`, `streak`, `signal` params
2. `StrategyRecommender.tsx` — Signal context consumer + IV gate + TP auto-fill; all three new behaviors land here
3. `strategyProfiles.ts` + `AppSettingsContext` — Config authority + global state; read by every strategy-aware component and API route
4. `api/strategy-recommend.js` — Returns `ivRankGate` in response payload; enforces gate consistently regardless of entry path
5. `src/lib/types.ts` + `usePositionMutations.ts` — Type contract extension (`DirectAddItem.target_price`) and DB write path for auto-filled TP
6. `AppLayout.tsx` — Shell receiving global strategy toggle, making active strategy visible on all pages

### Critical Pitfalls

1. **shortTerm ivRankMin pre-existing bug** — `strategyProfiles.ts` line 72 sets `ivRankMin: 30` for shortTerm; PROJECT.md requires 40%. Fix this before writing any IV filter logic or you ship the wrong gate threshold for every short-term trade.

2. **Scoring parity drift** — Any constant added to `oss-core.ts` must be identically added to `lib/_shared/scoring.cjs`. The 307 parity tests only cover pre-existing exports; new exports are not automatically covered. Strategy threshold constants belong in `strategyProfiles.ts` (not scoring files) so both the UI and API read from one source, eliminating the duplication risk entirely for these values.

3. **IV filter inside scoring functions breaks 307 parity tests** — The IV rank hard filter must NOT be implemented inside `calculateUnifiedScore` or any function in `scoring.cjs`. It belongs in the API route handler and UI render layer. Scoring functions score a contract; filtering which contracts to show is a separate concern.

4. **AppSettings.creditSpread namespace conflict** — `AppSettings` already has `creditSpread.minIVRank: 30`, `profitTarget: 30`, `dteLow: 45`, `dteHigh: 65`. These duplicate `strategyProfiles.ts` but are not strategy-aware. Any code reading `settings.creditSpread.*` instead of `getProfile(activeStrategy).*` will silently use swing parameters for shortTerm trades. Audit all references and replace before implementing the IV gate.

5. **URL signal context lost on re-analyze** — Signal context (score, streak, signal type) must be stored as `useRef` values in StrategyRecommender (read-only from URL), not as component state that can be cleared by form interaction. The signal context banner should re-read from URL params directly so it survives repeated "Analyze" clicks.

## Implications for Roadmap

Based on research, the natural build order follows data contract dependencies: type changes unblock everything; signal producer changes precede consumer changes; the IV gate depends on both the profile fix and the correct API response shape; the global toggle is fully independent and can go last.

### Phase 0: Prerequisite Fixes (Bug Squash)
**Rationale:** Two pre-existing bugs will corrupt every subsequent phase if not fixed first: the shortTerm `ivRankMin` mismatch and the `AppSettings.creditSpread` competing authority. These are not new features — they are corrections that must land before any feature work begins.
**Delivers:** `strategyProfiles.ts` shortTerm `ivRankMin` corrected to 40%; audit of all `settings.creditSpread.*` reads replaced with `getProfile(activeStrategy).*`; API param name standardized (`profileStrategy` → `strategy` in `scan-options.js`)
**Avoids:** Pitfall 6 (wrong IV threshold), Pitfall 5 (namespace conflict), Pitfall 12 (API param mismatch)

### Phase 1: Type + DB Write Path
**Rationale:** `DirectAddItem` needs `target_price?: number` and `useAddDirect` needs to write it before any UI can pass the value. This is the foundational data contract change that unblocks the TP auto-fill feature.
**Delivers:** `target_price` field in `DirectAddItem` interface; `useAddDirect` mutation writes `target_price` to positions table
**Uses:** `src/lib/types.ts`, `src/hooks/usePositionMutations.ts`
**Avoids:** Pitfall 4 (TP overwrite) by establishing the write path with explicit intent before adding form logic

### Phase 2: Signal Context URL Propagation
**Rationale:** Producer-side change in `Signals.tsx` — extend CTA navigate URLs with `score`, `streak`, `signal`. No dependencies on Phase 1. Can be done in parallel but logically precedes consumer testing.
**Delivers:** Full signal context in URL when navigating from Signals to StrategyRecommender; `/selector?ticker=NVDA&direction=BULL&strategy=swing&score=94&streak=3&signal=EMA` URL shape
**Implements:** URL-as-page-interface pattern; `useRef` storage in consumer for read-only signal metadata
**Avoids:** Pitfall 2 (signal context lost on re-analyze) via refs not state; Pitfall 11 (localStorage namespace) by not persisting signal context

### Phase 3: Spread Builder Integration (IV Gate + Signal Banner + TP Auto-Fill)
**Rationale:** All three consumer-side changes in `StrategyRecommender.tsx` land together because they share the same file and the same prerequisite (Phase 1 for TP write path, Phase 2 for signal params). IV gate requires API to return `ivRankGate` in response payload for consistent behavior on direct URL entry.
**Delivers:** Signal context banner (score, streak, signal type from URL params); IV rank hard gate with blocked UI and threshold explanation; profit target computed from `entry_price * (1 - profile.profitTarget)` and written via `useAddDirect`
**Uses:** `strategyProfiles.ts` (ivRankMin, profitTarget), ORATS `ivPercentile` (already in API response), `useSearchParams` (existing)
**Avoids:** Pitfall 3 (IV bypass via direct URL) by implementing gate at API response level; Pitfall 4 (TP overwrite) by deriving TP at open-time not as persistent state; Pitfall 7 (auto-analyze race) by passing strategy from URL ref directly to `handleAnalyze`; Pitfall 8 (IV source inconsistency) by displaying both cached and live IV with source labels; Pitfall 10 (parity test breakage) by keeping filter logic out of scoring functions

### Phase 4: Global Strategy Toggle + Page Consistency
**Rationale:** Fully independent of all other phases. `activeStrategy` context already works everywhere. This phase surfaces the toggle in AppLayout and adds strategy-aware subtitles/DTE validation across Scanner, Signals, and Portfolio pages.
**Delivers:** Strategy toggle in AppLayout header visible on all pages; "SWING / ST" badge always visible; page-level subtitles showing active profile parameters; Portfolio DTE validation adjusted to active strategy
**Avoids:** Pitfall 9 (strategy persistence leak) by making active strategy permanently visible

### Phase Ordering Rationale

- Phase 0 is non-negotiable first because two bugs corrupt subsequent work.
- Phase 1 before Phase 3 because `DirectAddItem.target_price` is a type dependency for TP auto-fill.
- Phase 2 can overlap with Phase 1 (no shared files) but must complete before Phase 3 testing.
- Phase 3 bundles all three StrategyRecommender changes because they are in the same file, share the same testing surface, and testing them together is more efficient than three separate PRs touching the same component.
- Phase 4 is last because it depends on all the pages it affects being verified working with strategy-aware values.

### Research Flags

Phases with well-documented patterns (skip additional research-phase):
- **Phase 0:** Direct code fixes with clear targets; no design ambiguity
- **Phase 1:** Standard TypeScript interface extension + mutation hook update; no unknowns
- **Phase 2:** Extending an existing URL param pattern; already proven in codebase
- **Phase 4:** Context-based UI wiring; AppLayout integration is straightforward

Phases that may benefit from targeted design decisions before implementation:
- **Phase 3:** Two product decisions need resolution before coding: (1) hard gate vs advisory mode UX (hide cards vs block with explanation — research recommends "block with explanation" as less confusing than hidden cards), and (2) signal context banner field selection (surfacing all of score/adx/rvol/direction/streak could clutter the builder header — recommend score + direction + streak only as minimum viable signal callout).

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All recommendations are verified existing code; no new dependencies proposed; direct inspection of package.json and source files |
| Features | HIGH | Table stakes verified against tastytrade, thinkorswim, OptionStrat, Option Alpha; anti-features confirmed by WFA data (se50/se60 negative OOS, SL 2x Sharpe 0.04) |
| Architecture | HIGH | Derived from direct source code analysis; component boundaries and data contracts are verified not inferred; existing patterns confirmed working |
| Pitfalls | HIGH | Critical pitfalls are verified bugs (shortTerm ivRankMin, creditSpread namespace) or structural constraints (307 parity tests); race conditions identified from React 18 batching behavior |

**Overall confidence:** HIGH

### Gaps to Address

- **Hard gate vs advisory mode UX:** The choice between hiding sub-IV-threshold candidates vs blocking with an explanation panel is a product decision with identical implementation complexity. Research recommends "block with explanation" (shows IV rank value, threshold, and strategy) over hidden cards. Resolve before Phase 3.
- **Signal context callout card fields:** Surfacing score + direction + streak is the recommended minimum; adxValue and rvol are available but add visual weight. Decide field selection before Phase 3 implementation.
- **shortTerm IV threshold validation:** `strategyProfiles.ts` currently has 30% for shortTerm despite PROJECT.md requiring 40%. Phase 0 must fix this, but if WFA data for shortTerm (OOS Sharpe 4.77 at IV ≥ 40%) is to be verified independently before changing the hard gate value, that verification should happen before Phase 0 commits.

## Sources

### Primary (HIGH confidence)
- `src/lib/strategyProfiles.ts` — Strategy profile interface and STRATEGY_PROFILES constants (direct inspection)
- `src/context/AppSettingsContext.tsx` — activeStrategy state, localStorage persistence, creditSpread conflict identification
- `src/pages/Signals.tsx` — CTA navigate() calls, signal data structure, URL param construction
- `src/pages/StrategyRecommender.tsx` — useSearchParams usage, handleAnalyze, openPosPrice form, auto-analyze pattern
- `src/hooks/usePositionMutations.ts` — useAddDirect mutation, DirectAddItem usage, positions DB write
- `src/lib/types.ts` — Position, DirectAddItem, WatchlistItem interfaces (target_price column confirmed)
- `api/strategy-recommend.js` — strategy param consumption, StrategyResult shape, ivRank in response
- `api/scan-options.js` — profileStrategy param naming inconsistency identified
- `tests/scoring-parity.test.ts` — parity test structure and coverage gaps
- `data/wfa-results.json`, `data/wfa-results-short.json` — OOS validation basis for IV thresholds and exit parameters

### Secondary (MEDIUM confidence)
- tastytrade, thinkorswim, OptionStrat, Option Alpha — IVR display patterns and order template patterns (verified via product documentation)
- React Router v6 useSearchParams docs — URL state persistence behavior
- tkdodo.eu — Zustand vs Context analysis (authoritative React ecosystem source)

### Tertiary (LOW confidence)
- shortTerm IV 40% threshold OOS Sharpe validation — cited as 4.77 in PROJECT.md; independent verification against wfa-results-short.json recommended before hardening as a gate value

---
*Research completed: 2026-03-14*
*Ready for roadmap: yes*
