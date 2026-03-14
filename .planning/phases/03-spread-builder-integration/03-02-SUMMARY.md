---
phase: 03-spread-builder-integration
plan: "02"
subsystem: ui
tags: [react, typescript, take-profit, spread-builder, wfa, exit-rules]

# Dependency graph
requires:
  - phase: 03-spread-builder-integration/03-01
    provides: IV gate overlay, signal context banner, strategyProfile on result, getProfile fallback pattern
  - phase: 02-data-contract-api-foundation/02-02
    provides: strategy-recommend.js STRATEGY_DEFAULTS with profitTarget field
provides:
  - TP auto-fill field in open-position inline form (WFA-validated default, user-editable)
  - target_price stored as fraction in DirectAddItem (EXIT-01 contract fulfilled)
  - openPosTP state with reactive effect and full reset lifecycle (EXIT-03 contract fulfilled)
  - EXIT-01 and EXIT-03 source-inspection regression tests in tests/data-contract.test.ts
affects:
  - usePositionMutations (already maps item.target_price to DB insert)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Reactive TP useEffect: recomputes from openPosPrice, fires only when price changes (not when user edits TP directly)
    - Dollar-to-fraction conversion: (parseFloat(openPosTP) / parseFloat(openPosPrice)) stored in target_price
    - Conditional form field: openPosPrice guard renders TP field, empty state shows nothing

key-files:
  created: []
  modified:
    - src/pages/StrategyRecommender.tsx
    - tests/data-contract.test.ts

key-decisions:
  - "openPosTP initialized as empty string — reactive effect sets it from fill price, user can then override freely"
  - "TP useEffect depends on [openPosPrice, activeStrategy, result] — re-fires on price change or strategy change, not on user TP edits (no stale closure)"
  - "target_price fallback is tpPct (fraction) when openPosTP is empty/zero — guarantees WFA-validated rate even if form skipped"
  - "TP field hidden until fill price entered — matches CONTEXT.md 'empty state shows nothing' requirement"

patterns-established:
  - "TP label shows live percentage (e.g., '30%') derived from openPosTP/openPosPrice while user types"
  - "Source-inspection tests for EXIT requirements use indexOf block-slicing pattern (matches existing data-contract.test.ts style)"

requirements-completed: [EXIT-01, EXIT-03]

# Metrics
duration: 8min
completed: 2026-03-14
---

# Phase 3 Plan 02: Reactive TP Auto-Fill Summary

**WFA-validated take-profit (30% swing / 40% shortTerm) pre-filled at entry time with dollar amount, percentage display, user override, and fraction storage in target_price**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-14T16:42:00Z
- **Completed:** 2026-03-14T16:50:22Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- TP field appears in open-position inline form only after fill price is entered (conditional render on `openPosPrice`)
- TP auto-fills with WFA-validated dollar amount (e.g., $2.10 for $7.00 credit at 30%)
- TP label shows live percentage derived from current TP/fill price ratio
- TP field is fully editable — user types override; effect only fires on fill price change
- `target_price` stored as fraction (e.g., 0.30) in `DirectAddItem`, not dollar amount
- `openPosTP` resets in all three paths: submit success, cancel button, new Analyze call
- 6 new source-inspection tests (EXIT-01: 3 tests, EXIT-03: 3 tests); full suite 550 tests green

## Task Commits

Each task was committed atomically:

1. **Task 1: Reactive TP state, effect, form field, and DirectAddItem wiring** - `29b7652` (feat)
2. **Task 2: Source-inspection regression tests for EXIT-01 and EXIT-03** - `f1ef7a9` (test)

## Files Created/Modified
- `src/pages/StrategyRecommender.tsx` - Added openPosTP state, reactive useEffect, TP field in inline form, target_price in DirectAddItem, all reset paths
- `tests/data-contract.test.ts` - Added EXIT-01 and EXIT-03 describe blocks (6 tests)

## Decisions Made
- TP useEffect depends only on `[openPosPrice, activeStrategy, result]` — not `openPosTP` itself — so user edits don't trigger re-computation (no input fighting)
- `target_price` fallback uses `tpPct` directly (the fraction from profitTarget) when `openPosTP` is empty or zero, ensuring WFA-validated rate is always stored even if form partially filled
- `setOpenPosTP('')` added to Cancel button onClick, submit success path, and handleAnalyze reset — three distinct reset paths ensure no stale TP leaks between sessions

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Phase 3 complete: signal context (03-01) and TP auto-fill (03-02) both implemented and tested
- `target_price` is now populated at entry time with WFA-validated fraction for all positions opened via Spread Builder
- EXIT-01 and EXIT-03 requirements fully verified by regression tests
- Phase 4 (if any) can rely on target_price being correctly stored in positions table via existing `item.target_price` mapping in `usePositionMutations`

---
*Phase: 03-spread-builder-integration*
*Completed: 2026-03-14*
