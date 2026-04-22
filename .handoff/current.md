---
task: Phase E8.b — DTE5 IWM (direction-corrected)
stage: pre-reg
owner: claude
from: user
timestamp: 2026-04-22T09:30:00-04:00
---

## Objective

Re-test DTE5 on IWM after fixing the direction-encoding bug that affected Phase E4. Canonical DTE5 signal (close > EMA34) + direction='CALL' (bull put credit spread).

Phase E4's sealed FAIL (holdoutSpyIR -0.43) tested bear call, not bull put. This phase provides the actual IWM generalization test.

## Pre-Registration

**Hypothesis**: A DTE5 bull put credit spread on IWM (short put δ ≈ 0.30, long put δ ≈ 0.20, DTE 2-7, SL 2.5× credit, trailing lock 50/50, hold-to-expiry, entry: close > EMA34) earns positive risk-adjusted alpha over SPY in the 2024-01-22 → 2026-02-28 holdout window. Prediction based on DTE5-QQQ-v2 (sealed FAIL −0.76) and DTE5-megacap-v2 (sealed FAIL −1.10): IWM likely shows the same "profitable in absolute, loses to SPY" pattern.

**Config Grid**: 4 variants on IWM:

| Variant | Short δ | Width |
|---|---:|---:|
| dte5-iwm-v2-anchor | 0.30 | $5 |
| dte5-iwm-v2-tight | 0.25 | $5 |
| dte5-iwm-v2-wide | 0.35 | $5 |
| dte5-iwm-v2-w10 | 0.30 | $10 |

**Decision Rule**: Winner = variant with highest **selection-window combinedSharpe**. Seal winner.

**Adoption Threshold**: holdoutSpyIR ≥ 0, holdoutSharpe ≥ 0.3, oosSharpe ≥ 0.8, passesStability, passesStatConsistency, deflatedSharpeMertens > 0.

**Holdout Window Hash**: sha256:4bde4339e7cb212ab59bb19dc727321d020d410f7b3e394c5389a16c06e7dbc9

**Declared Env Overrides**: none

## References

- Strategy file: `scripts/autoresearch/strategy-dte5-iwm-v2.ts`
- Superseded Phase E4 seal: `docs/holdout-evaluations/2026-04-22-1ac17d7b29c4.md`
- Direction bug memo: `memory/dte5-qqq-sealed-fail-window-artifact.md`
