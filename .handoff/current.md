---
task: Phase F1 — PMCC QQQ pt60 singleton adoption attempt (first post-F0 seal)
stage: pre-reg
owner: claude
from: user
timestamp: 2026-04-23T03:30:00Z
---

## Objective

Seal PMCC QQQ pt60 as the first Phase F1 adoption candidate under the
post-F0 clean-slate attempt counter. Pre-F0 sealed PMCC pt50 is
demoted to historical-only evidence; pt60 is a materially different
config (60% profit target vs 50%) and first-time sealing under the
F0-corrected simulator (gotcha #42 fix, calendar-day maxHoldDays,
full 6-gate machine enforcement).

## Pre-Registration

**Phase F0 boundary:** 2026-04-23T02:20:00Z UTC (declaration commit `0edb7f8`). Trials before this timestamp are excluded from the F0-effective attempt counter used in deflatedSharpeMertens gating.

**Residual informal priors:** I carry the following priors from pre-F0 exploration that are not mechanically counted:
- PMCC structure produces real risk-adjusted edge on QQQ (pre-F0 sealed PMCC pt50 cleared 6/6 before gotcha #42 fix; demoted but evidence not invalidated).
- QQQ is the most-explored ticker; other tickers underexplored.
- pt60 tested in F0 sweep (bypass mode, 2026-04-23) produced oosSharpe 1.72, oosSpyIR +0.85, dsrM > 0 under F0-effective N ≈ 18. This observation influenced the decision to pre-reg pt60 here.

These priors are a disclosure, not a correction. The F0 reset does not claim a clean epistemic slate — only a reset of the mechanical deflation counter.

**Hypothesis:** PMCC on QQQ with config (long δ 0.70-0.80, long DTE 240-300, short δ 0.20-0.30, short DTE 30-45, long profit target 60%, short profit target 50%, long stop loss 35%, long time-stop DTE 90, roll trigger moneyness 2%) — structural edge from premium collection on top of deep-ITM long LEAP — earns positive risk-adjusted alpha over SPY AND clears all 6 standard adoption gates including deflatedSharpeMertens > 0 computed under the F0-effective attempt counter.

**Config Grid:** 1 variant (singleton named anchor).

| Variant | Long δ | Long DTE | Short δ | Short DTE | Long PT |
|---|---|---|---|---|---|
| pmcc-qqq-pt60-f1-anchor | 0.70-0.80 | 240-300 | 0.20-0.30 | 30-45 | 60% |

Defined in `scripts/autoresearch/strategy-pmcc-qqq-pt60-f1.ts`.

**Decision Rule:** The named anchor `pmcc-qqq-pt60-f1-anchor` is always the sealed candidate (no variants to choose among). Seal via `scripts/evaluate-holdout.ts`.

**Adoption Threshold:** The sealed row must satisfy ALL of the standard 6 adoption gates as machine-enforced by `scripts/autoresearch/lib/seal-holdout.ts::computeStandardAdoption`:
- holdoutSpyIR >= 0
- holdoutSharpe >= 0.3
- oosSharpe >= 0.8
- passesStability = true
- passesStatConsistency = true
- deflatedSharpeMertens > 0 (computed under F0-effective attempt counter)

**Holdout Window Hash:** sha256:4bde4339e7cb212ab59bb19dc727321d020d410f7b3e394c5389a16c06e7dbc9

**Declared Env Overrides:** none

## Relationship to pre-F0 PMCC QQQ pt50

Pre-F0 sealed PMCC pt50 (2026-04-22, attempt 48 under global counter) cleared 6/6 adoption criteria but is demoted to historical-only under the Phase F0 clean-slate declaration. Reasons:
1. Sealed under gotcha-#42-biased simulator (simulateDiagonal long-exit fill used synthetic ±$0.05 spread instead of real bid/ask).
2. Sealed under the old permissive sealer that only enforced `passesHoldoutAndIR`, not the full 6 gates.

This pre-reg is NOT a re-run of pt50 with a counter reset. pt60 is a materially different profit-target parameter, first-time sealing under the F0-corrected pipeline.

## Caveats

- PMCC's always-in signal means the "signal alpha" question is N/A — PMCC's edge is structural (premium collection), not timing. F0 random-entry null test (strategy-bcd-qqq-random.ts, 2026-04-23) confirmed the EMA34 signal has no timing alpha for BCD; PMCC deliberately does not use a timing signal.
- The runner's `SrchVld=NO` delta-gate failure is expected for PMCC in this window: bounded-upside PMCC loses to unbounded long-call naive baseline during the 2024-2026 Mag7 rally. This does not affect the 6 adoption gates above.
- Holdout has been iterated against by prior runs — see `docs/sealed-holdout.md` "Known limitations." Not a fresh holdout; the October 2026 refresh is the clean data reset.

## References

- Strategy file: `scripts/autoresearch/strategy-pmcc-qqq-pt60-f1.ts`
- F0 declaration: `docs/phase-f0-clean-slate-declaration.md`
- F0 boundary lib: `scripts/autoresearch/lib/f0-boundary.ts`
- Sealer: `scripts/autoresearch/lib/seal-holdout.ts::computeStandardAdoption`
- Pre-F0 PMCC pt50 seal (historical): `docs/holdout-evaluations/2026-04-22-b6947551239a.md`
- F0 exploration leaderboard: `data/leaderboard-full-f0-pmcc-sweep.json` (pt60 row)
