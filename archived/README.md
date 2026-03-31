# Archived Code — Retired Strategies

**Archived:** 2026-03-30
**Reason:** Platform overhauled to DTE5 bull put credit spread (QQQ, sp30/20, EMA34) as the only active strategy. All prior strategies were retired after a pricing audit revealed phantom expiration profits inflating reported performance.

## What's Here

| Folder | Contents |
|--------|----------|
| `backtest/` | Retired backtest engine modules from `src/lib/backtest/` — VRP harvester, swing long option, debit spread exit, underlying sim, synthetic reprice, credit trade replay, signal data |
| `tests/` | Test files for the retired backtest modules — debit spread, swing, underlying, directional pipeline, option-native pipeline |
| `scripts/` | Analysis and WFA scripts for retired strategies — VRP (10 scripts), directional swing (2), option-native (2), swing loss analysis, spread comparison, and utility scripts |
| `experiments_data/` | Experiment JSON outputs from `data/experiments/` — debit spread, option-native, underlying, swing, and pullback config experiments |
| `backtesting-history/` | WFA results and reports for retired strategies — VRP harvester, directional swing, option-native swing, plus stale credit spread reports (full-sweep, sl-study, 130m-vs-4h, swing-loss-analysis) |
| `data/` | Stale WFA viewer JSON files — pre-audit results that powered the `/backtest` page (wfa-results, viewer-signals, viewer-configs) |

## Why Archived (Not Deleted)

These files document the research journey that led to the current validated DTE5 strategy. They may be useful for:
- Understanding why certain approaches were abandoned
- Reusing infrastructure patterns if new strategies are explored
- Historical audit trail

## Current Active Strategy

**DTE5 Bull Put Credit Spread** — QQQ only, sp30/20 (short 30-delta / long 20-delta), EMA34 gate, hold-to-expiry, $0 commissions (Robinhood). Validated via true portfolio growth WFA: $10K start, Sharpe 1.18, CAGR 38.8%, MaxDD 25.6%, WR 80%.

See `backtesting history/credit-spread/reports/spread-comparison/README.md` for full analysis.
