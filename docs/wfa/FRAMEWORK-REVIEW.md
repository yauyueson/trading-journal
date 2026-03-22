# WFA Framework Review & Next Steps

**Date:** 2026-03-21
**Evaluator:** Gemini (The Analyst)

## 1. Unified vs v2 Delta (Sharpe 1.45 vs 2.44)

The validation run successfully reproduced the mechanics of the strategy, but the performance profile changed dramatically (Sharpe 2.44 → 1.45, Trades 532 → 4,939). Are they comparable? **No.** The unified framework is structurally different in ways that naturally lower the ceiling but increase robustness:

1. **Capacity Limit Expansion:** The run metadata shows `"maxPositions": 50`. The v2 baseline was capped at 5. Allowing 50 open positions simultaneously removes the stringent capital-allocation filter and 10x's the trade frequency. This alone explains the massive jump in trades and PnL ($54K → $212K), but at the cost of higher drawdown (1.7% → 8.8%) and lower Sharpe, as marginal signals were admitted.
2. **Ensemble Voting vs Argmax:** The v2 baseline used TPE to find the single best set of parameters (argmax). Argmax is highly prone to overfitting the training window's local peaks. By taking the top-3 ensemble, the unified framework averages the signal of multiple robust configs. This effectively widens the net, diluting the win rate (94.4% → 88.7%) but drastically improving out-of-sample resilience.
3. **Fitness Metric Shift:** v2 was heavily selecting for configs that rushed to immediate exits because trade-level annualization (`sqrt(252/holdDays)`) rewarded them. The new daily portfolio Mark-to-Market Sharpe doesn't care if a trade closes in 1 day or 5; it measures portfolio volatility. 

**Conclusion:** The result was not "lost in translation." The unified framework is simply telling us the truth: the 2.44 Sharpe was an overfit artifact of 5 positions + argmax + trade-level math. The 1.45 Sharpe is a far more honest assessment of a broad application of the strategy.

## 2. Benchmark Wrapper Evaluation

**The current simplified P&L approximations for the benchmarks are unacceptable.** 
Comparing a fully simulated technical strategy against a math-based approximation benchmark completely invalidates the comparison. The true strategy pays slippage on the bid/ask, suffers from gamma exposure near expiry, and is subject to the actual IV paths produced by ORATS. The approximation benchmark bypasses all this microstructure friction. 

**Action:** Claude must route the "Mechanical Put-Sell" and "Random Entry" benchmarks through the exact same WFA options simulator pipeline (`src/lib/backtest/option-sim.ts`). A mechanical system is just the WFA engine running a constant entry signal (`DTE = 45`, `Delta = 0.30`) with no technical filters.

## 3. Assessing Methodology Gaps

1. **Holdout Degradation (Priority 1):** We still don't know why a 45-70% drop occurs when moving to the holdout. However, now that we have the top-3 ensemble and portfolio M2M Sharpe, we *finally* have a pristine tool to measure it. 
2. **DSR Failures (Priority 2):** DSR failing is actually a feature, not a bug. The expected max SR is inflated because the candidate space is large. Since the grid isn't shrinking, the only way to pass DSR is to lower the number of trials explicitly or accept that the raw edge isn't strong enough. We should ignore DSR modifications until the Holdout Degradation is investigated, as the Ensemble method acts as our primary defense.

## 4. Recommended First Real Experiment

The highest-value experiment leverages the new unified architecture to answer our oldest question: **Does the alpha survive strict execution mechanics and selectivity?**

We need to test a constrained parameter space focused on execution friction and high-probability signals.

**Experiment: `strict-execution-ensemble`**
- **Architecture:** Unified Swing Pipeline, top-3 Ensemble voting.
- **Constraints:** `maxPositions: 10` (up from 5, down from 50), `maxPerTicker: 3`.
- **Fills:** `fillMode: bidask` (We must enforce the bidask penalty to prove the edge survives true transaction costs).
- **IV Filter:** `minIVRank: 30` or `40` (We only want to sell premium when volatility is rich. The validation run allowed `0`, which is dangerous).
- **Signals:** Include the untested presets (`full`, `mb`, `adx`) alongside `vol` and `ema`. 
- **Profit Target Expansion:** Test `[0.3, 0.4, 0.5]` targets.

**Goal:** See if the Top-3 Ensemble can pull the Sharpe back above **2.0** under strict liquidity costs (`bidask`) while maintaining the portfolio M2M mathematics.

---

### Follow-Up Tasks for Claude (Executor)
1. Re-implement the Mechanical and Random benchmarks to use the actual `chain-cache` and `option-sim` evaluators. Approximations must be deleted.
2. Build and run the `strict-execution-ensemble` experiment defined above, and log the results with full metadata.
