---
phase: 01-prerequisite-fixes
plan: 01
subsystem: ui
tags: [react, typescript, strategy-profiles, settings, scanner, api]

# Dependency graph
requires: []
provides:
  - Corrected shortTerm ivRankMin (40, not 30) in strategyProfiles.ts
  - Standardized activeProfile param name across Scanner.tsx and scan-options.js
  - AppSettings WFA info card replacing editable credit spread inputs
  - CreditSpreadSettings type removed from settings.ts
  - creditSpread removed from AppSettings interface and DEFAULT_APP_SETTINGS
  - creditSpread merge logic removed from AppSettingsContext.tsx
affects:
  - 02-signal-context
  - 03-iv-gate
  - 04-tp-autofill

# Tech tracking
tech-stack:
  added: []
  patterns:
    - STRATEGY_PROFILES as single source of truth for credit spread config (no parallel editables)
    - WFA-validated config displayed read-only, not editable

key-files:
  created:
    - tests/prerequisite-fixes.test.ts
  modified:
    - src/lib/strategyProfiles.ts
    - src/pages/Scanner.tsx
    - api/scan-options.js
    - src/lib/types/settings.ts
    - src/context/AppSettingsContext.tsx
    - src/pages/AppSettings.tsx

key-decisions:
  - "Param rename to activeProfile (not strategy) to avoid collision with the existing strategy=long/short LOQ/CSQ toggle in scan-options.js"
  - "CreditSpreadSettings interface fully removed — downstream phases use STRATEGY_PROFILES directly as single source of truth"
  - "WFA info card shows both profiles side-by-side with hardcoded Sharpe values (swing 2.14, shortTerm 4.77)"

patterns-established:
  - "Strategy config: always read from STRATEGY_PROFILES[key], never from AppSettings.creditSpread"
  - "API profile selection: use activeProfile query param, never profileStrategy"

requirements-completed: [PRE-01, PRE-02, PRE-03]

# Metrics
duration: 2min
completed: 2026-03-14
---

# Phase 1 Plan 01: Prerequisite Fixes Summary

**Corrected shortTerm ivRankMin to 40, standardized activeProfile param across Scanner and API, and replaced editable credit spread settings with a read-only WFA-validated info card sourced from STRATEGY_PROFILES**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-14T15:16:35Z
- **Completed:** 2026-03-14T15:18:58Z
- **Tasks:** 2
- **Files modified:** 6 (+ 1 created)

## Accomplishments
- Fixed shortTerm.ivRankMin from 30 to 40 in strategyProfiles.ts — the single source of truth is now correct (PRE-01)
- Renamed profileStrategy param to activeProfile in Scanner.tsx and scan-options.js, eliminating collision risk with the strategy=long/short LOQ/CSQ toggle (PRE-02)
- Removed CreditSpreadSettings interface, creditSpread field from AppSettings type, DEFAULT_APP_SETTINGS defaults, and all three merge lines in AppSettingsContext.tsx (PRE-03)
- Replaced editable credit spread section in AppSettings.tsx with a read-only two-column WFA info card sourced from STRATEGY_PROFILES (PRE-03)
- Added tests/prerequisite-fixes.test.ts with 8 regression tests covering all three fixes; all 496 tests pass (488 original + 8 new)

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix ivRankMin and standardize API param naming (PRE-01 + PRE-02)** - `965f754` (fix)
2. **Task 2: Replace credit spread settings with WFA info card (PRE-03)** - `4f96adc` (feat)

**Plan metadata:** (docs commit — see below)

## Files Created/Modified
- `src/lib/strategyProfiles.ts` - shortTerm.ivRankMin: 30 -> 40
- `src/pages/Scanner.tsx` - params.set('profileStrategy', ...) -> params.set('activeProfile', ...)
- `api/scan-options.js` - req.query.profileStrategy -> req.query.activeProfile
- `src/lib/types/settings.ts` - Removed CreditSpreadSettings interface and creditSpread from AppSettings + DEFAULT_APP_SETTINGS
- `src/context/AppSettingsContext.tsx` - Removed three creditSpread merge lines
- `src/pages/AppSettings.tsx` - Replaced credit spread inputs with WFA info card, added STRATEGY_PROFILES import
- `tests/prerequisite-fixes.test.ts` - New file with 8 regression tests (PRE-01, PRE-02, PRE-03)

## Decisions Made
- Used activeProfile (not strategy) for the Scanner param rename to avoid collision with the existing strategy=long/short LOQ/CSQ toggle already destructured on line 51 of scan-options.js
- Fully removed CreditSpreadSettings type rather than leaving it as a stub — downstream phases will always read from STRATEGY_PROFILES directly
- WFA Sharpe values (swing 2.14, shortTerm 4.77) hardcoded in the info card since they are research artifacts, not runtime data

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All three prerequisite fixes are clean and tested
- strategyProfiles.ts is the authoritative source for all credit spread config going forward
- Scanner and API are aligned on activeProfile param naming
- Phase 2 (signal context, IV gate, TP auto-fill) can proceed without config bugs corrupting strategy parameters

---
*Phase: 01-prerequisite-fixes*
*Completed: 2026-03-14*
