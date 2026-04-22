---
task: Phase E8 — DTE5 generalization (direction-corrected): megacap v2
stage: pre-reg
owner: claude
from: user
timestamp: 2026-04-22T09:00:00-04:00
---

## Objective

Re-test DTE5 generalization to individual mega-caps after Phase E7 revealed a direction-encoding bug in Phase E3's strategy file. Phase E3 used `direction: 'PUT'` which maps to BEAR CALL credit spread; the canonical DTE5 bull put requires `direction: 'CALL'`. This v2 runs the same config with corrected direction + simplified canonical signal (close > EMA34).

Phase E3's sealed FAIL (holdoutSpyIR −1.19) tested bear call in a bull market, not DTE5 generalization. This phase provides the actual DTE5 generalization test.

## Pre-Registration

**Hypothesis**: A DTE5 bull put credit spread (short put δ ≈ 0.30, long put δ ≈ 0.20, DTE 2-7, SL 2.5× credit, trailing lock 50/50, hold-to-expiry, entry gate: close > EMA34) applied as a first-come-first-served portfolio across {AAPL, MSFT, NVDA, GOOG} with maxPositions=1 earns positive risk-adjusted alpha over SPY in the 2024-01-22 → 2026-02-28 holdout window. If DTE5's edge is a general large-cap credit-spread edge, individual mega-caps with liquid options should also pass. If it's QQQ-specific (ETF-only), this test will fail because individual earnings gaps will blow through the 2.5× SL.

**Config Grid**: 4 variants, all on {AAPL, MSFT, NVDA, GOOG} portfolio:

| Variant | Short δ | Width | Role |
|---|---:|---:|---|
| dte5-megacap-v2-anchor | 0.30 | $5 | Anchor |
| dte5-megacap-v2-tight | 0.25 | $5 | Short-delta robustness |
| dte5-megacap-v2-wide | 0.35 | $5 | Short-delta robustness |
| dte5-megacap-v2-w10 | 0.30 | $10 | Width robustness |

All share: long δ 0.20 (via width), DTE 2-7, SL 2.5×, TL 50/50, hold-to-expiry, fillMode=bidask, dynamic slippage, direction='CALL' (bull put), signal: close > EMA34. Defined in `scripts/autoresearch/strategy-dte5-megacap-v2.ts`.

**Decision Rule**: Winner = variant with highest **selection-window combinedSharpe**. Seal winner via `scripts/evaluate-holdout.ts`.

**Adoption Threshold**: The sealed winner's row must satisfy ALL of:
- `holdoutSpyIR ≥ 0`
- `holdoutSharpe ≥ 0.3`
- `oosSharpe ≥ 0.8`
- `passesStability = true`
- `passesStatConsistency = true`
- `deflatedSharpeMertens > 0`

**Holdout Window Hash**: sha256:4bde4339e7cb212ab59bb19dc727321d020d410f7b3e394c5389a16c06e7dbc9

**Declared Env Overrides**: none

## Process caveat

Phase E3 (PR #10, strategy-dte5-megacap.ts) and its sealed verdict are superseded by this Phase E8 re-run but not deleted — the seal is a permanent historical record. The E8 results represent the real DTE5 generalization test; E3 results represent what direction='PUT' does on megacaps in a bull market (tangentially informative: bear calls fail catastrophically).

## References

- Strategy file: `scripts/autoresearch/strategy-dte5-megacap-v2.ts`
- Superseded Phase E3 seal: `docs/holdout-evaluations/2026-04-22-200603aca360.md`
- Direction bug memo: `memory/dte5-qqq-sealed-fail-window-artifact.md`
- Sealed-holdout protocol: `docs/sealed-holdout.md`
