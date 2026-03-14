# Roadmap: WFA-Driven Workflow Integration

## Overview

This milestone operationalizes the WFA-validated trading edge by wiring the validated rules directly into the execution flow. Four phases close the gap in dependency order: first, fix pre-existing config bugs that would corrupt every feature downstream; second, establish the data contract and API param foundation; third, integrate all consumer-side behaviors in the spread builder (signal context, IV gate, TP auto-fill); fourth, surface the global strategy toggle everywhere so the active strategy is never ambiguous.

## Phases

- [ ] **Phase 1: Prerequisite Fixes** - Correct pre-existing bugs that corrupt strategy-specific parameters before any feature work
- [ ] **Phase 2: Data Contract + API Foundation** - Establish type contract for TP, wire API params, propagate signal context from signals page
- [ ] **Phase 3: Spread Builder Integration** - Connect signal banner, IV rank gate, and TP auto-fill in StrategyRecommender
- [ ] **Phase 4: Global Strategy Toggle** - Surface active strategy indicator in AppLayout and propagate strategy-aware defaults across all pages

## Phase Details

### Phase 1: Prerequisite Fixes
**Goal**: Pre-existing config bugs are corrected so strategy parameters are accurate and consistent before any feature work begins
**Depends on**: Nothing (first phase)
**Requirements**: PRE-01, PRE-02, PRE-03
**Success Criteria** (what must be TRUE):
  1. shortTerm strategy profile uses ivRankMin of 40% (not 30%), matching WFA-validated threshold
  2. scan-options.js accepts `activeProfile` (not `profileStrategy`) as the strategy profile param — no collision with existing `strategy` param
  3. All code paths that previously read `settings.creditSpread.*` for strategy-specific params now read from `getProfile(activeStrategy).*`
  4. All 488 existing tests pass with no new failures
**Plans:** 1 plan

Plans:
- [ ] 01-01-PLAN.md — Fix ivRankMin, standardize API param naming, replace credit spread settings with WFA info card

### Phase 2: Data Contract + API Foundation
**Goal**: The type contract for profit target is in place, API routes are strategy-aware, and signal context is emitted from the signals page into the URL
**Depends on**: Phase 1
**Requirements**: EXIT-02, STRAT-01, STRAT-02, SIG-01
**Success Criteria** (what must be TRUE):
  1. Opening a position with a `target_price` value writes it to the `positions` table (verifiable in DB/history view)
  2. Calling `strategy-recommend.js?strategy=shortTerm` returns profile-specific DTE, delta, and width defaults differing from the swing defaults
  3. Clicking "Build Swing Spread" or "Build ST Spread" on the signals page generates a URL containing `score`, `streak`, and `signal` query params alongside the existing `ticker`, `direction`, `strategy` params
  4. All 488 existing tests pass; new unit tests cover target_price mutation and URL param construction
**Plans**: TBD

### Phase 3: Spread Builder Integration
**Goal**: The spread builder enforces WFA-validated rules automatically — signal context is visible, IV rank gates candidates, and profit target is pre-filled at entry
**Depends on**: Phase 2
**Requirements**: SIG-02, SIG-03, IVR-01, IVR-02, IVR-03, IVR-04, EXIT-01, EXIT-03
**Success Criteria** (what must be TRUE):
  1. Arriving from signals page shows a signal context banner with signal type, score, direction, and streak; navigating to /selector directly shows no banner
  2. Candidates below the strategy-specific IV rank threshold appear visually distinct (greyed-out) with a LOW_IV badge indicating the threshold and current IV rank
  3. Opening a position from the spread builder pre-fills the profit target field with the strategy-specific TP percentage (30% for swing, 40% for shortTerm); the field is editable
  4. The IV rank threshold displayed and applied matches `strategyProfiles.ts` exactly — changing the profile source updates the gate with no other code changes required
  5. All 488 existing tests pass; IV gate logic is in the render/API-response layer with no changes to scoring functions
**Plans**: TBD

### Phase 4: Global Strategy Toggle
**Goal**: The active strategy is always visible and switchable from any page, and all pages reflect strategy-specific parameter defaults
**Depends on**: Phase 3
**Requirements**: STRAT-03, STRAT-04
**Success Criteria** (what must be TRUE):
  1. A SWING / ST toggle is visible in the AppLayout header on every page — user never needs to navigate to settings to see or change the active strategy
  2. Switching strategy updates page subtitles and default DTE/delta/width values on Scanner, Signals, and Selector pages without requiring a page reload
  3. Portfolio DTE health indicators adapt to the active strategy's DTE range (swing 45-65d, shortTerm 7-14d)
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Prerequisite Fixes | 0/1 | Planning complete | - |
| 2. Data Contract + API Foundation | 0/TBD | Not started | - |
| 3. Spread Builder Integration | 0/TBD | Not started | - |
| 4. Global Strategy Toggle | 0/TBD | Not started | - |
