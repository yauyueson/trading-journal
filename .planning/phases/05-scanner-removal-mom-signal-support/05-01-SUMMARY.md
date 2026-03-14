---
phase: 05-scanner-removal-mom-signal-support
plan: 01
subsystem: ui
tags: [react, react-router, navigation, signals, scanner]

# Dependency graph
requires:
  - phase: 04-global-strategy-toggle
    provides: AppLayout strategy toggle and Signals.tsx CTA URL infrastructure
provides:
  - Scanner page removed — /scanner redirects to /portfolio
  - TabNav without scanner tab
  - Dynamic signal type derivation (EMA vs MOM) in Signals CTA URLs
affects: [signals, strategy-recommender, navigation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "deriveSignalType: dominant-deviation-from-neutral pattern for EMA/MOM classification"
    - "Navigate redirect for removed routes preserves old bookmarks"

key-files:
  created: []
  modified:
    - src/router.tsx
    - src/components/TabNav.tsx
    - src/pages/Signals.tsx
    - src/lib/types.ts
    - tests/prerequisite-fixes.test.ts
  deleted:
    - src/pages/Scanner.tsx

key-decisions:
  - "Scanner.tsx deleted entirely — /scanner route replaced with Navigate redirect to /portfolio so old bookmarks gracefully redirect"
  - "PRE-02 Scanner.tsx source-reading test removed; scan-options.js param test retained (scan-options.js still used by Portfolio.tsx)"
  - "deriveSignalType uses deviation-from-neutral (50) to pick EMA vs MOM — momDev > emaDev selects MOM, EMA wins ties per WFA primary signal finding"
  - "ScannerApiContext interface removed from types.ts — only imported by deleted Scanner.tsx"

patterns-established:
  - "Signal type derivation: compare Math.abs(score - 50) per component; largest deviation wins; EMA wins ties"

requirements-completed: [SCAN-01, MOM-01]

# Metrics
duration: 2min
completed: 2026-03-14
---

# Phase 5 Plan 01: Scanner Removal and MOM Signal Support Summary

**Scanner tab and page removed (redirects to /portfolio); Signals CTA URLs now derive EMA vs MOM signal type from sc_ema/sc_mom component deviation scores**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-03-14T17:38:44Z
- **Completed:** 2026-03-14T17:40:35Z
- **Tasks:** 2
- **Files modified:** 5 (+ 1 deleted)

## Accomplishments

- Removed Scanner page, route entry, and tab — old `/scanner` bookmarks redirect to `/portfolio` via Navigate
- Deleted Scanner.tsx and removed ScannerApiContext from types.ts (Scanner-exclusive type)
- Added `deriveSignalType()` helper in Signals.tsx that picks EMA or MOM based on which sub-score deviates further from neutral (50); EMA wins ties
- Updated `buildParams` in Signals CTA to call `deriveSignalType(row.components)` instead of hardcoded `'EMA'`
- Updated page subtitle to reflect "EMA + MOM signals" support

## Task Commits

Each task was committed atomically:

1. **Task 1: Remove Scanner page, route, and tab (SCAN-01)** - `6c7de3c` (feat)
2. **Task 2: Derive signal type from components data (MOM-01)** - `2472815` (feat)

**Plan metadata:** (pending final docs commit)

## Files Created/Modified

- `src/router.tsx` - Removed scanner from TAB_PATHS; replaced scanner lazy-route with Navigate redirect to /portfolio
- `src/components/TabNav.tsx` - Removed scanner tab entry and Search lucide import
- `src/pages/Scanner.tsx` - Deleted entirely
- `src/lib/types.ts` - Removed ScannerApiContext interface (Scanner-exclusive, no other consumers)
- `src/pages/Signals.tsx` - Added deriveSignalType() helper; updated buildParams to use it; updated subtitle
- `tests/prerequisite-fixes.test.ts` - Removed Scanner.tsx source-reading test; retained scan-options.js param test

## Decisions Made

- Scanner.tsx deleted (not archived) — the redirect route handles old bookmarks; no value in keeping the file
- PRE-02 test updated (not deleted) — removed Scanner.tsx assertion, kept scan-options.js assertion which is still the active API contract check
- `deriveSignalType` ties default to EMA — consistent with WFA finding that EMA is the primary validated signal (IS→OOS improvement)
- No changes to StrategyRecommender.tsx — it already reads `signalType` from URL params dynamically

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Navigation is cleaned up — 7 tabs instead of 8
- Signal type (EMA/MOM) now correctly attributed in StrategyRecommender banner when clicking CTA from Signals dashboard
- api/scan-options.js preserved — still referenced by Portfolio.tsx line 118 and data-contract tests
- All 562 tests pass; TypeScript compiles cleanly; production build succeeds

---
*Phase: 05-scanner-removal-mom-signal-support*
*Completed: 2026-03-14*
