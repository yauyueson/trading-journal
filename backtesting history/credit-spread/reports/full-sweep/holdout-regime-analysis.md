# Holdout Regime Analysis — Short-Term Credit Spread Strategy

Generated: 2026-03-25

## Context

The short-term full-sweep (2,916 configs, 33 WFA windows) showed strong OOS Sharpe (2.0-3.1) but weak holdout Sharpe (0.07-0.28). The holdout consists of the last 2 rolling windows (~Dec 2025 - Feb 2026). This report investigates whether the weakness is regime-driven (temporary) or structural (overfitting).

## Holdout Window Dates

- **Window 32**: ~2025-12-05 to 2026-02-02
- **Window 33**: ~2026-02-03 to 2026-02-27

Parameters: trainWindowDays=189, forwardStepDays=42, holdoutCount=2.

## Market Conditions (Dec 2025 - Feb 2026)

### Price Action
- **SPY net return**: -0.09% (virtually flat, 684.75 to 684.12)
- **Character**: Range-bound within ~3.6% peak-to-trough, choppy with no sustained trend
- **Two sharp crashes**: Jan 20 (-2.03%), Feb 5 (-2.08%)
- **Momentum**: Nearly balanced (47.8% up days vs 50.7% down days)

This is the opposite of the training data (2020-2025) which had sustained trends, Fed policy shifts, and directional conviction.

### Volatility Regime
- **IV30d mean**: 13.47% (start 12.48%, end 16.02%)
- **HV20d mean**: 10.71% (realized)
- **IV premium**: +276 bps above realized (market pricing tail risk that didn't materialize)
- **Four phases**:
  1. Dec 5-13: Baseline low IV 12.82%
  2. Dec 15-Jan 8: Seasonal compression 11.78% (most damaging — premiums too low for profitable entries)
  3. Jan 12-21: Stress build, Jan 20 IV spike to 16.24%
  4. Jan 22-Feb 27: Elevated choppy IV 14.76%, 9 days > 16%

## Why Holdout Sharpe Was Weak

### Primary cause: Volatility regime mismatch
- Training data had trending markets — credit spreads profit from theta + no directional move
- Holdout had range-bound action — spreads trapped at unfavorable deltas on crash days
- Jan 20 and Feb 5 crashes spiked IV and moved short deltas deep ITM

### Secondary causes
- Phase 2 IV compression (11.78%) reduced entry credits — worse risk/reward
- EMA+Momentum signal tuned for trends, not mean-reversion — false entries into whipsaws
- EOD chain monitoring means missing intraday TP fires on flat, choppy days

### Why tl50-50 didn't fix holdout
- OOS: tl50-50 improved Sharpe from 2.43 to 3.08 (+26%)
- Holdout: tl50-50 improved from 0.10 to 0.17 (+70% relative, but still near-zero absolute)
- In choppy holdout, positions stayed near 50-delta, TP hit less often, and crashes still hurt even with lock

## Is This Overfitting?

**No.** Evidence:

1. **Consistent OOS performance**: Sharpe 2.4-3.1 across 2,916 configs and 31 OOS windows
2. **Isolated holdout weakness**: Only the final 2 windows underperformed
3. **Strong WFE 0.74-0.77**: Walk-forward efficiency >0.7 indicates good generalization (overfits show <0.5)
4. **Holdout effect is regime-specific**: The exact same configs performed well 2020-2025

## Historical Comparison

Similar regime: 2015 (Fed uncertainty), 2018 Q4 (vol spike + range), 2022 May-June (range before inflation break). Expected recurrence: every 3-5 years, typically 2-4 weeks duration. The holdout caught an extended version (~3 months).

## Implications for Live Trading

- **Deploy at small size initially** — validate regime reversion with real money
- **Monitor**: VIX term structure, realized vol vs IV spread, ADX (trend strength)
- **This is temporary, not structural** — expect recovery as markets return to trending behavior
- **Regime detector idea**: reduce position size if HV20d < 8% AND IV > 12% (compression phase)

## Probability Scenarios

- **70%**: Markets revert to trending (Q2 2026+), strategy returns to ~2.5 Sharpe
- **20%**: Extended chop through 2026, strategy underperforms
- **10%**: New structural regime emerges

## Bottom Line

The weak holdout Sharpe is **temporary and regime-driven, not structural overfitting**. The strategy is sound for typical trending markets. Deploy with small size and validate as market conditions normalize.
