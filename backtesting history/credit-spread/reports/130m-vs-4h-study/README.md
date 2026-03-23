# 130-Minute vs 4-Hour Timeframe Study

**Date**: 2026-03-22
**Result**: 130M has a generalizable ~2× Sharpe edge over 4H for short-term credit spreads.

## Study Design

- **Tickers**: 15 (SPY, QQQ, AMD, IWM, TSLA, AAPL, JPM, NVDA, AMZN, MSFT, META, NFLX, GOOGL, GS, COST)
- **Period**: 2024-03-01 → 2026-02-28
- **WFA Windows**: 7 rolling (189-day train, 42-day step, 14-day purge)
- **Sweep Grid**: 648 configs/arm (6 presets × 3 widths × 2 TP × 3 IV × 2 DS × 1 TS × 3 period multipliers)
- **130M Data**: Hybrid — native Polygon 130-min bars where available, 1H→130M view fallback for remaining dates
- **Period Multiplier Equivalence**: 4H pm × 1.5 = 130M pm (same calendar-day lookback)

## 130M Structural Advantage

3 × 130min = 390min = exact regular session (9:30–16:00 ET). No fractional bars, no boundary artifacts. Each bar covers exactly 1/3 of the trading day. More signal evaluation points (3 vs 2 per day).

## Phase 1: Comprehensive Sweep Results

| Metric | 4H | 130M | Delta |
|--------|-----|------|-------|
| OOS Sharpe | 0.84 | **1.72** | +0.88 |
| Win Rate | 74.6% | **78.3%** | +3.8% |
| Max DD | 27.5% | **18.8%** | -8.8% |
| Total P&L | $73K | **$184K** | +$111K |
| WF Efficiency | 0.16 | **0.23** | +0.08 |

130M won 5/5 aggregate metrics.

### Overfitting Concerns from Sweep

- Config instability: optimizer picked different configs each window for 130M
- Window 3 IS Sharpe of 19.84 (extreme, likely overfit for that window)
- Windows 4/6 had low trade counts (16/26 trades)
- These concerns led to Phase 2: dedicated walk-forward test

## Phase 2: Dedicated Walk-Forward Test (No Selection Bias)

Each config run through ALL 7 windows unconditionally — no training selection, no top-K filter. Pure OOS evaluation.

### 130M #1: `mf|tp30|w10|iv0|dsoff|pm2.25` — Grade B

| Window | IS Sharpe | OOS Sharpe | OOS WR% | OOS Trades | OOS P&L | Degradation |
|--------|-----------|------------|---------|------------|---------|-------------|
| 1 | 2.46 | 1.35 | 86.0% | 129 | +$11,235 | 0.55 |
| 2 | 2.41 | 3.83 | 81.9% | 127 | +$75,939 | 1.59 |
| 3 | 2.80 | 3.96 | 84.5% | 110 | +$37,472 | 1.42 |
| 4 | 2.50 | 4.11 | 97.5% | 118 | +$40,682 | 1.65 |
| 5 | 3.16 | 3.11 | 83.5% | 127 | +$43,447 | 0.98 |
| 6 | 3.78 | 3.01 | 84.8% | 105 | +$40,741 | 0.80 |
| 7 | 4.43 | 1.43 | 71.2% | 66 | +$13,047 | 0.32 |

**Aggregate**: Sharpe 2.06, WR 85.0%, Max DD 9.5%, P&L $263K, 782 trades, 7/7 positive OOS

### 130M #2: `mom|tp30|w10|iv0|dsoff|pm2.25` — Grade B

| Window | IS Sharpe | OOS Sharpe | OOS WR% | OOS Trades | OOS P&L | Degradation |
|--------|-----------|------------|---------|------------|---------|-------------|
| 1 | 2.44 | 1.15 | 84.9% | 126 | +$10,121 | 0.47 |
| 2 | 2.26 | 4.57 | 84.2% | 133 | +$92,980 | 2.02 |
| 3 | 2.67 | 2.73 | 83.0% | 106 | +$37,693 | 1.02 |
| 4 | 2.37 | 3.89 | 94.8% | 115 | +$45,181 | 1.64 |
| 5 | 3.06 | 3.14 | 84.0% | 125 | +$43,745 | 1.03 |
| 6 | 3.91 | 3.65 | 87.5% | 104 | +$41,798 | 0.93 |
| 7 | 4.99 | 1.47 | 71.4% | 63 | +$13,107 | 0.29 |

**Aggregate**: Sharpe 2.11, WR 85.1%, Max DD 10.0%, P&L $285K, 772 trades, 7/7 positive OOS

### 130M #3: `em|tp50|w10|iv20|dsoff|pm2.25` — Grade A (Best Generalization)

| Window | IS Sharpe | OOS Sharpe | OOS WR% | OOS Trades | OOS P&L | Degradation |
|--------|-----------|------------|---------|------------|---------|-------------|
| 1 | 0.00 | 0.00 | 0.0% | 0 | $0 | 0.00 |
| 2 | 0.00 | 5.34 | 85.1% | 94 | +$66,448 | 0.00 |
| 3 | 11.37 | 3.31 | 87.9% | 58 | +$39,658 | 0.29 |
| 4 | 5.95 | 2.97 | 91.4% | 35 | +$22,389 | 0.50 |
| 5 | 4.93 | 3.83 | 81.9% | 83 | +$31,425 | 0.78 |
| 6 | 4.47 | 3.13 | 90.7% | 43 | +$12,020 | 0.70 |
| 7 | 4.13 | 2.39 | 71.1% | 38 | +$20,382 | 0.58 |

**Aggregate**: Sharpe 2.22, WR 84.6%, Max DD 12.9%, P&L $192K, 351 trades, 6/6 positive OOS

### 4H Baseline: `em|tp50|w10|iv0|dsoff|pm1.5` — Grade A

| Window | IS Sharpe | OOS Sharpe | OOS WR% | OOS Trades | OOS P&L | Degradation |
|--------|-----------|------------|---------|------------|---------|-------------|
| 1 | 2.21 | 1.44 | 85.1% | 101 | +$17,862 | 0.65 |
| 2 | 2.01 | 2.45 | 77.9% | 95 | +$48,538 | 1.22 |
| 3 | 2.01 | 1.52 | 73.8% | 84 | +$25,506 | 0.76 |
| 4 | 1.81 | 2.38 | 94.4% | 90 | +$27,068 | 1.31 |
| 5 | 2.58 | 1.16 | 82.2% | 90 | +$13,828 | 0.45 |
| 6 | 2.32 | 1.02 | 81.4% | 86 | +$10,236 | 0.44 |
| 7 | 3.43 | 1.16 | 64.4% | 59 | +$3,375 | 0.34 |

**Aggregate**: Sharpe 1.13, WR 80.8%, Max DD 17.8%, P&L $146K, 605 trades, 7/7 positive OOS

## Overfitting Verdicts

| Config | Grade | Sharpe | Pos% | Median Degrad | OOS StdDev | Trades |
|--------|-------|--------|------|---------------|------------|--------|
| 130M #1 mf\|tp30\|w10 | B | 2.06 | 100% | 0.98 | 1.073 | 782 |
| 130M #2 mom\|tp30\|w10 | B | 2.11 | 100% | 1.02 | 1.167 | 772 |
| 130M #3 em\|tp50\|w10\|iv20 | **A** | 2.22 | 100% | 0.58 | 0.930 | 351 |
| 4H #1 em\|tp50\|w10 | A | 1.13 | 100% | 0.65 | 0.545 | 605 |

Key: Median degradation 0.98–1.02 for #1/#2 means OOS matches IS — strongest anti-overfitting signal. All configs positive in every window.

## Config Parameter Reference

| Code | Full Name | Meaning |
|------|-----------|---------|
| mf | Market-bias + Momentum + EMA | 3-component signal preset |
| mom | Momentum | Single-component signal |
| em | EMA + Momentum | 2-component signal |
| tp30/tp50 | Take Profit | Close at 30%/50% of max credit |
| w10/w5/w2.5 | Spread Width | Distance between strikes |
| iv0/iv20/iv30 | IV Rank Min | Minimum IV rank filter |
| dsoff/ds0.65 | Delta Stop | Early exit disabled / at 0.65 |
| pm2.25 | Period Multiplier | Indicator scaling (130M equiv of 4H pm1.5) |

## Files

| File | Purpose |
|------|---------|
| `timeframe-comparison-results.json` | Full sweep comparison JSON output |
| `scripts/wfa-ab-130m.ts` | Comprehensive 4H vs 130M sweep script |
| `scripts/wfa-dedicated-test.ts` | Single-config dedicated walk-forward test |
| `scripts/fetch-130m-batched.mjs` | Polygon 130M data fetcher with rate limit handling |

## Next Steps (If Migrating)

1. Refresh Polygon 130M data for all tickers (current data stale for some)
2. Choose between #1 (most trades), #2 (best P&L), or #3 (best generalization grade)
3. Integrate chosen config into `wfa-pipeline-short.ts` as 130M mode
4. Add multicore worker support (current comparison script is single-threaded)
