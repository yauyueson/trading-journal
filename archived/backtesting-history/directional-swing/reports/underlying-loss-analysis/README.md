# Underlying Loss / Concentration Analysis

Run: `data/runs/2026-03-28T02-40-26-544-unified-directional.json`

## Top Line
| Metric | Value |
| --- | --- |
| OOS Sharpe | 0.70 |
| OOS Total PnL | $33,790 |
| OOS Win Rate | 43.2% |
| OOS Max DD | 6.8% |
| Trades | 301 |
| Winners / Losers | 130 / 171 |
| Avg Winner / Avg Loser | $754 / -$375 |

## Concentration Snapshot
| Question | Answer |
| --- | --- |
| Top 5 losing trades share of gross losses | 12.4% |
| Top 10 losing trades share of gross losses | 21.3% |
| Top 5 winning trades share of gross profits | 19.4% |
| Loss concentration gate failed because... | all net losses were isolated to the mid-cycle bucket, even though total strategy PnL stayed positive |

## Ticker Concentration
| Ticker | Trades | Total PnL | Win Rate | Share of Gross Losses |
| --- | --- | --- | --- | --- |
| AMD | 15 | -$1,401 | 33.3% | 11.8% |
| SPY | 29 | -$488 | 41.4% | 5.7% |
| IWM | 19 | -$430 | 31.6% | 5.3% |
| AAPL | 26 | $940 | 34.6% | 8.8% |
| MSFT | 28 | $952 | 35.7% | 6.8% |
| QQQ | 24 | $1,243 | 50.0% | 4.9% |
| AMZN | 20 | $1,333 | 45.0% | 6.7% |
| JPM | 21 | $1,475 | 42.9% | 6.0% |
| GOOG | 21 | $2,274 | 47.6% | 5.2% |
| NFLX | 19 | $3,311 | 47.4% | 6.6% |
| META | 20 | $4,532 | 55.0% | 5.1% |
| TSLA | 17 | $5,302 | 41.2% | 13.4% |
| GS | 24 | $5,496 | 45.8% | 6.6% |
| NVDA | 18 | $9,253 | 55.6% | 7.2% |

## Source / Routing Concentration
| Source | Trades | Total PnL | Win Rate | Avg Loser | Avg Winner |
| --- | --- | --- | --- | --- | --- |
| pb8 | 219 | $21,641 | 44.3% | -$438 | $774 |
| pb21 | 82 | $12,150 | 40.2% | -$220 | $694 |

## Regime / Window Concentration
| Bucket | Trades | Total PnL | Win Rate | Share of Gross Losses |
| --- | --- | --- | --- | --- |
| W0-1 COVID Recovery | 47 | $13,948 | 48.9% | 11.8% |
| W2,5-8 Mid-Cycle | 124 | $4,440 | 42.7% | 48.4% |
| W3-4 2022 Bear | 48 | $3,252 | 43.8% | 23.0% |
| W9-11 2024-25 Bull | 82 | $12,150 | 40.2% | 16.8% |

| Exit Type | Trades | Total PnL | Win Rate | Avg PnL |
| --- | --- | --- | --- | --- |
| TIME_STOP | 123 | $90,702 | 88.6% | $737 |
| UNDERLYING_EXIT | 176 | -$58,083 | 10.8% | -$330 |
| END_OF_WINDOW | 2 | $1,171 | 100.0% | $586 |

## Loser Path Anatomy
| Group | Count | MFE P25 | MFE Median | MFE P75 | MAE P25 | MAE Median | MAE P75 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Losers | 171 | $0 | $54 | $211 | -$477 | -$312 | -$196 |
| Winners | 130 | $519 | $807 | $1,219 | -$128 | -$20 | $0 |

| Loser Metric | Value |
| --- | --- |
| Losers with positive MFE > $100 | 39.8% |
| Losers with positive MFE > $250 | 19.3% |
| Losers with positive MFE > $500 | 5.8% |
| Median loser first negative day | 1 |
| Median loser trough day | 5 |

### Loss Patterns
| Pattern | Count | Avg Final PnL | Avg MFE | Avg MAE | Avg Trough Day |
| --- | --- | --- | --- | --- | --- |
| late_reversal | 2 | -$120 | $742 | -$392 | 3.0 |
| gap | 27 | -$468 | $60 | -$532 | 2.2 |
| drift | 113 | -$357 | $69 | -$373 | 5.7 |
| whipsaw | 29 | -$379 | $458 | -$410 | 10.6 |

## Drawdown Concentration
| Metric | Value |
| --- | --- |
| Peak Date | 2023-07-19 |
| Trough Date | 2023-11-15 |
| Peak Equity | $127,638 |
| Trough Equity | $118,932 |
| Max Drawdown | 6.8% |

### Worst Ticker Contributors During Max DD
| Ticker | PnL Contribution |
| --- | --- |
| TSLA | -$2,421 |
| AAPL | -$1,671 |
| NFLX | -$1,458 |
| AMZN | -$904 |
| SPY | -$593 |
| JPM | -$583 |
| QQQ | -$489 |
| GOOG | -$452 |

### Source Contributors During Max DD
| Source | PnL Contribution |
| --- | --- |
| pb8 | -$8,706 |

### Worst Daily PnL Hits Inside Max DD
| Date | Portfolio Daily PnL |
| --- | --- |
| 2023-07-20 | -$1,576 |
| 2023-11-14 | -$1,188 |
| 2023-08-29 | -$887 |
| 2023-11-02 | -$673 |
| 2023-08-04 | -$570 |
| 2023-08-02 | -$521 |
| 2023-10-06 | -$486 |
| 2023-10-16 | -$421 |
| 2023-11-13 | -$394 |
| 2023-08-25 | -$392 |

## Named Losses
| Ticker | Entry | Exit | Source | Window | Exit Type | Hold | Final PnL | MFE | MAE | Pattern |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AMD | 2022-10-24 | 2022-11-11 | pb8 | W5 | UNDERLYING_EXIT | 18 | -$2,329 | $17 | -$2,329 | drift |
| AMD | 2022-07-13 | 2022-07-20 | pb8 | W4 | UNDERLYING_EXIT | 7 | -$1,536 | $0 | -$1,536 | drift |
| TSLA | 2023-02-22 | 2023-03-09 | pb8 | W5 | UNDERLYING_EXIT | 15 | -$1,391 | $337 | -$1,391 | whipsaw |
| TSLA | 2022-04-13 | 2022-04-27 | pb8 | W4 | UNDERLYING_EXIT | 14 | -$1,378 | $57 | -$1,428 | drift |
| TSLA | 2023-11-10 | 2023-11-15 | pb8 | W7 | UNDERLYING_EXIT | 5 | -$1,313 | $0 | -$1,313 | gap |
| NVDA | 2021-12-02 | 2021-12-14 | pb8 | W3 | UNDERLYING_EXIT | 12 | -$1,179 | $94 | -$1,234 | drift |
| AMZN | 2023-01-04 | 2023-01-11 | pb8 | W5 | UNDERLYING_EXIT | 7 | -$1,169 | $237 | -$1,169 | drift |
| TSLA | 2024-07-18 | 2024-07-25 | pb8 | W8 | UNDERLYING_EXIT | 7 | -$1,163 | $91 | -$1,334 | drift |
| NVDA | 2022-03-31 | 2022-04-07 | pb8 | W3 | UNDERLYING_EXIT | 7 | -$1,128 | $27 | -$1,128 | drift |
| TSLA | 2025-06-04 | 2025-06-06 | pb21 | W10 | UNDERLYING_EXIT | 2 | -$1,112 | $0 | -$1,426 | gap |

### Biggest Whipsaws / Late Reversals
| Ticker | Entry | Exit | Source | Final PnL | MFE | Peak Day | Pattern |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AMZN | 2022-02-24 | 2022-03-17 | pb8 | -$389 | $1,014 | 8 | whipsaw |
| AMD | 2020-08-27 | 2020-09-08 | pb8 | -$610 | $1,000 | 3 | whipsaw |
| MSFT | 2022-10-28 | 2022-11-11 | pb8 | -$477 | $917 | 4 | whipsaw |
| AMD | 2025-11-06 | 2025-11-18 | pb21 | -$312 | $891 | 4 | whipsaw |
| NFLX | 2023-07-14 | 2023-07-27 | pb8 | -$650 | $807 | 3 | whipsaw |
| NFLX | 2020-04-27 | 2020-05-26 | pb8 | -$157 | $779 | 14 | late_reversal |
| META | 2021-04-15 | 2021-05-13 | pb8 | -$83 | $705 | 10 | late_reversal |
| AMD | 2021-03-22 | 2021-04-01 | pb8 | -$98 | $535 | 6 | whipsaw |
| QQQ | 2022-08-09 | 2022-08-29 | pb8 | -$400 | $504 | 4 | whipsaw |
| AMD | 2022-04-28 | 2022-05-19 | pb8 | -$784 | $460 | 1 | whipsaw |

## Bottom Line
- The stock strategy is profitable, but the downside is concentrated in a small set of tickers and one broad mid-cycle bucket.
- The biggest losers are not frequent gap disasters; most are drifts, with a smaller set of real whipsaws that give back meaningful open profit.
- `pb8` remains the broad workhorse. `pb21` contributes fewer trades but materially positive PnL. Concentration is a stock-selection / regime problem, not a blend problem.
- Before touching options again, the next decision should be whether to accept this concentration profile as the stock baseline or add a stock-only risk overlay targeted at the worst drawdown contributors.