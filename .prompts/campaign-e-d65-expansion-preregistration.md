# Campaign E — d65 Alpha Expansion Pre-Registration

**Date pre-registered:** 2026-04-16 (after Campaign D sensitivity sweep)
**Purpose:** Bounded agent-driven expansion around Campaign D's two winning variants (`d65-sl35-ts105` and `d65-tp40-ts150`) to capture any remaining alpha in the d65 family that the static 26-variant sweep missed.

**Scope is deliberately tight.** This is NOT an open exploration — it's a focused expansion in a verified-productive neighborhood.

---

## Hard constraints (no iteration escapes these)

### 1. Maximum 10 iterations

After 10 iterations, the loop stops regardless of findings. Anything beyond would risk over-iteration on holdout.

### 2. Stay in the d65 family

Allowed changes per iteration:
- Parameter combinations NOT in Campaign D's 26-variant grid (e.g., `sl35 + ts150`, `sl33 + ts120`)
- Signal-logic tweaks to the d65-tp40 baseline (EMA band width, regime gates, proximity scoring)
- Ticker subset adjustments (subsets of the 14-ticker set only)
- `configVariants` parameter sweeps within the ts/sl/tp/delta neighborhood

Forbidden changes (out of scope for Campaign E):
- Different option modes (CREDIT_SPREAD, non-LEAP) — belongs to a different campaign
- Different tickers outside the 14-set
- Non-momentum signals (already exhausted by Option 3)
- Completely new signal family (e.g., RSI, VRP, volume-based entries)

### 3. Holdout discipline preserved

- Holdout Sharpe, IR, excess return REMAIN stripped from agent-visible leaderboard.
- Agent sees only PASS/FAIL gates and holdout stability labels.
- We do NOT re-run the Campaign D baseline; its holdout is already observed and cannot be re-spent.

### 4. Validity gates unchanged from Campaign D

- OOS Sharpe > 0
- OOS trades ≥ 60 (prorated for pre-2024 selection)
- MaxDD ≤ 45%
- Deflated Sharpe > 0 (under new N = 26 + 10×~5 = ~76 attempts)
- Delta gate vs naive baseline must pass

## WFA (same as Campaign D)

- `trainWindowDays: 252`, `forwardStepDays: 126`, `purgeGapDays: 10`, `rolling`, `holdoutCount: 5`
- Selection: 2019-01-17 → 2024-01-19
- Holdout: 2024-01-22 → 2026-02-27

## Leaderboard isolation

- `AUTORESEARCH_LEADERBOARD_SUFFIX=campaign-e`
- `AUTORESEARCH_STRATEGY_FILENAME=strategy-campaign-e.ts`
- `AUTORESEARCH_MIN_OOS_TRADES=60`

Campaign D's leaderboard is NOT carried forward — agent starts with just the Campaign D summary in the seeded journal.

## Decision rule (pre-committed)

After the 10 iterations (or earlier if agent runs out of ideas):

1. Identify the strategy with **highest selection combinedSharpe** that passes validity + deflated>0.
2. Compare against Campaign D's `d65-tp40-ts150` (combined 1.180, my recommended adoption from Campaign D).
3. **Adopt the Campaign E winner IF** it beats the Campaign D incumbent by ≥ **0.03** combined Sharpe (a tighter bar than Campaign D's 0.05 because we've already extracted the cheap alpha).
4. If no variant clears +0.03, Campaign E concludes with the Campaign D winner unchanged.
5. Holdout is observed once per final-round candidate, not used for ranking.

## Expected results

Honest expectation: we'll either find one or two more small alpha improvements (combined +0.02 to +0.08 range) from untested combinations, or confirm the d65 family is exhausted at ~1.18-1.19. Either outcome is useful.

A combined Sharpe > 1.30 would be surprising and should be scrutinized for overfit — flag it if it happens.

## Artifacts

- Pre-reg: this file, frozen before the loop starts
- Seeded strategy: `scripts/autoresearch/strategy-campaign-e.ts`
- Seeded journal: `scripts/autoresearch/journal-campaign-e.md`
- Program briefing: `scripts/autoresearch/program-campaign-e.md`
- Results: `scripts/autoresearch/campaign-e-results.md` (written after loop completes)
- Shell: `scripts/autoresearch/run-campaign-e-overnight.sh`
