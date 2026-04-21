# Holdout-Refresh Policy

**Adopted:** 2026-04-20 (Phase 3.a of the foundation rebuild).
**Applies to:** every autoresearch campaign going forward.
**Companion to:** [docs/sealed-holdout.md](sealed-holdout.md) (single-candidate sealing protocol).

## What this policy is for

`sealed-holdout.md` governs how ONE candidate's evaluation is locked in — one shot, committed record, no re-runs. This policy governs the WINDOW itself: when does the holdout become too worn-out to trust, and how do we roll it forward?

The underlying concern: every time the autoresearch loop produces a pre-reg seal (PASS or FAIL), the researcher learns something about the holdout window's behavior — indirectly, through which configs end up attempting the seal. After enough iterations, the researcher's next candidate is an implicit function of prior holdout outcomes. At that point the holdout has been observed, even though no single person "peeked" at raw numbers.

There is no clean technical fix. The defense is rotation.

## Refresh triggers

A refresh is mandatory when ANY of these fires:

1. **Adoption event (primary).** A strategy has been declared ADOPTED — moved from paper trading to live deployment, or otherwise committed to production. The strategy's developer necessarily iterated on prior holdout signals to get here, so the window is burnt for future research.
2. **Calendar backstop.** 6 months have elapsed since the last refresh. Even if nothing has shipped, accumulated pre-reg seals (PASS or FAIL) count as observations that erode the window's independence.
3. **Cumulative attempts (belt-and-suspenders).** 20 or more distinct strategies have attempted seal against the current manifest. Track via `scripts/autoresearch/lib/trial-ledger.ts` attempt counter. If this fires before the calendar backstop, refresh early — it means research activity has been unusually dense.

The three triggers are OR-joined. Any single trigger requires a refresh.

## How to refresh

All changes go through a single committed PR that updates `config/dataset-manifest.json`:

1. **Extend dataset end-date.** Pull new candles and option chains for the N months of new data (via `scripts/autoresearch/prefetch-data.ts` + `scripts/prefetch-chains.ts`). N should be at least 3 months so the new holdout is not trivially short; 6–12 months is typical.
2. **Roll holdout boundaries.** The new `holdoutStartDate` is the OLD `holdoutEndDate`; the new `holdoutEndDate` is the new `dataEndDate`. Old holdout data becomes new selection data. Alternative: shift the full window forward if the new data is long enough to host a fresh 12-month holdout AND the selection window stays ≥ 5 years.
3. **Update the manifest version field** and add a `notes:` entry describing the refresh trigger and rationale.
4. **Commit the PR against `main`.** The manifest's `rawHash` changes, so every subsequent runner invocation will stamp the new hash into `datasetManifestHash`.
5. **Re-run active strategies.** Any paper-trading strategy gets a fresh evaluation under the new manifest. Strategies that no longer pass `isValid` are retired. Strategies that pass can continue paper trading.
6. **Append to `docs/holdout-refresh-log.md`.** Date, trigger, new window, list of retired/preserved strategies.

## Historical implications

- Pre-refresh runs' `preRegHoldoutWindowHash` remains frozen at the old manifest's hash. Those runs are AUDITABLE but not directly COMPARABLE to post-refresh runs — the underlying data changed.
- `analyze-*.ts` and cross-campaign comparison scripts should filter by `datasetManifestHash` when comparing Sharpe, deflated Sharpe, holdout-OOS ratios, or any statistic that depends on the dataset window.
- Old `leaderboard-full-*.json` and `leaderboard-*.json` files are retained unchanged. A post-refresh campaign can live in a new leaderboard file (via `AUTORESEARCH_LEADERBOARD_SUFFIX`) so rows don't mix manifest versions.
- The existing `adoptionGatesEffectiveHash` + `datasetManifestHash` + `preRegHoldoutWindowHash` triple provides enough provenance to reconstruct any row's exact decision context after the fact.

## What does NOT trigger a refresh

- A rejected strategy (failed pre-reg seal or failed `isValid`). The rejection IS the outcome — no information leaked to future research unless developers iterate on the same failed idea against the same manifest.
- An abandoned mid-research candidate. Treated the same as rejection.
- A strategy adopted under the current manifest but then retired before a refresh event. The retirement counts as a failed adoption; next adoption event is what triggers.
- Routine code changes (strategy rewrites that produce the same `isValid` verdict, refactoring, fixing a bug in `runner.ts`). These may trigger re-evaluation but not a dataset-manifest refresh.

## Edge cases

### Mid-refresh active paper trading

Paper trading on an old-manifest strategy continues through the refresh window. Once the new manifest is committed:
- Re-evaluate the strategy on the new manifest.
- If it still passes, continue paper trading — this is a confirmation signal.
- If it fails, pause paper trading and decide whether to retire, iterate, or accept the live-vs-sim divergence as a live-only phenomenon worth studying.

### Refresh lands while a campaign is running

The runner hashes the manifest at start. If the manifest file changes mid-campaign, `assertGatesUnchanged` (for adoption gates) fires; a similar check for the dataset manifest rejects the run. In practice: finish the campaign, then refresh.

### No new data available (end of dataset)

If the dataset provider is 2 months behind and a refresh is due, wait until N months of fresh data can be pulled. Document the delay in `holdout-refresh-log.md` with the original trigger date + the actual refresh date. Don't rotate with less than 3 months of new holdout data — you'd be creating a worse window than the one you're retiring.

### Multiple triggers overlap

If adoption + calendar fire within a short span, do one refresh that satisfies both. Log both triggers in the log entry. Don't stack refreshes.

## Audit chain

Every refresh produces three artifacts:

1. A committed `config/dataset-manifest.json` change (visible in `git log config/dataset-manifest.json`).
2. A new `datasetManifestHash` stamped on all subsequent `RunResult` rows.
3. A markdown entry in `docs/holdout-refresh-log.md` with:
   - Date.
   - Trigger (adoption / calendar / cumulative).
   - Old window and new window (start/end dates).
   - List of active strategies re-evaluated and their new verdicts.

The chain lets any reviewer reconstruct "what data did the decision to adopt strategy X rely on?" from git history alone.

## Relationship to `sealed-holdout.md`

| Concern | `sealed-holdout.md` | `holdout-refresh-policy.md` (this doc) |
|---|---|---|
| Scope | One candidate | One window (containing many candidates over time) |
| Question | "Has this specific strategy been evaluated exactly once?" | "Is this window still a clean test of out-of-sample generalization?" |
| Mechanism | `docs/holdout-evaluations/*.md` seals | `config/dataset-manifest.json` version bump |
| Enforcement | Runner verifies one-seal-per-block-hash | Git PR + `datasetManifestHash` stamp on every run |

A sealed candidate does not extend the window's life. A window can be refreshed while sealed candidates remain on record — the seals stay as audit artifacts, but new runs against the new manifest produce new seals.
