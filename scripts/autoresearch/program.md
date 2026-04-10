# Autoresearch: Trading Strategy Discovery

## Your Goal

Discover a trading strategy that **complements** the existing DTE5 bull put credit spread.

The DTE5 strategy trades QQQ only, holds 2-7 DTE short put spreads, and has OOS Sharpe ~1.44. It works well in bullish/neutral markets but is idle in downtrends (EMA55 gate) and only trades one ticker.

**You want to find a strategy that fills the gaps DTE5 leaves** — different tickers, different holding periods, different market regimes.

## Key Metric: Combined Portfolio Sharpe

You optimize `combinedSharpe` — the Sharpe ratio of a 50/50 portfolio combining DTE5 daily returns with YOUR strategy's daily returns.

**A Sharpe 0.5 strategy uncorrelated with DTE5 is MORE valuable than a Sharpe 1.0 strategy perfectly correlated with it.**

Target: `combinedSharpe > DTE5 standalone Sharpe` AND `correlation < 0.30`

## What You Edit

You **only** edit `strategy.ts`. It must export a `StrategyDefinition` object with:
- `name` — string identifier
- `tickers` — which tickers to trade
- `generateSignals(data)` — entry logic (receives candles, EMAs, IV ranks, regime data)
- `buildConfig(ticker, direction)` — returns SimConfig (controls option mode, delta, DTE, TP/SL, etc.)
- `portfolio` — max positions, capital
- `wfa` — walk-forward params

## How to Run

```bash
npx tsx scripts/autoresearch/runner.ts
```

Read the output. It shows: combinedSharpe, correlation, standalone metrics, validity.

## Available Option Modes

Set via `buildConfig()` → `SimConfig.mode`:

- **`CREDIT_SPREAD`** — Sell OTM vertical spreads (short premium). Config: `creditShortDelta`, `creditSpreadWidth`, `creditDTERange`, `creditProfitTarget`, `creditStopLossMultiple`, `trailingActivatePct/FloorPct`, `creditDeltaStop`, `creditMaxLossStopPct`, `creditTimeStopDTE`
- **`LEAP`** — Buy deep ITM long-dated options. Config: `leapDeltaRange`, `leapDTERange`, `leapProfitTarget`, `leapStopLoss`, `leapTimeStopDTE`
- **`DEBIT_SPREAD`** — Not fully wired (use custom evaluator)
- **`SWING_LONG_OPTION`** — Not fully wired (use custom evaluator)

For anything else (diagonals, PMCC, calendars), implement `customEvaluator`.

## Available Data in `generateSignals(data: TickerDataBundle)`

- `data.candles[]` — daily OHLCV (date, open, high, low, close, volume)
- `data.emas.get(8|13|21|34|55)` — full EMA series arrays
- `data.ivRanks[]` — IV percentile rank (0-100 or null), 252-day min/max
- `data.regimeByDate.get(date)` — `{ vrp, contango, vrpPct, contangoPct }`
  - `vrp` = IV30^2 - HV20^2 (variance risk premium)
  - `contango` = (IV60/IV30) - 1 (term structure)
  - `vrpPct`, `contangoPct` = rolling 252-day percentile rank
- `data.dateToIdx` — Map<date, index> for lookups

## Available Tickers (25 total, all with 9 years of data)

AAPL, AMD, AMZN, AVGO, BA, COIN, COST, GLD, GOOG, GS, HOOD, IWM, JPM, LULU, META, MSFT, MSTR, NFLX, NVDA, PLTR, QQQ, SPY, TSLA, UBER, UNH

**DTE5 only trades QQQ.** Strategies on other tickers naturally decorrelate.

## Hard Constraints (must pass ALL)

1. OOS Sharpe > 0 (must survive walk-forward)
2. Min 100 OOS trades (statistical validity)
3. MaxDD < 35%
4. Holdout Sharpe >= 0 (unseen data must not be negative)

## Overfitting Defenses (shown in output)

The runner tracks several overfitting metrics. Pay attention to these:

- **Holdout gate**: Pass/fail on data the strategy never trained on. Exact holdout Sharpe is hidden to prevent you from implicitly optimizing for it.
- **Holdout/OOS ratio**: How much the edge survives to holdout. Want > 0.5. Below 0.3 = likely overfit.
- **Bootstrap 95% CI**: If the lower bound is > 0, the Sharpe is statistically significant. If CI includes 0, the edge may be noise.
- **Deflated Sharpe**: Adjusts for the number of strategies you've tried (multiple testing). After 50+ attempts, a raw Sharpe of 0.5 might be noise — the deflated Sharpe accounts for this. Want > 0.
- **WF Efficiency**: OOS Sharpe / train Sharpe. Close to 1.0 = robust. Below 0.3 = overfit to training data.

**Strategy**: aim for strategies that pass ALL checks, not just high combined Sharpe. A strategy with combined Sharpe 0.8 that passes all checks is better than one with 1.5 that fails holdout.

## Exploration Directions

These are starting points, not limits:

- **Long calls on momentum tickers** when IV is low (cheap premium)
- **Credit spreads on non-QQQ** tickers (SPY, IWM, GLD, individual stocks)
- **Regime-switching**: sell premium in high vol, buy options in low vol
- **Mean-reversion plays**: buy puts on overbought tickers (RSI-based)
- **Sector rotation**: different tickers in different market regimes
- **Hedging strategies**: long puts during high VRP periods
- **Multi-ticker diversification**: spread across uncorrelated underlyings
- **Different DTE ranges**: 30-90 DTE credit spreads (vs DTE5's 2-7)
- **Wider spreads / different deltas**: experiment with risk/reward profiles
- **Volatility term structure plays**: when contango is extreme

## Simulation Model Notes

- **Entry timing**: Signals fire on bar close, entry fills on the same date's option chain. This matches the DTE5 study convention. Slightly optimistic for directional strategies (no T+1 delay).
- **LEAP fills**: Entry at ask-side (mid + half-spread), exit at bid-side (mid - half-spread). This penalizes illiquid options realistically.
- **Monitoring**: Daily by default. Avoid sparse intervals (e.g., every 3 days) as they create MtM gaps that distort Sharpe.
- **No commissions**: Commission model is not enabled. Results slightly overstate net performance.

## Tips

1. **Start simple.** One ticker, one mode, basic entry logic. Get valid results first.
2. **Check correlation first.** Low correlation is the primary value driver.
3. **Non-QQQ tickers decorrelate naturally.** SPY, GLD, individual stocks.
4. **Different holding periods decorrelate.** 30-90 DTE vs DTE5's 2-7 DTE.
5. **Vol selling + vol buying can decorrelate.** DTE5 sells premium; buying LEAPs has opposite vol exposure.
6. **Don't over-filter entries.** More trades = more statistical power. 100 is the minimum.
7. **Check the exit type breakdown.** If most trades expire worthless, the TP/SL may be too tight/loose.
8. **IV rank matters differently for buyers vs sellers.** Sell when IV is high, buy when IV is low.

## Current Best

Check `leaderboard.json` for the running log of all attempts and current champion.

## What Failed Before (save time)

- Iron condors, butterflies, calendar spreads — all failed under WFA (April 2026)
- All credit spread strategies on QQQ — correlated with DTE5, no complementary value
- The only other viable finding: underlying swing trades had Sharpe ~0.7 but were equity-based, not options
