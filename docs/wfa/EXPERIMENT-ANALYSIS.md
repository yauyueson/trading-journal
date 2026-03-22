# WFA Experiment Analysis: Strict Execution Ensemble

**Date:** 2026-03-21
**Evaluator:** Gemini (The Analyst)
**Experiment:** `strict-execution-ensemble`
**Results summary:** Sharpe 0.54 | WR 84.3% | Max DD 13.0% | PnL $47,733 | 680 Trades

---

## 1. Is the IV≥30 gate too restrictive?

**Absolutely.** Reducing the trade count by 86% (4,939 → 680) means the strategy was out of the market for the vast majority of an 8-year structural bull run. Variance Risk Premium (VRP) — the fact that implied volatility structurally trades higher than realized volatility — exists continuously, even in low-IV regimes. By enforcing `IV ≥ 30`, we forcibly excluded the strategy from harvesting premium during "normal" market conditions, severely truncating the absolute PnL and therefore sinking the portfolio M2M Sharpe.

## 2. Should we test IV≥20 or IV≥10 to find the selectivity sweet spot?

**Yes.** The original v2 optimal swing config found `IV ≥ 20` to be the sweet spot, while the No-ADX swing experiment identified `IV ≥ 10`. Selling premium is mathematically a volume business over time. By relaxing the IV gate to 10 or 20, we allow the strategy to compound theta continuously rather than waiting solely for panic spikes.

## 3. The bidask penalty is severe — is the slippage model too aggressive, or is this the honest cost?

It is the honest, structural cost of trading options, and the optimizer perfectly diagnosed this by completely rejecting the $5 spread width across every window and exclusively selecting the $15 width. 

A $5 credit spread collects less total premium than a $15 spread, but the fixed bid/ask spread (e.g., $0.05 on the exact same strikes) represents a much larger relative penalty on the $5 spread's collected edge. The severe penalty proves the model works and has successfully inoculated us against overfitting to mathematically fragile, narrow spreads.

## 4. Mechanical put-selling achieves SR 0.78 — does this mean technical signals are net-negative after slippage?

No, the technical signals are **net-positive**, as proven by the fact that the strategy easily outperformed Random Entry (SR 0.54 vs SR 0.41).

The Mechanical Put-Sell benchmark achieves 0.78 because it is structurally "always-on" (maxPositions 10, trading every 5 days continuously). It captures the omnipresent equity risk premium and theta decay unconditionally. Our technical strategy was crippled by the `IV ≥ 30` gate. If we untether the technical signals from the extreme IV gate, they should compound the baseline edge of the Mechanical benchmark.

## 5. What experiment should we run next?

We must find the "liquidity sweet spot." We know $15 widths and true bidask fills protect us from slippage over-optimization. We now need to re-engage with the broad market by lowering the IV gate so the technical signals have enough "at-bats" to beat the mechanical baseline.

**Next Experiment: `liquidity-sweet-spot`**
- **Pipeline:** Unified Swing, top-3 ensemble voting
- **Constraints:** `maxPositions: 10`, `maxPerTicker: 3`
- **Fills:** `fillMode: bidask` (Maintain the honest reality check).
- **IV Rank Gate Sweep:** `[10, 15, 20]` (Lower the hurdle to allow continuous VRP harvesting).
- **Spread Width:** `[15]` (Hardcode to 15, as 5 was universally rejected).
- **Profit Target Sweep:** `[0.30, 0.40, 0.50]` (Holdovers from the previous run, clearly preferred over standard 30%).
- **Delta Stops:** `[Infinity]` (Disable, as it triggered 0 times).
- **Time Stops:** `[7, 14]`.
- **Presets:** `all 8` (Let the ensemble dynamically elect the best signal combinations per window).

**Goal:** Determine if the technical ensemble can surpass the Mechanical Put-Sell (0.78 SR) and cross the 1.50+ SR threshold when allowed to actively harvest standard market conditions with realistic fills.

**Execution Size:** 3 IV gates × 3 TPs × 1 Width × 1 Delta Stop × 2 Time Stops × 8 Presets = 144 configs (Half the run time of the previous experiment).
