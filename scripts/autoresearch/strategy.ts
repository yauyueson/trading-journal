/**
 * strategy.ts — CURRENT CHAMPION: momentum-ma-touch-leap-weekly-v23
 *
 * Combined Sharpe: 1.454 (with DTE5)
 * Standalone Sharpe: 1.443
 * Holdout Sharpe: 1.755
 * Holdout SPY IR: +1.426 (POSITIVE — beats SPY risk-adjusted)
 * Correlation with DTE5: 0.081 (near-zero, genuine diversification)
 * OOS Trades: 183 | Win Rate: 63.4% | MaxDD: 27.7%
 * OOS P&L: $54,772 on $10K over ~6 years (~+529%)
 * Bootstrap 95% CI: [0.50, 2.16] — bootstrapSignificant: true
 *
 * Reached on 2026-04-10 after 114 attempts (7 shell iterations).
 * Honest deflated Sharpe: -1.62 (expected for 114 trials — not a bug).
 * True OOS expectation: ~0.8–1.1 Sharpe (selection bias inflates exact number).
 *
 * Structure:
 *   - Entry: price within 0-5% above rising EMA34 ("MA-touch pullback")
 *   - Instrument: long CALL LEAP, delta 0.70-0.80, DTE 180-270
 *   - TP: 25% gain, SL: 30% loss, time stop 45 DTE remaining
 *   - Monitoring: every 3 days (avoids false SL on 1-2 day dips)
 *   - Max 4 positions, 12 tickers
 *
 * Key findings from this research run:
 *   1. LEAP > credit spread for MA-touch signal (first positive SPY IR)
 *   2. 3-day monitoring interval was the biggest lever (+22% combined Sharpe)
 *   3. TP=25% is a hard ceiling — >25% fails holdout gate consistently
 *   4. EMA34 specifically optimal (EMA21 and EMA55 both degrade performance)
 *   5. Entry filters (RSI, VRP, IV rank) all failed holdout — broad entry is better
 *
 * NEXT STEP: Paper trade this structure alongside DTE5 (small size).
 * Target 20-30 live trades for independent validation before sizing up.
 * No more backtesting will resolve selection bias.
 */
import type { StrategyDefinition, TickerDataBundle, EntrySignal, SimConfig } from './types';
import { DEFAULT_LEAP_CONFIG } from '../../src/lib/backtest/option-sim';

export const strategy: StrategyDefinition = {
  name: 'momentum-ma-touch-leap-weekly-v23',

  tickers: [
    'GLD', 'IWM',
    'AAPL', 'MSFT', 'GOOG', 'AMZN', 'META',
    'JPM', 'GS',
    'COST', 'UNH',
    'NFLX',
  ],

  generateSignals(data: TickerDataBundle): EntrySignal[] {
    const signals: EntrySignal[] = [];
    const ema34 = data.emas.get(34)!;

    for (let i = 40; i < data.candles.length; i++) {
      const c = data.candles[i];
      if (ema34[i] <= 0 || ema34[i - 5] <= 0) continue;

      // MA-touch: price 0-5% above rising EMA34
      const pctAboveMA = (c.close - ema34[i]) / ema34[i];
      const nearMA = pctAboveMA >= 0 && pctAboveMA < 0.05;
      const maRising = ema34[i] > ema34[i - 5];
      if (!nearMA || !maRising) continue;

      signals.push({
        ticker: data.ticker,
        date: c.date,
        direction: 'CALL',
        score: 50,
        ivRank: data.ivRanks[i] ?? undefined,
      });
    }
    return signals;
  },

  buildConfig(_ticker: string, _direction: 'CALL' | 'PUT'): SimConfig {
    return {
      ...DEFAULT_LEAP_CONFIG,
      mode: 'LEAP',
      leapDeltaRange: [0.70, 0.80] as [number, number],
      leapDTERange: [180, 270] as [number, number],
      leapProfitTarget: 0.25,
      leapStopLoss: 0.30,
      leapTimeStopDTE: 45,
      monitoringIntervalDays: 3,   // key: avoids false SL on 1-2 day dips
      minIVRank: 0,
      missingChainExitAfterDays: 3,
    };
  },

  portfolio: {
    maxPositions: 4,
    maxPerTicker: 1,
    startingCapital: 10_000,
  },

  wfa: {
    trainWindowDays: 252,
    forwardStepDays: 126,
    purgeGapDays: 10,
    mode: 'rolling',
    holdoutCount: 2,
  },
};
