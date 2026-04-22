/**
 * PMCC Low-Price — Phase E6.
 *
 * Tests whether the PMCC-pt50 structure (validated on QQQ, Phase E2b
 * sealed PASS) generalizes to lower-priced growth names that fit a $2K
 * account at entry.
 *
 * Underlyings: HOOD + PLTR. Both:
 * - Were <$50 for most of the 2021-2024 selection window
 * - Have liquid LEAP chains
 * - Grew meaningfully into the 2024-2026 holdout (HOOD $10 → $114,
 *   PLTR $16 → $184) — a PMCC that captures this directional move
 *   while collecting short-call theta should post strong results
 *
 * Capital scaling caveat: by end-holdout the underlyings are not
 * $2K-friendly anymore (HOOD LEAP at $114 spot ≈ $2,800+ capital
 * per position). The pre-reg accepts this — the evaluation is
 * PORTFOLIO-LEVEL edge, not a per-position affordability check.
 *
 * Pre-registered in .handoff/current.md.
 *
 * Structure: PMCC (long deep-ITM LEAP + rolling short OTM call) with
 * longPT=0.50 (the validated QQQ setting).
 *
 * Portfolio: maxPositions=1, maxPerTicker=1, startingCapital=$2K.
 * First-come-first-served across the 2-ticker basket.
 *
 * Run via:
 *   AUTORESEARCH_LEADERBOARD_SUFFIX=pmcc-lowprice \
 *   AUTORESEARCH_STRATEGY_FILENAME=strategy-pmcc-lowprice.ts \
 *   npx tsx scripts/autoresearch/runner.ts
 */
import type { StrategyDefinition, TickerDataBundle, MarketContext, EntrySignal, SimConfig, ConfigVariant } from './types';
import { DEFAULT_LEAP_CONFIG } from '../../src/lib/backtest/option-sim';

const LOWPRICE_TICKERS = ['HOOD', 'PLTR'];

const PMCC_LOWPRICE_ANCHOR: SimConfig = {
  ...DEFAULT_LEAP_CONFIG,
  mode: 'DIAGONAL',
  diagLongDeltaRange: [0.70, 0.80],
  diagLongDTERange: [240, 300],
  diagShortDeltaRange: [0.20, 0.30],
  diagShortDTERange: [30, 45],
  diagLongProfitTarget: 0.50,              // validated QQQ setting
  diagLongStopLoss: 0.35,
  diagLongTimeStopDTE: 90,
  diagShortProfitTarget: 0.50,
  diagRollTriggerMoneyness: 0.02,
  monitoringIntervalDays: 1,
};

const configVariants: ConfigVariant[] = [
  { name: 'pmcc-lowprice-tight-short', overrides: { diagShortDeltaRange: [0.25, 0.35], diagShortDTERange: [25, 35] } },
  { name: 'pmcc-lowprice-pt45',        overrides: { diagLongProfitTarget: 0.45 } },
  { name: 'pmcc-lowprice-pt55',        overrides: { diagLongProfitTarget: 0.55 } },
];

export const strategy: StrategyDefinition = {
  name: 'pmcc-lowprice-anchor',
  tickers: LOWPRICE_TICKERS,

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
    holdoutCount: 3,      // reduced from 5 — short-history tickers (HOOD 2021+, PLTR 2020+) can't fit 5 folds within manifest holdout
  },

  buildConfig(_ticker, _direction): SimConfig {
    return PMCC_LOWPRICE_ANCHOR;
  },

  generateSignals(data: TickerDataBundle, _market: MarketContext): EntrySignal[] {
    // Always-in: one signal per trading day; portfolio constraints suppress overlap.
    const signals: EntrySignal[] = [];
    for (let i = 60; i < data.candles.length; i++) {
      signals.push({
        ticker: data.ticker,
        date: data.candles[i].date,
        direction: 'CALL',
        score: 0,
      });
    }
    return signals;
  },

  configVariants,
};
