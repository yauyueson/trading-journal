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

### 24. Daily MtM writes executable close cost, not fair value
**Fixed:** 2026-04-17 (commit `131b6a3`)
**File:** `src/lib/backtest/option-sim.ts` — three `dailyMtM.push()` sites (standard credit, phased credit, LEAP)

**What happened:** The daily MtM series recorded `currentSpreadCost` / `currentPrice` — the liquidation price after bid/ask impact and slippage model — as the day's mark. With `fillMode: 'bidask'` on by default and dynamic slippage enabled, this baked *hypothetical* exit slippage into every monitoring day. Day-over-day return calculations then reflected both fair-value drift AND the constant drag of "what would it cost to close today?". The slippage cost was effectively double-counted: once in every daily mark, and again in the actual exit.

**How it was discovered:** Codex P1 finding, review round 6. Not exploited into a fake champion, but systematically depressed daily Sharpe and inflated MaxDD for any credit-spread / LEAP run with bid/ask fills.

**Fingerprint:**
- `fillMode: 'bidask'` with slippage enabled
- Credit-spread or LEAP backtests where daily Sharpe looks modestly worse than trade-level stats suggest
- MaxDD notably larger than the largest individual realized loss
- Equity curve has visible "drag" on monitoring days even when underlying isn't moving

**Prevention:**
- MtM now uses `grossCurrentSpreadCost` (credit) and `current.mid` (LEAP) — fair-value prices without slippage.
- `currentSpreadCost` / `currentPrice` (with slippage) are reserved for the actual exit computation downstream.
- Rule of thumb for any future exit model: slippage is realized once, at entry or exit. Daily MtM is a mark, not a liquidation estimate.

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

### 14. `missingChainExitAfterDays` — two-way tradeoff, default is `3`
**Where:** `SimConfig.missingChainExitAfterDays`
**Current default:** `3` (set in `DEFAULT_LEAP_CONFIG`, commit `9eecb4c`, 2026-04-17)

**Two directions of trouble:**

Setting it **too low (1-3)** causes premature exits during sparse data windows. The original finding (pre-2026-04) measured a +0.56 Sharpe loss when a sparse-chain stretch triggered repeated NO_CHAIN exits that would have recovered.

Setting it **too high (999)** effectively disables the safeguard. With 999, a position's boundary force-close (end of OOS window, time stop, or expiry) that lands on a missing-chain day marks at *intrinsic value* instead of the last tradable price. For credit spreads that's the worst-case floor; for LEAPs the P&L can be arbitrarily distorted.

**Why the current default is `3`:** Codex adversarial review (2026-04-17) flagged the 999 behavior as materially worse than the occasional premature-exit cost. `3` is a compromise: patient enough to weather 1-2-day chain outages, strict enough that boundary force-close rarely lands on sparse coverage. Studies that genuinely need the patient behavior (e.g. `scripts/wfa-dte5-tp-sl-study.ts`) override explicitly.

**Fingerprint (low-value failure mode):**
- NO_CHAIN exit type dominates (>10%)
- Dates with missing chain data cluster in early period
- Same strategy produces very different Sharpe on different date ranges

**Fingerprint (high-value failure mode):**
- Boundary-date exits (TIME_STOP, EXPIRATION, end-of-window force-close) price at spread-width for credit spreads or zero for LEAPs
- Last-valid-price vs actual-exit-price gap large on a small fraction of trades
- Impossible-looking P&L on the trade's last day

**Prevention:**
- `DEFAULT_LEAP_CONFIG.missingChainExitAfterDays: 3` — reviewed and intentional.
- `tests/option-sim-fills.test.ts` asserts `DEFAULT_CREDIT_CONFIG.missingChainExitAfterDays === 3`.
- Studies overriding to 999 must document the reason in the study script header.

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

### Baseline correctness (delta-gate comparator)

The runner's delta gate compares a strategy against a "naive baseline" (same SimConfig, periodic entry, no timing). If the baseline is mis-specified, the gate rejects or accepts variants against a wrong benchmark and the entire search is contaminated.

### 25. Naive baseline hard-coded to CALL direction
**Fixed:** 2026-04-17 (commit `c16733b`)
**File:** `scripts/autoresearch/runner.ts` — `generateNaiveSignals()`

**What:** `generateNaiveSignals()` used to emit only `direction: 'CALL'` entries. For a PUT credit-spread strategy (e.g. IWM 30-DTE bull puts) or a mixed CALL/PUT harness, the delta gate then compared PUT P&L against a bullish long-call comparator — completely wrong market exposure.

**Fingerprint:**
- Strategy generates PUT signals (check `allSignals.filter(s => s.direction === 'PUT').length`)
- Baseline Sharpe wildly different from strategy Sharpe on the same simConfig
- `passesDeltaSpyIR` result implausible given known strategy direction

**Prevention:** Runner now computes `naiveDirection` from the strategy's signal mix (majority vote) and passes it to `generateNaiveSignals()`. Any future strategy with mixed directions should audit the baseline direction decision before trusting delta metrics.

---

### 26. Delta gate fails open when baseline is unavailable
**Fixed:** 2026-04-17 (commits `c16733b`, `9eecb4c`)
**File:** `scripts/autoresearch/runner.ts` — delta gate evaluation

**What:** If the baseline worker errored out or produced < 20 trades (sparse chains, worker crash), the code left `baselineSpyIR` / `baselineMaxDD` / `baselineCorrelation` undefined — and the original code treated `undefined` delta metrics as **passing** the gate. Result: a worker failure silently promoted any strategy as "beats the baseline" without evidence.

**Fingerprint:**
- `baselineTrades` in the RunResult is undefined or 0
- `passesDeltaGates === true` alongside missing delta* numerics
- Strategies validated with zero baseline comparison still showing up as valid

**Prevention:**
- Fail closed by default: `passesDeltaSpyIR = deltaSpyIR != null ? deltaSpyIR > 0 : false` (and sibling gates).
- `SCREEN_MODE` intentionally skips the baseline worker → gates pass on the understanding that screen is triage, not validation; but any non-screen run with missing baseline fails the validity gate.

---

### 27. Baseline worker evaluated with CALL config only, ignoring `variant.putSimConfig`
**Fixed:** 2026-04-17 (commit `131b6a3`)
**File:** `scripts/autoresearch/runner.ts` — `evalOnWorker(blWorker, ..., variant.putSimConfig)`

**What:** After `configVariants` gained separate CALL / PUT configs (hybrid strategies), the strategy worker correctly received both via `evalOnWorker(stratWorker, ..., variant.putSimConfig)`. The baseline worker call was never updated — it always received CALL config only. For a PUT-direction baseline (after fix #25), trades were priced with the strategy's CALL params (wrong delta, DTE, profit target, etc.).

**Fingerprint:**
- Strategy has `hasSeparatePutConfig === true` (distinct `buildConfig('CALL')` vs `buildConfig('PUT')`)
- Baseline trades show parameters matching CALL spec even though direction is PUT
- Delta gates fluctuate unexpectedly when CALL and PUT configs are close vs far apart

**Prevention:** Baseline `evalOnWorker` call now mirrors strategy call: `evalOnWorker(blWorker, vi, simConfig, selWindows, holdoutWindows, variant.putSimConfig)`. Any future baseline variant added to the runner must forward all direction-specific configs.

---

### Window / carry accounting (selection → holdout)

When positions live longer than a single WFA window (LEAPs, long-DTE spreads), carry semantics across window boundaries are critical. Get them wrong and holdout metrics diverge silently from what the strategy actually did.

### 28. Carry state resets at the selection/holdout boundary
**Fixed:** 2026-04-17 (commit `131b6a3`)
**File:** `scripts/autoresearch/worker.ts` — `evaluateOnWindows` + single-call unification

**What:** Originally `evaluateOnWindows` was called twice — once for selection windows, once for holdout windows. Inside the function, `oosState = createConstraintState()` reinitialized carry on each invocation; `oosMaxDate` was also set to the *last window in the current call's list*. A 180-DTE LEAP opened in the last selection window got truncated at selection end, and its in-holdout dailyMtM never existed.

**Fingerprint:**
- Strategy has DTE significantly longer than `forwardStepDays`
- `workerResult.holdoutTrades` count implausibly low (the strategy "went dark" at the boundary)
- Holdout Sharpe sensitive to whether a late-selection entry fired

**Prevention:**
- Worker now evaluates `[...selectionWindows, ...holdoutWindows]` in a single `evaluateOnWindows` call, then splits trades by entry date.
- Carry state (`oosState`) and `oosMaxDate` span the full range.
- Runner computes holdout metrics on `[...allOOSTrades, ...holdoutTrades]` union so selection-entered trades' in-holdout MtM contributes (date filter inside `computePortfolioDailyMetrics` restricts contribution to holdout days).

---

### 29. Holdout metrics seeded with `startingCapital` instead of carried equity
**Fixed:** 2026-04-17 (commit `f41a0b9`)
**File:** `src/lib/backtest/wfa-options.ts` — `computePortfolioDailyMetrics(..., initialEquity?)`

**What:** Once fix #28 unioned carried trades into holdout metrics, a new bug emerged: `computePortfolioDailyMetrics` always seeded `equity = startingCapital` and `peak = startingCapital`. Returns were computed as `dailyPnl / prevEquity`, so a carried trade's in-holdout P&L was divided by the *starting* capital rather than the actual equity the strategy brought into holdout (e.g., $10k base but $13k after selection). Sharpe scale was wrong; MaxDD peak started from the wrong base.

**Fingerprint:**
- Selection Sharpe high → selection-end equity significantly above starting capital
- Holdout Sharpe magnitude looks off vs per-trade P&L distribution
- MaxDD computed from a peak that doesn't match the equity curve's actual peak at holdout start

**Prevention:**
- `computePortfolioDailyMetrics` accepts optional `initialEquity` parameter (defaults to `startingCapital` for backward compat).
- Runner derives `selectionEndEquity = oosMetrics.equityCurve[last].equity` and passes it to the holdout metrics call.
- Selection metrics still seed from `startingCapital` (correct — selection starts fresh).

---

### 30. Holdout gate passes on carry-only trades (zero new holdout entries)
**Fixed:** 2026-04-17 (commit `f41a0b9`)
**File:** `scripts/autoresearch/runner.ts` — `passesHoldoutNewEntries` gate

**What:** With carried selection trades scoring in holdout metrics, a strategy that stops generating signals after the boundary can still pass the holdout Sharpe/IR gate on a single lucky carried LEAP's in-holdout P&L. The gate passes without the strategy ever demonstrating it works on the unseen regime — exactly the opposite of what holdout is for.

**Fingerprint:**
- `newHoldoutTrades === 0` but `passesHoldoutOrIR === true`
- Strategy's signal count drops to zero in the holdout date range
- A single `carriedHoldoutTrades` entry carries the whole gate

**Prevention:**
- RunResult now reports both `newHoldoutTrades` (entered inside holdout) and `carriedHoldoutTrades` (selection-entered, live during holdout).
- `passesHoldoutNewEntries = newHoldoutTrades >= 1` — strict minimum: the strategy must take at least one new bet under the unseen regime.
- `isValid = isValidForSearch && passesHoldoutOrIR && passesHoldoutNewEntries`. Carry-only passes are rejected.
- `HOLDOUT_DERIVED_FIELDS` strips the new fields from the agent-visible leaderboard (no leakage).

---

### 31. `loadLeaderboard()` falling back to stripped agent-visible file
**Fixed:** 2026-04-17 (commit `c16733b`)
**File:** `scripts/autoresearch/runner.ts` — `loadLeaderboard()`

**What:** `data/leaderboard-full*.json` is gitignored (`data/*.json`), but `scripts/autoresearch/leaderboard*.json` is committed. Fresh clones have only the stripped (agent-visible) file. The old loader fell back to the stripped path when fullPath was missing — which meant historical entries lost `isValid` and all holdout fields. `leaderboard.filter(e => e.isValid)` then returned `[]`, and any newly "valid for search" run was crowned champion even if historical runs scored higher.

**Fingerprint:**
- Fresh clone or fresh campaign suffix
- Champion selection picks a run with combinedSharpe below known historical leaders
- `leaderboard.filter(e => e.isValid)` length drops after a clone

**Prevention:**
- Loader only reads `fullPath`; returns `[]` if missing (treat as no history).
- One-time migration block at runner startup rewrites stripped → full when fullPath absent. Runs for all suffixes (not only the primary).
- `backfillIsValidForSearch()` preserves ranking eligibility for pre-split historical entries.

---

### 32. `configVariants.overrides` shallow-merged — nested fields silently dropped
**Fixed:** 2026-04-17 (commit `58f9b25`)
**File:** `scripts/autoresearch/runner.ts` — `mergeConfigOverrides()`

**What:** `{ ...baseSimConfig, ...v.overrides }` is a top-level spread: any nested object in `overrides` replaces the whole sibling field. A variant like `overrides: { signalInvalidation: { graceDays: 3 } }` silently wiped `signalInvalidation.type`; `overrides: { slippage: { enabled: false } }` wiped the rest of the `DynamicSlippageConfig`. The variant was then evaluated on a materially different config than its author intended.

**Fingerprint:**
- Variant name includes a nested parameter tweak (e.g. `*-grace3`, `*-noSlippage`)
- Running the variant produces results inconsistent with a flat-parameter equivalent
- `signalInvalidation.type` or `slippage.executionStyle` unexpectedly `undefined` in a variant's effective config

**Prevention:** `mergeConfigOverrides()` does two-level merge for the two SimConfig fields that are objects (`signalInvalidation`, `slippage`). All other fields are primitives/arrays where replacement is correct. Any new object-valued SimConfig field must be added to the helper.

---

### 33. Strategy precomputation gated on local cache file
**Fixed:** 2026-04-17 (commit `c16733b`)
**File:** `scripts/autoresearch/strategy.ts` — `prepare()` hook fallback; `scripts/autoresearch/types.ts` — `StrategyDefinition.prepare?`

**What:** Campaign A's strategy module loaded `data-cache.json` at import time to build `breadthByDate` and `hv20PctByTickerDate` maps. If the file was missing (e.g., cacheless Supabase path, different machine), both maps stayed empty and the `breadth` / `rv_regime` gates silently rejected every signal. The strategy looked broken, but actually the machine setup was broken.

**Fingerprint:**
- Campaign A with GATE=breadth or GATE=rv_regime produces 0 signals
- Module-level log says "data-cache.json not found — gate disabled"
- Strategy works on one machine (where cache exists) but not another

**Prevention:**
- `StrategyDefinition.prepare?(tickerDataMap, market)` hook on the strategy interface. Runner calls it once before `generateSignals`, passing the loaded tickerDataMap.
- Campaign A's `prepare` rebuilds breadth + hv20 percentile from the in-memory bundle when the cache path hasn't already populated the maps.
- `TickerDataBundle.hv20` surfaces the raw hv20 series so precomputation doesn't need the full IV cache.

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
After N attempts, the expected maximum Sharpe from noise depends on the standard error of the Sharpe estimator (from bootstrap CI), not just N. The `computeDeflatedSharpe` function in `runner.ts` uses Gumbel EVT for E[max of N standard normals], scaled by bootstrap SE. A deflated Sharpe < 0 means the result is indistinguishable from luck. **Prior bug (fixed 2026-04-15)**: the old formula used `sqrt(2 * ln(N))` without SE scaling, producing E[max] ≈ 3.3 instead of ≈ 0.9 — catastrophically over-penalizing.

### Bootstrap CI for time series needs block bootstrap
I.i.d. bootstrap understates CI width for daily returns because it ignores autocorrelation. Use block bootstrap with block size ~sqrt(n). Already implemented in `bootstrapSharpeCI`.

### Bootstrap CI must start at the first OOS day, not `config.startDate`
**Fixed:** 2026-04-17 (commit `9eecb4c`)
**Files:** `src/lib/backtest/wfa-v2-orchestrator.ts`, `wfa-v3-orchestrator.ts`

`computePortfolioDailyMetrics` was called with `config.startDate` (WFA start) as the range start before handing `dailyReturns` to `blockBootstrap`. `bestTrial.oosTrades` only exist from the first OOS window onward, so the training-only prefix was injected as a long stretch of zero returns — deflating variance and biasing the Sharpe CI downward. Fixed to `bestTrial.windows[0]?.oosStart ?? config.startDate`. Any future stat computed over OOS trades must use an OOS-aligned date range.

### Structural bugs pass all statistical checks
Holdout, bootstrap, and deflated Sharpe all assume the simulator is trustworthy. **None of them caught the TRAILING_LOCK bug** because the bug produces consistent fake profits across all time periods. The only defense against structural bugs is sanity bounds + code review + adversarial testing.

---

## Research & Search Discipline

Bugs in this section are not in the simulator — they're in the *search process* sitting on top of the simulator. An agent-driven search loop optimizing against a leaky gate is just as corrupting as a miscoded payoff, and is harder to notice because no single run looks wrong.

### 34. Holdout gate boolean leaks into agent-visible leaderboard
**Fixed:** 2026-04-17 (commit `c16733b`)
**Files:** `scripts/autoresearch/runner.ts` — `isValidForSearch` / `isValid` split; `HOLDOUT_DERIVED_FIELDS`

**What:** The original `isValid = passesMinTrades && passesMaxDD && passesWFA && passesHoldoutOrIR && passesSanity && passesDeltaGates` combined selection-only gates with the holdout gate, and was left visible in the agent-facing leaderboard. Over N iterations the agent can observe which of its edits passed/failed the holdout gate as a boolean and implicitly optimize toward holdout-pass — precisely what pre-registered holdout is meant to prevent.

**How it was discovered:** Codex adversarial review after Campaign E (2026-04-17). 10 iterations of agent-driven edits were run against a leaderboard that included `isValid`. Entire campaign had to be invalidated.

**Fingerprint:**
- Any boolean in the agent-visible leaderboard whose computation reaches into holdout-window metrics
- Agent's journal references "passing validity" even when it can't see holdout numerics
- Valid count climbing over iterations without obvious selection-window improvements

**Prevention:**
- Split into `isValidForSearch` (selection-only, agent-visible) and `isValid` (includes holdout, stripped from agent file).
- `HOLDOUT_DERIVED_FIELDS` extended to strip `isValid`, `holdoutTrades`, `holdoutSharpe`, `holdoutSpyIR`, and other holdout-derived booleans/numerics from the agent-visible leaderboard.
- `__BEGIN_REVIEWER_ONLY__ … __END_REVIEWER_ONLY__` sentinel blocks in runner stdout wrap all holdout feedback; overnight shells strip them before passing the log to the next iteration's prompt.

---

### 35. Post-hoc incumbent selection violating the pre-reg decision rule
**Fixed:** process (2026-04-17) — Campaign D v2 results doc + Campaign E reset

**What:** Campaign D's pre-registration said "pick the highest selection combinedSharpe that passes validity." The strict winner was `d65-sl35-ts105` at 1.188. The originally-published recommendation was `d65-tp40-ts150` at 1.180 (runner-up), justified by "robustness-weighted reading" — a rule *not* in the pre-reg. Campaign E was then seeded from that post-hoc incumbent, contaminating all 10 of its iterations.

**Fingerprint:**
- Any sentence in a results doc of the form "the strict winner is X but we recommend Y because..."
- Downstream campaigns baselined on the "recommended" (non-strict) variant
- Results doc gets a v2 revision that reverts to the strict winner

**Prevention:**
- If post-hoc reasoning produces a different pick than the pre-reg rule, that's either: (a) a new hypothesis requiring a fresh pre-reg, or (b) a rule violation. Never both at once in the same results doc.
- Any variant used as a downstream incumbent must match the strict pre-reg winner exactly, or the downstream work must be classified as exploratory and not adopted.

---

### 36. Exact holdout numerics carried into agent-seeded journal
**Fixed:** 2026-04-17 (commits `c16733b`, `58f9b25`)
**Files:** `scripts/autoresearch/journal-campaign-e.md` (wiped); shell sentinel strip in `run-*-overnight.sh`

**What:** The journal that seeded Campaign E's first iteration contained a table with `Hldt Sharpe` and `Hldt IR` columns for prior Campaign D variants. Even though the code-level leaderboard correctly stripped holdout fields, the hand-authored seed leaked the same numbers through a different channel.

**Fingerprint:**
- Any `.md` file shipped to the agent that tabulates per-variant numerics from the holdout window
- Phrases like "holdout Sharpe = X" or "passes on holdout IR" in seed content
- Agent's first-iteration output references specific holdout values the search shouldn't know

**Prevention:**
- Seed journals must only reference selection-window metrics.
- When documenting prior results in an agent-facing file, use PASS/FAIL tokens, never numerics.
- Shell orchestration strips reviewer-only sentinel blocks from the prior-iteration output before appending to the next prompt.

---

### 37. Post-hoc threshold reclassification ("treat-as-valid")
**Fixed:** process (2026-04-17) — Campaign E audit

**What:** Campaign E's first iteration ran without `AUTORESEARCH_MIN_OOS_TRADES=60` exported (shell env oversight). When results came back with many `isValid: false` entries reasoned out as "trades < 100", a journal note was appended instructing the agent to reinterpret 60-99-trade variants as valid for ranking. That's a rule change applied after seeing results — exactly what pre-registration is meant to prevent.

**Fingerprint:**
- Any post-run journal edit that changes how prior results are classified
- Thresholds described in the pre-reg but re-justified mid-campaign
- "Treat X as Y" instructions appearing in the loop's prompt memory

**Prevention:**
- Any threshold discovered to be wrong mid-campaign invalidates the campaign. Don't patch in flight.
- Shell scripts export all validity thresholds (`AUTORESEARCH_MIN_OOS_TRADES`, etc.) before iteration 1 starts, and fail loudly if an env var is missing.

---

### 38. Deflated-Sharpe attempt counter resets per campaign
**Fixed:** 2026-04-17 (commit `c16733b`)
**File:** `scripts/autoresearch/runner.ts` — `data/attempts-global.json` ledger

**What:** The original attempt counter was per-`AUTORESEARCH_LEADERBOARD_SUFFIX`. Each campaign (A / C / D / E / Option 3) had its own counter that started at 1 — so Deflated Sharpe was computed against tiny N. The true serial search across all campaigns was in the hundreds of attempts; the reported deflated Sharpe materially understated p-hacking risk.

**Fingerprint:**
- `attemptNumber` field in the RunResult is small (< 50) despite many prior campaigns
- Deflated Sharpe close to raw Sharpe (tiny penalty) on a run that's part of a long serial search
- New campaign suffix starts with `attemptNumber: 1`

**Prevention:**
- Global `data/attempts-global.json` ledger persists across all runner invocations regardless of suffix.
- `incrementGlobalAttempts()` writes to this ledger; `attemptNumber` is read from the global count, not the local leaderboard length.
- Any future per-campaign isolation (new suffixes) must continue to increment the global counter.

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

---

## Measurement Artifacts (not bugs, but misleading)

### Sparse daily MTM inflates reported Sharpe and deflates correlation for infrequently-monitored LEAP strategies

**Discovered:** 2026-04-10 via monitoring interval sweep

**What happens:** The LEAP evaluator in `worker.ts` only records `dailyMtM` entries on monitoring days
(`monitoringIntervalDays` interval). With `monitoringIntervalDays=3`, only ~33% of trading days have
non-zero portfolio return in the daily P&L series. The other 67% show zero return.

**Effect on Sharpe:** A return series with 67% zeros has different statistical properties than the
same series continuously sampled. Counter-intuitively, this does NOT inflate Sharpe — the sparse
sampling reduces both mean and standard deviation proportionally, so the ratio (Sharpe) is not
significantly inflated by sparsity alone. The standalone Sharpe improvement with interval=3 vs
interval=1 IS a real performance improvement from fewer false SL triggers.

**Effect on correlation:** A series with 67% zeros has near-zero correlation with any continuous
series (DTE5 daily returns), because most of the time one series has zero while the other is
non-zero. With `monitoringIntervalDays=3`, the reported correlation is ~0.073 vs the real
underlying correlation (~0.25). **Do not trust reported correlation for strategies with
monitoringIntervalDays > 1.** The true correlation is approximately equal to the daily-monitoring
correlation (~0.26 for this LEAP strategy).

**Effect on combined Sharpe:** The combined formula uses the reported (artificially low) correlation,
which inflates the portfolio_sharpe component. The reported combined Sharpe of 1.326 for
interval=3 is likely ~0.05-0.10 higher than the "true" combined Sharpe would be if measured
with correct daily MTM.

**Fingerprint:**
- `monitoringIntervalDays > 1` in LEAP strategy config
- Reported correlation with DTE5 much lower than daily-monitoring version of same strategy
- Combined Sharpe noticeably higher than standalone Sharpe (unusual — normally combined ≈ standalone)

**Prevention (partial fix, not complete):**
- For LEAP strategies, always compare the standalone Sharpe across different monitoring intervals,
  not just combined Sharpe. The standalone improvement is the real signal.
- Report the `monitoringIntervalDays` parameter alongside all LEAP backtest results.
- To fix properly: the LEAP evaluator should record daily MTM for ALL days (including non-monitoring
  days) by interpolating the option's value between check dates. This requires changes to
  `scripts/autoresearch/worker.ts` LEAP evaluator's `dailyMtM` recording logic.
- Until fixed: use standalone Sharpe as the primary metric for comparing monitoring intervals.
