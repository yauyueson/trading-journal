---
task: Phase E2 — PMCC QQQ first sealed autoresearch campaign
stage: pre-reg
owner: claude
from: user
timestamp: 2026-04-22T00:00:00-04:00
---

## Objective

First sealed-holdout autoresearch campaign on the post-overhaul codebase for the PMCC (Poor Man's Covered Call) family on QQQ. The prior 30-ticker LEAP CALL family was confirmed dead on 2026-04-22 by bit-exact replicate of the 2026-04-18 naive-baseline diagnostic. PMCC is structurally different — theta from rolled short calls flips the holdout P&L regime vs naked long CALLs.

Engine: `simulateDiagonal` (Phase E1, merged as PR #7 f344f55) plus sync `makeDiagonalEvaluator` in the autoresearch worker (Phase E2 Step 1, commit a34238d + c5b8563). Strategy: `scripts/autoresearch/strategy-pmcc-qqq.ts`.

## Pre-Registration

**Hypothesis**: A systematic PMCC on QQQ — long deep-ITM LEAP (delta ~0.75, DTE ~270), rolled short OTM calls (delta ~0.25, DTE ~30-45) — earns positive risk-adjusted alpha over buy-and-hold SPY across the 2024-01-22 → 2026-02-28 holdout window. Primary edge mechanism: short-call theta captured during QQQ's drawdown and sideways periods cushions the long-leg beta exposure enough to beat SPY's risk-adjusted return.

**Config Grid**: 4 pre-registered variants, defined in `scripts/autoresearch/strategy-pmcc-qqq.ts`:

| Variant | Long δ | Long DTE | Long PT | Long SL | Long TS | Short δ | Short DTE | Short PT |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| pmcc-qqq-anchor (base) | [0.70, 0.80] | [240, 300] | 40% | 35% | 90 | [0.20, 0.30] | [30, 45] | 50% |
| pmcc-tight-short | [0.70, 0.80] | [240, 300] | 40% | 35% | 90 | [0.25, 0.35] | [25, 35] | 50% |
| pmcc-loose-short | [0.70, 0.80] | [240, 300] | 40% | 35% | 90 | [0.15, 0.25] | [35, 50] | 50% |
| pmcc-high-pt | [0.70, 0.80] | [240, 300] | 50% | 35% | 90 | [0.20, 0.30] | [30, 45] | 50% |

Roll trigger: `DTE ≤ 2 AND |spot/strike − 1| ≤ 0.02`. Fill model: `bidask` with dynamic slippage (inherited from DEFAULT_LEAP_CONFIG).

**Decision Rule**: Winner = variant with highest **selection-window combinedSharpe** (no holdout peek). Runner writes one row per variant to `data/leaderboard-full-pmcc-qqq.json`; agent-visible `scripts/autoresearch/leaderboard-pmcc-qqq.json` has holdout metrics stripped. The winner's row is then sealed via `scripts/evaluate-holdout.ts` against this pre-reg block's hash.

**Adoption Threshold**: The sealed winner's row must satisfy ALL of the following:
- `holdoutSpyIR ≥ 0` (core structural edge over SPY)
- `holdoutSharpe ≥ 0.3` (absolute risk-adjusted floor)
- `oosSharpe ≥ 0.8` (selection-window floor, mirrors DTE5's sealed bar)
- `passesStability = true` (holdout/OOS Sharpe ratio ∈ [0.5, 2.0])
- `passesStatConsistency = true` (bootstrap SE vs Mertens SE ratio ≤ 5.0x)
- `deflatedSharpeMertens > 0` (Bailey-López de Prado multiple-testing correction)

Any violation → seal file records FAIL, no live adoption, move on to next structurally-different candidate (likely PUT LEAPs or LEAP diagonals on a basket).

**Holdout Window Hash**: sha256:4bde4339e7cb212ab59bb19dc727321d020d410f7b3e394c5389a16c06e7dbc9

**Declared Env Overrides**: none

## References

- Design spec: `docs/superpowers/specs/2026-04-22-pmcc-qqq-campaign-design.md`
- Phase E1 implementation plan: `docs/superpowers/plans/2026-04-22-phase-e1-simulate-diagonal.md`
- Phase E1 PR: https://github.com/yauyueson/trading-journal/pull/7 (merged at f344f55)
- Sealed-holdout protocol: `docs/sealed-holdout.md`
- Prior LEAP family post-mortem: `scripts/autoresearch/diagnose-naive-baseline-results.md` (2026-04-18)
