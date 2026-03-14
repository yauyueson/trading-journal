# Architecture Patterns

**Domain:** Signal-to-execution workflow integration in a React trading journal
**Researched:** 2026-03-14
**Confidence:** HIGH — based on direct code analysis of the existing codebase

---

## Existing Architecture Snapshot

This is a subsequent milestone. The architecture below reflects what already exists plus the integration gaps that need closing. Understanding what is already wired is the prerequisite to understanding what needs to be built.

### What Already Exists (verified from source)

| Component | File | Current State |
|-----------|------|---------------|
| Strategy profiles | `src/lib/strategyProfiles.ts` | Complete — swing and shortTerm with all params |
| Active strategy state | `src/context/AppSettingsContext.tsx` | Complete — `activeStrategy` + `setActiveStrategy` in context |
| Strategy toggle UI | `src/pages/StrategyRecommender.tsx` | Exists in Spread Builder header only |
| URL param handoff | `src/pages/StrategyRecommender.tsx:80-90` | `ticker`, `direction`, `strategy` are read from `useSearchParams` |
| Signal CTAs | `src/pages/Signals.tsx:706-718` | Both buttons navigate with `?ticker=&direction=&strategy=` |
| Auto-analyze trigger | `src/pages/StrategyRecommender.tsx:93-102` | Fires `handleAnalyze()` when URL ticker matches state |
| Strategy param to API | `src/pages/StrategyRecommender.tsx:127` | `&strategy=${activeStrategy}` sent to `/api/strategy-recommend` |
| `strategy_type` on position | `src/lib/types.ts:149`, `usePositionMutations.ts:124` | Written to DB at entry — `strategy_type: activeStrategy` |

### What Is Absent (the integration gaps)

| Gap | Impact |
|-----|--------|
| Signal context (score, signal type, streak) not carried through URL | Spread Builder has no idea which signal triggered it |
| IV rank not hard-filtered in Spread Builder | Low-IV candidates display and can be acted on |
| Profit target (`target_price`) not auto-filled at entry | User must manually apply TP; `DirectAddItem` lacks `target_price` field |
| Strategy toggle only in Spread Builder | No global access — if user navigates to Scanner first, toggle not visible |
| `DirectAddItem` and `useAddDirect` do not write `target_price` | Even if UI computed TP, DB write path would drop it |

---

## Recommended Architecture

### Signal-to-Execution Data Flow

```
signal_history (DB) ──────────────────────────────────────────────┐
orats_iv_cache (DB) ──┐                                           │
                       ▼                                           ▼
Signals.tsx ──── useWatchlistIV ──── DashboardRow ──── CTA navigate()
(computes: score,     │               (status=GO,         ?ticker=TSLA
  direction, streak,  │                iv30=0.42,          &direction=BULL
  iv30, adx, rvol)    │                streak=3,           &strategy=swing
                       └──────────────  signal=EMA)         &score=94
                                                             &streak=3
                                                             &signal=EMA
                                                                │
                                                                ▼
StrategyRecommender.tsx ── useSearchParams() ── SignalContextBanner
  (reads: ticker, direction, strategy)            (score, direction,
  (NEW: reads: score, streak, signal)              streak, IV badge)
                │
                ├─── profile = getProfile(activeStrategy)
                │    (DTE, delta, width, profitTarget, ivRankMin)
                │
                ├─── handleAnalyze() → /api/strategy-recommend
                │    ?ticker=TSLA&direction=BULL&strategy=swing
                │    &targetDte=55&spreadWidth=15
                │
                │    ← StrategyResult { regime.ivRank, recommendations[] }
                │
                ├─── IV rank gate: regime.ivRank < profile.ivRankMin → block
                │
                └─── Open Position form:
                     entry_price (user input)
                     target_price = entry_price * (1 - profile.profitTarget) [NEW]
                     → useAddDirect(DirectAddItem + target_price) → positions DB
```

### Component Boundaries

| Component | Responsibility | Reads From | Writes To |
|-----------|---------------|-----------|-----------|
| `Signals.tsx` | Compute signal status, render dashboard, navigate to Spread Builder | `useSignalScanner`, `useWatchlistIV`, `useSignalStreaks`, `usePositions` | URL params on navigate |
| `src/lib/strategyProfiles.ts` | Single source of truth for all strategy parameters | — | Imported by pages + API |
| `AppSettingsContext` | Global `activeStrategy` state + persistence | `localStorage`, Supabase `app_settings` | `localStorage`, Supabase |
| `StrategyRecommender.tsx` | Spread builder: read context, fetch recommendations, gate on IV, open positions | URL params, `AppSettingsContext`, `/api/strategy-recommend` | `positions` DB via `useAddDirect` |
| `/api/strategy-recommend.js` | Options scoring + recommendation engine | ORATS API, `?strategy` param | Response JSON |
| `useAddDirect` / `usePositionMutations.ts` | DB write for new positions | `DirectAddItem` | `positions`, `transactions` tables |
| `DirectAddItem` (type) | Data contract for opening a position | — | `useAddDirect` |

### Where Each New Feature Lives

#### 1. Signal Context (score, signal type, streak) in URL

**Where:** `Signals.tsx` — DashboardDetailPanel CTA buttons (lines 706-718)

**Current:** `navigate('/selector?ticker=X&direction=Y&strategy=Z')`

**Change:** Add `&score=${row.score}&signal=${row.signal}&streak=${row.streak}` to the URL

No new state management needed. URL params are the transport layer between two lazy-loaded pages. `useSearchParams` already exists in StrategyRecommender.

**Boundary:** Signals page is the producer. StrategyRecommender is the consumer. The URL is the interface.

#### 2. Signal Context Banner in Spread Builder

**Where:** `StrategyRecommender.tsx` — above the ticker input form, displayed when URL params contain `score`

**Data flow:** `useSearchParams()` → read `score`, `signal`, `streak` → render banner

This is a read-only display component. No state management changes. Dismissed once user manually changes ticker.

#### 3. IV Rank Hard Filter

**Where:** `StrategyRecommender.tsx` — after `handleAnalyze()` resolves, before rendering recommendations

**Data flow:** `result.regime.ivRank` (already in API response) → compare to `profile.ivRankMin` → render gate UI

The API already returns `regime.ivRank`. The profile already has `ivRankMin`. The filter is a pure rendering decision — no API changes needed.

**Condition:** `result.regime.ivRank !== null && result.regime.ivRank * 100 < profile.ivRankMin`

When gated: show warning panel, hide recommendation cards. Do not prevent the API call — the data is still needed to show the IV rank value.

#### 4. Auto-Fill Profit Target

**Where:** `StrategyRecommender.tsx` — open position inline form (currently `openPosPrice` state)

**Data flow:**
```
user types entry_price → openPosPrice state
profile.profitTarget → computed TP = entry_price × (1 - profitTarget)
→ DirectAddItem.target_price
→ useAddDirect → positions.target_price column
```

**Type change required:** `DirectAddItem` needs `target_price?: number` added. `useAddDirect` mutation needs to write it. The `positions` table already has `target_price` (confirmed from `Position` interface line 18 and `WatchlistItem` line 104).

**Boundary:** The TP value is derived from `entry_price × (1 - profile.profitTarget)`. No user input needed — show it as a read-only preview next to the price field with an override affordance.

#### 5. Global Strategy Toggle

**Where:** `src/layouts/AppLayout.tsx` — header bar (above tabs)

**Current:** Toggle exists only in StrategyRecommender's own header.

**Change:** Move or duplicate toggle into AppLayout header so it appears on all pages. `useAppSettings()` is already available everywhere via context.

**Why AppLayout not TabNav:** AppLayout wraps all pages and has the persistent shell. TabNav is the tab bar — adding a strategy control there conflates navigation with configuration.

---

## Data Flow: Entry to Database

```
                    ┌─ URL params (score, signal, streak, direction, strategy)
                    │
StrategyRecommender │
  state:            │
    ticker          │── handleAnalyze() ──→ /api/strategy-recommend
    direction       │                              │
    activeStrategy  │                              ▼
    openPosPrice    │                   StrategyResult {
    [NEW] auto TP   │                     regime.ivRank,
                    │                     recommendations[],
                    │                     context.targetDte
                    │                   }
                    │
                    │── IV gate check (regime.ivRank vs profile.ivRankMin)
                    │
                    │── user clicks "Open Position"
                    │      openPosPrice (manual entry)
                    │      [NEW] target_price = price × (1 - profile.profitTarget)
                    │
                    └── useAddDirect(DirectAddItem)
                              │
                              ▼
                         positions table
                           target_price = computed TP   [NEW write]
                           strategy_type = activeStrategy
                           iv_rank_entry = regime.ivRank
                           spread_width = rec.width
```

---

## Patterns to Follow

### Pattern 1: URL as Page-to-Page Interface

**What:** Use `useNavigate` to pass context between pages via query params. Consumer uses `useSearchParams` to read.

**When:** Any time two lazy-loaded pages need to share state that doesn't belong in a global context (ephemeral, per-navigation data).

**Why this project uses it:** The existing `ticker`, `direction`, `strategy` handoff already works this way. Extending it for signal context (`score`, `signal`, `streak`) is zero additional infrastructure.

**Constraint:** URL params are strings. Numeric values need `parseInt`/`parseFloat` on the consumer side.

```typescript
// Producer (Signals.tsx)
navigate(`/selector?ticker=${row.ticker}&direction=${dir}&strategy=swing&score=${row.score}&signal=${row.signal}&streak=${row.streak}`);

// Consumer (StrategyRecommender.tsx)
const score = parseInt(searchParams.get('score') || '0', 10);
const signal = searchParams.get('signal') || '';
const streak = parseInt(searchParams.get('streak') || '0', 10);
```

### Pattern 2: Profile-Derived Computed Values (no user input)

**What:** Compute output values from `getProfile(activeStrategy)` + a single user input, rather than making the user fill multiple fields.

**When:** Any field that is deterministically derivable from the active strategy and an entry price.

**Example:** `target_price = entry_price × (1 - profile.profitTarget)`. Show computed result; allow override.

```typescript
const profile = getProfile(activeStrategy);
const computedTP = openPosPrice ? parseFloat(openPosPrice) * (1 - profile.profitTarget) : null;
```

### Pattern 3: Render-Layer IV Gate (not API-layer)

**What:** Let the API run and return results, then gate display in the UI.

**Why not API-layer:** The API already validates and returns `regime.ivRank`. Blocking at the API would lose the IV rank value the UI needs to display. The gate is a UX intervention, not a data constraint.

**Implementation:** After `result` is set, check `ivGated` condition before rendering recommendation cards. Render a gate UI instead.

```typescript
const ivGated = result !== null
  && result.regime.ivRank !== null
  && result.regime.ivRank * 100 < profile.ivRankMin;
```

### Pattern 4: Context for Cross-Page Global State

**What:** `AppSettingsContext` carries `activeStrategy` + `setActiveStrategy`. Any page can read and write it.

**When:** State that should persist across tab navigation and page reloads (stored in `localStorage`).

**Constraint:** `activeStrategy` is intentionally NOT in Supabase `app_settings` — it's a UI preference that persists locally only. Do not add it to the DB sync path.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Signal Context in a New Context Provider

**What:** Creating a `SignalContext` to pass score/streak/signal from Signals to Spread Builder.

**Why bad:** React Context is for values that multiple components at different levels need simultaneously. Signal context is one-way, ephemeral, and only applies when navigating from Signals to Spread Builder. URL params solve this with zero infrastructure.

**Instead:** URL params via `navigate()` + `useSearchParams()`.

### Anti-Pattern 2: Blocking the API Call on IV Rank

**What:** Checking IV rank (from `orats_iv_cache` or app state) before calling `/api/strategy-recommend` and returning early.

**Why bad:** The API response contains the authoritative `regime.ivRank` used to compute the gate. Client-side IV data may be stale. Blocking means the user sees no data and no explanation.

**Instead:** Let the API run. Gate rendering of recommendation cards based on the API response's `regime.ivRank`.

### Anti-Pattern 3: Duplicating Strategy Profile Data

**What:** Copying `profitTarget`, `ivRankMin`, `dteMin`/`dteMax` values into API route constants separate from `strategyProfiles.ts`.

**Why bad:** Creates sync bugs. `lib/_shared/scoring.cjs` already has the precedent — keeping two sources in sync requires test coverage.

**Instead:** `api/strategy-recommend.js` already reads `strategy` param and applies it. The DTE sigma and default width are the only strategy-specific values in the API; keep them as inline constants keyed on the `strategy` param string (as the existing draft plan specifies).

### Anti-Pattern 4: Writing TP as a Percentage

**What:** Storing `target_price` as a fraction (0.30) instead of an absolute price.

**Why bad:** The `positions` table `target_price` column stores absolute prices (same field used by `useUpdateTarget` mutation). Storing a percentage breaks the Portfolio page's display logic.

**Instead:** Compute absolute TP at write time: `target_price = entry_price * (1 - profile.profitTarget)`.

---

## Build Order (Phase Dependencies)

The features have a natural dependency order derived from shared data contracts:

### Phase 1: Type + DB Write Path (unblocks everything else)

**Changes:**
- Add `target_price?: number` to `DirectAddItem` interface (`src/lib/types.ts`)
- Write `target_price` in `useAddDirect` mutation (`src/hooks/usePositionMutations.ts`)

**Why first:** Auto-fill TP depends on this. Nothing else can write TP until the type + mutation support it.

**Test impact:** Low — adding optional field to interface, adding one column write to mutation. Existing 488 tests unaffected.

### Phase 2: Signal Context URL Params (producer side)

**Changes:**
- Signals CTA buttons include `score`, `signal`, `streak` in `navigate()` URL

**Why second:** Does not depend on Phase 1. Can be done in parallel, but logically the producer change should precede consumer testing.

**Test impact:** None — UI navigation change, no logic change.

### Phase 3: Spread Builder Reads Context + IV Gate + TP Auto-Fill (consumer side)

**Changes:**
- `StrategyRecommender.tsx` reads `score`, `signal`, `streak` from `useSearchParams`
- Renders `SignalContextBanner` when URL params are present
- After API response: checks `ivGated` condition, renders gate UI if triggered
- In open-position form: computes `target_price` from `openPosPrice × (1 - profile.profitTarget)`, passes to `useAddDirect`

**Why third:** Depends on Phase 1 (type change) and Phase 2 (URL params are the input). All three changes are in `StrategyRecommender.tsx` — bundle them.

**Test impact:** Medium — new rendering paths in StrategyRecommender. Integration tests for the IV gate condition.

### Phase 4: Global Strategy Toggle

**Changes:**
- Add strategy toggle to `AppLayout.tsx` header

**Why last:** Independent of all other phases — `activeStrategy` in context already works. Placing it last means all the pages it affects (Scanner, Recommender, Portfolio) have already been verified working with the strategy-aware values.

**Test impact:** None — rendering addition only.

---

## Scalability Considerations

| Concern | Current (2 strategies) | If more strategies added |
|---------|----------------------|--------------------------|
| `STRATEGY_PROFILES` map | 2 keys, flat object | Add key per strategy — zero structural change |
| URL param length | 6-7 params, ~80 chars | Acceptable up to ~15 params before considering a redirect-with-state pattern |
| IV gate threshold per strategy | `profile.ivRankMin` | Already per-profile — no change needed |
| API `strategy` param | String switch on 2 values | Add cases — no structural change |

---

## Sources

All findings are HIGH confidence — derived from direct source code analysis:

- `src/lib/strategyProfiles.ts` — complete StrategyProfile interface and STRATEGY_PROFILES constants
- `src/context/AppSettingsContext.tsx` — activeStrategy state management, localStorage persistence
- `src/pages/Signals.tsx` — DashboardRow, CTA navigate() calls, signal data structure
- `src/pages/StrategyRecommender.tsx` — useSearchParams usage, handleAnalyze, DirectAddItem construction, openPosPrice form
- `src/hooks/usePositionMutations.ts` — useAddDirect mutation, positions DB write
- `src/lib/types.ts` — Position, DirectAddItem, WatchlistItem interfaces
- `api/strategy-recommend.js` — strategy param consumption, StrategyResult shape
- `.planning/PROJECT.md` — milestone requirements and constraints
- `docs/superpowers/plans/2026-03-13-short-dte-platform-integration.md` — prior draft plan (partially implemented)
