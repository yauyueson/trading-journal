---
name: wfa-study
description: Set up, run, and document a Walk-Forward Analysis study phase. Encodes the validated 8-phase methodology from the DTE5 TP/SL study (198 configs). Use when designing new WFA experiments.
user-invocable: true
allowed-tools: Bash Read Grep Edit Write
---

# WFA Study Protocol

When invoked via `/wfa-study`, guide the user through setting up and documenting a new WFA study phase. This encodes the methodology validated across 8 phases and 198 configs.

## Study Infrastructure

**Core files:**
- `scripts/wfa-dte5-tp-sl-study.ts` — orchestrator (CLI: `npx tsx scripts/wfa-dte5-tp-sl-study.ts --phase N`)
- `scripts/wfa-dte5-tp-sl-worker.ts` — worker thread (supports per-signal delta, all exit mechanisms, override signals)
- Results folder: `backtesting history/credit-spread/reports/dte5-tp-sl-study/`

**WFA Parameters (validated):**
- Window: 252d train / 126d test / 10d purge
- Mode: rolling (not expanding)
- Windows: 15 total (13 selection + 2 holdout)
- Capital: $10,000 simulation, 10% risk/trade, 50-contract cap

## Phase Design Checklist

When user says `/wfa-study <description>`, walk through:

### 1. Define the hypothesis
What are we testing? Frame as: "H_N: [claim] — expected to [improve/degrade] [metric]"

### 2. Design the config matrix
| Config Label | What Varies | Base (unchanged) |
|-------------|-------------|-----------------|
| ... | ... | champion exit: SL 2.5x + TL 50/50 |

Typical dimensions to sweep:
- Entry gates (EMA periods, stacks, regime filters)
- Exit mechanisms (TP %, SL multiple, trailing lock %, time stop)
- Tickers (QQQ, SPY, IWM)
- Direction (bull, bear)
- Delta pairs (sp30/20, sp25/15, sp40/30)
- Spread width ($5, $10, $15)

### 3. Estimate config count
`[gate variants] × [tickers] × [exits] × [directions] = total configs`

Always pair each config with a baseline (nc-only, no SL/TL) for comparison.

### 4. Implementation approach
- If < 20 configs: sequential pools OK
- If 20-50 configs: single persistent worker pool with `overrideSignals`
- If > 50 configs: persistent pool mandatory (SQLite SIGSEGV after ~20 pool create/destroy cycles — learned the hard way in Phase 8)

### 5. Run the study
```bash
npx tsx scripts/wfa-dte5-tp-sl-study.ts --phase N [--ticker QQQ] [--direction bull]
```

## Results Documentation (MANDATORY)

After the study completes, results MUST go in the dedicated folder. User had to remind Claude about this — never leave results ephemeral.

**Where:** `backtesting history/credit-spread/reports/dte5-tp-sl-study/`

**Files to create:**
1. `phaseN-results.json` — raw results
2. Update `README.md` — add phase to summary table

### Results Table Format (user asked for this format 5 times)

Always include ALL of these columns:

```
| # | Config | OOS Sharpe | Holdout | WR% | MaxDD | Trades | PnL | $10K→ | CAGR | Grade |
```

- `$10K→` = portfolio growth from $10K initial (compound, not flat)
- `Grade` = A (Sharpe>1.5), B (>1.0), C (>0.5), D (>0), F (<0)
- Sort by OOS Sharpe descending

### Hypothesis Assessment

For each hypothesis tested, add to the README:

```
| # | Hypothesis | Status | Evidence |
|---|-----------|--------|----------|
| H_N | [claim] | CONFIRMED/REJECTED | [specific numbers] |
```

## Known Pitfalls (from 8 phases of experience)

1. **NO_CHAIN fix must persist**: `missingChainExitAfterDays: 999` — suppresses premature exits from sparse chain data. Worth +0.56 Sharpe.
2. **Conservative SL pricing**: SL exits must use actual market spread cost, not the threshold. Gamma can gap past SL at DTE 2-7.
3. **ORATS hv30d is always NULL**: Use `hv20d` for VRP computation (IV30² - HV20²).
4. **Worker pool SIGSEGV**: Never create/destroy >20 worker pools in one run. Use persistent pool with `overrideSignals` per work item.
5. **Bear configs at DTE5 don't work**: All 24 bear combos tested got Grade D or F. Don't waste time retesting unless market regime fundamentally shifts.
6. **Stack filters reduce trades without improving Sharpe**: EMA stacks (8>21>34>55) are more restrictive but no better than single EMA gates.

## When NOT to use this skill

- Simple parameter changes (just edit strategyProfiles.ts)
- UI/frontend changes (use deploy-check instead)
- Strategy consistency checks (use strategy-audit instead)
