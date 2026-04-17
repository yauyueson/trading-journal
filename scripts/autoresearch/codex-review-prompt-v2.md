# Codex Review v2: Post-Carry-Fix LEAP Strategy Audit

## Context

A previous Codex review (v1) identified a critical bug: the autoresearch WFA worker (`scripts/autoresearch/worker.ts`) was truncating LEAP positions at WFA window boundaries instead of carrying them across windows. This caused:
- 22 out of 26 "EXPIRATION" exits were actually window-boundary force-closes
- MaxDD was underreported by ~10-17 percentage points
- Standalone Sharpe was inflated by ~25%

The fix (already applied) changed `evaluateOnWindows()` in `worker.ts` to use `evaluateConfiguredSignalsWithState()` with shared `PortfolioConstraintState` across OOS windows, and set `maxDate` to the last window's end so LEAPs can complete their lifecycle.

## The New Honest Results

Several of the top configs were re-run with the carry fix. **These re-runs fail the 35% MaxDD gate**, while passing the other gates. Whether to accept a higher MaxDD is a product decision; this review should assess trustworthiness of the corrected metrics either way. A representative top config:

**Config B: `rerun-ema-accel-holdout4`**

| Metric | Old (truncated) | New (carry fix) | Delta |
|--------|----------------|-----------------|-------|
| Standalone Sharpe | 1.393 | **1.088** | -22% |
| Combined Sharpe | 1.276 | **1.046** | -18% |
| Correlation | 0.235 | **0.257** | +9% |
| MaxDD | 28.7% | **39.7%** | +38% |
| Win Rate | 66.5% | **62.2%** | -4.3pp |
| Trades | 203 | **185** | -9% |
| SPY IR | 0.810 | **0.610** | -25% |
| Holdout gate | PASS/STABLE | **PASS/STABLE** | same |
| EXPIRATION exits | 29 (14%) | **0** | should largely disappear with correct carry + time-stop |
| FORCE_CLOSE exits | 0 | **3 (2%)** | closes at evaluation horizon (window carry prevents boundary truncation) |
| Exit breakdown | TP:119 SL:55 EXP:29 | TP:114 SL:65 NC:3 FC:3 | more SL hits |

## Your Task

The v1 review's critical issue (window truncation) has been fixed. Now review whether the **corrected** results are trustworthy. Specifically:

### 1. Verify the carry fix is correct
- Read `scripts/autoresearch/worker.ts`, function `evaluateOnWindows()` (around line 418)
- Confirm that `evaluateConfiguredSignalsWithState()` is called with shared state across OOS windows
- Confirm that `maxDate` is set to the last window's oosEnd, not per-window
- Confirm that training windows remain independent (no carry — correct for optimization)
- **Check**: does `evaluateConfiguredSignalsWithState` in `src/lib/backtest/wfa-options.ts` correctly handle positions that span window boundaries? Does `retireClosedPositions()` work correctly when a position opened in window N exits in window N+2?

### 2. Remaining FORCE_CLOSE and NO_CHAIN exits
- 3 FORCE_CLOSE and 3 NO_CHAIN exits remain. What triggers these?
- Read the LEAP evaluator in `worker.ts` (`makeLeapEvaluator`, around line 270). Follow the path when monitoring reaches `monitorEnd` without triggering TP/SL/TIME_STOP.
- **Check**: are the FORCE_CLOSE exits priced correctly? Do they use the actual market price on the last monitoring date, or some synthetic value?
- **Check**: NO_CHAIN exits — what happens when `findContractDirect()` returns null for multiple consecutive monitoring days? Does `missingChainExitAfterDays: 3` work in the LEAP evaluator, or is it only wired for credit spreads?

### 3. MaxDD computation with carry
- With position carry, a LEAP entered late in window N now lives into window N+1. Its daily MtM during window N+1 is recorded as part of the window N trade.
- **Check**: does `computePortfolioDailyMetrics()` correctly account for MtM from positions that span multiple windows? Or does it only see the MtM entries from the window where the trade was opened?
- **Check**: is the 39.7% MaxDD peak-to-trough computed on a proper chronological equity curve that includes concurrent position MtM? Or could there be MtM gaps between windows?

### 4. Signal overlap / double-counting across windows
- With carry, a position from window N occupies a slot in window N+1. New signals in window N+1 should see this occupied slot and not over-allocate.
- **Check**: does the shared `PortfolioConstraintState` correctly prevent new entries when `maxPositions` or `maxPerTicker` is reached due to carried positions?
- **Check**: could a signal in window N+1 open a position for the same ticker that already has a carried position from window N? (Would violate `maxPerTicker: 1`)

### 5. Realistic position sizing with carry
- A carried position's capital remains locked. With $10K starting capital and 4 max positions, a position that carries from window N to N+1 reduces available capital for new entries in N+1.
- **Check**: does `openRiskCapital` correctly track carried positions' capital usage?
- **Check**: the old truncated evaluator effectively "freed" capital at window boundaries. With carry, capital stays locked longer. Could this capital constraint explain the trade count drop (203→185)?

### 6. The persistent concerns from v1
- **Multiple comparison bias**: 203 total attempts now. Deflated Sharpe is -2.167. The carry fix didn't change this — still a concern.
- **WFA efficiency 1.26**: OOS still beats training (was 2.03 before fix, now 1.26). More reasonable but still > 1.0. Is this explained by regime tailwind (2023-2025 AI bull > training periods)?
- **96% signal "skip" rate is a red herring**: the field name `signalsSkippedNoChain` is misleading. In `runner.ts` it is computed as `allSignals - OOS trades - holdout trades`, i.e. "everything that didn't become a trade", not strictly missing option chains. Approximate breakdown for this strategy:
  - ~12% of signals are in training windows (never intended to become trades).
  - Of the OOS-eligible signals, ~85% are rejected by portfolio constraints (`maxPositions: 4`, `maxPerTicker: 1`) because LEAPs last ~150 trading days and the portfolio stays fully allocated.
  - Only ~5% are true chain misses (no suitable delta/DTE contract on that date).
  - Chain coverage is otherwise excellent (93-98% per ticker).
  Treat the high rejection rate as expected/healthy behavior (abundant entry opportunities + full investment), not automatic selection bias. Still sanity-check that "true chain misses" are not regime-linked (earnings/macro days).

### 7. Is the corrected strategy worth paper-trading?
Given:
- Combined Sharpe 1.046 (honest, with carry)
- SPY IR 0.610 (genuine alpha over market)
- Holdout PASS/STABLE
- MaxDD 39.7% (fails the 35% gate; decision pending whether to accept)
- Bootstrap significant [0.124, 1.854]
- Correlation 0.257 with DTE5

Is this a strategy with a genuine edge, or is it primarily leveraged beta exposure to a 2019-2025 bull market? The key test: does the strategy's alpha come from signal timing (MA-touch, breakout, EMA accel) or from simply being long tech stocks with leverage?

## Files to Read

1. `scripts/autoresearch/worker.ts` — **focus on `evaluateOnWindows()` and `makeLeapEvaluator()`**
2. `src/lib/backtest/wfa-options.ts` — `evaluateConfiguredSignalsWithState()`, `retireClosedPositions()`, `createConstraintState()`
3. `src/lib/backtest/option-sim.ts` — `computeOptionAnalytics()`, trade structure
4. `scripts/autoresearch/runner.ts` — correlation computation, combined Sharpe, MaxDD aggregation
5. `docs/backtest-trust-gotchas.md` — reference for known bugs

## Output Format

1. **Trust Score**: 1-10 (focus on whether the carry fix is correctly implemented)
2. **Carry Fix Verification**: Does the fix work as intended? Any edge cases?
3. **Remaining Issues**: Anything that could still distort the 1.046 combined Sharpe or 39.7% MaxDD
4. **Alpha vs Beta Assessment**: Is the strategy's return from genuine signal timing or just leveraged market exposure?
5. **Recommendation**: Paper-trade as-is, fix something first, or reject?
