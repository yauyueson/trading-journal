# Campaign E-Clean — Pre-Registration

**Date pre-registered:** 2026-04-17
**Author:** Claude Code + yauyueson
**Trigger:** [scripts/autoresearch/campaign-e-audit.md](../scripts/autoresearch/campaign-e-audit.md) — Campaign E v1 was contaminated by holdout leakage, wrong incumbent, and post-hoc threshold reclassification. Infrastructure now remediated.

**Purpose:** One bounded pre-registered test around the Campaign D strict winner `d65-sl35-ts105`, covering:
1. Untested SimConfig combinations that Campaign D's 26-variant grid missed
2. The specific signal-level hypothesis that emerged from contaminated Campaign E (ema3d + noNT), evaluated under strict pre-registration

**Key commitment:** Grid is fixed below. No iteration, no mid-run additions. One runner invocation per strategy file, two invocations total, one decision at the end.

---

## Incumbent

From [scripts/autoresearch/campaign-d-results.md](../scripts/autoresearch/campaign-d-results.md):
- Strategy: `d65-sl35-ts105`
- Deep ITM LEAP CALL, 14 tickers (GLD, IWM, AAPL, MSFT, GOOG, AMZN, META, JPM, GS, COST, UNH, NFLX, NVDA, TSLA)
- δ [0.65, 0.80], DTE [180, 270], TP 0.40, SL 0.35, TS 105, contangoPct < 48, EMA34 rising 5d, 0–5% band
- **Selection combined Sharpe: 1.188** (this is the number to beat)
- Holdout Sharpe 1.067, IR 0.776 — both pass gate

## WFA structure (fixed, same as Campaign A and D)

- `trainWindowDays: 252`, `forwardStepDays: 126`, `purgeGapDays: 10`, `mode: 'rolling'`, `holdoutCount: 5`
- Selection 2019-01-17 → 2024-01-19 (10 windows), holdout 2024-01-22 → 2026-02-27 (5 windows)

## The 8-variant grid

### Invocation 1 — `strategy-campaign-e.ts` (baseline signals, 5 variants)

Same signal generator as `d65-sl35-ts105`. Only SimConfig differs.

| # | Name                    | SL   | TS  | TP   | Rationale                                       |
|---|-------------------------|------|-----|------|-------------------------------------------------|
| 1 | `ceC-inc`               | 0.35 | 105 | 0.40 | Incumbent anchor (sanity reproduction)          |
| 2 | `ceC-sl35-ts150`        | 0.35 | 150 | 0.40 | Combines Campaign D's top-2 axes — not tested   |
| 3 | `ceC-sl33-ts105`        | 0.33 | 105 | 0.40 | Tighter SL than incumbent (contaminated-E probe)|
| 4 | `ceC-sl33-ts150`        | 0.33 | 150 | 0.40 | Tighter SL + longer TS — contaminated iter-1    |
| 5 | `ceC-sl35-ts150-tp50`   | 0.35 | 150 | 0.50 | Longer TS + wider TP — capture late-expiry theta|

### Invocation 2 — `strategy-campaign-e-signals.ts` (ema3d + 12-ticker subset, 3 variants)

Signal changes from baseline:
- EMA34 rising over **3 days** instead of 5 days
- **12 tickers** (drop NVDA and TSLA — "noNT" subset)
- Everything else (SPY gate, EMA55 gate, EMA8>EMA13, 0–5% band, contangoPct<48) unchanged

| # | Name                          | SL   | TS  | TP   | Rationale                                     |
|---|-------------------------------|------|-----|------|-----------------------------------------------|
| 6 | `ceC-ema3d-noNT-inc`          | 0.35 | 105 | 0.40 | Signal + ticker changes alone, SimConfig inc. |
| 7 | `ceC-ema3d-noNT-sl35-ts150`   | 0.35 | 150 | 0.40 | Signal changes + TS extension                 |
| 8 | `ceC-ema3d-noNT-sl33-ts150`   | 0.33 | 150 | 0.40 | Matches contaminated-E iter-10 SimConfig      |

## Decision rule (pre-committed, verbatim)

1. Both invocations write to the same leaderboard suffix `campaign-e-clean`. Unified ranking across all 8 variants.
2. Filter to variants that pass **all** of these gates:
   - `isValidForSearch` (passesMinTrades ≥ 60, passesMaxDD ≤ 45%, passesWFA, passesSanity, passesDeltaGates)
   - `passesHoldoutOrIR` (holdout Sharpe ≥ 0.3 OR holdout SPY IR ≥ 0.3)
   - `passesHoldoutNewEntries` (`newHoldoutTrades ≥ 1`)
   - Deflated Sharpe > 0 under **global N** (data/attempts-global.json at run time)
3. Rank valid variants by **selection combinedSharpe** (50/50 with DTE5).
4. **Adopt the top-ranked variant** as new champion IF AND ONLY IF its combinedSharpe ≥ **1.218** (incumbent 1.188 + 0.03 adoption margin).
5. If no variant clears 1.218, incumbent `d65-sl35-ts105` is retained. This is a legitimate null outcome.
6. Holdout metrics are **observed**, not used for ranking.

## Hard commitments

- No mid-run variant additions
- No post-hoc threshold adjustments (adoption bar is 1.218 regardless of what the sweep produces)
- No re-ranking on holdout metrics
- No cherry-picking "this one passed holdout even though it ranked 3rd on selection"
- If the sweep produces a win at combined 1.21 (just under the bar), that is a null and incumbent stays

## Run commands

```bash
# Invocation 1: baseline signals + 5 SimConfig variants
AUTORESEARCH_LEADERBOARD_SUFFIX=campaign-e-clean \
  AUTORESEARCH_STRATEGY_FILENAME=strategy-campaign-e.ts \
  AUTORESEARCH_MIN_OOS_TRADES=60 \
  npx tsx scripts/autoresearch/runner.ts

# Invocation 2: ema3d + noNT signals + 3 SimConfig variants
AUTORESEARCH_LEADERBOARD_SUFFIX=campaign-e-clean \
  AUTORESEARCH_STRATEGY_FILENAME=strategy-campaign-e-signals.ts \
  AUTORESEARCH_MIN_OOS_TRADES=60 \
  npx tsx scripts/autoresearch/runner.ts
```

## Expected outcomes and priors

- **Most likely (estimated 60%):** no variant clears 1.218. Incumbent retained. Supports the audit's conclusion that the d65 neighborhood is empirically exhausted.
- **Possible (estimated 25%):** `ceC-sl35-ts150` or `ceC-sl33-ts150` clears the bar by a small margin. If so, adoption is defensible because these are single-parameter extensions of the incumbent, not stacked signal changes.
- **Unlikely but possible (estimated 15%):** one of the ema3d-noNT variants clears the bar. If so, adoption requires careful review — stacked signal + SimConfig changes are higher overfit risk.

Writing priors down publicly so we can audit ourselves after the fact.

## Artifacts to produce

- `scripts/autoresearch/leaderboard-campaign-e-clean.json` — agent-visible (holdout stripped)
- `data/leaderboard-full-campaign-e-clean.json` — full metrics including holdout
- `scripts/autoresearch/campaign-e-clean-results.md` — final analysis + decision (written after both invocations complete)

## Do NOT

- Restart a new Campaign E-clean with a different grid if this one returns null
- Add more variants "because the first round was inconclusive"
- Re-interpret the adoption bar after seeing results
- Run the agent-driven overnight loop (`run-campaign-e-overnight.sh`) — that's Option 1, which we explicitly declined
