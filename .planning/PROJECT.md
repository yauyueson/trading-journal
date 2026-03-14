# WFA-Driven Workflow Integration

## What This Is

Operationalize Walk-Forward Analysis findings into the trading journal's daily workflow. The platform has validated two credit spread strategies via WFA (swing: Sharpe 2.14, short-term: Sharpe 4.77) but the UI doesn't enforce the validated rules. This milestone bridges the gap between backtested edge and daily execution by carrying signal context through the spread builder, gating on IV rank, and auto-filling WFA-validated exit targets.

## Core Value

The platform must make the WFA-validated action the easiest action — signal alignment visible in the spread builder, IV rank filtering candidates before the user sees them, and profit targets pre-filled at entry.

## Requirements

### Validated

- Signal generation (EMA/MOM) with quality gates (score >= 90, ADX >= 15, RVOL >= 0.5) — existing
- IV >= 30% status gate on signals page (LOW_IV badge) — existing
- Strategy profile concept with swing/shortTerm presets — existing (drafted, not implemented)
- Credit spread scoring with IV rank adjustment, vol forecast, exitMultiplier — existing (Phase A-C)
- WFA results viewer at /backtest tab — existing
- "Build Swing/ST Spread" CTAs on signals page navigating to /selector — existing

### Active

- [ ] Signal context (signal type, score, direction, streak) passed from signals page to spread builder and displayed prominently
- [ ] IV rank hard filter in spread builder — candidates below strategy-specific threshold (swing 30%, ST 40%) hidden or gated
- [ ] Auto-fill profit target at strategy-specific TP (swing 30%, ST 40%) when opening a position from spread builder
- [ ] Strategy profile definitions (swing vs shortTerm) with WFA-validated parameters driving DTE, delta, width, TP defaults across all pages
- [ ] Global strategy toggle accessible from spread builder flow
- [ ] API routes (strategy-recommend, scan-options) accept strategy param and adjust defaults accordingly

### Out of Scope

- Debit spread improvements — WFA shows credit spreads massively outperform (Sharpe 2.14 vs LEAPs 0.22-0.37)
- Single-leg scoring improvements — LEAPs had 50% OOS survival rate vs credit 100%
- Score-based exit automation — WFA proved se50/se60 go negative OOS
- Stop-loss automation — WFA proved SL 2x destroys returns (Sharpe 0.04)
- Position card progress bars / TP alerts — deferred, auto-fill on entry is sufficient for now
- Anti-SL warning UX — deferred
- Portfolio-level capital utilization tracking — separate milestone

## Context

**WFA-validated configurations:**

| Parameter | Swing | Short-Term |
|-----------|-------|------------|
| DTE | 45-65d (target 55) | 7-14d (target 10) |
| Delta | 0.28-0.42 (default 0.35) | 0.30-0.45 (default 0.45) |
| Spread Width | $15 | $2.5 |
| TP Target | 30% | 40% |
| IV Rank Min | 30% | 40% |
| Stop Loss | None | None |
| Signals | EMA, MOM | EMA, MOM |
| OOS Sharpe | 2.14 | 4.77 |
| OOS Win Rate | 88.4% | 88.0% |
| OOS Max DD | 4.9% | 1.14% |

**Current workflow gap:** User sees GO signal on signals page, clicks "Build Swing Spread", lands on /selector — but the selector doesn't show which signal triggered, doesn't hard-gate on IV rank, and doesn't pre-fill the validated TP target. The user must remember and manually apply WFA rules.

**Key files:**
- `src/pages/Signals.tsx` — signals dashboard with GO/LOW_IV statuses
- `src/pages/StrategyRecommender.tsx` — spread builder (/selector)
- `src/pages/Scanner.tsx` — manual options scanner
- `api/strategy-recommend.js` — recommendation engine
- `api/scan-options.js` — scanner API
- `src/contexts/AppSettingsContext.tsx` — global settings
- Existing draft plan: `docs/superpowers/plans/2026-03-13-short-dte-platform-integration.md`

**Existing short-term WFA data:** `data/wfa-results-short.json` (1,320 OOS trades, 12 windows)
**Existing swing WFA data:** `data/wfa-results.json` (5,556 OOS trades, 12 windows)

## Constraints

- **Parity**: `src/lib/oss-core.ts` and `lib/_shared/scoring.cjs` must stay in sync — 307 parity tests enforce this
- **Test suite**: All 488 existing tests must pass after changes
- **API**: Vercel API routes are ESM .js — no TypeScript in api/ directory
- **Data**: ORATS is the sole options data provider; IV rank comes from `ivPercentile` field in ORATS cores
- **No new DB tables**: Use existing `signal_history`, `orats_iv_cache`, `positions` tables

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Start fresh plan (not layer on existing draft) | Existing plan covers strategy profiles but not signal context or exit automation holistically | -- Pending |
| Auto-fill TP only (no position card progress) | Simplest intervention at highest-leverage point (entry) | -- Pending |
| IV rank as hard filter, not soft penalty | WFA shows IV >= 30% is +58% Sharpe — this isn't optional, it's the edge | -- Pending |
| Carry signal context via URL params | Simplest implementation — no new state management needed | -- Pending |

---
*Last updated: 2026-03-14 after initialization*
