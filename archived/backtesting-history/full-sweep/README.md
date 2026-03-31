# Short-Term Credit Spread — Full Config Sweep

Generated: 2026-03-29

## Study Parameters
- **Date range**: 2020-01-01 → 2026-02-28
- **Tickers**: SPY, QQQ, AMD, IWM, TSLA, AAPL, JPM, NVDA, AMZN, MSFT, META, NFLX, GOOG, GS
- **Configs swept**: 2916
- **WFA windows**: 33 (31 selection + 2 holdout)
- **Runtime**: 221.9 minutes
- **Ranking metric**: Net OOS Sharpe
- **Execution model**: bidask_combo_plus_commission
- **Commission**: $0.65 per leg per side
- **IV rank method**: min_max_252d

## Sweep Dimensions
| Dimension | Values |
|-----------|--------|
| Signal preset | ema, mom, em, vol, full, mf |
| Period multiplier | 2.25, 3, 3.75 |
| Profit target | 30%, 40%, 50% |
| Spread width | $2.5, $5, $10 |
| IV rank min | 0, 20, 40 |
| Short delta | 0.25, 0.35, 0.45 |
| Time stop DTE | 1, 3 |

## Top 10 Results

| Rank | Config | IS Sharpe | OOS Net | OOS Gross | Holdout Net | Holdout Gross | WR% | MaxDD | Trades | Grade |
|------|--------|-----------|---------|-----------|-------------|---------------|-----|-------|--------|-------|
| 1 | mom|tp40|w10|iv20|d35|ts1|pm3 | -1.84 | 0.74 | -1.09 | -1.88 | -1.33 | 68.4% | 120.0% | 1912 | D |
| 2 | full|tp30|w5|iv20|d45|ts1|pm2.25 | -2.85 | 0.61 | -1.38 | -3.80 | -2.68 | 66.1% | 102.7% | 2021 | D |
| 3 | full|tp40|w10|iv0|d45|ts1|pm3 | -2.22 | 0.61 | -0.67 | -3.96 | -3.07 | 64.7% | 162.2% | 2581 | D |
| 4 | mom|tp50|w10|iv0|d45|ts1|pm3 | -1.90 | 0.60 | -0.13 | -3.90 | -3.09 | 61.8% | 151.0% | 2272 | D |
| 5 | mf|tp50|w10|iv20|d45|ts3|pm2.25 | -2.34 | 0.59 | -0.83 | -4.96 | -4.09 | 56.3% | 139.8% | 2007 | D |
| 6 | ema|tp40|w5|iv0|d35|ts3|pm3 | -2.77 | 0.59 | -0.95 | -5.96 | -4.06 | 66.1% | 100.2% | 2876 | D |
| 7 | full|tp40|w10|iv20|d45|ts1|pm2.25 | -2.24 | 0.58 | -0.68 | -2.43 | -1.83 | 63.8% | 141.6% | 1948 | D |
| 8 | mom|tp30|w10|iv0|d45|ts1|pm2.25 | -2.81 | 0.55 | -0.71 | -5.29 | -4.27 | 67.8% | 188.9% | 2800 | D |
| 9 | mf|tp40|w10|iv20|d45|ts1|pm2.25 | -2.18 | 0.53 | -0.62 | -2.46 | -1.87 | 64.3% | 140.9% | 1956 | D |
| 10 | em|tp30|w10|iv20|d45|ts1|pm2.25 | -2.39 | 0.51 | -0.69 | -3.83 | -3.05 | 66.5% | 148.2% | 2015 | D |

## Grade Distribution
- **A**: 0 configs
- **A+B**: 0 configs
- **Total**: 2916 configs

## Methodology

### Fixed Parameters
- DTE: 7-21 days
- Stop Loss: None (defined risk)
- Delta Stop: Off
- BSM Kappa: 4.0, Risk-free: 4%
- Daily calibration: On
- Fill mode: Bid/ask combo fills with dynamic slippage (bidask_combo_plus_commission)
- Commission: $0.65 per leg per side
- IV Rank: min_max_252d

### Overfitting Grade Rubric
| Grade | Criteria |
|-------|----------|
| A | 6/6 checks pass |
| B | 5/6 |
| C | 4/6 |
| D | 3/6 |
| F | <3/6 |

Checks: IS→OOS retention ≥40%, OOS Sharpe StdDev <1.0, all windows positive, sufficient trades, no extreme IS, OOS Sharpe >0.5