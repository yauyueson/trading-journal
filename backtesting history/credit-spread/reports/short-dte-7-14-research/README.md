# Short DTE 7-14 Research

Generated: 2026-05-06

## Goal

Test whether a tighter 7-14 DTE version of the short-term credit spread idea shows an alpha edge after the current simulator fixes, bid/ask fills, and explicit DTE/vol-regime gates.

This is exploratory research only. It is not a sealed-holdout adoption candidate.

## Tooling Changes

- `scripts/wfa-pipeline-short.ts`
  - Added `creditDTERanges` sweep support so the short pipeline can test `[7,14]` instead of the hardcoded `[7,21]`.
  - Enriched short-pipeline `EntrySignal`s with `vrp`, `contango`, `vrpPct`, and `contangoPct` from `orats_iv_cache`.
  - Added sweep support for `vrpFilters`, `contangoFilters`, `vrpPctFilters`, and `contangoPctFilters`.
- `src/lib/backtest/intraday-monitor.ts`
  - Enforced `vrpPctFilter` and `contangoPctFilter` during intraday credit-spread evaluation.
- `tests/wfa-short-pipeline.test.ts`
  - Added coverage that generated configs preserve 7-14 DTE and vol-regime filters.

Verification:

```bash
npx vitest run tests/wfa-short-pipeline.test.ts
npx tsc --noEmit
```

Both passed.

## Runs

### 1. Rich-Premium Gated Run

Config: `experiment.json`

```bash
npx tsx scripts/wfa-run-unified.ts --profile short --fill bidask --workers 1 --experiment 'backtesting history/credit-spread/reports/short-dte-7-14-research/experiment.json' --out short-dte-7-14-smoke-qqq.json
```

Note: the output filename says `smoke-qqq`, but the experiment config intentionally overrides the ticker set to `QQQ,IWM`.

| Metric | Value |
|---|---:|
| OOS Sharpe | 0.56 |
| Win Rate | 83.3% |
| Max DD | 0.1% |
| Total PnL | $148 |
| OOS Trades | 6 |
| Avg Trades / Week | 0.1 |

Verdict: rejected for sample starvation. The VRP/contango percentile gates cut the opportunity set too hard for a usable strategy.

### 2. Baseline No Vol Gates

Config: `baseline-no-vol-gates.json`

```bash
npx tsx scripts/wfa-run-unified.ts --profile short --fill bidask --workers 1 --experiment 'backtesting history/credit-spread/reports/short-dte-7-14-research/baseline-no-vol-gates.json' --out short-dte-7-14-baseline-no-vol-gates.json
```

| Metric | Value |
|---|---:|
| OOS Sharpe | 0.48 |
| Win Rate | 89.8% |
| Max DD | 0.9% |
| Total PnL | $1,111 |
| OOS Trades | 49 |
| Avg Trades / Week | 0.8 |

Ticker split:

| Ticker | Trades |
|---|---:|
| IWM | 28 |
| QQQ | 21 |

Exit split:

| Exit | Trades |
|---|---:|
| PROFIT_TARGET | 41 |
| TIME_STOP | 7 |
| EXPIRATION | 1 |

Per-window pattern:

| Window | OOS Trades | OOS Sharpe | Selected Shape |
|---:|---:|---:|---|
| 0 | 14 | 1.56 | `em`, d0.25, w10, tp50, iv0 |
| 1 | 16 | 1.68 | `vol`, d0.30, w10, tp50, iv20 |
| 2 | 4 | 1.70 | `em`, d0.30, w10, tp50, iv20 |
| 3 | 0 | 0.00 | `vol`, d0.30, w10, tp50, iv20 |
| 4 | 1 | 2.51 | `vol`, d0.25, w5, tp50, iv20 |
| 5 | 0 | 0.00 | `em`, d0.30, w10, tp50, iv20 |
| 6 | 13 | -2.19 | `em`, d0.25, w5, tp50, iv0 |
| 7 | 1 | -2.40 | `vol`, d0.20, w10, tp50, iv0 |

Verdict: not enough edge for adoption. The run finds trades and a high win rate, but aggregate Sharpe is weak, annualized return on $100k is tiny, two late OOS windows are negative, and the optimizer still selects unstable shapes.

## Research Conclusion

No production-worthy 7-14 DTE alpha edge found in this pass.

The most defensible candidate shape, if continuing research, is:

- QQQ/IWM bull put credit spreads
- 7-14 DTE
- Short delta 0.25-0.30
- $10 width
- 50% profit target
- No hard VRP/contango percentile gate
- Bid/ask fills
- Daily/130M monitoring

But the current evidence says this is at best a low-capacity paper-trading probe, not something to add beside BCD/PMCC. The next useful test would be fixed-config evaluation rather than adaptive WFA selection, because the adaptive selector is likely overfitting sparse train-window trades.
