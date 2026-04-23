/**
 * Bull Call Debit QQQ — RANDOM-ENTRY null test (Phase F0 challenge).
 *
 * Same structure, capital, and config variants as strategy-bull-call-debit-qqq.ts,
 * BUT generateSignals replaces the EMA34 filter with a seeded RNG that emits
 * the same approximate number of entries at random trading days. If the
 * gated variant's OOS Sharpe / SPY IR do not materially exceed the random-
 * entry variant's, the EMA34 signal contributes no timing alpha — the
 * observed performance is pure directional beta from the debit-spread
 * structure in a bull-market window.
 *
 * Target entry count: ~600 signals (matches the EMA34-gated count observed
 * during F0 sweep runs on QQQ 2016-01 → 2026-02). The RNG seed is fixed
 * so the test is reproducible.
 *
 * Run via:
 *   AUTORESEARCH_STRATEGY_FILENAME=strategy-bcd-qqq-random.ts \
 *   AUTORESEARCH_LEADERBOARD_SUFFIX=f0-bcd-random \
 *   AUTORESEARCH_PREREG_BYPASS="random-entry null test" \
 *   npx tsx scripts/autoresearch/runner.ts
 */
import type { StrategyDefinition, TickerDataBundle, MarketContext, EntrySignal, SimConfig, ConfigVariant } from './types';
import { DEFAULT_LEAP_CONFIG } from '../../src/lib/backtest/option-sim';

const BULL_CALL_DEBIT_ANCHOR: SimConfig = {
  ...DEFAULT_LEAP_CONFIG,
  mode: 'DEBIT_SPREAD',
  debitDTERange: [30, 60],
  debitLongDelta: 0.50,
  debitShortDelta: 0.30,
  debitProfitTargetPct: 0.50,
  debitMaxHoldDays: 45,
  debitMinExitDTE: 7,
  monitoringIntervalDays: 1,
  fillMode: 'bidask',
};

// Mirror the key variants from the signal-gated sweep so we can compare
// head-to-head. Only variants whose signal-gated counterpart looked
// interesting are retested under random entry.
const configVariants: ConfigVariant[] = [
  { name: 'bcd-random-wide',  overrides: { debitShortDelta: 0.20 } },  // mirrors bull-call-debit-qqq-wide
  { name: 'bcd-random-pt70',  overrides: { debitProfitTargetPct: 0.70 } },
  { name: 'bcd-random-itm',   overrides: { debitLongDelta: 0.65 } },
];

// Mulberry32 — small fast seeded PRNG, deterministic across runs.
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Target entry count: the signal-gated EMA34 filter produced ~608 QQQ signals
// across the 2016-2026 window in the F0 sweep (see leaderboard-full-f0-bcd-sweep.json
// trades counts × window ratio). We pick each trading day independently with
// probability targetCount / totalDays to get ~608 entries.
const TARGET_ENTRY_RATE = 608 / 2301;  // 2301 candles ≈ 10y trading days
const RNG_SEED = 20260423;  // F0 first exploration date

export const strategy: StrategyDefinition = {
  name: 'bcd-random-anchor',
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
    return BULL_CALL_DEBIT_ANCHOR;
  },

  generateSignals(data: TickerDataBundle, _market: MarketContext): EntrySignal[] {
    const rng = mulberry32(RNG_SEED);
    const signals: EntrySignal[] = [];
    const n = data.candles.length;
    for (let i = 55; i < n; i++) {
      if (rng() < TARGET_ENTRY_RATE) {
        signals.push({
          ticker: data.ticker,
          date: data.candles[i].date,
          direction: 'CALL',
          score: 50,
        });
      }
    }
    return signals;
  },

  configVariants,
};
