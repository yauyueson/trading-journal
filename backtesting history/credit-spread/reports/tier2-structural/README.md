# Tier 2: Structural Improvements — Results

**Date:** 2026-04-01
**Baseline:** QQQ bull + QQQ/SPY/IWM bear, shared $10K, 10% risk/leg
**Methodology:** 16 rolling WFA windows (252d train, 126d test), 2017-2026

## Summary

| Metric | Baseline | D: Dynamic Sizing | E: Corr Weights | F: Regime Tilt | D+E+F |
|--------|----------|--------------------|-----------------|----------------|-------|
| Sharpe | **1.026** | 1.008 | **1.037** | 0.891 | 0.916 |
| CAGR | 40.3% | 42.2% | 40.5% | 42.5% | 45.0% |
| MaxDD | **39.2%** | 44.3% | **38.8%** | 62.8% | 62.1% |
| Trades | 751 | 751 | 751 | 751 | 751 |

**All three experiments failed to beat baseline on risk-adjusted basis.**

---

## Experiment D: Dynamic Position Sizing

**Hypothesis:** Scale 0.5x-1.5x based on composite regime confidence (EMA separation, IV rank, trend depth, pullback proximity).

**Result: NEUTRAL (noise)**

- dSharpe: -0.017 (within noise band)
- CAGR increases +2% but MaxDD increases +5pp
- Confidence buckets show predictive power (High WR 80.4% vs Low 60%), but:
  - Only 5 trades in Low bucket (statistically meaningless)
  - 87% of trades (654/751) land in Mid bucket
  - Signal is too concentrated to differentiate sizing

**Conclusion:** The confidence signal has weak discrimination power. Most trades get similar scores, so the multiplier adds noise rather than signal.

---

## Experiment E: Correlation-Aware Portfolio Construction

**Hypothesis:** QQQ/SPY bears are ~90% correlated. Inverse-correlation weighting should reduce MaxDD.

**Result: REJECT** (but produced useful finding)

**Correlation Matrix:**
```
         QQQ     SPY     IWM
QQQ    1.000   0.930   0.751
SPY    0.930   1.000   0.858
IWM    0.751   0.858   1.000
```

- Correlations are high across the board (0.75-0.93)
- Inverse-correlation weights barely differ: QQQ 10%, SPY 9.5%, IWM 10.5%
- dSharpe: +0.011, dMaxDD: -0.4pp (not meaningful)

**Redundancy Check (important):**

| Config | Sharpe | CAGR | MaxDD | Trades |
|--------|--------|------|-------|--------|
| All 4 legs (baseline) | 1.026 | 40.3% | 39.2% | 751 |
| Drop SPY bear | 0.851 | 27.0% | 42.5% | 627 |
| Drop QQQ bear | **1.035** | 39.0% | **32.9%** | 731 |

- **SPY bear is essential** despite 0.93 QQQ correlation. Dropping it kills Sharpe (-17%).
- **QQQ bear is the weakest leg** (only 20 trades). Dropping it:
  - Maintains Sharpe (1.026 -> 1.035)
  - Reduces MaxDD by 6.3pp (39.2% -> 32.9%)
  - Only loses 20 trades and $4K P&L

**Actionable:** Consider removing QQQ bear from production portfolio (simplifies to QQQ bull + SPY/IWM bear).

---

## Experiment F: Regime-Adaptive Allocation

**Hypothesis:** Tilt bull-heavy in uptrends, bear-heavy in downtrends using SPY EMAs.

**Result: REJECT**

**Regime Distribution:**
- Strong bull: 59.9% of days
- Mild bull: 13.2%
- Neutral: 4.7%
- Mild/strong bear: 22.2%

| Tilt Level | Sharpe | CAGR | MaxDD |
|-----------|--------|------|-------|
| Baseline (50/50) | **1.026** | 40.3% | **39.2%** |
| Mild (55/45) | 0.872 | 40.4% | 62.0% |
| Moderate (65/35) | 0.884 | 41.6% | 60.3% |
| Aggressive (75/25) | 0.891 | 42.5% | 62.8% |

- All tilts **increase MaxDD by ~20pp** while Sharpe drops 13-15%
- CAGR only marginally improves (+0.1% to +2.2%)
- Root cause: EMA-based regime classification lags — you're still "strong bull" when crashes begin, overweighting the losing side

**Conclusion:** Market timing via EMAs doesn't help portfolio allocation. The lag inherent in trend-following indicators makes the tilt counterproductive at regime transitions.

---

## Key Takeaways

1. **Simple beats complex.** Fixed 10%, equal weight, binary EMA gates outperform all structural improvements.
2. **Correlation weighting fails** because all three tickers are too correlated (0.75-0.93) for meaningful differentiation.
3. **Regime tilting hurts** because EMA lag causes you to overweight the wrong direction at transitions.
4. **QQQ bear is removable** — only 20 trades, and dropping it cuts MaxDD by 6pp without hurting Sharpe. This is the only actionable finding.
5. **The confidence signal exists but is useless** — 87% of trades get medium confidence. The signal doesn't discriminate well enough to adjust sizing.
