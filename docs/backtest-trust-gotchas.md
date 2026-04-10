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

### 4. BSM spread cost not capped at spread width — impossible PnL
**Fixed:** 2026-03-23 (commit b1b9853)
**File:** `src/lib/backtest/intraday-monitor.ts`

**What happened:** BSM theoretical prices can exceed the spread width for deep-ITM legs. On a $10-wide defined-risk spread, the simulator produced spread cost > $10, realising impossible losses like -$1M on a single position. Defined-risk strategies by definition cap loss at `width - credit`; this bug violated that.

**Fingerprint:**
- Defined-risk credit spreads showing losses beyond max loss (pnl < -max_loss)
- Unreasonable daily MtM swings on deep-ITM positions
- Short-term SL study showing "blow up" Grade F with 999% drawdowns

**Prevention:** `clampSpreadCloseCost(cost, spreadWidth)` must clamp to `[0, spreadWidth]` after both BSM repricing and daily chain calibration.

---

### 5. BSM spread cost floor of 0 destroys profitable MtM
**Fixed:** 2026-03-23 (commit 04868af)
**File:** `src/lib/backtest/intraday-monitor.ts`

**What happened:** The previous fix for #4 used `Math.max(0, cost)` which clipped profitable positions where BSM prices the spread cost below zero (a good thing — indicates full decay). Clamping those to 0 eliminated the profit signal and destroyed daily MtM accuracy for winners. Dropped short-term baseline Sharpe from 2.23 to 0.45.

**Fingerprint:**
- Sharpe drops dramatically after "fixing" a BSM cap bug
- Daily MtM shows spread cost floored at 0 for many dates
- PROFIT_TARGET exits undercount versus EXPIRATION

**Prevention:** Only clamp at the upper bound (spread width). Negative theoretical cost means the short leg is worth less than the long leg — that's a profitable MtM signal, not an error. `clampSpreadCloseCost` now only clamps upward. **The two BSM bugs together teach:** any boundary fix needs an adversarial test for the opposite direction before merging.

---

### 6. Max drawdown computed as absolute sum, not % of peak equity
**Fixed:** 2026-03-07 (commit d189e98)
**File:** `src/lib/backtest/analytics.ts`

**What happened:** Two variants of the same bug:
1. **Stock DD:** peak initialized to 0, cumReturn started at 0, so `DD = peak - cumReturn` was an absolute drop multiplied by 100 — wrong units.
2. **Option DD** (primary): per-trade returns were premium fractions (+0.35 TP, -0.30 SL). Cumulating 1000+ of these made `optCum` reach 8-10 units, so a 2-unit drop became `optMaxDD = 2.0 × 100 = 200%`. Meaningless as a portfolio metric.

**How it was discovered:** Backtest results showed MaxDD > 100% on strategies that obviously couldn't lose more than starting capital.

**Fingerprint:**
- MaxDD > 100% on any equity-based strategy (impossible by construction)
- MaxDD scales with trade count rather than capital drawdown
- Same strategy shows wildly different DD on different date ranges

**Prevention:** Track equity starting at 1.0. Compute `DD = (peak - equity) / peak`. Standard finance definition: drawdown as % of peak equity, always in [0, 100].

---

### 7. MaxDD under-reported due to trades in insertion order instead of exit date
**Fixed:** 2026-03-11 (commit 4ba00ba)
**File:** `src/lib/backtest/option-sim.ts` — `computeOptionAnalytics`

**What happened:** The equity curve for MaxDD was built by iterating trades in insertion order (signal order or ticker order), not by exit date. A strategy that opened many concurrent losing positions then closed them all together would look like steady growth — the equity dip during the holding period was invisible because it was never realized in order.

**Fingerprint:**
- MaxDD suspiciously low on multi-ticker strategies with long holds
- Concurrent positions (many simultaneous trades) + flat DD curve
- Sharpe plausible but MaxDD feels wrong for the strategy type

**Prevention:** Always sort trades by `exitDate` before constructing the equity curve. The chronological realization order is the only correct sequence for drawdown metrics.

---

### 8. Walk-forward purge gap too short for options (5 days vs required DTE)
**Fixed:** 2026-03-10 (commit aad1e75)
**File:** `src/lib/backtest/types.ts` — `WalkForwardConfig.purgeGapDays`

**What happened:** The default purge gap between IS and OOS windows was 5 days — sufficient for stock strategies. For options strategies where positions can hold 45-65 DTE, this creates a 60-day overlap where IS-window positions are still open when OOS window starts. Look-ahead leakage at both ends: OOS signals use information from positions opened in IS, and IS optimization rewards configs that "pre-load" positions into the transition.

**Fingerprint:**
- Option strategy WFA with `purgeGapDays < max DTE`
- IS/OOS Sharpe gap smaller than expected (look-ahead leakage smoothing the transition)
- Positions with `entryDate` in IS and `exitDate` in OOS

**Prevention:** For options: `purgeGapDays >= max DTE` (default 65). Enforced by unit test in `tests/backtest-audit.test.ts`: "default purge gap is 65 for options (matches max DTE)".

---

### 9. IV Rank silently inflated (realized vol stored in IV column)
**Fixed:** 2026-03-03 (commit 81633a7)
**File:** `api/backfill-iv-history.js`, `api/cron-iv-snapshot.js`, `src/lib/services/ivRank.ts`

**What happened:** The `backfill-iv-history` script stored Realized Volatility in the `iv30` column, but `getIVRank()` treated all rows as Implied Volatility. Since RV < IV (volatility risk premium), the backfilled values were systematically lower than live values, pushing the IV Rank percentile to ~100% for most tickers. QQQ showed 100% IV Rank constantly, which silently disabled any strategy with an `ivRankMin` filter (everything passed).

**Fingerprint:**
- IV Rank near 100% for most tickers most of the time
- `ivRankMin` filter doesn't change signal counts
- Backfilled dates show dramatically different IV than live dates for the same ticker

**Prevention:** Added a `source` column (`live_iv` vs `rv_proxy`) to `ticker_iv_snapshots`. `getIVRank()` filters to `live_iv` only. Any future backfill using a proxy must tag the source.

---

### 10. IV Rank filter silently bypassed (empty cache rejected as null)
**Fixed:** 2026-04-01 (commit 0692eb0)
**File:** `scripts/short-put-1dte.ts`

**What happened:** The `orats_cores_cache` table was empty (separate data source from the chain cache). When the backtest asked for IV Rank, every lookup returned null. The filter treated null as "reject trade" rather than "missing data," so IV-rank-gated strategies silently ran with ALL trades rejected. Sharpe 0 everywhere was the symptom — but it looked like "the filter is just very restrictive" rather than "the data source is broken."

**Fingerprint:**
- Strategy with IV Rank filter produces 0 trades regardless of threshold
- Removing the filter makes the strategy behave normally
- `orats_cores_cache` has no rows, or all IV values are null

**Prevention:** Compute ATM IV directly from the 13GB chain cache (nearest-to-ATM option with DTE 20-40 as IV30 proxy) rather than relying on a separate cores cache. Any future filter using an external data source must assert non-empty data at startup and fail loud, not silently.

---

## Known Traps (not bugs, but easy to fall into)

### 11. IV rank filter that starves the strategy
**Where:** entry filters

**What:** IV rank > 30 on ETFs sounds plausible but kills 70-80% of signals because ETF IV clusters low. A filter that removes most signals is not "quality filtering" — it's overfitting to a subset with spurious characteristics.

**Fingerprint:**
- Signal count drops >50% when adding the filter
- Standalone Sharpe stays flat or worsens
- Correlation with baseline barely moves

**Prevention:** Any new entry filter must be measured on *trade count* first. If it cuts signals >30%, it must produce a proportional Sharpe improvement or it's a trap.

---

### 12. Multi-day monitoring interval creates MtM gaps
**Where:** `SimConfig.monitoringIntervalDays`

**What:** Setting `monitoringIntervalDays > 1` skips days in the spread valuation loop. This hides drawdowns between monitoring checks and distorts the daily Sharpe calculation — the strategy looks smoother than reality.

**Fingerprint:**
- Sharpe appears artificially stable
- Daily return series has gaps
- MaxDD unusually low for the strategy type

**Prevention:** Use `monitoringIntervalDays: 1` for all realistic backtests. Any multi-day interval needs a written justification.

---

### 13. Using `hv30d` from ORATS
**Where:** VRP computation, regime gates

**What:** ORATS `/hist/cores` does not provide `clsHv30d` — it skips from 20d to 60d. `orats_iv_cache.hv30d` is always NULL. Code that reads `hv30d` silently gets 0 or NaN and produces garbage VRP values.

**Fingerprint:**
- VRP values appear as 0 or NaN for most dates
- Regime gates never fire
- Works in unit tests with mock data, fails on real data

**Prevention:** Use `hv20d` for all VRP computation (IV30² - HV20²).

---

### 14. `missingChainExitAfterDays` disabled
**Where:** `SimConfig.missingChainExitAfterDays`

**What:** When chain data is missing for a trade date, the sim either holds the position (intended) or exits immediately (bug). Setting this to a low value (1-3 days) causes premature exits during sparse data windows, losing +0.56 Sharpe.

**Fingerprint:**
- NO_CHAIN exit type dominates (>10%)
- Dates with missing chain data cluster in early period
- Same strategy produces very different Sharpe on different date ranges

**Prevention:** Keep `missingChainExitAfterDays: 999` in all configs. Per `backtest-engine.md` domain constraints.

---

### 15. Slot allocator adverse selection (dual-direction strategies)
**Where:** `wfa-options.ts` `evaluateConfiguredSignalsWithConstraints`

**What:** When a strategy fires both bull and bear signals, alphabetical/insertion-order slot allocation fills bull signals first. Bear signals only get filled on broad-weakness days — precisely when bear calls get crushed by mean-reversion rallies. The slot allocator creates anti-alpha in the minority direction.

**Fingerprint:**
- Dual-direction strategy where one direction dominates trade count
- Minority direction has strongly negative standalone Sharpe
- Disabling the minority direction improves combined Sharpe

**Prevention:** Either disable minority direction, or redesign slot allocation to be direction-symmetric.

---

### 16. Single macro-regime IS with cross-ticker GA
**Where:** GA fitness in `src/lib/backtest/sweep.ts` (fixed 2026-03-07, commit b6440f8)

**What:** Multi-ticker GA training looks like diversification but isn't — 15 tickers across the same 2021-2024 IS period are 15 instruments in one macro regime (bull market, low vol). The GA rewards configs that fit the regime, not configs with a genuine edge. OOS into a different regime collapses.

**Fingerprint:**
- Multi-ticker GA with long IS period (>3 years) in a single market regime
- OOS performance highly regime-dependent
- "Best" configs converge on parameters that happen to suit the IS regime
- IS Sharpe high, OOS Sharpe moderate, but both collapse on out-of-regime holdout

**Prevention:** The `TEMPORAL_LAMBDA = 0.5` penalty in `runGeneticOptimize` splits each ticker's IS trades into early/late halves and penalizes fitness by `0.5 × |earlyFit - lateFit|`. Rewards temporally consistent edges over regime-fitted ones. Minimum 20 trades per ticker half required to apply the penalty reliably.

---

### 17. WFA empty windows drag grade down
**Where:** WFA grading in `scripts/wfa-sl-study.ts` and similar (fixed 2026-03-23, commit 4ec0d53)

**What:** Windows with 0 trades (early training periods before data coverage, or tight filters that never fire) were counted as "not positive Sharpe" in grade computation. This inflated StdDev and dragged Grade from B down to C for otherwise clean strategies.

**Fingerprint:**
- WFA grade looks worse than the per-window Sharpe distribution suggests
- Early windows have 0 trades but count against the strategy
- Grade computation sensitive to start date

**Prevention:** Filter to active windows only (trade count > 0) before computing Sharpe distribution, grade, StdDev. An empty window is missing data, not a failure.

---

### 18. Risk sizing floors at 1 contract when budget exceeded
**Where:** `src/lib/riskSizing.ts` — `getPositionSize` (fixed 2026-04-09, commit 822ed68)

**What:** When the risk budget for a trade was smaller than the cost of 1 contract, the old code forced the minimum to 1 contract — taking the trade anyway at over-budget risk. In backtests this inflates performance (every signal fires regardless of bankroll). In live trading it over-risks every DTE5 trade.

**Fingerprint:**
- Backtest takes trades when starting capital is near-zero (should be no-trade)
- `maxRiskPerTrade` cap is silently violated
- DTE5 paper trading at $1K loses more per trade than the 10% risk cap

**Prevention:** Allow 0 contracts when the trade's stop-out risk exceeds the budget. The check happens at both `riskSizing.ts` and the inline sizing path in `Dashboard.tsx`. Skipping a trade is the correct behavior — it's not "missing opportunity," it's respecting the risk contract.

---

### 19. Flat OOS days missing from merged daily metrics
**Where:** `scripts/short-put-1dte.ts` — `mergedDailyMetrics` (fixed 2026-04-07, commit fbe6ed2)

**What:** When computing merged daily metrics across two strategies, only dates where at least one strategy had non-zero returns were included. Zero-return days (flat) were silently dropped, compressing the denominator of Sharpe and inflating it. A strategy trading 1 day per month would show a Sharpe computed over ~12 observations instead of ~252.

**Fingerprint:**
- Sparse-trading strategy with unreasonably high Sharpe (infrequent but profitable trades)
- Daily return series length doesn't match calendar length
- Sharpe drops dramatically when recomputed over full trading calendar

**Prevention:** Always pass the union of all OOS trading dates (including flat days) to daily metrics functions. Flat days are real days where the strategy held cash — they belong in the denominator.

---

### 20. Force-closed positions not reflected in peak/MaxDD
**Where:** `scripts/short-put-1dte.ts` (fixed 2026-04-07, commit fbe6ed2)

**What:** When backtests force-closed open positions on the final day of the data window, the final-day P&L was added to equity but `peakEquity` and `maxDD` were not recomputed. This hid any drawdown that the force-close realized.

**Fingerprint:**
- MaxDD implausibly low compared to per-trade loss distribution
- Largest single-trade loss > reported MaxDD
- Multi-strategy combined report where a losing force-close is invisible

**Prevention:** Any code path that mutates equity after the main loop must also recompute `peakEquity` and `maxDD` over the full equity series. Don't trust "I only added one number at the end."

---

### 21. `||` fallback treats valid 0 as missing (smvVol and similar)
**Where:** `src/lib/backtest/chain-cache.ts` — smvVol fallback (fixed 2026-03-22, commit 2dda238)

**What:** `const smvVol = chainRow.smv_vol || defaultVol` treats a legitimate 0 value as falsy and replaces it with a default. For volatility surfaces, 0 is rare but possible (extreme near-the-money, deep decay). Every such row silently used the default, distorting any calculation using smvVol.

**Fingerprint:**
- `||` used for numeric fallback in data loading code
- Affected field has valid-but-rare 0 values
- Subtle differences in backtest results depending on how much data flows through the fallback

**Prevention:** Use nullish coalescing (`??`) for numeric fallbacks. `0 ?? default` is 0; `null ?? default` is default. The project-wide rule: only use `||` for booleans or strings where empty/zero/false is genuinely "missing."

---

### 22. Bash ARG_MAX exceeded when passing growing journal as prompt arg
**Fixed:** 2026-04-10 (run-overnight.sh)
**File:** `scripts/autoresearch/run-overnight.sh`

**What happened:** The autoresearch loop passed the full prompt (leaderboard + journal + strategy.ts + instructions) to `claude -p` as a command-line argument via `$(cat "$PROMPT_FILE")`. macOS `ARG_MAX` is ~256KB. After 4-13 iterations the journal grew past that limit, and every subsequent iteration failed instantly with `Argument list too long`. The shell script kept looping — each failed iteration "completed" in ~2 seconds with the error message captured as the claude output, and the journal never got updated, which masked the failure (it looked like the loop was still running).

**How it was discovered:** The run-log showed `You've hit your limit · resets 2pm` for iterations 14-50, but the agent was supposed to be running sonnet. Investigation revealed the actual error was ARG_MAX, which the bash pipeline silently masked under the usage-limit line returned by claude.

**Fingerprint:**
- Long-running loop where iterations suddenly complete in <5 seconds each
- Error messages like "Argument list too long" in the run log
- Leaderboard stops growing while the loop keeps "iterating"
- Any pattern where `claude -p "$(cat BIG_FILE)"` or `command -arg "$(big_content)"` accumulates content over time

**Prevention:**
- Pipe content via stdin: `cat file | claude -p` instead of `claude -p "$(cat file)"`
- If the CLI supports a `--input-file` flag, use that
- For any long-running loop that passes accumulated context, stress-test at 5x expected size
- The meta-lesson: **any bash pattern that accumulates content will eventually exceed ARG_MAX.** Default to stdin pipes or file references.

### 23. Stale 1D candle cache serving yesterday's prices
**Where:** `api/backtest-data.js` — `getCached1DCandles` (fixed 2026-03-30, commit 7332ad9)

**What:** The 1D candle cache returned Supabase `stock_candles` rows without checking if the data was current. Signal scans and backtests using the 1D path silently ran on yesterday's (or older) closing prices while the 130M path correctly fetched live data. Signals generated with stale data then matched signals generated with fresh data in end-of-day comparisons, creating apparent — but fake — consistency.

**Fingerprint:**
- Signal board shows prices that don't match live ticker
- Backtest results subtly shift when run at different times of day
- 1D and 130M paths disagree on "today" for the same ticker

**Prevention:** Both 1D and 130M paths now check last cached date vs today and top up from Tiingo when stale. Any data-loading layer that can be called in real-time must have a freshness check.

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
