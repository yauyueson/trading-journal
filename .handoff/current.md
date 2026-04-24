---
task: Phase F1 — BCD QQQ wide (10-day emission, flat-gated) singleton adoption attempt (second post-F0 seal, v2 after Codex prose correction)
stage: pre-reg
owner: claude
from: user
timestamp: 2026-04-23T22:30:00Z
---

## Objective

Seal bull call debit spread (BCD) QQQ "wide" structure — long δ 0.50,
short δ 0.20, DTE 30-60, PT 50% — as the second Phase F1 adoption
candidate under the post-F0 clean-slate attempt counter. Targets
small-account feasibility ($2K starting capital, ~$200-300 per spread).

This pre-reg references the Phase F0 boundary 2026-04-23T02:20:00Z UTC
(declaration commit `0edb7f8`). Trials before that timestamp are
excluded from the F0-effective attempt counter used in the
deflatedSharpeMertens gate.

Residual informal priors (disclosure, not mechanical correction):
- Pre-F0 Phase E10 + E11 established BCD-wide as a qualified PASS
  (5 of 6 gates), failing only on dsrM under global N=106. Under F0,
  the same row would clear 6/6.
- The F0 exploration sweep (2026-04-23) tested 17 BCD variants. 9
  cleared adoption under F0-effective N-at-seal-time. This pre-reg
  is drawn from that sweep — the "wide" config + 10-day cadence
  combination is influenced by prior peeking. The F0 reset does not
  claim a clean epistemic slate for this candidate.
- Orthogonal null test (`strategy-bcd-qqq-random.ts`,
  `strategy-bcd-qqq-nosignal.ts`) established that the EMA34 entry
  filter used in E10/E11 contributes no timing alpha. The BCD edge is
  structural (bull call debit payoff during QQQ positive-drift
  regime), not signal-driven. This pre-reg drops EMA34 in favor of
  fixed 10-day cadence to avoid carrying cosmetic complexity into the
  live config.

## Pre-Registration

**Hypothesis**: Bull call debit spreads on QQQ with config (long δ
0.50, short δ 0.20, DTE 30-60, profit target 50%, max hold 45 days,
min exit DTE 7, bid/ask fills), entered from a 10-trading-day
signal-emission cadence under portfolio constraint maxPositions=1
(i.e. emitted signals are accepted only when flat; signals arriving
while a prior spread is still open are skipped and NOT queued — so
observed inter-entry spacing is ≥ 10 trading days, often longer after
long-held trades), earn positive risk-adjusted alpha over SPY AND
clear all 6 standard adoption gates — including deflatedSharpeMertens
> 0 computed under the F0-effective attempt counter at this seal's
timestamp.

**Config Grid**: 1 variant (singleton named anchor):

| Variant | Long δ | Short δ | DTE | PT | Signal emission | Position cap |
|---|---|---|---|---|---|---|
| bcd-qqq-wide-f1-anchor | 0.50 | 0.20 | 30-60 | 50% | every 10 trading days from i=60 | maxPositions=1 |

Defined in `scripts/autoresearch/strategy-bcd-qqq-wide-f1.ts`. The
10-trading-day spacing applies to signal emission (loop stride in
`generateSignals`); actual entry dates are filtered by the runner's
portfolio-state gate via `evaluateConfiguredSignalsWithState()`. This
is the same emission-plus-flat-gate pattern validated by
`bcd-nosignal-10d-anchor` in the F0 exploration sweep
(`data/leaderboard-full-f0-bcd-nosignal-10d.json`).

**Decision Rule**: The named anchor `bcd-qqq-wide-f1-anchor` is always
the sealed candidate (no variants to choose among). Seal via
`scripts/evaluate-holdout.ts`.

**Adoption Threshold**: The sealed row must satisfy ALL of the
standard 6 adoption gates as machine-enforced by
`scripts/autoresearch/lib/seal-holdout.ts::computeStandardAdoption`:
- `holdoutSpyIR >= 0`
- `holdoutSharpe >= 0.3`
- `oosSharpe >= 0.8`
- `passesStability = true`
- `passesStatConsistency = true`
- `deflatedSharpeMertens > 0` (computed under F0-effective attempt counter)

**Holdout Window Hash**: sha256:4bde4339e7cb212ab59bb19dc727321d020d410f7b3e394c5389a16c06e7dbc9

**Declared Env Overrides**: none

## Relationship to pre-F0 Phase E11 bull-call-debit-qqq-solo-anchor

Pre-F0 Phase E11 sealed `bull-call-debit-qqq-solo-anchor` as a 5/6
PASS, failing only dsrM at −0.27 under the global attempt counter
(N=106). That artifact is demoted to historical-only under the Phase
F0 declaration.

This pre-reg is materially different from the E11 solo anchor:
1. **Entry**: drops EMA34 signal in favor of 10-trading-day signal
   emission (per F0 null-test finding that the EMA34 filter adds no
   alpha).
2. **F0-effective N at seal**: will be ≥30 (v2 re-run) vs the pre-F0
   N=106, which changes the dsrM gate outcome from FAIL to expected
   PASS.

Both changes combine to produce a different identity triple (name,
blob, preReg) — not a re-run of E11 under a counter reset.

## Relationship to v1 seal (2026-04-23-e281292f4870)

An earlier pre-reg (block hash `e281292f4870bbbd…`, committed
`d409ef4`) sealed the same strategy file as `bcd-qqq-wide-f1-anchor`
with verdict 6/6 PASS. Codex adversarial review of that seal flagged
a P1 finding: the v1 pre-reg hypothesis text called the entry a
"fixed 10-trading-day cadence," but the code emits signals every 10
days and lets the runner's portfolio-state gate skip signals that
arrive while a prior spread is still open. The strategy file and
measured numbers were correct; only the prose overstated what was
mechanically enforced.

This v2 pre-reg corrects the prose (describing emission-plus-
flat-gate rather than "fixed cadence") and produces a new
`preRegBlockHash` so the sealer requires a fresh audit row. The v1
seal remains in `docs/holdout-evaluations/2026-04-23-e281292f4870.md`
as historical evidence of the prose-mismatched seal and is superseded
by the v2 seal produced from this pre-reg.

## Caveats

- The "wide" config and 10-day cadence choice are informed by prior
  F0 sweep peeking. This is a residual-priors disclosure, not a clean
  first-look. Per the F0 declaration, the 6 gates remain the floor
  but do not fully correct for informal priors.
- 10-day cadence selected over 5-day because the F0 `nosignal-5d`
  variant failed holdoutSpyIR at −0.19 (over-trading drag during the
  2024-2026 Mag7 rally caps upside too aggressively against long-SPY).
  20-day cadence selected against because its oosSharpe (0.68) was
  too low to clear dsrM at current F0-effective N.
- Holdout has been iterated against by prior runs — see
  `docs/sealed-holdout.md` "Known limitations." Not a fresh holdout;
  the October 2026 refresh is the clean data reset.

## References

- Strategy file: `scripts/autoresearch/strategy-bcd-qqq-wide-f1.ts`
- F0 declaration: `docs/phase-f0-clean-slate-declaration.md`
- F0 boundary lib: `scripts/autoresearch/lib/f0-boundary.ts`
- Sealer: `scripts/autoresearch/lib/seal-holdout.ts::computeStandardAdoption`
- Pre-F0 E11 BCD solo seal (historical): `docs/holdout-evaluations/2026-04-22-e95532f9b3a3.md`
- F0 BCD exploration leaderboards:
  - `data/leaderboard-full-f0-bcd-sweep.json` (wide variant row)
  - `data/leaderboard-full-f0-bcd-nosignal-5d.json` (failed IR)
  - `data/leaderboard-full-f0-bcd-nosignal-20d.json` (failed dsrM)
- First F1 seal (PMCC pt60, reference pattern): `docs/holdout-evaluations/2026-04-23-7e9c2026f3df.md`
