---
phase: 03-spread-builder-integration
plan: 01
subsystem: ui
tags: [react, signal-context, iv-gate, url-params, overlay, vitest]

# Dependency graph
requires:
  - phase: 02-data-contract-api-foundation
    provides: strategyProfile in API response with ivRankMin, signal params from Signals page navigate()
provides:
  - Signal context banner in StrategyRecommender (conditionally rendered from URL params)
  - IV rank gate overlay wrapping all recommendation cards
  - 21 source-inspection regression tests for SIG-02, SIG-03, IVR-01..04
affects:
  - 04-auto-fill-entry (will read same URL params context)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - URL-param signal context (survives page refresh, zero new infrastructure)
    - Render-layer-only IV gate (no scoring function changes, preserves 307 parity tests)
    - hasSignalContext flag derived at render time outside useEffect

key-files:
  created: []
  modified:
    - src/pages/StrategyRecommender.tsx
    - tests/data-contract.test.ts

key-decisions:
  - "Signal banner rendered from URL params at render time (not useEffect) — avoids stale closure issues"
  - "IV gate computes ivRankMin from result.strategyProfile?.ivRankMin with getProfile(activeStrategy) fallback — respects API-provided profile"
  - "IV gate wraps entire Target Recommendations IIFE in one relative div — single gate point, not per-card"
  - "ivGateDismissed resets on each handleAnalyze call — fresh gate for each new ticker analysis"
  - "Null ivRank triggers informational warning (not blocked), matching IVR-04 requirement"

patterns-established:
  - "Source-inspection tests use readFileSync pattern established in Phase 2 — consistent test approach"
  - "IV gate: (ivBelowThreshold || ivUnknown) && !ivGateDismissed — explicit null-vs-low handling"

requirements-completed: [SIG-02, SIG-03, IVR-01, IVR-02, IVR-03, IVR-04]

# Metrics
duration: 5min
completed: 2026-03-14
---

# Phase 3 Plan 01: Signal Banner and IV Gate Summary

**Conditional WFA signal context banner above regime card + dismissible IV rank gate overlay wrapping all recommendation cards, enforced at render layer with zero scoring function changes**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-14T16:43:52Z
- **Completed:** 2026-03-14T16:46:30Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Signal context banner renders above regime card when arriving from Signals page with any of: score, streak, signalType, adx, rvol URL params
- Banner shows "WFA Validated" badge and available signal metadata; absent when navigating to /selector directly
- IV rank gate overlays all recommendation cards with opacity-40/pointer-events-none when ivRank < strategy threshold
- IV gate dismissible via "I understand the risk — proceed" button, resets on new Analyze
- Null ivRank shows "unavailable" informational message (not blocking per IVR-04)
- ivRankMin read from result.strategyProfile?.ivRankMin with getProfile(activeStrategy) fallback
- 21 new source-inspection tests covering SIG-02, SIG-03, IVR-01..04 all pass
- Zero changes to oss-core.ts or scoring.cjs — 307 parity tests fully intact

## Task Commits

Each task was committed atomically:

1. **Task 1: Signal context banner and IV gate overlay** - `2ff52b3` (feat)
2. **Task 2: Source-inspection regression tests SIG-02, SIG-03, IVR-01..04** - `fceb7c7` (test)

## Files Created/Modified
- `src/pages/StrategyRecommender.tsx` - Added ivGateDismissed state, 6 signal searchParams reads, hasSignalContext flag, signal banner JSX, IV gate overlay wrapping Target Recommendations
- `tests/data-contract.test.ts` - Appended 21 source-inspection tests for 6 Phase 3 requirements

## Decisions Made
- Signal params read at render time (outside useEffect) — avoids stale closure issues, params are stable on mount
- IV gate wraps entire Target Recommendations IIFE as one unit rather than per-card — cleaner implementation, matches "entire section" requirement from IVR-02
- ivGateDismissed resets on every handleAnalyze click — prevents stale gate state when user switches tickers

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Signal context banner and IV gate complete — Phase 3 Plan 02 can build on this foundation
- URL params (score, streak, signalType, adx, rvol, iv30d) are all read and available for any future plan 02 features
- IVR-04 confirmed: scoring functions untouched, all 307 parity tests still pass

## Self-Check: PASSED

- src/pages/StrategyRecommender.tsx: FOUND
- tests/data-contract.test.ts: FOUND
- .planning/phases/03-spread-builder-integration/03-01-SUMMARY.md: FOUND
- feat commit 2ff52b3: FOUND
- test commit fceb7c7: FOUND

---
*Phase: 03-spread-builder-integration*
*Completed: 2026-03-14*
