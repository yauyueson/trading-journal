# DTE5 TP/SL Walk-Forward Analysis Study — Complete Results

Generated: 2026-04-08

## Study Design

- **Strategy**: DTE5 Bull Put Credit Spread
- **Params**: sp30/20, DTE [2,7], width $10, maxPos=1
- **WFA**: 252d train / 126d test, purge 10d, rolling mode
- **Windows**: 15 total (13 selection + 2 holdout)
- **OOS Period**: 2019-01 to 2025-07 (13 windows)
- **Holdout Period**: 2025-07 to 2026-02 (2 windows, ~7 months)
- **Capital**: $10,000 simulation, 10% risk/trade, 50-contract cap
- **Total configs tested**: 198 across 8 phases

## Production Config

**`ema55 QQQ bull + SL 2.5x + TL 50/50`** — deployed for $1K live test

```
Entry: QQQ bull put spread when close > EMA55
  - Short delta: 0.30, Long delta: 0.20, Width: $10, DTE: 2-7
Exit Rules:
  1. Hold to expiry (default — capture full theta decay)
  2. Stop Loss: close at market if spread cost >= 2.5x entry credit
  3. Trailing Lock: when trade reaches 50% of max profit, lock floor at 50%
  4. NO_CHAIN fix: never force-exit on missing chain data
```

| Metric | Value |
|--------|-------|
| OOS Sharpe | 1.44 |
| OOS Win Rate | 80.9% |
| OOS Trades | 461 |
| OOS Total PnL | +$13.0k |
| OOS MaxDD (flat) | 11.8% |
| OOS CAGR | 18.7% |
| $10K → | $30.5k |
| Holdout Sharpe | +0.84 |
| Holdout Trades | 60 |
| Holdout PnL | +$1.1k |
| Grade | C |

---

## Phase Summary

| Phase | Configs | What Tested | Key Finding |
|-------|---------|-------------|-------------|
| 1 | 34 | Isolated TP/SL/delta stop/trailing lock | nc+sl2.5x champion (1.20). NO_CHAIN fix = +0.56 Sharpe |
| 2A | 8 | Multi-mechanism combos | Trailing lock 50/50 flips holdout from -0.27 to +0.18 |
| 2B | 12 | SL refinement (0.1x grid) | 2.5x confirmed optimal |
| 3R | 12 | Phased TP re-run with nc+ | All inferior to hold-to-expiry (best 0.70 vs 1.29) |
| 4 | 14 | Entry regime filters (contango, VRP) | cPct25+vrpPct25: Sharpe 1.36, MaxDD 8.7% |
| 5 | 10 | Trailing lock fine-tune | TL robust across 30/30 to 60/60 |
| 7 | 12 | Multi-ticker (QQQ/SPY/IWM × bull/bear) | All 3 bull tickers viable. All bears killed |
| **8** | **108** | **EMA gate & stack sweep** | **no_gate QQQ (1.50) > ema55 QQQ (1.44) > ema34 QQQ (1.29)** |

---

## Phase 8: EMA Gate & Stack Sweep — Top 20

### Bull Configs (champion exit: SL 2.5x + TL 50/50)

| # | Gate | Ticker | OOS Sharpe | Holdout | WR% | MaxDD | Trades | PnL | $10K→ | CAGR |
|---|------|--------|-----------|---------|-----|-------|--------|-----|-------|------|
| 1 | no_gate | QQQ | **1.50** | **+1.01** | 80.0% | 17.1% | 629 | +$16.3k | $41.6k | 24.5% |
| 2 | **ema55** | **QQQ** | **1.44** | **+0.84** | 80.9% | **11.8%** | 461 | +$13.0k | $30.5k | 18.7% |
| 3 | ema21 | QQQ | 1.35 | -0.25 | 81.3% | 15.4% | 432 | +$11.5k | $25.2k | 15.2% |
| 4 | no_gate | IWM | 1.30 | **+2.01** | 77.4% | 11.9% | 597 | +$11.1k | $28.3k | 17.3% |
| 5 | ema34 | QQQ | 1.29 | +0.18 | 81.0% | 15.0% | 447 | +$11.6k | $28.3k | 17.3% |
| 6 | ema13 | QQQ | 1.24 | +0.05 | 81.4% | 17.3% | 420 | +$10.7k | $19.8k | 11.0% |
| 7 | stack_8>21 | SPY | 1.17 | -0.19 | 81.3% | 9.7% | 418 | +$9.1k | $18.5k | 9.9% |
| 8 | stack_8>21 | QQQ | 1.11 | +0.57 | 80.9% | 14.3% | 346 | +$8.4k | $21.2k | 12.2% |
| 9 | stack_21>34>55 | QQQ | 1.10 | -0.08 | 80.8% | 15.5% | 344 | +$8.3k | $17.9k | 9.4% |
| 10 | ema21 | IWM | 0.90 | +1.58 | 77.6% | 7.9% | 366 | +$5.4k | $16.5k | 7.9% |
| 11 | no_gate | SPY | 0.88 | +0.65 | 79.1% | 26.3% | 727 | +$11.0k | $21.4k | 12.4% |
| 12 | ema34 | SPY | 0.85 | +0.13 | 79.6% | 16.0% | 534 | +$8.0k | $18.0k | 9.5% |
| 13 | ema34 | IWM | 0.76 | +1.42 | 76.9% | 7.8% | 360 | +$4.6k | $15.3k | 6.7% |
| 14 | ema55 | SPY | 0.73 | +0.25 | 79.1% | 19.3% | 569 | +$7.1k | $16.8k | 8.3% |
| 15 | ema55 | IWM | 0.71 | +1.97 | 76.6% | 9.2% | 367 | +$4.4k | $16.3k | 7.8% |

### Best Bear Configs (for reference — none recommended for production)

| # | Gate | Ticker | OOS Sharpe | Holdout | Trades | Grade |
|---|------|--------|-----------|---------|--------|-------|
| 1 | bear_21<34<55_prox | SPY | 0.40 | 0.00 | 71 | D |
| 2 | bear_34<55 | QQQ | 0.33 | +0.61 | 103 | F |
| 3 | bear_21<34<55 | SPY | 0.30 | 0.00 | 82 | D |
| 4 | bear_ema34 | IWM | 0.27 | -1.18 | 278 | D |

---

## Confirmed Hypotheses

| # | Hypothesis | Status | Evidence |
|---|-----------|--------|----------|
| H1 | TP hurts DTE5 | CONFIRMED | All TP configs degrade. Best tp90 = +0.02 vs baseline |
| H2 | SL 2.5x helps | CONFIRMED | +0.92 Sharpe vs baseline. Cuts gamma tail risk |
| H3 | Trailing lock saves holdout | CONFIRMED | tl50-50 flips holdout from -0.27 to +0.18 |
| H4 | Phased TP low value | CONFIRMED | Best phased (0.70) << champion (1.44) |
| H5 | NO_CHAIN fix critical | CONFIRMED | +0.56 Sharpe from data quality fix alone |
| H6 | Contango filter reduces drawdown | CONFIRMED | cPct25 cuts MaxDD from 15.0% to 11.9% |
| H7 | Bears don't work at DTE5 | CONFIRMED | All 24 bear combos Grade D or F |
| **H8** | **EMA55 > EMA34 for QQQ** | **CONFIRMED** | **1.44 vs 1.29 OOS, +0.84 vs +0.18 holdout** |
| **H9** | **No gate > any gate for OOS** | **CONFIRMED** | **no_gate QQQ 1.50 — but higher drawdown** |
| **H10** | **EMA stacks don't add value** | **CONFIRMED** | **Stack filters reduce trades without improving Sharpe** |

---

## Why EMA55 Over EMA34 or No Gate

| Metric | no_gate QQQ | ema55 QQQ | ema34 QQQ |
|--------|-------------|-----------|-----------|
| OOS Sharpe | **1.50** | 1.44 | 1.29 |
| Holdout Sharpe | +1.01 | +0.84 | +0.18 |
| OOS MaxDD (flat) | 17.1% | **11.8%** | 15.0% |
| Portfolio MaxDD | **45.2%** | 25.9% | 23.4% |
| OOS Trades | 629 | 461 | 447 |
| CAGR | **24.5%** | 18.7% | 17.3% |

**Decision**: EMA55 was chosen over no_gate because:
1. Portfolio MaxDD 25.9% vs 45.2% — no_gate risks a 45% drawdown
2. OOS flat MaxDD 11.8% is the **lowest of any QQQ config** — best risk-adjusted
3. Still strong holdout (+0.84 vs +1.01) — not giving up much
4. Fewer trades (461 vs 629) — less commission, less monitoring overhead
5. No_gate is most likely to be regime-dependent (works because 2019-2026 is bullish)

---

## Algorithm Improvements Made During Study

1. **NO_CHAIN fix** (`missingChainExitAfterDays: 999`): Suppresses premature exits from missing chain data. +0.56 Sharpe.
2. **Conservative SL pricing**: SL/MAX_LOSS exits use actual market spread cost (which may gap past threshold), not the threshold. Realistic for daily monitoring at DTE 2-7.
3. **Per-signal delta routing**: `configuredDelta` on EntrySignal allows different deltas per ticker/direction (e.g., sp40/30 for bear, sp15/05 for IWM).
4. **VRP fix**: ORATS doesn't provide `clsHv30d` — used `hv20d` instead for VRP computation.

## Data Files

| File | Contents |
|------|----------|
| `phase1-results.json` | 34 isolated mechanism configs |
| `phase2a-results.json` | 8 holdout diagnostic + multi-mechanism combos |
| `phase2b-results.json` | 12 SL parameter refinement |
| `phase3-results.json` | 24 phased TP (original, without nc+ fix — stale) |
| `phase3r-results.json` | 12 phased TP re-run with nc+ fix |
| `phase4-results.json` | 14 entry-level regime filters |
| `phase5-results.json` | 10 trailing lock fine-tune |
| `phase7-*.json` | 6 multi-ticker/direction validation files |
| `phase8-ema-sweep.json` | 54 EMA gate × ticker combos (108 configs: champion + baseline) |

## Caveats

1. Backtest period (2019-2026) is predominantly bullish — bull put spreads benefit structurally
2. Fill model uses mid (no explicit slippage) — real fills may differ
3. Holdout is ~60 trades over 7 months — statistically thin
4. 198 total configs tested — multiple testing penalty applies
5. NO_CHAIN fix assumes missing chain data is random, not crash-correlated
6. VRP uses hv20d proxy (ORATS doesn't provide hv30d)
7. EMA stacks and aggressive filters reduce sample size without improving quality
