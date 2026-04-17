# Autoresearch Journal — Campaign E (d65 Alpha Expansion)

## ⚠️ STATUS: CONTAMINATED — DO NOT USE PRIOR RESULTS

This campaign was launched under infrastructure flaws identified by adversarial review (Codex, 2026-04-17):

1. **Seeded from a non-pre-reg incumbent.** Campaign E used `d65-tp40-ts150` as its incumbent, but that variant was not the Campaign D pre-reg winner — the actual winner was `d65-sl35-ts105`. The v2 Campaign D results adopt `d65-sl35-ts105`.

2. **Holdout leakage into the search loop.** The `isValid` boolean used by the iteration agent embedded `passesHoldoutOrIR` (holdout pass/fail). Over 10 iterations the agent implicitly optimized against the 2024-2026 holdout.

3. **Exact holdout numerics in the seed.** The journal table seeding this campaign carried `Hldt Sharpe` and `Hldt IR` columns for Campaign D variants — direct holdout leakage.

4. **Post-hoc threshold reclassification.** After iteration 1 a note was appended instructing readers to treat 60-99 trade variants as valid for ranking — a rule change applied after seeing results.

5. **Per-campaign attempt-counter reset.** Deflated Sharpe used the Campaign E-local count (N ≈ 66) instead of a cumulative count across A/C/D/E/Option3. True N is in the hundreds.

All Campaign E findings (including the iter-10 "`d65-ema3d-fullStack-noNT-sl33-ts150`, combined 1.351" claim and iter-1 "`d65-tp50-ts150`, 1.235" claim) are therefore **not defensible as pre-registered results**.

## Remediation already applied

- The Campaign D v2 results doc (`campaign-d-results.md`) now adopts the strict pre-reg winner `d65-sl35-ts105`.
- Infrastructure fixed in `runner.ts`:
  - `isValidForSearch` (agent-visible, selection-only) and `isValid` (includes holdout, stripped from agent view).
  - `__BEGIN_REVIEWER_ONLY__ … __END_REVIEWER_ONLY__` sentinel blocks wrap all holdout feedback; the overnight shells strip them from agent prompts.
  - Global attempts counter (`data/attempts-global.json`) replaces the per-suffix reset for deflated Sharpe.
- Campaign E leaderboards deleted.
- Campaign E journal content (this file) wiped of the contaminated iteration logs.

## If you want to rerun Campaign E cleanly

1. Start from the restored incumbent `d65-sl35-ts105` (not `d65-tp40-ts150`).
2. Confirm `AUTORESEARCH_MIN_OOS_TRADES=60` is exported by the shell **before** the first iteration (shell has been fixed, but verify).
3. Ensure agent prompts no longer contain exact holdout numerics (the shell strip logic now handles this — the `__BEGIN_REVIEWER_ONLY__` sentinel).
4. Do not append "threshold recalibration" or "treat-as-valid" notes after seeing results — threshold must be fixed pre-run.
5. Limit to a small pre-registered grid (e.g. a 5-variant seed sweep around `d65-sl35-ts105`). Keep any agent loop very short to limit deflated-Sharpe penalty.
6. Update the Campaign E preregistration (`.prompts/campaign-e-d65-expansion-preregistration.md`) to reference `d65-sl35-ts105` as the incumbent and the +0.03 adoption threshold applied against `combined 1.188` (not the old 1.180).

See `campaign-e-audit.md` (sibling file) for the full remediation plan.
