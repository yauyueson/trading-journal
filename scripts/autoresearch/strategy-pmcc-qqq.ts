/**
 * PMCC QQQ — Phase E2b, pmcc-pt50 confirmation campaign.
 *
 * Phase E2a sealed FAIL on 2026-04-22 with pmcc-tight-short as the decision-rule
 * winner (holdoutSpyIR -0.234). An anomaly surfaced: pmcc-high-pt (longPT=0.50)
 * passed all declared adoption criteria (holdoutSpyIR +0.259) but was not the
 * decision-rule winner, so it was not sealed.
 *
 * Phase E2b pre-registers pmcc-pt50 as the NAMED ANCHOR and tests neighboring
 * profit-target values (0.45, 0.55) as robustness checks. The anchor is ALWAYS
 * the sealed candidate regardless of which variant has the highest selection
 * combinedSharpe — this is a confirmation-of-effect design, not a winner
 * search.
 *
 * Structure: Poor Man's Covered Call on QQQ — long deep-ITM LEAP (delta ~0.75,
 * DTE ~270), rolling monthly short OTM calls (delta ~0.25, DTE ~30-45).
 * Always-in entry.
 *
 * Run via:
 *   AUTORESEARCH_LEADERBOARD_SUFFIX=pmcc-qqq-pt50 \
 *   AUTORESEARCH_STRATEGY_FILENAME=strategy-pmcc-qqq.ts \
 *   npx tsx scripts/autoresearch/runner.ts
 */
import type { StrategyDefinition, TickerDataBundle, MarketContext, EntrySignal, SimConfig, ConfigVariant } from './types';
import { DEFAULT_LEAP_CONFIG } from '../../src/lib/backtest/option-sim';

const PMCC_PT50_ANCHOR: SimConfig = {
  ...DEFAULT_LEAP_CONFIG,
  mode: 'DIAGONAL',
  diagLongDeltaRange: [0.70, 0.80],
  diagLongDTERange: [240, 300],
  diagShortDeltaRange: [0.20, 0.30],
  diagShortDTERange: [30, 45],
  diagLongProfitTarget: 0.50,              // ← the distinguishing parameter
  diagLongStopLoss: 0.35,
  diagLongTimeStopDTE: 90,
  diagShortProfitTarget: 0.50,
  diagRollTriggerMoneyness: 0.02,
  monitoringIntervalDays: 1,
};

const configVariants: ConfigVariant[] = [
  { name: 'pmcc-pt45', overrides: { diagLongProfitTarget: 0.45 } },
  { name: 'pmcc-pt55', overrides: { diagLongProfitTarget: 0.55 } },
];

export const strategy: StrategyDefinition = {
  name: 'pmcc-pt50-anchor',
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
    return PMCC_PT50_ANCHOR;
  },

  generateSignals(data: TickerDataBundle, _market: MarketContext): EntrySignal[] {
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
