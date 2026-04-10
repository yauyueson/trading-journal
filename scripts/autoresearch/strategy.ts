/**
 * strategy.ts — CURRENT CHAMPION: momentum-dte60-90-ts14-v1
 *
 * Combined Sharpe: 0.742 (with DTE5)
 * Standalone Sharpe: 0.762
 * Correlation with DTE5: 0.429
 * OOS Trades: 661
 *
 * NOTE: This is a RESET to the last valid champion after the 2026-04-10
 * leaderboard cleanup. The subsequent LEAP iterations (leap-long-call-v1,
 * leap-pos2-v1) looked great on raw Sharpe (~1.25) but failed the new
 * holdout-or-IR gate: holdout Sharpe ≈ 0 AND holdout SPY IR ≈ -0.2.
 * They were riding the 2018-2024 bull regime and got crushed on the
 * 2024-2026 holdout. Classic regime-dependent alpha, not real edge.
 *
 * This champion (iter 14 pre-LEAP) is a diversified momentum credit spread:
 *   - 12 tickers across sectors
 *   - EMA34 momentum filter (price > EMA34 AND EMA34 rising)
 *   - DTE 60-90 (longer-dated for more theta per trade)
 *   - Delta 0.30, $5 width
 *   - TP 50%, SL 2.5x, trailing lock 50/50
 *   - Time stop 14 DTE (avoid last-week gamma)
 *
 * Next iteration should focus on STRUCTURAL improvements over parameter
 * tweaks. Incremental tuning from this baseline has been exhausted.
 */
import type { StrategyDefinition, TickerDataBundle, EntrySignal, SimConfig } from './types';
import { DEFAULT_CREDIT_CONFIG } from '../../src/lib/backtest/option-sim';

export const strategy: StrategyDefinition = {
  name: 'momentum-dte60-90-ts14-v1',

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
      creditShortDelta: 0.30,
      creditSpreadWidth: 5,
      creditDTERange: [60, 90] as [number, number],    // longer-dated for more theta
      creditProfitTarget: 0.50,
      creditStopLossMultiple: 2.5,
      creditTimeStopDTE: 14,                           // exit before last-week gamma
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
