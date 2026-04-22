---
task: Phase E8.c — DTE5 SPY (direction-corrected)
stage: pre-reg
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

## Context

- DTE5 QQQ v2 sealed FAIL (holdoutSpyIR -0.76), Phase E7
- DTE5 megacap v2 sealed FAIL (holdoutSpyIR -1.10), Phase E8a
- DTE5 IWM v2 sealed FAIL (holdoutSpyIR -0.62), Phase E8b
- Pattern: profitable absolute returns, lose to SPY in 2024-2026
- This phase completes the generalization test

## References

- Strategy file: `scripts/autoresearch/strategy-dte5-spy-v2.ts`
- Superseded Phase E5 seal: `docs/holdout-evaluations/2026-04-22-c458a47e4651.md`
