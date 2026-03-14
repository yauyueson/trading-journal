# Phase 4: Global Strategy Toggle - Research

**Researched:** 2026-03-14
**Domain:** React context propagation, strategy-aware UI components (Backtest.tsx, Stats.tsx)
**Confidence:** HIGH

## Summary

Phase 4 is a focused cleanup phase. STRAT-03 (global toggle in AppLayout header) was already shipped in a prior commit — the Swing/ST pill toggle at lines 39-51 of AppLayout.tsx reads `activeStrategy` from `AppSettingsContext` and calls `setActiveStrategy`. No work remains there.

The remaining work is entirely STRAT-04: two files have hardcoded strategy text that should be driven by `getProfile(activeStrategy)`. In `Backtest.tsx`, the page manages its own local `strategy: StrategyMode` state (`'swing' | 'short'`) that is completely isolated from `activeStrategy` in context — it needs to be replaced with a `useEffect` sync or direct derivation from context. In `Stats.tsx`, the DTE bucket boundaries at line 179 are hardcoded to swing-specific thresholds (`<30d / 30-45d / 45-65d / 65+d`) and need to become strategy-aware.

The established pattern throughout the codebase is: `useAppSettings()` → `activeStrategy` → `getProfile(activeStrategy).{property}`. All other pages (Scanner, StrategyRecommender, Portfolio, Signals) already follow this pattern. This phase just brings the two remaining outliers into conformance.

**Primary recommendation:** Replace `Backtest.tsx`'s local `strategy` state with a derived value from `useAppSettings().activeStrategy`, mapping `'shortTerm'` → `'short'` for `isShort` logic. Replace `Stats.tsx`'s hardcoded DTE bucket assignment with a helper that reads `getProfile(activeStrategy).dteMin/dteMax`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- STRAT-03 is already done — AppLayout.tsx lines 39-51 has the working toggle; no new work
- Backtest.tsx hardcoded strings (lines 313, 326, 427, 513, 729) → read from `getProfile(activeStrategy).label` / profile properties
- Backtest page's own `isShort` toggle should sync with global `activeStrategy`
- Stats.tsx DTE buckets: swing keeps `<30d / 30-45d / 45-65d / 65+d`; shortTerm uses `<5d / 5-10d / 10-14d / 14+d` (matching 7-14 DTE sweet spot); derive bucket boundaries from strategy profile DTE range

### Claude's Discretion
- Exact bucket breakpoints for shortTerm DTE stats
- Whether the Backtest page's internal swing/short toggle should be removed in favor of the global one
- Any other pages with hardcoded strategy text found during implementation

### Deferred Ideas (OUT OF SCOPE)
- Remove Scanner page entirely (noted in Phase 1)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| STRAT-03 | Global strategy toggle accessible within spread builder flow (in AppLayout header or selector page header) | ALREADY IMPLEMENTED — AppLayout.tsx lines 39-51. No implementation needed. |
| STRAT-04 | All page subtitles and DTE/width/delta defaults react to active strategy selection | Two files need changes: Backtest.tsx (local `strategy` state + hardcoded label/subtitle strings) and Stats.tsx (hardcoded DTE bucket thresholds at line 179 and bucket sort order at line 381). Pattern from Scanner/StrategyRecommender/Signals pages applies directly. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| React | 18 | Component rendering | Project baseline |
| `useAppSettings()` hook | project-local | Access `activeStrategy` + `setActiveStrategy` from `AppSettingsContext` | Established in all other strategy-aware pages |
| `getProfile(activeStrategy)` | `src/lib/strategyProfiles.ts` | Derive all strategy-specific params from single source of truth | Enforced by prior phase decisions; avoids duplication |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `STRATEGY_PROFILES` constant | `src/lib/strategyProfiles.ts` | Iterate over all strategy types for badge rendering | When rendering both strategies side-by-side |
| `StrategyType` type | `src/lib/strategyProfiles.ts` | TypeScript type for `'swing' | 'shortTerm'` | All strategy-typed variables |

**No new packages required.** This phase adds zero dependencies.

## Architecture Patterns

### Established Pattern: Strategy-Aware Page

Every strategy-aware page follows the same three-line pattern at the top of its component:

```typescript
// Source: src/pages/StrategyRecommender.tsx, src/pages/Signals.tsx, src/pages/Scanner.tsx
const { activeStrategy } = useAppSettings();
const profile = getProfile(activeStrategy);
// Then use profile.dteMin, profile.dteMax, profile.subtitle, profile.label, etc.
```

### Pattern 1: Backtest.tsx — Replace Local State with Context-Driven Derivation

**What:** `BacktestPage` currently declares `const [strategy, setStrategy] = useState<StrategyMode>('swing')` and `const isShort = strategy === 'short'`. This is isolated from the global `activeStrategy`.

**Current state (lines 217, 224):**
```typescript
// Backtest.tsx — current (to be replaced)
const [strategy, setStrategy] = useState<StrategyMode>('swing');
const isShort = strategy === 'short';
```

**Target state:**
```typescript
// Backtest.tsx — target
const { activeStrategy } = useAppSettings();
const isShort = activeStrategy === 'shortTerm';
// StrategyMode local type becomes unnecessary; remove it or map at activeData selection
```

The `handleStrategyChange` function and the inline toggle UI (lines 311-318) become either removed (global toggle replaces them) or kept as an override. Claude's discretion: remove the inline toggle to avoid two sources of truth.

**Hardcoded strings to replace:**

| Line | Hardcoded | Replace With |
|------|-----------|--------------|
| 313 | `'Swing (45-65 DTE)'` button label | `getProfile('swing').label` / `getProfile('shortTerm').label` |
| 326 | `'DTE 45-65 · $15 width · Delta 0.35 · TP 30%'` subtitle | `getProfile(activeStrategy).subtitle` |
| 427 | `'Delta 0.35 · $15 width · DTE 45-65 · no stop loss...'` table footnote | `getProfile(activeStrategy).subtitle` or constructed from profile props |
| 513 | `'Exit: TP 30%'` in score tier description | `${Math.round(getProfile('swing').profitTarget * 100)}%` |
| 729 | `'TP 30% (std30) is the best exit'` key finding | Static prose — leave as-is (this is historical WFA narrative, not a UI param) |

**Note on line 729:** That text is a WFA key-finding narrative paragraph, not a parameterized UI label. It describes the historical backtest result. Leave it hardcoded — changing it would be misleading if the strategy switches to shortTerm (40% TP). Line 513 is similar context.

**activeData selection** currently uses `isShort ? wfaShortData : wfaData`. This mapping stays the same; `isShort` is just derived differently.

### Pattern 2: Stats.tsx — Strategy-Aware DTE Buckets

**What:** Line 179 in `Stats.tsx` hardcodes the DTE bucket assignment inside `useMemo`. The sort order at line 381 also hardcodes the bucket key array. Both must be strategy-aware.

**Current state (line 179):**
```typescript
// Stats.tsx — current (to be replaced)
const dteBucket = dte < 30 ? '<30d' : dte < 45 ? '30-45d' : dte < 65 ? '45-65d' : '65+d';
```

**Strategy profile reference values:**
- `swing`: `dteMin=45, dteMax=65` → buckets: `<30d / 30-45d / 45-65d / 65+d`
- `shortTerm`: `dteMin=7, dteMax=14` → buckets: `<5d / 5-10d / 10-14d / 14+d`

**Target pattern:**

```typescript
// Stats.tsx — target
const { activeStrategy } = useAppSettings();
const profile = getProfile(activeStrategy);

// DTE bucket helper (inside useMemo or extracted above it)
const getDteBucket = (dte: number): string => {
    if (activeStrategy === 'shortTerm') {
        return dte < 5 ? '<5d' : dte < 10 ? '5-10d' : dte < 14 ? '10-14d' : '14+d';
    }
    // swing (default)
    return dte < 30 ? '<30d' : dte < 45 ? '30-45d' : dte < 65 ? '45-65d' : '65+d';
};
```

**Sort order array** at line 381 also needs to be strategy-conditional:
```typescript
// Current (swing only):
const order = ['<30d', '30-45d', '45-65d', '65+d'];

// Target:
const order = activeStrategy === 'shortTerm'
    ? ['<5d', '5-10d', '10-14d', '14+d']
    : ['<30d', '30-45d', '45-65d', '65+d'];
```

**Important:** `getDteBucket` is called inside the `useMemo` that depends on `[closedPositions, transactions]`. Since `activeStrategy` now affects bucket assignment, it must be added to the `useMemo` dependency array. Failing to do this is the primary pitfall for this task.

### Anti-Patterns to Avoid

- **Duplicating profile values in component:** Don't write `dte < 7` when you can derive `profile.dteMin`. The breakpoints for shortTerm were chosen as `<5d / 5-10d / 10-14d / 14+d` in the CONTEXT.md decisions. Use those exact values since they are locked decisions.
- **Two sources of truth for Backtest strategy:** Keeping both local `strategy` state and reading `activeStrategy` from context will cause them to diverge. Remove the local state.
- **Forgetting `activeStrategy` in useMemo deps:** If `getDteBucket` logic reads `activeStrategy` but the `useMemo` doesn't list it as a dependency, the DTE stats will not recompute when the strategy switches.
- **Modifying scoring functions:** CLAUDE.md is explicit: `src/lib/oss-core.ts` and `lib/_shared/scoring.cjs` must never have UI-layer concerns added. IVR-04 test enforces no `ivRankMin` in scoring. DTE buckets are a display concern — do not touch scoring files.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Strategy label strings | Custom label logic | `STRATEGY_PROFILES[s].label` / `.shortLabel` / `.subtitle` | Already defined and used in AppLayout, Scanner, StrategyRecommender |
| DTE range constants | Inline magic numbers | `getProfile(activeStrategy).dteMin` / `.dteMax` | Single source of truth enforced by Phase 1 PRE-03 decision |
| Profile-specific defaults | Any new constants | `getProfile(activeStrategy).profitTarget` / `.defaultWidth` / `.defaultDelta` | Same pattern enforced across all prior phases |

## Common Pitfalls

### Pitfall 1: `StrategyMode` type mismatch (`'short'` vs `'shortTerm'`)
**What goes wrong:** `Backtest.tsx` uses `StrategyMode = 'swing' | 'short'` while `AppSettingsContext` uses `StrategyType = 'swing' | 'shortTerm'`. If you compare `activeStrategy === 'short'` it will always be false.
**Why it happens:** The Backtest page predates the unified `StrategyType` definition and used its own local type.
**How to avoid:** Derive `isShort` as `activeStrategy === 'shortTerm'`. Delete the local `StrategyMode` type once no longer used.
**Warning signs:** TypeScript will not catch this — `'short'` is a valid string literal, it just never matches `'shortTerm'`.

### Pitfall 2: Missing `activeStrategy` in `useMemo` dependency array (Stats.tsx)
**What goes wrong:** DTE buckets show swing ranges even when shortTerm is active, because `useMemo` returns a cached result.
**Why it happens:** `closedPositions` and `transactions` are the original deps; `activeStrategy` was not a factor before this phase.
**How to avoid:** Update `useMemo` deps from `[closedPositions, transactions]` to `[closedPositions, transactions, activeStrategy]`.
**Warning signs:** Switching strategy in the header does not change the DTE bucket labels in the Breakdowns tab.

### Pitfall 3: Removing the Backtest inline toggle breaks `wfaShortData` selection
**What goes wrong:** If you remove `setStrategy` and the toggle, `isShort` is no longer settable, so users can't switch the Backtest viewer.
**Why it happens:** The `activeData` selection (`isShort ? wfaShortData : wfaData`) is the core logic of the Backtest viewer.
**How to avoid:** `isShort` should be derived from `activeStrategy === 'shortTerm'`, not from local state. The global header toggle then controls which WFA dataset is shown. This is the intended final state.
**Warning signs:** The Backtest page always shows swing data regardless of the header toggle.

### Pitfall 4: Treating line 729 (`'TP 30% (std30)'` key finding) as dynamic UI text
**What goes wrong:** Replacing the WFA narrative with profile-driven text would make it factually wrong when `activeStrategy === 'shortTerm'` (shortTerm uses 40% TP, but the swing WFA analysis data at line 729 is swing-specific).
**Why it happens:** The text appears to be a "hardcoded value" but it is a historical analysis result, not a UI param.
**How to avoid:** Leave line 729 (and line 513) unchanged. These are WFA analysis descriptions, not strategy-parameter labels.

## Code Examples

### Reading `activeStrategy` in a page component
```typescript
// Source: src/pages/StrategyRecommender.tsx (established pattern)
import { useAppSettings } from '../context/AppSettingsContext';
import { getProfile } from '../lib/strategyProfiles';

const { activeStrategy } = useAppSettings();
const profile = getProfile(activeStrategy);
// profile.label, profile.subtitle, profile.dteMin, profile.dteMax, profile.profitTarget, etc.
```

### Backtest.tsx: `isShort` from context (no local state)
```typescript
// Source: derived from AppLayout.tsx pattern
import { useAppSettings } from '../context/AppSettingsContext';

export const BacktestPage: React.FC = () => {
    const { activeStrategy } = useAppSettings();
    const isShort = activeStrategy === 'shortTerm';
    const activeData = isShort ? wfaShortData : wfaData;
    // ... rest unchanged
};
```

### Stats.tsx: strategy-aware DTE bucket assignment
```typescript
// Inside Stats.tsx useMemo, replacing line 179
const dteBucket = activeStrategy === 'shortTerm'
    ? (dte < 5 ? '<5d' : dte < 10 ? '5-10d' : dte < 14 ? '10-14d' : '14+d')
    : (dte < 30 ? '<30d' : dte < 45 ? '30-45d' : dte < 65 ? '45-65d' : '65+d');
```

### Stats.tsx: strategy-aware sort order (replacing line 381)
```typescript
const order = activeStrategy === 'shortTerm'
    ? ['<5d', '5-10d', '10-14d', '14+d']
    : ['<30d', '30-45d', '45-65d', '65+d'];
```

### `strategyProfiles.ts` profile properties available (reference)
```typescript
// Source: src/lib/strategyProfiles.ts
swing: {
  label: 'Swing (45-65 DTE)',
  shortLabel: 'Swing',
  subtitle: 'Delta 0.35 • DTE 45-65 • $15 width • TP 30% • No SL',
  dteMin: 45, dteMax: 65, dtePeak: 55,
  defaultDelta: 0.35, defaultWidth: 15, profitTarget: 0.30,
}
shortTerm: {
  label: 'Short-Term (7-14 DTE)',
  shortLabel: 'ST',
  subtitle: 'Delta 0.40 • DTE 7-14 • $2.5 width • TP 40% • No SL',
  dteMin: 7, dteMax: 14, dtePeak: 10,
  defaultDelta: 0.40, defaultWidth: 2.5, profitTarget: 0.40,
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Backtest local `strategy` state | Derive `isShort` from global `activeStrategy` | Phase 4 (this phase) | One source of truth; header toggle controls Backtest viewer |
| Stats hardcoded DTE buckets | Strategy-aware bucket helper | Phase 4 (this phase) | DTE breakdown tab reflects active strategy's DTE range |
| Individual page toggle UI | AppLayout header pill toggle | Prior commit (STRAT-03) | Already done; Backtest's inline toggle becomes redundant |

## Open Questions

1. **Should Backtest's inline swing/short toggle be hidden or removed?**
   - What we know: It currently works independently of global context. Removing it simplifies the page (one control point). Keeping it allows page-level override.
   - What's unclear: Whether users expect per-page overrides or always-global behavior.
   - Recommendation: Remove the inline toggle (lines 311-318) — the CONTEXT.md decision says "make it sync with the global activeStrategy", which implies the inline toggle is no longer needed once global context drives it. This is Claude's discretion per CONTEXT.md.

2. **Are there other hardcoded strategy strings beyond the five listed lines?**
   - What we know: CONTEXT.md identifies lines 313, 326, 427, 513, 729 as targets. Lines 513 and 729 are WFA narrative text.
   - What's unclear: Whether any other Backtest subtitle/badge text has hardcoded strategy names.
   - Recommendation: Audit Backtest.tsx during implementation for any additional `'45-65'`, `'DTE'`, `'$15'`, `'30%'` occurrences that are display params (not WFA narrative).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (project standard) |
| Config file | `vite.config.ts` (Vitest configured inline) |
| Quick run command | `npx vitest run tests/data-contract.test.ts --passWithNoTests` |
| Full suite command | `npm test` (488 tests) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| STRAT-03 | Toggle in AppLayout header renders both strategies | source-inspection | `npx vitest run tests/data-contract.test.ts` | N/A — already implemented, no new test needed |
| STRAT-04 | Backtest.tsx: `isShort` derived from `activeStrategy` (not local state) | source-inspection | `npx vitest run tests/data-contract.test.ts` | ❌ Wave 0 — add contract tests |
| STRAT-04 | Stats.tsx: DTE bucket logic reads `activeStrategy` | source-inspection | `npx vitest run tests/data-contract.test.ts` | ❌ Wave 0 — add contract tests |
| STRAT-04 | Stats.tsx: shortTerm DTE bucket sort order uses `['<5d', '5-10d', '10-14d', '14+d']` | source-inspection | `npx vitest run tests/data-contract.test.ts` | ❌ Wave 0 — add contract tests |

The established test pattern (Phases 1-3) uses `readFileSync` source inspection in `tests/data-contract.test.ts`. Phase 4 tests should follow this pattern: read `src/pages/Backtest.tsx` and `src/pages/Stats.tsx` and assert the absence of hardcoded strings / presence of profile-driven patterns.

### Sampling Rate
- **Per task commit:** `npx vitest run tests/data-contract.test.ts --passWithNoTests`
- **Per wave merge:** `npm test` (full 488-test suite)
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/data-contract.test.ts` — add STRAT-03 and STRAT-04 assertions (Backtest context derivation, Stats DTE bucket strategy-awareness). Extend existing file; do not create a new test file.

## Sources

### Primary (HIGH confidence)
- Direct code inspection of `src/pages/Backtest.tsx` — local `strategy` state, `isShort`, inline toggle, hardcoded strings at lines 313, 326, 427, 513, 729
- Direct code inspection of `src/pages/Stats.tsx` — hardcoded DTE buckets at lines 179 and 381
- Direct code inspection of `src/layouts/AppLayout.tsx` — confirms STRAT-03 is fully implemented at lines 39-51
- Direct code inspection of `src/lib/strategyProfiles.ts` — all profile properties available via `getProfile()`
- Direct code inspection of `src/context/AppSettingsContext.tsx` — `activeStrategy` / `setActiveStrategy` contract
- Direct code inspection of `tests/data-contract.test.ts` — established source-inspection test pattern for phases 1-3
- `.planning/phases/04-global-strategy-toggle/04-CONTEXT.md` — locked decisions and discretion areas

### Secondary (MEDIUM confidence)
- Pattern generalization from Scanner.tsx, StrategyRecommender.tsx, Signals.tsx — all use `useAppSettings()` + `getProfile()` in identical manner

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries are already in the project, zero new dependencies
- Architecture: HIGH — exact lines identified, exact replacement patterns confirmed from live code
- Pitfalls: HIGH — `StrategyMode` vs `StrategyType` mismatch verified directly in source; useMemo dep issue is standard React behavior

**Research date:** 2026-03-14
**Valid until:** 2026-04-14 (codebase is stable; no external API dependencies in this phase)
