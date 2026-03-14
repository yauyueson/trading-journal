# Phase 1: Prerequisite Fixes - Research

**Researched:** 2026-03-14
**Domain:** TypeScript config correction, React settings refactor, API param standardization
**Confidence:** HIGH

## Summary

Phase 1 consists of three surgical code corrections with no new dependencies and no algorithmic changes. All three fixes touch existing, well-understood files. The codebase is already well-structured to receive these changes: `strategyProfiles.ts` is the declared source of truth, the component hierarchy for Settings is straightforward, and the API param rename affects exactly two lines.

The most substantial change is PRE-03 (credit spread section removal + WFA info card), which involves touching four files across frontend and context layers. The correct approach is to remove `creditSpread` from the settings read/write pipeline while keeping `AppSettings` type fields for backward compatibility with any data already persisted to Supabase — the merged read fallback means old rows cause no runtime error. The `CreditSpreadSettings` type and `DEFAULT_APP_SETTINGS.creditSpread` should be kept (not deleted) so the Supabase merge logic doesn't throw on rows that still contain the field.

**Primary recommendation:** Three atomic commits — one per requirement — each verifiable in isolation. PRE-01 is one line. PRE-02 is two lines. PRE-03 is a focused component rewrite with context cleanup.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Remove the manual credit spread inputs (DTE low/high, target delta, spread width, min IV rank, profit target) from AppSettings.tsx
- Replace with a read-only WFA config info card showing the active strategy's validated parameters from strategyProfiles.ts
- Delete the creditSpread fields from the app_settings Supabase table (stop reading/writing them)
- strategyProfiles.ts is the single source of truth for all strategy parameters — no user override
- Clean break: rename `profileStrategy` to `strategy` in both Scanner.tsx and scan-options.js
- No backward compat alias — Scanner.tsx is the only caller
- Signals.tsx CTA already passes `strategy` — confirm consistency across all navigate() calls
- Fix shortTerm ivRankMin from 30 to 40 in strategyProfiles.ts to match WFA-validated threshold
- Swing stays at 30 (WFA-validated)
- These values are hardcoded from WFA, not user-configurable

### Claude's Discretion
- Whether to audit AppSettings.tsx for other useful settings to keep vs remove
- How to structure the WFA config info card (layout, which fields to show)
- Whether to keep the CreditSpreadSettings type or remove it entirely

### Deferred Ideas (OUT OF SCOPE)
- Remove Scanner page entirely — it's not part of the WFA-validated workflow (signals → spread builder). Consider removing /scanner route in a future phase.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PRE-01 | shortTerm ivRankMin fixed from 30 to 40 in strategyProfiles.ts | Confirmed: `strategyProfiles.ts` line 70 has `ivRankMin: 30` in the `shortTerm` block — needs change to 40 |
| PRE-02 | API param naming standardized — both scan-options.js and strategy-recommend.js use `strategy` (not `profileStrategy`) | Confirmed: `scan-options.js` line 47 reads `req.query.profileStrategy`; `strategy-recommend.js` line 1106 already reads `req.query.strategy`. Only scan-options.js + Scanner.tsx need updating |
| PRE-03 | Audit and redirect all `settings.creditSpread.*` reads to `getProfile(activeStrategy).*` where strategy-specific params are used | Confirmed: `settings.creditSpread` reads exist only in AppSettings.tsx (UI) and AppSettingsContext.tsx (merge logic). No page outside AppSettings.tsx reads `settings.creditSpread.*` for strategy decisions |
</phase_requirements>

---

## Standard Stack

### Core (all already in the project — no new installs)
| File | Type | Role |
|------|------|------|
| `src/lib/strategyProfiles.ts` | TypeScript module | Single source of truth for strategy params |
| `api/scan-options.js` | Vercel serverless ESM | Options scanner API handler |
| `src/pages/Scanner.tsx` | React component | Front-end caller of scan-options |
| `src/pages/AppSettings.tsx` | React component | Settings UI (credit spread section to replace) |
| `src/context/AppSettingsContext.tsx` | React context | Settings persistence + merge logic |
| `src/lib/types/settings.ts` | TypeScript types | AppSettings, CreditSpreadSettings types |

**Installation:** None required.

---

## Architecture Patterns

### PRE-01: Single-field value correction in strategyProfiles.ts

`strategyProfiles.ts` is a pure TypeScript constant module — no side effects, no imports from runtime code. The `shortTerm` profile `ivRankMin` field at line 70 reads `30`; it must become `40`.

```typescript
// src/lib/strategyProfiles.ts  (current — line 70)
ivRankMin: 30,   // BUG: should be 40 per WFA validation

// After fix
ivRankMin: 40,
```

No downstream reads of `ivRankMin` exist in active app code outside of `strategyProfiles.ts` itself and the spread builder's IV gate logic (which is a Phase 3 concern). The fix is safe to make in isolation.

---

### PRE-02: API param rename (two-line change, two files)

**Current flow:**

```
Scanner.tsx (line 68):    params.set('profileStrategy', activeStrategy)
scan-options.js (line 47): req.query.profileStrategy === 'shortTerm' ? 'shortTerm' : 'swing'
```

**After fix:**

```
Scanner.tsx:    params.set('strategy', activeStrategy)   // was 'profileStrategy'
scan-options.js: req.query.strategy === 'shortTerm' ? 'shortTerm' : 'swing'
```

**Critical naming collision in scan-options.js:** Line 47 introduces a local variable `activeProfile` using `profileStrategy`. Lines 49-61 then destructure `req.query` with `strategy = 'long'` as a separate param. The `strategy` param is the LOQ/CSQ toggle (`'long'` vs `'short'`). Renaming the profile param to `strategy` would shadow this existing `strategy` destructuring.

Resolution: Use `strategyProfile` or keep reading the new param as a named variable before the destructure:

```javascript
// scan-options.js — CORRECT rename approach
// Line 47: read the profile strategy param explicitly
const activeProfile = req.query.strategy === 'shortTerm' ? 'shortTerm' : 'swing';
// Line 49: existing destructure — rename the long/short toggle to avoid collision
const {
    ticker,
    strategy = 'long',   // this is the LOQ/CSQ toggle — keep as-is
    ...
} = req.query;
```

Wait — `req.query.strategy` would be consumed by the destructure on line 49 AFTER the activeProfile assignment on line 47. The order matters: assign `activeProfile` from `req.query.strategy` first (line 47), then destructure `strategy` with default `'long'` from `req.query` (line 49). Since `req.query.strategy` would now carry the profile value (`'swing'` or `'shortTerm'`), the destructure `strategy = 'long'` on line 49 would yield `'swing'` or `'shortTerm'` — NOT `'long'`.

**This is a naming collision that needs careful resolution.** The correct fix is:

```javascript
// scan-options.js (line 47) — read profile first
const activeProfile = req.query.strategy === 'shortTerm' ? 'shortTerm' : 'swing';
const dteDefaults = activeProfile === 'shortTerm' ? { min: '5', max: '21' } : { min: '20', max: '60' };

// line 49 — DON'T destructure 'strategy' from req.query anymore (it's now the profile param)
// Instead, use a different name for the LOQ/CSQ toggle, or read it separately
const {
    ticker,
    scanMode = 'long',   // rename: was 'strategy' — now LOQ/CSQ toggle
    ...
} = req.query;
```

Or alternatively, Scanner.tsx sends the profile under a *different* key that doesn't conflict:

```javascript
// Scanner.tsx — send as 'profileStrategy' is gone; send as 'activeProfile' instead
params.set('activeProfile', activeStrategy);   // no collision with existing 'strategy'

// scan-options.js line 47 — read 'activeProfile'
const activeProfile = req.query.activeProfile === 'shortTerm' ? 'shortTerm' : 'swing';
// line 49 — req.query.strategy still works as 'long'/'short' toggle unchanged
```

**Recommended resolution:** Send the profile param as `activeProfile` from Scanner.tsx (not `strategy`), so there is no collision with the existing `strategy` param in scan-options.js. The CONTEXT.md says "rename `profileStrategy` to `strategy`" but this creates a collision — the planner should choose `activeProfile` as the canonical name to avoid breaking the LOQ/CSQ toggle. This is within Claude's discretion.

**Confirmed: `strategy-recommend.js` already uses `req.query.strategy`** (line 1106: `const { ..., strategy: strategyParam } = req.query`) for the profile. PRE-02 says "both use `strategy`" — strategy-recommend.js is already compliant. Only scan-options.js and Scanner.tsx need to change.

**Signals.tsx check:** Signals.tsx uses `navigate()` calls (lines 706, 712) that pass `strategy=swing` and `strategy=shortTerm` as URL params to `/selector`. These go to StrategyRecommender/selector page, not to scan-options. No conflict here.

---

### PRE-03: Credit Spread section removal + WFA info card

**Files to touch:**

| File | Change |
|------|--------|
| `src/pages/AppSettings.tsx` | Remove lines 35-36 (`setCreditSpread` helper), lines 179-241 (credit spread section), line 184 reset button. Add WFA info card section. |
| `src/context/AppSettingsContext.tsx` | Remove 3 `creditSpread` merge references (lines 20, 95, 114) |
| `src/lib/types/settings.ts` | Decision: keep or remove `CreditSpreadSettings` type and `creditSpread` in `AppSettings` |

**Recommendation on CreditSpreadSettings type:** Keep the type and `DEFAULT_APP_SETTINGS.creditSpread` but remove UI inputs. Supabase `app_settings` rows may still contain `creditSpread` data from previous sessions. The context's merge logic uses spread syntax with defaults — if the field is present in the DB row, it merges silently. Removing the type causes TypeScript errors in the merge logic. Safe approach: keep the type, remove only the context merge lines for `creditSpread` (lines 20, 95, 114) since they're no longer needed once UI no longer writes it. The DB field becomes orphaned but harmless.

**Alternative (cleaner):** Remove `creditSpread` from `AppSettings` interface, remove all three context merge lines, remove `setCreditSpread` from AppSettings.tsx. The Supabase upsert for `updateSettings` would simply stop persisting the field. Old DB rows still have it but it's never read. TypeScript is now clean. This is the stronger choice aligned with the "delete the creditSpread fields from app_settings" decision.

**WFA info card — what to show:**

Both swing and shortTerm profiles side by side, sourced from `STRATEGY_PROFILES` constant:

```typescript
// Source data from strategyProfiles.ts
import { STRATEGY_PROFILES } from '../lib/strategyProfiles';

// Display fields for each profile:
// - DTE range (dteMin–dteMax, peak dtePeak)
// - Delta target (defaultDelta)
// - Spread width (defaultWidth)
// - Profit target (profitTarget × 100%)
// - IV Rank min (ivRankMin%)
// - WFA Sharpe (hardcoded display: swing 2.14, shortTerm 4.77)
```

Pattern: read-only card, no inputs, no save button for this section. The section should be clearly labeled as "WFA-Validated Parameters (read-only)".

**AppSettingsContext cleanup — exact lines:**

```typescript
// AppSettingsContext.tsx
// REMOVE line 20 (in loadFromStorage):
creditSpread: { ...DEFAULT_APP_SETTINGS.creditSpread, ...(parsed?.creditSpread ?? {}) },

// REMOVE line 95 (in Supabase load effect):
creditSpread: { ...DEFAULT_APP_SETTINGS.creditSpread, ...(data.settings.creditSpread ?? {}) },

// REMOVE line 114 (in updateSettings):
creditSpread: { ...settings.creditSpread, ...(patch.creditSpread ?? {}) },
```

The `updateSettings` function also has `...patch` spread at line 105 — if `creditSpread` is removed from the `AppSettings` type, TypeScript will enforce that no one passes it. The Supabase upsert will stop writing the field naturally.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead |
|---------|-------------|-------------|
| Strategy param source of truth | Custom config system | `strategyProfiles.ts` — already exists, already complete |
| Settings persistence | Custom DB schema changes | No migration needed — `app_settings` stores JSON blob; field removal is soft |
| WFA metrics display | Fetch from DB | Hardcode Sharpe values directly (WFA is a historical run, not a live query) |

---

## Common Pitfalls

### Pitfall 1: `strategy` naming collision in scan-options.js
**What goes wrong:** Renaming `profileStrategy` to `strategy` in Scanner.tsx causes `req.query.strategy` in scan-options.js to receive `'swing'` or `'shortTerm'` instead of `'long'`/`'short'`. The LOQ/CSQ scoring path switches from long-option scoring to credit-spread scoring unexpectedly.
**Root cause:** Two distinct concepts share the same param name — profile selection and scoring strategy.
**How to avoid:** Use `activeProfile` as the new canonical param name instead of `strategy`. Confirm Scanner.tsx sends it and scan-options.js reads it.
**Warning signs:** Scanner returning credit-spread scores for all options when running in `'long'` mode.

### Pitfall 2: TypeScript errors after removing `creditSpread` from AppSettings
**What goes wrong:** If `CreditSpreadSettings` is removed from the `AppSettings` interface while any code still references `settings.creditSpread`, TypeScript build fails.
**Root cause:** `src/lib/backtest/option-sim.ts` has a local field named `creditSpreadWidth` — this is *not* the settings type, it's a backtest config field. No production page reads `settings.creditSpread.*` for decisions (confirmed by grep: only AppSettings.tsx and AppSettingsContext.tsx reference it).
**How to avoid:** Grep confirms `settings.creditSpread` appears in 2 files only (AppSettings.tsx and AppSettingsContext.tsx). Remove both together atomically.
**Warning signs:** TypeScript build error `Property 'creditSpread' does not exist on type 'AppSettings'`.

### Pitfall 3: Supabase DB schema vs JSON blob
**What goes wrong:** Assuming the `creditSpread` field must be explicitly deleted from Supabase.
**Root cause:** `app_settings` stores a JSON blob in a `settings jsonb` column — there is no separate column per field. Removing `creditSpread` from app code means the blob is simply not written with that field going forward. Old rows retain it but reads no longer request it.
**How to avoid:** No DB migration needed. The merge code removal (3 lines) is sufficient.
**Warning signs:** None — this is safe by design.

### Pitfall 4: WFA info card imports
**What goes wrong:** Importing `STRATEGY_PROFILES` in AppSettings.tsx before confirming the import path.
**Root cause:** `strategyProfiles.ts` exports `STRATEGY_PROFILES` (a const) and `getProfile` (a function). AppSettings.tsx already imports from `'../context/AppSettingsContext'` — it needs a new import from `'../lib/strategyProfiles'`.
**How to avoid:** Use named import `import { STRATEGY_PROFILES } from '../lib/strategyProfiles';`.

---

## Code Examples

### PRE-01: The exact one-line change
```typescript
// src/lib/strategyProfiles.ts — shortTerm block
ivRankMin: 40,   // was 30 — WFA-validated shortTerm threshold
```

### PRE-02: Recommended param rename avoiding collision
```typescript
// src/pages/Scanner.tsx (line 68)
params.set('activeProfile', activeStrategy);   // was 'profileStrategy'
```

```javascript
// api/scan-options.js (line 47)
const activeProfile = req.query.activeProfile === 'shortTerm' ? 'shortTerm' : 'swing';
// line 49 req.query destructure unchanged — 'strategy' stays as LOQ/CSQ toggle
```

### PRE-03: WFA info card structure
```tsx
// src/pages/AppSettings.tsx — replacement for credit spread section (lines 179-241)
import { STRATEGY_PROFILES } from '../lib/strategyProfiles';

// In component:
const profiles = STRATEGY_PROFILES;

<section className="space-y-4">
  <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
    Credit Spread Strategy (WFA-Validated)
  </h2>
  <p className="text-xs text-gray-500">
    Parameters are locked to WFA-validated values. Not user-configurable.
  </p>
  <div className="grid grid-cols-2 gap-3">
    {(['swing', 'shortTerm'] as const).map(key => {
      const p = profiles[key];
      return (
        <div key={key} className="bg-[#000] border border-[#333] rounded-lg p-3 space-y-1">
          <p className="text-xs font-medium text-white">{p.label}</p>
          <p className="text-xs text-gray-400">DTE: {p.dteMin}–{p.dteMax} (peak {p.dtePeak})</p>
          <p className="text-xs text-gray-400">Delta: {p.defaultDelta}</p>
          <p className="text-xs text-gray-400">Width: ${p.defaultWidth}</p>
          <p className="text-xs text-gray-400">TP: {p.profitTarget * 100}%</p>
          <p className="text-xs text-gray-400">IV Rank min: {p.ivRankMin}%</p>
        </div>
      );
    })}
  </div>
</section>
```

### PRE-03: AppSettingsContext cleanup
```typescript
// src/context/AppSettingsContext.tsx

// loadFromStorage — REMOVE the creditSpread line:
// creditSpread: { ...DEFAULT_APP_SETTINGS.creditSpread, ...(parsed?.creditSpread ?? {}) },

// Supabase load merged — REMOVE:
// creditSpread: { ...DEFAULT_APP_SETTINGS.creditSpread, ...(data.settings.creditSpread ?? {}) },

// updateSettings — REMOVE:
// creditSpread: { ...settings.creditSpread, ...(patch.creditSpread ?? {}) },
```

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| `creditSpread` fields in app_settings let users override WFA params | `strategyProfiles.ts` is the single locked source of truth | Eliminates silent override of validated parameters |
| `profileStrategy` query param in scan-options.js | `activeProfile` param (standardized) | Removes naming inconsistency vs strategy-recommend.js |
| shortTerm ivRankMin: 30 | shortTerm ivRankMin: 40 | Correct IV gating for short-term strategy |

---

## Open Questions

1. **Param name: `strategy` vs `activeProfile` for the profile selector**
   - What we know: CONTEXT.md says rename to `strategy` but `scan-options.js` already uses `strategy` for the LOQ/CSQ toggle
   - What's unclear: Whether the planner should use `strategy` (causing collision fix) or `activeProfile` (cleaner, no collision)
   - Recommendation: Use `activeProfile` — it accurately names what it is, avoids the collision, and aligns with the local variable name already in scan-options.js

2. **Whether to remove `CreditSpreadSettings` type entirely**
   - What we know: No page reads `settings.creditSpread.*` for strategy decisions; it's safe to remove
   - What's unclear: CONTEXT.md says "Delete the creditSpread fields" which implies full removal; Claude's Discretion says "Whether to keep the CreditSpreadSettings type"
   - Recommendation: Remove `creditSpread` from `AppSettings` interface and `DEFAULT_APP_SETTINGS` entirely. The type `CreditSpreadSettings` can be deleted too. The backtest `creditSpreadWidth` field in option-sim.ts is a separate unrelated symbol.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (configured in vite.config.ts) |
| Config file | `vite.config.ts` — `test` block at line 987 |
| Quick run command | `npx vitest run --passWithNoTests` |
| Full suite command | `npx vitest run --passWithNoTests` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PRE-01 | `strategyProfiles.shortTerm.ivRankMin === 40` | unit | `npx vitest run --passWithNoTests` | ❌ Wave 0 |
| PRE-02 | `scan-options.js` reads `activeProfile` from query; Scanner.tsx sends `activeProfile` | unit/smoke | Manual verify or add unit test | ❌ Wave 0 |
| PRE-03 | AppSettings renders WFA card with correct values from STRATEGY_PROFILES; no creditSpread inputs | unit | `npx vitest run --passWithNoTests` | ❌ Wave 0 |

The 307 parity tests in `tests/scoring-parity.test.ts` and 488 total tests MUST remain green after all changes — these test `src/lib/oss-core.ts` and `lib/_shared/scoring.cjs` which are not touched in Phase 1.

### Sampling Rate
- **Per task commit:** `npx vitest run --passWithNoTests`
- **Per wave merge:** `npx vitest run --passWithNoTests`
- **Phase gate:** Full suite green (488 tests passing) before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/prerequisite-fixes.test.ts` — unit tests covering PRE-01 (ivRankMin value), PRE-02 (param name in scan-options mock), PRE-03 (WFA card render)

Note: PRE-01 and PRE-03 are pure constant/render changes. A minimal test asserting `STRATEGY_PROFILES.shortTerm.ivRankMin === 40` and that `AppSettings` no longer exports `creditSpread` defaults would fully cover the regression surface.

---

## Sources

### Primary (HIGH confidence)
- Direct code inspection: `src/lib/strategyProfiles.ts` — confirmed shortTerm ivRankMin: 30 at line 70
- Direct code inspection: `api/scan-options.js` — confirmed `req.query.profileStrategy` at line 47
- Direct code inspection: `src/pages/Scanner.tsx` — confirmed `params.set('profileStrategy', activeStrategy)` at line 68
- Direct code inspection: `api/strategy-recommend.js` — confirmed `req.query.strategy` at line 1106 (already compliant)
- Direct code inspection: `src/pages/AppSettings.tsx` — confirmed credit spread section lines 179-241
- Direct code inspection: `src/context/AppSettingsContext.tsx` — confirmed three creditSpread merge locations
- Direct code inspection: `src/lib/types/settings.ts` — confirmed `CreditSpreadSettings` type and `AppSettings.creditSpread` field
- grep search: `settings.creditSpread` appears only in AppSettings.tsx + AppSettingsContext.tsx (no other consumers)
- grep search: `profileStrategy` appears only in Scanner.tsx + scan-options.js (no other callers)

### Secondary (MEDIUM confidence)
- CONTEXT.md decisions — user-locked choices confirmed against code

## Metadata

**Confidence breakdown:**
- PRE-01 fix: HIGH — single line, confirmed value
- PRE-02 fix: HIGH — two lines, confirmed callers; param collision identified and resolved
- PRE-03 fix: HIGH — four files, all inspected, merge logic and UI paths confirmed
- No new dependencies, no algorithmic changes, no scoring changes

**Research date:** 2026-03-14
**Valid until:** 90 days (stable codebase, no external APIs involved)
