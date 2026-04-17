# Codex Review: Autoresearch LEAP Strategy Trustworthiness Audit

## Your Task

You are reviewing a backtested trading strategy to determine if its results are trustworthy or if they are inflated by bugs, overfitting, or measurement artifacts. Be skeptical — this project has a documented history of 23 simulator bugs that produced fake results (see `docs/backtest-trust-gotchas.md`).

## The Claimed Result

**Strategy**: `ma-touch-holdout5-daily-v1` — CALL LEAP on 13 individual stocks
**Period**: ~2019-01 to 2025-07 (6.5 years OOS via rolling WFA)

| Metric | Value |
|--------|-------|
| OOS Sharpe | 1.465 |
| Combined Sharpe (50/50 with DTE5) | 1.280 |
| Correlation with DTE5 | 0.243 |
| MaxDD | 28.7% |
| Win Rate | 66.3% |
| OOS Trades | 187 (29/year) |
| Total P&L | $51,232 on $10K start (512% return) |
| SPY Info Ratio | 0.958 |
| SPY Excess Return | 23.8% ann. |
| WFA Efficiency | 2.76x (OOS Sharpe / Avg Train Sharpe) |
| Bootstrap 95% CI | [0.66, 2.34], statistically significant |
| Holdout Sharpe | 0.725 (PASS) |
| Holdout Trades | 70 |
| Exit Breakdown | TP: 109 (58%), SL: 52 (28%), Expiration: 26 (14%) |

## What You Must Investigate

### 1. Walk-Forward Analysis integrity
- Read `src/lib/backtest/wfa-options.ts` — specifically `buildWFAWindows()` and `evaluateConfiguredSignalsWithConstraints()`
- The strategy uses: trainWindowDays=252, forwardStepDays=126, purgeGapDays=10, holdoutCount=5
- **Check**: Is purgeGapDays=10 sufficient for LEAPs with DTE 180-270? The gotchas doc (item #8) warns that purgeGap must be >= max DTE for options. This was fixed for credit spreads but LEAPs hold much longer. Is there IS→OOS leakage?
- **Check**: With holdoutCount=5 out of 15 total windows (10 selection + 5 holdout), is 2.5 years of holdout enough? Or is there implicit holdout optimization from 195 total attempts?
- **Check**: WFA efficiency of 2.76x (OOS beats training by 2.76x) is unusual — normally OOS degrades vs training. Is this a sign of look-ahead bias, or a genuine artifact of the strategy type?

### 2. LEAP simulator correctness
- Read `scripts/autoresearch/worker.ts` — the `makeLeapEvaluator()` function
- Read `src/lib/backtest/chain-cache.ts` — `findStrikeByDelta()` and `findContractDirect()`
- **Check**: How are LEAP entries priced? Does it use real chain data or BSM? What price does it pay (bid, ask, mid)?
- **Check**: How are LEAP exits priced? When TP at +25% or SL at -30% triggers, what price is used?
- **Check**: The 26 "EXPIRATION" exits — what are these? Real expiry, or WFA window boundary force-closes? If the latter, what price do they get? (gotcha #20 warns about force-close P&L not affecting MaxDD)
- **Check**: `missingChainExitAfterDays: 3` — how often does NO_CHAIN exit fire? With LEAPs on individual stocks, chain coverage may be spotty. Does the sim exit at last known price or at zero?

### 3. Signal generation look-ahead
- Read `scripts/autoresearch/strategy.ts` — the `generateSignals()` function
- **Check**: EMA calculations — are they computed on data available at signal time, or do they use future data? EMAs are recursive so usually fine, but verify the EMA arrays aren't forward-filled
- **Check**: The contango filter uses `data.regimeByDate` — where does this regime data come from? Is it computed from data available on that date, or from future VIX term structure?
- **Check**: The 20-day breakout (closing high) and EMA34 acceleration — are these strictly backward-looking?

### 4. Portfolio-level P&L construction
- **Check**: How is the $51,232 total P&L computed? Is it compounded (reinvesting profits) or additive? With 4 max positions on $10K, is position sizing realistic?
- **Check**: MaxDD 28.7% — is this computed on the equity curve with proper chronological ordering? (gotcha #7)
- **Check**: Does the sim respect the $10K capital constraint, or does it take trades when capital is insufficient? (gotcha #18 — 0-contracts-allowed fix)

### 5. Correlation computation
- **Check**: Read how `correlationWithDTE5` is computed in `scripts/autoresearch/runner.ts`. Is it Pearson on daily returns? Does it use the full OOS period or a subset?
- **Check**: The LEAP strategy has `monitoringIntervalDays: 1`, so the 3-day monitoring artifact (gotcha doc measurement artifact section) should NOT apply. Verify this — confirm every OOS trading day has a return value (not sparse zeros).
- **Check**: Does the 0.243 correlation hold up in sub-periods, or is it an average that masks high-correlation episodes?

### 6. Data snooping / multiple comparison bias
- **Check**: 195 total attempts were run. The deflated Sharpe is -1.777 (negative!). This means the raw 1.465 OOS Sharpe is INDISTINGUISHABLE from noise after accounting for 195 trials. How seriously should we take this?
- **Check**: The agent iterated on the journal, seeing which strategies worked and which failed. Each iteration informed the next. Is this a valid research process, or is the final strategy a product of implicit curve-fitting to the OOS period?
- **Check**: holdoutOOSRatio is 0.49 — holdout Sharpe is about half of OOS Sharpe. Is this expected degradation or a sign of overfit?

### 7. Chain data coverage
- **Check**: `signalsGenerated: 6538, signalsSkippedNoChain: 6281` — 96% of signals were skipped due to missing chain data! Only 257 signals had chains, producing 187 trades. Is this massive skip rate a concern? Could the 4% of signals that DO have chains be systematically biased (e.g., only liquid days)?

### 8. Comparison with passive benchmarks
- **Check**: SPY returned roughly 80-100% over 2019-2025 (including 2022 drawdown). The LEAP strategy claims 512%. Is this plausible for a levered directional bet on 13 tech-heavy stocks during a massive bull market?
- **Check**: A naive "buy and hold QQQ LEAP" strategy would have returned enormous amounts 2019-2025. Is the strategy's edge real, or is it mostly leverage + beta in a bull market?
- **Check**: The 2022 bear market is the key test. What happened to the strategy during Jan-Oct 2022? If MaxDD is only 28.7% during a period when NVDA fell 66%, how?

## Files to Read

1. `scripts/autoresearch/strategy.ts` — the champion strategy code
2. `scripts/autoresearch/worker.ts` — LEAP evaluator (how trades are simulated)
3. `scripts/autoresearch/runner.ts` — WFA orchestration, leaderboard, correlation computation
4. `src/lib/backtest/wfa-options.ts` — WFA window construction and portfolio metrics
5. `src/lib/backtest/chain-cache.ts` — option chain data lookup
6. `src/lib/backtest/option-sim.ts` — option simulator (entry/exit pricing)
7. `docs/backtest-trust-gotchas.md` — all known bugs and traps
8. `scripts/autoresearch/journal.md` — agent's research journal (shows iteration history)
9. `data/leaderboard-full.json` — all 195 attempts with full metrics

## Output Format

Produce a report with these sections:

1. **Trust Score**: 1-10 (1 = certainly fake, 10 = production-ready)
2. **Critical Issues**: Any finding that could invalidate the result entirely
3. **Concerns**: Issues that may reduce the real Sharpe but don't invalidate it
4. **Validated**: Aspects of the methodology that check out
5. **Recommendation**: Should this strategy be paper-traded, or are there issues to fix first?

Be specific — cite file paths, line numbers, and code snippets. Don't just say "looks fine" — show your work.
