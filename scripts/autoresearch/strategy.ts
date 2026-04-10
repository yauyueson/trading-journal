/**
 * strategy.ts — CURRENT CHAMPION: momentum-delta25-v1
 *
 * Combined Sharpe: 0.742 (with DTE5)
 * Standalone Sharpe: 0.762
 * Holdout Sharpe: 1.134
 * Correlation with DTE5: 0.429
 * OOS Trades: 661
 * Exit breakdown: TRAILING_LOCK 264, PROFIT_TARGET 271, STOP_LOSS 63
 *
 * Reached on 2026-04-10 post-TRAILING_LOCK-fix run (attempt #3).
 * Previous champion (momentum-dte60-90-ts14-v1) scored 0.673 under
 * the clean simulator. This version lowers delta 0.30 → 0.25 giving
 * wider margin before a loss, improving combined Sharpe by +0.07.
 *
 * NOTE: momentum-rsi-gate-v1 (attempt #12) had OOS 0.816 but FAILED
 * holdout gate (holdout Sharpe 0.061, IR -1.80) — RSI filter removes
 * too many signals in the holdout period, hurting performance there.
 *
 * Next iteration should explore STRUCTURAL changes:
 *   - Regime-gated entry (VIX < 20 or VRP positive)
 *   - Sector rotation (dynamic ticker weighting)
 *   - Iron condor (add PUT side to be directionally neutral)
 *   - DTE 45-60 (faster theta without gamma risk)
 *   - PUT spread entries (capture downside momentum, diversify direction)
 */
import type { StrategyDefinition, TickerDataBundle, EntrySignal, SimConfig } from './types';
import { DEFAULT_CREDIT_CONFIG } from '../../src/lib/backtest/option-sim';

export const strategy: StrategyDefinition = {
  name: 'momentum-delta25-v1',

  tickers: [
    'GLD', 'IWM',                              // ETFs with different drivers
    'AAPL', 'MSFT', 'GOOG', 'AMZN', 'META',    // mega-cap tech
    'JPM', 'GS',                               // financials
    'COST', 'UNH',                             // defensive
    'NFLX',                                    // growth
  ],

  generateSignals(data: TickerDataBundle): EntrySignal[] {
    const signals: EntrySignal[] = [];
    const ema34 = data.emas.get(34)!;

    for (let i = 40; i < data.candles.length; i++) {
      const c = data.candles[i];
      if (ema34[i] <= 0 || ema34[i - 5] <= 0) continue;

      // Momentum filter: price above EMA34 AND EMA34 rising (5-bar slope)
      const priceAboveMA = c.close > ema34[i];
      const maRising = ema34[i] > ema34[i - 5];
      if (!priceAboveMA || !maRising) continue;

      const regime = data.regimeByDate.get(c.date);
      signals.push({
        ticker: data.ticker,
        date: c.date,
        direction: 'CALL',
        score: 50,
        ivRank: data.ivRanks[i] ?? undefined,
        vrp: regime?.vrp,
        contango: regime?.contango,
        vrpPct: regime?.vrpPct,
        contangoPct: regime?.contangoPct,
      });
    }
    return signals;
  },

  buildConfig(_ticker: string, _direction: 'CALL' | 'PUT'): SimConfig {
    return {
      ...DEFAULT_CREDIT_CONFIG,
      mode: 'CREDIT_SPREAD',
      creditShortDelta: 0.25,           // delta 0.25 (vs 0.30 baseline) — wider margin
      creditSpreadWidth: 5,
      creditDTERange: [60, 90] as [number, number],
      creditProfitTarget: 0.50,
      creditStopLossMultiple: 2.5,
      creditTimeStopDTE: 14,
      trailingActivatePct: 0.50,
      trailingFloorPct: 0.50,
      monitoringIntervalDays: 1,
      minIVRank: 0,
      missingChainExitAfterDays: 3,
    };
  },

  portfolio: {
    maxPositions: 5,
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
