# WFA Credit Spread Audit Report (Standalone)

Date: 2026-03-21  
Scope: `option-sim`, `wfa-options`, `analytics`, `bsm-pricing`, `slippage`, `chain-cache`, `intraday-signals`, `portfolio-stress`, `wfa-run.ts`, `wfa-run-short.ts`

## 1) Executive Summary

This audit was performed against the current working tree, not against the older assumptions embedded in `docs/codex-wfa-audit-prompt.md`. That matters because several prompt-identified issues are already fixed in code now:

- WFA train/OOS evaluation enforces portfolio constraints and capital-at-risk budgets in `src/lib/backtest/wfa-options.ts:151-199` and `src/lib/backtest/wfa-options.ts:464-475`.
- WFA fitness now uses daily portfolio returns rather than trade-hold annualization in `src/lib/backtest/wfa-options.ts:201-268`.
- The generic simulator now executes `creditDeltaStop` in `src/lib/backtest/option-sim.ts:527-548`.
- Train-window selection now applies DSR-based guardrails in `src/lib/backtest/wfa-options.ts:275-343` with `computeDSR` in `src/lib/backtest/wfa-v2-stats.ts:152-186`.
- WFA now defaults to strict per-window metrics and supports guarded ensemble selection in `src/lib/backtest/wfa-options.ts:496-560`.
- Credit spreads now support combo-style spread fills, capped low-OI amplification, and requested-vs-realized width metadata in `src/lib/backtest/slippage.ts:62-138`, `src/lib/backtest/chain-cache.ts:420`, and `src/lib/backtest/option-sim.ts:656`.
- The short runner now routes through the v3 4H path via `scripts/wfa-run-short.ts`, `src/lib/backtest/intraday-monitor.ts`, and `src/lib/backtest/wfa-v3-orchestrator.ts`.

The main conclusions are:

- The swing strategy still looks materially more credible than the short-term strategy, but its reported edge can still be overstated by selection bias, curated-universe bias, and non-default reporting choices outside the current strict WFA baseline.
- The short-term 7-21 DTE strategy is no longer blocked by the old daily-monitoring implementation, and the strongest current evidence is now the full uncapped fixed 15-name universe under `bidask` fills with a real 63-day holdout (`npx tsx scripts/wfa-run-short.ts --tickers SPY,QQQ,AMD,IWM,TSLA,AAPL,JPM,NVDA,AMZN,MSFT,META,NFLX,GOOG,GS,COST --workers 8 --fill bidask`): OOS Sharpe `2.70`, OOS max drawdown `34.1%`, `+$171,415` OOS P&L, `326` OOS trades, and `5.8` trades/week, plus holdout Sharpe `2.65`, holdout max drawdown `26.3%`, `+$32,894` holdout P&L, and `57` holdout trades. That is materially more convincing than the earlier small-basket results because it uses the predeclared broader universe and a real reserved segment, but it is still more active and drawdown-heavy than the original target profile.
- Legacy trade-level analytics still expose hold-day Sharpe annualization in `src/lib/backtest/option-sim.ts:860-887` and `src/lib/backtest/analytics.ts:209-220`, so non-WFA entry points can still overstate short-horizon quality even though the main WFA path is better.

Targeted verification was run locally:

- `npx vitest run tests/option-sim-analytics.test.ts tests/wfa-options.test.ts tests/slippage.test.ts tests/option-sim-fills.test.ts tests/wfa-v3.test.ts tests/option-sim-delta-stop.test.ts tests/backtest-audit.test.ts`
- `npm run build`
- `npx tsx scripts/wfa-run-short.ts --ticker SPY --workers 1 --smoke`
- `npx tsx scripts/wfa-run-short.ts --ticker SPY --workers 1 --max-candidates 100`
- `npx tsx scripts/wfa-run-short.ts --ticker SPY --workers 1`
- `npx tsx scripts/wfa-run-short.ts --tickers SPY,QQQ,IWM,AMD --workers 1 --max-candidates 100 --fill bidask`
- `npx tsx scripts/wfa-run-short.ts --tickers SPY,IWM,AMD --workers 1 --max-candidates 100 --fill bidask`
- `npx tsx scripts/wfa-run-short.ts --tickers SPY,IWM,AMD --workers 1 --fill bidask`
- `npx tsx scripts/wfa-run-short.ts --tickers SPY,QQQ,AMD,IWM,TSLA,AAPL,JPM,NVDA,AMZN,MSFT,META,NFLX,GOOG,GS,COST --workers 1 --fill bidask`
- `npx tsx scripts/wfa-run-short.ts --ticker SPY --workers 4 --smoke`
- `npx tsx scripts/wfa-run-short.ts --tickers SPY,QQQ,AMD,IWM,TSLA,AAPL,JPM,NVDA,AMZN,MSFT,META,NFLX,GOOG,GS,COST --workers 8 --fill bidask`
- Result: all targeted tests passed (`102` tests in the full targeted suite, `68` in the focused short-runner suite), build passed, smoke runs completed on both serial and parallel paths, capped and uncapped single-name runs completed, capped basket runs completed, the full uncapped reduced-basket run completed, the pre-holdout fixed-universe run completed, and the current fixed-universe run with real holdout and parallel trial evaluation completed.

## 2) Bug Report

### Critical

1. **Legacy trade-level Sharpe is still structurally biased for short holds**
   - `computeOptionAnalytics` still defines returns as `pnlPct = pnl / maxLoss` and annualizes with `sqrt(252 / avgHoldDays)` in `src/lib/backtest/option-sim.ts:602-603` and `src/lib/backtest/option-sim.ts:875-886`.
   - The generic analytics module does the same style of hold-day annualization in `src/lib/backtest/analytics.ts:209-220`.
   - Impact: any consumer that still reads these trade-level Sharpe values can structurally overrate fast-turnover, low-variance configurations.

2. **Legacy trade-level Sharpe can still leak into non-WFA consumers**
   - The short wrapper now uses a real holdout by default and exports explicit holdout metrics, so the earlier "empty holdout" issue is fixed in current code.
   - The remaining current risk is that non-WFA entry points can still read legacy trade-hold Sharpe from `src/lib/backtest/option-sim.ts:875-886` and `src/lib/backtest/analytics.ts:209-220`.
   - Impact: the current main validation path is materially better, but surrounding consumers can still overstate short-horizon quality if they read the wrong metric.

### High

3. **Single-config selection risk remains despite DSR guardrails**
   - The optimizer is now capable of guarded ensemble selection in `src/lib/backtest/wfa-options.ts:496-560`, but the short v3 wrapper still ends up reporting one winning config across windows in the current fixed-universe run.
   - Impact: this is better than raw argmax, but still leaves winner's-curse variance and configuration instability on the table. The remaining issue is methodological, not a simple coding bug.

4. **Short-DTE monitoring mismatch has been fixed, shifting the bottleneck to evidence quality**
   - This is no longer true for the short runner. The current path uses `evaluateCreditSpread4H` in `src/lib/backtest/intraday-monitor.ts:105-363` and routes through `runWFAv3` in `scripts/wfa-run-short.ts:395-422`.
   - Updated assessment: the structural monitoring mismatch identified in the original audit has been addressed in code. The remaining issue is no longer cadence correctness; it is basket composition, concentration, and external validity.

5. **Short-runner evidence is now broad enough to be informative, but drawdown/turnover and WFE interpretation remain open issues**
   - This statement is no longer correct for the current fixed-universe run. The full uncapped 15-name result with real holdout produced `326` OOS trades, `57` holdout trades, OOS Sharpe `2.70`, and holdout Sharpe `2.65`.
   - Updated impact: the key remaining issues are no longer sample size or fake holdout validation. They are curated-universe bias, high trade frequency, sizable drawdown, and the fact that WFE becomes unstable when train-window Sharpe is near zero or negative.

### Medium

6. **Spread construction still snaps to the nearest available wing**
   - `findSpreadStrikes` chooses the closest available long strike in the same expiry and returns the actual width in `src/lib/backtest/chain-cache.ts:377-420`.
   - Impact: this is realistic, but means a nominal `$2.50` or `$5` sweep dimension is not guaranteed to be the actual realized width in sparse chains.

7. **The BSM/OU layer is assumption-driven rather than calibrated in this path**
   - `bsmPrice`, `bsmDelta`, and `ouIVEvolution` are cleanly implemented in `src/lib/backtest/bsm-pricing.ts:24-76`.
   - The remaining issue is not math correctness so much as parameter realism: `kappa`, theta choice, and any effective risk-free treatment are not surfaced here as a calibrated WFA model input.

## 3) Validity Assessment

### Swing Strategy (45-65 DTE): 4.0 / 5

Why it is reasonably credible:

- The main WFA path now uses portfolio daily returns, enforces capacity and capital constraints, and has DSR-based selection guardrails.
- Swing DTE materially reduces gamma-path fragility relative to the short strategy.
- The code now supports mark-to-market-based portfolio metrics and stress testing rather than relying only on exit-date P&L.

Why it is not higher:

- The optimizer still selects a single winner from a broad candidate set.
- Non-default lifecycle-style reporting can still flatter window-level comparability if re-enabled.
- The 14-ticker universe is curated and likely benefits from survivorship and bullish-regime concentration.

### Short-Term Strategy (7-21 DTE Basket): 4.1 / 5

Why confidence improved:

- The short runner now uses the v3 4H monitoring path rather than the old daily-monitoring implementation.
- The full uncapped fixed 15-name universe on the repaired path was directionally strong under `bidask` fills with a real holdout: OOS Sharpe `2.70`, max drawdown `34.1%`, `+$171,415` OOS P&L, `326` OOS trades, and `5.8` trades/week, plus holdout Sharpe `2.65` on `57` holdout trades with degradation `0.98`.
- The winning configuration was coherent rather than obviously absurd: `vol`, short delta `0.45`, profit target `50%`, width `2.5`, `ivMin = 30`, `deltaStop = 0.65`, `periodMultiplier = 2.5`.
- The current result is broad enough to matter but not uniformly clean: the holdout did not collapse, which is the biggest improvement versus the pre-holdout path, but the strategy still runs with substantial turnover and non-trivial drawdown.

Why confidence is still low:

- The universe is still curated and highly growth/beta heavy, so survivorship and broad-market-selection bias remain real.
- The resulting cadence is still arguably too high for the intended profile: `5.8` trades/week versus the earlier `2-4` trades/week target.
- OOS max drawdown `34.1%` and holdout max drawdown `26.3%` are much less comfortable than the earlier pre-holdout run suggested.
- Aggregate WFE in this run should not be trusted literally because near-zero or negative train-window Sharpe values make the ratio unstable.

Why it is not higher:

- The structural code issues are much improved, and the evidence is now statistically meaningful enough to take seriously.
- The remaining blockers are no longer trade count or fake validation. They are curated-universe bias, strategy-cadence control, and whether the drawdown profile is acceptable after a real holdout.

## 4) Answers To The Prompt's Major Audit Questions

### Area 1: Sharpe Ratio Validity

- `sqrt(252 / avgHoldDays)` is not a robust portfolio-level annualization method for overlapping options trades with variable holding periods. It remains in the legacy analytics path (`src/lib/backtest/option-sim.ts:883-886`, `src/lib/backtest/analytics.ts:209-220`), but the main WFA engine now uses daily portfolio returns instead (`src/lib/backtest/wfa-options.ts:240-268`).
- `pnl / maxLoss` is acceptable as a per-trade risk-efficiency measure, but it is not a substitute for portfolio return on capital. It should not be the sole optimizer fitness metric.
- Short-DTE Sharpe inflation is real in the legacy analytics path because the annualization multiplier grows as average hold days shrink.
- A 30-trade minimum is a guardrail, not strong statistical power. Under ideal IID assumptions, it is only borderline for distinguishing moderate Sharpe differences; under skew and autocorrelation it is weaker.
- For credit spreads, Sharpe alone is incomplete because returns are negatively skewed. The better pattern is: optimize on daily portfolio returns, then gate by DSR or a downside-aware companion such as Sortino or Calmar.

### Area 2: Walk-Forward Methodology

- The purge logic itself is sound for direct overlap prevention: OOS starts after `trainEnd + 1 + purgeGap` in `buildWFAWindows` at `src/lib/backtest/wfa-options.ts:52-68`.
- Purge gaps prevent direct position leakage, but they do not solve regime persistence or non-stationarity. That is not leakage; it is transfer risk.
- The code now partially addresses multiple testing through DSR in `src/lib/backtest/wfa-v2-stats.ts:152-186`, but this is not the same as a full SPA/FDR workflow and does not remove all selection bias.
- The shared WFA path now defaults to strict per-window metrics and supports guarded ensemble selection in `src/lib/backtest/wfa-options.ts:496-560`. That materially improves methodology versus the earlier audit baseline.
- WFE should be interpreted as a distribution across windows, not just a single scalar.
- Anchored windows are worth testing for the short strategy because the available history is shorter and the regime history is uneven, but that is an experiment choice rather than an obvious correctness fix.

### Area 3: Option Pricing And IV Model

- The BSM implementation itself looks mathematically sound: pricing and put delta parity are implemented correctly in `src/lib/backtest/bsm-pricing.ts:24-58`.
- `ouIVEvolution` is deterministic and assumption-driven in `src/lib/backtest/bsm-pricing.ts:60-76`; `kappa = 4.0` implies a meaningful pull toward theta over swing horizons, but the parameter is not shown here as empirically calibrated.
- HV-based theta targets are a simplification and ignore variance-risk-premium structure.
- The more important unresolved issue for short DTE is not put delta math; it is path dependence from gamma and daily monitoring cadence.

### Area 4: Fill Model And Microstructure

- The slippage model is conceptually coherent: half-spread plus incremental impact from OI and DTE in `src/lib/backtest/slippage.ts:46-62`.
- It is not obviously double-counting because `applyFill` subtracts the embedded half-spread before adding incremental impact in `src/lib/backtest/slippage.ts:95-102`.
- Independent leg fills are likely conservative relative to spread-combo execution.
- Short-dated illiquid tails can still be dominated by the OI penalty, which makes the short strategy especially fragile to microstructure assumptions.

### Area 5: Signal Generation And Indicator Scaling

- The 4H signal engine fully supports scaled indicator periods in `src/lib/backtest/intraday-signals.ts:27-40`.
- The short runner no longer opts out of that; it now sweeps `[1.5, 2.0, 2.5]` in `scripts/wfa-run-short.ts:96` and `scripts/wfa-run-short.ts:235-258`.
- The strongest current fixed-universe run selected `periodMultiplier = 2.5`, which still supports the original audit concern that `1.0` was too fast.
- The short runner still hard-codes `score >= 65` and `ADX >= 8` in `scripts/wfa-run-short.ts:183-184`. Those may be reasonable heuristics, but they are not justified in the code by a calibration layer.
- A new "gamma-aware preset" is less urgent than getting monitoring cadence, liquidity filtering, and portfolio-level selection right.

### Area 6: Why The Short-DTE Strategy Fails

- The original primary structural issue, daily monitoring of gamma-sensitive spreads, is now addressed in code.
- The leading remaining issues are now curated-universe bias, cadence control, drawdown tolerance, and WFE interpretability rather than pure opportunity scarcity.
- Economic compression still matters, but the fixed 15-name universe showed that breadth can materially improve trade count and aggregate economics without abandoning realistic execution.
- Data completeness looks much less like the limiting factor than it did in the original audit.

### Area 7: Whether The Swing Strategy Is Really Robust

- The swing path is much more plausible than the short path because it is less exposed to intraday gamma cliffs and now benefits from portfolio-consistent WFA metrics.
- It is still vulnerable to curated-universe bias and broad-market concentration.
- The right stress lens is not just realized drawdown from closed trades; it is portfolio daily mark-to-market drawdown and correlation stress.
- A high win rate alone is not enough. Profit factor and tail loss concentration matter more for a short-vol strategy.

### Area 8: Proposed Mathematical Improvements

- **Alternative fitness function:** the best immediate choice is not to abandon Sharpe entirely, but to keep portfolio daily-return Sharpe and pair it with DSR and downside diagnostics.
- **Ensemble selection:** yes, a small top-K ensemble is standard enough as a stability device, even if not the canonical textbook WFA recipe. A practical K here is 3 to 5.
- **Regime detection:** feasible, but high overfitting risk. If added, it should be frozen out-of-sample and validated against simple baselines rather than tuned aggressively.
- **Portfolio-level optimization:** now feasible because the WFA engine already computes daily portfolio returns and enforces position constraints.
- **Transaction cost integration:** modeled slippage already flows into net P&L because fills are priced through `applyFill`, then stored in trade economics and reflected in `pnl` at `src/lib/backtest/option-sim.ts:602-638`.

## 5) Improvement Roadmap

### Priority 1: Bring Short-DTE Cadence And Drawdown Back Under Control

- Impact: Very High
- Effort: Medium
- Risk: Medium
- Status: Worth testing next
- Why: the current fixed-universe run already has a real holdout and it held up, but `5.8` trades/week with `34.1%` OOS max drawdown is still a materially different risk/turnover profile than the intended target.

### Priority 2: Audit Universe Bias And Cross-Ticker Failure Modes

- Impact: High
- Effort: Medium
- Risk: Medium
- Status: Worth testing next
- Why: the real-holdout result is more believable now, which makes the remaining curated-universe and cross-ticker bias questions more important, not less.

### Priority 3: Top-K Ensemble Or Final SPA-Style Acceptance Gate

- Impact: High
- Effort: Medium
- Risk: Low-Medium
- Status: Worth testing next
- Why: DSR guardrails help, but one config still dominates all non-empty windows in the current fixed-universe run.

### Priority 4: Re-Tune Short 4H Signal Horizon And Gates

- Impact: Medium
- Effort: Medium
- Risk: Medium
- Status: Worth testing next
- Why: `periodMultiplier = 2.5` emerged as the real-holdout full-run winner, but the signal gates are still heuristic and the current cadence may be too high.

### Priority 5: WFE And Robustness Reporting Cleanup

- Impact: Medium
- Effort: Low-Medium
- Risk: Medium
- Status: Worth testing next
- Why: the current aggregate `WFE = 95.90` is not decision-useful because train-window Sharpe values near zero or below zero make the ratio explode.

### Not Worth Prioritizing Yet

- Adding a new gamma-aware signal preset before fixing monitoring cadence and selection stability.
- Deep regime-switching complexity before a simpler ensemble and strict-metric baseline is established.

## 6) Top-3 Pseudocode Changes

### A. Intraday-Aware Short-DTE Monitoring

```ts
for each open short-dte spread:
  for each intraday bar until exit:
    reprice short and long legs
    update gamma-aware short delta

    if spread_cost <= tp_cost: exit(PROFIT_TARGET)
    if abs(short_delta) >= dynamic_delta_stop(dte, gamma): exit(DELTA_STOP)
    if spread_cost >= hard_loss_cost: exit(STOP_LOSS)
    if dte <= time_stop_dte: exit(TIME_STOP)
```

### B. Top-K Guarded Ensemble Selection

```ts
results = evaluate_all_configs(train_window)
eligible = results
  .filter(r => r.tradeCount >= minTrades)
  .filter(r => r.dsr >= minDSR)
  .sort(by robustScore desc)

topK = eligible.slice(0, K)
oos_signals = union_signals(topK.configs, vote = "majority" or "average-rank")
run_oos_portfolio(oos_signals, constraints, capital_budget)
```

### C. Strict Window Metrics As Default Report Mode

```ts
for each wfa_window:
  oos_trades = simulate(best_config, oos_signals, allow_close_through_global_end)

  strict_metrics = computePortfolioDailyMetrics(
    oos_trades,
    allTradingDates,
    startDate = window.oosStart,
    endDate = window.oosEnd,
    startingCapital
  )

  lifecycle_metrics = computePortfolioDailyMetrics(
    oos_trades,
    allTradingDates,
    startDate = window.oosStart,
    endDate = globalEnd,
    startingCapital
  )

  report strict_metrics as the default
  keep lifecycle_metrics as optional continuity context
```

## 7) Short-Term Strategy Verdict

The short-term basket strategy is now credible enough to be treated as a serious validation candidate with a functioning holdout, but not yet validated enough to be treated as a robust production strategy.

Post-fix update: the implementation mismatch has been materially repaired, the holdout is now real, and the holdout did not collapse. The remaining question is not whether the engine works, but whether the strategy's drawdown, turnover, and curated-universe dependence are acceptable.

What must change before it can be trusted:

- Keep the 4H monitoring path and treat it as canonical.
- Freeze the current fixed 15-name universe and treat the current holdout-enabled run as the baseline before resuming further basket or config search.
- Re-test stability with guarded ensemble selection and the current winning `periodMultiplier = 2.5` neighborhood.
- Decide whether `5.8` trades/week and `34.1%` OOS max drawdown are acceptable or whether the strategy should be deliberately throttled.
- Clean up WFE-style reporting so near-zero train Sharpe does not produce misleading "healthy" aggregate ratios.

Without those changes, the short strategy will still be vulnerable to search leakage, curated-universe bias, and turnover creep even though the execution engine now looks materially sound.

Current verdict: credible fixed-universe candidate strategy with real holdout support, not yet validated production strategy.

## 8) Statistical Power Analysis

This section is intentionally approximate and should be interpreted as a decision aid rather than a formal proof.

- With `N = 30` effective observations, the Sharpe estimator is noisy even under IID-normal assumptions.
- The strongest current post-fix result is no longer the single-name `SPY` run or the reduced basket; it is the full uncapped fixed 15-name universe with real holdout, `326` OOS trades, and `57` holdout trades.
- A practical rule of thumb at mid-range Sharpe levels is:
  - `N = 30` supports only coarse distinctions; a difference around `0.5-0.6` Sharpe units is near the detection boundary.
  - `N = 100` improves that to roughly `0.3`.
  - `N = 300` improves that to roughly `0.18`.
  - `N = 500` improves that to roughly `0.14`.
- Once skew, fat tails, and overlapping-option path effects are acknowledged, effective power is worse than the IID-normal approximation.
- Multiple testing remains material even after DSR guardrails. When candidate counts reach the high hundreds, the expected best in-sample Sharpe under a noisy search is still non-trivial.

Practical interpretation:

- `minTrainTrades = 30` is a floor, not a comfort zone.
- Stronger confidence comes from more windows, more stable per-window OOS behavior, and selection procedures that penalize search breadth.
- `326` OOS trades plus `57` holdout trades is enough to move the short strategy well out of the "toy sample" regime.
- The post-fix short strategy is now in the regime where universe definition, turnover control, drawdown tolerance, and reporting discipline matter more than raw trade count.

## 9) Current-State Delta From The Prompt's Original Assumptions

### Already Fixed In Current Code

- **Portfolio constraints are enforced in WFA now**
  - Evidence: `src/lib/backtest/wfa-options.ts:151-199`, `src/lib/backtest/wfa-options.ts:464-475`
  - Test support: `tests/wfa-options.test.ts:127-198`

- **WFA fitness now uses daily portfolio returns**
  - Evidence: `src/lib/backtest/wfa-options.ts:201-268`, `src/lib/backtest/wfa-options.ts:309-319`, `src/lib/backtest/wfa-options.ts:479-511`

- **Generic simulator now executes `creditDeltaStop`**
  - Evidence: `src/lib/backtest/option-sim.ts:527-548`
  - Test support: `tests/option-sim-delta-stop.test.ts:94-160`

- **Config selection now has DSR-based guardrails**
  - Evidence: `src/lib/backtest/wfa-options.ts:316-336`, `src/lib/backtest/wfa-v2-stats.ts:152-186`
  - Test support: `tests/wfa-options.test.ts:200-272`

- **WFA now defaults to strict per-window metrics and supports guarded ensemble selection**
  - Evidence: `src/lib/backtest/wfa-options.ts:496-560`
  - Test support: `tests/wfa-options.test.ts:394-510`

- **Short runner now uses the v3 4H execution path**
  - Evidence: `scripts/wfa-run-short.ts:395-422`, `src/lib/backtest/intraday-monitor.ts:105-363`
  - Test support: `tests/wfa-v3.test.ts`

- **Short runner now uses a real holdout by default and supports parallel trial evaluation**
  - Evidence: `scripts/wfa-run-short.ts`, `scripts/wfa-v3-short-worker.ts`
  - Test support: `tests/wfa-v3.test.ts`

- **Spread fills and analytics are more explicit now**
  - Evidence: `src/lib/backtest/slippage.ts:62-138`, `src/lib/backtest/option-sim.ts:963-1029`, `src/lib/backtest/chain-cache.ts:420`
  - Test support: `tests/slippage.test.ts`, `tests/option-sim-fills.test.ts`, `tests/option-sim-analytics.test.ts`

### Remaining Risks

- Legacy trade-level Sharpe still exists in non-WFA analytics consumers.
- The fixed 15-name universe is still curated and can benefit from survivorship and broad-market-selection bias.
- The current short configuration is more active than the earlier target cadence.
- The current short configuration still carries material drawdown risk on both OOS and holdout slices.
- Short 4H signal threshold choices still look heuristic rather than validated.

### Worth Testing Next

- Controlled throttling experiments that try to bring frequency and drawdown down without collapsing holdout Sharpe.
- A frozen fixed-universe rerun on a later untouched segment rather than more basket search.
- Top-K ensemble selection over guarded winners.
- `periodMultiplier = 2.5` or nearby values for the short runner.
- Reporting changes that replace or de-emphasize unstable aggregate WFE.
- Liquidity filters that explicitly cap short-leg spread quality and low-OI exposure.

### Not Worth Pursuing Yet

- More basket hunting before the current fixed-universe result is validated on a real holdout.
- New signal-preset complexity before the existing 4H horizon and risk controls are validated.
