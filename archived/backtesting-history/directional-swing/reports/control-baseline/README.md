# Underlying Control Baseline

Canonical stock-first control for future directional and option-wrapper research.

## Control Artifact

- Experiment: `data/experiments/underlying-control-baseline.json`
- Run: `data/runs/2026-03-28T02-55-03-632-unified-directional.json`
- Main report: `backtesting history/directional-swing/reports/README.md`
- Deeper loss report: `backtesting history/directional-swing/reports/underlying-loss-analysis/README.md`

## Definition

- Universe: `SPY, QQQ, AMD, IWM, TSLA, AAPL, JPM, NVDA, AMZN, MSFT, META, NFLX, GOOG, GS`
- Strategy: underlying-only directional benchmark
- Entry families: `pb8` and `pb21`
- Selection: separate competing candidates only
- Portfolio: `maxPositions=3`, `maxPerTicker=1`, fixed `$10k` notional
- No blending
- No regime router
- No extra entry filters

## Top Line

| Metric | Value |
| --- | --- |
| OOS Sharpe | 0.70 |
| OOS Total PnL | $33,790 |
| OOS Win Rate | 43.2% |
| OOS Max DD | 6.8% |
| Trades | 301 |
| Positive Windows | 9/12 |

## Winning Window Selection

| Window Group | Winning Source |
| --- | --- |
| W0-W8 | `pb8` |
| W9-W11 | `pb21` |

## Canonical Use

Use this as the default comparator for:

- any stock-only overlay
- any signal-filter experiment
- any option wrapper

Any future strategy should be compared against this exact control before being considered an improvement.
