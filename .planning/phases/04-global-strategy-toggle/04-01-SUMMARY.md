---
phase: 04-global-strategy-toggle
plan: "01"
subsystem: frontend-strategy-context
tags: [strategy-toggle, backtest, stats, context, dte-buckets]
dependency_graph:
  requires: [AppSettingsContext, strategyProfiles.ts, AppLayout (STRAT-03)]
  provides: [STRAT-04 compliant Backtest.tsx, STRAT-04 compliant Stats.tsx]
  affects: [src/pages/Backtest.tsx, src/pages/Stats.tsx, tests/data-contract.test.ts]
tech_stack:
  added: []
  patterns: [context-driven isShort derivation, profile-driven label strings, strategy-conditional DTE buckets]
key_files:
  created: []
  modified:
    - src/pages/Backtest.tsx
    - src/pages/Stats.tsx
    - tests/data-contract.test.ts
decisions:
  - "Remove inline Backtest.tsx strategy toggle — AppLayout global header toggle is the single control point"
  - "Backtest.tsx subtitle/footnote reads from profile.subtitle instead of hardcoded strings"
  - "Stats.tsx shortTerm DTE buckets: <5d / 5-10d / 10-14d / 14+d (locked per CONTEXT.md)"
  - "Tab reset on isShort change moved to useEffect (reactive to global context)"
metrics:
  duration_minutes: 2
  completed_date: "2026-03-14"
  tasks_completed: 2
  files_modified: 3
---

# Phase 4 Plan 01: Global Strategy Toggle — Strategy-Aware Pages Summary

**One-liner:** Replaced Backtest.tsx local strategy state and Stats.tsx fixed DTE buckets with context-driven `activeStrategy` from `useAppSettings()`, making the global header toggle the single control point for all strategy-specific behavior.

## Objective

STRAT-04: Wire the last two hardcoded strategy references in the codebase to the global `activeStrategy` context. After this plan, every page derives strategy-specific behavior from `getProfile()`.

## What Was Built

### Backtest.tsx (STRAT-04)

- Removed `StrategyMode` type and `useState<StrategyMode>('swing')` local state
- Added `useAppSettings` and `getProfile` imports
- Derived `isShort` from `activeStrategy === 'shortTerm'` (global context, not local)
- Removed inline Swing/Short-Term toggle buttons (AppLayout header is the single control point)
- Replaced hardcoded subtitle strings (`'DTE 45-65 ...'` / `'DTE 7-14 ...'`) with `profile.subtitle`
- Replaced hardcoded footnote string with `profile.subtitle` expression
- Added `useEffect` to reset tab when `isShort` changes (preserves UX: short mode hides Signals/Configs tabs)
- Removed unused `Zap` lucide import

### Stats.tsx (STRAT-04)

- Added `useAppSettings` import and `activeStrategy` destructure inside component
- Replaced fixed DTE bucket assignment with strategy-conditional logic:
  - `swing`: `<30d / 30-45d / 45-65d / 65+d`
  - `shortTerm`: `<5d / 5-10d / 10-14d / 14+d`
- Replaced fixed DTE sort order with strategy-conditional array
- Added `activeStrategy` to the `stats` `useMemo` dependency array

### Contract Tests (tests/data-contract.test.ts)

Added 13 new source-inspection tests across three describe blocks:
- `STRAT-03 — AppLayout global strategy toggle (regression guard)`: 2 tests
- `STRAT-04 — Backtest.tsx derives strategy from global activeStrategy`: 5 tests
- `STRAT-04 — Stats.tsx strategy-aware DTE buckets`: 6 tests

## Test Results

All 563 tests pass (12 test files). No regressions.

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- `/Users/yuchenqiu/03_Projects/trading-journal/src/pages/Backtest.tsx` — modified, useAppSettings + getProfile present, no useState<StrategyMode>
- `/Users/yuchenqiu/03_Projects/trading-journal/src/pages/Stats.tsx` — modified, useAppSettings + activeStrategy + shortTerm DTE buckets present
- `/Users/yuchenqiu/03_Projects/trading-journal/tests/data-contract.test.ts` — modified, 88 lines added, 67 tests pass
- Commits: aba6de9 (test red phase), 267f06a (green phase)
