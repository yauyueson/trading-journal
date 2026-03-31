# Option-Native Swing Report

## Top Line
| Metric | Value |
| --- | --- |
| Stage | stage0 |
| OOS Sharpe | 0.07 |
| OOS Total PnL | $1,840 |
| OOS Win Rate | 43.2% |
| OOS Max DD | 12.5% |
| Trades | 183 |
| Shadow Sharpe | 0.31 |
| Shadow Total PnL | $15,017 |
| Wrapper Cost Drag | $-13,177 |

## Gate
- Fill Rate: FAIL (0.23 vs >= 85%)
- Median Entry Spread: PASS (0.01 vs <= 5%)
- P75 Entry Spread: PASS (0.02 vs <= 8%)
- Synthetic Mark Rate: PASS (0.00 vs <= 5%)
- OOS Total PnL: PASS (1840 vs > 0)
- OOS Max DD: PASS (13 vs < 20%)
- Wrapper Cost Drag: FAIL (-0.88 vs >= -25% of shadow PnL)

## Per Window
| Window | Train Start | OOS Start | Train Sharpe | OOS Sharpe | Option PnL | Shadow PnL | Trades | Best Config |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| W0 | 2018-01-02 | 2020-04-07 | 1.31 | 2.50 | $10,863 | $13,009 | 16 | pb8/dte50_70/delta70_80/tp40/ema34/c2/h15/iv<=100/spr<=10/mp3 |
| W1 | 2018-07-03 | 2020-10-06 | 1.69 | 0.01 | $627 | $2,683 | 22 | pb8/dte50_70/delta70_80/tp40/ema34/c2/h15/iv<=100/spr<=10/mp3 |
| W2 | 2019-01-03 | 2021-04-08 | 1.80 | -1.12 | $-4,956 | $-2,684 | 31 | pb8/dte35_50/delta70_80/tp25/ema34/c2/h15/iv<=100/spr<=10/mp3 |
| W3 | 2019-07-05 | 2021-10-06 | 1.24 | -0.09 | $-1,589 | $856 | 28 | pb8/dte35_50/delta75_85/tp40/ema34/c2/h15/iv<=100/spr<=10/mp3 |
| W4 | 2020-01-03 | 2022-04-06 | 0.79 | -0.85 | $-265 | $1,574 | 30 | pb8/dte35_50/delta75_85/tp40/ema34/c2/h15/iv<=100/spr<=10/mp3 |
| W5 | 2020-07-06 | 2022-10-06 | 1.03 | 0.81 | $462 | $1,062 | 15 | pb21/dte35_50/delta75_85/tp40/ema34/c2/h15/iv<=100/spr<=10/mp3 |
| W6 | 2021-01-04 | 2023-04-10 | 1.08 | -0.44 | $-988 | $-833 | 13 | pb21/dte50_70/delta70_80/tp40/ema34/c2/h10/iv<=100/spr<=10/mp3 |
| W7 | 2021-07-06 | 2023-10-09 | 1.32 | -1.35 | $-962 | $-710 | 5 | pb21/dte50_70/delta70_80/tp40/ema34/c2/h10/iv<=100/spr<=10/mp3 |
| W8 | 2022-01-03 | 2024-04-10 | 0.61 | 0.39 | $1,001 | $1,326 | 7 | pb21/dte50_70/delta75_85/tp25/ema34/c2/h15/iv<=100/spr<=10/mp3 |
| W9 | 2022-07-06 | 2024-10-09 | 0.85 | -0.71 | $-979 | $-693 | 8 | pb21/dte50_70/delta70_80/tp25/ema21/c2/h10/iv<=100/spr<=10/mp3 |
| W10 | 2023-01-04 | 2025-04-11 | 1.13 | 1.40 | $520 | $616 | 1 | pb21/dte50_70/delta75_85/tp25/ema21/c2/h15/iv<=100/spr<=10/mp3 |
| W11 | 2023-07-07 | 2025-10-13 | 0.71 | -1.91 | $-1,893 | $-1,188 | 7 | pb8/dte50_70/delta70_80/tp25/ema34/c2/h10/iv<=100/spr<=10/mp3 |

## DTE Band Comparison
| Band | Option PnL | Shadow PnL | Cost Drag |
| --- | --- | --- | --- |
| 35_50 | $-6,963 | $384 | $-7,347 |
| 50_70 | $8,803 | $14,633 | $-5,830 |

## Delta Band Comparison
| Entry Delta Bucket | Trades | Option PnL |
| --- | --- | --- |
| -76_-66 | 1 | $-1,001 |
| -77_-67 | 2 | $409 |
| -78_-68 | 4 | $-419 |
| -79_-69 | 3 | $-1,646 |
| -80_-70 | 11 | $-5,365 |
| -81_-71 | 7 | $-1,818 |
| -82_-72 | 2 | $-659 |
| -83_-73 | 5 | $3,315 |
| -84_-74 | 6 | $5,645 |
| -85_-75 | 15 | $-8,033 |
| -86_-76 | 7 | $-91 |
| -87_-77 | 6 | $-3,029 |
| -88_-78 | 2 | $408 |
| -90_-80 | 1 | $-129 |
| 65_75 | 1 | $225 |
| 67_77 | 4 | $-1,178 |
| 68_78 | 7 | $3,433 |
| 69_79 | 6 | $-134 |
| 70_80 | 33 | $11,901 |
| 71_81 | 10 | $5,197 |
| 72_82 | 8 | $-2,489 |
| 73_83 | 8 | $-1,006 |
| 74_84 | 4 | $-1,183 |
| 75_85 | 19 | $7 |
| 76_86 | 6 | $1,379 |
| 77_87 | 3 | $-536 |
| 78_88 | 1 | $-1,518 |
| 79_89 | 1 | $153 |

## Ticker Breakdown
| Ticker | Option PnL | Shadow PnL | Cost Drag |
| --- | --- | --- | --- |
| AAPL | $9,943 | $10,294 | $-352 |
| AMD | $7,291 | $7,672 | $-381 |
| AMZN | $-2,575 | $-2,330 | $-245 |
| GOOG | $-995 | $-814 | $-181 |
| GS | $-4,786 | $-3,367 | $-1,419 |
| IWM | $2,014 | $4,389 | $-2,374 |
| JPM | $-3,840 | $-3,228 | $-612 |
| META | $-3,435 | $-1,374 | $-2,062 |
| MSFT | $1,398 | $5,057 | $-3,660 |
| NFLX | $591 | $698 | $-107 |
| NVDA | $4,084 | $3,943 | $141 |
| QQQ | $-507 | $509 | $-1,016 |
| SPY | $-5,938 | $-5,167 | $-771 |
| TSLA | $-1,404 | $-1,265 | $-139 |

## Regime Breakdown
| Bucket | Trades | Option PnL | Shadow PnL | Avg OOS Sharpe |
| --- | --- | --- | --- | --- |
| W0-1 COVID Recovery | 38 | $11,490 | $15,691 | 1.25 |
| W2,5-8 Mid-Cycle | 71 | $-5,443 | $-1,839 | -0.34 |
| W3-4 2022 Bear | 58 | $-1,854 | $2,430 | -0.47 |
| W9-11 2024-25 Bull | 16 | $-2,353 | $-1,265 | -0.41 |

## Fill / Skip Breakdown
| Metric | Value |
| --- | --- |
| Accepted Trades | 183 |
| Portfolio Capacity Skips | 332 |
| Portfolio Premium Cap Skips | 160 |
| CHAIN_MISSING | 4 |
| LOW_OI | 96 |
| NO_BUDGET | 402 |
| NO_CONTRACT | 109 |
| WIDE_SPREAD | 1 |

## Spread / OI / Synthetic
| Metric | Value |
| --- | --- |
| Fill Rate | 23.0% |
| Median Entry Spread % | 1.2% |
| P75 Entry Spread % | 2.0% |
| Median Entry OI | 910 |
| Synthetic Mark Rate | 0.0% |

## Delta Drift
| Metric | Value |
| --- | --- |
| Avg Peak |Delta Drift| | 0.13 |
| % Trades Peak Drift >= 0.15 | 25.1% |

## Wrapper vs Shadow
| Metric | Value |
| --- | --- |
| Option PnL | $1,840 |
| Shadow PnL | $15,017 |
| Cost Drag | $-13,177 |
| Avg Cost Drag / Trade | $-72 |
| Option Sharpe | 0.07 |
| Shadow Sharpe | 0.31 |

## Final Verdict
The option wrapper failed the current stage gate. On the current evidence, the stock benchmark remains the cleaner expression of the edge.