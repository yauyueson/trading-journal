# Phase F0 — Clean-Slate Declaration

**Effective:** 2026-04-22T22:15:00Z (pre-registered before any F1 pre-reg is written; see git history for immutable binding).
**Status:** ACTIVE.
**Supersedes:** `docs/attempt-counter-policy.md` per-campaign EAC opt-in. Phase F0 is a full reset, not a per-campaign adjustment.

## What this declaration does

Phase F0 declares a one-time reset of the sealed-holdout attempt counter and a demotion of all pre-2026-04-22 sealed artifacts from "currently validated" to "historical evidence only." All future sealed adoption decisions are made under a clean counter starting from attempt #1 (defined as the first runner invocation committed under the F0 regime), against a codebase with four specific reliability fixes shipped immediately prior (see `## Codebase snapshot` below).

## Why

Two independent reasons, both pre-registered (not post-hoc):

1. **Global `attemptNumber` over-counted invalid comparisons.** Bailey-López de Prado deflation for Deflated Sharpe (Mertens) reads the global ledger attempt count (at 106 by 2026-04-22). Many of those attempts ran under pre-audit simulator versions with documented bugs (phantom expiration profits, direction inversion, synthetic ±$0.05 long-exit spreads). A run against a broken simulator is not a legitimate multiple-testing comparison — it tested a pipeline defect, not a strategy hypothesis. Applying uniform BdLP deflation across those attempts double-punishes post-overhaul strategies.

2. **Four reliability fixes shipped on 2026-04-22 meaningfully change the simulator and the seal ceremony.** After a codebase change of this magnitude, seals generated before the fix ran under a materially different pipeline and are not interchangeable with post-fix seals for adoption purposes. Carrying forward the old counter would be mixing apples and oranges.

## Codebase snapshot

Phase F0 starts at the following commits on branch `phase-e11-bull-call-debit-solo` (merged to main as part of this declaration):

- **Gotcha #42** (`06c0396`): `simulateDiagonal` and `makeDiagonalEvaluator` long-leg exits now use the contract's real bid/ask, not synthetic mid±$0.05. Previously understated exit slippage materially on deep-ITM LEAPs with $2-$4 bid/ask spreads.
- **Debit-spread evaluator** (`a9dd310`): same-expiry retry now reassigns `shortMatch`, `debitMaxHoldDays` is enforced in the monitor loop, and a missing-chain force-close triggers after `missingChainExitAfterDays` (default 3) consecutive days.
- **Seal ceremony** (`f1a1ed3`): verdict is now `passesHoldoutAndIR AND all six standard adoption gates` (holdoutSpyIR >= 0, holdoutSharpe >= 0.3, oosSharpe >= 0.8, passesStability, passesStatConsistency, deflatedSharpeMertens > 0). A row that clears `passesHoldoutAndIR` but fails any standard gate is sealed FAIL, not PASS.
- **Phase F0 declaration** (this commit): pre-registered reset of the attempt counter for future adoption decisions.

All four land on `main` before the first F1 campaign pre-reg is written.

## Attempt-counter rules under F0

1. **F0 starts at attempt #1.** The first autoresearch runner invocation committed after this declaration's commit is the first F0 attempt. The global ledger continues to increment from 107, but F0 pre-regs compute dsrM and other deflation-sensitive metrics using a **filtered attempt count**: only attempts stamped with a timestamp ≥ 2026-04-22T22:15:00Z AND a `repoGitSha` reachable from the F0 boundary commit count toward the F0 counter.

2. **Filter implementation.** The seal ceremony and pre-reg-gate readers must read the ledger, filter for `timestamp >= F0_BOUNDARY_ISO` AND `repoGitSha` is an ancestor of current HEAD (or is HEAD itself), and report `effectiveAttemptNumber` alongside `attemptNumber`. The 6-criterion dsrM gate uses `effectiveAttemptNumber` for its deflation math.

3. **Both counters reported.** Every F0 sealed artifact reports global `attemptNumber` AND F0 `effectiveAttemptNumber`, along with the dsrM computed under each. If the two disagree in adoption direction, the verdict is qualified (which this policy does not allow for F0 adoption — see gate 6 below).

## Pre-existing sealed artifacts — status

| Seal | Pre-F0 status | Post-F0 status | Reason |
|---|---|---|---|
| PMCC QQQ pt50 (2026-04-22 attempt 48) | validated PASS (6/6) | **historical evidence only** | Sealed under gotcha-#42-biased simulator. Not demoted for strategy-quality reasons — it cleared all 6 criteria at a comfortable margin — but sealed under a biased pipeline. |
| Bull call debit QQQ 4-variant (E10, 2026-04-22 attempt 104) | qualified PASS (5/6, dsrM −0.26) | **historical evidence only** | dsrM fail under the old permissive sealer that stamped PASS anyway. Under the F0 sealer the verdict would flip to FAIL. |
| Bull call debit QQQ singleton (E11, 2026-04-22 attempt 106) | qualified PASS (5/6, dsrM −0.27) | **historical evidence only** | Same as E10. |
| DTE5 QQQ / megacap / IWM / SPY (E3-E8) | sealed FAIL | **historical evidence only** | Unchanged classification; demoted only for regime-tracking clarity. |
| LEAP long call QQQ (E9) | sealed FAIL | **historical evidence only** | Same. |

"Historical evidence only" means: the sealed files in `docs/holdout-evaluations/` remain as permanent record of what was tried and what the numbers were. They are not in the "currently adopted" strategy catalog. No F0 pre-reg may cite them as priors for a decision rule; they may be cited in the free-form context section of a pre-reg, but the pre-reg's adoption gate evaluates the NEW seal's numbers, not the historical ones.

## What this declaration does NOT do

1. **Does not re-run or re-seal pre-F0 artifacts.** The `docs/audit-rows/*.jsonl` files and `docs/holdout-evaluations/*.md` files stay exactly as they are. The F0 sealer (machine-enforced 6 gates, commit `f1a1ed3`) will emit different verdicts on those rows if re-run, but nobody is going to re-run them. They're frozen.

2. **Does not reset the ticker cache, data files, or the holdout window.** The holdout window remains `sha256:4bde4339e7cb212ab59bb19dc727321d020d410f7b3e394c5389a16c06e7dbc9` until the planned 2026-10-20 holdout refresh. F0 only resets the attempt counter for the adoption-threshold dsrM gate.

3. **Does not erase priors.** The researcher (human + assistant) carries informal priors from pre-F0 exploration: "QQQ has been the most-explored ticker," "bounded-upside structures fight the 2024-2026 Mag7 window," "PMCC pt50 produced real signal," "credit spreads on QQQ look promising." These priors survive the reset. F0 does not claim a clean epistemic slate — it only resets the formal mechanical counter that drives deflation math.

## Binding commitments

1. **No further resets until 2026-10-20 holdout refresh**, except for an explicitly documented simulator audit that invalidates the current codebase (e.g., discovery of a structural bug on par with gotcha #42). A near-miss adoption result is NEVER a valid reset trigger.

2. **F0 sealer is the floor.** Pre-regs may document stricter thresholds; they may not loosen any of the 6 standard gates. The sealer enforces standard 6 regardless of pre-reg text.

3. **First F1 pre-reg must not be near-boundary on dsrM.** If the proposed F1 strategy's dsrM under F0 would land close to 0, pick a different strategy or add more margin. First F1 should not look like outcome-flipping.

4. **Residual informal priors acknowledged in every F1+ pre-reg.** Each pre-reg includes a sentence stating "I carry priors from pre-F0 exploration" and names the most material ones. This is a disclosure, not a correction.

5. **No re-running of pre-F0 strategies under F0 counter** unless the strategy has a materially different config (not just re-seal of the same config with the new counter). Re-testing bull call debit with identical config would be retroactive rehabilitation, forbidden by gate 4 of the EAC policy and gate 1 here.

## Procedural safeguards

- **Pre-reg block hash covers the F0 boundary reference.** F1+ pre-regs include a line `**Phase F0 boundary:** 2026-04-22T22:15:00Z (commit <SHA of this declaration>)`. Any change invalidates the pre-reg.
- **Runner and sealer implement `effectiveAttemptNumber`.** Not deferred — lands in the same commit as this declaration or in an immediately following fix.
- **Codex adversarial review on each F1+ pre-reg and its first seal.** Re-uses existing `codex:adversarial-review` workflow.

## Scope limitations (known at time of declaration)

- **Adoption gates are hardcoded, not parsed from pre-reg text.** The F0 sealer enforces the standard 6 gates regardless of what the pre-reg's free-form adoption threshold says. A pre-reg committing to a stricter threshold is human-only — the sealer does not enforce extra gates. Future enhancement: structured adoption-gate block in pre-reg frontmatter so the sealer can enforce exactly what was pre-registered. For F0, the hardcoded standard is the contract.
- **Diagonal simulator missing-chain handling is silent-skip, not force-close.** Lower-priority than debit-spread because QQQ (the primary diagonal target) has dense chain coverage. If a future F1 campaign uses DIAGONAL on a data-sparse ticker, add a force-close guard mirroring the debit-spread fix before sealing.
- **Debit-spread missing-chain force-close uses last-known spread mid, not an executable degraded-data price.** Under bidask fillMode this may slightly overstate exit value (the stale mid is not the bid an actual seller would hit). For low chain-gap tickers (QQQ, SPY) the impact is negligible. Future enhancement: use intrinsic value from last-known stock price, mirroring the credit-spread evaluator's `computeIntrinsicSpreadCloseCost`. For F0, the stale-mid fallback is acceptable provided F1 campaigns use tickers with dense coverage.
- **LEAP simulator missing-chain handling is already correct** (uses `NO_CHAIN` exit mechanism).
- **Credit-spread simulator missing-chain handling is already correct** (uses `NO_CHAIN` exit mechanism).
- **`effectiveAttemptNumber` implementation deferred.** The runner/sealer do not yet compute a filtered attempt counter. Implementation gates F1's first sealed artifact — a follow-up commit must land before any F1 runner invocation. Options: (a) read-time filter in sealer based on timestamp + ancestor reachability of the boundary commit, (b) write-time stamp in runner based on same filter. Recommendation: (a), smaller change.
- **The residual-priors acknowledgment is a disclosure, not quantification.** No mechanical correction for mental comparisons from pre-F0 search.
- **Global `attemptNumber` continues incrementing.** The F0 filter is applied at read-time, not write-time, to preserve a single append-only ledger.

## Post-declaration checklist before first F1 runner invocation

1. [ ] Implement `effectiveAttemptNumber` filter (see scope limitations above). Blocking.
2. [ ] Codex adversarial review of the `effectiveAttemptNumber` implementation. Blocking.
3. [ ] F1 strategy pre-reg drafted with `**Phase F0 boundary:** 2026-04-22T22:15:00Z (commit <SHA>)` line. Non-blocking for infra but required before runner.
4. [ ] Residual-priors disclosure in F1 pre-reg. Non-blocking for infra.
5. [ ] Strategy selected is not bull-call-debit QQQ or PMCC QQQ pt50 with identical config (gate 5 of binding commitments).

## References

- `docs/sealed-holdout.md` — the adoption protocol this supplements.
- `docs/backtest-trust-gotchas.md` — pre-F0 simulator defects (gotcha #42 closed 2026-04-22).
- `docs/attempt-counter-policy.md` — per-campaign EAC policy, superseded by F0.
- `memory/dsrM-global-attempt-ceiling.md` — the Phase E11 learning that motivated this.
- Boundary commits: `06c0396` (gotcha #42), `a9dd310` (debit-spread evaluator), `f1a1ed3` (seal ceremony), this doc's commit.
