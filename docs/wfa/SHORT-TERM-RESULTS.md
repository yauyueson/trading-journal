# Short-Term WFA Analysis Results

**Strategy:** Short-DTE Credit Spreads (7-21 DTE) with 4H intraday monitoring
**Date:** 2026-03-22
**Status:** PRODUCTION LOCKED

## Final Locked Configuration

| Parameter | Value |
|-----------|-------|
| Signal Preset | `vol` |
| Credit Short Delta | `0.35` |
| Spread Width | `$5` |
| Profit Target | `30%` |
| Time Stop | `1 DTE` |
| Delta Stop | Off |
| IV Rank Minimum | `0` (disabled) |
| ADX Gate | Disabled |
| Dir Confidence | `any` (no gate) |
| Period Multiplier | `1.5` |
| Max Positions | `5` |
| Max Per Ticker | `2` |
| Fill Mode | `bidask` |

**Performance (Exp3 — production config):** SR 2.44, WR 85.4%, Max DD 17.7%, $352K PnL, 494 trades, 8.2 trades/week

## Infrastructure

- **Pipeline:** `scripts/wfa-pipeline-short.ts` — unified 4H pipeline
- **Entry:** `scripts/wfa-run-unified.ts --profile short`
- **Worker:** `scripts/wfa-v3-short-worker.ts` — parallel trial evaluation
- **Monitor:** `src/lib/backtest/intraday-monitor.ts` — BSM 4H repricing with daily calibration
- **Signals:** `src/lib/backtest/intraday-signals.ts` — 4H tech score with period multiplier scaling
- **Data:** `data/intraday-candles.sqlite` — 4H candle cache (Polygon)

## Experiment Timeline

### Experiment 1: Grid Sweep (384 configs)

**Date:** 2026-03-22
**Grid:** 2 presets × 2 TPs × 2 widths × 1 IV × 2 deltaStops × 2 timeStops × 2 dirConfTiers × 2 deltas × 3 periodMults = 384
**Fill:** bidask | **Tickers:** 15 | **Windows:** 8 rolling (189d train / 42d step / 14d purge)

| Metric | Result |
|--------|--------|
| Sharpe | 2.80 |
| Win Rate | 84.0% |
| Max DD | 13.2% |
| PnL | $528,441 |
| Trades | 877 |
| Trades/Week | 14.6 |
| WFE | 0.75 |

**Key finding: Unanimous config convergence.** The optimizer selected the exact same config in ALL 8 windows:
`vol/d0.35/tp30/w5/iv0/dsOff/pm1.5/dcAny/ts1`

Per-window OOS Sharpe: 4.50, 4.61, 3.63, 4.13, 1.02, 2.81, 6.33, 3.78 (all positive).

This is the strongest convergence signal observed in any WFA experiment — stronger even than the swing strategy which also converged but across fewer dimensions.

### Experiment 2: Fixed Config Sensitivity Isolation (5 configs)

**Date:** 2026-03-22
**Purpose:** Bypass WFA optimizer bias by directly testing parameter impacts on the locked baseline.

| Config | Change vs Baseline | Sharpe | WR | Max DD | PnL | Trades | Trd/Wk | WFE |
|--------|-------------------|--------|-----|--------|------|--------|--------|-----|
| **Baseline** | *(grid winner)* | **3.30** | 85.7% | **8.4%** | $536K | 949 | 15.8 | 0.82 |
| **Cadence** | dirConfTier=high | 3.24 | 85.5% | 8.7% | $516K | 937 | 15.6 | 0.83 |
| **Gamma** | timeStop=3 DTE | 3.06 | 82.0% | 13.1% | $514K | 1003 | 16.6 | 0.82 |
| **Width** | $10 width | 2.55 | 88.4% | 10.3% | $507K | 974 | 16.1 | 0.73 |
| **Smoothing** | periodMult=2.5 | 2.52 | 85.2% | 12.7% | $393K | 943 | 15.7 | 0.61 |

**Fixed config (SR 3.30) beat adaptive sweep (SR 2.80)** — confirming the swing strategy finding that fixed configs outperform per-window optimization.

#### Sensitivity Verdicts

1. **`dirConfTier=high` — REJECTED (no-op)**
   - Only 12 fewer trades (949 → 937). Unlike swing where it cut 40%, the 4H signals are already high-confidence.
   - Not the right lever for short-term cadence control.

2. **`ts3` gamma protection — REJECTED (harmful)**
   - SR drops 7%, DD increases 56% (8.4% → 13.1%). Early exit locks in losses before theta decay completes.
   - For 7-21 DTE spreads, holding to 1 DTE is correct — gamma risk is offset by premium capture.

3. **`$10` width — VIABLE but inferior**
   - Best WR (88.4%) but SR drops 23%. $5 width is structurally superior for short-DTE.

4. **`pm2.5` smoothing — REJECTED**
   - Loses 24% Sharpe and 26% PnL. Fast indicators (pm1.5) capture genuine short-term momentum.

5. **Cadence is structural (~16/week) across ALL variants**
   - No single parameter change reduces it. It's inherent to 15 tickers × 4H signals.

### Experiment 3: Capacity Cap

**Date:** 2026-03-22
**Purpose:** Mechanically throttle cadence via portfolio constraints.

| Constraint | Sharpe | WR | Max DD | PnL | Trades | Trd/Wk | WFE |
|-----------|--------|-----|--------|------|--------|--------|-----|
| maxPos=10, maxTkr=5 (Exp2 baseline) | 3.30 | 85.7% | 8.4% | $536K | 949 | 15.8 | 0.82 |
| **maxPos=5, maxTkr=2 (Exp3 cap)** | **2.44** | **85.4%** | **17.7%** | **$352K** | **494** | **8.2** | **0.61** |

Per-window OOS Sharpe: 2.50, 1.96, 4.91, 4.24, 2.81, 4.13, 3.38, 3.49 (all positive).

**Cadence cut nearly in half** (15.8 → 8.2 trades/week). SR remains well above 2.0 threshold.

**Trade-off:** Max DD increased from 8.4% → 17.7% due to portfolio concentration (fewer positions = each loss hits harder). Per-trade quality improved: PnL dropped 34% while trades dropped 48%.

## Key Findings

### What Works
- **`vol` preset with `pm1.5`** — fastest period multiplier captures genuine short-term momentum
- **$5 width** — optimal for short-DTE; narrower spreads have tighter bid-ask percentages
- **`tp30` (30% profit target)** — takes profits early, consistent with short holding period
- **`ts1` (1 DTE time stop)** — lets theta run to completion; early exit destroys value
- **No IV rank filter** — over-filtering kills opportunity set
- **No dirConfidence gate** — 4H signals are already inherently selective
- **Capacity cap (maxPos=5, maxTkr=2)** — the correct lever for cadence control

### What Doesn't Work (for Short-DTE)
- **`dirConfTier=high`** — barely filters anything (12 fewer trades out of 949)
- **`ts3` gamma protection** — increases DD by 56% and reduces SR by 7%
- **Slower period multipliers (pm2.0, pm2.5)** — 24% Sharpe degradation
- **$10 width** — 23% Sharpe penalty vs $5
- **ADX gate** — unnecessary noise filter for 4H signals
- **Adaptive per-window optimization** — overfits to IS volume, underperforms fixed config

### Short-Term vs Swing Comparison

| Metric | Swing (locked) | Short-Term (locked) |
|--------|---------------|-------------------|
| Sharpe | 1.14 | 2.44 |
| Win Rate | 91.1% | 85.4% |
| Max DD | 5.0% | 17.7% |
| PnL ($100K capital) | $71,896 | $352,371 |
| Trades (total) | 474 | 494 |
| Trades/Week | ~1.5 | 8.2 |
| DTE Range | 45-65 | 7-21 |
| Width | $20 | $5 |
| Time Stop | 3 DTE | 1 DTE |
| Profit Target | 40% | 30% |
| dirConfTier | high | any |
| Evaluation Period | 6 years | 2 years |
| Monitoring | Daily chain | 4H BSM + daily calibration |

The short-term strategy has higher raw returns (SR 2.44 vs 1.14) but higher risk (DD 17.7% vs 5.0%). The swing strategy is more conservative with a longer track record (6 years vs 2 years).

## Reproduce

```bash
# Experiment 1: Grid sweep
npx tsx scripts/wfa-run-unified.ts --profile short --tickers SPY,QQQ,AMD,IWM,TSLA,AAPL,JPM,NVDA,AMZN,MSFT,META,NFLX,GOOG,GS,COST --fill bidask --workers 8 --experiment experiments/short-cadence-control.json

# Experiment 2: Fixed config isolation (5 runs)
npx tsx scripts/wfa-run-unified.ts --profile short --tickers SPY,QQQ,AMD,IWM,TSLA,AAPL,JPM,NVDA,AMZN,MSFT,META,NFLX,GOOG,GS,COST --fill bidask --workers 4 --experiment experiments/exp2-baseline.json --out exp2-baseline.json
# ... repeat for exp2-cadence, exp2-gamma, exp2-width, exp2-smoothing

# Experiment 3: Capacity cap (PRODUCTION CONFIG)
npx tsx scripts/wfa-run-unified.ts --profile short --tickers SPY,QQQ,AMD,IWM,TSLA,AAPL,JPM,NVDA,AMZN,MSFT,META,NFLX,GOOG,GS,COST --fill bidask --workers 4 --max-pos 5 --max-ticker 2 --experiment experiments/exp3-capacity-cap.json --out exp3-capacity-cap.json
```

## Result Files

- `data/runs/2026-03-22T01-59-56-140-unified-short.json` — Exp1 grid sweep
- `data/runs/exp2-baseline.json` — Exp2 baseline
- `data/runs/exp2-cadence.json` — Exp2 dirConfTier=high
- `data/runs/exp2-gamma.json` — Exp2 ts3
- `data/runs/exp2-width.json` — Exp2 $10 width
- `data/runs/exp2-smoothing.json` — Exp2 pm2.5
- `data/runs/exp3-capacity-cap.json` — Exp3 capacity cap (production)
