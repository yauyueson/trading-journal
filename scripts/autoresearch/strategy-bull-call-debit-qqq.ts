/**
 * Bull Call Debit Spread QQQ — Phase E10 ($2K-friendly, bounded risk).
 *
 * Structure: buy higher-delta (lower-strike) call + sell lower-delta
 * (higher-strike) call at same expiry. Net debit = max loss.
 *
 * Designed as a capital-efficient + drawdown-tamed alternative to the
 * outright long call tested in Phase E9 (which had 60-65% MaxDD). The
 * short-leg premium partially offsets the long-leg cost, reducing max
 * loss per trade from $500-800 (outright) to $200-400 (spread).
 *
 * Phase E9 showed long-call anchor/atm/short-dte all passed holdoutSpyIR
 * but failed MaxDD gate. If the short leg's cushion is enough to bring
 * MaxDD under 45% while keeping positive SPY IR, this structure PASSES
 * full sealed adoption on a $2K account.
 *
 * Capital per position at QQQ ~$500: net debit ~$3-5 → $300-500 per
 * contract. Fits $2K with maxPositions=1 at ~20-25% risk per trade.
 *
 * Engine: uses new makeDebitSpreadEvaluator in worker.ts (wired Phase E10).
 *
 * Run via:
 *   AUTORESEARCH_LEADERBOARD_SUFFIX=bull-call-debit-qqq \
 *   AUTORESEARCH_STRATEGY_FILENAME=strategy-bull-call-debit-qqq.ts \
 *   npx tsx scripts/autoresearch/runner.ts
 */
import type { StrategyDefinition, TickerDataBundle, MarketContext, EntrySignal, SimConfig, ConfigVariant } from './types';
import { DEFAULT_LEAP_CONFIG } from '../../src/lib/backtest/option-sim';

const BULL_CALL_DEBIT_ANCHOR: SimConfig = {
  ...DEFAULT_LEAP_CONFIG,
  mode: 'DEBIT_SPREAD',
  // Debit spread parameters
  debitDTERange: [30, 60],
  debitLongDelta: 0.50,         // long call at ATM
  debitShortDelta: 0.30,        // short call ~3-5% OTM
  debitProfitTargetPct: 0.50,   // close at +50% of max profit
  debitMaxHoldDays: 45,
  debitMinExitDTE: 7,
  monitoringIntervalDays: 1,
  fillMode: 'bidask',
};

const configVariants: ConfigVariant[] = [
  // Spread-width variants (vary short delta, hold long delta)
  { name: 'bull-call-debit-qqq-narrow', overrides: { debitShortDelta: 0.40 } },  // tighter spread
  { name: 'bull-call-debit-qqq-wide',   overrides: { debitShortDelta: 0.20 } },  // wider spread
  // Profit target variants
  { name: 'bull-call-debit-qqq-pt30',   overrides: { debitProfitTargetPct: 0.30 } }, // fast exit
  { name: 'bull-call-debit-qqq-pt70',   overrides: { debitProfitTargetPct: 0.70 } }, // hold longer
  // Long-leg delta variants (moneyness)
  { name: 'bull-call-debit-qqq-itm',    overrides: { debitLongDelta: 0.65 } }, // deeper ITM long
  { name: 'bull-call-debit-qqq-otm',    overrides: { debitLongDelta: 0.35 } }, // OTM long (cheaper)
  // DTE variants
  { name: 'bull-call-debit-qqq-shortdte', overrides: { debitDTERange: [15, 30] } }, // shorter DTE
  { name: 'bull-call-debit-qqq-longdte',  overrides: { debitDTERange: [60, 90] } }, // longer DTE
];

export const strategy: StrategyDefinition = {
  name: 'bull-call-debit-qqq-anchor',
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

  configVariants,
};
