/**
 * strategy-30-naive-baseline.ts — Foundational diagnostic.
 *
 * Answers the single question: does the LEAP-CALL-on-30-tickers family have
 * any out-of-sample edge once the EMA selection layer is removed?
 *
 * Identical to strategy-30-smoke.ts except `score` is a constant (0) so the
 * portfolio's 4-slot allocator has no information to rank on. Concurrent
 * signals fall back to insertion-order tie-break, which is the closest
 * approximation of "take every qualifying signal" without changing the runner.
 *
 * Prior smokes with EMA scoring (smoke30, smoke30-revscore) both had
 * holdout SPY IR < 0 and failed the 14-ticker delta gate. This run tells us
 * whether the baseline itself would have passed.
 *
 * Verdict rule:
 *   Holdout SPY IR ≥ 0.3 AND holdout Sharpe ≥ 0.3 → foundation is real.
 *   Otherwise → LEAP-CALL family is a selection-window mirage.
 *
 * Run:
 *   AUTORESEARCH_LEADERBOARD_SUFFIX=smoke30-naive \
 *     AUTORESEARCH_STRATEGY_FILENAME=strategy-30-naive-baseline.ts \
 *     AUTORESEARCH_MIN_OOS_TRADES=60 \
 *     npx tsx scripts/autoresearch/runner.ts
 */
import type { StrategyDefinition, TickerDataBundle, MarketContext, EntrySignal, SimConfig } from './types';
import { DEFAULT_LEAP_CONFIG } from '../../src/lib/backtest/option-sim';

const UNIVERSE_30 = [
  'IWM', 'AAPL', 'MSFT', 'GOOG', 'AMZN', 'META', 'JPM', 'GS', 'COST', 'NFLX', 'NVDA', 'TSLA',
  'AMD', 'AVGO', 'BA', 'COIN', 'HOOD', 'LULU', 'MSTR', 'PLTR', 'UBER',
  'CRM',
  'ORCL', 'CRWD', 'SHOP', 'PANW', 'ANET', 'VRT', 'ARM', 'NOW',
];

export const strategy: StrategyDefinition = {
  name: 'smoke30-naive-d65-sl35-ts105',
  tickers: UNIVERSE_30,

  portfolio: {
    maxPositions: 4,
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
    return {
      ...DEFAULT_LEAP_CONFIG,
      mode: 'LEAP' as const,
      leapDeltaRange: [0.65, 0.80] as [number, number],
      leapDTERange: [180, 270] as [number, number],
      leapProfitTarget: 0.40,
      leapStopLoss: 0.35,
      leapTimeStopDTE: 105,
      monitoringIntervalDays: 1,
    };
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

      const pct = (c.close - ema34[i]) / ema34[i];
      if (!(pct >= 0 && pct < 0.05)) continue;

      const regime = data.regimeByDate.get(c.date);
      if (regime && regime.contangoPct !== undefined && regime.contangoPct >= 48) continue;

      signals.push({
        ticker: data.ticker,
        date: c.date,
        direction: 'CALL',
        score: 0,
      });
    }

    return signals;
  },
};
