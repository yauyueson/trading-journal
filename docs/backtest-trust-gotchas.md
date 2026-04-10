# Backtest Trust Gotchas

Every item on this page is a real bug or trap that has produced fake results in this project. Read this before making any claim about a strategy's performance, and add to it every time a new one is found.

**The meta-rule:** when a backtest result looks amazing, assume it's a bug until proven otherwise. The most valuable strategy in this repo (DTE5) has an OOS Sharpe of ~1.4. Anything dramatically higher needs forensic justification, not celebration.

---

## How to use this doc

- **Before trusting a backtest result**, scan the "Fingerprint" column for any match.
- **Before merging simulator changes**, run through the "Known Simulator Bugs" section and verify your change doesn't reintroduce or mirror any listed bug.
- **After finding a new bug**, add an entry here. Minimum fields: what, when, fingerprint, fix, prevention.

---

## Known Simulator Bugs (fixed — do not regress)

### 1. TRAILING_LOCK exit fills at floor threshold, not market price
**Fixed:** 2026-04-10 (commit c55bef9)
**File:** `src/lib/backtest/credit-spread-exit.ts` — `resolveTriggeredCreditExitCost`

**What happened:** TRAILING_LOCK exits booked at `trailingFloorCost` (the trigger threshold) instead of the actual market spread cost. Since the trigger fires *because* the market has moved past the floor, the simulator was claiming fills at a price the market wasn't offering.

**How it was exploited:** The autoresearch agent found `trailingActivatePct: 0.01, trailingFloorPct: 0.99` on delta-0.90 spreads. Activation fired at 1% profit, floor was set at 99% of max profit, trigger condition `currentCost > floorCost` fired immediately, and the exit booked 99% of max profit on day 1. Produced a fake OOS Sharpe of 6.47.

**Fingerprint:**
- OOS Sharpe > 3.0 on 8yr data
- TRAILING_LOCK as dominant exit type (>50% of exits)
- Extreme `trailingActivatePct` or `trailingFloorPct` values (e.g., 0.01 / 0.99)
- Per-trade edge disproportionate to entry credit size
- Standalone MaxDD < 2% over 8 years

**Prevention:**
- `resolveTriggeredCreditExitCost` now returns `clampSpreadCloseCost(currentSpreadCost, ...)` for TRAILING_LOCK (same conservative principle as STOP_LOSS).
- Runner enforces `MAX_SANE_OOS_SHARPE = 3.0` hard sanity gate.
- Unit test in `tests/credit-spread-exit.test.ts` asserts TRAILING_LOCK returns market cost, not floor.

---

### 2. Phantom expiration profits on ITM credit spreads
**Fixed:** 2026-03-28 (pre-audit code replaced by `credit-spread-exit.ts`)
**File:** `src/lib/backtest/credit-spread-exit.ts` — `computeIntrinsicSpreadCloseCost`

**What happened:** Pre-audit code priced all expired spreads as profitable (exit cost = 0), creating phantom wins for ITM-expired spreads. A delta-0.45 credit spread expiring ITM should be at max loss; the bug counted it as max profit.

**How it was exploited:** Short-term 7-21 DTE credit spread sweeps reported OOS Sharpe 2.0-3.1 in `sweep-results.json`. Re-audit with intrinsic-clamped expiration pricing collapsed them to negative Sharpe.

**Fingerprint:**
- Short-DTE credit spreads reporting Sharpe > 1.5
- High win rate (>80%) at delta > 0.30
- EXPIRATION exits producing high profit
- Mid-fill mode without bid/ask slippage

**Prevention:**
- `computeIntrinsicSpreadCloseCost` now correctly handles ITM expiration.
- Any claim of short-DTE credit spread Sharpe > 1.0 must be re-verified against current simulator.
- Do not treat `sweep-results.json` or `data/wfa-results.json` as validated baselines.

---

### 3. Mid-fills overstate options performance
**Fixed:** 2026-03-25 onward (fillMode: 'bidask' is now the default)
**File:** `src/lib/backtest/option-sim.ts`, `slippage.ts`

**What happened:** Mid-price fills assume you can execute at the midpoint of the bid/ask spread. For deep ITM LEAPs and wide credit spreads, the bid/ask spread can be 5-10% of the contract value. Mid fills claim that free.

**Fingerprint:**
- Backtest uses `fillMode: 'mid'` without slippage model
- Deep ITM contracts (delta > 0.70)
- Thin-volume contracts (OI < 100)
- Swing strategy Sharpe 1.275 claim from pre-audit era

**Prevention:**
- `DEFAULT_CREDIT_CONFIG.fillMode = 'bidask'`.
- `slippage.ts` applies `DEFAULT_DYNAMIC_SLIPPAGE` to all realistic backtests.
- Swing (45-65 DTE) strategy is retired.

---

## Known Traps (not bugs, but easy to fall into)

### 4. IV rank filter that starves the strategy
**Where:** entry filters

**What:** IV rank > 30 on ETFs sounds plausible but kills 70-80% of signals because ETF IV clusters low. A filter that removes most signals is not "quality filtering" — it's overfitting to a subset with spurious characteristics.

**Fingerprint:**
- Signal count drops >50% when adding the filter
- Standalone Sharpe stays flat or worsens
- Correlation with baseline barely moves

**Prevention:** Any new entry filter must be measured on *trade count* first. If it cuts signals >30%, it must produce a proportional Sharpe improvement or it's a trap.

---

### 5. Multi-day monitoring interval creates MtM gaps
**Where:** `SimConfig.monitoringIntervalDays`

**What:** Setting `monitoringIntervalDays > 1` skips days in the spread valuation loop. This hides drawdowns between monitoring checks and distorts the daily Sharpe calculation — the strategy looks smoother than reality.

**Fingerprint:**
- Sharpe appears artificially stable
- Daily return series has gaps
- MaxDD unusually low for the strategy type

**Prevention:** Use `monitoringIntervalDays: 1` for all realistic backtests. Any multi-day interval needs a written justification.

---

### 6. Using `hv30d` from ORATS
**Where:** VRP computation, regime gates

**What:** ORATS `/hist/cores` does not provide `clsHv30d` — it skips from 20d to 60d. `orats_iv_cache.hv30d` is always NULL. Code that reads `hv30d` silently gets 0 or NaN and produces garbage VRP values.

**Fingerprint:**
- VRP values appear as 0 or NaN for most dates
- Regime gates never fire
- Works in unit tests with mock data, fails on real data

**Prevention:** Use `hv20d` for all VRP computation (IV30² - HV20²).

---

### 7. `missingChainExitAfterDays` disabled
**Where:** `SimConfig.missingChainExitAfterDays`

**What:** When chain data is missing for a trade date, the sim either holds the position (intended) or exits immediately (bug). Setting this to a low value (1-3 days) causes premature exits during sparse data windows, losing +0.56 Sharpe.

**Fingerprint:**
- NO_CHAIN exit type dominates (>10%)
- Dates with missing chain data cluster in early period
- Same strategy produces very different Sharpe on different date ranges

**Prevention:** Keep `missingChainExitAfterDays: 999` in all configs. Per `backtest-engine.md` domain constraints.

---

### 8. Slot allocator adverse selection (dual-direction strategies)
**Where:** `wfa-options.ts` `evaluateConfiguredSignalsWithConstraints`

**What:** When a strategy fires both bull and bear signals, alphabetical/insertion-order slot allocation fills bull signals first. Bear signals only get filled on broad-weakness days — precisely when bear calls get crushed by mean-reversion rallies. The slot allocator creates anti-alpha in the minority direction.

**Fingerprint:**
- Dual-direction strategy where one direction dominates trade count
- Minority direction has strongly negative standalone Sharpe
- Disabling the minority direction improves combined Sharpe

**Prevention:** Either disable minority direction, or redesign slot allocation to be direction-symmetric.

---

## Sanity bounds (auto-enforced)

Any backtest result that violates these should be treated as a bug until proven otherwise:

| Metric | Sanity bound | Enforced in |
|---|---|---|
| OOS Sharpe on 8yr data | ≤ 3.0 | `scripts/autoresearch/runner.ts` — `MAX_SANE_OOS_SHARPE` |
| Standalone MaxDD on 8yr data | > 2% | (manual check — add if violated again) |
| Per-trade edge as % of max profit | < 95% | (manual check — add if violated again) |
| Win rate on credit spreads | < 85% | (varies by delta, but > 90% at delta > 0.30 is suspect) |
| Holdout/OOS ratio | > 0.5 and < 2.0 | `runner.ts` warning only; hard bound not yet set |

These bounds are intentionally loose. Anything beyond them is almost always a structural bug, not genius.

---

## Validation discipline

These are not bugs — they are process failures that let bugs through.

### Holdout is not a free lunch
If you iterate on a strategy based on holdout feedback (even indirectly — "this config has holdout Sharpe X"), you have turned holdout into another optimization target. Real holdout is a write-once gate: one run, accept or reject, never revisit. The runner hides exact holdout Sharpe for this reason (shows PASS/FAIL only).

### Deflated Sharpe over many attempts
After N attempts of random strategies, the expected maximum Sharpe from pure noise is `sqrt(2 * ln(N))`. For 100 attempts that's ~3.0. The `computeDeflatedSharpe` function in `runner.ts` subtracts this — a deflated Sharpe < 0 means the result is indistinguishable from noise even if raw Sharpe is 2+.

### Bootstrap CI for time series needs block bootstrap
I.i.d. bootstrap understates CI width for daily returns because it ignores autocorrelation. Use block bootstrap with block size ~sqrt(n). Already implemented in `bootstrapSharpeCI`.

### Structural bugs pass all statistical checks
Holdout, bootstrap, and deflated Sharpe all assume the simulator is trustworthy. **None of them caught the TRAILING_LOCK bug** because the bug produces consistent fake profits across all time periods. The only defense against structural bugs is sanity bounds + code review + adversarial testing.

---

## Appendix: adding a new gotcha

When you find a new gotcha, add an entry with this shape:

```markdown
### N. Short descriptive title
**Fixed:** <date> (commit <hash>)  // or "Trap — no code fix" if behavioral
**File:** `path/to/file.ts` — `functionName` (if applicable)

**What happened:** One paragraph. Be specific about the incorrect behavior.

**How it was exploited / discovered:** How the bug was found or what it cost.

**Fingerprint:**
- bullet list of observable signs
- prefer metrics and exit-type distributions over vague descriptions
- something you can actually grep for

**Prevention:**
- code fix applied
- test that enforces the invariant
- documentation or process change
```

Then add any unit-testable invariant to `tests/backtest-audit.test.ts`.
