# Swing Credit Spread Loss Analysis
## 1. Executive Summary
| Question | Answer | Evidence |
| --- | --- | --- |
| Can the current strategy be made profitable? | No, not from tested path fixes | Best tested counterfactual is still -$17986 |
| Dominant failure mode | Large losers after good win rate | WR 82.6% with total PnL -$18621 and avg winner/loss asymmetry preserved |
| What mostly kills trades? | Directional breach + reversals | 86.6% directional breach, 8.5% reversal-after-profit |
No tested path-level counterfactual reached profitability. Strategy remains structurally negative in this 45-65 DTE form.
## 2. Data Source and Validation
| Metric | Value |
| --- | --- |
| Analysis source | validated_replay |
| Target run | data/runs/2026-03-27T20-31-21-127-unified-swing.json |
| CLI | npx tsx scripts/wfa-run-unified.ts --experiment data/experiments/pb-wide-sweep.json --profile swing |
| Target trades | 470 |
| Target total PnL | -$18621 |
| Target OOS Sharpe | -0.43 |
| Check | Pass |
| --- | --- |
| Trade count | no |
| Exit breakdown exact | no |
| Total PnL within $1 | no |
| OOS Sharpe within 0.01 | no |
| Per-window trade counts exact | no |
| Per-window Sharpe within 0.02 | no |
| Trade-level exact matches | 116/470 |
| Window | Rerun Trades | Target Trades | Rerun Sharpe | Target Sharpe |
| --- | --- | --- | --- | --- |
| 0 | 46 | 46 | -0.63 | -0.63 |
| 1 | 32 | 32 | -1.97 | -1.97 |
| 2 | 33 | 38 | 0.06 | -0.69 |
| 3 | 46 | 43 | -1.58 | -1.57 |
| 4 | 45 | 42 | -1.59 | -2.50 |
| 5 | 38 | 38 | 0.63 | 0.12 |
| 6 | 38 | 40 | 0.30 | 0.41 |
| 7 | 41 | 43 | 0.10 | 0.07 |
| 8 | 31 | 35 | -0.71 | 0.68 |
| 9 | 40 | 51 | -1.57 | -0.92 |
| 10 | 39 | 41 | -1.46 | -1.40 |
| 11 | 24 | 21 | -3.02 | -1.72 |
| Replay Validation | Value |
| --- | --- |
| Passed | yes |
| Matches | 470 |
| Mismatches | 0 |

Rerun mismatch samples:

- AAPL 2021-04-14 CALL strike=126 width=10 -> rerun PROFIT_TARGET 2021-04-29 pnl=99.39
- AAPL 2021-04-19 CALL strike=125 width=10 -> rerun PROFIT_TARGET 2021-06-11 pnl=85.48
- AMZN 2021-04-23 CALL strike=3190 width=10 -> rerun PROFIT_TARGET 2021-06-10 pnl=112.31
- AAPL 2021-04-26 CALL strike=130 width=10 -> rerun PROFIT_TARGET 2021-06-14 pnl=123.97
- AMD 2021-04-29 CALL strike=80 width=10 -> rerun PROFIT_TARGET 2021-06-10 pnl=109.98
- AMD 2021-05-05 PUT strike=85 width=10 -> rerun PROFIT_TARGET 2021-05-13 pnl=54.99
- AAPL 2021-05-13 PUT strike=135 width=10 -> rerun PROFIT_TARGET 2021-05-28 pnl=78.48
- AAPL 2021-05-28 PUT strike=130 width=10 -> rerun STOP_LOSS 2021-07-09 pnl=-849.03
- AMD 2021-06-10 CALL strike=76.5 width=3.5 -> rerun PROFIT_TARGET 2021-06-30 pnl=32.44
- IWM 2021-06-10 CALL strike=220 width=10 -> rerun TIME_STOP 2021-07-28 pnl=57.78
- AMD 2021-06-11 CALL strike=76.5 width=11.5 -> rerun PROFIT_TARGET 2021-06-24 pnl=86.89
- AMD 2021-06-14 CALL strike=77 width=12 -> rerun PROFIT_TARGET 2021-06-28 pnl=72.89
## 3. Exit Breakdown and Loss Contribution
| Exit Type | Count | Total PnL | P10 | Median | P90 |
| --- | --- | --- | --- | --- | --- |
| PROFIT_TARGET | 378 | $49448 | $71 | $125 | $200 |
| TIME_STOP | 54 | -$30305 | -$1296 | -$519 | $71 |
| STOP_LOSS | 33 | -$36616 | -$1582 | -$1131 | -$784 |
| EXPIRATION | 5 | -$1149 | -$460 | -$143 | -$59 |
| Exit Type | Count |
| --- | --- |
| PROFIT_TARGET | 378 |
| TIME_STOP | 54 |
| STOP_LOSS | 33 |
| EXPIRATION | 5 |
## 4. Path Taxonomy of Losers
| Pattern | Count | Median Hold | Median MFE | Median MAE | Breach Rate | Median Worst IV Ratio |
| --- | --- | --- | --- | --- | --- | --- |
| gap | 0 | NA | NA | NA | 0.0% | NA |
| drift | 58 | 42.0 | $0 | -$968 | 96.6% | 1.24 |
| whipsaw | 18 | 45.0 | $83 | -$920 | 100.0% | 1.26 |
| late_reversal | 1 | 42.0 | $137 | -$919 | 100.0% | 1.15 |
Sensitivity:
| Threshold Set | Gap | Drift | Whipsaw | Late Reversal |
| --- | --- | --- | --- | --- |
| aggressive | 0 | 58 | 17 | 2 |
| base | 0 | 58 | 18 | 1 |
| conservative | 0 | 65 | 11 | 1 |
## 5. MFE / MAE Analysis
| Group | Count | MFE P25 | MFE Median | MFE P75 | MAE P25 | MAE Median | MAE P75 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| all_losers | 82 | $0 | $6 | $39 | -$1194 | -$917 | -$745 |
| stop_loss | 33 | $0 | $0 | $0 | -$1246 | -$1131 | -$834 |
| time_stop | 44 | $4 | $24 | $65 | -$1083 | -$911 | -$636 |
| Group | MFE > $50 | MFE > $100 | MFE > $150 |
| --- | --- | --- | --- |
| all_losers | 23.2% | 8.5% | 2.4% |
| stop_loss | 12.1% | 6.1% | 6.1% |
| time_stop | 34.1% | 11.4% | 0.0% |
| Hold Bucket | Active Eventual Losers | Avg Unrealized PnL |
| --- | --- | --- |
| 0-5 | 81 | -$189 |
| 6-10 | 79 | -$239 |
| 11-15 | 75 | -$353 |
| 16-20 | 73 | -$405 |
| 21-30 | 63 | -$507 |
| 31-40 | 53 | -$620 |
| 41+ | 1 | -$8 |
Average-loser cohort inflection day: 1
## 6. Stock-vs-Short-Strike Behavior
| Exit Type | Count | Breach Rate | Median First Breach Day | Median Max Breach |
| --- | --- | --- | --- | --- |
| PROFIT_TARGET | 378 | 28.6% | 11.0 | 4.8 |
| TIME_STOP | 54 | 98.1% | 11.0 | 15.0 |
| STOP_LOSS | 33 | 97.0% | 12.5 | 84.6 |
| EXPIRATION | 5 | 60.0% | 10.0 | 18.2 |
| Ticker | Entry | Exit | Exit Type | Final PnL | Min Dist | Worst IV Ratio |
| --- | --- | --- | --- | --- | --- | --- |
| GOOG | 2020-11-06 | 2020-12-18 | TIME_STOP | -$531 | 15.2 | 0.97 |
## 7. Winner vs Loser Entry Conditions
| Feature | Winner Median | Winner P25/P75 | Loser Median | Loser P25/P75 | All Median | Loss Rate By Quartile |
| --- | --- | --- | --- | --- | --- | --- |
| entryDelta | 0.3 | 0.3 / 0.4 | 0.3 | 0.3 / 0.3 | 0.3 | Q1 15.3%, Q2 20.3%, Q3 17.8%, Q4 16.4% |
| entryIV | 0.3 | 0.3 / 0.4 | 0.3 | 0.3 / 0.4 | 0.3 | Q1 11.9%, Q2 20.3%, Q3 16.9%, Q4 20.7% |
| entryDTE | 50.0 | 47.0 / 57.0 | 50.5 | 47.0 / 55.5 | 50.0 | Q1 16.9%, Q2 17.8%, Q3 19.5%, Q4 15.5% |
| spreadWidth | 15.0 | 15.0 / 20.0 | 15.0 | 10.0 / 15.0 | 15.0 | Q1 25.4%, Q2 17.8%, Q3 16.1%, Q4 10.3% |
| rewardRiskRatio | 0.2 | 0.2 / 0.3 | 0.2 | 0.2 / 0.3 | 0.2 | Q1 12.7%, Q2 20.3%, Q3 14.4%, Q4 22.4% |
| entryDistancePct | 4.6 | 3.5 / 6.6 | 5.1 | 3.8 / 8.3 | 4.7 | Q1 12.7%, Q2 15.3%, Q3 20.3%, Q4 21.6% |
| d8 | 0.0 | -0.0 / 0.0 | 0.0 | -0.0 / 0.0 | 0.0 | Q1 28.0%, Q2 11.9%, Q3 15.3%, Q4 14.7% |
| prior5dReturn | 1.6 | -2.5 / 5.2 | -0.7 | -5.2 / 4.4 | 1.5 | Q1 26.3%, Q2 13.6%, Q3 15.3%, Q4 14.7% |
| prior10dReturn | 3.5 | -3.8 / 8.4 | 2.8 | -7.2 / 8.0 | 3.5 | Q1 25.4%, Q2 11.0%, Q3 18.6%, Q4 14.7% |
Categorical distributions:
| Ticker | Count | Loss Rate | Total PnL |
| --- | --- | --- | --- |
| AAPL | 166 | 14.5% | -$3900 |
| AMD | 107 | 15.9% | -$691 |
| AMZN | 53 | 28.3% | -$9152 |
| GOOG | 37 | 18.9% | -$4624 |
| GS | 28 | 32.1% | -$4200 |
| IWM | 18 | 22.2% | -$392 |
| META | 16 | 18.8% | -$187 |
| JPM | 14 | 7.1% | $1372 |
| NFLX | 11 | 9.1% | $734 |
| MSFT | 6 | 16.7% | $510 |
| SPY | 5 | 0.0% | $535 |
| NVDA | 4 | 0.0% | $765 |
| QQQ | 3 | 0.0% | $331 |
| TSLA | 2 | 0.0% | $277 |
| Direction | Count | Loss Rate | Total PnL |
| --- | --- | --- | --- |
| CALL | 297 | 15.2% | -$3282 |
| PUT | 173 | 21.4% | -$15340 |
| Window | Count | Loss Rate | Total PnL |
| --- | --- | --- | --- |
| W9 | 51 | 11.8% | -$1938 |
| W0 | 46 | 17.4% | -$1158 |
| W3 | 43 | 23.3% | -$5377 |
| W7 | 43 | 9.3% | $1172 |
| W4 | 42 | 23.8% | -$4496 |
| W10 | 41 | 17.1% | -$1425 |
| W6 | 40 | 12.5% | $737 |
| W2 | 38 | 15.8% | -$1187 |
| W5 | 38 | 7.9% | $570 |
| W8 | 35 | 8.6% | $1056 |
| W1 | 32 | 31.3% | -$3749 |
| W11 | 21 | 47.6% | -$2827 |
| Regime Bucket | Count | Loss Rate | Total PnL |
| --- | --- | --- | --- |
| W5-8 | 156 | 9.6% | $3535 |
| W9-11 | 113 | 20.4% | -$6190 |
| W3-4 | 85 | 23.5% | -$9873 |
| W0-1 | 78 | 23.1% | -$4906 |
| W2 | 38 | 15.8% | -$1187 |
| Preset | Count | Loss Rate | Total PnL |
| --- | --- | --- | --- |
| vol | 228 | 21.5% | -$15997 |
| em | 166 | 16.3% | -$4076 |
| pb | 76 | 7.9% | $1451 |
| Config | Count | Loss Rate | Total PnL |
| --- | --- | --- | --- |
| vol/tp50/w10/d30/ts7 | 73 | 28.8% | -$8277 |
| vol/tp50/w20/d35/ts7 | 71 | 12.7% | $461 |
| em/tp50/w15/d35/ts7 | 70 | 22.9% | -$4936 |
| em/tp50/w15/d35/ts3 | 46 | 17.4% | -$1158 |
| vol/tp40/w10/d30/ts3 | 42 | 23.8% | -$4496 |
| pb/tp30/w15/d30/ts3 | 40 | 5.0% | $2087 |
| em/tp50/w20/d30/ts3 | 37 | 8.1% | $503 |
| pb/tp40/w15/d35/ts3 | 36 | 11.1% | -$636 |
| vol/tp40/w20/d30/ts3 | 35 | 8.6% | $1056 |
| em/tp40/w15/d35/ts7 | 13 | 0.0% | $1515 |
| vol/tp40/w15/d35/ts7 | 7 | 85.7% | -$4741 |
## 8. Loss Mechanism Diagnosis
| Mechanism | Count | Loss Rate | Total PnL |
| --- | --- | --- | --- |
| directional_breach | 71 | 100.0% | -$61373 |
| reversal_after_profit | 7 | 100.0% | -$5993 |
| structural_time_decay_failure | 3 | 100.0% | -$772 |
| vol_expansion_without_breach | 1 | 100.0% | -$799 |
| Question | Answer | Evidence |
| --- | --- | --- |
| Directional? | Yes | 86.6% of losers breach the short strike |
| Vol expansion without breach? | Present but secondary | 1.2% of losers |
| Reversals after profit? | Material | 8.5% of losers had MFE >= $100 before failing |
| Structural reward/risk? | Still negative | Avg winner $130 vs avg loser -$841 |
## 9. Counterfactual Pathway to Profitability
| Counterfactual | Total PnL | Win Rate | Affected Trades | STOP_LOSS Avoided | TIME_STOP Avoided | Avg Winner | Avg Loser |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BE_after_100 | -$18170 | 75.7% | 39 | 2 | 9 | $126 | -$552 |
| Lock50_after_100 | -$17986 | 84.0% | 54 | 2 | 9 | $114 | -$839 |
| Exit_on_first_breach | -$35836 | 57.4% | 192 | 28 | 53 | $126 | -$350 |
| Day21_exit | -$28447 | 62.1% | 214 | 24 | 54 | $119 | -$355 |
| Combined_plausible | -$21227 | 67.2% | 230 | 26 | 54 | $106 | -$356 |
Counterfactuals are path-level diagnostics on realized trades only. They are not fresh WFA results.
## 10. Named Example Trades
### Gap
| Ticker | Entry | Exit | Exit Type | Window | Config | Hold | Final PnL | MFE | MAE | First Breach | Repricing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Drift
| Ticker | Entry | Exit | Exit Type | Window | Config | Hold | Final PnL | MFE | MAE | First Breach | Repricing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GOOG | 2020-08-18 | 2020-09-24 | STOP_LOSS | 0 | em/tp50/w15/d35/ts3 | 37 | -$1241 | $0 | -$1241 | 30 | exact |
| AAPL | 2020-08-25 | 2020-08-31 | STOP_LOSS | 0 | em/tp50/w15/d35/ts3 | 6 | -$970 | $0 | -$970 | 6 | interpolated |
| AMZN | 2020-08-31 | 2020-09-04 | STOP_LOSS | 0 | em/tp50/w15/d35/ts3 | 4 | -$1496 | $0 | -$1496 | 4 | exact |
### Whipsaw
| Ticker | Entry | Exit | Exit Type | Window | Config | Hold | Final PnL | MFE | MAE | First Breach | Repricing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AAPL | 2020-08-17 | 2020-08-31 | STOP_LOSS | 0 | em/tp50/w15/d35/ts3 | 14 | -$1010 | $185 | -$1010 | 14 | interpolated |
| AAPL | 2020-08-18 | 2020-08-31 | STOP_LOSS | 0 | em/tp50/w15/d35/ts3 | 13 | -$990 | $175 | -$990 | 13 | interpolated |
| AMD | 2023-10-23 | 2023-12-08 | TIME_STOP | 7 | vol/tp50/w20/d35/ts7 | 46 | -$1444 | $143 | -$1444 | 11 | interpolated |
### Late Reversal
| Ticker | Entry | Exit | Exit Type | Window | Config | Hold | Final PnL | MFE | MAE | First Breach | Repricing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AAPL | 2023-06-30 | 2023-08-11 | TIME_STOP | 6 | vol/tp50/w20/d35/ts7 | 42 | -$919 | $137 | -$919 | 10 | interpolated |
### Top 10 Worst Losses
| Ticker | Entry | Exit | Exit Type | Config | Hold | Final PnL | MFE | MAE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AMZN | 2021-07-14 | 2021-07-30 | STOP_LOSS | em/tp50/w15/d35/ts7 | 16 | -$1881 | $0 | -$1881 |
| AMD | 2023-10-26 | 2023-12-08 | STOP_LOSS | vol/tp50/w20/d35/ts7 | 43 | -$1728 | $0 | -$1728 |
| AAPL | 2023-10-26 | 2023-12-08 | TIME_STOP | vol/tp50/w20/d35/ts7 | 43 | -$1647 | $0 | -$1647 |
| AMZN | 2021-02-04 | 2021-02-25 | STOP_LOSS | em/tp50/w15/d35/ts7 | 21 | -$1646 | $0 | -$1646 |
| AMZN | 2024-07-02 | 2024-08-06 | STOP_LOSS | vol/tp40/w20/d30/ts3 | 35 | -$1603 | $37 | -$1603 |
| AAPL | 2023-01-04 | 2023-02-14 | TIME_STOP | em/tp50/w20/d30/ts3 | 41 | -$1579 | $8 | -$1579 |
| AAPL | 2023-01-03 | 2023-02-14 | TIME_STOP | em/tp50/w20/d30/ts3 | 42 | -$1570 | $17 | -$1570 |
| AMZN | 2020-08-31 | 2020-09-04 | STOP_LOSS | em/tp50/w15/d35/ts3 | 4 | -$1496 | $0 | -$1496 |
| AMD | 2023-10-23 | 2023-12-08 | TIME_STOP | vol/tp50/w20/d35/ts7 | 46 | -$1444 | $143 | -$1444 |
| GS | 2023-07-25 | 2023-09-11 | TIME_STOP | vol/tp50/w20/d35/ts7 | 48 | -$1322 | $64 | -$1377 |
### Top 10 Losers With Highest Positive MFE Before Failure
| Ticker | Entry | Exit | Exit Type | Config | Hold | Final PnL | MFE | Peak Day | First Breach |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AAPL | 2020-08-17 | 2020-08-31 | STOP_LOSS | em/tp50/w15/d35/ts3 | 14 | -$1010 | $185 | 8 | 14 |
| AAPL | 2020-08-18 | 2020-08-31 | STOP_LOSS | em/tp50/w15/d35/ts3 | 13 | -$990 | $175 | 7 | 13 |
| AMD | 2023-10-23 | 2023-12-08 | TIME_STOP | vol/tp50/w20/d35/ts7 | 46 | -$1444 | $143 | 3 | 11 |
| GS | 2020-06-05 | 2020-07-22 | TIME_STOP | em/tp50/w15/d35/ts3 | 47 | -$149 | $141 | 46 | 6 |
| AAPL | 2023-06-30 | 2023-08-11 | TIME_STOP | vol/tp50/w20/d35/ts7 | 42 | -$919 | $137 | 31 | 10 |
| AMD | 2025-08-05 | 2025-09-15 | TIME_STOP | vol/tp50/w10/d30/ts7 | 41 | -$163 | $136 | 8 | 1 |
| AAPL | 2023-10-25 | 2023-12-08 | TIME_STOP | vol/tp50/w20/d35/ts7 | 44 | -$1317 | $127 | 1 | 13 |
| AMD | 2024-09-26 | 2024-11-13 | TIME_STOP | vol/tp40/w20/d30/ts3 | 48 | -$1081 | $99 | 33 | 26 |
| AAPL | 2021-03-12 | 2021-04-26 | TIME_STOP | em/tp50/w15/d35/ts7 | 45 | -$419 | $93 | 18 | 27 |
| AMD | 2025-10-24 | 2025-12-15 | TIME_STOP | vol/tp50/w10/d30/ts7 | 52 | -$625 | $85 | 19 | 26 |
## 11. Final Verdict
| Conclusion | Evidence | Path Forward |
| --- | --- | --- |
| Structurally dead in current form | All tested realized-path fixes remain negative. Losses are dominated by breaches/reversals and the reward-risk ratio still fails. | Do not pursue further 45-65 DTE swing credit spread optimization without a materially different entry/exit structure. |