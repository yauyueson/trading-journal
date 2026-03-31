# Directional Swing Report

| Config | Value |
| --- | --- |
| Strategy | underlying |
| Tickers | SPY, QQQ, AMD, TSLA, AAPL, JPM, NVDA, AMZN, META, NFLX, GS |
| Date Range | 2018-01-01 -> 2026-02-28 |
| Train/Step/Purge | 504/126/65 |

## Underlying Benchmark

| Metric | Value |
| --- | --- |
| OOS Sharpe | 0.50 |
| OOS Total PnL | $21,868 |
| OOS Win Rate | 33.4% |
| OOS Max DD | 8.7% |
| Trades | 350 |
| Avg Winner | $838 |
| Avg Loser | $-327 |

### Gate
- OOS Sharpe: PASS (0.4965596644703897 vs > 0.40)
- OOS Total PnL: PASS (21867.590090735972 vs > 0)
- Positive Windows: PASS (9 vs >= 7/12)
- Regime Sharpe Floor: PASS (-0.05753593588062903 vs > -1.0)
- Loss Concentration: FAIL (0.6664864427975074 vs <= 50%)
- Drawdown Concentration: FAIL (8.878975728469534 vs <= 1.5x median regime DD)

### Per Window
| Window | Train Start | OOS Start | Train Sharpe | OOS Sharpe | OOS PnL | WR | Trades | Best Config |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| W0 | 2018-01-02 | 2020-04-07 | 1.15 | 2.88 | $13,195 | 68.0% | 25 | pb8/ema34/c2/h15/mp3 |
| W1 | 2018-07-03 | 2020-10-06 | 1.63 | 0.32 | $657 | 33.3% | 30 | pb8/ema34/c2/h15/mp3 |
| W2 | 2019-01-03 | 2021-04-08 | 2.02 | 1.29 | $1,473 | 23.1% | 26 | pb21/ema21/c1/h20/mp3 |
| W3 | 2019-07-05 | 2021-10-06 | 1.67 | -0.52 | $-947 | 16.7% | 30 | pb21/ema21/c1/h20/mp3 |
| W4 | 2020-01-03 | 2022-04-06 | 1.49 | 0.67 | $1,055 | 31.6% | 19 | pb21/ema21/c1/h20/mp3 |
| W5 | 2020-07-06 | 2022-10-06 | 1.03 | 0.44 | $1,046 | 33.3% | 30 | pb8/ema21/c1/h20/mp3 |
| W6 | 2021-01-04 | 2023-04-10 | 0.97 | -0.07 | $-1,232 | 34.6% | 26 | pb8/ema34/c2/h20/mp3 |
| W7 | 2021-07-06 | 2023-10-09 | 1.25 | 0.83 | $4,453 | 47.8% | 23 | pb8/ema21/c2/h20/mp3 |
| W8 | 2022-01-03 | 2024-04-10 | 0.90 | 0.37 | $483 | 30.2% | 53 | pb8/ema21/c1/h15/mp5 |
| W9 | 2022-07-06 | 2024-10-09 | 1.61 | 1.15 | $4,717 | 36.0% | 25 | pb8/ema21/c2/h20/mp3 |
| W10 | 2023-01-04 | 2025-04-11 | 1.18 | 0.84 | $1,322 | 33.3% | 33 | pb8/ema21/c1/h15/mp3 |
| W11 | 2023-07-07 | 2025-10-13 | 0.63 | -2.16 | $-4,355 | 23.3% | 30 | pb8/ema21/c2/h15/mp3 |

### Selected Routing Breakdown
| Routing | Windows Selected | Trades | Total PnL | Avg OOS Sharpe | Win Rate |
| --- | --- | --- | --- | --- | --- |
| pb21 | 3 | 75 | $1,581 | 0.48 | 22.7% |
| pb8 | 9 | 275 | $20,287 | 0.51 | 36.4% |

### Executed Signal Source Breakdown
| Signal Source | Trades | Total PnL | Win Rate |
| --- | --- | --- | --- |
| pb21 | 75 | $1,581 | 22.7% |
| pb8 | 275 | $20,287 | 36.4% |

### Regime Breakdown
| Bucket | Trades | Total PnL | Avg OOS Sharpe | Win Rate |
| --- | --- | --- | --- | --- |
| W0-1 COVID Recovery | 55 | $13,852 | 1.60 | 49.1% |
| W2,5-8 Mid-Cycle | 158 | $6,223 | 0.57 | 32.9% |
| W3-4 2022 Bear | 49 | $108 | 0.08 | 22.4% |
| W9-11 2024-25 Bull | 88 | $1,685 | -0.06 | 30.7% |

### Ticker Breakdown
| Ticker | Trades | Total PnL | Win Rate |
| --- | --- | --- | --- |
| AAPL | 29 | $1,961 | 37.9% |
| AMD | 28 | $3,026 | 39.3% |
| AMZN | 35 | $-575 | 31.4% |
| GS | 31 | $5,603 | 38.7% |
| JPM | 38 | $-675 | 26.3% |
| META | 29 | $1,563 | 34.5% |
| NFLX | 27 | $-1,838 | 29.6% |
| NVDA | 32 | $2,836 | 31.3% |
| QQQ | 32 | $1,119 | 37.5% |
| SPY | 37 | $-598 | 27.0% |
| TSLA | 32 | $9,444 | 37.5% |$17,539 | 35.5% |