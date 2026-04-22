---
task: Phase E4 — DTE5 IWM small-account campaign
stage: pre-reg
owner: claude
from: user
timestamp: 2026-04-22T05:00:00-04:00
---

## Objective

Test whether the validated DTE5 bull put credit spread structure generalizes from QQQ to IWM (Russell 2000 small-cap ETF). Phase E3 just killed DTE5 on individual mega-caps (sealed FAIL at holdoutSpyIR −1.19) because individual-name gaps blow through the 2.5× SL. ETFs don't have that single-name risk, so IWM is the real test of whether DTE5's edge is ETF-portable or QQQ-specific.

A sealed PASS here would give a 2-ETF credit-spread book (QQQ + IWM) with genuine factor diversification (large-cap tech vs small-cap). A sealed FAIL would narrow the edge to QQQ-only, with important implications for strategy design going forward.

## Pre-Registration

**Hypothesis**: A bull put credit spread on IWM with the DTE5 parameter set (short put δ≈0.30, long put δ≈0.20, DTE 2-7, SL 2.5× credit, trailing lock 50/50, EMA55 trend + SPY>EMA200 macro + EMA8>EMA13 momentum gates) earns positive risk-adjusted alpha over SPY across the 2024-01-22 → 2026-02-28 holdout window. IWM's small-cap factor exposure provides factor diversification from QQQ; if DTE5's edge is a broad-ETF structural edge (not QQQ-specific), IWM should clear the same adoption threshold QQQ cleared. Width $5 anchors the campaign (fits $2K account); $10 is a diagnostic variant.

**Config Grid**: 4 variants, all on IWM:

| Variant | Short δ | Width | Role |
|---|---:|---:|---|
| dte5-iwm-anchor | 0.30 | $5 | Anchor |
| dte5-iwm-tight | 0.25 | $5 | Short-delta robustness (lower) |
| dte5-iwm-wide | 0.35 | $5 | Short-delta robustness (upper) |
| dte5-iwm-w10 | 0.30 | $10 | Width robustness (diagnostic only — doesn't fit $2K) |

All share: long δ 0.20 (implicit via spread width), DTE 2-7, SL 2.5×, TL 50/50, hold-to-expiry (profitTarget=1.0, no time stop), fillMode=bidask, dynamic slippage. Defined in `scripts/autoresearch/strategy-dte5-iwm.ts`.

**Decision Rule**: Winner = variant with highest **selection-window combinedSharpe** (no holdout peek). Standard. Seal the winner via `scripts/evaluate-holdout.ts`.

**Adoption Threshold**: The sealed winner's row must satisfy ALL of:
- `holdoutSpyIR ≥ 0`
- `holdoutSharpe ≥ 0.3`
- `oosSharpe ≥ 0.8`
- `passesStability = true`
- `passesStatConsistency = true`
- `deflatedSharpeMertens > 0`

Any violation → seal FAIL, no live adoption. Decision-tree for next step:
- FAIL + OOS also bad (like Phase E3): DTE5 is QQQ-specific; move to structurally different designs
- FAIL + OOS good but holdout bad: parameter overfit to small-cap selection window; try tighter parameter ranges
- PASS: add IWM paper trading alongside QQQ

**Holdout Window Hash**: sha256:4bde4339e7cb212ab59bb19dc727321d020d410f7b3e394c5389a16c06e7dbc9

**Declared Env Overrides**: none

## Prior related seals

- DTE5 QQQ (validated, pre-post-overhaul): live paper trading at $1K
- PMCC pt50 QQQ: sealed PASS 2026-04-22 (holdoutSpyIR +0.26) — PR #8, branch phase-e2-pmcc-qqq-campaign
- PMCC tight-short QQQ: sealed FAIL 2026-04-22a
- DTE5 mega-cap (AAPL/MSFT/NVDA/GOOG): sealed FAIL 2026-04-22 (holdoutSpyIR −1.19) — branch phase-e3-dte5-megacap-sweep

## References

- Strategy file: `scripts/autoresearch/strategy-dte5-iwm.ts`
- Prior failure memo: `docs/holdout-evaluations/2026-04-22-200603aca360.md` (megacap)
- Sealed-holdout protocol: `docs/sealed-holdout.md`
- Validated DTE5-QQQ config: `src/lib/strategyProfiles.ts` (STRATEGY_PROFILES.dte5)
