# pmcc-qqq-pt60-f1 — sealed-anchor regime attribution

Generated: 2026-04-25T14:24:37.122Z

## Replay summary

- WFA: 10 selection + 5 holdout windows (252/126/10 rolling)
- Capital: $10,000, maxPositions=1
- Total trades: **39** (selection 28 · holdout 11)
- Selection PnL: $34408, Sharpe 1.72, MaxDD 17.5%
- Holdout PnL:   $18669, Sharpe 1.41, MaxDD 35.5%

## Per-regime PnL — combined (selection + holdout)

### QQQ vs 100d EMA

| Bucket | N | Wins | Losses | Win% | Sum PnL | Mean PnL | Mean Win | Mean Loss |
|--------|---:|---:|---:|---:|---:|---:|---:|---:|
| above | 23 | 12 | 11 | 52.2% | $30150 | $1311 | $3582 | $-1166 |
| below | 16 | 10 | 6 | 62.5% | $22927 | $1433 | $3131 | $-1398 |

### SPY vs 200d EMA

| Bucket | N | Wins | Losses | Win% | Sum PnL | Mean PnL | Mean Win | Mean Loss |
|--------|---:|---:|---:|---:|---:|---:|---:|---:|
| above | 25 | 13 | 12 | 52.0% | $32443 | $1298 | $3690 | $-1293 |
| below | 14 | 9 | 5 | 64.3% | $20633 | $1474 | $2925 | $-1139 |

### 5d/60d RV shock

| Bucket | N | Wins | Losses | Win% | Sum PnL | Mean PnL | Mean Win | Mean Loss |
|--------|---:|---:|---:|---:|---:|---:|---:|---:|
| elevated | 6 | 2 | 4 | 33.3% | $1424 | $237 | $3208 | $-1248 |
| mild | 9 | 5 | 4 | 55.6% | $11464 | $1274 | $3228 | $-1169 |
| normal | 23 | 14 | 9 | 60.9% | $39011 | $1696 | $3611 | $-1283 |
| shock | 1 | 1 | 0 | 100.0% | $1177 | $1177 | $1177 | $0 |

### IV30 / HV20

| Bucket | N | Wins | Losses | Win% | Sum PnL | Mean PnL | Mean Win | Mean Loss |
|--------|---:|---:|---:|---:|---:|---:|---:|---:|
| cheap | 6 | 5 | 1 | 83.3% | $11772 | $1962 | $2669 | $-1571 |
| normal | 33 | 17 | 16 | 51.5% | $41304 | $1252 | $3585 | $-1228 |

### IV30 percentile (252d)

| Bucket | N | Wins | Losses | Win% | Sum PnL | Mean PnL | Mean Win | Mean Loss |
|--------|---:|---:|---:|---:|---:|---:|---:|---:|
| high | 13 | 7 | 6 | 53.8% | $13475 | $1037 | $3098 | $-1368 |
| low | 10 | 6 | 4 | 60.0% | $19941 | $1994 | $4054 | $-1096 |
| normal | 16 | 9 | 7 | 56.3% | $19660 | $1229 | $3143 | $-1232 |

### Breadth (% universe > 50d EMA)

| Bucket | N | Wins | Losses | Win% | Sum PnL | Mean PnL | Mean Win | Mean Loss |
|--------|---:|---:|---:|---:|---:|---:|---:|---:|
| broad | 21 | 12 | 9 | 57.1% | $32969 | $1570 | $3684 | $-1249 |
| narrow | 17 | 10 | 7 | 58.8% | $21373 | $1257 | $3008 | $-1245 |
| normal | 1 | 0 | 1 | 0.0% | $-1265 | $-1265 | $0 | $-1265 |

### CPI proximity (entry within X trading days)

| Bucket | N | Wins | Losses | Win% | Sum PnL | Mean PnL | Mean Win | Mean Loss |
|--------|---:|---:|---:|---:|---:|---:|---:|---:|
| gt_5d | 20 | 9 | 11 | 45.0% | $13084 | $654 | $2965 | $-1236 |
| le_1d | 5 | 4 | 1 | 80.0% | $14980 | $2996 | $3915 | $-680 |
| le_3d | 6 | 4 | 2 | 66.7% | $14102 | $2350 | $4205 | $-1359 |
| le_5d | 8 | 5 | 3 | 62.5% | $10911 | $1364 | $3026 | $-1406 |

### FOMC proximity (entry within X trading days)

| Bucket | N | Wins | Losses | Win% | Sum PnL | Mean PnL | Mean Win | Mean Loss |
|--------|---:|---:|---:|---:|---:|---:|---:|---:|
| gt_5d | 19 | 13 | 6 | 68.4% | $37143 | $1955 | $3448 | $-1280 |
| le_1d | 7 | 2 | 5 | 28.6% | $-230 | $-33 | $2824 | $-1176 |
| le_3d | 7 | 3 | 4 | 42.9% | $6999 | $1000 | $3897 | $-1173 |
| le_5d | 6 | 4 | 2 | 66.7% | $9165 | $1528 | $3034 | $-1485 |

## What-if gating — selection period only

Holdout (11 trades) is left unconditioned. Sharpe/MaxDD below are computed from the kept-trade subset over the selection range 2019-01-17 → 2024-01-19.

| Gate | Kept | Removed | Sum PnL kept | Sum PnL removed | Win% kept | Mean PnL kept | Sharpe | MaxDD |
|------|---:|---:|---:|---:|---:|---:|---:|---:|
| QQQ > 100d EMA | 15 | 13 | $19284 | $15124 | 53.3% | $1286 | 1.34 | 15.4% |
| SPY > 200d EMA | 15 | 13 | $19729 | $14679 | 53.3% | $1315 | 1.22 | 16.5% |
| QQQ > 100d EMA AND SPY > 200d EMA | 13 | 15 | $17427 | $16981 | 53.8% | $1341 | 1.21 | 14.2% |
| no RV shock (5d/60d < 2.0) | 27 | 1 | $33230 | $1177 | 55.6% | $1231 | 1.66 | 18.2% |
| no RV elevated (5d/60d < 1.5) | 23 | 5 | $38222 | $-3814 | 65.2% | $1662 | 2.06 | 13.1% |
| IV/HV not crisis | 28 | 0 | $34408 | $0 | 57.1% | $1229 | 1.72 | 17.5% |
| IV percentile not high (<80) | 18 | 10 | $28735 | $5673 | 61.1% | $1596 | 1.68 | 18.2% |
| breadth not narrow (>=50%) | 16 | 12 | $20973 | $13435 | 56.3% | $1311 | 1.52 | 14.5% |
| CPI proximity > 1d | 24 | 4 | $24789 | $9619 | 54.2% | $1033 | 1.36 | 21.4% |
| FOMC proximity > 1d | 22 | 6 | $32226 | $2182 | 63.6% | $1465 | 1.68 | 21.7% |
| CPI proximity > 3d AND FOMC proximity > 3d | 11 | 17 | $17405 | $17003 | 72.7% | $1582 | 1.47 | 12.0% |
| trend ON + no RV elevated + event > 1d | 6 | 22 | $14802 | $19605 | 83.3% | $2467 | 1.41 | 11.0% |

Baseline selection (no gate): N=28, Sum PnL $34408, Sharpe 1.72, MaxDD 17.5%

## Per-trade ledger (appendix)

| # | bucket | entryDate | exitDate | exitType | pnl | qqq>100d | spy>200d | rvShock | iv/hv | ivPct | dCpi | dFomc | breadth |
|---|--------|-----------|----------|----------|----:|:--------:|:--------:|---------|-------|-------|-----:|------:|---------|
| 1 | selection | 2019-01-17 | 2019-03-21 | PROFIT_TARGET | $1689 | N | N | normal | cheap | normal | 4 | 8 | broad |
| 2 | selection | 2019-03-21 | 2019-06-03 | STOP_LOSS | $-653 | Y | Y | normal | normal | normal | 7 | 1 | broad |
| 3 | selection | 2019-06-03 | 2019-06-21 | PROFIT_TARGET | $487 | N | N | mild | normal | high | 7 | 12 | narrow |
| 4 | selection | 2019-06-21 | 2019-12-18 | PROFIT_TARGET | $2173 | Y | Y | normal | cheap | normal | 7 | 2 | broad |
| 5 | selection | 2019-12-18 | 2020-02-10 | PROFIT_TARGET | $1821 | Y | Y | normal | normal | low | 5 | 5 | broad |
| 6 | selection | 2020-02-24 | 2020-02-28 | STOP_LOSS | $-1265 | Y | Y | elevated | normal | high | 6 | 6 | normal |
| 7 | selection | 2020-02-28 | 2020-03-20 | STOP_LOSS | $-1009 | N | N | elevated | normal | high | 8 | 2 | narrow |
| 8 | selection | 2020-03-20 | 2020-04-14 | PROFIT_TARGET | $1177 | N | N | shock | cheap | high | 7 | 4 | narrow |
| 9 | selection | 2020-04-14 | 2020-06-09 | PROFIT_TARGET | $2943 | Y | N | normal | cheap | high | 1 | 11 | broad |
| 10 | selection | 2020-06-09 | 2020-08-17 | PROFIT_TARGET | $3088 | Y | Y | normal | normal | normal | 1 | 1 | broad |
| 11 | selection | 2020-08-24 | 2021-01-25 | PROFIT_TARGET | $4630 | Y | Y | normal | normal | normal | 8 | 16 | broad |
| 12 | selection | 2021-01-25 | 2021-03-08 | STOP_LOSS | $-1320 | Y | Y | normal | normal | normal | 7 | 2 | broad |
| 13 | selection | 2021-03-08 | 2021-06-24 | PROFIT_TARGET | $3828 | N | Y | mild | normal | normal | 2 | 7 | narrow |
| 14 | selection | 2021-06-24 | 2021-11-03 | PROFIT_TARGET | $4395 | Y | Y | normal | normal | low | 10 | 6 | broad |
| 15 | selection | 2021-11-03 | 2022-01-20 | STOP_LOSS | $-1121 | Y | Y | normal | normal | low | 5 | 0 | broad |
| 16 | selection | 2022-01-20 | 2022-02-23 | STOP_LOSS | $-1527 | N | Y | normal | normal | high | 5 | 4 | narrow |
| 17 | selection | 2022-02-23 | 2022-05-09 | STOP_LOSS | $-883 | N | N | normal | normal | high | 8 | 15 | narrow |
| 18 | selection | 2022-05-09 | 2022-06-16 | STOP_LOSS | $-1275 | N | N | elevated | normal | high | 2 | 3 | narrow |
| 19 | selection | 2022-06-16 | 2022-07-29 | PROFIT_TARGET | $2560 | N | N | mild | normal | high | 4 | 1 | narrow |
| 20 | selection | 2022-07-29 | 2022-09-15 | STOP_LOSS | $-1087 | Y | N | mild | normal | normal | 8 | 2 | broad |
| 21 | selection | 2022-09-15 | 2022-10-11 | STOP_LOSS | $-1443 | N | N | elevated | normal | normal | 2 | 4 | narrow |
| 22 | selection | 2022-10-11 | 2023-02-02 | PROFIT_TARGET | $4463 | N | N | normal | normal | high | 2 | 14 | narrow |
| 23 | selection | 2023-02-02 | 2023-03-10 | STOP_LOSS | $-1013 | Y | Y | mild | normal | low | 8 | 1 | broad |
| 24 | selection | 2023-03-10 | 2023-05-16 | PROFIT_TARGET | $3279 | N | N | normal | normal | normal | 2 | 8 | narrow |
| 25 | selection | 2023-05-16 | 2023-06-14 | PROFIT_TARGET | $3104 | Y | Y | normal | normal | low | 4 | 9 | broad |
| 26 | selection | 2023-06-14 | 2023-10-25 | STOP_LOSS | $-680 | Y | Y | normal | normal | low | 1 | 0 | broad |
| 27 | selection | 2023-10-25 | 2023-12-11 | PROFIT_TARGET | $3776 | N | N | mild | normal | normal | 9 | 5 | narrow |
| 28 | selection | 2023-12-11 | 2024-03-01 | PROFIT_TARGET | $4268 | Y | Y | normal | normal | low | 1 | 2 | broad |
| 29 | holdout | 2024-03-01 | 2024-04-19 | STOP_LOSS | $-1383 | Y | Y | normal | normal | normal | 7 | 13 | broad |
| 30 | holdout | 2024-04-19 | 2024-06-10 | PROFIT_TARGET | $4098 | N | Y | normal | normal | high | 7 | 8 | narrow |
| 31 | holdout | 2024-06-10 | 2024-12-04 | PROFIT_TARGET | $5249 | Y | Y | normal | normal | low | 2 | 2 | broad |
| 32 | holdout | 2024-12-04 | 2025-03-03 | STOP_LOSS | $-1571 | Y | Y | normal | cheap | low | 5 | 10 | broad |
| 33 | holdout | 2025-03-03 | 2025-04-03 | STOP_LOSS | $-2250 | N | Y | mild | normal | high | 7 | 12 | narrow |
| 34 | holdout | 2025-04-03 | 2025-05-13 | PROFIT_TARGET | $5955 | N | N | elevated | normal | high | 5 | 11 | narrow |
| 35 | holdout | 2025-05-13 | 2025-08-12 | PROFIT_TARGET | $5361 | Y | Y | normal | cheap | normal | 0 | 4 | broad |
| 36 | holdout | 2025-08-25 | 2025-10-29 | PROFIT_TARGET | $5488 | Y | Y | mild | normal | low | 9 | 16 | broad |
| 37 | holdout | 2025-10-29 | 2025-11-20 | STOP_LOSS | $-2412 | Y | Y | normal | normal | normal | 10 | 0 | broad |
| 38 | holdout | 2025-11-24 | 2026-02-27 | TIME_STOP | $461 | Y | Y | elevated | normal | normal | 7 | 11 | narrow |
| 39 | holdout | 2026-02-27 | 2026-02-27 | TIME_STOP | $-326 | Y | Y | mild | normal | normal | 11 | 21 | narrow |