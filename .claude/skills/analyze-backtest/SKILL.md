---
name: analyze-backtest
description: Analyze optimizer/backtest JSON export and provide structured diagnosis with actionable parameter recommendations
user_invocable: true
---

# Backtest Analysis Protocol

When the user invokes `/analyze-backtest`, they will paste a JSON export from the backtester. Follow this exact analysis framework every time. Be direct, specific, and actionable.

## Step 0: Parse and Validate

Read the JSON. Identify the mode (`validate`, `optimize`, or `walkforward`). If the JSON is missing or malformed, ask the user to re-export.

## Step 1: Health Check (always show first)

Present a quick-glance summary table:

| Metric | Value | Verdict |
|--------|-------|---------|
| Grade | A/B/C/F | - |
| Total Trades | N | Need 30+ for statistical significance |
| Win Rate (theta-adj) | X% | Target: >50% |
| Profit Factor | X.XX | Target: >1.3 |
| Sharpe | X.XX | Target: >0.8 |
| Sortino | X.XX | Target: >1.0 |
| Max Drawdown | X% | Target: <25% |
| Avg Hold Days | X | - |
| WF Efficiency | X% | Target: >40% (optimize mode only) |

Verdict: one sentence — "Strategy is viable / marginal / not viable because..."

## Step 2: Signal Quality Breakdown

### By Direction
- CALL count, win rate, avg return
- PUT count, win rate, avg return
- Flag if one direction has <40% WR or <5 trades
- Recommendation: disable weak direction or adjust min confidence per direction

### By Setup
For each setup (Perfect Storm, Breakout, Directional, etc.):
- Count, win rate, avg return
- Flag setups with WR < 40% or negative avg return
- Recommendation: exclude losing setups via setupGroups filter

### By Tier
- S/A/B tier breakdown
- Flag if B-tier has significantly worse WR than S-tier (expected) but also if S-tier has too few trades

## Step 3: Exit Analysis

Calculate exit distribution:
- TP hits: X% of exits
- SL hits: X% of exits
- Time stops: X% of exits
- Score stops: X% of exits

Diagnose:
- **High SL% (>40%)**: Entry quality is poor or SL too tight. Recommend: loosen SL or raise minScore
- **High time stops (>30%)**: Trades aren't reaching TP/SL. Recommend: tighten TP or increase maxHoldDays
- **High score stops (>25%)**: Score threshold may be too aggressive. Recommend: lower scoreStopThreshold or disable
- **Low TP% (<30%)**: TP may be too ambitious. Recommend: tighten TP

## Step 4: Efficiency Analysis (MFE/MAE)

If MFE/MAE data available:
- Compare avg MFE to avg captured return → how much profit is left on table
- Compare avg MAE to SL level → is SL getting hit at the extremes or mid-range
- "Avg trade reaches +X% before settling at +Y%" — quantify the gap

Recommendations:
- If MFE >> captured return: TP is too loose, tighten it
- If MAE is close to SL: SL is well-calibrated
- If MAE << SL: SL could be tighter to reduce unnecessary risk

## Step 5: Weight & Parameter Analysis (optimize mode)

### Weight Distribution
Look at best config weights (w_mb, w_bxs, w_bxl, w_ema, w_mom):
- Any weight at 0? → that indicator adds no value, consider removing
- Any weight >50? → over-reliance on single indicator
- Compare top 5 configs — do they converge on similar weights?

### Period Analysis
If periods were optimized:
- Flag any unusual values (e.g., sc_mb_len=5 is too short, >50 is too long)
- Check if top configs converge or diverge on periods

### GA Convergence
If generationHistory available:
- Did bestFitness plateau? At which generation?
- Is avgFitness converging toward bestFitness? (good = population converging)
- If no convergence by final gen: recommend more generations or larger population
- If converged too early (gen 3-4): population may be too small or search space too narrow

## Step 6: Overfitting Check (optimize mode)

Compare IS vs OOS metrics:
- IS Sharpe vs OOS Sharpe → WF Efficiency
- IS WR vs OOS WR → should be within 10pp
- IS PF vs OOS PF → OOS should be >60% of IS

Flag overfitting signals:
- WF Efficiency < 30%: severe overfitting
- OOS WR drops >15pp from IS: curve-fitted
- IS Sharpe > 2.0 but OOS < 0.5: too good to be true

Recommendations:
- More tickers in multi-ticker GA
- Fewer optimized parameters (disable periods/decay)
- Longer data range
- Increase OOS split %

## Step 7: Walk-Forward Window Analysis (walkforward mode)

For each window:
- IS fitness vs OOS performance
- Flag windows where OOS Sharpe < 0 (strategy failed in that period)
- Look for regime sensitivity (did it fail in specific market conditions?)

Cross-window consistency:
- Do different windows find similar optimal configs? (good = robust)
- Do different windows find wildly different configs? (bad = regime-dependent)

## Step 8: Actionable Recommendations

Always end with a numbered list of specific changes. Format:

### Recommended Changes (priority order)

1. **[HIGH]** Change X from Y to Z — reason
2. **[MEDIUM]** Change X from Y to Z — reason
3. **[LOW]** Change X from Y to Z — reason

Each recommendation must specify:
- The exact parameter name
- Current value
- Recommended new value or range
- Why

Example:
> 1. **[HIGH]** Raise `premiumSL` from 0.50 to 0.65 — 42% of exits are SL, avg MAE is only -38%, current SL is too tight
> 2. **[MEDIUM]** Disable PUT signals — 12 PUT trades with 25% WR vs 48 CALL trades with 58% WR
> 3. **[LOW]** Lower `scoreStopThreshold` from 55 to 45 — score stops are 28% of exits, removing profitable trades early

## Rules

- Never say "it depends" without following up with a specific recommendation
- Always reference actual numbers from the JSON, not vague statements
- If trade count is <20, explicitly warn that all conclusions are low-confidence
- If data looks like it might be from a single ticker, recommend multi-ticker validation
- Compare to benchmarks: buy-and-hold SPY does ~10% annually, Sharpe ~0.5
- Do not recommend changes that would increase overfitting (e.g., "add more GA genes")
- Keep the entire analysis under 800 words — be dense, not verbose
