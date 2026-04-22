# PMCC QQQ — First Post-Overhaul LEAP Campaign

**Adopted:** 2026-04-22
**Context:** First LEAP-family autoresearch campaign under the post-overhaul code base (sealed-holdout protocol, hardened simulator, statistical gates). Prior 30-ticker LEAP CALL family was confirmed dead by 2026-04-22 replicate of the 2026-04-18 naive-baseline diagnostic (holdout SPY IR −0.337, bit-exact replication).

## Why PMCC, why QQQ, why now

**Why PMCC (diagonal):** The prior LEAP failures were all long-CALL-only structures on broad baskets. The 2026-04-18 naive-baseline result showed the basket itself underperforms SPY in holdout regardless of ranking signal. Any new long-CALL bet on the same universe re-runs a known failure. PMCC is structurally different — it earns theta from rolled short calls, which flips the P&L regime: the strategy wins in sideways/drawdown months where naked LEAP calls bleed.

**Why QQQ:** Single-ticker mirrors the successful DTE5 pattern (one high-quality instrument, not a basket). QQQ is the benchmark for LEAP strategies in retail options lore; it has deep option liquidity and a clean dividend calendar. Single-ticker also caps the simulator edge-case surface area during a first diagonal build.

**Why now:** The engine overhaul is complete, the sealed-holdout protocol is in force, and DTE5 has validated that the full post-overhaul pipeline can produce a sealed PASS. PMCC is the logical next structurally-different family to test.

## Phase E1 — Engine: `simulateDiagonal`

### Mechanics committed to simulate

| Event | Behavior |
|---|---|
| Open (day 0) | Buy 1 QQQ LEAP call. Sell 1 QQQ shorter-dated OTM call. Net debit = long premium − short premium. |
| Daily | Mark both legs to mid. Combined dailyMtM = Δ(long) + Δ(short) with sign flipped for short. |
| Short call exits | (a) expires OTM → keep full credit; (b) closed early at 50% profit target → roll; (c) approaching ITM with DTE ≤ 2 → close at ask, roll immediately. |
| Roll cadence | New short call opened targeting configured DTE range, repeating until long exits. |
| Long exits | (a) profit target on long leg; (b) stop loss on long leg; (c) time stop at configured DTE remaining. Short leg closed simultaneously. |
| Assignment edge | If short expires ITM without a roll: P&L capped at (K_short − K_long) × 100 + original short credit. |

### Accepted simplifications

1. **No early assignment of short call.** Only expiry-time assignment. American-style early-assignment on ex-div accepted as documented limitation (QQQ's dividend is small; expected impact on aggregate P&L negligible).
2. **Single short call at a time.** No layered shorts or partial hedging.
3. **Roll rule fixed.** `DTE ≤ 2 OR underlying within 2% of short strike`. Not parameterized in the first version.
4. **Mid fills + `applyFill` slippage.** Same model as `simulateBuyWrite`.

### Capital-at-risk

`(longPremium − shortPremium) × 100` — the net debit, not the full long-leg cost. Matches how PMCC is actually sized. Applied in both `computeOptionAnalytics` and `capitalAtRisk`.

### Config schema additions

```ts
diagLongDeltaRange: [number, number];      // e.g., [0.70, 0.80]
diagLongDTERange: [number, number];        // e.g., [240, 300]
diagShortDeltaRange: [number, number];     // e.g., [0.20, 0.30]
diagShortDTERange: [number, number];       // e.g., [30, 45]
diagLongProfitTarget: number;              // e.g., 0.40
diagLongStopLoss: number;                  // e.g., 0.35
diagLongTimeStopDTE: number;               // e.g., 90
diagShortProfitTarget: number;             // e.g., 0.50
diagRollTriggerMoneyness: number;          // e.g., 0.02
```

### OptionTrade extension

```ts
diagonalLegs?: {
  longCall: OptionLeg;
  shortCallCycles: ShortCallCycle[];  // one entry per short-call lifecycle
};
```

### Dispatcher guards

Both `scripts/eval-worker.ts` and `scripts/autoresearch/worker.ts` throw an explicit error on `mode === 'DIAGONAL'`. The PMCC campaign runs through a dedicated entry path that calls `simulateDiagonal` directly, mirroring how `replicate-bxm.ts` calls `simulateBuyWrite`.

### Reference oracle (three layers)

1. **Unit tests on mocked chains** — happy path, assignment at expiry, roll before expiry, profit target, time stop, capital-at-risk.
2. **Decomposition identity** — on any month where the short call expires worthless, `simulateDiagonal`'s combined P&L must equal `simulateLeap`(long only) + short premium. Catches leg-reconciliation bugs.
3. **Hand-calculated reference scenarios** — three canonical QQQ PMCC months from 2022-2023 using real cached chain data:
   - Happy month (QQQ drifts up ~2%, short OTM expiry)
   - Rolled month (QQQ rallies past short strike mid-cycle)
   - Drawdown month (QQQ drops ~4%)

   Each month's expected combined P&L hand-computed to ±0.5% of capital. Fixture at `tests/fixtures/pmcc-reference-scenarios.json`. Simulator must match all three before Phase E2 begins.

Plus one property test: combined dailyMtM must sum to exit P&L (phantom-expiration guard).

### Implementation order

1. Extend types (`OptionMode`, `OptionTrade.diagonalLegs`, `SimConfig.diag*`).
2. Dispatcher guards (both workers throw on DIAGONAL).
3. `simulateDiagonal` skeleton mirroring `simulateBuyWrite`.
4. Capital-at-risk branches.
5. Mocked-chain unit tests → pass.
6. Hand-compute oracle fixtures.
7. Iterate against oracle → match.
8. Decomposition + dailyMtM sum consistency tests.
9. Codex round 1 — single round target (reference-driven TDD, per BXM retrospective).
10. Fix findings, PR merge.

**Scope estimate:** ~600 LoC simulator + ~400 LoC tests + ~100 LoC fixtures = ~1100 LoC. 3-5 days including Codex round.

**Rollback-safety:** all additive. No existing simulator path changes.

## Phase E2 — Autoresearch campaign

### Hypothesis (pre-reg claim)

> A systematic PMCC on QQQ — long deep-ITM LEAP (delta ~0.75, DTE ~270), rolled short OTM calls (delta ~0.25, DTE ~30-45) — earns positive risk-adjusted alpha over buy-and-hold SPY across the 2024-01-22 → 2026-02-28 holdout window. Primary edge mechanism: short-call theta captured during QQQ's drawdown and sideways periods cushions the long-leg beta exposure enough to beat SPY's risk-adjusted return.

### Strategy file

`scripts/autoresearch/strategy-pmcc-qqq.ts`:
- Ticker: QQQ only.
- Portfolio: `maxPositions: 1, maxPerTicker: 1, startingCapital: 10000`.
- Entry signal: **always-in**. Open a new PMCC whenever the previous one exits. No EMA/VIX/IV overlay on the first test. The structure itself is under test, not a timing filter on top.
- `score: 0`.

### Config grid — 4 variants

| ID | Long δ | Long DTE | Long PT | Long SL | Long TS | Short δ | Short DTE | Short PT |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| pmcc-anchor | 0.75 | 270 | 40% | 35% | 90 | 0.25 | 45 | 50% |
| pmcc-tight-short | 0.75 | 270 | 40% | 35% | 90 | 0.30 | 30 | 50% |
| pmcc-loose-short | 0.75 | 270 | 40% | 35% | 90 | 0.20 | 45 | 50% |
| pmcc-high-pt | 0.75 | 270 | 50% | 35% | 90 | 0.25 | 45 | 50% |

Four variants deliberate. No sweep. Discipline: the DSR denominator is N=4 for this pre-reg block, not 50.

### WFA split

Reuse current manifest. Selection 2017-01-01 → 2024-01-21, holdout 2024-01-22 → 2026-02-28. `holdoutCount=5`, rolling forward step 126 days. Same burnedness caveat as DTE5's seal; same comparability.

### Decision rule

1. Pick the variant with highest **selection** combinedSharpe (no holdout peek).
2. Commit that variant's strategy file SHA.
3. Run sealed-holdout ceremony.
4. Write seal file regardless of PASS/FAIL.

### Adoption threshold (all must pass)

- `holdoutSpyIR ≥ 0`
- `holdoutSharpe ≥ 0.3`
- `oosSharpe ≥ 0.8`
- `passesStability = true`
- `passesStatConsistency = true`
- `deflatedSharpeMertens > 0`

### Pre-registration block template

```
## Pre-Registration — PMCC QQQ first systematic test
Hypothesis: Systematic PMCC on QQQ earns positive holdout SPY-IR
  under tightened sealed-holdout regime.
Config Grid: 4 variants (pmcc-anchor, pmcc-tight-short, pmcc-loose-short,
  pmcc-high-pt). See scripts/autoresearch/strategy-pmcc-qqq.ts.
Decision Rule: Winner = highest selection combinedSharpe; no holdout peek.
Adoption Threshold: holdoutSpyIR ≥ 0 AND holdoutSharpe ≥ 0.3 AND
  oosSharpe ≥ 0.8 AND passesStability AND passesStatConsistency AND
  deflatedSharpeMertens > 0.
Holdout Window Hash: sha256:<placeholder-64hex>
Declared Env Overrides: none.
```

### Expected runtime

~1.5-2 hours for all 4 variants (single ticker, WFA + 5 holdout folds).

### Execution order

1. Phase E1 engine PR merged, tests green, Codex clean.
2. Strategy file + pre-reg block committed.
3. Run campaign (`AUTORESEARCH_LEADERBOARD_SUFFIX=pmcc-qqq`, no bypass — this is a real candidate).
4. Select winner from selection-only metrics.
5. Run `scripts/evaluate-holdout.ts` against winner.
6. Seal file lands in `docs/holdout-evaluations/`.
7. Outcome-driven next step:
   - PASS → consider small live size or plan Phase E3 (D2 basket or signal overlay, new pre-reg).
   - FAIL → write it down, move on (likely B: PUT LEAPs).

## How this evolves

Autoresearch evolution is **sequential across campaigns**, not parallel within one. The 4-variant grid is frozen before running. Each sealed outcome informs the *next* pre-reg. This is the post-overhaul discipline — opposite of the Campaign-A-to-E era's iterate-and-cherry-pick pattern.

## References

- [docs/sealed-holdout.md](../../sealed-holdout.md) — one-evaluation-per-candidate policy.
- [docs/holdout-refresh-policy.md](../../holdout-refresh-policy.md) — window rotation rules.
- [docs/backtest-trust-gotchas.md](../../backtest-trust-gotchas.md) — running catalogue of simulator traps.
- [scripts/autoresearch/diagnose-naive-baseline-results.md](../../../scripts/autoresearch/diagnose-naive-baseline-results.md) — 2026-04-18 diagnostic that killed the prior LEAP family.
- [docs/superpowers/specs/2026-04-18-phase-0c9-bxm-replication-plan.md](./2026-04-18-phase-0c9-bxm-replication-plan.md) — the BXM plan whose retrospective shaped this reference-driven TDD approach. *(if present; otherwise the plan lived in `~/.claude/plans/calm-weaving-wilkinson.md`)*
