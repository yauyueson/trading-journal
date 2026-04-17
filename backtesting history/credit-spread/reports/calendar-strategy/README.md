# Calendar Spread Strategy -- Regime-Aware Report

**Date:** 2026-04-07
**Engine:** Post-audit (worst-side fills, honest pricing)
**Commission:** $0 (Robinhood)
**Methodology:** TRUE WFA (252d train / 126d test), per-window optimization
**Config grid:** 264 configs per ticker per window
**Starting Capital:** $10,000

## Design

Bull regime (close>EMA34): put calendar. Bear regime (EMA21<EMA34<EMA55): call calendar. Sideways (NOT bull, NOT bear, trendStrength<threshold): put or call swept.

> **Note:** trendStrength is a close-only directional metric, NOT Wilder ADX. Thresholds calibrated to this metric.

Short DTE: [5,7,14], Long DTE: [14,21,30,45], Deltas: [0.3,0.4,0.5]

---

## Section 1: Per-Ticker OOS Results

| Ticker | OOS Sharpe | CAGR | MaxDD | Trades | Pos Win | Final$ |
|---|---|---|---|---|---|---|
| QQQ | -0.262 | -4.4% | 40.7% | 106 | 4/16 | $6994 |
| SPY | 0.182 | 1.7% | 40.0% | 188 | 8/16 | $11433 |
| IWM | 0.117 | 0.5% | 26.5% | 166 | 10/16 | $10395 |

## Section 2: Window-by-Window

### QQQ

| W# | Period | StartEq | EndEq | PnL | Trades | Config | Train Sharpe |
|---|---|---|---|---|---|---|---|
| 1 | 2018-01-03 to 2018-07-03 | $10000 | $10803 | $803 | 3 | sw|call|d0.3|14/45|ADX20 | 0.61 |
| 2 | 2018-07-05 to 2019-01-03 | $10803 | $10681 | $-122 | 4 | sw|call|d0.3|5/45|ADX25 | 1.86 |
| 3 | 2019-01-04 to 2019-07-05 | $10681 | $10681 | $0 | 2 | sw|call|d0.4|5/45|ADX25 | 1.68 |
| 4 | 2019-07-08 to 2020-01-03 | $10681 | $10511 | $-170 | 8 | sw|call|d0.3|5/30|ADX20 | 0.71 |
| 5 | 2020-01-06 to 2020-07-06 | $10511 | $10511 | $0 | 0 | sw|call|d0.4|7/21|ADX20 | 1.93 |
| 6 | 2020-07-07 to 2021-01-04 | $10511 | $10640 | $129 | 4 | sw|call|d0.5|7/30|ADX25 | 2.21 |
| 7 | 2021-01-05 to 2021-07-06 | $10640 | $10265 | $-375 | 31 | bull|put|d0.4|5/30 | 1.11 |
| 8 | 2021-07-07 to 2022-01-03 | $10265 | $10186 | $-79 | 4 | sw|call|d0.3|14/30|ADX25 | 1.16 |
| 9 | 2022-01-04 to 2022-07-06 | $10186 | $11588 | $1402 | 11 | sw|put|d0.3|5/14|ADX20 | 0.85 |
| 10 | 2022-07-07 to 2023-01-04 | $11588 | $11025 | $-563 | 21 | bull|put|d0.3|5/21 | 1.33 |
| 11 | 2023-01-05 to 2023-07-07 | $11025 | $9740 | $-1285 | 3 | sw|put|d0.3|7/21|ADX18 | 1.30 |
| 12 | 2023-07-10 to 2024-01-05 | $9740 | $8275 | $-1465 | 5 | sw|call|d0.3|14/30|ADX18 | 1.80 |
| 13 | 2024-01-08 to 2024-07-09 | $8275 | $7509 | $-766 | 6 | sw|put|d0.5|5/45|ADX18 | 1.67 |
| 14 | 2024-07-10 to 2025-01-07 | $7509 | $7509 | $0 | 0 | bear|call|d0.3|7/30 | 1.08 |
| 15 | 2025-01-08 to 2025-07-11 | $7509 | $6994 | $-515 | 4 | sw|call|d0.3|14/30|ADX25 | 2.29 |
| 16 | 2025-07-14 to 2026-01-09 | $6994 | $6994 | $0 | 0 | sw|call|d0.3|5/45|ADX20 | 1.54 |

### SPY

| W# | Period | StartEq | EndEq | PnL | Trades | Config | Train Sharpe |
|---|---|---|---|---|---|---|---|
| 1 | 2018-01-03 to 2018-07-03 | $10000 | $10561 | $561 | 10 | sw|call|d0.3|5/21|ADX25 | 1.72 |
| 2 | 2018-07-05 to 2019-01-03 | $10561 | $8527 | $-2034 | 11 | bear|call|d0.4|7/30 | 1.73 |
| 3 | 2019-01-04 to 2019-07-05 | $8527 | $7807 | $-720 | 1 | bear|call|d0.5|14/21 | 2.08 |
| 4 | 2019-07-08 to 2020-01-03 | $7807 | $8498 | $691 | 32 | bull|put|d0.5|5/45 | 1.61 |
| 5 | 2020-01-06 to 2020-07-06 | $8498 | $8272 | $-226 | 2 | sw|call|d0.4|14/45|ADX18 | 1.69 |
| 6 | 2020-07-07 to 2021-01-04 | $8272 | $8057 | $-215 | 13 | bull|put|d0.5|14/30 | 2.50 |
| 7 | 2021-01-05 to 2021-07-06 | $8057 | $8873 | $816 | 14 | bull|put|d0.5|14/45 | 1.85 |
| 8 | 2021-07-07 to 2022-01-03 | $8873 | $8703 | $-170 | 12 | bull|put|d0.5|14/45 | 1.52 |
| 9 | 2022-01-04 to 2022-07-06 | $8703 | $7681 | $-1022 | 5 | bull|put|d0.5|14/45 | 1.32 |
| 10 | 2022-07-07 to 2023-01-04 | $7681 | $8087 | $406 | 5 | sw|put|d0.4|14/21|ADX25 | 0.74 |
| 11 | 2023-01-05 to 2023-07-07 | $8087 | $8211 | $124 | 9 | sw|put|d0.3|5/30|ADX20 | 2.10 |
| 12 | 2023-07-10 to 2024-01-05 | $8211 | $8311 | $100 | 6 | sw|put|d0.4|5/45|ADX18 | 2.12 |
| 13 | 2024-01-08 to 2024-07-09 | $8311 | $8123 | $-188 | 4 | sw|put|d0.4|5/45|ADX20 | 1.96 |
| 14 | 2024-07-10 to 2025-01-07 | $8123 | $8968 | $845 | 34 | bull|put|d0.5|5/14 | 1.49 |
| 15 | 2025-01-08 to 2025-07-11 | $8968 | $12014 | $3046 | 27 | bull|put|d0.5|5/14 | 1.67 |
| 16 | 2025-07-14 to 2026-01-09 | $12014 | $11433 | $-581 | 3 | sw|put|d0.4|7/45|ADX20 | 1.64 |

### IWM

| W# | Period | StartEq | EndEq | PnL | Trades | Config | Train Sharpe |
|---|---|---|---|---|---|---|---|
| 1 | 2018-01-03 to 2018-07-03 | $10000 | $11212 | $1212 | 21 | bull|put|d0.4|7/21 | 1.69 |
| 2 | 2018-07-05 to 2019-01-03 | $11212 | $11422 | $211 | 6 | sw|put|d0.3|7/30|ADX20 | 1.15 |
| 3 | 2019-01-04 to 2019-07-05 | $11422 | $11892 | $470 | 4 | sw|call|d0.4|5/21|ADX18 | 1.61 |
| 4 | 2019-07-08 to 2020-01-03 | $11892 | $12427 | $535 | 4 | sw|put|d0.3|7/30|ADX20 | 0.98 |
| 5 | 2020-01-06 to 2020-07-06 | $12427 | $10965 | $-1462 | 8 | bear|call|d0.3|7/45 | 1.73 |
| 6 | 2020-07-07 to 2021-01-04 | $10965 | $9921 | $-1044 | 4 | sw|put|d0.4|14/45|ADX25 | 2.14 |
| 7 | 2021-01-05 to 2021-07-06 | $9921 | $10619 | $698 | 24 | bull|put|d0.4|5/21 | 2.20 |
| 8 | 2021-07-07 to 2022-01-03 | $10619 | $10761 | $142 | 8 | sw|call|d0.3|7/45|ADX20 | 2.69 |
| 9 | 2022-01-04 to 2022-07-06 | $10761 | $10634 | $-127 | 12 | bear|call|d0.4|14/45 | 1.98 |
| 10 | 2022-07-07 to 2023-01-04 | $10634 | $11888 | $1254 | 8 | sw|put|d0.3|14/45|ADX25 | 2.02 |
| 11 | 2023-01-05 to 2023-07-07 | $11888 | $13668 | $1780 | 12 | bear|call|d0.4|7/45 | 2.01 |
| 12 | 2023-07-10 to 2024-01-05 | $13668 | $11942 | $-1726 | 10 | bear|call|d0.4|7/45 | 3.32 |
| 13 | 2024-01-08 to 2024-07-09 | $11942 | $13615 | $1673 | 26 | bull|put|d0.5|5/45 | 1.73 |
| 14 | 2024-07-10 to 2025-01-07 | $13615 | $12019 | $-1596 | 9 | sw|put|d0.4|5/30|ADX18 | 2.23 |
| 15 | 2025-01-08 to 2025-07-11 | $12019 | $12726 | $707 | 5 | sw|call|d0.3|5/30|ADX25 | 2.63 |
| 16 | 2025-07-14 to 2026-01-09 | $12726 | $10395 | $-2331 | 5 | sw|call|d0.4|14/21|ADX25 | 1.92 |

## Section 3: IWM Sideways-Only Calendar (no bear overlap)

IWM all-regime calendar selected bear configs in 4/16 windows, overlapping with existing IWM bear call spread. Sideways-only version restricts to 198 sideways configs.

| Variant | OOS Sharpe | CAGR | MaxDD | Trades | Final$ |
|---|---|---|---|---|---|
| IWM all-regime | 0.117 | 0.5% | 26.5% | 166 | $10395 |
| IWM sideways-only | -0.195 | -3.8% | 27.9% | 91 | $7357 |

### IWM Sideways-Only Window Detail

| W# | Period | StartEq | EndEq | PnL | Trades | Config | Train Sharpe |
|---|---|---|---|---|---|---|---|
| 1 | 2018-01-03 to 2018-07-03 | $10000 | $8223 | $-1777 | 3 | sw|call|d0.5|14/30|ADX18 | 0.89 |
| 2 | 2018-07-05 to 2019-01-03 | $8223 | $8360 | $137 | 6 | sw|put|d0.3|7/30|ADX20 | 1.15 |
| 3 | 2019-01-04 to 2019-07-05 | $8360 | $8698 | $338 | 4 | sw|call|d0.4|5/21|ADX18 | 1.61 |
| 4 | 2019-07-08 to 2020-01-03 | $8698 | $9029 | $331 | 4 | sw|put|d0.3|7/30|ADX20 | 0.98 |
| 5 | 2020-01-06 to 2020-07-06 | $9029 | $8222 | $-807 | 2 | sw|put|d0.3|14/30|ADX18 | 1.54 |
| 6 | 2020-07-07 to 2021-01-04 | $8222 | $7494 | $-728 | 4 | sw|put|d0.4|14/45|ADX25 | 2.14 |
| 7 | 2021-01-05 to 2021-07-06 | $7494 | $8274 | $780 | 7 | sw|call|d0.3|7/30|ADX25 | 1.57 |
| 8 | 2021-07-07 to 2022-01-03 | $8274 | $8170 | $-104 | 8 | sw|call|d0.3|7/45|ADX20 | 2.69 |
| 9 | 2022-01-04 to 2022-07-06 | $8170 | $7671 | $-499 | 8 | sw|call|d0.5|7/30|ADX20 | 1.67 |
| 10 | 2022-07-07 to 2023-01-04 | $7671 | $8555 | $884 | 8 | sw|put|d0.3|14/45|ADX25 | 2.02 |
| 11 | 2023-01-05 to 2023-07-07 | $8555 | $9357 | $802 | 6 | sw|put|d0.3|14/45|ADX25 | 1.98 |
| 12 | 2023-07-10 to 2024-01-05 | $9357 | $9512 | $155 | 3 | sw|put|d0.4|14/45|ADX25 | 1.44 |
| 13 | 2024-01-08 to 2024-07-09 | $9512 | $9627 | $115 | 9 | sw|put|d0.4|14/45|ADX25 | 1.38 |
| 14 | 2024-07-10 to 2025-01-07 | $9627 | $8600 | $-1027 | 9 | sw|put|d0.4|5/30|ADX18 | 2.23 |
| 15 | 2025-01-08 to 2025-07-11 | $8600 | $8996 | $396 | 5 | sw|call|d0.3|5/30|ADX25 | 2.63 |
| 16 | 2025-07-14 to 2026-01-09 | $8996 | $7357 | $-1639 | 5 | sw|call|d0.4|14/21|ADX25 | 1.92 |

## Section 4: Portfolio Combinations

| Portfolio | Sharpe | CAGR | MaxDD | Final$ | MinEq | Trades |
|---|---|---|---|---|---|---|
| QQQ bull only | 0.687 | 18.5% | 39.6% | $39069 | $6964 | 552 |
| QQQ bull + all 3 bear | 0.985 | 39.9% | 47.9% | $147754 | $6976 | 809 |
| BB + IWM calendar (all-regime) | 1.594 | 40.0% | 46.3% | $148149 | $5707 | 975 |
| BB + IWM calendar (sw-only) | 1.539 | 39.6% | 63.4% | $145111 | $3852 | 900 |

## Caveats

1. TRUE WFA: per-window train/test, no look-ahead
2. Calendar exit = close both legs at near-term expiry (no rolling)
3. Debit trade: max loss = premium paid
4. Far-term leg sold at bid (worst side) at exit
5. Trend gate is close-only directional metric (NOT Wilder ADX) -- no OHLC available from option chain snapshots
6. Cache-only: zero API calls
7. IWM sideways-only avoids overlap with existing IWM bear call spread
