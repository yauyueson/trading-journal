# Phase 2: Data Contract + API Foundation — Research

**Researched:** 2026-03-14
**Domain:** TypeScript type contracts, React Router v6 URL params, Vercel API route param handling, Supabase mutation patterns
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Signal URL params:**
- Signals page CTA passes ALL available signal metadata: score, direction, streak, signalType, adxValue, rvol, iv30d
- signalType hardcoded as 'EMA' for now — extend when MOM signals are added
- URL format: `/selector?ticker=TSLA&direction=BULL&strategy=swing&score=95&streak=3&signalType=EMA&adx=28&rvol=1.2&iv30d=0.35`
- These params are read-only context — they inform the banner in Phase 3, not the scoring

**API strategy behavior:**
- strategy-recommend.js returns `profitTarget` and `ivRankMin` in the API response alongside regime data — frontend reads from API, not from strategyProfiles import
- DTE Gaussian sigma derived internally from strategy param (swing σ=15, shortTerm σ=5) — no extra API param
- API adjusts dtePeak, defaultWidth, deltaRange per strategy profile
- Include `strategy` in the response context object so frontend knows which profile was used

**target_price write path:**
- Store target_price as PERCENTAGE (e.g., 0.30 for swing 30%, 0.40 for shortTerm 40%) — not absolute dollar
- Compute absolute target at display time from entry_price and stored percentage
- TP auto-fill computed from actual fill price the user enters, not from recommendation credit — TP field updates reactively as the user types their fill price
- Add `target_price` field to DirectAddItem interface and write it in useAddDirect mutation

### Claude's Discretion

- Exact URL param encoding (whether to use short names like `adx` vs `adxValue`)
- Whether to add a helper function for parsing signal params from URL
- How to handle the reactive TP computation in the open-position form (debounce, immediate, etc.)

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| EXIT-02 | target_price field added to DirectAddItem type and written by useAddDirect mutation | DirectAddItem interface at types.ts:125 needs `target_price?: number`; useAddDirect insert object at mutations.ts:100 needs the field; spread_width has same gap and same fix pattern |
| STRAT-01 | strategy-recommend.js accepts `strategy` query param and uses profile-specific dtePeak, DTE sigma, defaultWidth, and deltaRange | API already reads `strategy` param (line 1106) and maps to STRATEGY_DEFAULTS; missing pieces are: (a) return profitTarget/ivRankMin/strategy in response, (b) pass strategyDefaults.defaultWidth as default for widthParam |
| STRAT-02 | scan-options.js accepts `strategy` query param and adjusts DTE/delta defaults per profile | API currently only reads `activeProfile` param; needs to also accept `strategy` param (or treat them as the same), then adjust delta defaults per profile |
| SIG-01 | Signals page CTA passes signal metadata (signalType, score, direction, streak, adxValue, rvol) as URL params when navigating to spread builder | CTAs at Signals.tsx:706 and :712 need navigate() calls extended with all metadata fields; all data is already available on the `row` object (DashboardRow) |
</phase_requirements>

---

## Summary

Phase 2 is pure plumbing: three files need surgical edits to wire up data that already exists in memory/context but is not yet flowing through the system. No new infrastructure, no new state management, no new API calls.

The four requirements break into three distinct work streams: (1) add `target_price` to the TypeScript type and the Supabase insert, (2) enrich the two navigate() calls in Signals.tsx with the full signal metadata already available on `row`, (3) make strategy-recommend.js echo back `profitTarget`/`ivRankMin`/`strategy` in its response, and make scan-options.js respond to profile-specific delta defaults.

All data sources exist. The `DashboardRow` type already carries `score`, `streak`, `adx`, `rvol`, `iv30`; `STRATEGY_PROFILES` already defines `profitTarget` and `ivRankMin`; `strategy-recommend.js` already reads the `strategy` param and branches on `STRATEGY_DEFAULTS`. This phase connects them.

**Primary recommendation:** Read the code carefully before editing — the API already does more strategy-branching than it appears (line 1106+), and the type already has `target_price?: number` on `Position` but NOT on `DirectAddItem`. Surgical, targeted edits.

---

## Standard Stack

### Core
| Library/Pattern | Version/Location | Purpose | Why Standard |
|-----------------|------------------|---------|--------------|
| React Router v6 `useSearchParams` | `react-router-dom` v6 (already in use) | Read URL params in spread builder (Phase 3) | Established pattern in codebase |
| React Router `navigate()` | already used in Signals.tsx | Encode signal metadata into URL | Established pattern (lines 706, 712) |
| TypeScript interface extension | `src/lib/types.ts` | Add `target_price` to DirectAddItem | Existing pattern for all fields |
| Supabase `.insert()` | `src/hooks/usePositionMutations.ts` | Write target_price to positions table | 11 mutations all use this pattern |
| Vercel `req.query.*` destructuring | `api/strategy-recommend.js` | Read/return strategy profile data | Established API pattern |

### Supporting
| Library | Location | Purpose | When to Use |
|---------|----------|---------|-------------|
| `STRATEGY_PROFILES` / `getProfile()` | `src/lib/strategyProfiles.ts` | Single source of truth for profitTarget, ivRankMin, DTE, delta | Everywhere a strategy param is needed |
| `STRATEGY_DEFAULTS` (inline in API) | `api/strategy-recommend.js:324` | Mirror of STRATEGY_PROFILES for CJS API context | API can't import .ts files |

**Installation:** No new packages required.

---

## Architecture Patterns

### Pattern 1: Extending DirectAddItem and useAddDirect (EXIT-02)

**What:** Add `target_price?: number` to the `DirectAddItem` interface in `src/lib/types.ts`, then add `target_price: item.target_price ?? null` to the insert object in `useAddDirect` in `src/hooks/usePositionMutations.ts`.

**Note on gap:** `spread_width` is present in `DirectAddItem` at types.ts:147 but is NOT written in the useAddDirect insert (confirmed — no match in mutations.ts). While fixing target_price, also add `spread_width: item.spread_width ?? null` to the insert. This is the same bug pattern.

**Current state:**
```typescript
// src/lib/types.ts:125 — DirectAddItem does NOT have target_price
export interface DirectAddItem {
    ticker: string;
    // ... strategy_type?: 'swing' | 'shortTerm';  ← last field
}
```

```typescript
// src/hooks/usePositionMutations.ts:100 — useAddDirect does NOT write target_price or spread_width
await supabase.from('positions').insert([{
    // ... strategy_type: item.strategy_type || null,  ← last field in insert
}])
```

**Fix pattern:**
```typescript
// 1. types.ts — add to DirectAddItem
target_price?: number;  // stored as percentage (e.g., 0.30 = 30%)

// 2. usePositionMutations.ts — add to insert object
target_price: item.target_price ?? null,
spread_width: item.spread_width ?? null,  // fix same gap
```

**Source:** Direct code inspection of `src/lib/types.ts:125-150` and `src/hooks/usePositionMutations.ts:100-125`.

### Pattern 2: Signal URL Param Encoding (SIG-01)

**What:** The `navigate()` calls in `Signals.tsx` at lines 706 and 712 currently pass only `ticker`, `direction`, `strategy`. They need to pass the full signal metadata from the `row` object.

**Current state:**
```typescript
// Signals.tsx:706-712
navigate(`/selector?ticker=${row.ticker}&direction=${dir}&strategy=swing`);
navigate(`/selector?ticker=${row.ticker}&direction=${dir}&strategy=shortTerm`);
```

**DashboardRow already has all needed fields:**
```typescript
interface DashboardRow {
    ticker: string;
    score: number;       // EMA score (e.g., 95)
    direction: string;   // 'CALL' | 'PUT'
    streak: number;      // consecutive signal days
    adx: number;         // from debug.adx
    rvol: number;        // from debug.rvol
    iv30: number | null; // IV30 in decimal (e.g., 0.35)
    // ...
}
```

**Fix — extend navigate() calls:**
```typescript
// Short param names chosen for URL brevity (Claude's discretion)
const params = new URLSearchParams({
    ticker: row.ticker,
    direction: dir,
    strategy: 'swing',       // or 'shortTerm'
    score: String(Math.round(row.score)),
    streak: String(row.streak),
    signalType: 'EMA',
    adx: String(row.adx.toFixed(1)),
    rvol: String(row.rvol.toFixed(2)),
    ...(row.iv30 != null ? { iv30d: String(row.iv30.toFixed(4)) } : {}),
});
navigate(`/selector?${params.toString()}`);
```

**Recommendation for Claude's discretion items:**
- Use short param names (`adx`, `rvol`, `iv30d`) — less visual noise in URL, Phase 3 banner only needs to display them
- Add a `parseSignalParams(searchParams: URLSearchParams)` helper in `src/lib/signalParams.ts` — keeps Phase 3 clean, makes the contract testable
- No debounce needed for reactive TP — the TP computation is `entryPrice * profitTarget`, which is O(1) arithmetic; update immediately on change

### Pattern 3: API Response Enrichment — strategy-recommend.js (STRAT-01)

**What:** The API already reads `strategy` param and branches correctly. The missing piece is returning `profitTarget`, `ivRankMin`, and `strategy` in the response object so the frontend doesn't need to re-import `strategyProfiles.ts` to know what TP to autofill.

**Current API state:** `strategy-recommend.js` already has (lines 319-327):
```javascript
const STRATEGY_DEFAULTS = {
    swing: { dtePeak: 55, dteSigma: 15, deltaRange: [0.28, 0.42] },
    shortTerm: { dtePeak: 10, dteSigma: 5, deltaRange: [0.20, 0.40] },
};
```

And already reads (line 1107):
```javascript
const activeStrategy = (strategyParam === 'shortTerm') ? 'shortTerm' : 'swing';
const strategyDefaults = STRATEGY_DEFAULTS[activeStrategy];
```

**Missing in STRATEGY_DEFAULTS:** `profitTarget`, `ivRankMin`, `defaultWidth`. Add these to the inline `STRATEGY_DEFAULTS` object so they're available at response-build time.

**Addition to STRATEGY_DEFAULTS:**
```javascript
const STRATEGY_DEFAULTS = {
    swing: {
        dtePeak: 55, dteSigma: 15, deltaRange: [0.28, 0.42],
        defaultWidth: 15, profitTarget: 0.30, ivRankMin: 30,
    },
    shortTerm: {
        dtePeak: 10, dteSigma: 5, deltaRange: [0.20, 0.40],
        defaultWidth: 2.5, profitTarget: 0.40, ivRankMin: 40,
    },
};
```

**Addition to response JSON** (add alongside `context`/`regime` at line ~1944):
```javascript
strategyProfile: {
    strategy: activeStrategy,
    profitTarget: strategyDefaults.profitTarget,
    ivRankMin: strategyDefaults.ivRankMin,
    defaultWidth: strategyDefaults.defaultWidth,
},
```

**Note:** The `defaultWidth` in the API currently comes from `widthParam = parseInt(spreadWidth) || 15` hardcoded — that fallback should be `strategyDefaults.defaultWidth` for strategy-awareness.

### Pattern 4: scan-options.js Strategy-Aware Delta Defaults (STRAT-02)

**What:** `scan-options.js` already handles `activeProfile` for DTE defaults (line 47-48). It does NOT adjust delta defaults per profile. The `strategy = 'long'` param is the LOQ/CSQ toggle (long/short), not the strategy profile.

**Current state (confirmed):**
```javascript
const activeProfile = req.query.activeProfile === 'shortTerm' ? 'shortTerm' : 'swing';
const dteDefaults = activeProfile === 'shortTerm' ? { min: '5', max: '21' } : { min: '20', max: '60' };
const { strategy = 'long', dteMin = dteDefaults.min, dteMax = dteDefaults.max,
        minDelta = '0', maxDelta = '1', ... } = req.query;
```

**Fix:** Add profile-specific delta defaults. Shortterm has tighter delta range (0.20-0.40) vs swing (0.28-0.42).

```javascript
const deltaDefaults = activeProfile === 'shortTerm'
    ? { min: '0.20', max: '0.40' }
    : { min: '0.28', max: '0.42' };
const { ..., minDelta = deltaDefaults.min, maxDelta = deltaDefaults.max, ... } = req.query;
```

**Important:** `activeProfile` and `strategy` serve different purposes in scan-options.js:
- `activeProfile` = swing/shortTerm strategy profile (DTE, delta ranges) — Phase 1 param rename
- `strategy` = long/short (LOQ/CSQ scoring mode) — DO NOT overwrite or alias these

### Anti-Patterns to Avoid

- **Renaming `strategy` in scan-options.js:** The `strategy = 'long'` param in scan-options.js is the LOQ/CSQ direction toggle. Do NOT alias `strategy` to mean the profile — keep `activeProfile` for profile selection.
- **Importing strategyProfiles.ts in API files:** API routes are `.js` ESM, cannot import `.ts`. Use the inline `STRATEGY_DEFAULTS` object (which already mirrors strategyProfiles.ts values).
- **Writing absolute dollar TP to DB:** Decision is to store as decimal percentage (0.30, 0.40). Absolute dollar is computed at display time: `Math.round(entry_price * target_price * 100) / 100`.
- **Removing target_price from WatchlistItem:** `WatchlistItem` already has `target_price?: number | null` and is already written in `useAddToWatchlist`. Do not change that path — it works.
- **Breaking the 307 scoring parity tests:** These changes do not touch scoring functions, only API response shape and DB write path. Safe.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| URL encoding signal metadata | Custom serializer | `new URLSearchParams({...}).toString()` | Built-in, handles encoding, already used in Scanner.tsx |
| Parsing URL params in spread builder | Custom parser | `useSearchParams()` from react-router-dom v6 | Established pattern, already in use |
| Reactive TP computation | Debounced state machine | Inline expression in render: `(parseFloat(price) * profitTarget).toFixed(2)` | O(1) arithmetic, no async, no debounce needed |

---

## Common Pitfalls

### Pitfall 1: target_price Semantic Confusion
**What goes wrong:** Writing the recommendation credit (e.g., $3.00) as target_price instead of the percentage (0.30).
**Why it happens:** `StrategyRecommender.tsx:228` has `target_price: 0` as a stub — the actual fill price comes from `openPosPrice` typed by the user.
**How to avoid:** Compute at form submit time: `target_price: profile.profitTarget` (the decimal, e.g., 0.30). Do not use the `netCredit` from the recommendation.
**Warning signs:** `target_price` values > 1.0 in the DB mean absolute dollar was stored.

### Pitfall 2: spread_width Not Written by useAddDirect
**What goes wrong:** spread_width is in DirectAddItem and is set at StrategyRecommender.tsx:300, but the useAddDirect insert object does not include it (confirmed by grep). Same bug as target_price.
**Why it happens:** Field was added to the type but the insert was not updated.
**How to avoid:** Fix both fields together in the same task — `target_price` and `spread_width` in the insert.

### Pitfall 3: STRATEGY_DEFAULTS Drift from strategyProfiles.ts
**What goes wrong:** The inline `STRATEGY_DEFAULTS` in strategy-recommend.js diverges from `STRATEGY_PROFILES` in strategyProfiles.ts.
**Why it happens:** Two copies of the same data — one .ts (frontend), one inline .js (API).
**How to avoid:** When adding `profitTarget`/`ivRankMin`/`defaultWidth` to the API's STRATEGY_DEFAULTS, verify the values match strategyProfiles.ts exactly. Consider adding a comment: "// Must match src/lib/strategyProfiles.ts STRATEGY_PROFILES".

### Pitfall 4: DashboardRow.adx is Already a Number
**What goes wrong:** Assuming `row.adx` needs type coercion or might be undefined.
**Why it happens:** The debug object (`sig.result.debug?.adx as number ?? 0`) already resolves to 0 if missing.
**How to avoid:** Use `row.adx.toFixed(1)` directly in the navigate() call — no null check needed (already defaulted to 0 at line 277).

### Pitfall 5: iv30d Value Encoding
**What goes wrong:** Encoding iv30d as percentage (35) instead of decimal (0.35) or vice versa.
**Why it happens:** `DashboardRow.iv30` is the raw value from `useWatchlistIV` which returns the `iv30` from `ticker_iv_snapshots` — stored as a decimal (e.g., 0.35 = 35%).
**How to avoid:** Pass the raw value as-is. Phase 3 banner will need to multiply by 100 for display (35%). Document the encoding in the helper function.

---

## Code Examples

### Example 1: Complete navigate() call with signal metadata
```typescript
// Signals.tsx — replace lines 706-716 (both CTAs)
// Source: existing pattern at Scanner.tsx, extended with signal metadata
const buildParams = (strategyParam: string) => {
    const p = new URLSearchParams({
        ticker: row.ticker,
        direction: dir,
        strategy: strategyParam,
        score: String(Math.round(row.score)),
        streak: String(row.streak),
        signalType: 'EMA',
        adx: String(row.adx.toFixed(1)),
        rvol: String(row.rvol.toFixed(2)),
    });
    if (row.iv30 != null) p.set('iv30d', String(row.iv30.toFixed(4)));
    return p.toString();
};

// Swing CTA
navigate(`/selector?${buildParams('swing')}`);
// Short-Term CTA
navigate(`/selector?${buildParams('shortTerm')}`);
```

### Example 2: DirectAddItem target_price — set at form submit
```typescript
// StrategyRecommender.tsx — in the submit handler
// entry_price comes from openPosPrice typed by user
// profitTarget is decimal from profile (0.30 or 0.40)
const item: DirectAddItem = {
    // ... existing fields ...
    entry_price: parseFloat(openPosPrice) || 0,
    target_price: profile.profitTarget,  // e.g., 0.30 — stored as percentage
    spread_width: isSpread(rec) ? rec.width : undefined,  // fix existing gap
    strategy_type: activeStrategy,
};
```

### Example 3: API response strategyProfile shape
```javascript
// api/strategy-recommend.js — add to response JSON
return res.status(200).json({
    success: true,
    context: { ... },  // existing
    regime: { ... },   // existing
    strategyProfile: {       // NEW
        strategy: activeStrategy,            // 'swing' | 'shortTerm'
        profitTarget: strategyDefaults.profitTarget,  // 0.30 | 0.40
        ivRankMin: strategyDefaults.ivRankMin,        // 30 | 40
        defaultWidth: strategyDefaults.defaultWidth,  // 15 | 2.5
    },
    recommendedStrategy: decodedStrategy,
    strategies: { ... },  // existing
});
```

### Example 4: TP reactive display (Claude's discretion — immediate, no debounce)
```tsx
// StrategyRecommender.tsx — inside the open-position form
const fillPrice = parseFloat(openPosPrice) || 0;
const tpAbsolute = fillPrice > 0
    ? `$${(fillPrice * profile.profitTarget).toFixed(2)} (${Math.round(profile.profitTarget * 100)}% of $${fillPrice.toFixed(2)} credit)`
    : `${Math.round(profile.profitTarget * 100)}% of fill price`;

// Render near the entry_price field
<p className="text-xs text-text-tertiary mt-1">
    TP: {tpAbsolute}
</p>
```

---

## State of the Art

| Old Pattern | Current Pattern | Impact |
|-------------|-----------------|--------|
| `creditSpread.*` settings reads | `getProfile(activeStrategy).*` | Phase 1 completed; this phase builds on it |
| `target_price: 0` stub | `target_price: profile.profitTarget` | Phase 2 delivers this |
| Strategy-agnostic API (always swing defaults) | Strategy-aware API returns profitTarget/ivRankMin | Phase 2 STRAT-01 |

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.0.18 |
| Config file | `vitest.config.ts` (root) |
| Quick run command | `npx vitest run tests/data-contract.test.ts --passWithNoTests` |
| Full suite command | `npx vitest run --passWithNoTests` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| EXIT-02 | DirectAddItem has `target_price?: number` field | unit | `npx vitest run tests/data-contract.test.ts -t "EXIT-02"` | Wave 0 |
| EXIT-02 | useAddDirect insert includes target_price | unit (source inspection) | `npx vitest run tests/data-contract.test.ts -t "useAddDirect"` | Wave 0 |
| STRAT-01 | strategy-recommend.js STRATEGY_DEFAULTS has profitTarget/ivRankMin | unit (source inspection) | `npx vitest run tests/data-contract.test.ts -t "STRAT-01"` | Wave 0 |
| STRAT-02 | scan-options.js uses profile-aware delta defaults | unit (source inspection) | `npx vitest run tests/data-contract.test.ts -t "STRAT-02"` | Wave 0 |
| SIG-01 | Signals.tsx navigate() includes score/streak/signalType/adx/rvol | unit (source inspection) | `npx vitest run tests/data-contract.test.ts -t "SIG-01"` | Wave 0 |

**Sampling rate:**
- Per task commit: `npx vitest run tests/data-contract.test.ts --passWithNoTests`
- Per wave merge: `npx vitest run --passWithNoTests`
- Phase gate: Full suite (488 tests) green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/data-contract.test.ts` — covers EXIT-02, STRAT-01, STRAT-02, SIG-01 using source inspection pattern (same pattern as `tests/prerequisite-fixes.test.ts`)

The prerequisite-fixes.test.ts provides the exact test pattern to follow: read source files with `readFileSync`, assert presence/absence of specific strings, import TypeScript modules and assert field types.

---

## Open Questions

1. **StrategyResult TypeScript interface — add strategyProfile field?**
   - What we know: `StrategyResult` in `src/lib/types.ts:286` is the TypeScript type for the API response. It does not currently have a `strategyProfile` field.
   - What's unclear: Whether the planner should add `strategyProfile?: { strategy: string; profitTarget: number; ivRankMin: number; defaultWidth: number }` to StrategyResult, or leave the type loose.
   - Recommendation: Add it. The spread builder reads from the API response — type safety helps Phase 3.

2. **iv30d param — decimal vs percent in URL?**
   - What we know: `DashboardRow.iv30` is stored as decimal (e.g., 0.35). Phase 3 banner will display as percent (35%).
   - Recommendation: Store as decimal in URL, document the convention in the helper function.

---

## Sources

### Primary (HIGH confidence)
- Direct code inspection: `src/lib/types.ts` (DirectAddItem interface, lines 125-150)
- Direct code inspection: `src/hooks/usePositionMutations.ts` (useAddDirect insert object, lines 96-140)
- Direct code inspection: `api/strategy-recommend.js` (STRATEGY_DEFAULTS, handler params, response shape)
- Direct code inspection: `api/scan-options.js` (activeProfile handling, delta defaults)
- Direct code inspection: `src/pages/Signals.tsx` (DashboardRow type, navigate() calls, lines 702-718)
- Direct code inspection: `src/pages/StrategyRecommender.tsx` (DirectAddItem construction, lines 281-302)
- Direct code inspection: `src/lib/strategyProfiles.ts` (STRATEGY_PROFILES values)
- Direct code inspection: `tests/prerequisite-fixes.test.ts` (test pattern reference)

### Metadata

**Confidence breakdown:**
- Type contract changes: HIGH — exact current code verified by direct read
- API response changes: HIGH — exact current response shape verified at lines 1943-1958
- Signal URL params: HIGH — DashboardRow fields verified at Signals.tsx lines 276-298
- Test patterns: HIGH — prerequisite-fixes.test.ts provides exact template

**Research date:** 2026-03-14
**Valid until:** 2026-04-14 (stable codebase, no fast-moving dependencies)
