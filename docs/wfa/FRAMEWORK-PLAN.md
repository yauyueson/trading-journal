# WFA Unified Framework — Design & Migration Plan

**Date:** 2026-03-21
**Purpose:** Provide a rigorous, consolidated blueprint to replace WFA v1/v2/v3 with a unified, statistically robust Walk-Forward Analysis (WFA) pipeline.

---

## 1. Unified Pipeline Architecture

Currently, the WFA ecosystem is fragmented into daily (swing) vs intraday (short) logic across `v1`, `v2`, and `v3`. The unified pipeline will expose a single entry point that parameterizes the execution layer.

- **Single Entry Point:** `scripts/wfa-run-unified.ts`
- **Core Engine:** A consolidated orchestrator that conditionally invokes 4H repricing vs daily closing marks based on the specified `profile`.
- **Profiles Module:** Define parameter spaces and execution constraints as composable configurations (`v2-swing`, `v3-short-4h`, etc.).
- **Evaluation Metric:** ALL optimizations must optimize for portfolio daily mark-to-market Sharpe, NOT trade-hold Sharpe (`sqrt(252/avgHoldDays)` is deprecated entirely for WFA fitness).

## 2. Statistical Validation Protocol

The current framework calculates statistics (DSR, PBO, Permutation) but they are mostly decorative or implemented incorrectly for credit spread distributions.

- **Deflated Sharpe Ratio (DSR):** The threshold model must be appropriately scaled to the actual number of trials run (e.g. 100 or 400). If the expected max Sharpe is structurally inflated beyond the observed Sharpe due to broad search, the window must be gated empty (no trades).
- **Correcting the Permutation Test:** Standard trade-level permutation testing fails on credit spreads because most trades are winners regardless of shuffle order, inflating the p-value to ~1.0. We will switch to a **portfolio equity curve block bootstrap** or drop order-based permutation for trade-level PnL in favor of comparing actual Sharpe to randomized entry Sharpe.
- **Top-K Ensemble Selection:** Rather than picking the single `argmax` config which maximizes winner's curse variance, select the Top-K (e.g. K=5) configs that pass the DSR guardrail. The final OOS signal is a majority vote or rank-weighted combination.

## 3. Holdout Protocol

The 45-70% holdout degradation must be structurally isolated and diagnosed. 

- **Structure:** 
  - `Train` (e.g., 252-504 days) → `Step/OOS` (63-126 days) → `Purge` gap (21-65 days).
  - `Holdout`: The last N days (e.g. 252 for swing, 63 for short) of the dataset is **strictly reserved**. The optimizer pipeline can never view data past the Holdout threshold.
- **Degradation Measure:** The pipeline will report `OOS Average Sharpe`, `Holdout Sharpe`, and explicit `Degradation %`.
- **Diagnosis Tools:** Track Regime matches. Is the holdout in a regime unobserved during train/OOS? Compare the Top-K parameters from the final OOS window against parameter decay over time to warn of structural shifts.

## 4. Benchmark Suite

WFA results must validate that the edge is unique and not just harvesting generic equity risk premium. The unified runner will output a comparative scorecard:

1.  **Naive Strategy (Baseline):** Buy-and-Hold SPY.
2.  **Naive Premium Selling:** Mechanical ATM put-selling on SPY at target DTE (no technical signals).
3.  **Random Entry (Monte Carlo):** A dummy signal preset that randomly enters spread positions but applies the optimizer's target structural exits (stop loss, DTE time stop, TP%). If random entry achieves the same Sharpe, the technical alpha is zero.

## 5. Reproducibility & Stability

- **Deterministic Seeds:** CLI must allow `--seed <hash>`. The GA/TPE and data splitters must be perfectly deterministic.
- **Metadata Logging:** Output results as `data/runs/{timestamp}-unified-{profile}.json` containing:
  - Exact CLI arguments
  - Git commit hash
  - Target SQLite DB hash/stats
  - Reproducibility command string (e.g., `npx tsx scripts/wfa-run-unified.ts --profile swing --seed 42 --filters...`)
- **Parameter Drift Penalization:** Track Coefficient of Variation (CV) for structural variables (delta, width). If CV > 0.3 across windows, the strategy is flagged as highly unstable.

## 6. Incremental Migration Path

Do not perform an all-or-nothing rewrite.
1.  **Phase A:** Implement the single entry point `wfa-run-unified.ts` and ensure it can transparently pass through to the legacy `v2` orchestration logic for the `swing` profile.
2.  **Phase B:** Implement the portfolio-M2M evaluation constraint and Top-K ensemble selection within the unified structure.
3.  **Phase C:** Implement the permutation test correction, benchmark wrapper, and reproducibility logger.
4.  **Phase D:** After validation, delete the deprecated `wfa-v3`, `.mjs` files, and `v1` redundant scripts.

## 7. Validation Test

Before promoting the unified framework, we must prove it hasn't regressed on existing known-good models.
- **Step 1:** Run `wfa-run-unified.ts --profile swing --seed 42 --universe 15-name`
- **Goal:** Reproduce the original best v2 swing results (`data/wfa-v2-results-swing.json`): roughly `SR ~2.4`, `WR ~94%`, `DD ~1.7%`.
- **Success Criteria:** The evaluation metrics must match within a tight tolerance boundary. Only after this validation passes can the new methodology gating/ensemble modifications be turned on to see how they "downgrade" or true-up the baseline result.

## 8. Experimentation System & Advisor Mode

To support the constant research cycle (like the No-ADX test or v3 Intraday 4H tests), the framework will support rapid iterations:
- **Experiment Config Interface:** Pass `--experiment custom-preset.json`, overriding base profile parameters seamlessly. The system outputs side-by-side comparison tables against the base profile's historical JSON log.
- **"Advisor" Recommendation Engine:**
  - A CLI subcommand `npx tsx scripts/wfa-run-unified.ts analyze --advisor`
  - The framework reads all prior `data/runs/*.json` files.
  - It generates a Pareto analysis reporting parameter voids (e.g. "We have never searched `minIVRank` < 10 with `1H` candles").
  - It recommends 3 new configs/boundaries to iteratively execute next to maximize global parameter space coverage.

---

### End of Plan
