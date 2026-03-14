# Phase 2: Data Contract + API Foundation - Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Establish the type contract for profit target, wire API routes to be strategy-aware, and propagate signal context from signals page into URL params. This is the producer-side plumbing — Phase 3 consumes it in the spread builder.

</domain>

<decisions>
## Implementation Decisions

### Signal URL params
- Signals page CTA passes ALL available signal metadata: score, direction, streak, signalType, adxValue, rvol, iv30d
- signalType hardcoded as 'EMA' for now — extend when MOM signals are added
- URL format: `/selector?ticker=TSLA&direction=BULL&strategy=swing&score=95&streak=3&signalType=EMA&adx=28&rvol=1.2&iv30d=0.35`
- These params are read-only context — they inform the banner in Phase 3, not the scoring

### API strategy behavior
- strategy-recommend.js returns `profitTarget` and `ivRankMin` in the API response alongside regime data — frontend reads from API, not from strategyProfiles import
- DTE Gaussian sigma derived internally from strategy param (swing σ=15, shortTerm σ=5) — no extra API param
- API adjusts dtePeak, defaultWidth, deltaRange per strategy profile
- Include `strategy` in the response context object so frontend knows which profile was used

### target_price write path
- Store target_price as PERCENTAGE (e.g., 0.30 for swing 30%, 0.40 for shortTerm 40%) — not absolute dollar
- Compute absolute target at display time from entry_price and stored percentage
- TP auto-fill computed from actual fill price the user enters, not from recommendation credit — this means TP field updates reactively as the user types their fill price
- Add `target_price` field to DirectAddItem interface and write it in useAddDirect mutation

### Claude's Discretion
- Exact URL param encoding (whether to use short names like `adx` vs `adxValue`)
- Whether to add a helper function for parsing signal params from URL
- How to handle the reactive TP computation in the open-position form (debounce, immediate, etc.)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `DirectAddItem` in `src/lib/types.ts:125` — already has strategy_type, iv_rank_entry, spread_width; just needs target_price
- `useAddDirect` in `src/hooks/usePositionMutations.ts:96` — mutation already writes to positions table
- `Position` in `src/lib/types.ts:18` — already has `target_price?: number` field
- `Signals.tsx` lines 706-712 — existing navigate() calls to `/selector` with ticker, direction, strategy

### Established Patterns
- URL params read via `useSearchParams()` from React Router v6
- Strategy profiles imported directly: `import { STRATEGY_PROFILES, getProfile } from '../lib/strategyProfiles'`
- API routes read params via `req.query.*` destructuring

### Integration Points
- `Signals.tsx` lines 706, 712 — add signal metadata params to navigate() calls
- `api/strategy-recommend.js` — add strategy profile branching and return profitTarget/ivRankMin in response
- `src/hooks/usePositionMutations.ts:99` — add target_price to insert object in useAddDirect
- `src/lib/types.ts:125` — add target_price to DirectAddItem interface
- `StrategyRecommender.tsx` line 281 — add target_price to DirectAddItem construction

</code_context>

<specifics>
## Specific Ideas

- The reactive TP field should show something like "TP: $2.10 (30% of $3.00 credit)" updating as the user types their fill price
- target_price stored as percentage allows easy comparison: "this position targets 30% TP" regardless of credit amount

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-data-contract-api-foundation*
*Context gathered: 2026-03-14*
