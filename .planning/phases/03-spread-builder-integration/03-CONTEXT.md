# Phase 3: Spread Builder Integration - Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Connect signal banner, IV rank gate, and TP auto-fill in StrategyRecommender.tsx. This is the consumer side — Phase 2 produced the URL params and API data, this phase renders them in the spread builder UI and wires TP into the open-position flow.

</domain>

<decisions>
## Implementation Decisions

### Signal banner design
- Full-width card component placed above the regime card (first thing visible after analysis)
- Shows all signal metadata from URL params: signal type, score, direction, streak, ADX, RVOL, iv30d
- Includes a "WFA Validated" badge to reinforce that this entry aligns with backtest data
- Banner only appears when arriving from signals page (URL has signal params); absent on direct /selector navigation
- Show whatever params are available — partial params show partial banner, no minimum required set

### IV gate visual treatment
- Gates the ENTIRE results section, not individual cards — one overlay/warning covers all recommendations
- Warning message shows threshold + current value: "IV Rank 22% is below the 30% WFA threshold for swing trades"
- Gate is DISMISSIBLE — "I understand the risk" button removes the overlay, user has final say
- IV threshold read from API response `strategyProfile.ivRankMin` (Phase 2 wired this)
- If IV rank is null/missing from API: show informational warning "IV Rank unavailable — cannot validate against WFA threshold" (not blocking)

### TP auto-fill UX
- TP field appears only after user enters a fill price — empty state shows nothing
- Reactive computation: as user types fill price, TP updates showing both % and $ amount
- TP stored as percentage in target_price field (Phase 2 decision: 0.30 for swing, 0.40 for shortTerm)
- TP is editable — user can override the auto-filled value if they choose

### Edge states
- Null IV rank: show informational warning, don't block
- Partial signal params: show banner with whatever is available
- Missing strategyProfile in API response: fall back to frontend strategyProfiles.ts import

### Claude's Discretion
- Exact TP field layout in the open-position form (new field vs inline annotation)
- Signal banner background color / styling consistent with existing regime card
- IV gate overlay styling (opacity, blur, z-index)
- Dismiss button placement and styling
- How to handle the reactive TP computation (debounce vs immediate)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `useSearchParams()` already imported in StrategyRecommender.tsx (line 2, 72)
- `searchParams` already parsed for ticker, direction, strategy
- Regime card component (lines 562-687) — signal banner should match this visual style
- `handleOpenPosition` callback (line 247) — integration point for TP auto-fill
- `DirectAddItem` construction (line 281) — where target_price gets added
- `openPosPrice` state (used in handleOpenPosition) — the fill price input the TP reacts to
- API response `result.regime.ivRank` — IV rank already available in the response

### Established Patterns
- Cards use `bg-surface-card rounded-xl p-4 shadow-sm` styling pattern
- Color-coded badges throughout: green for positive, amber for warning, red for danger
- Regime card uses `<div className="grid grid-cols-2 gap-4">` for multi-column layout

### Integration Points
- `StrategyRecommender.tsx` line 72 — extend searchParams reads for signal params
- Above the regime card rendering (~line 562) — insert signal banner
- Results section (after regime card) — wrap in IV gate overlay
- `handleOpenPosition` (~line 247) — add target_price to DirectAddItem construction
- Open-position form (wherever price input renders) — add reactive TP display

</code_context>

<specifics>
## Specific Ideas

- Signal banner should feel like a "why you're here" context card — not a data dump
- IV gate overlay should be respectful — inform the user, don't lecture. One button to proceed.
- The reactive TP should show: "TP: $2.10 (30% of $3.00 credit)" format, updating live as fill price changes

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 03-spread-builder-integration*
*Context gathered: 2026-03-14*
