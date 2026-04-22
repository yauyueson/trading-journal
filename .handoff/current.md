---
task: Phase E6 — PMCC on lower-priced growth names ($2K-friendly)
stage: pre-reg
owner: claude
from: user
timestamp: 2026-04-22T07:00:00-04:00
---

## Objective

Test whether the validated PMCC-QQQ-pt50 structure (Phase E2b sealed PASS, holdoutSpyIR +0.26) generalizes to lower-priced individual growth names that fit a $2K account at entry. Portfolio of HOOD + PLTR, both $20-40 range during selection period, growing materially into holdout.

The hypothesis: PMCC's "capture upside via deep-ITM LEAP + collect short-call theta" structure should benefit from higher IV (individual names) and sustained directional moves (HOOD went $10→$114, PLTR $16→$184 across the evaluation window).

## Pre-Registration

**Hypothesis**: A PMCC on a HOOD+PLTR portfolio with long-leg profit target 0.50 (validated on QQQ) earns positive risk-adjusted alpha over SPY in the 2024-01-22 → 2026-02-28 holdout window. Individual-name growth underlyings provide higher IV (richer short-call theta) and sustained directional moves (LEAP long leg captures upside) vs an index. If the PMCC structure has a true structural edge, it should generalize. If it's QQQ-specific (like DTE5 proved to be in Phase E3), this campaign will fail.

**Config Grid**: 4 variants, all on {HOOD, PLTR} portfolio (maxPositions=1, first-come-first-served):

| Variant | Long PT | Short δ | Short DTE | Role |
|---|---:|---:|---:|---|
| pmcc-lowprice-anchor | 0.50 | [0.20, 0.30] | [30, 45] | Anchor (mirrors pt50-QQQ) |
| pmcc-lowprice-tight-short | 0.50 | [0.25, 0.35] | [25, 35] | Short-side sensitivity |
| pmcc-lowprice-pt45 | 0.45 | [0.20, 0.30] | [30, 45] | Long-PT sensitivity (lower) |
| pmcc-lowprice-pt55 | 0.55 | [0.20, 0.30] | [30, 45] | Long-PT sensitivity (upper) |

All share: long δ [0.70, 0.80], long DTE [240, 300], long SL 0.35, long TS DTE 90, short PT 0.50, roll trigger 0.02, monitoringIntervalDays 1, fillMode=bidask with dynamic slippage. Defined in `scripts/autoresearch/strategy-pmcc-lowprice.ts`.

**Decision Rule**: Winner = variant with highest **selection-window combinedSharpe** (no holdout peek). Standard decision rule. Seal via `scripts/evaluate-holdout.ts`.

**Adoption Threshold**: The sealed winner's row must satisfy ALL of:
- `holdoutSpyIR ≥ 0`
- `holdoutSharpe ≥ 0.3`
- `oosSharpe ≥ 0.8`
- `passesStability = true`
- `passesStatConsistency = true`
- `deflatedSharpeMertens > 0`

## Capital scaling caveat

HOOD and PLTR grew materially during the evaluation window:
- HOOD: $18 (2022) → $10 (2023) → $114 (2025-12)
- PLTR: $18 (2022) → $16 (2023) → $184 (2025-12)

A PMCC's capital requirement scales linearly with underlying price. At $2K starting, HOOD/PLTR PMCCs fit when underlying is <$50 (capital ~$1K-1.5K) but would exceed the account when underlying is $100+. The simulator does NOT enforce "can't afford position" — it opens trades regardless of notional. This pre-reg accepts that evaluation is portfolio-level (strategy edge) rather than per-position affordability (live capital).

Adoption implication: a PASS here says the PMCC structure has edge on these underlyings; it does NOT say you can deploy $2K live against this portfolio today (you can't — HOOD/PLTR at current prices need more capital per position). A live deployment would require either (a) lower-price underlyings or (b) scaled-up account size.

## Prior related seals

- PMCC pt50 QQQ: sealed PASS (PR #8), holdoutSpyIR +0.26
- PMCC tight-short QQQ: sealed FAIL (PR #8), holdoutSpyIR −0.23 — long-PT too tight
- DTE5 mega-cap (AAPL/MSFT/NVDA/GOOG): sealed FAIL catastrophic (PR #10) — individual names broken for DTE5
- DTE5 IWM: sealed FAIL (PR #9) — profitable but lags SPY
- DTE5 SPY: sealed FAIL (PR #11) — decision-rule winner fails; w10 variant interesting

**Holdout Window Hash**: sha256:4bde4339e7cb212ab59bb19dc727321d020d410f7b3e394c5389a16c06e7dbc9

**Declared Env Overrides**: none

## References

- Strategy file: `scripts/autoresearch/strategy-pmcc-lowprice.ts`
- Sealed-holdout protocol: `docs/sealed-holdout.md`
- PMCC engine: `simulateDiagonal` + `makeDiagonalEvaluator` (on this branch, inherited from PR #8)
- Validated PMCC-QQQ config: `scripts/autoresearch/strategy-pmcc-qqq.ts` (this branch)
