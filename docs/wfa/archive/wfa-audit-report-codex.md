# WFA Credit Spread Audit Report (Codex)

Date: 2026-03-20  
Scope: `option-sim`, `wfa-options`, `analytics`, `bsm-pricing`, `slippage`, `chain-cache`, `intraday-signals`, `portfolio-stress`, `wfa-run.ts`, `wfa-run-short.ts`, `wfa-short-worker.ts`

## 1) Bug Report (Math / Leakage / Assumption Risks)

### Critical

1. **RESOLVED (2026-03-20): portfolio constraints are now enforced in the WFA engine**
   - `runWFAOptions` now evaluates train and OOS signals through `evaluateSignalsWithConstraints`.
   - Evidence:
     - `src/lib/backtest/wfa-options.ts:129-183` enforces `maxPositions`, `maxPerTicker`, and capital-at-risk budget.
     - `src/lib/backtest/wfa-options.ts:391-420` applies these constraints in both train and OOS.
     - `tests/wfa-options.test.ts:127-198` adds regression tests for constraint/capital gating.
   - Historical impact (before fix):
     - Inflated concurrency and optimistic realized-path risk metrics.

2. **PARTIALLY RESOLVED: WFA fitness now uses portfolio daily returns, but legacy analytics still expose trade-level Sharpe**
   - WFA optimizer/runtime Sharpe now uses daily portfolio returns:
     - `src/lib/backtest/wfa-options.ts:185-251` (`computePortfolioDailyMetrics`)
     - `src/lib/backtest/wfa-options.ts:286-293` (train fitness)
     - `src/lib/backtest/wfa-options.ts:423-440, 449-475` (OOS/window/aggregate Sharpe)
   - Legacy `computeOptionAnalytics` still computes trade-level hold-day Sharpe (`src/lib/backtest/option-sim.ts:858-860`), so non-WFA consumers can still read the old-style metric.

3. **Per-window OOS metrics include exits beyond window end**
   - OOS evaluation sets `maxDate = config.endDate`, not `w.oosEnd`.
   - `src/lib/backtest/wfa-options.ts:418`, `src/lib/backtest/wfa-options.ts:423-429`
   - This is acceptable for portfolio continuity, but per-window OOS/WFE then includes post-window information (for that trade’s full lifecycle), weakening strict window comparability.

### High

4. **Selection bias from argmax over large candidate pools**
   - `optimizeWindow` picks best IS Sharpe directly.
   - `src/lib/backtest/wfa-options.ts:258-301`
   - No built-in deflation/penalty for multiple testing.
   - With 288 candidates and low N windows, chance winners are likely.

5. **Generic simulator includes `creditDeltaStop` in config but does not apply it**
   - `SimConfig` has `creditDeltaStop` (`src/lib/backtest/option-sim.ts:104`), but `simulateCreditSpread` exit logic omits delta-stop checks (`src/lib/backtest/option-sim.ts:510-516`).
   - Swing/short runners implement delta stop in custom evaluators, so behavior is inconsistent across entry points.

### Medium

6. **Large discrepancy between reported realized DD and correlated MTM stress**
   - Swing report: OOS MaxDD ~4.6% (realized path), but stress module reports peak correlated DD ~67.8% on daily MTM.
   - Indicates hidden path risk not visible in exit-date-only drawdown metric.

7. **Short strategy artifact file appears pre-fix / non-comparable**
   - `data/wfa-results-short.json` contains heavy duplicate-like trade patterns and limited date span.
   - Current code includes dedup (`scripts/wfa-run-short.ts:175-185`), but this artifact likely predates it.

## 2) Validity Assessment (1-5)

### Swing (45-65 DTE): **4.0 / 5**

Why not higher:
- Multiple-testing selection bias remains (argmax over large candidate pools).
- Per-window OOS metrics still include post-window exits (continuity tradeoff).
- Survivorship bias in curated ticker universe likely non-trivial.

Why not lower:
- Metrics are directionally plausible and less fragile than short-DTE.
- 2022 bear-period subset in current artifact is not catastrophic.
- Profit factor remains healthy in tested artifact (~2.88).

### Short (7-14 DTE): **2.0 / 5**

Why still low:
- Daily monitoring + short-DTE gamma is structurally mismatched.
- Very weak or unstable OOS behavior in the short artifact.
- High sensitivity to microstructure assumptions and candidate-selection noise.
- `creditDeltaStop` is still declared but not executed in the generic simulator path.

## 3) Answers To Key Audit Questions

### Sharpe / Fitness Validity

- **Annualization by `sqrt(252/avgHoldDays)` is not robust** for overlapping multi-asset portfolios.
- **`pnl/maxLoss` return definition** is valid for per-trade risk efficiency, but not a full portfolio performance metric.
- **Short-DTE inflation risk is real** under hold-day annualization; best fix is daily portfolio-return Sharpe.
- **N=30 is borderline**:
  - Under IID normal assumptions, power to distinguish Sharpe 1.0 vs 0.5 is only moderate.
  - Under skew/fat tails/autocorrelation (credit spreads), effective power is worse.
- **Sharpe alone is insufficient** for negatively skewed distributions; optimizer should include downside/tail-aware criteria.

### WFA Methodology

- **Purge gaps (65 for swing, 14 for short)** are broadly adequate for direct position overlap leakage.
- **Signal regime persistence is not leakage** by itself, but it increases non-stationarity risk and lowers out-of-regime transferability.
- **Multiple-testing correction is needed** (DSR / SPA / block bootstrap preferable to pure Bonferroni for correlated configs).
- **WFE should be distributional**, not just one scalar.
- **Anchored windows are worth testing for short-DTE**, especially if data history is limited.

### Option Model & Microstructure

- **Risk-free rate omission** has small effect on vertical spreads (mostly cancels between legs), but should be explicit and consistent.
- **O-U kappa/theta are currently assumption-driven**, not calibrated in this path.
- **`putDelta = callDelta - 1`** is mathematically valid in BSM; American/dividend effects are second-order but non-zero near ex-div and deep ITM.
- **Independent-leg slippage is conservative** vs combo-order fills.
- **Current slippage model is not obviously double-counting**; it adds half-spread baseline + incremental impact.

### Signal/Threshold Findings (computed from local 4H data, 2022-01-01..2026-02-28)

- Score threshold **65** is not extremely strict:
  - For `em` preset: ~36.66% of all 4H signals pass 65.
  - Conditional on directional signals, ~84.47% pass 65.
- Raising to **70** has modest effect for `ema/em`, larger effect for `vol`.
- ADX gate `<8` is almost non-binding after score gating:
  - For score>=65, ADX<8 share was ~0.03%-0.07% across tested presets.
- `periodMultiplier=2.0` reduces signal volume materially vs `1.0` (roughly 17%-22% fewer signals in tested presets), consistent with slower indicator response.

### Chain Data Completeness (short universe, 2022-01-01..2026-02-28)

- 7-14 DTE coverage is near-complete for most tickers.
- GOOG is lower (~94.15% of trading days), others mostly 96%-100%.
- So short strategy failure is unlikely to be primarily driven by missing weekly expiries in this universe.

## 4) Improvement Roadmap (Impact / Effort / Risk)

### Priority 1 — Portfolio-Consistent Fitness + Enforced Capacity
- Impact: **Very High**
- Effort: **Medium**
- Risk: **Low-Medium**
- Changes:
  - Enforce `maxPositions`, `maxPerTicker`, capital/risk budget in OOS simulation.
  - Compute optimizer fitness on **daily portfolio returns** (not trade-level pseudo-frequency scaling).

### Priority 2 — Robust Config Selection (Deflated + Ensemble)
- Impact: **High**
- Effort: **Medium**
- Risk: **Low**
- Changes:
  - Replace argmax Sharpe with filtered top-K by deflated/bootstrapped significance.
  - Use ensemble voting/aggregation to reduce winner’s-curse variance.

### Priority 3 — Short-DTE Intraday Risk Handling
- Impact: **High** (for short only)
- Effort: **Medium-High**
- Risk: **Medium**
- Changes:
  - Use 4H monitoring (`intraday-monitor`) or at minimum higher-frequency stop checks.
  - Add gamma-aware stop logic (dynamic delta threshold by DTE/gamma).

### Priority 4 — WFA Reporting Upgrades
- Impact: Medium
- Effort: Low
- Risk: Low
- Report per-window WFE distribution, rolling OOS decay, and stress-adjusted DD.

### Priority 5 — Universe/Regime Robustness Tests
- Impact: Medium
- Effort: Medium
- Risk: Low
- Add random-universe bootstrap and regime-segmented OOS diagnostics.

## 5) Pseudocode For Top 3 Changes

### A. Enforce portfolio constraints + daily-return Sharpe

```ts
for each day in oos_calendar:
  candidates = signals_on_day(day)
  rank candidates by model score / expected edge
  for sig in candidates:
    if openPositions >= maxPositions: break
    if openByTicker[sig.ticker] >= maxPerTicker: continue
    if riskUsed + tradeMaxLoss(sig) > riskBudget: continue
    openTrade(sig)

  mtmPnl = sum(position.dailyMtMChange for open positions)
  equity += mtmPnl
  dailyReturns.push(mtmPnl / prevEquity)

fitnessSharpe = mean(dailyReturns) / std(dailyReturns) * sqrt(252)
```

### B. Deflated + Ensemble Selection

```ts
results = evaluateAllConfigs(IS)
for r in results:
  r.dsr = deflatedSharpe(r.sharpe, r.tradeCount, numTrials=M)
keep = results.filter(r => r.tradeCount >= minTrades && r.dsr >= dsrMin)
topK = selectTopK(keep, key = robustScore(r))   // e.g. dsr + stability penalty
selectedConfig = ensemble(topK)                 // signal vote or averaged params
```

### C. Short-DTE Intraday Monitoring

```ts
entry = openSpreadFromDailyChain(signalDay)
for bar in intradayBarsUntilExit:
  repriced = bsmRepriceSpread(entry, bar.close, ivDynamics)
  if endOfDay(bar) and realChainAvailable:
    repriced = calibrateToChainMid(repriced)

  if repriced.cost <= tpCost: exit(PROFIT_TARGET)
  if repriced.cost >= slCost: exit(STOP_LOSS)
  if abs(repriced.shortDelta) >= dynamicDeltaStop(bar.dte, repriced.gamma): exit(DELTA_STOP)
  if bar.dte <= timeStopDTE: exit(TIME_STOP)
```

## 6) Short-Term Strategy Verdict

**Verdict: salvageable only with structural changes; not reliable in current daily-monitoring form.**

What must change to salvage 7-14 DTE:
- Intraday-aware monitoring (or robust proxy) for gamma-sensitive exits.
- Portfolio-level constraint enforcement and daily-return fitness.
- Multiple-testing-robust selection + ensemble stability.
- Explicit liquidity filtering (`minShortOI`, spread quality) for low-OI tails.
- Re-tune indicator horizon (`periodMultiplier`) and verify regime transfer.

Without those, results are likely to remain fragile and hard to trust OOS.

## 7) Statistical Power Analysis

### Distinguishing Sharpe 1.0 vs 0.5 at N=30

- Under ideal IID-normal assumptions, N=30 gives only moderate power.
- Approximate Sharpe estimator SE at S≈0.75: ~0.21.
- 80% power minimum detectable difference (two-sided, alpha 5%):
  - `MDD ≈ (1.96 + 0.84) * SE ≈ 0.58 Sharpe units`.
- So a 0.5 difference is near the detection boundary even before non-normality penalties.

### Practical MDD guide (S≈0.75, 80% power)

- N=30  → ~0.58  
- N=100 → ~0.32  
- N=300 → ~0.18  
- N=900 → ~0.11

### Multiple-testing effect (M=288 configs)

- Under null (true Sharpe=0), expected max in-sample Sharpe from chance alone is non-trivial.
- Simulation-style intuition:
  - At N=30, best-of-288 null Sharpe often lands around ~0.57 on average.
- This reinforces using deflated Sharpe / bootstrap-based selection controls.

## 8) Continuation Update (Current Branch Snapshot)

### What changed since the earlier draft

- WFA now enforces capacity/risk constraints in both train and OOS paths.
- WFA optimization and OOS reporting now use portfolio daily-return Sharpe.
- Tests were added for constraint enforcement and capital gating in `tests/wfa-options.test.ts`.
- Per-window metric mode is now configurable:
  - `windowMetricsMode='lifecycle'` (default): include full trade lifecycle through global end date.
  - `windowMetricsMode='strict'`: compute each window's OOS metrics only through `w.oosEnd`.
  - Evidence: `src/lib/backtest/wfa-options.ts`, `tests/wfa-options.test.ts`.
- Generic simulator now executes `creditDeltaStop`:
  - `simulateCreditSpread` exits with `DELTA_STOP` when `abs(shortLeg.delta) >= creditDeltaStop`.
  - Evidence: `src/lib/backtest/option-sim.ts`, `tests/option-sim-delta-stop.test.ts`.
- Train-window selection now has multiple-testing guardrails:
  - `optimizeWindow` computes DSR per candidate and applies `selectionGuard` (`minTrainTrades`, `minDSR`) before final pick.
  - If nothing passes strict filters, it falls back to top-K Sharpe candidates and ranks by robust score (`robustScore`, then DSR, Sharpe, trades).
  - Evidence: `src/lib/backtest/wfa-options.ts`, `tests/wfa-options.test.ts`.

### Open issues still worth addressing next

1. **Single-config selection remains (no signal-level ensemble yet)**
   - Selection is now guarded/robust, but execution still deploys one config per window.
   - A top-K ensemble at signal layer is still optional future work for extra variance reduction.

### Suggested immediate execution order

1. Add top-K signal ensemble execution mode (vote/aggregate across selected configs).
2. Add optional SPA/permutation significance gate for final candidate acceptance.

## 9) Research-Backed Variant Matrix To Test Next (Config + Strategy)

Below is a practical experiment set designed for your current codebase (`vrpFilter`, `contangoFilter`, `slopeFilter`, liquidity filters, DTE/delta/exit knobs already exist).

### A) Regime-Aware Entry Gating (Vol Risk Premium + Term Structure)

Hypothesis:
- Short-vol credit spreads should perform better when volatility risk premium is favorable and term structure is healthier.
- Literature signal: term-structure shape carries variance-risk-premium information, and this has return predictability.

Config variants:
- `contangoFilter`: `[-0.05, 0.00, 0.03, 0.06]`
- `vrpFilter`: `[0.00, 0.005, 0.010, 0.020]` (scale in IV^2-RV^2 units)
- `slopeFilter`: use rolling quantile gates (e.g., >=20th / >=40th / >=60th percentile) instead of fixed absolute numbers.

WFA checks:
- Report OOS Sharpe/WFE by regime bucket (`contango<0`, `0-5%`, `>5%`).
- Require improvement in both aggregate OOS Sharpe and worst-regime Sharpe (not just average).

### B) DTE/Delta Architecture (Avoiding 7-14D Gamma Cliff)

Hypothesis:
- Very short maturities have larger jump/gamma sensitivity; extending some exposure to 14-35 DTE may stabilize tails while retaining premium harvest.

Config variants (portfolio sleeves):
- Sleeve S1 (short): DTE `7-14`, delta `0.15-0.25`, `creditTimeStopDTE=3`.
- Sleeve S2 (hybrid): DTE `14-21`, delta `0.20-0.30`, `creditTimeStopDTE=4`.
- Sleeve S3 (carry): DTE `21-35`, delta `0.25-0.35`, `creditTimeStopDTE=5`.

WFA checks:
- Compare per-sleeve and blended portfolio: OOS Sharpe, MaxDD, CVaR(95), worst 5-day loss.
- Accept only if short sleeve no longer dominates downside tail metrics.

### C) Exit-Logic Variants (Tail Control Without Killing Carry)

Hypothesis:
- Fixed TP + effectively no SL (`creditStopLossMultiple=100`) leaves left-tail too open.
- Dynamic delta/time exits should reduce catastrophic tail outcomes.

Config variants:
- `creditStopLossMultiple`: `[2.0, 2.5, 3.0, 100]`
- `creditDeltaStop`: static `[0.45, 0.55, 0.65]`
- Dynamic delta-stop schedule (new variant):
  - DTE>=10: `0.65`
  - 6<=DTE<10: `0.55`
  - DTE<=5: `0.45`
- TP policy: compare fixed TP (`0.30/0.50`) vs phased TP (already supported in simulator).

WFA checks:
- Exit-type decomposition: `%DELTA_STOP`, `%STOP_LOSS`, `%TIME_STOP`, `%EXPIRATION`.
- Tail diagnostic: P95/P99 trade loss and cluster-loss days.

### D) Liquidity & Execution Quality Filters (Short-DTE Critical)

Hypothesis:
- Illiquid options can distort realized execution and destabilize OOS.

Config variants:
- `minShortOI`: `[250, 500, 1000, 2000]`
- `maxBidAskSpreadPct`: `[0.08, 0.12, 0.20]`
- Slippage stress modes for robustness:
  - baseline
  - `1.5x`
  - `2.0x` impact/spread

WFA checks:
- Strategy must remain positive Sharpe under at least `1.5x` stress.
- If performance collapses only in stress mode, classify as execution-fragile.

### E) Selection / Validation Hardening

Already done:
- DSR + min-trade guard in train-window config selection.

Next validations:
- Add SPA/Reality-Check style acceptance test for final selected strategy family.
- Report significance-adjusted score alongside Sharpe/WFE.

Pass condition:
- Improvement must survive significance gate and stress-fill scenario, not just raw OOS Sharpe.

## 10) Why These Variants (Research Signals)

- DSR and multiple-testing correction are motivated by Bailey & López de Prado and data-snooping literature (White RC, Hansen SPA).
- Variance-risk term-structure evidence supports regime-conditioned short-vol exposure.
- Option illiquidity evidence supports strict liquidity and spread-quality filters.
- Put-call/volatility-spread evidence supports using option-implied information as additional gating signals.

## 11) Primary Sources Used

1. White (2000), *A Reality Check for Data Snooping* (Econometrica):  
   https://www.ssc.wisc.edu/~bhansen/718/White2000.pdf
2. Hansen (2005), *A Test for Superior Predictive Ability* (JBES / JSTOR index):  
   https://www.jstor.org/stable/i27638831
3. Bailey, Borwein, López de Prado, Zhu (2016), *The Probability of Backtest Overfitting* (JCF):  
   https://www.risk.net/journal-of-computational-finance/2471206/the-probability-of-backtest-overfitting
4. Johnson (2017), *Risk Premia and the VIX Term Structure* (JFQA):  
   https://www.cambridge.org/core/services/aop-cambridge-core/content/view/56572D1F060448571BD8F597C732D9C3/S0022109017000825a.pdf/div-class-title-risk-premia-and-the-vix-term-structure-div.pdf
5. Cboe S&P 500 PutWrite Indices Methodology (official methodology document):  
   https://cdn.cboe.com/api/global/us_indices/governance/Cboe_SP_500_PutWrite_Indices_Methodology.pdf
6. Christoffersen, Goyenko, Jacobs, Karoui (2018), *Illiquidity Premia in the Equity Options Market* (RFS index/DOI):  
   https://academic.oup.com/rfs/issue/31/3
7. Bali & Hovakimian (2009), *Volatility Spreads and Expected Stock Returns* (cited in JFQA references page):  
   https://www.cambridge.org/core/journals/journal-of-financial-and-quantitative-analysis/article/volatility-and-expected-option-returns/EE41728DD4BDD83E333298737A28E02F
8. Cremers & Weinbaum (2010), *Deviations from Put-Call Parity and Stock Return Predictability* (Management Science listing):  
   https://pubsonline.informs.org/doi/10.1287/mnsc.1100.1278

## 12) First Batch Runner (Implemented)

`scripts/wfa-run.ts` now supports a regime-study batch mode for Section 9A:

- Command:
  - `npx tsx scripts/wfa-run.ts --regime-study`
  - optional output name: `--regime-out wfa-regime-study.json`
- What it does:
  - Runs multiple WFA arms (baseline + contango/VRP gates).
  - Prints an automatic before/after OOS table (`Sharpe`, `ΔSharpe`, `WFE`, `MaxDD`, trades, P&L).
  - Writes arm summaries + per-window chosen config metadata to `data/<regime-out>.json`.

## 13) Regime Study Check (SPY Pilot, March 20, 2026)

Quick validation run executed:

- `npx tsx scripts/wfa-run.ts --regime-study --ticker SPY`
- Output artifact: `data/wfa-regime-study.json`

### OOS Summary (SPY only)

| Arm | Sharpe | ΔSharpe vs baseline | WFE | MaxDD | Trades | OOS PnL |
|---|---:|---:|---:|---:|---:|---:|
| baseline | 0.47 | +0.00 | 0.37 | 11.2% | 341 | $20,943 |
| contango_3 | 0.38 | -0.10 | 0.34 | 7.3% | 251 | $10,471 |
| contango_6 | 0.40 | -0.08 | 0.38 | 4.6% | 172 | $8,621 |
| vrp_005 | 0.47 | +0.00 | 0.37 | 11.2% | 341 | $20,943 |
| vrp_010 | 0.47 | +0.00 | 0.37 | 11.2% | 341 | $20,943 |
| hybrid_c3_v005 | 0.38 | -0.10 | 0.34 | 7.3% | 251 | $10,471 |
| hybrid_c6_v010 | 0.40 | -0.08 | 0.38 | 4.6% | 172 | $8,621 |

### Interpretation

1. **Contango gating is a risk reducer, not a return enhancer (for SPY in this sample).**
   - `contango_6` cut drawdown from `11.2%` to `4.6%` (~59% reduction), but Sharpe and total PnL both fell.
2. **Current VRP thresholds are non-binding.**
   - `vrp_005` and `vrp_010` are identical to baseline, suggesting these cutoffs do not meaningfully filter SPY entries in this period.
3. **Hybrid arms are effectively dominated by contango filter behavior.**
   - Because VRP was non-binding, hybrid outcomes match corresponding contango-only arms.

### What to test next (directly from this result)

1. Replace hard contango gate with **position sizing by regime** (e.g., full size when contango >= 6%, reduced size otherwise) to preserve more carry while keeping DD control.
2. Re-parameterize VRP using **cross-sectional or rolling-percentile thresholds** instead of fixed `0.005/0.010`.
3. Run the same regime study on full universe (`--regime-study` without `--ticker`) and evaluate whether contango risk reduction persists cross-asset.

## 14) Runtime Optimization Update (Machine Utilization)

To improve local CPU utilization, `scripts/wfa-run.ts` now supports worker-thread parallel train evaluation:

- New flag: `--workers <n>`
- New flag: `--regime-arm <name>` (for single-arm benchmarking/targeted runs)
- Default worker count set to `4` (empirically best on this machine)

### Controlled benchmark (SPY baseline arm, March 20, 2026)

Command template:
- `npx tsx scripts/wfa-run.ts --regime-study --regime-arm baseline --ticker SPY --train 504 --step 504 --workers <n>`

Results:
- `workers=1`: `81.7s`
- `workers=4`: `41.0s` (best, ~2.0x faster)
- `workers=8`: `184.2s` (worse due contention/overhead)

Interpretation:
- This workload is not purely CPU-bound; SQLite/data-access contention creates a non-linear scaling curve.
- "More workers" is not always better here; `4` is currently the practical sweet spot.

## 15) Full-Universe Regime Study Analysis (14 Tickers, March 20, 2026)

Run:
- `npx tsx scripts/wfa-run.ts --regime-study --workers 4`
- Artifact: `data/wfa-regime-study.json` (`generatedAt: 2026-03-20T20:09:38.406Z`)

### Aggregate OOS outcome

| Arm | Sharpe | WFE | MaxDD | OOS PnL | Trades |
|---|---:|---:|---:|---:|---:|
| baseline | 1.511 | 0.706 | 7.63% | $218,700 | 4,877 |
| vrp_005 | 1.511 | 0.706 | 7.63% | $218,700 | 4,877 |
| vrp_010 | 1.511 | 0.706 | 7.63% | $218,700 | 4,877 |
| contango_3 | 0.815 | 0.511 | 18.31% | $145,735 | 2,083 |
| hybrid_c3_v005 | 0.815 | 0.511 | 18.31% | $145,735 | 2,083 |
| contango_6 | 0.632 | 0.435 | 21.49% | $104,226 | 1,435 |
| hybrid_c6_v010 | 0.632 | 0.435 | 21.49% | $104,226 | 1,435 |

### Key findings

1. **Baseline clearly dominates this test.**
   - Best Sharpe (`1.511`), best WFE (`0.706`), and materially lower drawdown than contango-gated variants.
2. **VRP filters are still non-binding at current thresholds.**
   - `vrp_005` / `vrp_010` are exactly identical to baseline in Sharpe, DD, PnL, and trade count.
3. **Contango gates hurt both return and risk in this full-universe sample.**
   - Contrary to the SPY pilot, `contango_3`/`contango_6` reduced trade count heavily but **increased** MaxDD to `18.31%` / `21.49%`.
4. **Hybrid results equal contango-only behavior.**
   - Since VRP was non-binding, hybrids collapse to their matching contango arm.

### Interpretation

- The original fixed contango thresholds (`3%`, `6%`) are likely misaligned for this cross-asset set.
- Gating reduced diversification and left returns more concentrated in fewer periods/tickers, worsening path-level drawdown even with fewer trades.
- This is a strong signal that **hard binary gating** is too blunt; regime should likely be applied through sizing or adaptive thresholds.

### Recommended next experiments (priority order)

1. Replace hard `contangoFilter` with **regime-based sizing** (e.g., 1.0x / 0.6x / 0.3x sizing by contango bucket).
2. Replace fixed VRP thresholds with **rolling percentile gates** (per ticker or pooled cross-sectional percentiles).
3. Add **minimum-trades-per-window guard** in OOS diagnostics to prevent no-trade windows from quietly degrading robustness.
4. Re-run full-universe with the same framework and compare:
   - Sharpe / WFE,
   - MaxDD,
   - trade concentration by ticker and by window.

## 16) Next-Step Implementation Check: Regime-Based Sizing (SPY 3-Window Pilot)

Implemented:
- Added contango-bucket sizing parameters to `SimConfig` and runner/worker evaluators:
  - `contangoSizeLow`, `contangoSizeMid`, `contangoSizeHigh`
  - `contangoSizeMidThreshold`, `contangoSizeHighThreshold`
- Added sizing study arms in `scripts/wfa-run.ts`:
  - `size_c3_c6_balanced`: `0.5 / 1.0 / 1.25` across `<3% / 3-6% / >=6%`
  - `size_c3_c6_conservative`: `0.35 / 0.8 / 1.1` across same buckets

Quick A/B run (March 20, 2026):
- Baseline command:  
  `npx tsx scripts/wfa-run.ts --regime-study --regime-arm baseline --ticker SPY --train 504 --step 504 --workers 4 --regime-out wfa-regime-baseline-3w.json`
- Sizing command:  
  `npx tsx scripts/wfa-run.ts --regime-study --regime-arm size_c3_c6_balanced --ticker SPY --train 504 --step 504 --workers 4 --regime-out wfa-regime-size-balanced-3w.json`

Results:
- Baseline: Sharpe `0.822`, MaxDD `3.83%`, PnL `$31,764`, Trades `357`, WFE `0.704`
- `size_c3_c6_balanced`: Sharpe `0.649`, MaxDD `9.92%`, PnL `$28,220`, Trades `421`, WFE `0.635`

Delta (`size - baseline`):
- Sharpe: `-0.173`
- MaxDD: `+6.09%`
- PnL: `-$3,544`
- Trades: `+64`
- WFE: `-0.069`

Interpretation:
- This first sizing profile increased activity but degraded risk-adjusted returns and drawdown.
- So the concept may still be valid, but these specific multipliers are too aggressive for this sample.

Immediate follow-up to test:
1. Try a **pure de-risking profile** first (e.g. `0.25 / 0.6 / 1.0`) rather than high-regime leverage.
2. Add per-window trade-floor diagnostics to avoid overweighting sparse favorable buckets.

### Follow-up Run: Conservative Sizing Profile

Command:
- `npx tsx scripts/wfa-run.ts --regime-study --regime-arm size_c3_c6_conservative --ticker SPY --train 504 --step 504 --workers 4 --regime-out wfa-regime-size-conservative-3w.json`

Result (`size_c3_c6_conservative`):
- Sharpe `0.618`
- MaxDD `8.67%`
- PnL `$22,905`
- Trades `421`
- WFE `0.628`

Comparison:
- vs baseline: worse Sharpe (`-0.204`), worse DD (`+4.85%`), lower PnL (`-$8,860`)
- vs balanced sizing: slightly lower DD (`-1.24%`) but materially lower PnL (`-$5,316`) and lower Sharpe (`-0.031`)

Decision from this pilot:
- Current contango-sizing profiles (balanced and conservative) are **not competitive** versus baseline in this SPY check.
- Before spending full-universe runtime on this path, prefer either:
  - much stronger de-risking profile (`0.2 / 0.5 / 0.9`), or
  - pivot to percentile-based VRP/contango adaptive thresholds rather than fixed bucket sizing.

### Final Check: Strong De-Risking Profile (`0.2 / 0.5 / 0.9`)

Command:
- `npx tsx scripts/wfa-run.ts --regime-study --regime-arm size_c3_c6_derisk --ticker SPY --train 504 --step 504 --workers 4 --regime-out wfa-regime-size-derisk-3w.json`

Result (`size_c3_c6_derisk`):
- Sharpe `0.572`
- MaxDD `6.83%`
- PnL `$16,738`
- Trades `421`
- WFE `0.621`

Comparison:
- vs baseline: Sharpe `-0.250`, DD `+3.01%`, PnL `-$15,026`
- vs conservative: DD improved (`-1.84%`) but Sharpe and PnL both worsened

Final decision on contango bucket sizing branch:
- Even with aggressive de-risking, this sizing family does **not** beat baseline on the SPY pilot.
- It reduces drawdown relative to other sizing profiles, but not enough to offset return degradation, and still remains worse than baseline DD.
- Recommended pivot: stop iterating fixed contango sizing multipliers and move to percentile/adaptive regime signals (or non-regime structural improvements).

## 17) Adaptive Percentile Pilot (SPY 3-Window): `contango_pct60` vs `vrp_pct60`

Objective:
- Validate whether rolling percentile filters improve robustness versus fixed regime thresholds.

Runs (March 20, 2026):
- `contango_pct60`:  
  `npx tsx scripts/wfa-run.ts --regime-study --regime-arm contango_pct60 --ticker SPY --train 504 --step 504 --workers 4 --regime-out wfa-regime-contango-pct60-3w.json`
- `vrp_pct60`:  
  `npx tsx scripts/wfa-run.ts --regime-study --regime-arm vrp_pct60 --ticker SPY --train 504 --step 504 --workers 4 --regime-out wfa-regime-vrp-pct60-3w.json`

Results:
- Baseline (reference): Sharpe `0.822`, MaxDD `3.83%`, PnL `$31,764`, Trades `357`, WFE `0.704`
- `contango_pct60`: Sharpe `0.470`, MaxDD `6.70%`, PnL `$10,234`, Trades `161`, WFE `0.450`
- `vrp_pct60`: Sharpe `0.570`, MaxDD `5.60%`, PnL `$23,594`, Trades `131`, WFE `0.580`

Comparison notes:
- `vrp_pct60` is materially better than `contango_pct60` (higher Sharpe/WFE, lower DD, higher PnL), but both remain below baseline.
- Both percentile filters sharply reduced trade count (from `357` to `161`/`131`), suggesting the threshold is currently too restrictive for this setup.
- `vrp_pct60` appears to be the better adaptive signal family to continue, while contango percentile gating underperforms.

Decision:
- Keep `vrp`-percentile branch for tuning (next test: relax to `vrp_pct50` and `vrp_pct40`).
- De-prioritize contango percentile gating unless paired with a non-binary mechanism (e.g., soft sizing or blended scoring).

### Threshold Sweep Follow-Up (`vrp_pct50`, `vrp_pct40`)

Runs (March 20, 2026):
- `vrp_pct50`:  
  `npx tsx scripts/wfa-run.ts --regime-study --regime-arm vrp_pct50 --ticker SPY --train 504 --step 504 --workers 4 --regime-out wfa-regime-vrp-pct50-3w.json`
- `vrp_pct40`:  
  `npx tsx scripts/wfa-run.ts --regime-study --regime-arm vrp_pct40 --ticker SPY --train 504 --step 504 --workers 4 --regime-out wfa-regime-vrp-pct40-3w.json`

Results vs baseline:
- Baseline: Sharpe `0.822`, MaxDD `3.83%`, PnL `$31,764`, Trades `357`, WFE `0.704`
- `vrp_pct60`: Sharpe `0.570`, MaxDD `5.60%`, PnL `$23,594`, Trades `131`, WFE `0.580`
- `vrp_pct50`: Sharpe `0.640`, MaxDD `6.10%`, PnL `$28,102`, Trades `202`, WFE `0.640`
- `vrp_pct40`: Sharpe `0.690`, MaxDD `6.30%`, PnL `$21,123`, Trades `244`, WFE `0.680`

Interpretation:
- Relaxing VRP percentile from `60 -> 50 -> 40` improved Sharpe and WFE monotonically.
- However, all tested VRP percentile gates still underperform baseline on both Sharpe and drawdown.
- `vrp_pct50` currently looks like the best compromise in this branch (better PnL than `vrp_pct40` with similar risk profile).

Working decision:
- Keep `vrp_pct50` as the candidate if we continue percentile-based gating.
- Do not promote percentile gating to production candidate yet; baseline remains superior in this SPY pilot.

## 18) Full-Universe Validation: `vrp_pct50`

Run (completed March 20, 2026):
- `npx tsx scripts/wfa-run.ts --regime-study --regime-arm vrp_pct50 --workers 4 --regime-out wfa-regime-vrp-pct50-full.json`
- Runtime: `1982.4s` (~33.0 minutes)
- Artifact: `data/wfa-regime-vrp-pct50-full.json`

Full-universe OOS result:
- `vrp_pct50`: Sharpe `1.04`, WFE `0.63`, MaxDD `22.0%`, PnL `$202,601`, Trades `3,142`

Reference baseline from section 15:
- Baseline: Sharpe `1.511`, WFE `0.706`, MaxDD `7.63%`, PnL `$218,700`, Trades `4,877`

Conclusion:
- `vrp_pct50` remains inferior to baseline on risk-adjusted return and drawdown in full-universe validation.
- Adaptive VRP percentile gating improves over stricter percentile variants, but does not beat the no-regime baseline in current form.
