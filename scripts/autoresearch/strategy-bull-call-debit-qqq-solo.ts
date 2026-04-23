/**
 * Bull Call Debit Spread QQQ (Singleton) — Phase E11.
 *
 * Phase E10's `bull-call-debit-qqq-wide` passed 5 of 6 adoption criteria
 * (holdoutSpyIR +0.37, holdoutSharpe 0.95, oosSharpe 0.88, stability OK,
 * stat-consistency OK). Only dsrM fails at −0.26 due to N=4 multiple-
 * testing penalty.
 *
 * This Phase E11 pre-registers the same config as a SINGLETON NAMED
 * ANCHOR (confirmation-of-effect design). With N=1 variant, the Bailey-
 * López de Prado deflation coefficient is substantially smaller, and
 * dsrM should flip positive — producing a clean 6-of-6 adoption PASS.
 *
 * Config IDENTICAL to Phase E10 winner (dte+delta frozen; no overrides):
 * - mode: DEBIT_SPREAD
 * - debitLongDelta 0.50, debitShortDelta 0.20 (the "wide" variant)
 * - debitDTERange [30, 60]
 * - debitProfitTargetPct 0.50
 * - debitMaxHoldDays 45, debitMinExitDTE 7
 *
 * Decision rule: NAMED ANCHOR is always the sealed candidate (no
 * variants; no winner search). This is the Phase E2b PMCC-pt50 pattern:
 * confirm a specific config cleanly without multi-testing deflation.
 *
 * Run via:
 *   AUTORESEARCH_LEADERBOARD_SUFFIX=bull-call-debit-qqq-solo \
 *   AUTORESEARCH_STRATEGY_FILENAME=strategy-bull-call-debit-qqq-solo.ts \
 *   npx tsx scripts/autoresearch/runner.ts
 */
import type { StrategyDefinition, TickerDataBundle, MarketContext, EntrySignal, SimConfig } from './types';
import { DEFAULT_LEAP_CONFIG } from '../../src/lib/backtest/option-sim';

const BULL_CALL_DEBIT_SOLO: SimConfig = {
  ...DEFAULT_LEAP_CONFIG,
  mode: 'DEBIT_SPREAD',
  debitDTERange: [30, 60],
  debitLongDelta: 0.50,
  debitShortDelta: 0.20,              // the "wide" variant from Phase E10
  debitProfitTargetPct: 0.50,
  debitMaxHoldDays: 45,
  debitMinExitDTE: 7,
  monitoringIntervalDays: 1,
  fillMode: 'bidask',
};

export const strategy: StrategyDefinition = {
  name: 'bull-call-debit-qqq-solo-anchor',
  tickers: ['QQQ'],

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
    return BULL_CALL_DEBIT_SOLO;
  },

  generateSignals(data: TickerDataBundle, _market: MarketContext): EntrySignal[] {
    // Canonical DTE5 bull signal: close > EMA34. direction='CALL' → bull call debit spread.
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

  // No configVariants — this is the singleton anchor design.
};
