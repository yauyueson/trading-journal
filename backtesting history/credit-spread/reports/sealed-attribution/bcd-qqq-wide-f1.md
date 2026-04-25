# bcd-qqq-wide-f1 — sealed-anchor regime attribution

Generated: 2026-04-25T14:24:37.115Z

## Replay summary

- WFA: 10 selection + 5 holdout windows (252/126/10 rolling)
- Capital: $2,000, maxPositions=1
- Total trades: **84** (selection 59 · holdout 25)
- Selection PnL: $7165, Sharpe 0.97, MaxDD 39.8%
- Holdout PnL:   $5497, Sharpe 1.29, MaxDD 42.8%

## Per-regime PnL — combined (selection + holdout)

### QQQ vs 100d EMA

| Bucket | N | Wins | Losses | Win% | Sum PnL | Mean PnL | Mean Win | Mean Loss |
|--------|---:|---:|---:|---:|---:|---:|---:|---:|
| above | 66 | 42 | 24 | 63.6% | $9636 | $146 | $516 | $-502 |
| below | 18 | 11 | 7 | 61.1% | $3026 | $168 | $658 | $-602 |

### SPY vs 200d EMA

| Bucket | N | Wins | Losses | Win% | Sum PnL | Mean PnL | Mean Win | Mean Loss |
|--------|---:|---:|---:|---:|---:|---:|---:|---:|
| above | 68 | 44 | 24 | 64.7% | $11875 | $175 | $541 | $-498 |
| below | 16 | 9 | 7 | 56.3% | $786 | $49 | $567 | $-616 |

### 5d/60d RV shock

| Bucket | N | Wins | Losses | Win% | Sum PnL | Mean PnL | Mean Win | Mean Loss |
|--------|---:|---:|---:|---:|---:|---:|---:|---:|
| elevated | 5 | 3 | 2 | 60.0% | $-1031 | $-206 | $277 | $-931 |
| mild | 27 | 17 | 10 | 63.0% | $5070 | $188 | $569 | $-460 |
| normal | 51 | 33 | 18 | 64.7% | $9290 | $182 | $558 | $-507 |
| shock | 1 | 0 | 1 | 0.0% | $-668 | $-668 | $0 | $-668 |

### IV30 / HV20

| Bucket | N | Wins | Losses | Win% | Sum PnL | Mean PnL | Mean Win | Mean Loss |
|--------|---:|---:|---:|---:|---:|---:|---:|---:|
| cheap | 17 | 11 | 6 | 64.7% | $1892 | $111 | $513 | $-625 |
| crisis | 5 | 3 | 2 | 60.0% | $768 | $154 | $717 | $-692 |
| normal | 62 | 39 | 23 | 62.9% | $10001 | $161 | $542 | $-484 |

### IV30 percentile (252d)

| Bucket | N | Wins | Losses | Win% | Sum PnL | Mean PnL | Mean Win | Mean Loss |
|--------|---:|---:|---:|---:|---:|---:|---:|---:|
| high | 13 | 8 | 5 | 61.5% | $1471 | $113 | $688 | $-806 |
| low | 24 | 18 | 6 | 75.0% | $6237 | $260 | $488 | $-426 |
| normal | 47 | 27 | 20 | 57.4% | $4954 | $105 | $542 | $-484 |

### Breadth (% universe > 50d EMA)

| Bucket | N | Wins | Losses | Win% | Sum PnL | Mean PnL | Mean Win | Mean Loss |
|--------|---:|---:|---:|---:|---:|---:|---:|---:|
| broad | 54 | 35 | 19 | 64.8% | $10070 | $186 | $530 | $-446 |
| narrow | 23 | 14 | 9 | 60.9% | $2138 | $93 | $571 | $-651 |
| normal | 7 | 4 | 3 | 57.1% | $454 | $65 | $596 | $-644 |

### CPI proximity (entry within X trading days)

| Bucket | N | Wins | Losses | Win% | Sum PnL | Mean PnL | Mean Win | Mean Loss |
|--------|---:|---:|---:|---:|---:|---:|---:|---:|
| gt_5d | 34 | 23 | 11 | 67.6% | $6237 | $183 | $574 | $-634 |
| le_1d | 16 | 10 | 6 | 62.5% | $1470 | $92 | $474 | $-545 |
| le_3d | 21 | 11 | 10 | 52.4% | $1547 | $74 | $509 | $-406 |
| le_5d | 13 | 9 | 4 | 69.2% | $3407 | $262 | $596 | $-489 |

### FOMC proximity (entry within X trading days)

| Bucket | N | Wins | Losses | Win% | Sum PnL | Mean PnL | Mean Win | Mean Loss |
|--------|---:|---:|---:|---:|---:|---:|---:|---:|
| gt_5d | 49 | 32 | 17 | 65.3% | $7564 | $154 | $531 | $-555 |
| le_1d | 9 | 6 | 3 | 66.7% | $2051 | $228 | $503 | $-323 |
| le_3d | 16 | 8 | 8 | 50.0% | $895 | $56 | $621 | $-509 |
| le_5d | 10 | 7 | 3 | 70.0% | $2152 | $215 | $561 | $-591 |

## What-if gating — selection period only

Holdout (25 trades) is left unconditioned. Sharpe/MaxDD below are computed from the kept-trade subset over the selection range 2019-01-17 → 2024-01-19.

| Gate | Kept | Removed | Sum PnL kept | Sum PnL removed | Win% kept | Mean PnL kept | Sharpe | MaxDD |
|------|---:|---:|---:|---:|---:|---:|---:|---:|
| QQQ > 100d EMA | 44 | 15 | $5372 | $1793 | 65.9% | $122 | 0.88 | 47.7% |
| SPY > 200d EMA | 45 | 14 | $6303 | $862 | 66.7% | $140 | 0.97 | 38.0% |
| QQQ > 100d EMA AND SPY > 200d EMA | 41 | 18 | $5450 | $1715 | 65.9% | $133 | 0.88 | 39.6% |
| no RV shock (5d/60d < 2.0) | 58 | 1 | $7833 | $-668 | 65.5% | $135 | 1.10 | 36.6% |
| no RV elevated (5d/60d < 1.5) | 54 | 5 | $7844 | $-680 | 64.8% | $145 | 1.11 | 31.6% |
| IV/HV not crisis | 55 | 4 | $7567 | $-402 | 65.5% | $138 | 1.03 | 43.3% |
| IV percentile not high (<80) | 49 | 10 | $6927 | $238 | 65.3% | $141 | 1.02 | 40.1% |
| breadth not narrow (>=50%) | 42 | 17 | $5548 | $1617 | 64.3% | $132 | 0.96 | 34.1% |
| CPI proximity > 1d | 51 | 8 | $6025 | $1140 | 62.7% | $118 | 0.94 | 53.6% |
| FOMC proximity > 1d | 51 | 8 | $5641 | $1524 | 64.7% | $111 | 0.82 | 63.6% |
| CPI proximity > 3d AND FOMC proximity > 3d | 23 | 36 | $1576 | $5589 | 65.2% | $69 | 0.48 | 77.8% |
| trend ON + no RV elevated + event > 1d | 28 | 31 | $4008 | $3157 | 64.3% | $143 | 0.73 | 45.6% |

Baseline selection (no gate): N=59, Sum PnL $7165, Sharpe 0.97, MaxDD 39.8%

## Per-trade ledger (appendix)

| # | bucket | entryDate | exitDate | exitType | pnl | qqq>100d | spy>200d | rvShock | iv/hv | ivPct | dCpi | dFomc | breadth |
|---|--------|-----------|----------|----------|----:|:--------:|:--------:|---------|-------|-------|-----:|------:|---------|
| 1 | selection | 2019-01-29 | 2019-02-05 | PROFIT_TARGET | $249 | N | N | normal | normal | normal | 11 | 1 | normal |
| 2 | selection | 2019-02-12 | 2019-03-11 | TIME_STOP | $101 | Y | Y | normal | normal | normal | 1 | 9 | broad |
| 3 | selection | 2019-03-13 | 2019-04-02 | PROFIT_TARGET | $157 | Y | Y | normal | normal | low | 1 | 5 | broad |
| 4 | selection | 2019-04-10 | 2019-05-15 | FORCE_CLOSE | $-144 | Y | Y | normal | normal | normal | 0 | 14 | broad |
| 5 | selection | 2019-05-23 | 2019-06-17 | TIME_STOP | $182 | N | Y | mild | normal | normal | 9 | 16 | narrow |
| 6 | selection | 2019-06-21 | 2019-08-07 | FORCE_CLOSE | $-198 | Y | Y | normal | cheap | normal | 7 | 2 | broad |
| 7 | selection | 2019-08-19 | 2019-09-16 | TIME_STOP | $20 | Y | Y | elevated | cheap | normal | 4 | 13 | narrow |
| 8 | selection | 2019-09-17 | 2019-10-15 | TIME_STOP | $-114 | Y | Y | normal | normal | normal | 3 | 1 | broad |
| 9 | selection | 2019-10-15 | 2019-11-04 | PROFIT_TARGET | $190 | Y | Y | normal | normal | normal | 3 | 11 | broad |
| 10 | selection | 2019-11-12 | 2019-12-13 | PROFIT_TARGET | $232 | Y | Y | normal | normal | low | 1 | 9 | broad |
| 11 | selection | 2019-12-26 | 2020-01-16 | PROFIT_TARGET | $241 | Y | Y | normal | normal | low | 10 | 10 | broad |
| 12 | selection | 2020-01-27 | 2020-02-06 | PROFIT_TARGET | $324 | Y | Y | elevated | crisis | normal | 8 | 2 | broad |
| 13 | selection | 2020-02-10 | 2020-03-03 | FORCE_CLOSE | $-373 | Y | Y | mild | normal | normal | 3 | 8 | broad |
| 14 | selection | 2020-03-10 | 2020-04-03 | FORCE_CLOSE | $-668 | N | N | shock | normal | high | 1 | 4 | narrow |
| 15 | selection | 2020-04-07 | 2020-04-27 | PROFIT_TARGET | $545 | N | N | mild | cheap | high | 3 | 15 | narrow |
| 16 | selection | 2020-05-06 | 2020-06-01 | PROFIT_TARGET | $475 | Y | N | normal | normal | high | 4 | 5 | broad |
| 17 | selection | 2020-06-04 | 2020-06-23 | PROFIT_TARGET | $409 | Y | Y | normal | normal | normal | 4 | 4 | broad |
| 18 | selection | 2020-07-02 | 2020-08-03 | PROFIT_TARGET | $574 | Y | Y | mild | normal | normal | 7 | 16 | broad |
| 19 | selection | 2020-08-14 | 2020-08-26 | PROFIT_TARGET | $585 | Y | Y | mild | normal | normal | 2 | 12 | broad |
| 20 | selection | 2020-08-28 | 2020-09-25 | FORCE_CLOSE | $-821 | Y | Y | normal | crisis | normal | 9 | 12 | broad |
| 21 | selection | 2020-09-28 | 2020-11-12 | FORCE_CLOSE | $50 | Y | Y | mild | cheap | normal | 11 | 8 | broad |
| 22 | selection | 2020-11-23 | 2020-12-16 | PROFIT_TARGET | $649 | Y | Y | normal | cheap | normal | 7 | 12 | broad |
| 23 | selection | 2020-12-22 | 2021-02-02 | PROFIT_TARGET | $657 | Y | Y | normal | crisis | normal | 8 | 4 | broad |
| 24 | selection | 2021-02-05 | 2021-03-05 | FORCE_CLOSE | $-579 | Y | Y | mild | normal | low | 3 | 7 | broad |
| 25 | selection | 2021-03-08 | 2021-04-01 | PROFIT_TARGET | $836 | N | Y | mild | normal | normal | 2 | 7 | narrow |
| 26 | selection | 2021-04-06 | 2021-05-14 | FORCE_CLOSE | $-479 | Y | Y | normal | cheap | low | 5 | 13 | broad |
| 27 | selection | 2021-05-18 | 2021-06-09 | PROFIT_TARGET | $447 | Y | Y | mild | normal | low | 4 | 14 | narrow |
| 28 | selection | 2021-06-16 | 2021-06-28 | PROFIT_TARGET | $435 | Y | Y | normal | normal | low | 4 | 0 | broad |
| 29 | selection | 2021-06-30 | 2021-08-05 | PROFIT_TARGET | $563 | Y | Y | normal | normal | low | 8 | 10 | broad |
| 30 | selection | 2021-08-12 | 2021-08-30 | PROFIT_TARGET | $470 | Y | Y | normal | normal | low | 1 | 11 | broad |
| 31 | selection | 2021-09-10 | 2021-10-06 | FORCE_CLOSE | $-562 | Y | Y | normal | crisis | normal | 2 | 8 | broad |
| 32 | selection | 2021-10-08 | 2021-10-21 | PROFIT_TARGET | $488 | Y | Y | elevated | normal | normal | 3 | 12 | normal |
| 33 | selection | 2021-10-22 | 2021-11-03 | PROFIT_TARGET | $611 | Y | Y | normal | cheap | low | 7 | 8 | broad |
| 34 | selection | 2021-11-05 | 2021-12-15 | FORCE_CLOSE | $-426 | Y | Y | normal | normal | normal | 3 | 2 | broad |
| 35 | selection | 2021-12-20 | 2021-12-23 | PROFIT_TARGET | $604 | Y | Y | mild | normal | high | 6 | 3 | narrow |
| 36 | selection | 2022-01-04 | 2022-01-25 | FORCE_CLOSE | $-764 | Y | Y | normal | cheap | normal | 6 | 13 | narrow |
| 37 | selection | 2022-02-02 | 2022-03-07 | FORCE_CLOSE | $-799 | N | Y | mild | cheap | high | 6 | 5 | narrow |
| 38 | selection | 2022-03-17 | 2022-03-28 | PROFIT_TARGET | $634 | N | Y | mild | cheap | high | 5 | 1 | narrow |
| 39 | selection | 2022-03-31 | 2022-04-26 | FORCE_CLOSE | $-884 | Y | Y | normal | cheap | normal | 8 | 11 | normal |
| 40 | selection | 2022-04-29 | 2022-06-10 | FORCE_CLOSE | $-844 | N | N | elevated | normal | high | 8 | 3 | narrow |
| 41 | selection | 2022-06-13 | 2022-07-11 | TIME_STOP | $285 | N | N | normal | normal | high | 1 | 2 | narrow |
| 42 | selection | 2022-07-13 | 2022-07-27 | PROFIT_TARGET | $707 | N | N | normal | normal | high | 0 | 10 | narrow |
| 43 | selection | 2022-07-27 | 2022-08-15 | PROFIT_TARGET | $848 | N | N | mild | normal | normal | 10 | 0 | broad |
| 44 | selection | 2022-08-24 | 2022-09-26 | FORCE_CLOSE | $-898 | Y | N | normal | normal | normal | 10 | 19 | normal |
| 45 | selection | 2022-10-06 | 2022-11-07 | FORCE_CLOSE | $-702 | N | N | mild | normal | high | 5 | 11 | narrow |
| 46 | selection | 2022-11-17 | 2022-12-12 | TIME_STOP | $-148 | N | N | normal | normal | normal | 5 | 11 | normal |
| 47 | selection | 2022-12-16 | 2023-01-17 | TIME_STOP | $-35 | N | N | normal | normal | normal | 3 | 2 | narrow |
| 48 | selection | 2023-01-18 | 2023-02-01 | PROFIT_TARGET | $704 | N | N | normal | normal | low | 3 | 10 | normal |
| 49 | selection | 2023-02-01 | 2023-03-13 | FORCE_CLOSE | $-485 | Y | Y | normal | normal | low | 9 | 0 | broad |
| 50 | selection | 2023-03-16 | 2023-04-17 | TIME_STOP | $345 | Y | N | mild | normal | low | 2 | 4 | broad |
| 51 | selection | 2023-04-28 | 2023-05-22 | PROFIT_TARGET | $512 | Y | Y | mild | normal | low | 8 | 3 | broad |
| 52 | selection | 2023-05-26 | 2023-06-15 | PROFIT_TARGET | $646 | Y | Y | mild | normal | low | 11 | 12 | broad |
| 53 | selection | 2023-06-27 | 2023-07-18 | PROFIT_TARGET | $704 | Y | Y | mild | normal | low | 9 | 8 | broad |
| 54 | selection | 2023-07-26 | 2023-09-08 | FORCE_CLOSE | $-368 | Y | Y | mild | normal | low | 10 | 0 | broad |
| 55 | selection | 2023-09-21 | 2023-10-16 | TIME_STOP | $325 | Y | Y | normal | normal | normal | 6 | 1 | narrow |
| 56 | selection | 2023-10-19 | 2023-11-14 | PROFIT_TARGET | $843 | Y | Y | normal | normal | normal | 5 | 9 | narrow |
| 57 | selection | 2023-11-16 | 2023-12-11 | TIME_STOP | $259 | Y | Y | mild | cheap | low | 2 | 11 | broad |
| 58 | selection | 2023-12-15 | 2024-01-16 | TIME_STOP | $-140 | Y | Y | normal | normal | low | 3 | 2 | broad |
| 59 | selection | 2024-01-17 | 2024-02-02 | PROFIT_TARGET | $690 | Y | Y | normal | normal | low | 3 | 10 | broad |
| 60 | holdout | 2024-02-14 | 2024-03-11 | TIME_STOP | $-64 | Y | Y | mild | normal | normal | 1 | 10 | broad |
| 61 | holdout | 2024-03-14 | 2024-04-17 | FORCE_CLOSE | $-307 | Y | Y | mild | normal | normal | 2 | 4 | broad |
| 62 | holdout | 2024-04-26 | 2024-05-20 | PROFIT_TARGET | $818 | Y | Y | normal | normal | normal | 12 | 3 | narrow |
| 63 | holdout | 2024-05-24 | 2024-06-13 | PROFIT_TARGET | $604 | Y | Y | normal | normal | low | 7 | 12 | broad |
| 64 | holdout | 2024-06-25 | 2024-07-10 | PROFIT_TARGET | $649 | Y | Y | normal | normal | low | 8 | 8 | broad |
| 65 | holdout | 2024-07-10 | 2024-07-26 | FORCE_CLOSE | $-683 | Y | Y | normal | normal | normal | 1 | 15 | broad |
| 66 | holdout | 2024-08-07 | 2024-08-15 | PROFIT_TARGET | $1309 | N | Y | mild | normal | high | 5 | 5 | narrow |
| 67 | holdout | 2024-08-21 | 2024-09-06 | FORCE_CLOSE | $-628 | Y | Y | normal | cheap | normal | 5 | 15 | broad |
| 68 | holdout | 2024-09-19 | 2024-10-14 | TIME_STOP | $527 | Y | Y | normal | cheap | normal | 6 | 1 | broad |
| 69 | holdout | 2024-10-17 | 2024-11-07 | PROFIT_TARGET | $792 | Y | Y | normal | normal | normal | 5 | 15 | broad |
| 70 | holdout | 2024-11-14 | 2024-12-06 | PROFIT_TARGET | $574 | Y | Y | normal | normal | normal | 1 | 5 | broad |
| 71 | holdout | 2024-12-13 | 2025-01-13 | FORCE_CLOSE | $-501 | Y | Y | mild | normal | low | 2 | 3 | broad |
| 72 | holdout | 2025-01-15 | 2025-02-13 | PROFIT_TARGET | $593 | Y | Y | mild | cheap | normal | 0 | 9 | broad |
| 73 | holdout | 2025-02-13 | 2025-03-04 | FORCE_CLOSE | $-682 | Y | Y | normal | normal | normal | 1 | 11 | broad |
| 74 | holdout | 2025-03-14 | 2025-04-15 | FORCE_CLOSE | $-1019 | N | N | elevated | normal | high | 2 | 3 | narrow |
| 75 | holdout | 2025-04-28 | 2025-05-12 | PROFIT_TARGET | $944 | N | N | normal | cheap | high | 11 | 7 | normal |
| 76 | holdout | 2025-05-12 | 2025-06-04 | PROFIT_TARGET | $813 | Y | Y | normal | cheap | normal | 1 | 3 | broad |
| 77 | holdout | 2025-06-10 | 2025-07-03 | PROFIT_TARGET | $808 | Y | Y | normal | normal | normal | 1 | 6 | broad |
| 78 | holdout | 2025-07-10 | 2025-08-11 | TIME_STOP | $520 | Y | Y | normal | normal | low | 3 | 14 | broad |
| 79 | holdout | 2025-08-21 | 2025-09-11 | PROFIT_TARGET | $758 | Y | Y | normal | normal | normal | 7 | 16 | broad |
| 80 | holdout | 2025-09-19 | 2025-10-27 | PROFIT_TARGET | $1170 | Y | Y | normal | crisis | normal | 6 | 2 | broad |
| 81 | holdout | 2025-10-31 | 2025-12-08 | FORCE_CLOSE | $-910 | Y | Y | mild | normal | normal | 9 | 2 | broad |
| 82 | holdout | 2025-12-15 | 2026-01-12 | TIME_STOP | $442 | Y | Y | normal | normal | normal | 3 | 3 | narrow |
| 83 | holdout | 2026-01-14 | 2026-02-17 | TIME_STOP | $-1029 | Y | Y | normal | normal | normal | 1 | 9 | narrow |
| 84 | holdout | 2026-02-27 | 2026-02-27 | FORCE_CLOSE | $0 | Y | Y | mild | normal | normal | 11 | 21 | narrow |