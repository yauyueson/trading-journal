# BCD rotation WFA — v1

Generated: 2026-04-25T15:53:26.874Z

## Question

Does liquidity-filtered mega-cap BCD rotation beat or diversify QQQ-only BCD under the same WFA discipline?

## Setup

- **Universe:** 23 tickers (BCD Tier A+B from liquidity scorecard, post-backfill 2026-04-25): AMD, MSFT, AAPL, JPM, META, ORCL, NVDA, IWM, CRM, BA, TSLA, CRWD, AMZN, GS, NFLX, AVGO, PANW, COST, LULU, SHOP, GOOG, ANET, NOW
- **Strategy structure:** BCD F1 verbatim — long δ 0.50, short δ 0.20, DTE 30-60, PT 50%, max hold 45d, min exit DTE 7, bid/ask fills
- **Rotation rule:** every 10 trading days, top 3 eligible tickers by (126d return − 21d return) / 63d realized vol
- **WFA:** 252 train / 126 forward / 10 purge / rolling, 10 selection + 5 holdout windows
- **Capital:** rotation $6,000 (3 slots × $2,000/slot), baseline $2,000 × 1 slot
- **No gates** in primary rotation. Optional variant adds RV5/RV60 ≥ 1.5 skip on QQQ.
- **Holdout boundary:** 2024-01-22

## Headline comparison

### Selection (everything before holdout)

| Strategy | Trades | Win% | Sharpe | MaxDD | PnL | Sharpe Δ | DD Δ | Corr to baseline |
|----------|-------:|-----:|-------:|------:|----:|---------:|-----:|-----------------:|
| QQQ-only baseline (F1 anchor) | 59 | 64.4% | 0.97 | 39.8% | $7,165 | — | — | — |
| Rotation top-3 | 154 | 49.4% | 0.90 | 70.8% | $27,802 | -0.07 | 31.0pp | 0.36 |
| Rotation top-3 + RV filter | 149 | 49.0% | 0.86 | 73.1% | $26,456 | -0.11 | 33.3pp | 0.36 |

### Holdout (last 5 windows)

| Strategy | Trades | Win% | Sharpe | MaxDD | PnL | Sharpe Δ | DD Δ | Corr to baseline |
|----------|-------:|-----:|-------:|------:|----:|---------:|-----:|-----------------:|
| QQQ-only baseline (F1 anchor) | 25 | 60.0% | 1.22 | 14.3% | $5,497 | — | — | — |
| Rotation top-3 | 72 | 48.6% | 0.61 | 21.5% | $8,980 | -0.61 | 7.2pp | 0.52 |
| Rotation top-3 + RV filter | 70 | 48.6% | 0.53 | 22.2% | $7,376 | -0.69 | 7.9pp | 0.52 |

## Per-ticker contribution (Rotation top-3)

| Ticker | Picks | Trades | Wins | Losses | Win% | Sum PnL |
|--------|------:|-------:|-----:|-------:|-----:|--------:|
| GOOG | 26 | 11 | 6 | 5 | 54.5% | $16,251 |
| NVDA | 56 | 15 | 9 | 6 | 60.0% | $6,282 |
| META | 20 | 8 | 7 | 1 | 87.5% | $6,155 |
| NFLX | 44 | 9 | 6 | 3 | 66.7% | $6,051 |
| GS | 30 | 13 | 8 | 5 | 61.5% | $5,500 |
| AVGO | 32 | 14 | 10 | 4 | 71.4% | $5,450 |
| JPM | 27 | 13 | 7 | 6 | 53.8% | $1,615 |
| NOW | 25 | 8 | 3 | 5 | 37.5% | $1,530 |
| MSFT | 12 | 3 | 2 | 1 | 66.7% | $1,481 |
| CRWD | 33 | 20 | 10 | 10 | 50.0% | $1,338 |
| IWM | 9 | 4 | 2 | 2 | 50.0% | $811 |
| ANET | 26 | 12 | 6 | 6 | 50.0% | $725 |
| PANW | 19 | 6 | 2 | 4 | 33.3% | $9 |
| AAPL | 32 | 13 | 7 | 6 | 53.8% | -$12 |
| ORCL | 13 | 6 | 2 | 4 | 33.3% | -$133 |
| AMD | 28 | 8 | 3 | 5 | 37.5% | -$538 |
| CRM | 8 | 1 | 0 | 1 | 0.0% | -$727 |
| AMZN | 17 | 3 | 0 | 3 | 0.0% | -$1,117 |
| LULU | 30 | 6 | 1 | 5 | 16.7% | -$2,084 |
| BA | 34 | 10 | 1 | 9 | 10.0% | -$2,100 |
| COST | 59 | 22 | 9 | 13 | 40.9% | -$2,669 |
| SHOP | 40 | 15 | 9 | 6 | 60.0% | -$3,160 |
| TSLA | 34 | 6 | 1 | 5 | 16.7% | -$3,878 |

## Per-ticker contribution (Rotation + RV filter)

Rebalances skipped due to QQQ RV5/RV60 ≥ 1.5: **22** of 225 (9.8%).

| Ticker | Picks | Trades | Wins | Losses | Win% | Sum PnL |
|--------|------:|-------:|-----:|-------:|-----:|--------:|
| GOOG | 23 | 11 | 6 | 5 | 54.5% | $16,251 |
| NVDA | 49 | 17 | 10 | 7 | 58.8% | $6,257 |
| META | 19 | 8 | 7 | 1 | 87.5% | $5,839 |
| GS | 30 | 13 | 8 | 5 | 61.5% | $5,500 |
| AVGO | 29 | 14 | 10 | 4 | 71.4% | $5,450 |
| NFLX | 40 | 8 | 5 | 3 | 62.5% | $3,721 |
| CRWD | 31 | 19 | 10 | 9 | 52.6% | $1,665 |
| MSFT | 9 | 3 | 2 | 1 | 66.7% | $1,481 |
| NOW | 21 | 7 | 3 | 4 | 42.9% | $1,422 |
| AAPL | 27 | 12 | 7 | 5 | 58.3% | $1,320 |
| ANET | 24 | 11 | 6 | 5 | 54.5% | $1,269 |
| JPM | 25 | 12 | 6 | 6 | 50.0% | $972 |
| IWM | 9 | 4 | 2 | 2 | 50.0% | $811 |
| ORCL | 11 | 6 | 2 | 4 | 33.3% | -$133 |
| AMD | 22 | 7 | 3 | 4 | 42.9% | -$485 |
| CRM | 8 | 1 | 0 | 1 | 0.0% | -$727 |
| AMZN | 15 | 3 | 0 | 3 | 0.0% | -$1,117 |
| LULU | 25 | 5 | 1 | 4 | 20.0% | -$1,340 |
| PANW | 19 | 7 | 2 | 5 | 28.6% | -$1,381 |
| BA | 31 | 10 | 1 | 9 | 10.0% | -$2,100 |
| COST | 54 | 22 | 9 | 13 | 40.9% | -$2,684 |
| TSLA | 31 | 6 | 1 | 5 | 16.7% | -$3,878 |
| SHOP | 36 | 13 | 6 | 7 | 46.2% | -$4,282 |

## Pick concentration check

Rotation top-3 was selected from 225 rebalance dates. Equal distribution would give each ticker ~29 picks. Concentration shows whether the rule is finding diversification or just buying the same names.

| Rank | Ticker | Picks | % of top-3 slots |
|-----:|--------|------:|-----------------:|
| 1 | COST | 59 | 8.7% |
| 2 | NVDA | 56 | 8.3% |
| 3 | NFLX | 44 | 6.5% |
| 4 | SHOP | 40 | 5.9% |
| 5 | BA | 34 | 5.0% |
| 6 | TSLA | 34 | 5.0% |
| 7 | CRWD | 33 | 4.9% |
| 8 | AAPL | 32 | 4.7% |
| 9 | AVGO | 32 | 4.7% |
| 10 | GS | 30 | 4.4% |
| 11 | LULU | 30 | 4.4% |
| 12 | AMD | 28 | 4.1% |
| 13 | JPM | 27 | 4.0% |
| 14 | GOOG | 26 | 3.9% |
| 15 | ANET | 26 | 3.9% |
| 16 | NOW | 25 | 3.7% |
| 17 | META | 20 | 3.0% |
| 18 | PANW | 19 | 2.8% |
| 19 | AMZN | 17 | 2.5% |
| 20 | ORCL | 13 | 1.9% |
| 21 | MSFT | 12 | 1.8% |
| 22 | IWM | 9 | 1.3% |
| 23 | CRM | 8 | 1.2% |

## Caveats

- Earnings calendar not modeled. Single-name BCD trades through earnings drift carry unmeasured event risk.
- WFA capital constraint: rotation runs at $6K (3 slots × $2K) vs baseline at $2K. Sharpe is unitless so the comparison is honest, but absolute PnL is 3× scale.
- Per-position sizing is fixed at $2K — large-underlying tickers (AMZN at $1.5K+) may not afford the BCD spread on early-history dates with small strikes; the simulator returns null and the slot stays empty for that signal.
- Holdout boundary same as the sealed F1 anchor (2024-01-22). Rotation has not been pre-registered, no dsrM cost, no sealed adoption claim.
- "Correlation to baseline" is daily-MtM Pearson correlation over the same window. Low correlation = better portfolio diversification candidate; high correlation = rotation is essentially a leveraged QQQ proxy.
