# QQQ clean-sheet validation results

Generated: 2026-05-07T00:00:00.000Z
Mode: cache-only; observed API calls: 0
Data: 2017-01-01 to 2026-02-28
Selection OOS: 2019-01-02 to 2023-11-01
Holdout OOS: 2023-11-02 to 2026-02-28

## Cache evidence

- dataCoverage: `docs/data-coverage/2026-05-07-cache-only-coverage.json` (a88c548f8948109bbea86437f54a72f71f9f66ed2bdadbc266ddf007fa622da8)
- cacheQuality: `docs/data-quality/2026-05-07-wfa-cache-quality.json` (5fa5cba25d01b2c94b4d72a7bbf691feb00e59a36b1a98e81a7c53788d84faeb)

## Results

| Strategy | Decision | Sel trades | Sel Sharpe | Sel DD | Hold trades | Hold Sharpe | Hold DD | Hold SPY IR | NO_CHAIN | Hold PnL |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| BCD QQQ wide F1 | paper_candidate | 55 | 0.80 | 48.9% | 23 | 1.14 | 27.1% | 0.44 | 0 | $4432 |
| PMCC QQQ PT60 F1 | paper_candidate | 27 | 1.61 | 17.5% | 11 | 1.84 | 12.5% | 0.20 | 0 | $23729 |

## Decision notes

- BCD QQQ wide F1: passes minimum clean-sheet statistical gates; live trading remains separately blocked by governance.
- PMCC QQQ PT60 F1: passes minimum clean-sheet statistical gates; live trading remains separately blocked by governance.

Live deployment remains blocked unless a separate governance review explicitly promotes a paper candidate.

