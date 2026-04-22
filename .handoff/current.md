---
task: Phase E7 — DTE5 QQQ re-validation under sealed-holdout protocol
stage: pre-reg
owner: claude
from: user
timestamp: 2026-04-22T08:00:00-04:00
---

## Objective

Re-validate the active live DTE5 QQQ bull put credit spread under the post-overhaul sealed-holdout protocol. The strategy was originally validated pre-overhaul and is currently live paper-trading at $1K per CLAUDE.md, but carries no sealed record under the current trust regime. A sealed PASS here gives DTE5 QQQ the same discipline stamp as PMCC-pt50-QQQ (Phase E2b sealed PASS 2026-04-22).

Confirmation-of-effect design: the NAMED ANCHOR `dte5-qqq-live-anchor` mirrors the production config exactly (STRATEGY_PROFILES.dte5 in `src/lib/strategyProfiles.ts`) and is always the sealed candidate regardless of which variant has the highest selection combinedSharpe. Two neighbor variants (width $5 and width $20) serve as robustness checks only.

## Pre-Registration

**Hypothesis**: A QQQ bull put credit spread with DTE5 parameters (short put δ 0.30, long put δ 0.20 via $10 spread width, DTE 2-7, SL 2.5× credit, trailing lock 50/50, hold-to-expiry, EMA55 trend + SPY>EMA200 macro + EMA8>EMA13 momentum gates) earns positive risk-adjusted alpha over SPY in the 2024-01-22 → 2026-02-28 holdout window. This is a re-validation of an already-live strategy under the sealed-holdout regime, not new strategy discovery. Expected outcome: sealed PASS with holdoutSpyIR clearly above 0 (prior validation reported OOS Sharpe 1.44, holdout ~0.84).

**Config Grid**: 3 configs, all identical except spread width:

| Variant | Width | Role |
|---|---:|---|
| dte5-qqq-live-anchor | $10 | **Sealed candidate (matches live config)** |
| dte5-qqq-w5 | $5 | Robustness (narrower; diagnostic) |
| dte5-qqq-w20 | $20 | Robustness (wider; diagnostic) |

All share: short δ 0.30, long δ 0.20 (implicit via width), DTE 2-7, SL 2.5×, TL 50/50, hold-to-expiry (profitTarget=1.0, no time stop), fillMode=bidask with dynamic slippage. Defined in `scripts/autoresearch/strategy-dte5-qqq-reval.ts`.

**Decision Rule**: The sealed candidate is the NAMED ANCHOR `dte5-qqq-live-anchor` regardless of whether it has the highest selection combinedSharpe. This is a confirmation-of-effect design mirroring Phase E2b PMCC pt50. The width variants (w5, w20) are diagnostic — their sealed-holdout metrics are reported in the seal's footer but are NOT the sealed candidate. Only `dte5-qqq-live-anchor` gets a seal file.

**Adoption Threshold**: The sealed anchor's row must satisfy ALL of:
- `holdoutSpyIR ≥ 0`
- `holdoutSharpe ≥ 0.3`
- `oosSharpe ≥ 0.8`
- `passesStability = true` (holdout/OOS Sharpe ratio ∈ [0.5, 2.0])
- `passesStatConsistency = true` (bootstrap SE vs Mertens SE ratio ≤ 5.0x)
- `deflatedSharpeMertens > 0` (Bailey-López de Prado multiple-testing correction — N=3 variants)

Robustness context (NOT gating):
- If w5 AND w20 BOTH have positive holdoutSpyIR → robust plateau, strong confidence
- If anchor passes but both neighbors fail → single-width artifact, anchor seal is confirmed but flagged as fragile
- If anchor FAILS but neighbors pass → important diagnostic about width sensitivity

**Holdout Window Hash**: sha256:4bde4339e7cb212ab59bb19dc727321d020d410f7b3e394c5389a16c06e7dbc9

**Declared Env Overrides**: none

## Motivation

Why re-validate a strategy that's already validated + live?

1. **Trust parity**: all other sealed strategies on main (PMCC pt50 QQQ sealed PASS) will have post-overhaul sealed records. DTE5 QQQ — the PRIMARY live strategy — should have the same audit anchor.
2. **Methodology confidence**: Phase E3-E5 showed that non-QQQ DTE5 variants fail the tightened holdoutSpyIR gate. Re-running DTE5-QQQ through the same protocol confirms the strategy's edge isn't a stale pre-overhaul artifact — it should clear the same bar E3/E4/E5 failed.
3. **Documentation**: sealed evaluation creates a dated record (`docs/holdout-evaluations/2026-04-22-*.md`) that outlives CLAUDE.md's prose description.

## Prior related seals

- PMCC pt50 QQQ: sealed PASS (PR #8), holdoutSpyIR +0.26
- DTE5 mega-cap (AAPL/MSFT/NVDA/GOOG): sealed FAIL (PR #10)
- DTE5 IWM: sealed FAIL (PR #9)
- DTE5 SPY: sealed FAIL (PR #11)
- PMCC lowprice (HOOD/PLTR): inconclusive (infrastructure limit, E6)

## References

- Strategy file: `scripts/autoresearch/strategy-dte5-qqq-reval.ts`
- Canonical live config: `src/lib/strategyProfiles.ts` (STRATEGY_PROFILES.dte5)
- Sealed-holdout protocol: `docs/sealed-holdout.md`
