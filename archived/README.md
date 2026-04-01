# Archived — Retired Strategies & Research

**Last cleaned:** 2026-04-01
**Reason:** Platform overhauled to DTE5 bull+bear credit spreads. All prior strategies retired after pricing audit revealed phantom expiration profits.

## What's Here

| Item | Contents |
|------|----------|
| `LESSONS.md` | **Start here** — Consolidated findings from 12 backtesting studies with methodology learnings |
| `scripts/` | Deprecated/one-off scripts (wfa-run.ts, credit-sweep.ts, debug tools, analysis scripts) |

## What Was Removed (2026-04-01 Cleanup)

The following were deleted from the repo. Git history preserves them if needed:

- `backtest/` — Retired engine modules (VRP harvester, swing long option, debit spread, underlying sim, synthetic reprice)
- `tests/` — Test files for retired modules
- `backtesting-history/` — Raw WFA result JSONs and study reports (12MB). Key findings preserved in LESSONS.md
- `data/` — Stale WFA viewer JSONs (6MB) from pre-audit `/backtest` page
- `experiments_data/` — Experiment config snapshots for retired strategies

## Current Active Strategy

**DTE5 Bull Put + Bear Call Portfolio** — QQQ bull (sp30/20, EMA34) + SPY/IWM bear (sp40/30, EMA21<34<55). Combined Sharpe 0.99, CAGR 40%.

See `backtesting history/credit-spread/reports/` for current validated results.
