/**
 * DTE5 QQQ Re-Validation — Phase E7.
 *
 * The active live strategy per CLAUDE.md + src/lib/strategyProfiles.ts.
 * Currently "validated" under pre-overhaul autoresearch. This campaign
 * re-validates the same configuration under the post-overhaul sealed-
 * holdout protocol to give it the same trust-regime status as PMCC-pt50-QQQ
 * (Phase E2b sealed PASS).
 *
 * Confirmation-of-effect design: pmcc-pt50-anchor-equivalent structure —
 * NAMED ANCHOR is always sealed regardless of variants' combinedSharpe.
 * Two neighbor variants (width $5 and width $20) serve as robustness checks
 * around the canonical $10 width.
 *
 * Config mirrors STRATEGY_PROFILES.dte5:
 * - Ticker: QQQ
 * - Short put δ 0.30, long put δ 0.20 (via $10 width)
 * - DTE 2-7 (peak 5)
 * - SL 2.5× credit, Trailing Lock 50/50
 * - Hold-to-expiry (profitTarget=1.0, no time stop)
 * - EMA55 trend gate + SPY>EMA200 macro + EMA8>EMA13 momentum
 * - maxPositions=1, maxPerTicker=1
 *
 * Run via:
 *   AUTORESEARCH_LEADERBOARD_SUFFIX=dte5-qqq-reval \
 *   AUTORESEARCH_STRATEGY_FILENAME=strategy-dte5-qqq-reval.ts \
 *   npx tsx scripts/autoresearch/runner.ts
 */
import type { StrategyDefinition, TickerDataBundle, MarketContext, EntrySignal, SimConfig, ConfigVariant } from './types';

const DTE5_QQQ_LIVE_ANCHOR: SimConfig = {
  mode: 'CREDIT_SPREAD',
  leapDeltaRange: [0.65, 0.80],           // unused for CREDIT_SPREAD
  leapDTERange: [180, 365],                // unused
  leapProfitTarget: 0.50,                  // unused
  leapStopLoss: 0.30,                      // unused
  leapTimeStopDTE: 90,                     // unused
  creditShortDelta: 0.30,
  creditSpreadWidth: 10,                   // canonical QQQ DTE5 width
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
  { name: 'dte5-qqq-w5',  overrides: { creditSpreadWidth: 5 } },    // robustness: narrower
  { name: 'dte5-qqq-w20', overrides: { creditSpreadWidth: 20 } },   // robustness: wider
];

export const strategy: StrategyDefinition = {
  name: 'dte5-qqq-live-anchor',
  tickers: ['QQQ'],

  portfolio: {
    maxPositions: 1,
    maxPerTicker: 1,
    startingCapital: 10000,                // matches canonical autoresearch scale
  },

  wfa: {
    trainWindowDays: 252,
    forwardStepDays: 126,
    purgeGapDays: 10,
    mode: 'rolling' as const,
    holdoutCount: 5,
  },

  buildConfig(_ticker, _direction): SimConfig {
    return DTE5_QQQ_LIVE_ANCHOR;
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
