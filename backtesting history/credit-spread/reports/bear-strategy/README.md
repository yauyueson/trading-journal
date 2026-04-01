# Bear Call Spread Strategy — Comprehensive Report

**Date:** 2026-03-31
**Engine:** Post-audit (worst-side fills, honest pricing, same-expiry legs)
**Commission:** $0 (Robinhood)
**Methodology:** Walk-Forward Analysis (252d train / 126d test, ~16 windows) with TRUE portfolio growth
**Starting Capital:** $10,000 shared equity (bull + bear size from same pool)

## Study Design

**Goal:** Utilize idle capital during bear markets. The validated QQQ bull put spread (sp30/20 EMA34) generates no signals when price < EMA34. Bear call spreads can profit during those periods.

**Fixed regime for all bear configs:** EMA21 < EMA34 < EMA55 (triple alignment — confirmed downtrend)

**Variables swept per ticker (QQQ, SPY, IWM):**
- Proximity filters (8): none, nearEMA8_1%, nearEMA8_2%, nearEMA8_3%, nearEMA21_1%, nearEMA21_2%, nearEMA21_3%, nearEMA21_5%
- Rally-from-low filter: none vs 8%
- Spread configs (5): sp15/05, sp20/10, sp25/15, sp30/20, sp40/30
- Total: 240 standalone configs → best per ticker → 6 portfolio combos

---

## Section 1: Proximity Filter Impact (Per-Ticker)

Average Sharpe and trade count across all spread/rally combos:

| Proximity | QQQ Sharpe | QQQ Trades | SPY Sharpe | SPY Trades | IWM Sharpe | IWM Trades |
|-----------|---------|--------|---------|--------|---------|--------|
| none | -0.207 | 115 | -0.146 | 133 | 0.069 | 178 |
| nearEMA8_1% | -0.173 | 56 | -0.230 | 75 | -0.012 | 107 |
| nearEMA8_2% | -0.229 | 79 | -0.247 | 102 | 0.098 | 150 |
| nearEMA8_3% | -0.163 | 99 | -0.067 | 120 | 0.126 | 165 |
| nearEMA21_1% | 0.090 | 22 | 0.017 | 42 | 0.151 | 55 |
| nearEMA21_2% | -0.038 | 42 | -0.146 | 68 | 0.012 | 94 |
| nearEMA21_3% | -0.181 | 61 | 0.001 | 90 | 0.085 | 120 |
| nearEMA21_5% | 0.032 | 92 | 0.031 | 117 | 0.146 | 157 |

## Section 2: Best Bear Config Per Ticker (Standalone, 10% Risk)

### QQQ Bear — Top 5

| Proximity | Rally | Spread | Sharpe | CAGR | MaxDD | WR | Final$ | Trades |
|-----------|-------|--------|--------|------|-------|----|--------|--------|
| nearEMA21_1% | none | sp40/30 | 0.368 | 3.3% | 19.8% | 71% | $12986 | 24 |
| nearEMA21_5% | none | sp25/15 | 0.341 | 3.8% | 23.8% | 81% | $13455 | 93 |
| nearEMA21_1% | rally8% | sp40/30 | 0.338 | 2.7% | 19.2% | 70% | $12377 | 20 |
| nearEMA21_2% | none | sp30/20 | 0.214 | 1.8% | 27.3% | 75% | $11496 | 44 |
| nearEMA8_1% | none | sp40/30 | 0.203 | 2.0% | 42.5% | 67% | $11698 | 54 |

### SPY Bear — Top 5

| Proximity | Rally | Spread | Sharpe | CAGR | MaxDD | WR | Final$ | Trades |
|-----------|-------|--------|--------|------|-------|----|--------|--------|
| nearEMA21_5% | none | sp40/30 | 0.559 | 10.9% | 46.6% | 65% | $22916 | 114 |
| nearEMA21_3% | none | sp40/30 | 0.554 | 9.7% | 41.0% | 67% | $20948 | 87 |
| nearEMA21_3% | rally8% | sp40/30 | 0.436 | 7.0% | 40.2% | 65% | $17140 | 83 |
| nearEMA21_5% | rally8% | sp40/30 | 0.366 | 5.9% | 46.3% | 63% | $15875 | 110 |
| nearEMA21_2% | none | sp40/30 | 0.344 | 4.6% | 43.8% | 64% | $14385 | 69 |

### IWM Bear — Top 5

| Proximity | Rally | Spread | Sharpe | CAGR | MaxDD | WR | Final$ | Trades |
|-----------|-------|--------|--------|------|-------|----|--------|--------|
| nearEMA21_3% | rally8% | sp15/05 | 0.575 | 3.8% | 20.6% | 89% | $13492 | 119 |
| nearEMA21_1% | rally8% | sp30/20 | 0.561 | 5.1% | 16.3% | 80% | $14926 | 55 |
| nearEMA21_2% | rally8% | sp15/05 | 0.524 | 3.1% | 13.9% | 88% | $12786 | 95 |
| nearEMA21_5% | rally8% | sp15/05 | 0.456 | 3.5% | 17.8% | 89% | $13189 | 159 |
| nearEMA8_3% | rally8% | sp15/05 | 0.450 | 3.5% | 18.0% | 89% | $13222 | 166 |

## Section 3: Portfolio Combinations (True Combined WFA, $10K Shared Equity)

| Portfolio | Sharpe | CAGR | MaxDD | Final$ | MinEq | Trades | Leg Breakdown |
|-----------|--------|------|-------|--------|-------|--------|---------------|
| QQQ bull only (baseline) | 0.687 | 18.5% | 39.6% | $39069 | $6964 | 552 | QQQb:552t/$29069/79% |
| QQQ bull + QQQ bear (nearEMA21_1%+sp40/30) | 0.813 | 24.6% | 37.0% | $58472 | $7365 | 576 | QQQb:552t/$43924/79%, QQQb:24t/$4548/71% |
| QQQ bull + SPY bear (nearEMA21_5%+sp40/30) | 0.912 | 33.9% | 47.5% | $103765 | $7285 | 666 | QQQb:552t/$71406/79%, SPYb:114t/$22359/65% |
| QQQ bull + IWM bear (nearEMA21_3%+sp15/05) | 0.786 | 23.0% | 32.9% | $52712 | $7555 | 671 | QQQb:552t/$38194/79%, IWMb:119t/$4518/89% |
| QQQ bull + SPY bear + IWM bear | 0.943 | 36.1% | 46.7% | $118336 | $7376 | 785 | QQQb:552t/$80332/79%, SPYb:114t/$23104/65%, IWMb:119t/$4900/89% |
| QQQ bull + all 3 bear | 0.985 | 39.9% | 47.9% | $147754 | $6976 | 809 | QQQb:552t/$101196/79%, QQQb:24t/$4733/71%, SPYb:114t/$26846/65%, IWMb:119t/$4979/89% |

### Window-by-Window: QQQ bull + all 3 bear

| W# | Period | StartEq | EndEq | PnL | Trades | Leg Detail |
|----|--------|---------|-------|-----|--------|------------|
| 1 | 2018-01-03→2018-07-03 | $10000 | $6976 | $-3024 | 34 | QQQb:21t/$-1769, QQQb:2t/$-400, SPYb:10t/$-946, IWMb:1t/$91 |
| 2 | 2018-07-05→2019-01-03 | $6976 | $8544 | $1568 | 46 | QQQb:16t/$-1116, QQQb:3t/$730, SPYb:18t/$1434, IWMb:9t/$520 |
| 3 | 2019-01-04→2019-07-05 | $8544 | $9604 | $1060 | 27 | QQQb:23t/$1540, SPYb:1t/$-512, IWMb:3t/$32 |
| 4 | 2019-07-08→2020-01-03 | $9604 | $9363 | $-241 | 32 | QQQb:23t/$-94, SPYb:1t/$-540, IWMb:8t/$393 |
| 5 | 2020-01-06→2020-07-06 | $9363 | $12924 | $3561 | 27 | QQQb:22t/$1412, QQQb:1t/$511, SPYb:3t/$1563, IWMb:1t/$75 |
| 6 | 2020-07-07→2021-01-04 | $12924 | $12193 | $-731 | 26 | QQQb:26t/$-731 |
| 7 | 2021-01-05→2021-07-06 | $12193 | $14177 | $1984 | 31 | QQQb:31t/$1984 |
| 8 | 2021-07-07→2022-01-03 | $14177 | $15983 | $1806 | 63 | QQQb:50t/$752, IWMb:13t/$1054 |
| 9 | 2022-01-04→2022-07-06 | $15983 | $37522 | $21539 | 77 | QQQb:8t/$-2108, QQQb:5t/$3708, SPYb:34t/$17548, IWMb:30t/$2391 |
| 10 | 2022-07-07→2023-01-04 | $37522 | $29433 | $-8089 | 66 | QQQb:29t/$-4410, QQQb:6t/$-419, SPYb:18t/$-3327, IWMb:13t/$67 |
| 11 | 2023-01-05→2023-07-07 | $29433 | $44810 | $15377 | 81 | QQQb:60t/$21113, QQQb:1t/$-1827, SPYb:3t/$-3884, IWMb:17t/$-25 |
| 12 | 2023-07-10→2024-01-05 | $44810 | $37150 | $-7660 | 69 | QQQb:44t/$3489, QQQb:2t/$-2064, SPYb:11t/$-3174, IWMb:12t/$-5911 |
| 13 | 2024-01-08→2024-07-09 | $37150 | $63934 | $26784 | 54 | QQQb:54t/$26784 |
| 14 | 2024-07-10→2025-01-07 | $63934 | $64093 | $159 | 48 | QQQb:48t/$159 |
| 15 | 2025-01-08→2025-07-11 | $64093 | $116624 | $52531 | 71 | QQQb:40t/$23061, QQQb:4t/$4494, SPYb:15t/$18684, IWMb:12t/$6292 |
| 16 | 2025-07-14→2026-01-09 | $116624 | $147754 | $31130 | 57 | QQQb:57t/$31130 |

## Section 4: Per-Ticker Proximity at Portfolio Level

Each row: QQQ bull + [ticker] bear with given proximity. Best spread/rally per ticker held constant.

### QQQ Bear (sp40/30, none)

| Proximity | Solo Sharpe | Solo Trades | Ptf Sharpe | Ptf CAGR | Ptf MaxDD | Ptf Final$ | vs Baseline |
|-----------|-------------|-------------|------------|----------|-----------|------------|-------------|
| none | -0.115 | 118 | 0.507 | 13.0% | 57.2% | $26545 | -0.180 |
| nearEMA8_1% | 0.203 | 54 | 0.722 | 22.0% | 51.0% | $49230 | +0.035 |
| nearEMA8_2% | -0.029 | 81 | 0.572 | 15.7% | 46.9% | $32183 | -0.115 |
| nearEMA8_3% | -0.065 | 100 | 0.533 | 14.1% | 58.5% | $28785 | -0.154 |
| nearEMA21_1% | 0.368 | 24 | 0.813 | 24.6% | 37.0% | $58472 | +0.126 |
| nearEMA21_2% | 0.118 | 45 | 0.654 | 18.6% | 48.1% | $39192 | -0.033 |
| nearEMA21_3% | 0.111 | 62 | 0.662 | 19.4% | 48.0% | $41401 | -0.025 |
| nearEMA21_5% | 0.164 | 94 | 0.705 | 22.5% | 48.1% | $50946 | +0.018 |

### SPY Bear (sp40/30, none)

| Proximity | Solo Sharpe | Solo Trades | Ptf Sharpe | Ptf CAGR | Ptf MaxDD | Ptf Final$ | vs Baseline |
|-----------|-------------|-------------|------------|----------|-----------|------------|-------------|
| none | 0.264 | 134 | 0.725 | 24.4% | 48.5% | $57702 | +0.039 |
| nearEMA8_1% | -0.017 | 74 | 0.618 | 17.6% | 41.5% | $36757 | -0.069 |
| nearEMA8_2% | 0.127 | 100 | 0.654 | 19.8% | 52.1% | $42595 | -0.032 |
| nearEMA8_3% | 0.290 | 118 | 0.749 | 25.2% | 47.5% | $60655 | +0.062 |
| nearEMA21_1% | 0.295 | 44 | 0.768 | 23.8% | 39.6% | $55202 | +0.081 |
| nearEMA21_2% | 0.344 | 69 | 0.772 | 25.0% | 42.2% | $59729 | +0.085 |
| nearEMA21_3% | 0.554 | 87 | 0.911 | 32.6% | 42.1% | $95914 | +0.224 |
| nearEMA21_5% | 0.559 | 114 | 0.912 | 33.9% | 47.5% | $103765 | +0.226 |

### IWM Bear (sp15/05, rally8%)

| Proximity | Solo Sharpe | Solo Trades | Ptf Sharpe | Ptf CAGR | Ptf MaxDD | Ptf Final$ | vs Baseline |
|-----------|-------------|-------------|------------|----------|-----------|------------|-------------|
| none | 0.411 | 180 | 0.814 | 24.2% | 36.5% | $56797 | +0.127 |
| nearEMA8_1% | 0.406 | 106 | 0.758 | 21.7% | 33.3% | $48390 | +0.072 |
| nearEMA8_2% | 0.365 | 152 | 0.787 | 23.1% | 33.4% | $52858 | +0.100 |
| nearEMA8_3% | 0.450 | 166 | 0.797 | 23.6% | 33.3% | $54522 | +0.110 |
| nearEMA21_1% | 0.246 | 55 | 0.729 | 20.3% | 36.2% | $44119 | +0.042 |
| nearEMA21_2% | 0.524 | 95 | 0.747 | 21.3% | 34.4% | $46878 | +0.060 |
| nearEMA21_3% | 0.575 | 119 | 0.786 | 23.0% | 32.9% | $52712 | +0.100 |
| nearEMA21_5% | 0.456 | 159 | 0.801 | 23.7% | 33.2% | $55027 | +0.114 |

## Section 5: Risk Tier Comparison

Best combo (QQQ bull + all 3 bear) at different risk levels:

| Risk/Leg | Sharpe | CAGR | MaxDD | Final$ | MinEq | Trades |
|----------|--------|------|-------|--------|-------|--------|
| 5% | 0.982 | 20.0% | 24.9% | $43152 | $8528 | 809 |
| 10% | 0.985 | 39.9% | 47.9% | $147754 | $6976 | 809 |
| 15% | 1.017 | 50.9% | 64.4% | $270423 | $5280 | 809 |
| 20% | 0.983 | 52.9% | 82.2% | $301583 | $3493 | 809 |

## Section 6: Year-by-Year Breakdown

QQQ bull + all 3 bear:

| Year | Bull PnL | B-Trades | Bear PnL | R-Trades | Total PnL | Bear % |
|------|----------|----------|----------|----------|-----------|--------|
| 2018 | $-2885 | 37 | $1429 | 43 | $-1456 | 98% |
| 2019 | $1446 | 46 | $-627 | 13 | $819 | -77% |
| 2020 | $681 | 48 | $2149 | 5 | $2830 | 76% |
| 2021 | $2736 | 81 | $1054 | 13 | $3790 | 28% |
| 2022 | $-6518 | 37 | $19968 | 106 | $13450 | 148% |
| 2023 | $24602 | 104 | $-16885 | 46 | $7717 | -219% |
| 2024 | $26943 | 102 | $0 | 0 | $26943 | 0% |
| 2025 | $54191 | 97 | $29470 | 31 | $83661 | 35% |

## Key Conclusions

1. **Best standalone bear per ticker:** QQQ: nearEMA21_1%+sp40/30 (Sharpe 0.368), SPY: nearEMA21_5%+sp40/30 (Sharpe 0.559), IWM: nearEMA21_3%+sp15/05 (Sharpe 0.575)
2. **Best portfolio combo:** QQQ bull + all 3 bear — Sharpe 0.985, CAGR 39.9%, MaxDD 47.9%
3. **Bull-only baseline:** Sharpe 0.687, CAGR 18.5%
4. **Bear contribution:** Fills idle periods (especially 2022 crash, 2025 correction)
5. **Optimal risk tier:** See Section 5 for Sharpe-optimal risk level

## Section 7: IV Rank Filter Experiment

Tests whether filtering bear entries by IV Rank percentile (252d min-max) improves portfolio performance.
Uses best config per ticker from Phase A.

### Per-Ticker Impact (standalone)

| Ticker | IV Gate | Sharpe | CAGR | MaxDD | WR | Final$ | Trades |
|--------|---------|--------|------|-------|----|--------|--------|
| QQQ | none | 0.368 | 3.3% | 19.8% | 71% | $12986 | 24 |
| QQQ | >=15 | 0.368 | 3.3% | 19.8% | 71% | $12986 | 24 |
| QQQ | >=25 | 0.471 | 4.3% | 14.1% | 74% | $13979 | 23 |
| QQQ | >=35 | 0.489 | 4.1% | 13.1% | 75% | $13764 | 20 |
| SPY | none | 0.559 | 10.9% | 46.6% | 65% | $22916 | 114 |
| SPY | >=15 | 0.644 | 13.0% | 41.1% | 66% | $26627 | 112 |
| SPY | >=25 | 0.644 | 13.0% | 41.1% | 66% | $26627 | 112 |
| SPY | >=35 | 0.679 | 13.7% | 34.4% | 67% | $28060 | 108 |
| IWM | none | 0.575 | 3.8% | 20.6% | 89% | $13492 | 119 |
| IWM | >=15 | 0.712 | 4.2% | 16.7% | 90% | $13865 | 105 |
| IWM | >=25 | 0.593 | 3.2% | 14.5% | 88% | $12910 | 93 |
| IWM | >=35 | 0.316 | 1.4% | 11.0% | 87% | $11222 | 63 |

### Portfolio-Level Impact (QQQ bull + all 3 bear)

| IV Gate | Sharpe | CAGR | MaxDD | Final$ | MinEq | Trades | vs Baseline |
|---------|--------|------|-------|--------|-------|--------|-------------|
| none | 0.985 | 39.9% | 47.9% | $147754 | $6976 | 809 | +0.298 |
| >=15 | 1.015 | 41.4% | 44.8% | $160438 | $6976 | 793 | +0.329 |
| >=25 | 1.030 | 42.0% | 44.8% | $166498 | $6976 | 780 | +0.343 |
| >=35 | 0.990 | 39.3% | 47.1% | $142397 | $6408 | 743 | +0.303 |

## Caveats

1. Backtest period (2017-2026) has limited sustained bear episodes — results have high variance
2. Bear configs with <30 trades are in statistical noise territory
3. Combined portfolio assumes no margin interaction between bull and bear positions
4. All positions hold to expiry — no TP/SL exits
