# Phase 4: Global Strategy Toggle - Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Surface active strategy indicator in AppLayout and propagate strategy-aware defaults across all pages. Most of this work was already shipped in prior phases — this phase is cleanup of remaining hardcoded strategy text in Backtest.tsx and Stats.tsx.

</domain>

<decisions>
## Implementation Decisions

### Global toggle (STRAT-03) — ALREADY EXISTS
- Swing/Short pill toggle in AppLayout.tsx header (lines 39-51) — shipped in a prior commit
- Color-coded: swing = green, shortTerm = blue
- All pages with strategy-dependent behavior already read `activeStrategy` from context
- No new work needed for STRAT-03

### Backtest page strategy-awareness
- Make the hardcoded WFA config strings dynamic based on active strategy
- "Swing (45-65 DTE)" → read from `getProfile(activeStrategy).label`
- "DTE 45-65 · $15 width · Delta 0.35 · TP 30%" → read from profile properties
- The Backtest page currently has a swing/short toggle already (for WFA results viewer) — make it sync with the global activeStrategy

### Stats page DTE buckets
- Make DTE buckets strategy-aware instead of hardcoded '<30d', '30-45d', '45-65d', '65+d'
- For swing: keep current buckets (they match 45-65 DTE sweet spot)
- For shortTerm: use buckets like '<5d', '5-10d', '10-14d', '14+d' (matching 7-14 DTE sweet spot)
- Derive bucket boundaries from strategy profile DTE range

### Claude's Discretion
- Exact bucket breakpoints for shortTerm DTE stats
- Whether the Backtest page's internal swing/short toggle should be removed in favor of the global one
- Any other pages with hardcoded strategy text found during implementation

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `AppLayout.tsx` lines 39-51: global toggle already renders and works
- `useAppSettings()` → `activeStrategy` already available in all pages
- `getProfile(activeStrategy)` pattern established throughout codebase
- `STRATEGY_PROFILES[s].shortLabel` / `.subtitle` / `.label` already defined

### Established Patterns
- Scanner, StrategyRecommender, Portfolio, Signals all read `activeStrategy` from context
- Profile properties accessed via `getProfile(activeStrategy).dteMin` etc.

### Integration Points
- `src/pages/Backtest.tsx` lines 313, 326, 427, 513, 729 — hardcoded swing strategy text
- `src/pages/Stats.tsx` lines 179, 381 — hardcoded DTE bucket boundaries
- Backtest page has its own `isShort` toggle — needs to sync with global `activeStrategy`

</code_context>

<specifics>
## Specific Ideas

No specific requirements — this is a cleanup phase. Follow existing patterns from other pages.

</specifics>

<deferred>
## Deferred Ideas

- Remove Scanner page entirely (noted in Phase 1)

</deferred>

---

*Phase: 04-global-strategy-toggle*
*Context gathered: 2026-03-14*
