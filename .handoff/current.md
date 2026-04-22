---
task: Phase E10 — Bull call debit spread QQQ ($2K-friendly)
stage: pre-reg
owner: claude
from: user
timestamp: 2026-04-22T12:00:00-04:00
---

## Objective

Test bull call debit spread on QQQ as a capital-efficient alternative to the outright long call (Phase E9). Phase E9 showed long calls with HIGH delta captured positive holdoutSpyIR (+0.055 to +0.28) but failed the 45% MaxDD gate (60-65% drawdown). The debit spread caps max loss at net debit — if the short-leg cushion brings MaxDD under 45% while preserving positive SPY IR, this structure could PASS full sealed adoption at $2K.

Engine note: Phase E10 also wires `makeDebitSpreadEvaluator` into the autoresearch worker (previously "not fully wired" per `scripts/autoresearch/program.md`). This unblocks DEBIT_SPREAD mode for future campaigns.

## Pre-Registration

**Hypothesis**: A bull call debit spread on QQQ (buy call at δ 0.50, sell call at δ 0.30, same expiry, DTE 30-60, PT 50% of max profit, min exit DTE 7, signal: close > EMA34) earns positive risk-adjusted alpha over SPY AND keeps MaxDD < 45% during the 2024-01-22 → 2026-02-28 holdout window. The short-leg premium reduces max loss per trade from ~$500-800 (outright long call) to ~$200-400 (spread), with proportionally reduced upside (bounded by spread width). Compared to Phase E9 long calls, expected tradeoff: lower absolute PnL, materially lower MaxDD, holdoutSpyIR possibly preserved (same directional capture, just capped).

**Config Grid**: 4 variants on QQQ:

| Variant | Long δ | Short δ | PT % | Role |
|---|---:|---:|---:|---|
| bull-call-debit-qqq-anchor | 0.50 | 0.30 | 50% | Anchor |
| bull-call-debit-qqq-narrow | 0.50 | 0.40 | 50% | Tighter spread (lower debit, lower max profit) |
| bull-call-debit-qqq-wide | 0.50 | 0.20 | 50% | Wider spread (higher debit, higher max profit) |
| bull-call-debit-qqq-hold | 0.50 | 0.30 | 70% | Hold longer (higher PT) |

All share: DTE 30-60, maxHoldDays 45, minExitDTE 7, monitoring daily, bidask fill. Defined in `scripts/autoresearch/strategy-bull-call-debit-qqq.ts`.

**Decision Rule**: Winner = variant with highest **selection-window combinedSharpe**. Seal winner.

**Adoption Threshold**: holdoutSpyIR ≥ 0, holdoutSharpe ≥ 0.3, oosSharpe ≥ 0.8, passesStability, passesStatConsistency, deflatedSharpeMertens > 0.

**Holdout Window Hash**: sha256:4bde4339e7cb212ab59bb19dc727321d020d410f7b3e394c5389a16c06e7dbc9

**Declared Env Overrides**: none

## References

- Strategy file: `scripts/autoresearch/strategy-bull-call-debit-qqq.ts`
- New evaluator: `scripts/autoresearch/worker.ts` (`makeDebitSpreadEvaluator`)
- Phase E9 long call seal: `docs/holdout-evaluations/2026-04-22-909b4f7a1969.md`
- Sealed-holdout protocol: `docs/sealed-holdout.md`
