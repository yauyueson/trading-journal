# Feature Landscape

**Domain:** Options trading journal — WFA-driven signal-to-execution workflow integration
**Researched:** 2026-03-14
**Project:** WFA-Driven Workflow Integration (adding validated strategy enforcement to existing platform)

---

## Context

This is a subsequent milestone on an existing, working platform. The gap is not features missing from scratch — it is the distance between the backtested edge and daily execution. The platform generates signals, the user clicks "Build Swing Spread", lands on /selector, and must manually remember WFA-validated rules. The feature work here closes that gap by enforcing rules at the UI layer.

The three questions from the milestone context:
1. How do platforms carry signal context through a multi-step trade entry workflow?
2. How is IV rank filtering implemented as a hard gate vs soft indicator?
3. How do platforms auto-fill exit parameters based on strategy presets?

---

## Table Stakes

Features users expect. Missing = the platform feels broken or forces mental tax the user shouldn't carry.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Signal source visible in spread builder | User clicked from a signal — they need to confirm they're building the right trade for the right ticker/direction | Low | URL params carrying `ticker`, `signal`, `direction` is the standard pattern; no new state layer needed |
| Strategy parameters reflected in builder defaults | When switching Swing vs Short-Term, every field (DTE, delta, width) should reset to validated values | Low | `strategyProfiles.ts` already drafted; just wire context reads |
| IV rank displayed on candidates | Every professional platform (tastytrade, thinkorswim, OptionStrat, Option Samurai) shows IVR/IVP as a primary column | Low | ORATS `ivPercentile` already fetched; display-only wiring |
| Candidates below IV threshold clearly distinguished | Users need to know at a glance which candidates pass the IV gate — tastytrade color-codes IVR, Option Alpha gates bot entry by IVR condition | Low | Badge / greyed-out row is the standard pattern |
| Profit target field pre-filled on entry | Bracket orders (tastytrade, E*TRADE "Exit Plan") and order templates (thinkorswim) set TP at entry as a standard flow | Low | Write `profitTarget` from profile into the position record at creation time |
| Global strategy toggle accessible during workflow | If user realizes mid-build they want Short-Term instead, they should not navigate away | Low | Pill toggle in app header; already described in draft plan |
| Strategy parameters update all pages consistently | Scanner DTE defaults, Portfolio DTE highlighting, Signals subtitle — all must reflect active strategy | Low-Med | Requires wiring `useAppSettings` profile reads across 4 pages |

---

## Differentiators

Features that set the platform apart from generic trading tools. Not universally expected, but high value for a WFA-backed journal.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Signal quality badge in spread builder | Show the originating signal's score + direction streak inline in the builder — no other journal-style platform does this | Low | Surface `score`, `adxValue`, `streak` from URL params as a read-only callout card in the builder header |
| IV rank hard gate (hidden candidates, not warnings) | tastytrade shows IVR but never prevents entry; OptionStrat never gates. Hard-hiding sub-threshold candidates is a discipline enforcer not seen elsewhere | Low-Med | Toggle between "hide" (strict mode) vs "warn" (advisory mode) gives power-user flexibility |
| Strategy profile subtitle on every page | Signals, Portfolio, Scanner all show the active strategy's validated parameters as a subtitle line — permanent reminders of the WFA edge | Low | String interpolation from profile object; cosmetically ties the whole platform together |
| WFA-derived defaults, not arbitrary | Other platforms have order templates, but parameters are user-set. This platform's defaults (TP 30%/40%, DTE 55/10, IV ≥ 30%/40%) come from validated WFA output with documented Sharpe and win rate | None (data already in WFA results) | The differentiator is the sourcing story — surface "WFA-validated" label next to each default |
| Dual-strategy DTE validation in Portfolio | Portfolio DTE highlighting adjusts to which strategy is active, so Swing positions don't trigger warnings when Short-Term profile is active | Low | Single line change wired to profile; no platform studied has backtested-validated DTE ranges driving position health indicators |

---

## Anti-Features

Things to deliberately NOT build in this milestone.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Score-based exit automation | WFA proved `se50`/`se60` go negative OOS — automating an exit trigger on score drops destroys returns | Manual exit only; TP target is a reminder, not an automated order |
| Stop-loss automation | WFA proved SL 2× destroys returns (avg Sharpe 0.04); adding SL UI implies it is a valid choice | No SL field in position creation from strategy; document why in tooltip if needed |
| Debit spread workflow changes | WFA: credit spreads Sharpe 2.14, LEAPs Sharpe 0.22-0.37. Improving debit spread flow is negative ROI | Defer entirely; scope to credit spread execution only |
| Capital utilization tracking | Separate milestone concern; adding it here splits focus | Track as follow-on milestone |
| Position card TP progress bars / alerts | Adds visual complexity at the monitoring layer; the high-leverage point is entry, not monitoring | Auto-fill TP at entry is sufficient; progress bars deferred |
| "Override IV gate" persistent setting | Giving users a persistent override trains them to bypass the filter. The value is the discipline, not the option to disable it | Allow per-session advisory mode but never save "ignore IV" as a persisted setting |
| Bracket order automation (auto-close at TP) | This platform doesn't execute trades — it journals them. Automation would require broker API integration, not in scope | TP field is a target to reference manually, not an OCO order |
| Third-party signal webhooks | Scope creep; the platform's own EMA/MOM signals are the validated edge | Keep signal source internal; no webhook ingestion from external alert services |

---

## Feature Dependencies

```
strategyProfiles.ts (definition module)
  → AppSettingsContext (activeStrategy state)
    → Scanner page (DTE/delta defaults)
    → StrategyRecommender page (DTE/width defaults + IV gate)
    → Signals page (subtitle)
    → Portfolio page (DTE range validation)
    → API: strategy-recommend.js (dtePeak/width/delta behavior)
    → API: scan-options.js (DTE defaults)

Signal context URL params (ticker, signalType, score, direction, streak)
  → StrategyRecommender page (signal callout card)
    → Depends on: Signals page CTA link construction (must include params)

IV rank hard gate
  → Depends on: strategyProfiles.ts (ivRankMin per strategy)
  → Depends on: ORATS ivPercentile already fetched in scan-options

Auto-fill profit target
  → Depends on: strategyProfiles.ts (profitTarget per strategy)
  → Depends on: position creation flow in StrategyRecommender
```

---

## MVP Recommendation

Prioritize in order:

1. **strategyProfiles.ts + AppSettingsContext** — zero-dep foundation; everything else reads from it
2. **Strategy-aware API routes** (strategy-recommend.js, scan-options.js) — enables backend to respect active profile
3. **Signal context URL params** — wire Signals page CTA links, render callout card in StrategyRecommender
4. **IV rank hard gate in StrategyRecommender** — hide/warn candidates below `profile.ivRankMin`; this is the edge-enforcement step
5. **Auto-fill profit target on position creation** — write `profitTarget` from profile at entry
6. **Global strategy toggle in header** — exposes the above to the user
7. **Page-level subtitle + DTE validation updates** (Scanner, Signals, Portfolio) — cosmetic consistency pass

Defer:
- Progress bars / monitoring UX: not highest leverage
- Anti-SL warning copy: messaging refinement, lower priority than mechanics
- Per-strategy IV threshold differentials (swing 30% vs ST 40%): the ST threshold value may need additional validation before being made a hard gate vs. using the conservative 30% uniformly

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Table stakes identification | HIGH | Verified against tastytrade, thinkorswim, OptionStrat, Option Alpha; all show IVR prominently, use order templates/presets, carry strategy context within a session |
| Differentiators | MEDIUM | Hard-gating on IV (vs. display-only) and WFA-sourced defaults are genuinely absent in surveyed platforms; absence of evidence isn't conclusive proof |
| Anti-features | HIGH | WFA data is internal and definitive: se50/se60 and SL 2× are proven harmful; scope exclusions confirmed by PROJECT.md |
| Feature complexity estimates | HIGH | All features are wiring existing infrastructure; no new APIs, no new DB tables; complexity is integration not invention |
| URL params as context-passing pattern | MEDIUM | TradersPost/webhook platforms use JSON payloads for signal context; URL params are a lighter pattern that fits SPA navigation and is confirmed suitable for this use case |

---

## Gaps to Address

- The exact UX pattern for "hard gate vs advisory mode" (hide vs warn for below-threshold IV candidates) is a product decision, not a research finding. Both are implementable at identical complexity — the choice should be made before implementation.
- Short-Term IV threshold (40% in PROJECT.md vs 30% in the draft `strategyProfiles.ts`) is inconsistent. WFA data should adjudicate this before it becomes a hard gate value. If unresolved, use the conservative 30% floor for both and treat 40% as aspirational.
- Signal context callout card design (what fields to surface, how much visual weight to give it) needs a brief design decision — surfacing all of `score`, `adxValue`, `rvol`, `direction`, `streak` could clutter the builder header.

---

## Sources

- [Option Alpha — Exit Options Automated Position Management](https://optionalpha.com/help/exit-options)
- [Option Alpha — Using Bots to Automate Profit Targets & Stop Losses](https://optionalpha.com/blog/using-bots-to-automate-profit-targets-and-stop-losses)
- [Option Alpha — Automation Basics](https://docs.optionalpha.com/platform/bots/automation-basics)
- [OptionStrat Features](https://optionstrat.com/features)
- [OptionStrat Review 2026 — OptionsScanners.com](https://optionsscanners.com/review/optionstrat)
- [tastytrade — Options Trading](https://tastytrade.com/options/)
- [SignalStack — tastytrade Integration](https://signalstack.com/integrations/brokers-and-exchanges/tastytrade/)
- [E*TRADE — Automating Exit Strategies for Options Trades](https://us.etrade.com/knowledge/library/options/automating-exit-strategies-for-options-trades)
- [TradeStation — OptionStation Pro Order Management](https://www.tradestation.com/insights/2025/04/15/optimizing-options-trading-manage-orders-and-positions-with-optionstation-pro/)
- [Option Samurai Review 2026 — OptionsScanners.com](https://optionsscanners.com/review/option-samurai)
- [thinkorswim — Order Entry and Saved Orders](https://toslc.thinkorswim.com/center/howToTos/thinkManual/Trade/Order-Entry-Tools)
- [Warrior Trading — How to use IV Rank in Options Trading](https://www.warriortrading.com/implied-volatility-iv-rank/)
- [TradersPost — TradingView Signal Sources](https://docs.traderspost.io/docs/learn/signal-sources/tradingview)
- [ORATS Trade Builder](https://orats.com/trade-builder)
