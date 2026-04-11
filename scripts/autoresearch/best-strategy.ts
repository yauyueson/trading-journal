/**
 * best-strategy.ts — RESEARCH CHAMPION (2026-04-10 session)
 *
 * Champion: momentum-ma-touch-leap-weekly-v2 (monitoringIntervalDays=3)
 * Combined Sharpe: 1.326 | Standalone: 1.274 | Corr w/ DTE5: 0.073
 * MaxDD: 32.6% | WR: 61.5% | Trades: 169 | Holdout: 0.873 / IR 0.560
 *
 * BREAKTHROUGH DISCOVERY: monitoring interval matters enormously.
 *
 * The key insight: daily monitoring catches brief option drops (<30%) that recover within
 * 1-2 days and triggers false SL exits. Checking every 3 days avoids these false triggers.
 *
 * Interval sweep (MA-touch, EMA34, LEAP [0.70,0.80] delta, DTE [180,270], TP=25%, SL=30%):
 * - interval=1 (daily):  combined=1.090, standalone=1.076, corr=0.260, MaxDD=31.8%, trades=206
 * - interval=2 (2-day):  combined=1.261, standalone=1.211, corr=0.109, MaxDD=24.5%, trades=191
 * - interval=3 (3-day):  combined=1.326, standalone=1.274, corr=0.073, MaxDD=32.6%, trades=169  ← PEAK
 * - interval=5 (weekly): combined=1.218, standalone=1.121, corr=0.035, MaxDD=26.0%, trades=153
 * - interval=7 (7-day):  combined=1.260, standalone=1.166, corr=0.031, MaxDD=33.9%, trades=136
 *
 * ⚠️ MEASUREMENT ARTIFACT WARNING: The low correlation values (0.073 for interval=3) are
 * partially a MEASUREMENT ARTIFACT. When monitoring is every 3 days, the daily MTM records
 * only have non-zero entries on check days (~33% of days). The other 67% of days show zero
 * portfolio return, which dilutes the measured correlation with DTE5. The TRUE correlation
 * during the holding period is likely ~0.200-0.250 (between daily's 0.260 and the reported
 * 0.073). The standalone Sharpe improvement (1.076 → 1.274) IS genuine — it reflects real
 * performance improvement from avoiding false SL triggers. The combined Sharpe of 1.326 is
 * likely inflated by ~0.05-0.10 due to the correlation artifact.
 *
 * ⚠️ CONFIRMED DEAD ENDS (this session, building on interval=3 champion):
 * - TP=30/35/40%: holdout failure — 25% TP is the hard constraint
 * - SL=25%: MORE SL hits (64) than SL=30% (49) with interval=3 — counterproductive
 * - Band=8%: MaxDD 45.8% — weaker signals beyond 5% above EMA34
 * - maxPos=5: combined 1.322 ≈ champion, MaxDD 26.9% — statistically tied, safer
 * - Bounce + interval=3: combined 1.162 valid but sparse (118 trades)
 * - EMA55 touch + interval=3: MaxDD 50.6%, WR 56.3% — EMA34 is specifically optimal
 * - Dip-buy (all variants): too sparse, MaxDD spikes
 * - Delta < 0.70: more leverage → higher SL sensitivity → MaxDD spikes
 *
 * PREVIOUS CHAMPION (before interval discovery):
 * momentum-ma-touch-leap-v2: combined=1.090, interval=1
 */
import type { StrategyDefinition, TickerDataBundle, EntrySignal, SimConfig } from './types';
import { DEFAULT_LEAP_CONFIG } from '../../src/lib/backtest/option-sim';

export const strategy: StrategyDefinition = {
  name: 'momentum-ma-touch-leap-weekly-v2',

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
      monitoringIntervalDays: 3,  // OPTIMAL: avoids false SL triggers from 1-2 day noise dips
      minIVRank: 0,
      missingChainExitAfterDays: 3,
    };
  },

  portfolio: {
    maxPositions: 3,
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
