# Phase 1: Prerequisite Fixes - Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Correct pre-existing config bugs so strategy parameters are accurate and consistent before any feature work begins. Three fixes: ivRankMin mismatch, API param naming inconsistency, and creditSpread settings namespace conflict.

</domain>

<decisions>
## Implementation Decisions

### Settings page credit spread section
- Remove the manual credit spread inputs (DTE low/high, target delta, spread width, min IV rank, profit target) from AppSettings.tsx
- Replace with a read-only WFA config info card showing the active strategy's validated parameters from strategyProfiles.ts
- Delete the creditSpread fields from the app_settings Supabase table (stop reading/writing them)
- strategyProfiles.ts is the single source of truth for all strategy parameters — no user override

### API param naming
- Clean break: rename `profileStrategy` to `activeProfile` in both Scanner.tsx and scan-options.js (avoids collision with existing `strategy` param for LOQ/CSQ toggle)
- No backward compat alias — Scanner.tsx is the only caller
- strategy-recommend.js already uses `strategy` correctly — no change needed there
- Signals.tsx CTA passes `strategy` to /selector which maps to strategy-recommend.js — confirm consistency

### ivRankMin fix
- Fix shortTerm ivRankMin from 30 to 40 in strategyProfiles.ts to match WFA-validated threshold
- Swing stays at 30 (WFA-validated)
- These values are hardcoded from WFA, not user-configurable

### Claude's Discretion
- Whether to audit AppSettings.tsx for other useful settings to keep vs remove
- How to structure the WFA config info card (layout, which fields to show)
- Whether to keep the CreditSpreadSettings type or remove it entirely

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `strategyProfiles.ts`: Already has complete swing/shortTerm profiles with all params — just needs ivRankMin fix
- `AppSettingsContext.tsx`: Has the settings save/load plumbing — creditSpread section can be removed from merge logic

### Established Patterns
- Settings page uses `draft` state pattern with `setCreditSpread` helper — removal is straightforward
- API routes use `req.query.*` destructuring at top of handler

### Integration Points
- `Scanner.tsx` line 68: sends `profileStrategy` → change to `strategy`
- `scan-options.js` line 47: reads `profileStrategy` → change to `strategy`
- `AppSettings.tsx` lines 184-234: credit spread input section → remove
- `AppSettingsContext.tsx` lines 20, 95, 114: creditSpread merge logic → remove
- `src/lib/types/settings.ts` lines 56, 86: CreditSpreadSettings type → remove or deprecate

</code_context>

<specifics>
## Specific Ideas

- The WFA config info card should show both swing and shortTerm profiles side by side so the user can see the difference at a glance
- WFA source data: swing Sharpe 2.14, ST Sharpe 4.77 — these numbers could appear on the card for confidence

</specifics>

<deferred>
## Deferred Ideas

- Remove Scanner page entirely — it's not part of the WFA-validated workflow (signals → spread builder). Consider removing /scanner route in a future phase.

</deferred>

---

*Phase: 01-prerequisite-fixes*
*Context gathered: 2026-03-14*
