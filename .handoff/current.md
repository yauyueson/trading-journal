---
task: Phase E2b — PMCC QQQ longPT=0.50 confirmation campaign
stage: pre-reg
owner: claude
from: user
timestamp: 2026-04-22T03:30:00-04:00
---

## Objective

Second sealed-holdout autoresearch campaign on PMCC QQQ. Phase E2a sealed FAIL on 2026-04-22 with the decision-rule winner `pmcc-tight-short` (holdoutSpyIR −0.234). That campaign surfaced an anomaly: the non-winning variant `pmcc-high-pt` (longPT=0.50 instead of 0.40) passed all declared adoption criteria (holdoutSpyIR +0.259). Under sealed-holdout discipline we cannot retroactively pick the anomaly as the winner — we must pre-register it as a named anchor and re-seal.

Phase E2b does exactly that, with two neighboring profit-target values as robustness checks.

## Pre-Registration

**Hypothesis**: A PMCC on QQQ with long-leg profit target 0.50 (close the LEAP at +50% on premium) earns positive risk-adjusted alpha over SPY in the 2024-01-22 → 2026-02-28 holdout window. The higher profit target vs Phase E2a's 0.40 is expected to let the LEAP ride more of QQQ's 2024-2025 rally before closing, which — combined with the rolled short-call theta — produces positive SPY-excess return unlike the lower-PT siblings. Robustness check: adjacent profit targets 0.45 and 0.55 should show similar direction if the 0.50 pass was real edge and not a single-point artifact.

**Config Grid**: 3 configs, all sharing base PMCC structure (long δ [0.70, 0.80], long DTE [240, 300], short δ [0.20, 0.30], short DTE [30, 45], long SL 0.35, long TS DTE 90, short PT 0.50, roll trigger 0.02):

| Variant | Long Profit Target | Role |
|---|---:|---|
| pmcc-pt50-anchor | 0.50 | Sealed candidate |
| pmcc-pt45 | 0.45 | Robustness check (diagnostic only) |
| pmcc-pt55 | 0.55 | Robustness check (diagnostic only) |

Always-in entry. Fill model: bidask with dynamic slippage. Defined in `scripts/autoresearch/strategy-pmcc-qqq.ts`.

**Decision Rule**: The sealed candidate is the NAMED ANCHOR `pmcc-pt50-anchor`, regardless of whether it has the highest selection combinedSharpe. This is a confirmation-of-effect design. The two neighbor variants (pt45, pt55) are diagnostic — their sealed-holdout metrics are reported in the seal ceremony's context but are NOT the sealed candidate. Only `pmcc-pt50-anchor` gets a seal file.

**Adoption Threshold**: The sealed anchor's row must satisfy ALL of the following:
- `holdoutSpyIR ≥ 0` (core structural edge over SPY)
- `holdoutSharpe ≥ 0.3` (absolute risk-adjusted floor)
- `oosSharpe ≥ 0.8` (selection-window floor, mirrors DTE5's sealed bar)
- `passesStability = true` (holdout/OOS Sharpe ratio ∈ [0.5, 2.0])
- `passesStatConsistency = true` (bootstrap SE vs Mertens SE ratio ≤ 5.0x)
- `deflatedSharpeMertens > 0` (Bailey-López de Prado multiple-testing correction)

Robustness context (NOT gating; reviewer judgement):
- If pt45 AND pt55 BOTH have positive holdoutSpyIR → robust edge (accept anchor's seal)
- If anchor passes but both neighbors fail → single-point artifact, anchor seal is confirmed but flagged as fragile in the seal file's footer
- If anchor passes and exactly one neighbor passes → partial robustness, flagged

**Holdout Window Hash**: sha256:4bde4339e7cb212ab59bb19dc727321d020d410f7b3e394c5389a16c06e7dbc9

**Declared Env Overrides**: none

## References

- Phase E2a seal (FAIL): `docs/holdout-evaluations/2026-04-22-b6947551239a.md`
- Phase E2a pre-reg: same window's prior block (hash b6947551239a...)
- Design spec: `docs/superpowers/specs/2026-04-22-pmcc-qqq-campaign-design.md`
- Sealed-holdout protocol: `docs/sealed-holdout.md`
- Strategy file: `scripts/autoresearch/strategy-pmcc-qqq.ts` (blob will change vs E2a)
