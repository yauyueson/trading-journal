/**
 * strategy-campaign-d.ts — d65-tp40 sensitivity sweep
 *
 * Pre-registered in .prompts/campaign-d-d65-sensitivity-preregistration.md
 *
 * Single signal generator (exact d65-tp40 champion logic). 26 configVariants
 * sweeping TS, TP, SL, delta range, DTE range, and targeted intersections.
 *
 * Purpose:
 * 1. Re-validate the champion metrics under current code (post all trust-gotcha fixes).
 * 2. Extract any nearby alpha that was overlooked or obscured by code-version drift.
 *
 * Decision rule (from pre-reg):
 * - Pick highest selection combinedSharpe that passes validity + deflated>0
 * - Adopt winner only if it beats baseline combinedSharpe by ≥ 0.05
 * - Holdout is observed but NOT used for ranking
 *
 * Run:
 *   AUTORESEARCH_LEADERBOARD_SUFFIX=campaign-d \
 *     AUTORESEARCH_STRATEGY_FILENAME=strategy-campaign-d.ts \
 *     AUTORESEARCH_MIN_OOS_TRADES=60 \
 *     npx tsx scripts/autoresearch/runner.ts
 */
import type { StrategyDefinition, TickerDataBundle, MarketContext, EntrySignal, SimConfig } from './types';
import { DEFAULT_LEAP_CONFIG } from '../../src/lib/backtest/option-sim';

const CAMPAIGN_TICKERS = [
  'GLD', 'IWM', 'AAPL', 'MSFT', 'GOOG', 'AMZN', 'META',
  'JPM', 'GS', 'COST', 'UNH', 'NFLX', 'NVDA', 'TSLA',
];

export const strategy: StrategyDefinition = {
  name: 'd65-tp40-baseline',
  tickers: CAMPAIGN_TICKERS,

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
    holdoutCount: 5,  // selection ends 2024-01-19, holdout covers 2024-01-22 → 2026-02-27
  },

  buildConfig(_ticker: string, _direction: 'CALL' | 'PUT'): SimConfig {
    return {
      ...DEFAULT_LEAP_CONFIG,
      mode: 'LEAP' as const,
      leapDeltaRange: [0.65, 0.80] as [number, number],
      leapDTERange: [180, 270] as [number, number],
      leapProfitTarget: 0.40,
      leapStopLoss: 0.30,
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

      // Validity guards (identical to champion)
      if (ema8[i] <= 0 || ema13[i] <= 0) continue;
      if (ema34[i] <= 0 || ema34[i - 5] <= 0) continue;
      if (ema55[i] <= 0 || ema200[i] <= 0) continue;

      const spy = market.spyByDate.get(c.date);
      if (!spy || !spy.ema200 || spy.ema200 <= 0) continue;

      // Champion gates
      if (spy.close <= spy.ema200) continue;            // SPY > EMA200
      if (c.close <= ema55[i]) continue;                // ticker > EMA55
      if (!(ema8[i] > ema13[i] && ema34[i] > ema34[i - 5])) continue;

      const pct = (c.close - ema34[i]) / ema34[i];
      if (!(pct >= 0 && pct < 0.05)) continue;          // 0-5% band above EMA34

      const regime = data.regimeByDate.get(c.date);
      if (regime && regime.contangoPct !== undefined && regime.contangoPct >= 48) continue;

      signals.push({
        ticker: data.ticker,
        date: c.date,
        direction: 'CALL',
        score: Math.round(100 - pct * 1000),
      });
    }

    return signals;
  },

  // 26 pre-registered variants: TS/TP/SL/delta/DTE sensitivity + 6 combinations
  configVariants: [
    // Time stop sweep (5 new + baseline-equivalent)
    { name: 'd65-tp40-ts090', overrides: { leapTimeStopDTE: 90 } },
    { name: 'd65-tp40-ts105', overrides: { leapTimeStopDTE: 105 } },
    { name: 'd65-tp40-ts120', overrides: { leapTimeStopDTE: 120 } },
    { name: 'd65-tp40-ts135', overrides: { leapTimeStopDTE: 135 } },
    { name: 'd65-tp40-ts150', overrides: { leapTimeStopDTE: 150 } },
    { name: 'd65-tp40-ts180', overrides: { leapTimeStopDTE: 180 } },

    // Profit target sweep (4 variants; 0.40 = baseline)
    { name: 'd65-tp30-ts105', overrides: { leapProfitTarget: 0.30 } },
    { name: 'd65-tp35-ts105', overrides: { leapProfitTarget: 0.35 } },
    { name: 'd65-tp45-ts105', overrides: { leapProfitTarget: 0.45 } },
    { name: 'd65-tp50-ts105', overrides: { leapProfitTarget: 0.50 } },

    // Stop loss sweep (3 variants; 0.30 = baseline)
    { name: 'd65-sl20-ts105', overrides: { leapStopLoss: 0.20 } },
    { name: 'd65-sl25-ts105', overrides: { leapStopLoss: 0.25 } },
    { name: 'd65-sl35-ts105', overrides: { leapStopLoss: 0.35 } },

    // Delta range sweep (3 variants; [0.65, 0.80] = baseline)
    { name: 'd60-tp40-ts105', overrides: { leapDeltaRange: [0.60, 0.75] as [number, number] } },
    { name: 'd70-tp40-ts105', overrides: { leapDeltaRange: [0.70, 0.85] as [number, number] } },
    { name: 'd75-tp40-ts105', overrides: { leapDeltaRange: [0.75, 0.90] as [number, number] } },

    // DTE range sweep (3 variants; [180, 270] = baseline)
    { name: 'd65-dte150-ts105', overrides: { leapDTERange: [150, 240] as [number, number] } },
    { name: 'd65-dte210-ts105', overrides: { leapDTERange: [210, 300] as [number, number] } },
    { name: 'd65-dte120-ts105', overrides: { leapDTERange: [120, 180] as [number, number] } },

    // Combination probes (6)
    { name: 'd65-tp40-ts150-sl25', overrides: { leapTimeStopDTE: 150, leapStopLoss: 0.25 } },
    { name: 'd65-tp45-ts150', overrides: { leapTimeStopDTE: 150, leapProfitTarget: 0.45 } },
    { name: 'd65-tp35-ts090', overrides: { leapTimeStopDTE: 90, leapProfitTarget: 0.35 } },
    { name: 'd70-tp45-ts150', overrides: {
      leapDeltaRange: [0.70, 0.85] as [number, number],
      leapTimeStopDTE: 150,
      leapProfitTarget: 0.45,
    } },
    { name: 'd65-tp40-ts120-dte210', overrides: {
      leapTimeStopDTE: 120,
      leapDTERange: [210, 300] as [number, number],
    } },
    { name: 'd60-tp35-ts090', overrides: {
      leapDeltaRange: [0.60, 0.75] as [number, number],
      leapTimeStopDTE: 90,
      leapProfitTarget: 0.35,
    } },
  ],
};
