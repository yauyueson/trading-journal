# WFA v2 Comprehensive Analysis Plan

## Purpose

Systematically find the best credit spread configurations for **swing** (45-65 DTE) and **short-term** (7-21 DTE) strategies using walk-forward analysis with deliberate, round parameter grids. All analysis uses real `calculateTechScore` signals (7-component engine) and ORATS chain data (46M rows, zero API calls).

---

## 1. Data & Infrastructure

### 1.1 Data Sources
| Source | Content | Size | Access |
|--------|---------|------|--------|
| SQLite `option-chains.sqlite` | Historical option chains (bid/ask/mid/greeks/OI) | 13 GB, 46M rows | Local, read-only, mmap'd |
| `data/cache/stock-candles.json` | Daily OHLCV for all tickers | ~5 MB | Local cache (fetched from Supabase once) |
| `data/cache/orats-iv.json` | IV30, IV60, HV20, HV30, HV60 per ticker/date | ~8 MB | Local cache (fetched from Supabase once) |

**Cache protocol**: First run downloads from Supabase and caches locally. All subsequent runs load from disk (~200ms). Use `--refresh` flag to re-download.

### 1.2 Ticker Universe (15)
```
SPY  QQQ  AMD  IWM  TSLA  AAPL  JPM  NVDA
AMZN MSFT META NFLX GOOG  GS    COST
```

### 1.3 Date Ranges
| Period | Dates | Purpose |
|--------|-------|---------|
| Data start | 2017-01-01 | Indicator lookback buffer |
| WFA start | 2018-01-01 | First train window starts here |
| WFA end | ~2025-02-28 | Last OOS window ends here |
| Holdout | ~2025-02-28 → 2026-02-28 | 1 year (252 trading days), untouched until final validation |
| Data end | 2026-03-06 | Latest available data |

### 1.4 WFA Window Structure
- **Train window**: 504 trading days (~2 years)
- **OOS step**: 126 trading days (~6 months)
- **Purge gap**: 65 days (>= max DTE, prevents look-ahead)
- **Mode**: Rolling (fixed-width train window slides forward)
- **Expected windows**: ~9 (fewer than v1's 11 due to longer holdout)

### 1.5 Machine & Performance
- **Apple M5 Pro**, 15 cores, 24 GB RAM, ARM64, Node v25.8.1
- **8 worker threads**, each with own read-only SQLite connection
- **SQLite optimizations**: WAL mode, 2GB mmap (unified memory), 64MB page cache per worker
- **Signal generation**: ~10s (single-pass engine, 5 presets derived from sub-scores)
- **Worker optimizations**: binary search for signal date filtering, LRU caches (50 chains / 20K contracts)
- **Runner optimizations**: config dedup cache (skip identical GA individuals), parallel train+OOS dispatch

---

## 2. Signal Presets

The real `calculateTechScore` engine computes 7 directional sub-scores per bar. Each preset zeros out certain components to isolate different indicators:

| Preset | Active Components | Rationale |
|--------|-------------------|-----------|
| `ema` | EMA stack only | v1 baseline signal, cleanest trend follower |
| `mom` | Momentum/ROC only | v1's second signal, pure momentum |
| `em` | EMA + Momentum | Combined directional, v1's best absolute return |
| `full` | All 7 (MB+BXS+BXL+EMA+MOM+ADX+RVOL) | Full scoring engine, never tested in WFA |
| `vol` | RVOL + Momentum | Volume-confirmed moves, new in v2 |

Dropped: `mf` (1/20 in TPE), `adx` (2/20), `mb` (0/20) — insufficient signal.

**Quality gates** (applied to all presets, not swept):
- ADX >= 15 (skip low-trend bars)
- RVOL >= 0.5 (skip low-volume bars)
- Direction must be CALL or PUT (skip NEUTRAL)

---

## 3. Parameter Grid — SWING Profile (45-65 DTE)

### 3.1 Swept Parameters

| Parameter | Values | Count | Spacing | Rationale |
|-----------|--------|-------|---------|-----------|
| `signalWeightPreset` | ema, mom, em, full, vol | 5 | — | v1 baselines + v2 additions |
| `creditShortDelta` | 0.20, 0.25, 0.30, 0.35, 0.40 | 5 | 0.05 | TPE converged 0.22-0.29; extend to 0.40 for ATM |
| `creditSpreadWidth` | $5, $10, $15, $20 | 4 | $5 | v1 best was $15; test narrower and wider |
| `creditProfitTarget` | 30%, 35%, 40%, 45%, 50% | 5 | 5% | v1 best was 30%; explore higher targets |
| `minIVRank` | 0, 10, 20, 30, 40, 50 | 6 | 10 | v1 proved IV>=30 is +58% Sharpe; sweep full range |
| `creditTimeStopDTE` | 5, 7, 10 | 3 | ~3 | When to force-close before expiry |
| `maxPositions` | 5, 10 | 2 | — | Portfolio concentration |
| `maxPerTicker` | 3, 5 | 2 | — | Per-ticker concentration |

### 3.2 Fixed Parameters (NOT swept)

| Parameter | Value | Reason |
|-----------|-------|--------|
| `creditStopLossMultiple` | 100 (None) | v1 Phase 1 proved SL 2x = Sharpe 0.04 |
| `creditDTERange` | [45, 65] | Profile definition |
| `monitoringIntervalDays` | 1 | Daily monitoring, no gaps |
| `vrpFilter` | 0 (disabled) | TPE showed no benefit |
| `contangoFilter` | 0 (disabled) | TPE showed no benefit |
| `slopeFilter` | 0 (disabled) | No SQLite cores data available |
| `useSmvVol` | false | Not yet implemented |
| `fillMode` | bidask | Realistic execution |
| `slippage` | enabled, 2bps base | Dynamic slippage model |

### 3.3 Grid Size
```
5 × 5 × 4 × 5 × 6 × 3 × 2 × 2 = 36,000 total combinations
```

---

## 4. Parameter Grid — SHORT Profile (7-21 DTE)

### 4.1 Swept Parameters

| Parameter | Values | Count | Spacing | Rationale |
|-----------|--------|-------|---------|-----------|
| `signalWeightPreset` | ema, mom, em, full, vol | 5 | — | Same presets |
| `creditShortDelta` | 0.25, 0.30, 0.35, 0.40, 0.45, 0.50 | 6 | 0.05 | Wider range for short DTE |
| `creditSpreadWidth` | $1, $5, $10 | 3 | varies | Narrower for short DTE |
| `creditProfitTarget` | 30%, 35%, 40%, 45%, 50% | 5 | 5% | Same as swing |
| `minIVRank` | 0, 10, 20, 30, 40, 50 | 6 | 10 | Same as swing |
| `creditTimeStopDTE` | 1, 3 | 2 | — | Must exit sooner |
| `maxPositions` | 5, 10 | 2 | — | Same as swing |
| `maxPerTicker` | 3, 5 | 2 | — | Same as swing |

### 4.2 Fixed Parameters
Same as swing except `creditDTERange` = [7, 21].

### 4.3 Grid Size
```
5 × 6 × 3 × 5 × 6 × 2 × 2 × 2 = 21,600 total combinations
```

---

## 5. Optimization Strategy

### 5.1 Genetic Algorithm (Primary)

| Setting | Value | Rationale |
|---------|-------|-----------|
| Population | 50 | Balance exploration vs runtime |
| Generations | 8 (400 evals total) | ~35 min on M5 Pro |
| Elite | 10% (5 individuals) | Preserve best configs across generations |
| Crossover | Uniform | Each gene from random parent |
| Mutation | 15% per gene | Jump to random grid value |
| Selection | Tournament (k=3) | Mild selection pressure |
| Dedup | Hash-based cache | Skip re-evaluation of identical configs |

### 5.2 Fitness Function

```
fitness = Sharpe × sqrt(WFE) × min(1, trades/500) × 1/(1 + maxDD/10)
```

| Component | Purpose | Example |
|-----------|---------|---------|
| `Sharpe` | Primary performance | SR 1.5 → 1.5 |
| `sqrt(WFE)` | IS->OOS transfer quality | WFE 0.9 → 0.95x |
| `min(1, trades/500)` | Soft trade count penalty | 250 trades → 0.50x, 500+ → 1.0x |
| `1/(1 + maxDD/10)` | Drawdown penalty | 5% DD → 0.67x, 10% DD → 0.50x |

### 5.3 Run Plan

| Run | Profile | Mode | Trials | Est. Time | Output |
|-----|---------|------|--------|-----------|--------|
| 1 | swing | ga | 400 | ~35 min | `data/wfa-v2-results-swing.json` |
| 2 | short | ga | 400 | ~30 min | `data/wfa-v2-results-short.json` |
| 3 | swing | ga | 400 | ~35 min | Seed=43, robustness check |

```bash
# Full analysis (all 3 runs, unattended, ~100 min)
npx tsx scripts/.run-wfa-v2.mjs --profile all --mode ga --trials 400

# Or individually:
npx tsx scripts/.run-wfa-v2.mjs --profile swing --mode ga --trials 400
npx tsx scripts/.run-wfa-v2.mjs --profile short --mode ga --trials 400
npx tsx scripts/.run-wfa-v2.mjs --profile swing --mode ga --trials 400 --seed 43
```

---

## 6. Statistical Validation

Applied to the best config from each profile after optimization:

### 6.1 Tests

| Test | Threshold | Purpose |
|------|-----------|---------|
| **Deflated Sharpe Ratio (DSR)** | > 0.50 | Adjusts for multiple testing (N trials) |
| **PBO (CSCV)** | < 0.50 | Probability of backtest overfitting |
| **Block Bootstrap CI** | CI5 > 0 | 5,000 resamples, block size 5 |
| **Permutation Test** | p < 0.05 | Better than random label shuffling |
| **Parameter Stability** | CV < 0.30 | Coefficient of variation across windows |

### 6.2 Regime Analysis

Trades split by VIX regime (SPY IV30d proxy):
| Regime | VIX Range | Expected |
|--------|-----------|----------|
| Low | < 15 | Most trades, moderate Sharpe |
| Mid | 15-25 | Fewer trades, possibly higher Sharpe |
| High | > 25 | Fewest trades, test if strategy survives |

All 3 regimes must have trades.

---

## 7. Holdout Validation

### 7.1 Protocol
1. WFA windows stop before holdout boundary (~2025-02-28)
2. Best config runs on holdout period (1 year, 252 trading days) with NO parameter changes
3. Portfolio constraints applied (maxPositions, maxPerTicker)

### 7.2 Gates
| Check | Threshold | Action if Failed |
|-------|-----------|------------------|
| Holdout Sharpe / OOS Sharpe | >= 0.50 | Flag — possible overfit |
| Holdout Win Rate | >= 60% | Flag — strategy may be broken |
| Holdout trade count | >= 10 | Flag — insufficient sample |

### 7.3 Interpretation
- Degradation < 50% = **healthy generalization**
- Degradation 50-75% = **acceptable, monitor in production**
- Degradation > 75% = **likely overfit, do not deploy**

---

## 8. v1 Baseline Comparison

| Metric | v1 Baseline |
|--------|-------------|
| OOS Sharpe | 1.275 |
| Win Rate | 89.52% |
| Max Drawdown | 4.64% |
| Trade Count | 5,556 |
| Total PnL | $613,248 |
| WF Efficiency | 0.885 |
| Best Config | ema, delta=0.35, width=$15, TP=30%, IV>=30, mpt5 |

**v2 improvement targets**:
- Sharpe >= 1.3 (match or beat v1)
- Holdout Sharpe ratio >= 0.5 (v1 had no holdout test)
- Statistical validation passes (v1 had none)
- Trade count >= 500 (avoid overthinning)

---

## 9. Output & Deliverables

### 9.1 Per-Profile JSON
Saved to `data/wfa-v2-results-{profile}.json`:
```json
{
  "oos": { "windows": [], "allTrades": [], "sharpe": 0, "winRate": 0, "maxDD": 0, "totalPnl": 0, "wfEfficiency": 0, "equityCurve": [] },
  "holdout": { "sharpe": 0, "winRate": 0, "maxDD": 0, "totalPnl": 0, "tradeCount": 0, "degradation": 0 },
  "stats": { "dsr": {}, "pbo": {}, "bootstrap": {}, "permutationPValue": 0, "paramStability": [] },
  "regimes": [],
  "bestConfig": {},
  "ranking": [],
  "paretoFrontier": [],
  "v1Comparison": { "v1": {}, "v2": {} },
  "totalEvaluations": 0,
  "elapsedMs": 0
}
```

### 9.2 Console Report
- OOS metrics + holdout metrics with pass/fail flags
- Statistical validation summary
- Regime breakdown
- Best config params (all round grid values)
- Top 5 composite ranking with Pareto markers
- v1 vs v2 comparison table

---

## 10. Execution Sequence

```bash
# Single command — runs all 3 steps unattended (~100 min total)
npx tsx scripts/.run-wfa-v2.mjs --profile all --mode ga --trials 400
```

```
Step 1: Swing GA (400 trials, ~35 min)
        → saves data/wfa-v2-results-swing.json

Step 2: Short GA (400 trials, ~30 min)
        → saves data/wfa-v2-results-short.json

Step 3: Swing GA seed=43 (robustness, ~35 min)
        → saves data/wfa-v2-results-swing-seed43.json

Step 4: Cross-run summary printed automatically
        → signal match, Sharpe stability check

Step 5: Review results together
        → If config passes all gates + holdout:
        → Document as production recommendation
        → Update CLAUDE.md production config
```

---

## 11. Decisions Log

All design decisions reviewed and locked:

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Signal presets | 5: ema, mom, em, full, vol | mf/adx/mb dropped — no signal in TPE top configs |
| 2 | Swing delta | 0.20-0.40 (5 values, step 0.05) | Extended to 0.40 for ATM exploration |
| 3 | Short width | $1, $5, $10 | $2.50 dropped — unreliable strike availability |
| 4 | GA evaluations | 400 (8 gens x 50 pop) | ~80 evals per signal preset |
| 5 | Holdout period | 1 year (252 trading days) | 6 months produced only 44 trades |
| 6 | Trade count | Soft penalty: min(1, trades/500) | Scales linearly, no hard rejection |
| 7 | Fitness function | Sharpe x sqrt(WFE) x tradePenalty x ddPenalty | Balances quality, generalization, throughput, risk |
| 8 | Monitoring interval | 1 (daily, locked) | No need to sweep |
| 9 | Stop loss | None (100, locked) | v1 proved SL destroys returns |
| 10 | VRP/contango/slope | Disabled (locked) | TPE showed no benefit |
| 11 | Data loading | Local JSON cache, Supabase fallback | Zero network I/O during runs |
| 12 | Drawdown penalty | 1/(1 + maxDD/10) | 5% DD = 0.67x, 10% DD = 0.50x |
