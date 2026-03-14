# Phase 3: Spread Builder Integration - Research

**Researched:** 2026-03-14
**Domain:** React UI / StrategyRecommender.tsx state management and rendering
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Signal banner design**
- Full-width card component placed above the regime card (first thing visible after analysis)
- Shows all signal metadata from URL params: signal type, score, direction, streak, ADX, RVOL, iv30d
- Includes a "WFA Validated" badge to reinforce that this entry aligns with backtest data
- Banner only appears when arriving from signals page (URL has signal params); absent on direct /selector navigation
- Show whatever params are available — partial params show partial banner, no minimum required set

**IV gate visual treatment**
- Gates the ENTIRE results section, not individual cards — one overlay/warning covers all recommendations
- Warning message shows threshold + current value: "IV Rank 22% is below the 30% WFA threshold for swing trades"
- Gate is DISMISSIBLE — "I understand the risk" button removes the overlay, user has final say
- IV threshold read from API response `strategyProfile.ivRankMin` (Phase 2 wired this)
- If IV rank is null/missing from API: show informational warning "IV Rank unavailable — cannot validate against WFA threshold" (not blocking)

**TP auto-fill UX**
- TP field appears only after user enters a fill price — empty state shows nothing
- Reactive computation: as user types fill price, TP updates showing both % and $ amount
- TP stored as percentage in target_price field (0.30 for swing, 0.40 for shortTerm)
- TP is editable — user can override the auto-filled value if they choose

**Edge states**
- Null IV rank: show informational warning, don't block
- Partial signal params: show banner with whatever is available
- Missing strategyProfile in API response: fall back to frontend strategyProfiles.ts import

### Claude's Discretion
- Exact TP field layout in the open-position form (new field vs inline annotation)
- Signal banner background color / styling consistent with existing regime card
- IV gate overlay styling (opacity, blur, z-index)
- Dismiss button placement and styling
- How to handle the reactive TP computation (debounce vs immediate)

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SIG-02 | Spread builder displays full signal context banner when arrived from signals page — shows signal type, score, direction, streak, ADX, RVOL | URL params already in place from Phase 2 `buildParams`; banner reads `searchParams.get()` for each field; guard is `score || streak || signalType || adx || rvol` truthy check |
| SIG-03 | Signal context banner absent when user navigates to spread builder directly | Inverse of SIG-02 — none of the signal params present means no banner rendered; `!hasSignalContext` path renders nothing |
| IVR-01 | Spread builder gates recommendations using strategy-specific IV rank threshold (swing >= 30%, shortTerm >= 40%) | `result.regime.ivRank` already in API response; `result.strategyProfile.ivRankMin` added by Phase 2; comparison at render time |
| IVR-02 | Sub-threshold candidates shown greyed-out with LOW_IV warning badge, not hidden | Overlay on results section (not card-level removal); CSS `opacity-50 pointer-events-none` when gate is active and not dismissed |
| IVR-03 | IV rank threshold sourced from `strategyProfiles.ts` (single source of truth), not hardcoded in UI | Read from `result.strategyProfile.ivRankMin` (API) with fallback to `getProfile(activeStrategy).ivRankMin` |
| IVR-04 | IV rank filter operates at API response display layer, not inside scoring functions | Pure render-time conditional — no changes to scoring.cjs or oss-core.ts |
| EXIT-01 | Profit target auto-filled from active strategy profile when opening position from spread builder | `target_price` added to `DirectAddItem` construction in `handleOpenPosition` using `profile.profitTarget` or `result.strategyProfile.profitTarget` |
| EXIT-03 | Auto-filled TP is editable — user can override | New `openPosTP` state (string) pre-filled by reactive effect when `openPosPrice` changes; user can type to override |
</phase_requirements>

---

## Summary

Phase 3 is a pure UI integration phase inside `src/pages/StrategyRecommender.tsx`. All data dependencies were established in Phases 1 and 2: the signal URL params arrive via `buildParams` in Signals.tsx, the `strategyProfile.ivRankMin` and `strategyProfile.profitTarget` fields are returned by `strategy-recommend.js`, and `target_price` is already typed on `DirectAddItem`. This phase wires those data points to three new visual elements: a signal context banner, an IV gate overlay, and a reactive TP field.

The file is large (1300+ lines) but the integration points are tightly scoped. Signal params are read at the `useSearchParams()` call already at line 72. The results section starts at `{result && (` around line 562 — the IV gate wraps this entire block. The open-position inline form is at lines 1170-1235 — the TP field inserts into the existing flex row.

The primary challenge is state management for the IV gate dismissal (`ivGateDismissed` boolean state) and the reactive TP computation (`openPosTP` state that responds to `openPosPrice` changes while remaining user-overridable). Both patterns are straightforward React state — no external library needed.

**Primary recommendation:** Three targeted additions to `StrategyRecommender.tsx` (signal banner, IV gate, TP field), backed by source-inspection regression tests following the established `readFileSync` pattern.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| React (existing) | 18 | State, effects, rendering | Already in project |
| react-router-dom `useSearchParams` | v6 | Read URL signal params | Already imported at line 2 |
| lucide-react | existing | Icons (AlertCircle, CheckCircle, X) | Already used throughout |
| Tailwind CSS | existing | Styling, overlay classes | All existing cards use it |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `src/lib/strategyProfiles.ts` `getProfile()` | local | Fallback ivRankMin/profitTarget | When strategyProfile absent from API response |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Inline overlay CSS | Portal/modal | Portal adds complexity; full-width CSS overlay is simpler and sufficient |
| Debounced TP update | Immediate onChange | Immediate is better UX for a single number field with no API call |

---

## Architecture Patterns

### Recommended Project Structure

No new files needed. All changes in:
```
src/pages/
└── StrategyRecommender.tsx   # All 3 features added here
tests/
└── data-contract.test.ts     # New SIG-02/SIG-03/IVR-01..04/EXIT-01/EXIT-03 tests appended
```

### Pattern 1: Signal Context Detection

**What:** Derive `hasSignalContext` boolean from URL search params. Read all 6 signal fields defensively (null = absent).

**When to use:** Before rendering — controls whether the banner renders at all (SIG-02 / SIG-03).

```typescript
// Extend existing searchParams block (line 72 area)
const urlScore     = searchParams.get('score');
const urlStreak    = searchParams.get('streak');
const urlSignalType = searchParams.get('signalType');
const urlAdx       = searchParams.get('adx');
const urlRvol      = searchParams.get('rvol');
const urlIv30d     = searchParams.get('iv30d');

const hasSignalContext = !!(urlScore || urlStreak || urlSignalType || urlAdx || urlRvol);
```

**Why `||` not `&&`:** CONTEXT.md requires "partial params show partial banner, no minimum required set."

### Pattern 2: Signal Banner Component (inline JSX)

**What:** Full-width card rendered immediately before the Regime Card (`{result && (` block, line 562). Mirrors the regime card's `bg-surface-card rounded-xl p-4 shadow-sm` pattern.

**When to use:** Only when `hasSignalContext` is true and `result` is present.

Visual anatomy:
```
[WFA Validated badge]  [EMA Signal · BULL · Score 94 · Streak 3d · ADX 28.5 · RVOL 1.42 · IV30 34.2%]
```

Color palette consistent with existing badges:
- `bg-emerald-500/10 border-emerald-500/30` for the WFA badge (already used in regime card)
- `bg-[#1C1C1E] border-[#2A2A2A] rounded-xl p-4` for the banner container (matches regime card)

### Pattern 3: IV Gate Overlay

**What:** When `result` exists and `result.regime.ivRank < ivRankMin` and `!ivGateDismissed`, wrap the entire recommendations div in a relative container and render an absolute overlay.

**State needed:**
```typescript
const [ivGateDismissed, setIvGateDismissed] = useState(false);
```

**Reset on new analysis:** Include `setIvGateDismissed(false)` in `handleAnalyze()` alongside the existing state resets.

**Threshold source (IVR-03):**
```typescript
const ivRankMin = result.strategyProfile?.ivRankMin ?? getProfile(activeStrategy).ivRankMin;
```

**Gate logic:**
```typescript
const ivRankPct = result.regime.ivRank != null ? result.regime.ivRank * 100 : null;
const ivBelowThreshold = ivRankPct != null && ivRankPct < ivRankMin;
const ivUnknown = result.regime.ivRank == null;
const showIvGate = (ivBelowThreshold || ivUnknown) && !ivGateDismissed;
```

**Overlay structure:**
```tsx
<div className="relative">
  {/* greyed-out results */}
  <div className={showIvGate ? 'opacity-40 pointer-events-none select-none' : ''}>
    {/* ...all recommendation cards... */}
  </div>
  {/* overlay */}
  {showIvGate && (
    <div className="absolute inset-0 flex items-center justify-center z-10">
      <div className="bg-[#1C1C1E] border border-amber-500/40 rounded-xl p-6 max-w-md mx-4 shadow-2xl text-center">
        <AlertCircle className="text-amber-400 mx-auto mb-3" size={28} />
        <p className="text-amber-300 font-bold mb-1">IV Rank below WFA threshold</p>
        <p className="text-gray-400 text-sm mb-4">
          {ivBelowThreshold
            ? `IV Rank ${ivRankPct!.toFixed(0)}% is below the ${ivRankMin}% WFA threshold for ${activeStrategy} trades`
            : 'IV Rank unavailable — cannot validate against WFA threshold'}
        </p>
        <button onClick={() => setIvGateDismissed(true)}
          className="px-4 py-2 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/30 rounded-lg text-sm font-bold transition-all">
          I understand the risk — proceed
        </button>
      </div>
    </div>
  )}
</div>
```

### Pattern 4: Reactive TP Field

**What:** New `openPosTP` state string. An effect reacts to `openPosPrice` changes and pre-fills the TP dollar amount. User can type to override.

**State needed:**
```typescript
const [openPosTP, setOpenPosTP] = useState('');
```

**Effect:**
```typescript
useEffect(() => {
  if (!openPosPrice) { setOpenPosTP(''); return; }
  const fillPrice = parseFloat(openPosPrice);
  if (isNaN(fillPrice) || fillPrice <= 0) { setOpenPosTP(''); return; }
  const tpPct = result?.strategyProfile?.profitTarget ?? getProfile(activeStrategy).profitTarget;
  setOpenPosTP((fillPrice * tpPct).toFixed(2));
}, [openPosPrice, activeStrategy, result]);
```

**Display text while typing:**
```
TP: $2.10 (30% of $7.00 credit)
```

**Wire to DirectAddItem in handleOpenPosition (EXIT-01):**
```typescript
const tpPct = result?.strategyProfile?.profitTarget ?? getProfile(activeStrategy).profitTarget;
const item: DirectAddItem = {
  ...existing fields...
  target_price: parseFloat(openPosTP) > 0
    ? parseFloat(openPosTP) / (parseFloat(openPosPrice) || 1)  // store as fraction
    : tpPct,
};
```

**Note:** CONTEXT.md states "TP stored as percentage in target_price field (0.30 for swing)". The `target_price` field in `DirectAddItem` is defined as `/** Take-profit target price, stored as a percentage (e.g., 0.30 = 30%). */`. So `target_price = tpFraction`, not a dollar amount. The display shows dollars, but storage is always the fraction. This means when the user overrides with a dollar amount we convert: `target_price = dollarTP / fillPrice`.

**Reset state on cancel/submit:** Add `setOpenPosTP('')` alongside `setOpenPosQty('')` / `setOpenPosPrice('')` in the existing reset paths (lines 307-309).

### Pattern 5: IV Gate Reset on New Analysis

`handleAnalyze()` already resets `openPosIdx`, `expandedCard`, etc. Add:
```typescript
setIvGateDismissed(false);
```

### Anti-Patterns to Avoid

- **Reading signal params in `useEffect`:** The params are stable on mount; read them at render time and derive `hasSignalContext` directly.
- **Scoring logic in render:** IVR-04 is explicit — IV threshold check must be a render-time comparison only, not inside any scoring function. No changes to `oss-core.ts` or `scoring.cjs`.
- **Hardcoding 30% or 40% in JSX:** Always read from `result.strategyProfile.ivRankMin` with fallback to `getProfile(activeStrategy).ivRankMin`.
- **Blocking gate (non-dismissible):** CONTEXT.md is explicit that the gate must be dismissible.
- **TP field visible before fill price entered:** The CONTEXT.md UX decision is "empty state shows nothing" — only render the TP row when `openPosPrice` is non-empty.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| IV threshold value | Hardcoded constants | `result.strategyProfile.ivRankMin` + `getProfile()` fallback | Phase 2 established this as single source of truth |
| TP percentage | Hardcoded 0.30 / 0.40 | `result.strategyProfile.profitTarget` + `getProfile()` fallback | Same single source of truth pattern |
| Overlay/modal | Custom portal or third-party | Inline absolute CSS overlay | Simpler, consistent with existing warnings |
| Signal context state | URL state, history.state | `useSearchParams()` | Already imported; survives refresh |

---

## Common Pitfalls

### Pitfall 1: IV Gate Not Resetting Between Analyses
**What goes wrong:** User dismisses gate, analyzes a different (also low-IV) ticker, gate stays dismissed.
**Why it happens:** `ivGateDismissed` state is not reset in `handleAnalyze`.
**How to avoid:** Add `setIvGateDismissed(false)` to the existing reset block in `handleAnalyze`.
**Warning signs:** Gate absent after clicking Analyze with a new ticker.

### Pitfall 2: TP Stored as Dollar Amount Instead of Fraction
**What goes wrong:** `target_price: 2.10` stored instead of `target_price: 0.30`. Position monitoring in future phases breaks.
**Why it happens:** The display is in dollars but the DB contract is a fraction.
**How to avoid:** When user overrides TP in dollars, convert: `target_price = parseFloat(openPosTP) / parseFloat(openPosPrice)`. When using profile default, use `tpPct` (0.30) directly.

### Pitfall 3: Banner Appears on Direct Navigation with Stale Params
**What goes wrong:** User arrives from signals (banner shows), navigates away, comes back via direct URL — banner might re-appear if params are still in the URL.
**Why it happens:** React Router preserves the URL. If the user navigates to `/selector?ticker=SPY&direction=BULL&score=92...` directly the next time, the banner would show.
**How to avoid:** This is actually correct behavior per the decision — "URL has signal params" means the banner shows, regardless of how the URL was constructed. The test for SIG-03 should verify absence when signal params are absent, not attempt to detect "navigation source".

### Pitfall 4: `openPosTP` Effect Fires with Stale `result`
**What goes wrong:** Effect depends on `result` for `strategyProfile.profitTarget` but `result` could be null briefly.
**Why it happens:** `result` is cleared at the top of `handleAnalyze`.
**How to avoid:** `result?.strategyProfile?.profitTarget ?? getProfile(activeStrategy).profitTarget` — the fallback ensures a valid value even when `result` is null.

### Pitfall 5: ivRank Null vs Low IV Confusion
**What goes wrong:** `result.regime.ivRank === null` triggers the blocking overlay (wrong per CONTEXT.md — null should be informational only).
**Why it happens:** A single `< ivRankMin` check treats null as 0, which is below threshold.
**How to avoid:** Explicit null check: `ivBelowThreshold = ivRankPct != null && ivRankPct < ivRankMin`. Separate `ivUnknown = ivRankPct == null`. Both trigger `showIvGate` but the message differs.

---

## Code Examples

### Signal Banner — Field Reading
```typescript
// Source: existing useSearchParams pattern in StrategyRecommender.tsx line 72-88
const [searchParams] = useSearchParams();
// Existing
const urlTicker = searchParams.get('ticker');
// New — add alongside existing reads
const urlScore      = searchParams.get('score');       // "94"
const urlStreak     = searchParams.get('streak');      // "3"
const urlSignalType = searchParams.get('signalType');  // "EMA"
const urlAdx        = searchParams.get('adx');         // "28.5"
const urlRvol       = searchParams.get('rvol');        // "1.42"
const urlIv30d      = searchParams.get('iv30d');       // "0.3420"
const hasSignalContext = !!(urlScore || urlStreak || urlSignalType || urlAdx || urlRvol);
```

### TP Conversion Formula
```typescript
// Fill price: $7.00 credit received, profitTarget: 0.30
// Display: "TP: $2.10 (30% of $7.00)"
// Store: target_price = 0.30

// If user overrides display to $2.50:
// Store: target_price = 2.50 / 7.00 = 0.357
// (preserves the fractional contract meaning)
```

### IV Rank Threshold Lookup
```typescript
// Source: Phase 2 established strategyProfile in API response (02-02-SUMMARY.md)
const ivRankMin: number =
  (result.strategyProfile?.ivRankMin != null)
    ? result.strategyProfile.ivRankMin   // from API (e.g. 30 or 40)
    : getProfile(activeStrategy).ivRankMin; // fallback

const ivRankPct = result.regime.ivRank != null
  ? result.regime.ivRank * 100   // ivRank is 0-1 in the type; display as 0-100
  : null;
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Hardcoded `ivRankMin: 30` in UI | Read from `strategyProfile.ivRankMin` | Phase 2 (this milestone) | Enables shortTerm 40% vs swing 30% without code duplication |
| No TP pre-fill | `target_price` on `DirectAddItem`, reactive compute | Phase 2 (type) + Phase 3 (UI) | WFA exit rule enforced at entry |
| No signal context in spread builder | URL params from `buildParams` in Signals.tsx | Phase 2 (SIG-01) | Context visible to trader at decision moment |

---

## Open Questions

1. **Should the signal banner persist after re-running Analyze?**
   - What we know: Banner reads URL params which are set at navigation time and don't change when Analyze is re-clicked.
   - What's unclear: If user changes ticker/direction manually and re-runs, the banner still shows the original signal params.
   - Recommendation: Keep banner visible as long as signal params are in the URL. This is consistent with the "URL params survive refresh" design decision. If the user wants a clean state they navigate away.

2. **TP field placement — new row vs inline annotation?**
   - What we know: Claude's Discretion per CONTEXT.md.
   - Recommendation: Add as a new row in the open-position form flex layout — same `w-28` width as the Entry $ field, placed immediately after it. Label: "TP $". This is the least disruptive insertion into the existing 3-field (Qty, Entry $, Owner) row pattern.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (523 tests passing as of 2026-03-14) |
| Config file | `vite.config.ts` (test config inline) |
| Quick run command | `npx vitest run tests/data-contract.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map

All tests follow the established `readFileSync` source-inspection pattern from `data-contract.test.ts`. No server startup or React rendering needed.

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SIG-02 | StrategyRecommender.tsx reads score/streak/signalType/adx/rvol/iv30d from searchParams | source inspection | `npx vitest run tests/data-contract.test.ts` | ✅ (append to existing file) |
| SIG-03 | Signal banner conditional on `hasSignalContext` (absent when no signal params) | source inspection | `npx vitest run tests/data-contract.test.ts` | ✅ (append) |
| IVR-01 | IV gate compares result.regime.ivRank to threshold | source inspection | `npx vitest run tests/data-contract.test.ts` | ✅ (append) |
| IVR-02 | IV gate wraps results section (not individual cards) | source inspection | `npx vitest run tests/data-contract.test.ts` | ✅ (append) |
| IVR-03 | Threshold read from `result.strategyProfile?.ivRankMin` with fallback | source inspection | `npx vitest run tests/data-contract.test.ts` | ✅ (append) |
| IVR-04 | No IV rank check inside scoring.cjs or oss-core.ts | source inspection (negative) | `npx vitest run tests/data-contract.test.ts` | ✅ (append) |
| EXIT-01 | handleOpenPosition sets target_price on DirectAddItem | source inspection | `npx vitest run tests/data-contract.test.ts` | ✅ (append) |
| EXIT-03 | openPosTP state is editable (not computed-only) | source inspection | `npx vitest run tests/data-contract.test.ts` | ✅ (append) |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/data-contract.test.ts` (fast, ~200ms)
- **Per wave merge:** `npx vitest run` (full 523+ suite)
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
None — existing test infrastructure covers all phase requirements. Tests are appended to `tests/data-contract.test.ts` following the established `readFileSync` pattern. No new test files or framework config needed.

---

## Sources

### Primary (HIGH confidence)
- Source code: `src/pages/StrategyRecommender.tsx` (1300+ lines, read directly) — all integration points, state patterns, existing form structure
- Source code: `src/lib/strategyProfiles.ts` — `ivRankMin` and `profitTarget` values for both profiles
- Source code: `src/lib/types.ts` — `DirectAddItem.target_price` field definition and JSDoc
- Source code: `src/pages/Signals.tsx` lines 706-737 — `buildParams` IIFE producing the URL params Phase 3 reads
- Phase 2 deliverables: `02-02-SUMMARY.md` — confirms `strategyProfile` in API response and `target_price` in mutation

### Secondary (MEDIUM confidence)
- `tests/data-contract.test.ts` — existing test patterns using `readFileSync` source inspection; Phase 3 tests follow same structure

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries; existing React, Tailwind, useSearchParams
- Architecture: HIGH — integration points verified by reading actual source code
- Pitfalls: HIGH — derived from actual code behavior (null checks, state reset paths, type contracts)

**Research date:** 2026-03-14
**Valid until:** 2026-04-14 (stable codebase; only StrategyRecommender.tsx changes would invalidate)
