# Attempt-Counter Policy

**Status:** ACTIVE (effective 2026-04-22, first application TBD in next pre-reg).
**Supersedes:** nothing. Complements `docs/sealed-holdout.md`.

## Purpose

Specify which historical autoresearch attempts count as legitimate multiple-testing surface area for the Bailey-López de Prado Deflated Sharpe (Mertens) formula (`deflatedSharpeMertens`, a.k.a. dsrM). The default formula reads the global `attemptNumber` from the trial ledger, which over-counts pre-overhaul runs whose results were invalidated by simulator bugs. This policy defines when — and under what conditions — a narrower counter is permitted.

## Background

The Bailey-López de Prado deflation factor grows with N (number of variants tested). It assumes each attempt was a bona fide chance to detect a false positive — i.e., each result either was or was not a signal, and you picked the best out of N clean draws. This assumption breaks when:

1. **Simulator produced known-invalid results.** Pre-audit expiration bug produced phantom profits (see `memory/full-sweep-study.md`, `memory/swing-strategy-dead.md`). A run that reports Sharpe 2.5 because of a bug did not test a strategy — it surfaced a simulator defect. Counting it as a comparison conflates two different hypothesis spaces ("is this strategy real?" vs. "is my simulator correct?").
2. **Direction or parameter bugs inverted the test.** Phase E3/E4/E5 DTE5 generalization runs used `direction: 'PUT'` where the engine expected `direction: 'CALL'` to produce a bull put spread (documented in `memory/dte5-qqq-sealed-fail-window-artifact.md`). Those runs did not test DTE5 bull put generalization; they tested the bear call spread variant with a confusing label.

Applying the global `attemptNumber` uniformly across these categories means a post-overhaul strategy effectively pays the deflation cost of attempts that could never have passed any sealed-adoption threshold.

## What this policy allows

A **per-campaign Effective Attempt Counter (EAC)** may be used in place of the global `attemptNumber`, subject to the conditions below. The sealed audit row still records the global `attemptNumber` — the EAC is reported as an additional field and used for the adoption-threshold dsrM check.

### Conditions for using EAC

1. **Pre-registration required.** The pre-reg in `.handoff/current.md` must declare `useEffectiveAttemptCounter: true` and state the boundary date or boundary condition BEFORE any audit row for the campaign is written. No retroactive application.
2. **Boundary must be principled.** Acceptable boundaries:
   - The sealed-holdout ceremony commit date (**2026-04-19**, commit `706f507`): attempts prior to this were not adoption-gated under the current protocol, so they are not legitimate comparisons for adoption-threshold decisions.
   - A documented simulator-correctness fix commit whose absence would have produced invalid results in the counted attempts. Must cite the specific gotcha in `docs/backtest-trust-gotchas.md` or a named audit.
   - A data-regime break (e.g., holdout window refresh on 2026-10-20).
3. **No re-run of existing sealed strategies.** EAC cannot be used to re-evaluate strategies that already have a sealed audit row. Re-running bull-call-debit-qqq under EAC would be retroactive methodology-shopping. EAC applies only to strategies being sealed for the first time.
4. **Acknowledge residual informal search.** The pre-reg must include a line acknowledging that priors about which structures to test ("credit spreads on QQQ look promising", "bounded-upside wants pt50", etc.) survived the simulator overhaul and constitute informal selection pressure outside the ledger. The EAC does not buy a clean slate; it buys an honest accounting of the formal comparisons that were mechanically countable.
5. **Report both numbers.** The sealed seal file must report dsrM under both the global `attemptNumber` and the EAC. If they disagree in adoption direction, the PASS verdict is qualified ("passes under EAC, fails under global — see §Known limitations").

### Calculating the EAC

For each attempt in the ledger:
- **Include in EAC** if: timestamp ≥ 2026-04-19T15:09:43Z (sealed-ceremony live) AND simulator was post-fix AND attempt ran under the current adoption-gate hashes (`adoptionGatesEffectiveHash` matches current).
- **Exclude from EAC** if: any of the above conditions failed.

The EAC is computed at seal time from the ledger by filtering and counting.

### Simulator-fix boundary (if invoked separately)

If a pre-reg invokes a simulator-fix boundary that is EARLIER than 2026-04-19 (e.g., "counting from 2026-04-03 because phase-X bug fix"), it must cite:
- The commit SHA of the fix
- The specific gotcha or memory file documenting the bug
- Evidence (unit test, replication script, or prior memory) that attempts after that commit were running under the corrected engine

The burden of justification scales with how early the proposed boundary is. A 2026-04-19 boundary is the safest and should be the default unless there is a specific reason to go earlier.

## What this policy does NOT allow

- **Retroactive re-sealing.** E10 and E11 (bull call debit QQQ) seals stand as recorded. Their dsrM values are what they are under the global counter. A future sealed PASS on a DIFFERENT structure under EAC does not rehabilitate them.
- **Resetting after a failed seal.** Declaring EAC for the first time immediately after a near-miss (e.g., dsrM = −0.1) is procedurally indistinguishable from p-hacking. To mitigate: the first pre-reg to use EAC should be for a structure where the global-counter dsrM is not near the adoption boundary, so the EAC adjustment is marginal-but-principled rather than outcome-flipping.
- **Repeated boundary shopping.** The boundary date chosen for one campaign is binding for all subsequent campaigns in the same hypothesis class. Moving the boundary later after seeing results is disallowed.
- **Using EAC to bypass other criteria.** The 6-criterion adoption threshold is the threshold. EAC only affects how dsrM is computed; it does not relax `holdoutSpyIR`, `oosSharpe`, `passesStability`, or `passesStatConsistency`.

## Procedural safeguards

1. **Pre-reg block hash covers the EAC declaration.** Any change to `useEffectiveAttemptCounter` or the boundary date after pre-reg invalidates the pre-reg.
2. **Sealed seal file includes the EAC computation details** (boundary, ledger count before/after filter, list of excluded attempts by reason category).
3. **Codex adversarial review** of any pre-reg invoking EAC should specifically challenge the boundary justification.

## Application path

The next campaign that wants to use this policy must:

1. In the pre-reg under `## Pre-Registration`, add an `EAC` subsection:
   ```
   **Effective Attempt Counter (EAC):** enabled
   **Boundary:** 2026-04-19T15:09:43Z (sealed-holdout ceremony live, commit 706f507)
   **Residual informal search acknowledgment:** I carry priors from pre-overhaul
     search (approx. 10-20 mental comparisons re: bounded-upside structures on
     QQQ) that are not mechanically counted. EAC does not claim a clean slate.
   ```
2. Run the campaign.
3. At seal time, the seal file's adoption-threshold table reports two dsrM rows — one under global `attemptNumber`, one under EAC. Adoption decision uses the EAC row. Qualified outcome if the two disagree.

## Known limitations

- **Priors are not mechanically counted.** The residual-search acknowledgment is a disclosure, not a correction. A user who had previously run 50 strategies under buggy code and internalized "QQQ is the right ticker" is in a different epistemic position than one starting fresh. This policy does not attempt to quantify that gap.
- **The 2026-04-19 boundary is policy-driven, not math-driven.** Picking an earlier date (e.g., the specific simulator-fix commits) is also defensible. This policy picks the sealed-ceremony date as the safest default because it corresponds to an externally-visible protocol change, not a subjective claim about when the simulator became correct.
- **dsrM is a point estimate.** Even under EAC, a marginal dsrM (e.g., +0.02) is weak evidence. Prefer strategies that clear dsrM > 0 with margin over those that squeak past.

## References

- Bailey & López de Prado (2014), "The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting and Non-Normality."
- `docs/sealed-holdout.md` — the adoption-protocol doc this supplements.
- `docs/backtest-trust-gotchas.md` — pre-overhaul simulator defects.
- `memory/dsrM-global-attempt-ceiling.md` — the Phase E11 learning that motivated this policy.
- Sealed commit `706f507` (2026-04-19): Phase 0.a.5 — sealed-holdout ceremony live.
