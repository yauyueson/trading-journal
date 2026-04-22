/**
 * DTE5 SPY — Phase E5.
 *
 * Tests whether the DTE5 bull put credit spread structure generalizes
 * from QQQ to SPY (S&P 500 ETF). Third ETF-level test in the DTE5
 * generalization series:
 *   - QQQ: validated (pre-overhaul)
 *   - IWM: Phase E4 sealed FAIL (profitable but lagged SPY)
 *   - SPY: this campaign
 *
 * Unlike IWM which has small-cap factor risk, SPY is the broadest
 * large-cap US ETF. A PASS here would indicate DTE5's edge is a
 * general large-cap-ETF-structure edge. A FAIL would indicate the
 * edge is specifically to QQQ's tech-weighted composition.
 *
 * Pre-registered in .handoff/current.md (2026-04-22).
 *
 * Structure: Bull put credit spread on SPY only. Same signal stack
 * as validated DTE5-QQQ: EMA55 ticker gate, SPY>EMA200 macro,
 * EMA8>EMA13 + EMA34-rising momentum.
 *
 * Portfolio: maxPositions=1, maxPerTicker=1, startingCapital=$2K.
 *
 * Run via:
 *   AUTORESEARCH_LEADERBOARD_SUFFIX=dte5-spy \
 *   AUTORESEARCH_STRATEGY_FILENAME=strategy-dte5-spy.ts \
 *   npx tsx scripts/autoresearch/runner.ts
 */
import type { StrategyDefinition, TickerDataBundle, MarketContext, EntrySignal, SimConfig, ConfigVariant } from './types';

const DTE5_SPY_ANCHOR: SimConfig = {
  mode: 'CREDIT_SPREAD',
  leapDeltaRange: [0.65, 0.80],           // unused for CREDIT_SPREAD
  leapDTERange: [180, 365],                // unused
  leapProfitTarget: 0.50,                  // unused
  leapStopLoss: 0.30,                      // unused
  leapTimeStopDTE: 90,                     // unused
  creditShortDelta: 0.30,
  creditSpreadWidth: 5,                    // $5 wide — fits $2K account
  creditDTERange: [2, 7],
  creditProfitTarget: 1.0,                 // hold-to-expiry
  creditStopLossMultiple: 2.5,
  creditTimeStopDTE: 0,                    // hold-to-expiry
  trailingActivatePct: 0.50,
  trailingFloorPct: 0.50,
  monitoringIntervalDays: 1,
  minIVRank: 0,
  fillMode: 'bidask',
  slippage: {
    baseMultiplier: 1.0,
    oiPivot: 500,
    oiExponent: 0.5,
    dtePivot: 30,
    dteExponent: 0.5,
  },
};

const configVariants: ConfigVariant[] = [
  { name: 'dte5-spy-tight', overrides: { creditShortDelta: 0.25 } },
  { name: 'dte5-spy-wide',  overrides: { creditShortDelta: 0.35 } },
  { name: 'dte5-spy-w10',   overrides: { creditSpreadWidth: 10 } },
];

export const strategy: StrategyDefinition = {
  name: 'dte5-spy-anchor',
  tickers: ['SPY'],

  portfolio: {
    maxPositions: 1,
    maxPerTicker: 1,
    startingCapital: 2000,
  },

  wfa: {
    trainWindowDays: 252,
    forwardStepDays: 126,
    purgeGapDays: 10,
    mode: 'rolling' as const,
    holdoutCount: 5,
  },

  buildConfig(_ticker, _direction): SimConfig {
    return DTE5_SPY_ANCHOR;
  },

  generateSignals(data: TickerDataBundle, market: MarketContext): EntrySignal[] {
    const signals: EntrySignal[] = [];
    const ema8 = data.emas.get(8)!;
    const ema13 = data.emas.get(13)!;
    const ema34 = data.emas.get(34)!;
    const ema55 = data.emas.get(55)!;
    const ema200 = data.emas.get(200)!;
    const n = data.candles.length;

    for (let i = 60; i < n; i++) {
      const c = data.candles[i];

      if (ema8[i] <= 0 || ema13[i] <= 0) continue;
      if (ema34[i] <= 0 || ema34[i - 5] <= 0) continue;
      if (ema55[i] <= 0 || ema200[i] <= 0) continue;

      const spy = market.spyByDate.get(c.date);
      if (!spy || !spy.ema200 || spy.ema200 <= 0) continue;
      if (spy.close <= spy.ema200) continue;

      if (c.close <= ema55[i]) continue;

      if (!(ema8[i] > ema13[i] && ema34[i] > ema34[i - 5])) continue;

      signals.push({
        ticker: data.ticker,
        date: c.date,
        direction: 'PUT',
        score: 0,
      });
    }

    return signals;
  },

  configVariants,
};
