# Short-Term WFA Engine Rebuild Plan

## Goal Description
Rebuild the WFA analysis engine for short-term trading (7-21 DTE) by integrating the v3 4H orchestrator into the unified framework (`wfa-run-unified.ts`) and addressing the high-priority issues identified in Codex's audit (`wfa-audit-report-codex.md` and `wfa-audit-report-codex-standalone.md`). 

The "v3 preset bug" where only the `full` preset worked has already been resolved in code by directly precomputing signals per preset in `intraday-signals.ts`.

## Proposed Changes

### 1. Unify the Orchestrator
Extract the loose 4H logic currently inside `scripts/wfa-run-short.ts` into a standard pipeline.

#### [NEW] `scripts/wfa-pipeline-short.ts`
- Extract the 4H orchestration pipeline akin to `wfa-pipeline-swing.ts`.
- Expose `runShortPipeline()` which configures the v3 4H evaluator and runs it.
- Integrate the newly verified `periodMultiplier = [1.5, 2.0, 2.5]` sweep natively.
- Enforce the 15-name universe as the default for short-term runs.

#### [MODIFY] `scripts/wfa-run-unified.ts`
- Expand `--profile short` support to route to `runShortPipeline()`.
- Ensure it properly parses Short-specific options (e.g. keeping `--holdout` mapping, correctly passing 4H specific arguments).

#### [MODIFY] `scripts/wfa-v3-short-worker.ts`
- Update imports and payload shapes to match `wfa-pipeline-short.ts` extraction.

### 2. Tame Drawdown and Cadence
The highest priority outstanding issue from the audit is that the short-term 15-name basket fires too often (5.8 trades/week) and has high drawdowns (34.1%).
- Add `dirConfTier` (e.g., `['any', 'high']`) to the candidate sweep dimensions for the Short profile, just like Swing. This single gate was responsible for a 50% DD reduction in the Swing strategy.
- Ensure `creditStopLossMultiple` or tightened `creditDeltaStop` logic can be configured to contain right-tail risk.

### 3. Cleanup Reporting
#### [MODIFY] `src/lib/backtest/wfa-options.ts`
- **Fix WFE Reporting**: Modify `wfEfficiency` (WFE) so it handles train Sharpe near zero or negative. If `bestTrainSharpe < 0.1`, return `0` or cap it to prevent exploding artifact numbers like `WFE = 95.90`.

## Verification Plan

### Automated Tests
- Run `npx vitest run tests/wfa-options.test.ts tests/wfa-v3.test.ts` to ensure core WFA metrics and intraday logic aren't broken.
- Verify typescript builds with `npm run build`.

### Manual Smoke Test
- Execute a fast smoke test through the unified runner:
  ```bash
  npx tsx scripts/wfa-run-unified.ts --profile short --ticker SPY --smoke
  ```
- Validate that it correctly fires 4H signals and prints rational WFE.

### Full Targeted Holdout Experiment
- Execute the full validation run on the 15-name universe with strict constraints to verify cadence drops to the target 2-4 trades/week:
  ```bash
  npx tsx scripts/wfa-run-unified.ts --profile short --tickers SPY,QQQ,AMD,IWM,TSLA,AAPL,JPM,NVDA,AMZN,MSFT,META,NFLX,GOOG,GS,COST --fill bidask --workers 8 --experiment <target_experiment.json>
  ```
