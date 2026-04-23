/**
 * PMCC QQQ pt60 — Phase F1 singleton anchor (first F1 adoption attempt).
 *
 * Phase F0 clean-slate declaration (2026-04-23) reset the attempt counter.
 * This is the first pre-registered F1 campaign. Pre-reg in
 * .handoff/current.md — see that file for hypothesis, decision rule,
 * adoption threshold, F0 boundary, and residual-priors disclosure.
 *
 * Config drawn from the F0 exploration sweep (data/leaderboard-full-f0-pmcc-sweep.json):
 * pmcc-pt60 produced oosSharpe 1.72, oosSpyIR +0.85, oosMaxDD 17.5%,
 * holdoutSharpe 1.63, holdoutSpyIR +0.15, passesStability and
 * passesStatConsistency both true. Under F0 effective N (was ~18 at
 * exploration, ~22 at this seal), dsrM clears > 0 with comfortable margin.
 *
 * Signal: always-in (every trading day from i=60). PMCC's edge is
 * structural (premium collection on top of directional long-LEAP
 * exposure), not timing. The F0 random-entry null test on BCD
 * (strategy-bcd-qqq-random.ts) confirmed the EMA34 signal has no
 * timing alpha; PMCC deliberately does not use a timing signal.
 *
 * Decision rule: NAMED ANCHOR is always the sealed candidate — this is
 * a confirmation-of-effect design, not a winner search. No variants.
 *
 * Run via:
 *   AUTORESEARCH_LEADERBOARD_SUFFIX=pmcc-qqq-pt60-f1 \
 *   AUTORESEARCH_STRATEGY_FILENAME=strategy-pmcc-qqq-pt60-f1.ts \
 *   npx tsx scripts/autoresearch/runner.ts
 */
import type { StrategyDefinition, TickerDataBundle, MarketContext, EntrySignal, SimConfig } from './types';
import { DEFAULT_LEAP_CONFIG } from '../../src/lib/backtest/option-sim';

const PMCC_PT60_F1_CONFIG: SimConfig = {
  ...DEFAULT_LEAP_CONFIG,
  mode: 'DIAGONAL',
  diagLongDeltaRange: [0.70, 0.80],
  diagLongDTERange: [240, 300],
  diagShortDeltaRange: [0.20, 0.30],
  diagShortDTERange: [30, 45],
  diagLongProfitTarget: 0.60,              // pt60 — the distinguishing parameter from pre-F0 pt50
  diagLongStopLoss: 0.35,
  diagLongTimeStopDTE: 90,
  diagShortProfitTarget: 0.50,
  diagRollTriggerMoneyness: 0.02,
  monitoringIntervalDays: 1,
};

export const strategy: StrategyDefinition = {
  name: 'pmcc-qqq-pt60-f1-anchor',
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
    return PMCC_PT60_F1_CONFIG;
  },

  generateSignals(data: TickerDataBundle, _market: MarketContext): EntrySignal[] {
    // Always-in: every trading day from i=60 forward. PMCC is structurally
    // edge-producing; no timing signal is used (per F0 null-test finding).
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

  // No configVariants — this is a singleton confirmation design.
};
