/**
 * DTE5 IWM — Phase E4.
 *
 * Tests whether the DTE5 bull put credit spread structure (validated on
 * QQQ only) generalizes to IWM, the other major US broad-ETF. Small-cap
 * factor exposure vs QQQ's large-cap/tech. Fits a $2K account at $5
 * spread width.
 *
 * Context: Phase E3 just killed DTE5 on individual mega-caps (AAPL,
 * MSFT, NVDA, GOOG) — sealed FAIL at holdoutSpyIR -1.19. The mechanism
 * was individual-name earnings/news gaps blowing through the 2.5x SL.
 * ETFs don't have single-name earnings exposure, so IWM is the real
 * test of whether DTE5's edge generalizes to non-QQQ underlyings.
 *
 * Pre-registered in .handoff/current.md (2026-04-22).
 *
 * Structure: Bull put credit spread on IWM only.
 * Same signal stack as validated DTE5-QQQ: EMA55 ticker gate, SPY>EMA200
 * macro, EMA8>EMA13 + EMA34-rising momentum.
 *
 * Portfolio: maxPositions=1, maxPerTicker=1, startingCapital=$2K.
 *
 * Run via:
 *   AUTORESEARCH_LEADERBOARD_SUFFIX=dte5-iwm \
 *   AUTORESEARCH_STRATEGY_FILENAME=strategy-dte5-iwm.ts \
 *   npx tsx scripts/autoresearch/runner.ts
 */
import type { StrategyDefinition, TickerDataBundle, MarketContext, EntrySignal, SimConfig, ConfigVariant } from './types';

const DTE5_IWM_ANCHOR: SimConfig = {
  mode: 'CREDIT_SPREAD',
  leapDeltaRange: [0.65, 0.80],           // unused for CREDIT_SPREAD
  leapDTERange: [180, 365],                // unused
  leapProfitTarget: 0.50,                  // unused
  leapStopLoss: 0.30,                      // unused
  leapTimeStopDTE: 90,                     // unused
  creditShortDelta: 0.30,
  creditSpreadWidth: 5,                    // $5 wide — fits $2K account at 25% risk
  creditDTERange: [2, 7],
  creditProfitTarget: 1.0,                 // hold-to-expiry
  creditStopLossMultiple: 2.5,
  creditTimeStopDTE: 0,                    // hold-to-expiry
  trailingActivatePct: 0.50,
  trailingFloorPct: 0.50,
  monitoringIntervalDays: 1,
  minIVRank: 0,                            // EMA55 gate replaces
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
  { name: 'dte5-iwm-tight', overrides: { creditShortDelta: 0.25 } },
  { name: 'dte5-iwm-wide',  overrides: { creditShortDelta: 0.35 } },
  { name: 'dte5-iwm-w10',   overrides: { creditSpreadWidth: 10 } },
];

export const strategy: StrategyDefinition = {
  name: 'dte5-iwm-anchor',
  tickers: ['IWM'],

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
    return DTE5_IWM_ANCHOR;
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
