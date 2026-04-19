# Sealed-Holdout Policy

**Adopted:** 2026-04-19 (Phase 0.a.5 of the foundation rebuild).
**Applies to:** every autoresearch campaign going forward.

## What this policy is for

The autoresearch loop tries hundreds of strategy variants. Every variant the agent sees influences the next one it proposes. If the agent ever sees how a variant performs on the *holdout* window, the whole point of a holdout — an independent check on out-of-sample generalisation — is lost.

"Sealed holdout" means three things, stricter than typical backtest hygiene:

1. **One evaluation per pre-registered candidate.** A candidate is a specific strategy committed to git and described in a `.handoff/current.md` Pre-Registration block. Once its holdout result is sealed, it is frozen: the record is written to `docs/holdout-evaluations/`, and further evaluations against the same block hash are refused.
2. **No peeking.** The researcher does not read the holdout columns of the audit leaderboard (`data/leaderboard-full*.json`) during search. Peeking is indistinguishable from running multiple tests; there is no technical enforcement of this, only discipline.
3. **Every seal is a written record.** The seal file stamps the candidate's git SHA, the pre-reg block hash, the adoption-gate file hash, and every holdout metric at the moment of decision. The chain of custody is this record.

## The protocol

1. **Pre-commit the candidate.** The candidate's strategy file (typically `scripts/autoresearch/strategy.ts` or a variant) must be clean and committed to git. No uncommitted edits. The runner stamps the strategy's git SHA onto every row it produces.
2. **Write a Pre-Registration block.** Edit `.handoff/current.md` with a fresh `## Pre-Registration` section containing:
   - `**Hypothesis**: <what you expect>`
   - `**Config Grid**: <what you tested>`
   - `**Decision Rule**: <how you picked this candidate>`
   - `**Adoption Threshold**: <the exact gate the seal must clear>`
   - `**Holdout Window Hash**: sha256:<64hex>` (placeholder until Phase 0.b.6)
   - `**Declared Env Overrides**: none` (or listed env vars)
3. **Commit `.handoff/current.md`.** The block hash becomes the chain-of-custody anchor.
4. **Run the runner against the candidate on a clean working tree.** This produces an audit row in `data/leaderboard-full*.json` (the existing gitignored leaderboard) AND appends one JSON line to `docs/audit-rows/<preRegBlockHash>.jsonl` (a tracked per-block file the seal ceremony reads). Every row is stamped with:
   - `strategyGitSha` — last commit touching the strategy file.
   - `strategyBlobSha` — content hash of the strategy file at run time.
   - `repoGitSha` — `git rev-parse HEAD` at run time, **null if the working tree had any uncommitted change**. The seal refuses rows with null repoGitSha.
   - `holdoutEvaluated` — `true` unless `AUTORESEARCH_SKIP_HOLDOUT=1` was set.
5. **Commit `docs/audit-rows/<preRegBlockHash>.jsonl`.** This is the immutable anchor the seal reads. Hand-edits to the tracked file cause the seal to refuse. Appending more lines in future runs is fine — the seal takes the FIRST matching row, not the last.
6. **Seal.** Invoke:
   ```bash
   npx tsx scripts/evaluate-holdout.ts \
     --strategy scripts/autoresearch/strategy.ts \
     --strategy-name "<exact name from strategy export>" \
     --prereg-hash <block hash>
   ```
   The evaluator verifies:
   - Pre-reg block hash matches `.handoff/current.md` and the file is committed.
   - Strategy file exists, is tracked, and is clean.
   - `docs/audit-rows/<preRegBlockHash>.jsonl` exists and is tracked + clean.
   - At least one row in the file matches the identity triple `(strategyName, strategyBlobSha === current blob, repoGitSha === current HEAD)`. Refuses with a specific diagnostic if any field mismatches.
   - The matched row's `strategyGitSha` equals the strategy file's current last-touch commit.
   - The matched row's `holdoutEvaluated === true`.
   - No prior seal exists for this block hash.
   - The FIRST row matching the identity triple is the one sealed (prevents rerunning under the same code until the numbers look favorable and then sealing the newer row).

   On success the evaluator writes `docs/holdout-evaluations/<YYYY-MM-DD>-<hash-prefix>.md` and exits 0 (PASS) or 1 (FAIL). Any refusal exits 2.

### Why the committed JSONL file

Earlier drafts read from the mutable `data/leaderboard-full*.json`. Codex round-1 flagged this as the ceremony's main trust hole — a researcher could hand-edit the gitignored JSON and produce a sealed PASS. Round-2 added two more tightenings:

- **Silent overwrite** — a plain `docs/audit-rows/<blockHash>.json` would be overwritten by each runner run, so an earlier bad result would vanish before sealing. The append-only JSONL with first-match selection closes this: every run leaves a trace in git history, and the sealed verdict is the FIRST row under a given identity triple.
- **Identity binding** — `strategyGitSha` alone binds only the strategy file's last-touch commit; a change in an imported helper (e.g. `src/lib/backtest/option-sim.ts`) would not move it. `repoGitSha` now binds the full tree (and is null on any dirty working tree at run time), and `strategyBlobSha` binds the exact strategy-file content. The seal requires all three to match the current state before writing.

## Known limitations at time of adoption

**The current holdout window is burned.** Between 2026-04-18 and this policy taking effect, the runner logged 38+ trials (plus many earlier) against the current holdout window (~2024-01-22 → 2026-02-27). The audit file for those trials was readable during search. Any "holdout" result from *before* this policy is diagnostic, not conclusive: even if the numbers look clean, the researcher had opportunities to peek.

Going forward, seals count. The current window continues to be usable — it is the only long window we have — but the real discipline starts from the first seal under this protocol. When we accumulate enough candidates evaluated under the seal, we can start trusting the pattern.

**`preRegHoldoutWindowHash` is a placeholder.** The value is format-checked (64 hex, optionally with `sha256:` prefix) but not yet semantically bound to specific trading dates. Phase 0.b.6 will introduce a committed dataset manifest that the hash must match; until then, the hash is an honour-system commitment.

**Reseal is deferred.** Carving a fresh holdout range (e.g. forward-only from a chosen cutoff, or reserving future data) is a research decision that trades time for rigour. We chose to defer it and ship the protocol over the existing (burned) window. A future decision will revisit.

**Mid-run provenance tampering is not defended.** The runner captures `strategyGitSha`/`strategyBlobSha`/`repoGitSha` at a single point in time (just after esbuild bundles the strategy). An operator could, in principle, edit a source file, let the runner finish, revert the edit before committing, and produce a row whose SHAs are "clean" even though the bundled code was not. The seal accepts that row because the ancestor + blob checks all match. Closing this hole properly requires running the entire evaluation in an isolated worktree/snapshot. We chose to document it rather than block shipping Phase 0.a.5. In the solo-operator context this policy is written for, the operator is the trusted party; self-tampering is out of scope. Future work may close it.

## Researcher discipline

- **During search:** do not open `data/leaderboard-full*.json`. If you need to inspect why a variant failed selection, look at the agent-visible leaderboard (`scripts/autoresearch/leaderboard*.json`) — it is deliberately stripped of holdout-outcome fields.
- **When promoting a candidate:** go through the full protocol above. Resist the temptation to "just peek" at `data/leaderboard-full*.json` first. The seal is the evaluation; anything earlier is a search signal.
- **If you do peek (you are human):** write the fact down. A seal whose decision was informed by peeking is diagnostic, not final. Note it in the seal file's footer. The point of this policy is to be honest with yourself about what you've seen.

## When seals disagree with search

If a sealed evaluation FAILS but the search loop found the candidate promising, that is the system working correctly. Overfitting to the selection windows is the default failure mode; sealed-holdout is how we detect it. Do not:

- Re-run the runner and re-seal under a new block hash without changing anything substantive.
- Adjust the adoption threshold after seeing the holdout number.
- Combine multiple sealed results to pick a winner.

Do:

- Write the failure down.
- Leave the seal in `docs/holdout-evaluations/`.
- Move on to a genuinely different candidate with a new pre-reg block.

## References

- `scripts/evaluate-holdout.ts` — the ceremony script.
- `scripts/autoresearch/lib/pre-reg-gate.ts` — pre-registration validator (reused by the evaluator).
- `scripts/autoresearch/lib/leaderboard-redaction.ts` — what the agent does not see.
- `tests/holdout-leakage-detection.test.ts` — CI enforcement of redaction.
- `tests/evaluate-holdout.test.ts` — CI enforcement of the seal ceremony.
- `docs/backtest-trust-gotchas.md` — running catalogue of simulator traps that make "holdout passed" a lie.
