---
task: Phase E5 — DTE5 SPY small-account campaign
stage: pre-reg
owner: claude
from: user
timestamp: 2026-04-22T06:00:00-04:00
---

## Objective

Third ETF-level test in the DTE5 generalization series. Tests whether DTE5's validated bull put credit spread structure generalizes from QQQ to SPY (S&P 500, broader/more-diversified than QQQ). IWM failed (Phase E4, small-cap underperformance during 2024-2026). SPY is the "gold standard" broad-market ETF; if DTE5 works there, the edge is a general large-cap-ETF-structure edge, not QQQ-specific. If it fails, the edge is narrower than that.

Note on circularity: DTE5-SPY uses SPY>EMA200 as its macro gate, and the adoption threshold evaluates against SPY itself as benchmark. This is structurally honest — the strategy can still beat SPY on risk-adjusted basis even while entering only in SPY-bullish regimes — but worth noting in interpretation.

## Pre-Registration

**Hypothesis**: A bull put credit spread on SPY with the DTE5 parameter set (short put δ≈0.30, long put δ≈0.20, DTE 2-7, SL 2.5× credit, trailing lock 50/50, EMA55 trend + SPY>EMA200 macro + EMA8>EMA13 momentum gates) earns positive risk-adjusted alpha over SPY buy-and-hold across the 2024-01-22 → 2026-02-28 holdout window. The macro gate's circularity (same-ticker entry filter) makes this a "can DTE5 extract theta above SPY's beta return in bullish regimes" question. Width $5 anchors the campaign (fits $2K account); $10 is a diagnostic variant.

**Config Grid**: 4 variants, all on SPY:

| Variant | Short δ | Width | Role |
|---|---:|---:|---|
| dte5-spy-anchor | 0.30 | $5 | Anchor |
| dte5-spy-tight | 0.25 | $5 | Short-delta robustness (lower) |
| dte5-spy-wide | 0.35 | $5 | Short-delta robustness (upper) |
| dte5-spy-w10 | 0.30 | $10 | Width robustness |

All share: long δ 0.20, DTE 2-7, SL 2.5×, TL 50/50, hold-to-expiry, fillMode=bidask, dynamic slippage. Defined in `scripts/autoresearch/strategy-dte5-spy.ts`.

**Decision Rule**: Winner = variant with highest **selection-window combinedSharpe** (no holdout peek). Seal via `scripts/evaluate-holdout.ts`.

**Adoption Threshold**: The sealed winner's row must satisfy ALL of:
- `holdoutSpyIR ≥ 0`
- `holdoutSharpe ≥ 0.3`
- `oosSharpe ≥ 0.8`
- `passesStability = true`
- `passesStatConsistency = true`
- `deflatedSharpeMertens > 0`

Decision-tree for FAIL:
- Absolute returns negative (like Phase E3 megacap): structure is broken on SPY
- Absolute returns positive but holdoutSpyIR < 0 (like Phase E4 IWM): strategy works, SPY beats it via beta — hard to add value on top of its own benchmark; pivot to structurally different designs
- PASS: SPY DTE5 joins QQQ DTE5 + PMCC pt50 QQQ as a validated 3-strategy book

**Holdout Window Hash**: sha256:4bde4339e7cb212ab59bb19dc727321d020d410f7b3e394c5389a16c06e7dbc9

**Declared Env Overrides**: none

## Prior related seals

- DTE5 QQQ: validated (pre-overhaul), live paper at $1K
- PMCC pt50 QQQ: sealed PASS (PR #8)
- PMCC tight-short QQQ: sealed FAIL
- DTE5 mega-cap (AAPL/MSFT/NVDA/GOOG): sealed FAIL catastrophic (PR #10)
- DTE5 IWM: sealed FAIL (positive abs returns, lags SPY) (PR #9)

## References

- Strategy file: `scripts/autoresearch/strategy-dte5-spy.ts`
- Sealed-holdout protocol: `docs/sealed-holdout.md`
- Validated DTE5-QQQ config: `src/lib/strategyProfiles.ts`
