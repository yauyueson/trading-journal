---
phase: 02-data-contract-api-foundation
plan: 01
subsystem: api
tags: [typescript, react, supabase, react-router, mutations, url-params]

# Dependency graph
requires:
  - phase: 01-prerequisite-fixes
    provides: strategy profiles, settings cleanup, API param rename

provides:
  - target_price field on DirectAddItem type contract
  - target_price and spread_width written to positions table via useAddDirect mutation
  - Signals page CTAs encode score, streak, signalType, adx, rvol, iv30d as URL params in navigate()

affects:
  - 03-selector-ui-ux (consumes target_price write path and signal metadata URL params)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - URLSearchParams object spread + conditional p.set() for optional params
    - IIFE pattern inside JSX for co-located helper functions (buildParams)
    - Source-inspection tests (readFileSync) for static contract regression

key-files:
  created:
    - tests/data-contract.test.ts
  modified:
    - src/lib/types.ts
    - src/hooks/usePositionMutations.ts
    - src/pages/Signals.tsx

key-decisions:
  - "Tests assert static source patterns (readFileSync) not runtime behavior, matching prerequisite-fixes.test.ts convention"
  - "buildParams implemented as IIFE inside JSX return — avoids lifting function outside component, keeps it co-located with the buttons"
  - "adx and rvol passed as formatted strings (toFixed(1), toFixed(2)) to avoid floating-point noise in URL params"
  - "signalType hardcoded to 'EMA' — only EMA signal is currently active per backtest findings"

patterns-established:
  - "Source-inspection pattern: readFileSync + toContain/toMatch for contract regression tests"
  - "URLSearchParams + conditional p.set() for optional signal metadata in navigate() calls"

requirements-completed: [EXIT-02, SIG-01]

# Metrics
duration: 2min
completed: 2026-03-14
---

# Phase 2 Plan 1: Data Contract and API Foundation Summary

**DirectAddItem extended with target_price, useAddDirect mutation writes target_price and spread_width, and Signals CTAs pass full signal metadata (score, streak, signalType, adx, rvol, iv30d) as URL params via buildParams() helper**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-14T15:56:41Z
- **Completed:** 2026-03-14T15:59:00Z
- **Tasks:** 1
- **Files modified:** 4 (3 src + 1 test)

## Accomplishments

- Added `target_price?: number` to `DirectAddItem` interface — establishes the type contract Phase 3 relies on for TP auto-fill
- Added `target_price: item.target_price ?? null` and `spread_width: item.spread_width ?? null` to `useAddDirect` insert — previously spread_width was missing from the DB write path
- Replaced hardcoded navigate() template literals in Signals.tsx with a `buildParams()` helper that encodes score, streak, signalType, adx, rvol, and conditionally iv30d — provides full signal context to the selector
- Added 14 regression tests in `tests/data-contract.test.ts` covering all EXIT-02 and SIG-01 requirements via source inspection

## Task Commits

Each task was committed atomically:

1. **Task 1: Add target_price to type contract and mutation, extend signal navigate() with metadata** - `d7e2a83` (feat)

**Plan metadata:** (docs commit to follow)

## Files Created/Modified

- `tests/data-contract.test.ts` - 14 regression tests for EXIT-02 and SIG-01 via readFileSync source inspection
- `src/lib/types.ts` - Added `target_price?: number` to DirectAddItem interface (line ~151)
- `src/hooks/usePositionMutations.ts` - Added `target_price` and `spread_width` to useAddDirect insert object
- `src/pages/Signals.tsx` - Replaced two hardcoded navigate() calls with buildParams() helper encoding full signal metadata

## Decisions Made

- Tests use source inspection (readFileSync + toContain) not runtime assertions — matches the pattern established in prerequisite-fixes.test.ts for contract-level regression coverage
- `buildParams` implemented as an IIFE inside JSX to keep the helper co-located with its usage without creating a module-level function
- `signalType` hardcoded to `'EMA'` since the backtest findings confirm EMA is the only signal producing IS→OOS improvement
- adx and rvol formatted with `toFixed(1)` / `toFixed(2)` to avoid floating-point representation noise in URL params

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Test assertions for `'adx'` and `'rvol'` initially used single-quoted string literals, but `URLSearchParams` object notation uses unquoted keys in source. Updated tests to use `.toMatch(/adx\s*:/)` regex to match actual source pattern. No code change needed — only the test assertions were adjusted to reflect the correct source pattern.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 3 (Selector UI/UX) can now consume `target_price` from URL params and write it via useAddDirect
- Signal context banner can read score, streak, signalType, adx, rvol, iv30d from URL search params using useSearchParams()
- All 510 tests pass (488 original + 8 prerequisite + 14 new data-contract)

---
*Phase: 02-data-contract-api-foundation*
*Completed: 2026-03-14*
