/**
 * PMCC QQQ — first post-overhaul LEAP autoresearch campaign.
 *
 * Pre-registered in .handoff/current.md (2026-04-22).
 *
 * Structure: Poor Man's Covered Call on QQQ — long deep-ITM LEAP (delta ~0.75,
 * DTE ~270), rolling monthly short OTM calls (delta ~0.25, DTE ~30-45).
 *
 * "Always-in" entry: a new PMCC is opened on every trading day; portfolio
 * constraints (maxPositions=1, maxPerTicker=1) suppress overlap so in practice
 * a new PMCC opens each time the prior one exits.
 *
 * Run via:
 *   AUTORESEARCH_LEADERBOARD_SUFFIX=pmcc-qqq npx tsx scripts/autoresearch/runner.ts
 */
import type { StrategyDefinition, TickerDataBundle, MarketContext, EntrySignal, SimConfig, ConfigVariant } from './types';
import { DEFAULT_LEAP_CONFIG } from '../../src/lib/backtest/option-sim';

const PMCC_ANCHOR: SimConfig = {
  ...DEFAULT_LEAP_CONFIG,
  mode: 'DIAGONAL',
  diagLongDeltaRange: [0.70, 0.80],
  diagLongDTERange: [240, 300],
  diagShortDeltaRange: [0.20, 0.30],
  diagShortDTERange: [30, 45],
  diagLongProfitTarget: 0.40,
  diagLongStopLoss: 0.35,
  diagLongTimeStopDTE: 90,
  diagShortProfitTarget: 0.50,
  diagRollTriggerMoneyness: 0.02,
  monitoringIntervalDays: 1,
  // Inherit fillMode and slippage from DEFAULT_LEAP_CONFIG (bidask + dynamic)
};

const configVariants: ConfigVariant[] = [
  { name: 'pmcc-tight-short', overrides: { diagShortDeltaRange: [0.25, 0.35], diagShortDTERange: [25, 35] } },
  { name: 'pmcc-loose-short', overrides: { diagShortDeltaRange: [0.15, 0.25], diagShortDTERange: [35, 50] } },
  { name: 'pmcc-high-pt',     overrides: { diagLongProfitTarget: 0.50 } },
];

export const strategy: StrategyDefinition = {
  name: 'pmcc-qqq-anchor',
  tickers: ['QQQ'],

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

  buildConfig(_ticker: string, _direction: 'CALL' | 'PUT'): SimConfig {
    return PMCC_ANCHOR;
  },

  generateSignals(data: TickerDataBundle, _market: MarketContext): EntrySignal[] {
    // Always-in: one signal per trading day; portfolio constraints suppress overlap.
    // Skip the first 60 candles to let EMAs / regime data stabilize (matches other strategies).
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
