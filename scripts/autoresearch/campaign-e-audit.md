# Campaign E Audit & Remediation

**Date:** 2026-04-17
**Trigger:** Codex adversarial review (see session notes)

---

## What happened

Campaign E was launched on 2026-04-16 as a bounded 10-iteration agent-driven expansion around what I believed to be the Campaign D winner. The review flagged five structural problems that together make Campaign E's findings **not defensible as preregistered results**:

1. **Wrong incumbent carried forward.** Campaign D's pre-registered decision rule says rank by selection combinedSharpe. Strict winner: `d65-sl35-ts105` (combined 1.188). I recommended `d65-tp40-ts150` (combined 1.180) based on holdout/robustness arguments — a rule that was not in the pre-reg. Campaign E was then seeded from the non-pre-reg incumbent. Everything downstream is contaminated at the root.

2. **Holdout leakage through `isValid`.** `runner.ts` computed `isValid = passesMinTrades && passesMaxDD && passesWFA && passesHoldoutOrIR && passesSanity && passesDeltaGates` and kept `isValid` in the agent-visible leaderboard (only exact holdout numerics were stripped). Over 10 iterations of agent-driven edits, the agent could observe which of its strategies passed the holdout gate and which did not, and implicitly optimize toward passing holdout.

3. **Exact holdout numerics in seeded journal.** The journal-campaign-e.md seed contained a table with `Hldt Sharpe` and `Hldt IR` columns for prior Campaign D variants, feeding exact holdout outcomes into the Campaign E agent's context at iteration 1.

4. **Post-hoc threshold reclassification.** After iteration 1 ran without `AUTORESEARCH_MIN_OOS_TRADES=60` exported (an oversight — shell forgot to set it), a journal note was appended instructing the agent to reinterpret `isValid: false` with `trades < 100` reason as "treat as valid if trades ≥ 60." This is a rule change applied after seeing results — precisely what pre-registration is meant to prevent.

5. **Deflated Sharpe reset per campaign.** `runner.ts` isolated leaderboards by `AUTORESEARCH_LEADERBOARD_SUFFIX`, and the deflated-Sharpe attempt counter used the per-suffix count (N ≈ 66 at Campaign E end). The true serial search across Campaigns A, C, D, E, and Option 3 is in the hundreds of attempts, meaning the reported deflated Sharpe values materially understate p-hacking risk.

## Contamination scope

- **Contaminated and unusable as preregistered evidence:** Campaign E's iteration outputs (all 10 iterations, 60+ leaderboard entries), including the claimed iter-10 champion `d65-ema3d-fullStack-noNT-sl33-ts150` (combined 1.351).
- **Contaminated incumbent selection:** Campaign D's original recommendation of `d65-tp40-ts150`. The underlying 26-variant sweep is still valid (the decision rule was pre-registered and the data is clean); only my post-hoc recommendation departed from the rule.
- **Still valid:**
  - Campaign A (regime gates) — pre-reg rule strictly followed, winner was the ungated baseline, holdout observed once.
  - Campaign C (portfolio responses) — pre-reg rule followed, baseline won, holdout observed once via post-replay approximation.
  - Campaign D's raw sensitivity grid (26 variants) — correctly measured, but the v2 results doc now adopts the actual strict-pre-reg winner `d65-sl35-ts105`.
  - Option 3 loop (124 entries, 0 valid) — conclusion "non-momentum complement space empirically exhausted" doesn't depend on fine-grained ranking, so the null result holds even under holdout leakage concerns.

## Remediation applied in this session

### Infrastructure (runner.ts)

1. **Split `isValid` into two tiers.**
   - `isValidForSearch`: selection-only criteria (`passesMinTrades`, `passesMaxDD`, `passesWFA`, `passesSanity`, `passesDeltaGates`). Agent-visible.
   - `isValid`: adds `passesHoldoutOrIR`. Stripped from agent-visible leaderboard.
2. **Strip holdout-derived booleans from agent-visible leaderboard.** `HOLDOUT_DERIVED_FIELDS` now includes `isValid`, `passesHoldout`, `passesHoldoutOrIR`, `holdoutTrades`, plus the existing numerics.
3. **Sentinel-wrapped reviewer-only output.** `printResult` now emits holdout pass/fail inside `__BEGIN_REVIEWER_ONLY__ … __END_REVIEWER_ONLY__` blocks. The agent-visible verdict is "NEW PROVISIONAL BEST" / "VALID_FOR_SEARCH — not best" / "DISCARDED (failed search validity)" with no holdout information.
4. **Global attempts ledger.** `data/attempts-global.json` now tracks attempts across all campaigns. Deflated Sharpe uses this global N instead of the per-suffix count.

### Shell scripts (run-campaign-e-overnight.sh, run-option3-overnight.sh, run-overnight.sh)

1. **RUNNER_SUMMARY extraction now strips `__BEGIN_REVIEWER_ONLY__ … __END_REVIEWER_ONLY__` blocks** before passing the runner output into the next iteration's journal prompt. No holdout signal reaches the agent via the log.

### Documentation

1. **`campaign-d-results.md` v2** — adopts `d65-sl35-ts105` per strict pre-reg rule. Prior robustness-weighted recommendation explicitly marked as a rule violation that has been corrected.
2. **`journal-campaign-e.md`** — wiped of contaminated iteration content. Replaced with contamination notice + remediation-applied notes.
3. **`strategy-campaign-e.ts`** — reset to `d65-sl35-ts105` (the correct incumbent) with explanatory header. All prior `configVariants` removed.
4. **This audit doc** — documents what happened, what was contaminated, and what to do about it.

### Data

1. Contaminated Campaign E leaderboards renamed with `.contaminated` suffix (not deleted — available for forensic review):
   - `scripts/autoresearch/leaderboard-campaign-e.json.contaminated`
   - `data/leaderboard-full-campaign-e.json.contaminated`

## Where this leaves us

### Adopted state (defensible)

- **Primary:** DTE5 QQQ bull-put credit spread (unchanged, OOS Sharpe ~1.44).
- **Secondary:** **`d65-sl35-ts105`** — Campaign D strict pre-reg winner.
  - Selection combined Sharpe 1.188, standalone 1.341, MaxDD 25.4%, 90 trades.
  - Single parameter change from baseline (SL 0.30 → 0.35).
  - Holdout: Sharpe 1.067, IR 0.776 (both pass the 0.3 gate).
  - Campaigns A, C, Option 3 all confirmed no additional alpha beyond this.

### NOT adopted (contaminated, must not be claimed)

- `d65-tp40-ts150` (combined 1.180) — Campaign D runner-up, incorrectly recommended in v1 results doc.
- `d65-ema3d-fullStack-noNT-ts150` (combined 1.247) — Campaign E iter 10, contaminated.
- `d65-ema3d-fullStack-noNT-sl33-ts150` (combined 1.351) — Campaign E "claimed champion", contaminated.
- `d65-tp50-ts150` (combined 1.235) — Campaign E iter 1, contaminated (and relied on the post-hoc threshold reclassification).

## If you want to rerun cleanly

Any or all of the following are legitimate next steps, each in a separate clean run:

### Campaign E-clean (agent-driven d65 expansion, properly preregistered)

Prerequisites:
- Infrastructure fixes in this session are already applied (sentinel strip, isValid split, global attempts ledger).
- Update `.prompts/campaign-e-d65-expansion-preregistration.md` to reference `d65-sl35-ts105` as the incumbent and `combined 1.188` as the threshold-beating target (adoption bar: +0.03 → 1.218).
- Delete the `.contaminated` leaderboards or leave them; a fresh suffix (e.g. `AUTORESEARCH_LEADERBOARD_SUFFIX=campaign-e2`) avoids collision.
- Verify `AUTORESEARCH_MIN_OOS_TRADES=60` is exported by the shell (already in run-campaign-e-overnight.sh).

Expectation: the empirical ceiling around `d65-sl35-ts105` is likely near 1.19-1.22. Probably low ROI.

### Static pre-reg grid test for the specific ema3d + noNT finding

The Campaign E agent's proposed direction (EMA3d rising + 12-ticker noNT subset) is itself a reasonable hypothesis, just not one that can be adopted from Campaign E's run because that run was contaminated.

A clean test would be a single runner invocation with ~8 pre-registered configVariants isolating each factor (ema3d alone, noNT alone, band=0.03/0.04, stack filter alone) around the `d65-sl35-ts105` incumbent. No agent iteration. One pre-reg, one decision.

### Do nothing else

`d65-sl35-ts105` already delivers combined Sharpe 1.188 — a 10% improvement over the 1.079 baseline from three orthogonal campaigns' worth of investigation. The holdout passes. The delta gate passes. Deflated Sharpe positive under the correct global N.

Given that three campaigns (A, C, Option 3) all returned "no additional alpha found beyond this", additional search has diminishing expected value. "Commit and move to live testing" is a defensible conclusion.

---

## Appendix: what's checked in / what's gone

### Files modified
- `scripts/autoresearch/runner.ts` — isValid split, sentinel blocks, stripped fields, global attempts ledger
- `scripts/autoresearch/types.ts` — added `isValidForSearch` field
- `scripts/autoresearch/run-overnight.sh` — RUNNER_SUMMARY strips reviewer-only blocks
- `scripts/autoresearch/run-option3-overnight.sh` — same
- `scripts/autoresearch/run-campaign-e-overnight.sh` — same (plus MIN_OOS_TRADES export)
- `scripts/autoresearch/campaign-d-results.md` — v2 with strict pre-reg adoption
- `scripts/autoresearch/journal-campaign-e.md` — wiped, contamination notice
- `scripts/autoresearch/strategy-campaign-e.ts` — reset to `d65-sl35-ts105`

### Files created
- `scripts/autoresearch/campaign-e-audit.md` (this file)

### Files preserved (for forensic review)
- `scripts/autoresearch/leaderboard-campaign-e.json.contaminated`
- `data/leaderboard-full-campaign-e.json.contaminated`
