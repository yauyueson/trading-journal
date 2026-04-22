/**
 * DTE5 Mega-cap Sweep — Phase E3.
 *
 * Tests whether the validated DTE5 bull put credit spread structure
 * (QQQ) generalizes to individual mega-cap tickers. Fits a $2K account
 * at $5 spread width.
 *
 * Pre-registered in .handoff/current.md (2026-04-22).
 *
 * Structure: Bull put credit spread on a pre-reg'd mega-cap basket.
 * - Short put delta 0.30, long put delta 0.20
 * - DTE 2-7 (peak 5)
 * - Width $5 (half of QQQ default $10 to fit $2K account)
 * - Stop loss 2.5× credit
 * - Trailing lock 50% activate / 50% floor
 * - Hold-to-expiry (profitTarget=1.0, timeStopDTE=0)
 * - IV-rank filter: none (EMA55 gate replaces)
 * - Signal: price > EMA55 AND SPY > EMA200 AND EMA8 > EMA13 AND EMA34 rising
 *
 * Portfolio: maxPositions=1, maxPerTicker=1 — one spread at a time
 * across the whole mega-cap basket (first-come-first-served by signal
 * date). Realistic small-account scenario.
 *
 * Run via:
 *   AUTORESEARCH_LEADERBOARD_SUFFIX=dte5-megacap \
 *   AUTORESEARCH_STRATEGY_FILENAME=strategy-dte5-megacap.ts \
 *   npx tsx scripts/autoresearch/runner.ts
 */
import type { StrategyDefinition, TickerDataBundle, MarketContext, EntrySignal, SimConfig, ConfigVariant } from './types';

// Pre-registered mega-cap set: high liquidity, tight bid/ask, sufficient
// options volume for credit spreads at $5 width.
const MEGACAP_TICKERS = ['AAPL', 'MSFT', 'NVDA', 'GOOG'];

const DTE5_MEGACAP_ANCHOR: SimConfig = {
  mode: 'CREDIT_SPREAD',
  leapDeltaRange: [0.65, 0.80],           // unused for CREDIT_SPREAD
  leapDTERange: [180, 365],                // unused
  leapProfitTarget: 0.50,                  // unused
  leapStopLoss: 0.30,                      // unused
  leapTimeStopDTE: 90,                     // unused
  creditShortDelta: 0.30,
  creditSpreadWidth: 5,                    // $5 wide — fits $2K account at 25% risk
  creditDTERange: [2, 7],
  creditProfitTarget: 1.0,                 // hold-to-expiry
  creditStopLossMultiple: 2.5,
  creditTimeStopDTE: 0,                    // hold-to-expiry, no time stop
  trailingActivatePct: 0.50,
  trailingFloorPct: 0.50,
  monitoringIntervalDays: 1,
  minIVRank: 0,                            // EMA55 gate replaces
  fillMode: 'bidask',
  slippage: {
    baseMultiplier: 1.0,
    oiPivot: 500,
    oiExponent: 0.5,
    dtePivot: 30,
    dteExponent: 0.5,
  },
};

const configVariants: ConfigVariant[] = [
  { name: 'dte5-megacap-tight',  overrides: { creditShortDelta: 0.25 } },
  { name: 'dte5-megacap-wide',   overrides: { creditShortDelta: 0.35 } },
  { name: 'dte5-megacap-w10',    overrides: { creditSpreadWidth: 10 } },
];

export const strategy: StrategyDefinition = {
  name: 'dte5-megacap-anchor',
  tickers: MEGACAP_TICKERS,

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
    return DTE5_MEGACAP_ANCHOR;
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

      // SPY macro regime gate
      const spy = market.spyByDate.get(c.date);
      if (!spy || !spy.ema200 || spy.ema200 <= 0) continue;
      if (spy.close <= spy.ema200) continue;

      // Ticker trend gate: price above EMA55
      if (c.close <= ema55[i]) continue;

      // Short-term momentum gate: EMA8 > EMA13 AND EMA34 rising 5d
      if (!(ema8[i] > ema13[i] && ema34[i] > ema34[i - 5])) continue;

      // Bull put credit spread → direction='PUT' (sell put below, buy put further below)
      signals.push({
        ticker: data.ticker,
        date: c.date,
        direction: 'PUT',
        score: 0,
      });
    }

    return signals;
  },

  configVariants,
};
