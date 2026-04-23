/**
 * Bull Call Debit QQQ — NO-SIGNAL baseline (F0 exploration challenge).
 *
 * Earlier F0 runs established:
 *   - Signal-gated BCD wide (close > EMA34): oosSharpe 1.06, oosSpyIR 0.63
 *   - Random-entry BCD wide (seeded RNG, same count): oosSharpe 0.90, oosSpyIR 0.65
 *
 * Random-entry had essentially identical SPY IR, suggesting the EMA34
 * filter adds no timing alpha. This strategy tests fixed-cadence entries:
 * if a deterministic every-Nth-day entry produces similar metrics, the
 * EMA34 filter really is pure theater.
 *
 * Cadence selected via env var NOSIGNAL_CADENCE (default 10 trading days).
 *
 * Run via (three campaigns, one per cadence):
 *   NOSIGNAL_CADENCE=5 AUTORESEARCH_LEADERBOARD_SUFFIX=f0-bcd-nosignal-5d  ...
 *   NOSIGNAL_CADENCE=10 AUTORESEARCH_LEADERBOARD_SUFFIX=f0-bcd-nosignal-10d ...
 *   NOSIGNAL_CADENCE=20 AUTORESEARCH_LEADERBOARD_SUFFIX=f0-bcd-nosignal-20d ...
 */
import type { StrategyDefinition, TickerDataBundle, MarketContext, EntrySignal, SimConfig } from './types';
import { DEFAULT_LEAP_CONFIG } from '../../src/lib/backtest/option-sim';

const BULL_CALL_DEBIT_WIDE: SimConfig = {
  ...DEFAULT_LEAP_CONFIG,
  mode: 'DEBIT_SPREAD',
  debitDTERange: [30, 60],
  debitLongDelta: 0.50,
  debitShortDelta: 0.20,       // wide
  debitProfitTargetPct: 0.50,
  debitMaxHoldDays: 45,
  debitMinExitDTE: 7,
  monitoringIntervalDays: 1,
  fillMode: 'bidask',
};

const CADENCE = Number(process.env.NOSIGNAL_CADENCE ?? 10);
if (!Number.isFinite(CADENCE) || CADENCE < 1) {
  throw new Error(`NOSIGNAL_CADENCE must be a positive integer, got ${process.env.NOSIGNAL_CADENCE}`);
}

export const strategy: StrategyDefinition = {
  name: `bcd-nosignal-${CADENCE}d-anchor`,
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
    return BULL_CALL_DEBIT_WIDE;
  },

  generateSignals(data: TickerDataBundle, _market: MarketContext): EntrySignal[] {
    const signals: EntrySignal[] = [];
    for (let i = 60; i < data.candles.length; i += CADENCE) {
      signals.push({
        ticker: data.ticker,
        date: data.candles[i].date,
        direction: 'CALL',
        score: 50,
      });
    }
    return signals;
  },

  // No configVariants — each cadence is a separate campaign run.
};
