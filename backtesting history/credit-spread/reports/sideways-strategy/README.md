# Sideways Strategy -- Iron Condor & Iron Butterfly Report

**Date:** 2026-04-07
**Engine:** Post-audit (worst-side fills, honest pricing, same-expiry legs)
**Commission:** $0 (Robinhood)
**Methodology:** TRUE Walk-Forward Analysis (252d train / 126d test)
**WFA Design:** Per-window optimization -- sweep 216 configs on train, select best by Sharpe (min 5 trades), run ONLY selected config on OOS. No look-ahead.
**Starting Capital:** $10,000

## Study Design

Gate: close < EMA34 AND NOT(EMA21<EMA34<EMA55) AND trendStrength(14) < threshold

> **Note:** trendStrength is a close-only directional metric, NOT Wilder ADX (no OHLC available). Thresholds (18/20/25) are calibrated to this metric.

Config grid: 216 configs per ticker per window

---

## Section 1: Per-Ticker OOS Results

| Ticker | OOS Sharpe | OOS CAGR | OOS MaxDD | Trades | Pos Windows | Min Equity |
|--------|-----------|----------|-----------|--------|-------------|------------|
| QQQ | 0.112 | 0.4% | 33.8% | 170 | 5/16 | $8379 |
| SPY | -0.119 | -5.2% | 68.9% | 132 | 7/16 | $4297 |
| IWM | 0.315 | 5.4% | 66.6% | 210 | 8/16 | $5337 |

## Section 2: Window-by-Window Detail

### QQQ

| W# | Period | StartEq | EndEq | PnL | Trades | Selected Config | Train Sharpe |
|----|--------|---------|-------|-----|--------|-----------------|--------------|
| 1 | 2018-01-03 to 2018-07-03 | $10000 | $10846 | $846 | 7 | iron_condor|d0.3|$10|ADX18|50%|ds0.5 | 1.05 |
| 2 | 2018-07-05 to 2019-01-03 | $10846 | $10606 | $-240 | 5 | iron_condor|d0.3|$10|ADX18|50%|ds0.5 | 1.60 |
| 3 | 2019-01-04 to 2019-07-05 | $10606 | $10276 | $-330 | 1 | iron_condor|d0.2|$10|ADX18|50%|none | 2.75 |
| 4 | 2019-07-08 to 2020-01-03 | $10276 | $10511 | $235 | 10 | iron_condor|d0.2|$10|ADX20|50%|none | 0.81 |
| 5 | 2020-01-06 to 2020-07-06 | $10511 | $10511 | $0 | 0 | iron_condor|d0.2|$5|ADX20|50%|none | 0.74 |
| 6 | 2020-07-07 to 2021-01-04 | $10511 | $9534 | $-977 | 6 | iron_condor|d0.2|$5|ADX25|50%|none | 1.58 |
| 7 | 2021-01-05 to 2021-07-06 | $9534 | $9331 | $-203 | 12 | iron_condor|d0.2|$5|ADX25|80%|none | -1.01 |
| 8 | 2021-07-07 to 2022-01-03 | $9331 | $8587 | $-744 | 13 | iron_condor|d0.2|$10|ADX25|50%|none | 0.98 |
| 9 | 2022-01-04 to 2022-07-06 | $8587 | $8379 | $-208 | 13 | iron_condor|d0.3|$5|ADX18|50%|none | 1.13 |
| 10 | 2022-07-07 to 2023-01-04 | $8379 | $10104 | $1725 | 20 | iron_condor|d0.3|$10|ADX25|50%|ds0.5 | 0.58 |
| 11 | 2023-01-05 to 2023-07-07 | $10104 | $11806 | $1702 | 9 | iron_condor|d0.3|$5|ADX25|50%|ds0.5 | 0.94 |
| 12 | 2023-07-10 to 2024-01-05 | $11806 | $13093 | $1287 | 31 | iron_condor|d0.3|$10|ADX25|50%|ds0.5 | 1.71 |
| 13 | 2024-01-08 to 2024-07-09 | $13093 | $11157 | $-1936 | 16 | iron_condor|d0.3|$10|ADX25|50%|ds0.5 | 1.77 |
| 14 | 2024-07-10 to 2025-01-07 | $11157 | $11082 | $-75 | 6 | iron_condor|d0.2|$10|ADX20|50%|none | 0.57 |
| 15 | 2025-01-08 to 2025-07-11 | $11082 | $10588 | $-494 | 11 | iron_condor|d0.3|$10|ADX18|50%|ds0.5 | 0.09 |
| 16 | 2025-07-14 to 2026-01-09 | $10588 | $10348 | $-240 | 10 | iron_condor|d0.3|$5|ADX18|50%|ds0.5 | 0.86 |

### SPY

| W# | Period | StartEq | EndEq | PnL | Trades | Selected Config | Train Sharpe |
|----|--------|---------|-------|-----|--------|-----------------|--------------|
| 1 | 2018-01-03 to 2018-07-03 | $10000 | $10271 | $271 | 13 | iron_condor|d0.2|$10|ADX25|50%|none | 2.78 |
| 2 | 2018-07-05 to 2019-01-03 | $10271 | $9567 | $-704 | 4 | iron_condor|d0.2|$10|ADX25|hold|none | 1.12 |
| 3 | 2019-01-04 to 2019-07-05 | $9567 | $9244 | $-323 | 1 | iron_condor|d0.2|$10|ADX18|80%|none | 0.27 |
| 4 | 2019-07-08 to 2020-01-03 | $9244 | $7209 | $-2035 | 26 | iron_condor|d0.25|$10|ADX25|50%|ds0.5 | -0.00 |
| 5 | 2020-01-06 to 2020-07-06 | $7209 | $7226 | $17 | 4 | iron_butterfly|d0.5|$10|ADX18|50%|none | 0.79 |
| 6 | 2020-07-07 to 2021-01-04 | $7226 | $5772 | $-1454 | 3 | iron_butterfly|d0.5|$10|ADX18|50%|none | 0.99 |
| 7 | 2021-01-05 to 2021-07-06 | $5772 | $5960 | $188 | 2 | iron_condor|d0.25|$10|ADX20|50%|none | 0.43 |
| 8 | 2021-07-07 to 2022-01-03 | $5960 | $5448 | $-512 | 11 | iron_condor|d0.25|$10|ADX20|50%|none | 0.43 |
| 9 | 2022-01-04 to 2022-07-06 | $5448 | $4297 | $-1151 | 12 | iron_condor|d0.2|$5|ADX18|50%|none | -0.08 |
| 10 | 2022-07-07 to 2023-01-04 | $4297 | $4518 | $221 | 7 | iron_butterfly|d0.5|$10|ADX18|50%|none | 0.37 |
| 11 | 2023-01-05 to 2023-07-07 | $4518 | $6342 | $1824 | 13 | iron_butterfly|d0.5|$10|ADX25|50%|none | 1.11 |
| 12 | 2023-07-10 to 2024-01-05 | $6342 | $6298 | $-44 | 8 | iron_condor|d0.2|$10|ADX20|50%|none | 1.73 |
| 13 | 2024-01-08 to 2024-07-09 | $6298 | $6218 | $-80 | 1 | iron_butterfly|d0.5|$10|ADX18|50%|none | 0.68 |
| 14 | 2024-07-10 to 2025-01-07 | $6218 | $7411 | $1193 | 14 | iron_condor|d0.25|$10|ADX25|50%|none | 0.79 |
| 15 | 2025-01-08 to 2025-07-11 | $7411 | $6471 | $-940 | 12 | iron_condor|d0.25|$10|ADX25|50%|ds0.5 | 1.67 |
| 16 | 2025-07-14 to 2026-01-09 | $6471 | $6516 | $45 | 1 | iron_condor|d0.2|$10|ADX25|50%|ds0.5 | 1.05 |

### IWM

| W# | Period | StartEq | EndEq | PnL | Trades | Selected Config | Train Sharpe |
|----|--------|---------|-------|-----|--------|-----------------|--------------|
| 1 | 2018-01-03 to 2018-07-03 | $10000 | $9470 | $-530 | 11 | iron_condor|d0.25|$10|ADX25|50%|none | -1.14 |
| 2 | 2018-07-05 to 2019-01-03 | $9470 | $8950 | $-520 | 6 | iron_condor|d0.3|$5|ADX25|50%|none | -0.40 |
| 3 | 2019-01-04 to 2019-07-05 | $8950 | $10205 | $1255 | 6 | iron_condor|d0.3|$5|ADX25|50%|none | 0.63 |
| 4 | 2019-07-08 to 2020-01-03 | $10205 | $10129 | $-76 | 6 | iron_condor|d0.2|$10|ADX18|80%|none | 1.51 |
| 5 | 2020-01-06 to 2020-07-06 | $10129 | $10491 | $362 | 9 | iron_condor|d0.2|$10|ADX20|50%|ds0.5 | 2.37 |
| 6 | 2020-07-07 to 2021-01-04 | $10491 | $11251 | $760 | 12 | iron_condor|d0.2|$10|ADX20|50%|ds0.5 | 1.64 |
| 7 | 2021-01-05 to 2021-07-06 | $11251 | $11687 | $436 | 21 | iron_condor|d0.2|$10|ADX20|50%|ds0.5 | 2.27 |
| 8 | 2021-07-07 to 2022-01-03 | $11687 | $11336 | $-351 | 17 | iron_condor|d0.2|$10|ADX25|80%|none | 3.47 |
| 9 | 2022-01-04 to 2022-07-06 | $11336 | $9391 | $-1945 | 10 | iron_butterfly|d0.5|$10|ADX25|50%|none | 1.86 |
| 10 | 2022-07-07 to 2023-01-04 | $9391 | $5475 | $-3915 | 16 | iron_butterfly|d0.5|$10|ADX25|50%|none | 0.90 |
| 11 | 2023-01-05 to 2023-07-07 | $5475 | $5337 | $-138 | 24 | iron_condor|d0.3|$10|ADX25|50%|ds0.5 | 0.58 |
| 12 | 2023-07-10 to 2024-01-05 | $5337 | $5800 | $463 | 6 | iron_condor|d0.25|$10|ADX18|80%|none | 1.47 |
| 13 | 2024-01-08 to 2024-07-09 | $5800 | $9933 | $4133 | 26 | iron_condor|d0.25|$5|ADX25|80%|none | 2.42 |
| 14 | 2024-07-10 to 2025-01-07 | $9933 | $15600 | $5666 | 23 | iron_condor|d0.25|$5|ADX25|80%|none | 3.11 |
| 15 | 2025-01-08 to 2025-07-11 | $15600 | $15998 | $398 | 7 | iron_condor|d0.25|$5|ADX25|80%|none | 2.30 |
| 16 | 2025-07-14 to 2026-01-09 | $15998 | $15272 | $-725 | 10 | iron_condor|d0.25|$5|ADX25|80%|none | 1.62 |

## Section 3: Portfolio Combinations

| Portfolio | Sharpe | CAGR | MaxDD | Final$ | MinEq | Trades |
|---|---|---|---|---|---|---|
| QQQ bull only | 0.687 | 18.5% | 39.6% | $39069 | $6964 | 552 |
| QQQ bull + all 3 bear | 0.985 | 39.9% | 47.9% | $147754 | $6976 | 809 |
| QQQ bull + QQQ sideways | 1.141 | 18.7% | 37.6% | $39417 | $6574 | 722 |
| QQQ bull + SPY sideways | 1.007 | 17.2% | 86.2% | $35585 | $1455 | 684 |
| QQQ bull + IWM sideways | 1.065 | 20.4% | 77.8% | $44342 | $2904 | 762 |
| Bull + bear + all sideways | 1.291 | 40.2% | 60.5% | $149890 | $4168 | 1321 |

## Caveats

1. TRUE WFA: each window trains independently, no future data leakage
2. Sideways regime may have limited occurrence in bull-dominated period
3. Trend gate is close-only directional metric (NOT Wilder ADX) -- thresholds calibrated to this metric, not standard ADX values
4. Max loss = MAX(put width, call width), only one side ITM at expiry
5. Portfolio combinations use merged daily PnL equity curve (shared-capital simulation)
6. Cache-only: zero API calls
