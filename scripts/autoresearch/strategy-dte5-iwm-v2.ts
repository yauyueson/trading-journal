/**
 * DTE5 IWM v2 — Phase E8 (direction bug fixed).
 *
 * Phase E4 (PR #9) had direction='PUT' (bear call) not 'CALL' (bull put).
 * This v2 uses direction='CALL' + simplified canonical DTE5 signal.
 *
 * Run via:
 *   AUTORESEARCH_LEADERBOARD_SUFFIX=dte5-iwm-v2 \
 *   AUTORESEARCH_STRATEGY_FILENAME=strategy-dte5-iwm-v2.ts \
 *   npx tsx scripts/autoresearch/runner.ts
 */
import type { StrategyDefinition, TickerDataBundle, MarketContext, EntrySignal, SimConfig, ConfigVariant } from './types';

const DTE5_IWM_V2_ANCHOR: SimConfig = {
  mode: 'CREDIT_SPREAD',
  leapDeltaRange: [0.65, 0.80], leapDTERange: [180, 365], leapProfitTarget: 0.50,
  leapStopLoss: 0.30, leapTimeStopDTE: 90,
  creditShortDelta: 0.30,
  creditSpreadWidth: 5,
  creditDTERange: [2, 7],
  creditProfitTarget: 1.0,
  creditStopLossMultiple: 2.5,
  creditTimeStopDTE: 0,
  trailingActivatePct: 0.50,
  trailingFloorPct: 0.50,
  monitoringIntervalDays: 1,
  minIVRank: 0,
  fillMode: 'bidask',
  slippage: {
    baseMultiplier: 1.0, oiPivot: 500, oiExponent: 0.5,
    dtePivot: 30, dteExponent: 0.5,
  },
};

const configVariants: ConfigVariant[] = [
  { name: 'dte5-iwm-v2-tight', overrides: { creditShortDelta: 0.25 } },
  { name: 'dte5-iwm-v2-wide',  overrides: { creditShortDelta: 0.35 } },
  { name: 'dte5-iwm-v2-w10',   overrides: { creditSpreadWidth: 10 } },
];

export const strategy: StrategyDefinition = {
  name: 'dte5-iwm-v2-anchor',
  tickers: ['IWM'],

  portfolio: {
    maxPositions: 1,
    maxPerTicker: 1,
    startingCapital: 10000,
  },

  wfa: {
    trainWindowDays: 252,
    forwardStepDays: 126,
    purgeGapDays: 10,
    mode: 'rolling' as const,
    holdoutCount: 5,
  },

  buildConfig(_ticker, _direction): SimConfig {
    return DTE5_IWM_V2_ANCHOR;
  },

  generateSignals(data: TickerDataBundle, _market: MarketContext): EntrySignal[] {
    const signals: EntrySignal[] = [];
    const ema34 = data.emas.get(34)!;
    const n = data.candles.length;

    for (let i = 55; i < n; i++) {
      const c = data.candles[i];
      const e34 = ema34[i];
      if (e34 <= 0) continue;
      if (c.close <= e34) continue;

      signals.push({
        ticker: data.ticker,
        date: c.date,
        direction: 'CALL',
        score: 50,
      });
    }

    return signals;
  },

  configVariants,
};
