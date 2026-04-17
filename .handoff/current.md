---
task: Autoresearch Session 6 — Strategy Optimization
stage: done
owner: claude
from: user
timestamp: 2026-04-10T00:00:00-04:00
---

## Objective
Run autonomous trading strategy research loop (session 3, iterations 1-15 of 50 total).
Improve combined Sharpe beyond session 2 champion of 0.798.

## Work Done

### claude — 2026-04-10 (Session 6)
Ran 20 iterations (attempts #86-105). Advanced champion from 1.326 → 1.396.

**New champion: momentum-ma-touch-leap-weekly-v19 (Combined Sharpe 1.396)**
- Standalone Sharpe: 1.361
- MaxDD: 23.6% | WR: 62.3% | Trades: 183 | Holdout IR: 0.560
- Signal: price 0-5% above rising EMA34, price > EMA55 (regime filter), CALL LEAP
- Config: delta [0.70,0.80], DTE [180,270], TP 25%, SL 30%, interval=3, timeStop=60
- Universe: IWM + AAPL MSFT GOOG AMZN META + JPM GS + COST UNH NFLX (no GLD)

**Key discoveries this session:**
- maxPositions=4 (was 3): +0.027 Sharpe, -6.2% MaxDD via Kelly 25% sizing
- Remove GLD: +0.038 Sharpe — commodity ETF doesn't fit equity momentum signal
- EMA55 regime filter: +0.002 Sharpe, filters downtrend false entries
- DTE axis confirmed: [180,270] is optimal, [270,365] too few trades
- SL axis confirmed: 30% optimal, 25% too tight, 35% too wide
- Signal band confirmed: 0-5% optimal, 3% reduces diversification

**Note on runner:** NUM_WORKERS reduced to 4 to avoid intermittent segfaults.

**Dead ends found (15 iterations):**
- EMA55 MA-touch: INVALID holdout -0.28
- Wider MA band (0-8%), asymmetric band (-2% to +5%): INVALID
- NVDA+TSLA tickers: INVALID (displace better signals)
- TL 35/35, 50/50 variations: worse quality or INVALID
- Delta 0.22/0.27: worse than 0.25
- maxPositions 4: good holdout ratio (1.16) but lower combined
- direction=PUT, TL50/50+DTE45-60: simulator crashes

## Artifacts Modified
- scripts/autoresearch/strategy.ts (reset to v18 champion)
- scripts/autoresearch/best-strategy.ts (updated to v18)
- scripts/autoresearch/journal.md (iterations 2-15 + session wrap-up)
- scripts/autoresearch/leaderboard.json (updated by runner)
