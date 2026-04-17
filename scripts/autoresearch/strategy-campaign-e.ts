/**
 * strategy-campaign-e.ts — reset to strict pre-reg incumbent (2026-04-17)
 *
 * ⚠️ CAMPAIGN E IS CONTAMINATED. Prior iteration results (ema3d, fullStack,
 *    noNT, sl33, tp50 findings) are NOT defensible as pre-registered.
 *    See campaign-e-audit.md and journal-campaign-e.md for details.
 *
 * This file is reset to the Campaign D strict-pre-reg winner `d65-sl35-ts105`
 * (combined 1.188, standalone 1.341, MaxDD 25.4%, 90 selection trades).
 * Any future Campaign E must start from here, not from `d65-tp40-ts150` (which
 * was incorrectly adopted in the earlier Campaign D recommendation and then
 * seeded Campaign E, contaminating all its iterations).
 *
 * Contamination sources now fixed in infrastructure:
 *   - runner.ts splits `isValid` into `isValidForSearch` (selection-only,
 *     agent-visible) and `isValid` (includes holdout, stripped from agent view)
 *   - `__BEGIN_REVIEWER_ONLY__ … __END_REVIEWER_ONLY__` sentinel blocks wrap
 *     holdout feedback; overnight shells strip them before passing to agent
 *   - Global attempts ledger (data/attempts-global.json) replaces per-suffix
 *     counter reset, so deflated Sharpe reflects true multi-campaign search
 *
 * Before running a fresh Campaign E:
 *   1. Verify run-campaign-e-overnight.sh exports AUTORESEARCH_MIN_OOS_TRADES=60.
 *   2. Verify the shell strips __REVIEWER_ONLY__ blocks (already patched).
 *   3. Update .prompts/campaign-e-d65-expansion-preregistration.md to reference
 *      combined 1.188 (not 1.180) as the incumbent threshold.
 *   4. Decide whether the +0.03 adoption bar is still the right threshold given
 *      the new incumbent.
 */
import type { StrategyDefinition, TickerDataBundle, MarketContext, EntrySignal, SimConfig } from './types';
import { DEFAULT_LEAP_CONFIG } from '../../src/lib/backtest/option-sim';

const CAMPAIGN_TICKERS = [
  'GLD', 'IWM', 'AAPL', 'MSFT', 'GOOG', 'AMZN', 'META',
  'JPM', 'GS', 'COST', 'UNH', 'NFLX', 'NVDA', 'TSLA',
];

export const strategy: StrategyDefinition = {
  name: 'd65-sl35-ts105-incumbent',
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
    holdoutCount: 5,
  },

  buildConfig(_ticker: string, _direction: 'CALL' | 'PUT'): SimConfig {
    // Campaign D strict pre-reg winner (d65-sl35-ts105):
    // - same delta range / DTE / TP / TS as baseline d65-tp40
    // - only change: SL loosened 0.30 → 0.35
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
        score: Math.round(100 - pct * 1000),
      });
    }

    return signals;
  },

  // No configVariants in the incumbent reset. Add them explicitly only when
  // starting a fresh pre-registered Campaign E with a clean leaderboard.
};
