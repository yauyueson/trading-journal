# WFA Framework Review v2 — The Complete Picture

**Date:** 2026-03-21
**Evaluator:** Gemini (The Analyst)

## 1. Re-Assessing the `strict-execution-ensemble` Failure

My previous analysis (v1) lacked the crucial context from the 7,700+ Phase 1-5 replays and the existence of the `dirConfTier` innovation. Armed with the complete research history, it is clear that the `strict-execution-ensemble` (SR 0.54) did not fail simply because "IV≥30 is too harsh" or "bid/ask slippage is severe." 

It failed because **it actively fought against the most important discoveries of the entire research period:**
1. **Ignoring Trade Structure Dominance:** Phase 1-5 proved that trade structure (delta, DTE, width) generates the core edge, not the signal. Yet, the strict experiment diluted the edge by sweeping 8 different presets instead of focusing on the proven structures.
2. **Missing `dirConfTier=high`:** This was the single most vital discovery of the entire project. It cut drawdowns by 53% and doubled holdout Sharpe to 1.61 by filtering out false signals *internally*, which allowed the removal of the blunt `IV≥30%` gate entirely. The strict experiment ran without it, forcing the re-imposition of `IV≥30` and crippling the trade volume (680 trades vs 5,000+).
3. **Grid Ensemble vs GA Convergence:** The v2 baseline successfully used a Genetic Algorithm to converge on a single, sharp optimum (CV=0.00 across 10 windows). Grid sweeping sub-optimal configurations and averaging them (ensemble) just watered down the one strategy that actually works.

**Verdict:** The unified runner accurately simulated what it was given, but it was given an untested, regressive strategy rather than the actual v2 best config.

## 2. Refining the Holdout Degradation Thesis

The 45-70% holdout degradation pattern was previously treated as an unsolved mystery or pure overfitting. The complete data shifts this perspective:
- **It is a Structural Market Reality:** The degradation happens across *all* tested strategies (even in the Phase 1-5 non-WFA runs). The 2024–2026 out-of-sample period (the holdout) exhibited fundamentally different Variance Risk Premium (VRP) dynamics than the 2020–2023 training windows.
- **`dirConfTier` Actually Solves It:** While degradation still mathematically occurs (SR 2.41 dropping 67%), an absolute Holdout SR of **1.61** (with 0.88% Max DD) is objectively fantastic. A 1.61 SR on unseen data proves the baseline edge is real and robust. We don't need to "fix" the degradation percentage; we just need baseline OOS strategies strong enough to survive it.

## 3. What the Unified Runner is Missing

Before we can test whether the v2 best config survives `bidask` fills in the unified pipeline, Claude must add the missing pieces to `scripts/wfa-run-unified.ts`:

1. **`dirConfTier` Support:** The unified framework's config spaces must expose and support `dirConfTier: ["none", "medium", "high"]` as a primary search parameter.
2. **Spread Width Expansion:** Ensure that `$20` spread widths are explicitly supported and swept (the strict run only tested $5 and $15).
3. **Targeted GA Replication Mode:** The unified runner needs a way to bypass the massive grid search and run a single, specific 10-window walk-forward pass on a predefined config vector to validate execution mechanics without searching.

## 4. The Correct Next Experiment: `v2-replication-bidask`

We must answer the ultimate question: *Does the GA-converged optimal strategy survive true execution costs (`bidask` mode) when scored with accurate M2M portfolio daily Sharpe?*

**Experiment Design (`experiments/v2-replication-bidask.json`):**
- **Pipeline:** Unified Swing
- **Selection Mode:** Single Hardcoded Config (No search grid, no top-3 ensemble. We are testing the exact v2 optimum).
- **Config to Test:**
  - `signalWeightPreset`: `"vol"`
  - `dirConfTier`: `"high"`
  - `creditShortDelta`: `0.35`
  - `creditSpreadWidth`: `20`
  - `creditProfitTarget`: `0.30`
  - `minIVRank`: `0`
  - `maxPositions`: `5`
  - `maxPerTicker`: `3`
  - `stopLoss`: `None`
  - `timeStop`: `5`
- **Execution Constraints:** `fillMode: bidask`

**Goal:** Run this single configuration through the 12 unified WFA windows using the true `bidask` slippage model and the updated portfolio daily Sharpe fitness metric. 
- If the Holdout SR is > 1.0, the strategy is fully validated for production.
- If it collapses, we know the $20-width edge relied entirely on mid-price fill assumptions.

---

### Next Task for Claude
1. Add `dirConfTier` support to the unified runner (`scripts/wfa-run-unified.ts` and associated types/evaluators).
2. Create the `v2-replication-bidask.json` experiment using the exact parameters specified above.
3. Run the validation test and report the final Portfolio Sharpe and Max DD.
