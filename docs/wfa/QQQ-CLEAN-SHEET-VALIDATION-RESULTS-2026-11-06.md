# QQQ clean-sheet validation results

Generated: 2026-11-06T00:00:00.000Z
Mode: cache-only; observed API calls: 0
Data: 2017-01-01 to 2026-02-28
Dataset manifest sha256: 4bde4339e7cb212ab59bb19dc727321d020d410f7b3e394c5389a16c06e7dbc9
Selection OOS: 2019-01-17 to 2024-01-19
Holdout OOS: 2024-01-22 to 2026-02-27

## Cache evidence

- dataCoverage: `docs/data-coverage/2026-05-07-cache-only-coverage.json` (a88c548f8948109bbea86437f54a72f71f9f66ed2bdadbc266ddf007fa622da8)
- cacheQuality: `docs/data-quality/2026-05-07-wfa-cache-quality.json` (5fa5cba25d01b2c94b4d72a7bbf691feb00e59a36b1a98e81a7c53788d84faeb)

## Results

| Strategy | Decision | Sel trades | Sel Sharpe | Sel DD | Hold trades | Hold Sharpe | Hold DD | Hold SPY IR | NO_CHAIN | Hold PnL |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| BCD QQQ wide F1 | paper_candidate | 59 | 0.97 | 39.8% | 25 | 1.22 | 14.3% | 0.48 | 0 | $5497 |
| PMCC QQQ PT60 F1 | paper_candidate | 28 | 1.72 | 17.5% | 11 | 1.63 | 12.5% | 0.26 | 0 | $18669 |

## Decision notes

- BCD QQQ wide F1: passes minimum clean-sheet statistical gates; live trading remains separately blocked by governance.
- PMCC QQQ PT60 F1: passes minimum clean-sheet statistical gates; live trading remains separately blocked by governance.

Live deployment remains blocked unless a separate governance review explicitly promotes a paper candidate.

## Caveats (added by hand after generation, 2026-11-06 repro audit)

- These numbers reproduce the 2026-04-23 seals exactly. The same audit found simulator bugs that overstate PnL: PMCC deep-ITM shorts are booked at $0 (gotcha #44), and BCD missing-chain exits are booked at a stale mid (gotcha #45). Do not cite this file as clean adoption evidence. See `backtesting history/credit-spread/reports/repro-bcd-pmcc-2026-11-06/README.md`.
- The SPY benchmark here is price-only (raw intraday closes, no dividends). That overstates holdout IR by about 0.08–0.11 compared with the runner's dividend-adjusted SPY.
