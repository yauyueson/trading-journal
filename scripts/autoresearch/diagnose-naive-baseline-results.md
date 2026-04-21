# Naive Baseline Holdout Diagnostic — Results

**Date:** 2026-04-18
**Question:** Does the 30-ticker LEAP CALL family's in-sample alpha survive out-of-sample once the EMA selection layer is removed?
**Answer:** **No. The LEAP-CALL-on-30-tickers family is a selection-window mirage.**

## Setup

`strategy-30-naive-baseline.ts` is identical to `strategy-30-smoke.ts` except signal `score = 0` (constant). With no info to rank on, the 4-slot allocator picks arbitrarily when >4 concurrent signals exist. Same 30 tickers, same EMA entry conditions, same SPY regime + contango gates, same `d65-sl35-ts105` LEAP config, same `maxPositions=4 / maxPerTicker=1`. Run through canonical WFA (10 selection folds + 5 holdout folds).

## Three-run comparison

All three runs are on the identical 30-ticker universe, identical entry conditions, identical config — only the `score` function differs.

| Variant | Score formula | OOS Sharpe | OOS SpyIR | Holdout Sharpe | **Holdout SpyIR** | OOS / Holdout Trades | Deflated Sharpe |
|---|---|---|---|---|---|---|---|
| smoke30 | `100 − pct·1000` (reward near-EMA) | 1.381 | 0.755 | 1.099 | **−0.062** | 140 / 56 | 0.146 |
| smoke30-revscore | `pct·1000` (reward extended) | 1.560 | 0.830 | 0.905 | **−0.332** | 140 / 59 | 0.517 |
| smoke30-naive | `0` (no info) | 1.218 | 0.669 | 0.668 | **−0.337** | 132 / 55 | 0.164 |

**Internal "always-long" baseline** (computed by runner inside each OOS selection fold, unconstrained by maxPositions): Sharpe ≈ 1.38, SpyIR ≈ 1.04, 250 trades — **measured in-sample only**. No holdout number exists for this baseline because the delta gate is applied only in the selection window.

## Verdict (applying the pre-defined rule)

> Holdout SPY IR ≥ 0.3 **and** holdout Sharpe ≥ 0.3 → foundation is real.
> Otherwise → foundation is a selection-window mirage.

- Holdout Sharpe: 0.668 ≥ 0.3 ✓
- Holdout SPY IR: **−0.337 < 0.3** ✗ (in fact, negative — strategy underperforms SPY by 6.4%/yr)

**❌ Foundation is a selection-window mirage.** The naive-baseline holdout is worse than the original smoke's holdout (−0.062), not better. Removing selection didn't rescue the family.

## What this means

1. **All three score variants fail the same holdout.** The 2024-01 → 2026-02 holdout has **negative SpyIR for every variant** — ranging from −0.062 (near-EMA) to −0.337 (reversed / naive). The LEAP-CALL basket earns positive Sharpe out-of-sample (0.67–1.10) but consistently **loses to SPY by 1–6.5%/yr**.

2. **The "IR 1.04 in-sample" number does not generalize.** The runner's always-long baseline hit IR ≈ 1.04 across every selection window, which seduced us into thinking the family had real structural edge. But the same signal structure applied to the held-out 2024–2026 window underperforms SPY — even without EMA ranking.

3. **The EMA timing signal isn't the root cause.** Swapping score direction (near → far), removing score entirely, or keeping the original — none matter. All three holdouts are negative. The timing filter is a minor contributor; the bigger problem is that the LEAP-CALL-on-30-tickers basket itself did not outperform SPY during 2024–2026.

4. **Why the in-sample / out-of-sample divergence?** Most likely explanation: 2018–2023 training window had broader participation across mid/large caps (value/growth rotation, Covid reopening, etc.), while 2024–2026 was dominated by mega-cap MAG7 concentration that a 30-ticker equal-weighted LEAP basket could not match on a risk-adjusted basis. The LEAP family's edge was real during 2018–2023 but has not persisted.

## Implication for research direction

- Any **timing filter** layered on LEAP CALLs (IV rank, VRP, macro regime, earnings windows, …) is polishing a non-existent edge under current holdout conditions. Even the best-case filter can't reverse a holdout SpyIR floor of −0.06.
- The sensible next move is **path (b): change strategy family.** Candidates:
  - **Credit spreads** (bull put / bear call) with the 30-ticker universe — theta-positive, negative beta to vol, different regime.
  - **Calendar / diagonal spreads** — theta-positive + long gamma crossover.
  - **Iron condor** or **butterfly** — range-bound mean-reversion exposure, different factor.
  - **Same LEAP family but wider delta bucket** (e.g., 0.50–0.65 or 0.30–0.50) — less directional, different risk profile. (Weaker hypothesis; the 0.65–0.80 failure suggests the issue isn't the delta bucket.)
- Before launching a new campaign: re-run the equivalent "naive baseline" sanity on whichever new family is chosen, with the same verdict rule. Don't invest attempts in a family until its constant-score holdout passes.

## Attempts ledger

- Global attempt counter: **37 → 38** (single anchor, no configVariants).
- Deflated Sharpe (adjusted for 38 attempts): 0.164 — survives but marginal.
- This run is a foundational diagnostic, not a campaign. It does not contaminate any pre-reg.

## Files

- `scripts/autoresearch/strategy-30-naive-baseline.ts` — the strategy file (score = 0)
- `data/leaderboard-full-smoke30-naive.json` — full leaderboard entry
- `/tmp/smoke30-naive.log` — raw runner log

## Decision

The LEAP-CALL-on-30-tickers research direction is exhausted under the current holdout window. Recommend **path (b) — change strategy family.** Specific candidate list above.
