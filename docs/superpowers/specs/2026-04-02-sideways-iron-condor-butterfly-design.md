> **Post-implementation correction (2026-04-07):** ADX references in this spec are actually a close-only directional metric (not Wilder ADX). See `computeCloseOnlyTrend()` in `scripts/short-put-1dte.ts`.

# Sideways Strategy — Iron Condors & Iron Butterflies

**Date:** 2026-04-02
**Status:** Design approved, pending implementation
**Author:** Claude (brainstorm with user)

---

## Problem

The current portfolio has two regime-dependent strategies:

- **Bull:** QQQ DTE5 bull put spread (EMA34 gate) — Sharpe 1.18
- **Bear:** QQQ/SPY/IWM DTE5 bear call spreads (triple EMA alignment + proximity) — combined Sharpe 0.985

When neither regime gate is active (range-bound/choppy markets), capital sits idle. Window-by-window analysis shows multiple periods with zero or minimal activity on one or both sides (W6, W14 for bear; W3, W4 for bull). The goal is to **maximize idle capital** during these periods with neutral option structures.

## Strategy Overview

Sell iron condors and iron butterflies on QQQ, SPY, IWM during confirmed range-bound regimes. DTE5, hold-to-expiry with optional profit target and delta stop exits. WFA optimizer selects the best structure and parameters per window.

## Regime Detection

Entry requires ALL conditions to be true:

1. **Negation gate (evaluated per-ticker independently):** Ticker close < EMA34 AND NOT(EMA21 < EMA34 < EMA55)
   - Ensures neither bull nor bear regime is active for that specific ticker
   - Each of QQQ/SPY/IWM can be in different regimes on the same day
   - This is the "leftover" regime by definition
2. **ADX confirmation:** ADX(14) < threshold (swept: 18, 20, 25)
   - Confirms actual range-bound behavior, not a brief EMA crossover during volatile transition
   - Prevents entering condors just as a new trend starts

## Structures

### Iron Condor
- Sell OTM put at short delta + buy further OTM put (bull put leg)
- Sell OTM call at short delta + buy further OTM call (bear call leg)
- Both legs share same expiration and wing width
- Profits when underlying stays between short strikes

### Iron Butterfly
- Sell ATM put + ATM call (both at ~0.50 delta)
- Buy OTM put + OTM call at wing width distance
- Higher credit than condor but narrower profit zone
- Special case: short delta is fixed at ATM, not swept

## Tickers

QQQ, SPY, IWM — same universe as the bear side. Different indices decouple in regime timing, providing more trade opportunities.

## Parameters

### Swept (WFA optimizer selects per window)

| Parameter | Values | Notes |
|-----------|--------|-------|
| Structure | iron condor, iron butterfly | Butterfly short delta fixed at ATM |
| Short delta (condor only) | 0.20, 0.25, 0.30 | How far OTM for short strikes |
| Wing width | $5, $10 | Distance from short to long (protection) strikes |
| ADX threshold | 18, 20, 25 | Range-bound confirmation strictness |
| Profit target | 50%, 80%, 100% (hold-to-expiry) | % of initial credit collected to trigger exit |
| Delta stop | none, 0.50, 0.60 | Exit if either short strike delta exceeds threshold |

### Fixed

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| DTE | 5 (range 2-7) | Consistent with bull/bear strategies |
| Max concurrent | 1 per ticker | Conservative start |
| Commission | $0 | Robinhood |
| Risk sizing | Swept at portfolio level (5/10/15/20%) | Same as existing studies |

### Config Space

- Condor: 3 deltas x 2 widths x 3 ADX x 3 TP x 3 delta stops = **162/ticker**
- Butterfly: 2 widths x 3 ADX x 3 TP x 3 delta stops = **54/ticker**
- **Total: 216/ticker x 3 tickers = 648 configs**

## WFA Methodology

Identical to existing bull and bear studies:

- **Window structure:** 252 trading days train / 126 trading days test, rolling
- **Train phase:** Sweep all 216 configs, rank by Sharpe, select best
- **Test phase:** Run best config forward with real equity carried from prior window
- **Portfolio growth:** True portfolio growth — equity carries forward across windows
- **Final evaluation:** Combine sideways results with bull + bear for full 3-regime portfolio backtest

## Data & API Constraints

### Hard constraint: NO ORATS API calls — cache-only mode

- **Database:** `data/option-chains.sqlite` (~15.5M rows)
- **Coverage:** QQQ/SPY/IWM chains cached 2018-01 → 2026-03 (2,050 trading days each)
- **DTE 2-7 gaps:** ~162 dates for QQQ and ~183 dates for IWM in the 2018-2021 period (early ORATS data had fewer short-dated expirations). SPY has 100% coverage.
- **Gap handling:** If a date has no matching DTE 2-7 chain, skip it (no trade signal). The WFA already handles sparse signal days. This loses ~8% of early-period opportunities but ensures zero API spend.
- **From Oct 2021 onward:** 99.9%+ DTE 2-7 coverage on all three tickers.

### ADX Computation

ADX(14) must be computed from candle data. Source: `stock_candles` table in Supabase or local candle cache. This is a new indicator — requires:
- True Range (TR) calculation
- +DI / -DI smoothing (14-period Wilder's)
- ADX = 14-period smoothed average of DX

No external API needed — computed from existing cached candle data.

## Engine Changes

### New code needed

1. **Iron condor position type** — open bull put + bear call as a single position with shared entry/exit logic. The engine already has both leg types; this combines them.
2. **Iron butterfly variant** — special case where both short strikes are ATM (~0.50 delta). Shares 90%+ of condor code path.
3. **ADX(14) indicator** — compute from candle data. New function, ~30 lines. Used only in regime gate evaluation.
4. **Sideways regime gate** — combine EMA negation check + ADX filter. Returns boolean per (ticker, date).
5. **Config grid expansion** — add `structure` type and condor/butterfly branching to the sweep harness.

### Existing code reused (no changes)

- `option-sim.ts` — bull put and bear call simulation (iron condor = both simultaneously)
- `chain-cache.ts` — O(1) PK lookup, `findContractDirect()` for strike matching
- `wfa-options.ts` — rolling window engine
- `bsm-pricing.ts` — BSM pricing, delta computation
- `portfolio-stress.ts` — correlated drawdown using dailyMtM
- Worker thread pool (`wfa-run-unified.ts`) — 13 workers on 15-core machine
- Profit target exit (`profitTarget` config)
- Delta stop exit (`DELTA_STOP` type, `creditDeltaStop` config)

## Compute Strategy

| Aspect | Detail |
|--------|--------|
| Workers | 13 (default `cpus - 2` on 15-core machine) |
| Config pruning | Butterfly skips delta sweep → effective configs ~648 total |
| Parallelization | Each worker evaluates one config across all train windows independently |
| Per-ticker | QQQ, SPY, IWM run as separate passes, each saturating all 13 workers |
| Chain cache | SQLite with O(1) PK lookup, warm from prior bear study |
| Estimated runtime | ~648 configs x ~16 windows x ~2s/eval / 13 workers ≈ **30-45 min** |

## Success Criteria

1. **Standalone viability:** At least one ticker has standalone Sharpe > 0
2. **Portfolio improvement:** Combined 3-regime portfolio (bull + bear + sideways) improves Sharpe vs bull+bear-only baseline (0.985)
3. **Drawdown budget:** Sideways leg MaxDD < 30%
4. **Idle fill rate:** Sideways strategy generates trades in at least 50% of previously idle windows
5. **No API calls:** Entire study runs from cached data only

## Output

Results written to `backtesting history/credit-spread/reports/sideways-strategy/README.md` with:
- Per-ticker standalone results (top 5 configs each)
- Portfolio combination results (sideways-only, bull+sideways, bear+sideways, all three)
- Window-by-window breakdown for best combo
- Risk tier comparison (5/10/15/20%)
- Comparison vs bull+bear baseline

## Risk & Caveats

1. **Limited range-bound sample:** The 2018-2026 period is bull-dominated. True range-bound windows may be underrepresented, leading to high variance in sideways results.
2. **Regime transition risk:** The negation gate + ADX may still allow entries near regime boundaries. The delta stop provides protection but adds complexity.
3. **Gamma risk on DTE5 condors:** Short-dated condors have high gamma near expiry. A breakout on day 4-5 can go from max profit to max loss quickly. Profit targets and delta stops mitigate this.
4. **Statistical significance:** With only ~16 WFA windows and potentially few trades per window (range-bound is less frequent), individual config results may be noisy. Focus on robust configs with >30 total trades.
