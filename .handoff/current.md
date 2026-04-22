---
task: Phase E8.c — DTE5 SPY (direction-corrected)
stage: sealed
owner: claude
from: user
timestamp: 2026-04-22T10:00:00-04:00
---

## Objective

Complete the DTE5 generalization retest by running SPY with corrected direction (bull put, not bear call). Phase E5 had the direction bug. This closes the loop on "DTE5 generalization to other ETFs/tickers".

## Pre-Registration

**Hypothesis**: A DTE5 bull put credit spread on SPY (short put δ ≈ 0.30, long put δ ≈ 0.20, DTE 2-7, SL 2.5× credit, trailing lock 50/50, hold-to-expiry, entry: close > EMA34) earns positive risk-adjusted alpha over SPY in the 2024-01-22 → 2026-02-28 holdout window. This is the most circular of the tests (entry on SPY benchmark, compared to SPY benchmark), so the question is specifically "can DTE5 extract theta above SPY's beta return in SPY's own bullish regimes".

**Config Grid**: 4 variants on SPY:

| Variant | Short δ | Width |
|---|---:|---:|
| dte5-spy-v2-anchor | 0.30 | $5 |
| dte5-spy-v2-tight | 0.25 | $5 |
| dte5-spy-v2-wide | 0.35 | $5 |
| dte5-spy-v2-w10 | 0.30 | $10 |

**Decision Rule**: Winner = variant with highest **selection-window combinedSharpe**. Seal winner.

**Adoption Threshold**: holdoutSpyIR ≥ 0, holdoutSharpe ≥ 0.3, oosSharpe ≥ 0.8, passesStability, passesStatConsistency, deflatedSharpeMertens > 0.

**Holdout Window Hash**: sha256:4bde4339e7cb212ab59bb19dc727321d020d410f7b3e394c5389a16c06e7dbc9

**Declared Env Overrides**: none

## Sealed outcome (post-run)

dte5-spy-v2-wide sealed FAIL at holdoutSpyIR −1.01 (holdoutSharpe 0.45 passes floor; OOS Sharpe 0.92 + OOS PnL +$4,999 profitable). Same window-artifact pattern as Phase E7/E8a/E8b. See `docs/holdout-evaluations/2026-04-22-ce851216a353.md`.

## Context (sealed series complete as of 2026-04-22)

- PMCC pt50 QQQ: sealed PASS (+0.26 SPY IR) — **only adoption candidate**
- DTE5 QQQ v2 re-val: sealed FAIL (holdoutSpyIR −0.76), Phase E7
- DTE5 megacap v2: sealed FAIL (holdoutSpyIR −1.10), Phase E8a
- DTE5 IWM v2: sealed FAIL (holdoutSpyIR −0.62), Phase E8b
- DTE5 SPY v2: sealed FAIL (holdoutSpyIR −1.01), Phase E8c

Pattern: all 4 DTE5 candidates profitable in absolute terms but lose to SPY in 2024-2026 Mag7-rally window. Only PMCC's LEAP+rolled-short structure captures enough upside to beat SPY.

## References

- Strategy file: `scripts/autoresearch/strategy-dte5-spy-v2.ts`
- Superseded Phase E5 seal: `docs/holdout-evaluations/2026-04-22-c458a47e4651.md`
