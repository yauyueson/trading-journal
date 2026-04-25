# Unsealed Sensitivity Sweeps + WFA Validation — BCD & PMCC (F1 anchors)

**Date:** 2026-04-24
**Strategies:** `bcd-qqq-wide-f1`, `pmcc-qqq-pt60-f1`
**Data:** QQQ daily candles, 2017-01-03 → 2026-02-27 (2,301 trading days)
**Runner:** [scripts/autoresearch/lean-sensitivity-runner.ts](lean-sensitivity-runner.ts)
**Status:** UNSEALED descriptive research. Did not touch trial ledger, pre-reg gate, or sealer. Zero dsrM attempts burned.

## Purpose

Map response surfaces for six single-parameter sweeps against the F1 sealed anchors, to decide which (if any) candidate variants are worth burning a sealed attempt on.

## Method

- Anchors: exact copies of the F1 sealed SimConfigs (see [strategy-bcd-qqq-wide-f1.ts](strategy-bcd-qqq-wide-f1.ts), [strategy-pmcc-qqq-pt60-f1.ts](strategy-pmcc-qqq-pt60-f1.ts))
- Variants: only the target parameter changed
- Evaluation: end-to-end on full data range, `maxPositions=1` portfolio gate (same as F1)
- Metrics: trade-level + portfolio-level via `computeOptionAnalytics(trades, { allTradingDates })`
- **No WFA split.** Descriptive, not adoption candidates. Full-history Sharpe is a response-surface signal, not an unbiased OOS estimate. Live candidates (below) need WFA OOS validation before pre-registration.

## Results summary

| # | Sweep | Anchor peaks? | Live alternative? |
|---|-------|:-:|:-:|
| 1 | BCD stop-loss | N/A (no SL is anchor) | **No** — any SL strictly worse |
| 2 | PMCC pin-roll threshold | ≈ | No — essentially inert (Sharpe spread ≤ 0.04) |
| 3 | BCD short-leg delta | **Yes** (d20) | No — moving either direction hurts |
| 4 | BCD DTE band | **Yes** (30-60) | No — moving either direction hurts |
| 5 | PMCC short-call PT | No | **Maybe** — pt30 +0.14 Sharpe, non-monotonic |
| 6 | PMCC long-leg SL | No | **Yes** — looser/none +0.12 Sharpe, much better PF |

Four of six variants confirm the anchor is at or near peak. Two — both on PMCC — suggest the sealed config is *not* at peak.

---

## 1. BCD — Stop-Loss Sensitivity

Hypothesis: Adding a mark-to-market stop-loss caps tail losses and improves Sharpe.

| Variant | Trades | WinRate | Sharpe | MtM DD | Realized DD | ROC | PF | TotalPnl |
|---------|-------:|--------:|-------:|-------:|------------:|----:|---:|---------:|
| **bcd-no-sl (F1 anchor)** | 99 | 65.7% | **0.79** | **3.2%** | **2.9%** | **20.9%** | **1.78** | **$13,186** |
| bcd-sl30 | 140 | 38.6% | 0.18 | 6.1% | 6.0% | 2.8% | 1.10 | $2,654 |
| bcd-sl50 | 124 | 50.0% | 0.32 | 7.0% | 6.5% | 6.4% | 1.20 | $5,412 |
| bcd-sl70 | 106 | 57.5% | 0.41 | 6.5% | 6.3% | 10.1% | 1.31 | $7,032 |

**Verdict: REJECT.** Any SL is strictly worse. No-SL Sharpe (0.79) is ~2× the best SL variant (0.41 for SL70). BCD is already defined-risk (max loss = debit paid); a stop-loss just clips recoverable dips.

## 2. PMCC — Pin-Risk Roll-Threshold Sensitivity

Hypothesis: Varying `diagRollTriggerMoneyness` (anchor 2%) changes risk-adjusted returns.

| Variant | Trades | WinRate | Sharpe | MtM DD | Realized DD | ROC | PF | TotalPnl |
|---------|-------:|--------:|-------:|-------:|------------:|----:|---:|---------:|
| pmcc-roll-never | 42 | 59.5% | 1.27 | 5.2% | 4.4% | 26.6% | 3.39 | $50,405 |
| pmcc-roll-1pct | 42 | 59.5% | 1.26 | 5.2% | 4.4% | 26.4% | 3.37 | $50,076 |
| **pmcc-roll-2pct (anchor)** | 42 | 59.5% | 1.25 | 5.3% | 4.5% | 26.2% | 3.36 | $49,599 |
| pmcc-roll-3pct | 42 | 59.5% | 1.25 | 5.3% | 4.5% | 26.2% | 3.36 | $49,606 |
| pmcc-roll-5pct | 42 | 59.5% | 1.23 | 5.3% | 4.5% | 25.6% | 3.31 | $48,523 |

**Verdict: REJECT (INERT).** Sharpe spread ≤ 0.04 across range. The `diagRollTriggerMoneyness` field only gates the DTE≤2 pin-risk branch, which rarely fires during QQQ's 2017-2026 trend. Field is effectively dead weight.

## 3. BCD — Short-Leg Delta (round 2)

Hypothesis: Shifting the short-call delta reshapes the spread width and payoff profile.

| Variant | Trades | WinRate | Sharpe | MtM DD | Realized DD | ROC | PF | TotalPnl |
|---------|-------:|--------:|-------:|-------:|------------:|----:|---:|---------:|
| bcd-short-d15 | 92 | 59.8% | 0.68 | 4.2% | 4.1% | 19.4% | 1.69 | $12,677 |
| **bcd-short-d20 (anchor)** | 99 | 65.7% | **0.79** | **3.2%** | **2.9%** | **20.9%** | **1.78** | **$13,186** |
| bcd-short-d25 | 96 | 64.6% | 0.59 | 3.3% | 2.9% | 15.1% | 1.53 | $8,163 |
| bcd-short-d30 | 99 | 65.7% | 0.49 | 2.7% | 2.3% | 11.4% | 1.40 | $5,321 |

**Verdict: ANCHOR AT PEAK.** Both narrower (d15) and wider (d25-d30) hurt Sharpe. Confirms the F0 sweep's selection of "wide" (long d0.50 / short d0.20) as optimal. Don't pre-register alternatives.

## 4. BCD — DTE Band (round 2)

Hypothesis: Shifting the DTE window changes theta/gamma/beta mix.

| Variant | Trades | WinRate | Sharpe | MtM DD | Realized DD | ROC | PF | TotalPnl |
|---------|-------:|--------:|-------:|-------:|------------:|----:|---:|---------:|
| bcd-dte-21-45 | 118 | 61.0% | 0.56 | 3.1% | 2.7% | 13.9% | 1.49 | $8,698 |
| **bcd-dte-30-60 (anchor)** | 99 | 65.7% | **0.79** | **3.2%** | **2.9%** | **20.9%** | **1.78** | **$13,186** |
| bcd-dte-45-75 | 76 | 67.1% | 0.68 | 4.1% | 3.8% | 18.1% | 1.76 | $10,369 |
| bcd-dte-60-90 | 69 | 60.9% | 0.47 | 4.5% | 4.4% | 12.3% | 1.44 | $7,219 |

**Verdict: ANCHOR AT PEAK.** 30-60 beats both shorter (21-45) and longer (45-75, 60-90) DTE bands. Shorter DTE collects less premium per trade; longer DTE accumulates gamma-exit drag. Don't pre-register alternatives.

## 5. PMCC — Short-Call Profit Target (round 2)

Hypothesis: Short-call PT controls how often we roll the premium-collecting leg.

| Variant | Trades | WinRate | Sharpe | MtM DD | Realized DD | ROC | PF | TotalPnl |
|---------|-------:|--------:|-------:|-------:|------------:|----:|---:|---------:|
| **pmcc-short-pt30** | 42 | 57.1% | **1.39** | **4.7%** | **4.1%** | **26.9%** | **3.59** | **$51,008** |
| pmcc-short-pt40 | 42 | 57.1% | 1.27 | 5.2% | 4.4% | 25.5% | 3.32 | $48,420 |
| **pmcc-short-pt50 (anchor)** | 42 | 59.5% | 1.25 | 5.3% | 4.5% | 26.2% | 3.36 | $49,599 |
| pmcc-short-pt60 | 42 | 57.1% | 1.33 | 4.8% | 4.3% | 24.4% | 3.20 | $46,283 |
| pmcc-short-pt70 | 42 | 57.1% | 1.11 | 5.6% | 4.9% | 21.3% | 2.78 | $40,313 |

**Verdict: MAYBE.** pt30 tops the anchor on every metric (Sharpe +0.14, MtM DD −0.6pp, PnL +$1,409). BUT the shape is non-monotonic (pt30 > pt60 > pt40 > pt50 > pt70), which is a yellow flag: a clean monotonic response is more robust, and non-monotonic signals often don't survive window perturbations. Interpret effect size as plausible, not proven.

**Next step before any pre-reg:** re-run pt30 + anchor under WFA with the same selection/holdout split the F1 anchor was sealed under. If OOS Sharpe lift ≥ +0.10 AND holdoutSpyIR stays positive, consider pre-reg.

## 6. PMCC — Long-Leg Stop-Loss (round 2) ⭐ strongest finding

Hypothesis: Long-LEAP SL controls how we react to deep drawdowns.

| Variant | Trades | WinRate | Sharpe | MtM DD | Realized DD | ROC | PF | TotalPnl |
|---------|-------:|--------:|-------:|-------:|------------:|----:|---:|---------:|
| pmcc-long-sl25 | 55 | 45.5% | 1.08 | 6.1% | 5.1% | 15.5% | 2.53 | $38,952 |
| **pmcc-long-sl35 (anchor)** | 42 | 59.5% | 1.25 | 5.3% | 4.5% | 26.2% | 3.36 | $49,599 |
| **pmcc-long-sl45** | 37 | 67.6% | 1.32 | 4.5% | 4.1% | 29.5% | 3.79 | **$50,892** |
| pmcc-long-sl55 | 31 | 67.7% | 1.25 | 5.1% | 4.5% | 37.5% | 4.70 | $50,165 |
| **pmcc-long-sl-none** | 24 | 83.3% | **1.37** | **4.0%** | 4.0% | **44.3%** | **7.69** | $47,029 |

**Verdict: LIVE CANDIDATE.** Monotonic improvement from tight → loose SL across almost every metric. `sl-none` wins on Sharpe (+0.12 vs anchor), MtM DD (−1.3pp), PF (7.69 vs 3.36), winRate (83%), ROC (44% vs 26%). `sl45` is nearly as good with more trades. Same structural pattern as BCD's SL result: long-optionality trades punish premature stop-outs.

**Warning:** end-to-end evaluation on a 2017-2026 bull market. "No SL" looks great when the underlying trends up — but catastrophic in a sustained bear where the LEAP decays 60%+ and you ride it down. The 83% win rate comes partly from survivorship: fewer trades, each held longer, means more of the sample is during QQQ's strong trend days. This finding especially needs WFA + holdout validation before sealed pre-reg.

**Next step before any pre-reg:**
1. Re-run `pmcc-long-sl-none` and `pmcc-long-sl45` under WFA with the anchor's selection/holdout split.
2. Check holdoutSpyIR, holdoutSharpe, and especially the 2022 QQQ drawdown (-35%) period — did sl-none ride through and recover, or did it leave a permanent scar?
3. Check realizedExitDrawdown across WFA windows, not just MtM.

## Candidates — WFA validation (2026-04-24, same day)

Ran the three live candidates through the F1 anchor's WFA structure (10 selection + 5 holdout windows, rolling 252/126/10, $10K starting capital, maxPositions=1). See [lean-wfa-runner.ts](lean-wfa-runner.ts), output [lean-wfa-pmcc-candidates.json](lean-wfa-pmcc-candidates.json).

### Selection OOS (2019-01-17 → 2024-01-19, 10 windows)
| Variant | Trades | Sharpe | MaxDD | TotalPnl |
|---|---:|---:|---:|---:|
| pmcc-pt60-f1 (anchor) | 28 | **1.72** | 17.5% | $34,408 |
| pmcc-long-sl45 | 21 | 1.72 | 16.1% | $36,082 |
| pmcc-long-sl-none | 14 | **1.41** | **27.9%** | $28,985 |
| **pmcc-short-pt30** | 28 | **1.76** | 16.9% | $35,166 |

### Holdout (2024-01-22 → 2026-02-27, 5 windows)
| Variant | Trades | Sharpe | MaxDD | SPY IR | Ann. excess | TotalPnl |
|---|---:|---:|---:|---:|---:|---:|
| pmcc-pt60-f1 (anchor) | 11 | 1.63 | 12.5% | **+0.15** | 1.8% | $18,669 |
| pmcc-long-sl45 | 8 | 1.22 | 11.9% | **−0.21** | −2.2% | $13,267 |
| pmcc-long-sl-none | 5 | 1.22 | 12.1% | **−0.04** | −0.5% | $12,010 |
| **pmcc-short-pt30** | 11 | **1.71** | **10.8%** | **+0.18** | **2.3%** | $19,807 |

### Verdicts

1. **`pmcc-long-sl-none` — REJECT.** The end-to-end "no SL is best" finding was survivorship bias. Selection window `sel-w6` (2022 bear) Sharpe is −1.27 for sl-none vs −0.63 for anchor — the LEAP actually compounded losses during the 2022 QQQ drawdown instead of stopping out. Selection MaxDD almost doubles (17.5% → 27.9%). Holdout SPY IR goes negative. Not a tail risk concern, a realized disaster. **The 2022 stress check was decisive.**

2. **`pmcc-long-sl45` — REJECT.** Looks fine on selection (Sharpe matches anchor) but holdoutSpyIR flips to **−0.21** — the 2024-2026 holdout punishes it. Not robust across the selection/holdout boundary.

3. **`pmcc-short-pt30` — LIVE CANDIDATE, PARKED.** The ONLY variant that beats the anchor on both selection AND holdout:
   - Selection Sharpe +0.04 (1.76 vs 1.72)
   - Holdout Sharpe +0.08 (1.71 vs 1.63)
   - Holdout SPY IR +0.03 (+0.18 vs +0.15)
   - Holdout MaxDD −1.7pp (10.8% vs 12.5%)
   - Per-window Sharpe profile nearly identical to anchor → not a different risk exposure

   Effect size is small but consistent, which is what WFA is for. **Do not pre-register yet** — at global attemptNumber 106, +0.04 Sharpe will almost certainly fail dsrM deflation. Park for post-2026-10-20 holdout refresh when effective N resets.

## Summary for the log

Out of 6 single-parameter sweep axes examined on 2026-04-24, end-to-end identified 2 live candidates. Under WFA + holdout validation, 1 survived (pt30). That 1 candidate is parked pending holdout refresh, because the current dsrM ceiling would reject its effect size.

Zero sealed attempts burned. Zero changes to the F1 anchors (still the live paper-traded strategies).

## Files

- [lean-sensitivity-bcd-sl.json](lean-sensitivity-bcd-sl.json)
- [lean-sensitivity-pmcc-roll.json](lean-sensitivity-pmcc-roll.json)
- [lean-sensitivity-bcd-short-delta.json](lean-sensitivity-bcd-short-delta.json)
- [lean-sensitivity-bcd-dte.json](lean-sensitivity-bcd-dte.json)
- [lean-sensitivity-pmcc-short-pt.json](lean-sensitivity-pmcc-short-pt.json)
- [lean-sensitivity-pmcc-long-sl.json](lean-sensitivity-pmcc-long-sl.json)
- [lean-wfa-pmcc-candidates.json](lean-wfa-pmcc-candidates.json) — WFA validation of the 3 candidates
- [lean-sensitivity-runner.ts](lean-sensitivity-runner.ts) — 6 named sensitivity sweeps, `LEAN_SWEEP=<name>|all`
- [lean-wfa-runner.ts](lean-wfa-runner.ts) — WFA runner, 4 variants (anchor + 3 candidates)

## Files

- [lean-sensitivity-bcd-sl.json](lean-sensitivity-bcd-sl.json)
- [lean-sensitivity-pmcc-roll.json](lean-sensitivity-pmcc-roll.json)
- [lean-sensitivity-bcd-short-delta.json](lean-sensitivity-bcd-short-delta.json)
- [lean-sensitivity-bcd-dte.json](lean-sensitivity-bcd-dte.json)
- [lean-sensitivity-pmcc-short-pt.json](lean-sensitivity-pmcc-short-pt.json)
- [lean-sensitivity-pmcc-long-sl.json](lean-sensitivity-pmcc-long-sl.json)
- [lean-sensitivity-runner.ts](lean-sensitivity-runner.ts) — 6 named sweeps, `LEAN_SWEEP=<name>|all`

## Code changes

Minimal, additive:

- [src/lib/backtest/option-sim.ts](../../src/lib/backtest/option-sim.ts): added optional `debitStopLossPct` field to `SimConfig`
- [scripts/autoresearch/worker.ts](worker.ts): `makeDebitSpreadEvaluator` checks `debitStopLossPct` before PT branch. No behavior change when unset.

Verified: `npx tsc --noEmit` clean. `tests/scoring-parity.test.ts` (307 tests) + `tests/option-sim-fills.test.ts` (13 tests) all pass.
