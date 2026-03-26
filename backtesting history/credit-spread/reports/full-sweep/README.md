# Short-Term Credit Spread — Full Config Sweep & SL Combo Study

Generated: 2026-03-24

## Executive Summary

Comprehensive parameter sweep of 2,916 configs across 7 dimensions, followed by a 145-variant SL combo study on the top 5 winners. Uses **EOD ORATS chain-based monitoring** (not BSM theoretical pricing) for accurate PnL. Data spans 2020-01-01 to 2026-02-28 with 33 rolling WFA windows.

**Best config**: `mf|tp50|w2.5|d45|pm3 + tl50-50`
- OOS Sharpe 2.99, Holdout 0.25, WR 86.4%, MaxDD 1.4%, PnL $85.6K (6yr, $100K start)
- WFE 0.78, Grade B, 2,612 trades (~8.1/week), ~$33/trade avg

**Key finding**: Trailing lock `tl50-50` consistently improves all 5 top base configs by 17-26% OOS Sharpe.

**Critical concern**: Holdout Sharpe ranges 0.07-0.25 across all top configs — weak out-of-sample generalizability.

---

## 1. Background & Motivation

The previous short-term strategy (`em|tp50|w10|iv20|pm2.25`) was validated ~2 weeks ago with limited 2-year data. Three concerns prompted this study:

1. **Data sufficiency**: Only had 130M candle data from 2024+, too short for robust WFA
2. **Window 0 zero trades**: Signal lookback ate into training window with limited data
3. **SL skepticism**: Prior SL study showed no benefit, but may have been affected by data limitations

### Data Backfill

Discovered Tiingo IEX provides intraday data back to 2017. Backfilled 169,092 1H bars for 14 tickers (2017-01-03 to 2024-03-17) into local SQLite. Combined with existing ORATS chain cache (2017-2026), this provides 6+ years of aligned data.

---

## 2. Critical Bug Discovery: BSM Pricing Inflation

During the sweep, we discovered a **systemic PnL inflation bug** affecting all BSM-based backtests:

### The Problem

When a profit target triggered between 130M monitoring bars (2+ hours apart), the exit used the raw BSM theoretical price instead of the threshold price. BSM can show spread cost near $0.08 when the TP threshold is $1.10 — inflating per-trade PnL by 2-3×.

**Example**: Entry credit $2.22, TP threshold $1.11 (50%), BSM shows $0.088 at next check → PnL recorded as ($2.22 - $0.088) × 100 = $213 instead of ($2.22 - $1.11) × 100 = $111.

### Root Cause

BSM theoretical prices diverge significantly from reality for short-dated, high-gamma options between infrequent monitoring points. The model produces mathematically valid but practically unrealistic prices.

### The Fix: EOD Chain-Based Monitoring

Replaced BSM intraday repricing with **daily EOD ORATS chain lookups**:

- Uses `findContractDirect()` for actual market prices each trading day
- No BSM model, no kappa, no IV theta assumptions
- Threshold-based exit pricing: TP exits use `tpCost`, SL exits use `slCost` (not raw chain price)
- Applied globally to `intraday-monitor.ts`, `option-sim.ts`, and all worker scripts

**Impact**: Avg PnL/trade dropped from ~$100+ (BSM) to ~$33 (chain-based) — the realistic number.

---

## 3. Sweep Methodology

### 3.1 Sweep Dimensions (2,916 configs)

| Dimension | Values | Count |
|-----------|--------|-------|
| Signal preset | ema, mom, em, vol, full, mf | 6 |
| Period multiplier | 2.25, 3.0, 3.75 | 3 |
| Profit target | 30%, 40%, 50% | 3 |
| Spread width | $2.50, $5, $10 | 3 |
| IV rank min | 0, 20, 40 | 3 |
| Short delta | 0.25, 0.35, 0.45 | 3 |
| Time stop DTE | 1, 3 | 2 |

**Total**: 6 × 3 × 3 × 3 × 3 × 3 × 2 = **2,916 configs**

### 3.2 Fixed Parameters

| Parameter | Value | Reason |
|-----------|-------|--------|
| DTE range | [7, 21] | Defines short-term strategy |
| Stop loss | None (defined risk) | SL study confirmed no benefit |
| Delta stop | Off | SL study confirmed no benefit |
| Max positions | 10 | Portfolio diversification |
| Max per ticker | 5 | Concentration limit |
| BSM kappa | 4.0 | N/A (chain-based, not BSM) |
| Risk-free rate | 4% | Standard |
| Fill mode | Bid/ask combo + dynamic slippage | Realistic execution |
| Commission | $0.65 per leg per side | Standard retail |
| Starting capital | $100,000 | Baseline |

### 3.3 WFA Window Configuration

| Parameter | Value |
|-----------|-------|
| Data start | 2019-06-01 (lookback buffer) |
| OOS start | 2020-01-01 |
| OOS end | 2026-02-28 |
| Train window | 189 days (~9 months) |
| Forward step | 42 days (~2 months) |
| Purge gap | 14 days (2-week embargo) |
| Mode | Rolling |
| Selection windows | 31 |
| Holdout windows | 2 (last 2, unseen during selection) |
| Total windows | 33 |

### 3.4 Overfitting Grade Rubric

| Grade | Criteria |
|-------|----------|
| A | 6/6 checks pass |
| B | 5/6 |
| C | 4/6 |
| D | 3/6 |
| F | <3/6 |

**Checks**: IS→OOS retention ≥40%, OOS Sharpe StdDev <1.0, all active windows positive, sufficient trades per window, no extreme IS Sharpe, OOS Sharpe >0.5

### 3.5 Signal Pre-computation

18 signal sets (6 presets × 3 period multipliers) pre-computed before dispatch. Each signal set cached in memory and distributed to worker threads by key.

### 3.6 Infrastructure

- 13 worker threads (M3 Max, 14 cores)
- Workers receive signal sets + config, return aggregated metrics only (no raw trades — prevents OOM)
- Runtime: ~200 minutes for 2,916 configs

---

## 4. Sweep Results

### 4.1 Grade Distribution

| Grade | Count | % |
|-------|-------|---|
| A | 1 | 0.03% |
| B | 93 | 3.2% |
| C | 1,459 | 50.0% |
| D | 215 | 7.4% |
| F | 1,148 | 39.4% |
| **Total** | **2,916** | |

Only 1 Grade A config (`vol|tp30|w5|iv0|d45|ts1|pm2.25`, OOS Sharpe 1.82) — low OOS Sharpe despite perfect checks. 93 Grade B configs provide the viable pool.

### 4.2 Top 10 Configs (by OOS Sharpe)

| Rank | Config | IS Sharpe | OOS Sharpe | Holdout | WFE | WR% | MaxDD | PnL | Trades | Grade |
|------|--------|-----------|------------|---------|-----|-----|-------|-----|--------|-------|
| 1 | vol\|tp50\|w2.5\|iv0\|d45\|ts1\|pm3 | 3.25 | 2.46 | 0.11 | 0.76 | 81.7% | 1.7% | $71.1K | 2,177 | C |
| 2 | full\|tp50\|w2.5\|iv0\|d45\|ts1\|pm3.75 | 3.18 | 2.46 | -0.08 | 0.77 | 81.9% | 1.7% | $76.2K | 2,285 | C |
| 3 | vol\|tp50\|w2.5\|iv0\|d45\|ts1\|pm2.25 | 3.29 | 2.44 | 0.09 | 0.74 | 81.7% | 1.8% | $70.9K | 2,227 | C |
| 4 | mf\|tp50\|w2.5\|iv0\|d45\|ts1\|pm3 | 3.27 | 2.43 | -0.00 | 0.74 | 82.2% | 1.6% | $76.8K | 2,300 | B |
| 5 | full\|tp50\|w2.5\|iv0\|d45\|ts1\|pm3 | 3.19 | 2.42 | 0.03 | 0.76 | 82.2% | 1.6% | $76.0K | 2,303 | B |
| 6 | mf\|tp50\|w2.5\|iv0\|d45\|ts1\|pm3.75 | 3.16 | 2.41 | -0.03 | 0.76 | 81.7% | 1.7% | $74.3K | 2,261 | C |
| 7 | ema\|tp50\|w2.5\|iv0\|d45\|ts1\|pm2.25 | 3.29 | 2.39 | 0.05 | 0.73 | 81.6% | 1.5% | $73.5K | 2,250 | B |
| 8 | full\|tp50\|w2.5\|iv0\|d45\|ts1\|pm2.25 | 3.27 | 2.38 | 0.01 | 0.73 | 82.0% | 1.5% | $75.2K | 2,305 | B |
| 9 | mf\|tp50\|w2.5\|iv0\|d45\|ts1\|pm2.25 | 3.28 | 2.38 | 0.01 | 0.72 | 82.0% | 1.6% | $74.9K | 2,306 | B |
| 10 | mom\|tp50\|w2.5\|iv0\|d45\|ts1\|pm3.75 | 3.10 | 2.35 | 0.02 | 0.76 | 82.1% | 1.8% | $70.2K | 2,196 | C |

### 4.3 Key Observations from Sweep

1. **TP50 + w2.5 + d45 + iv0 dominates**: Every top-10 config shares these parameters
2. **Signal preset barely matters**: vol, full, mf, ema, mom all appear in top 10 with <5% OOS spread
3. **Period multiplier barely matters**: 2.25, 3.0, 3.75 all appear, <3% spread
4. **IV rank filter hurts**: iv0 (no filter) beats iv20 and iv40 — filtering reduces trade count without improving quality
5. **Holdout is universally weak**: -0.08 to +0.11 across top 10 — near zero

### 4.4 Current Production Config

`em|tp50|w2.5|iv20|d45|ts1|pm2.25` → OOS Sharpe 2.15, Grade B — ranked below top 10 due to iv20 filter.

---

## 5. SL Combo Study

### 5.1 Methodology

Tested 29 SL variants on each of 5 top base configs (145 total evaluations):

| Category | Variants |
|----------|----------|
| Trailing Lock (TL) | tl75-25, tl50-50 |
| Max Loss (ML) | ml75, ml90 |
| Delta Stop (DS) | ds70, ds75, ds80 |
| TL + ML combos | tl75-25+ml75, tl75-25+ml90, tl50-50+ml75, tl50-50+ml90 |
| TL + DS combos | tl75-25+ds70/75/80, tl50-50+ds70/75/80 |
| ML + DS combos | ml75+ds70/75/80, ml90+ds70/75/80 |
| Triple combos | tl75-25+ml75+ds70/75/80, tl75-25+ml90+ds70/75/80, tl50-50+ml75+ds70/75/80, tl50-50+ml90+ds70/75/80 |

TL notation: `tl{activate}-{floor}` — activate trailing lock at X% of TP profit, floor at Y% of TP profit.

### 5.2 Best SL Variant per Base Config

| Base Config | Best SL | OOS Sharpe | Δ vs Baseline | Holdout | WR% | PnL |
|-------------|---------|------------|---------------|---------|-----|-----|
| vol\|tp50\|w2.5\|d45\|pm3 | tl50-50 | 2.88 | +17% | 0.23 | 85.9% | $79.0K |
| full\|tp50\|w2.5\|d45\|pm3.75 | tl50-50 | 2.89 | +18% | 0.07 | 85.9% | $84.4K |
| vol\|tp50\|w2.5\|d45\|pm2.25 | tl50-50 | 3.08 | +26% | 0.23 | 86.0% | $80.7K |
| mf\|tp50\|w2.5\|d45\|pm3 | tl50-50 | 2.99 | +23% | 0.25 | 86.4% | $85.6K |
| full\|tp50\|w2.5\|d45\|pm3 | tl50-50 | 3.04 | +26% | 0.15 | 86.5% | $86.5K |

**`tl50-50` wins on every single base config.** No other SL variant comes close.

### 5.3 SL Mechanism Rankings

| Mechanism | Effect on OOS Sharpe | Verdict |
|-----------|---------------------|---------|
| **tl50-50** (trailing lock) | +17-26% improvement | **Strong positive** |
| **tl75-25** (trailing lock) | +5-10% improvement | Mild positive |
| **ml90** (max loss 90%) | -35% degradation | Harmful |
| **ml75** (max loss 75%) | -50% degradation | Very harmful |
| **ds70/75/80** (delta stop) | Negative OOS Sharpe | **Destructive** |
| **Any combo with DS** | Grade F universally | Catastrophic |

### 5.4 Overall Top 5 (Sweep + SL Combined)

| Rank | Config | OOS Sharpe | Holdout | WR% | PnL | Grade |
|------|--------|------------|---------|-----|-----|-------|
| 1 | vol\|tp50\|w2.5\|d45\|pm2.25+tl50-50 | 3.08 | 0.23 | 86.0% | $80.7K | C |
| 2 | full\|tp50\|w2.5\|d45\|pm3+tl50-50 | 3.04 | 0.15 | 86.5% | $86.5K | B |
| 3 | mf\|tp50\|w2.5\|d45\|pm3+tl50-50 | 2.99 | 0.25 | 86.4% | $85.6K | B |
| 4 | full\|tp50\|w2.5\|d45\|pm3.75+tl50-50 | 2.89 | 0.07 | 85.9% | $84.4K | B |
| 5 | vol\|tp50\|w2.5\|d45\|pm3+tl50-50 | 2.88 | 0.23 | 85.9% | $79.0K | C |

### 5.5 Why tl50-50 Works

Trailing lock activates at 50% of TP profit reached, locks in a floor at 50% of TP profit. This:

- Converts ~400 losing trades (expirations/time stops) into small winners via early lock
- Increases trade count by ~13% (more positions enter since existing ones exit faster)
- Improves WR from ~82% → ~86% with minimal MaxDD increase
- **Does NOT replace TP** — TP still handles 1,167-1,282 exits; TL adds 422-449 incremental exits

---

## 6. Concerns & Open Questions

### 6.1 Weak Holdout Performance (Critical)

All top configs show holdout Sharpe of 0.07-0.25 (vs OOS Sharpe of 2.4-3.1). The holdout windows are the last 2 rolling periods (~4 months, roughly Oct 2025 - Feb 2026). This could indicate:

1. **Regime change**: Recent market conditions differ from 2020-2025 training period
2. **Overfitting**: Strategy may be tuned to specific volatility/trend regimes
3. **Sample size**: Only 2 holdout windows — small sample for conclusions

### 6.2 Capital Utilization (Structural)

$2.50 spread width × 10 max positions = $25,000 max risk on $100,000 capital → **only 2.5% utilization** at any time. The $85.6K PnL over 6 years (~$14K/year) on $100K is a **14% annual return** — solid, but the capital efficiency question matters for real deployment.

Options to improve utilization:
- Increase max positions (20-30)
- Allow wider spreads ($5, $10) on high-conviction signals
- Run alongside swing strategy for combined returns

### 6.3 EOD vs Intraday Monitoring

Chain-based monitoring uses EOD prices (one check per day). Short-term spreads (7-21 DTE) can move significantly intraday. The TP/TL triggers may fire at different times with real-time monitoring vs EOD-only. This likely makes the backtest slightly conservative (misses some intraday TP opportunities).

### 6.4 Signal Preset Insensitivity

All 6 signal presets perform nearly identically in top configs. This suggests the edge comes primarily from the **options structure** (delta, width, TP level, time stop) rather than the directional signal. The signal may just be providing "not terrible" entry timing.

---

## 7. Files & Artifacts

| File | Description |
|------|-------------|
| `backtesting history/credit-spread/reports/full-sweep/sweep-results.json` | 2,916 config results (chain-based) |
| `backtesting history/credit-spread/reports/full-sweep/sl-on-sweep-results.json` | 145 SL combo results on top 5 |
| `scripts/wfa-full-sweep.ts` | Main sweep pipeline |
| `scripts/wfa-sweep-worker.ts` | Worker thread (chain-based evaluator) |
| `scripts/wfa-sl-on-sweep.ts` | SL combo study pipeline |
| `scripts/wfa-sl-worker.ts` | SL study worker |
| `scripts/backfill-130m.ts` | Tiingo IEX 10-min → 1H backfill script |
| `scripts/debug-pnl.ts` | PnL debugging tool |
| `data/intraday-candles.sqlite` | 298K rows, 14 tickers, 2017-2026 |

---

## 8. Recommended Next Steps

1. **Gemini feasibility review** — evaluate whether holdout weakness is a dealbreaker or addressable
2. **Capital utilization study** — test max positions 20-30, or variable position sizing
3. **Regime analysis** — characterize the holdout period to understand if weakness is temporary
4. **Live paper trading** — deploy best config for 30-60 days to validate real-world execution
5. **Combined strategy** — evaluate short-term + swing together for portfolio-level returns
