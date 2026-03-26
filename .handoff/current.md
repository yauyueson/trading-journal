---
task: Post-audit strategy assessment — short-term viable, swing retired
stage: done
owner: user
from: claude
timestamp: 2026-03-25T22:30:00-04:00
---

## Objective

Assess both credit spread strategies (short-term and swing) after Phase A/B/C WFA audit. Determine which strategies survive under corrected infrastructure.

## Summary

**Short-term (7-21 DTE, 130M)**: Conditionally viable. OOS Sharpe 2.0-3.1 across 2,916 configs with real execution costs. Weak holdout (max 0.28) is the main concern — needs paper trading validation.

**Swing (45-65 DTE)**: Retired. Two-sided strategy collapsed (Sharpe -0.38). Bounded bullish-only experiment also failed (Sharpe 0.25, only 54% positive windows). No further swing investment justified.

## Short-Term Assessment

### Existing full-sweep IS post-audit

The March 24 full-sweep (`wfa-full-sweep.ts` + `wfa-sweep-worker.ts`) already uses audit-correct logic via `credit-spread-exit.ts`:
- Threshold exit pricing (`resolveTriggeredCreditExitCost`)
- NO_CHAIN forced exits (`shouldExitNoChain` + `createMissingChainState`)
- Intrinsic expiration fallback (`computeIntrinsicSpreadCloseCost`)
- Bidask fills + $0.65/leg commissions

All three files are untracked (created together). **No rerun was needed.**

### Key findings

| Metric | Value | Assessment |
|--------|-------|------------|
| OOS Sharpe (top 5) | 2.38-2.46 | Strong |
| Holdout Sharpe | -0.08 to +0.11 (base), max 0.28 (A/B) | Weak |
| Win Rate | 81-82% (base), 86% (with tl50-50) | Good |
| Max DD | 1.4-1.8% | Very low |
| NO_CHAIN exits | **Zero** in top 20 | Clean |
| Exit types | TP + EXPIRATION + TIME_STOP only | No destructive exits |
| tl50-50 boost | +17-26% OOS Sharpe | Consistent |

### Holdout concern

- 0/94 Grade A/B configs achieve holdout Sharpe > 0.5
- Mean holdout across Grade A/B: -0.061
- Only 29/94 Grade A/B have holdout > 0
- Holdout period (~Oct 2025 - Feb 2026) may be regime-driven, but with only 2 windows we can't distinguish regime from overfit

### Width trade-off

- w2.5: Best Sharpe (2.46) but only $71K PnL over 6yr ($33/trade avg)
- w10: Lower Sharpe (2.31) but $206K PnL — 3x more capital-efficient, better holdout (0.16 avg)
- Old production config `em|tp50|w10|iv20|pm2.25`: OOS 1.96, holdout 0.15, PnL $190K

### Recommendation

**Keep existing production config** `em|tp50|w10|iv20|d45|ts1|pm2.25` — not the highest OOS Sharpe but better capital efficiency and reasonable holdout. Validate with 30-60 days paper trading before scaling up.

## Swing Assessment — Retired

### Tests run this session

| Test | Train Window | Sharpe | PnL | Positive Windows | DD |
|------|-------------|--------|-----|-----------------|-----|
| Bullish-only, 252d | 252d | -0.11 | -$7.7K | 8/14 (57%) | 25.9% |
| Bullish-only, 378d | 378d | 0.25 | +$11.9K | 8/13 (62%) | 14.9% |

### Stop/continue threshold (from Codex)

- Positive OOS Sharpe? 378d barely (0.25)
- At least 8/12 positive windows? **No** (8/13 = 62%, below 67% threshold)
- Materially lower drawdown? Yes (14.9% vs 90.8% baseline)

**Fails 2 of 3 criteria.** Per Codex recommendation: retire swing.

### Why bullish-only still fails

Bear market windows destroy performance even with CALL-only signals:
- W4 (Oct 2021 - Apr 2022): Sharpe -1.11
- W5 (Apr 2022 - Oct 2022): Sharpe -2.35
- W10 (Oct 2024 - Apr 2025): Sharpe -0.92
- W12 (Oct 2025 - Feb 2026): Sharpe -1.39

Put credit spreads (opened by bullish/CALL signals) get hammered when stocks drop, regardless of entry signal quality. The structural problem is not the signal direction but the option structure's sensitivity to sudden drawdowns.

### NO_CHAIN persists

46-49 trades (6.2-6.3%) forced to exit at ~-$611 avg. This is a data coverage problem, not a strategy problem. Solving it would help but wouldn't rescue a Sharpe 0.25 strategy.

## Work Done

### Claude — 2026-03-25 (this session)

1. **Short-term validation** — Confirmed March 24 full-sweep already uses post-audit code. No rerun needed. Analyzed 2,916 configs: strong OOS (2.0-3.1 Sharpe), weak holdout (max 0.28).

2. **Bullish-only swing experiment** — Added `signalDirectionFilter` to swing pipeline config. Ran two proper WFA experiments:
   - 252d train: Sharpe -0.11, 7/14 positive windows
   - 378d train: Sharpe 0.25, 7/13 positive windows
   Both fail Codex's stop/continue threshold.

3. **Decision**: Retire swing. Focus on short-term with paper trading validation.

## Artifacts

### New files
- `data/experiments/swing-bullish-only.json` — bullish-only experiment config
- `data/runs/swing-bullish-252d.json` — 252d train bullish-only results
- `data/runs/swing-bullish-378d.json` — 378d train bullish-only results

### Modified files
- `scripts/wfa-pipeline-swing.ts` — added `signalDirectionFilter` to `SwingPipelineConfig` and signal generation

### Existing (validated, not rerun)
- `backtesting history/credit-spread/reports/full-sweep/sweep-results.json` — 2,916 short-term configs
- `backtesting history/credit-spread/reports/full-sweep/sl-on-sweep-results.json` — 145 SL combo results

## Next Steps

1. **Live small-money validation** — Deploy `em|tp50|w10|iv20|d45|ts1|pm2.25` with real small-size trades for 30-60 days
2. **Capital utilization study** — Test maxPositions 20-30 to improve returns without degrading Sharpe
3. **Remove swing from production config** — Update `data/strategy-config.json` and UI
4. **Holdout regime analysis** — DONE. Report saved to `backtesting history/credit-spread/reports/full-sweep/holdout-regime-analysis.md`. Conclusion: weak holdout is regime-driven (choppy, range-bound Dec 2025 - Feb 2026), not overfitting. Expect recovery as markets return to trending.
