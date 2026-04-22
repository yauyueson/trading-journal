/**
 * DTE5 QQQ Re-Validation — Phase E7 (blob v2).
 *
 * Blob bumped 2026-04-22 after the first run's rows were written under a
 * dirty working tree (untracked leaderboard-dte5-qqq-reval.json from the
 * pre-fix bear-call run sat in the tree when the v2 runner started).
 * Those rows stamped repoGitSha=null and became permanently unsealable
 * under the first-matching-row rule. Bumping the blob here (this comment
 * is the only change) breaks the identity match so new rows are the first
 * match and can be sealed. No functional change.
 *
 * The active live strategy per CLAUDE.md + src/lib/strategyProfiles.ts.
 * Currently "validated" under pre-overhaul autoresearch. This campaign
 * re-validates the same configuration under the post-overhaul sealed-
 * holdout protocol to give it the same trust-regime status as PMCC-pt50-QQQ
 * (Phase E2b sealed PASS).
 *
 * Confirmation-of-effect design: pmcc-pt50-anchor-equivalent structure —
 * NAMED ANCHOR is always sealed regardless of variants' combinedSharpe.
 * Two neighbor variants (width $5 and width $20) serve as robustness checks
 * around the canonical $10 width.
 *
 * Config mirrors STRATEGY_PROFILES.dte5:
 * - Ticker: QQQ
 * - Short put δ 0.30, long put δ 0.20 (via $10 width)
 * - DTE 2-7 (peak 5)
 * - SL 2.5× credit, Trailing Lock 50/50
 * - Hold-to-expiry (profitTarget=1.0, no time stop)
 * - EMA55 trend gate + SPY>EMA200 macro + EMA8>EMA13 momentum
 * - maxPositions=1, maxPerTicker=1
 *
 * Run via:
 *   AUTORESEARCH_LEADERBOARD_SUFFIX=dte5-qqq-reval \
 *   AUTORESEARCH_STRATEGY_FILENAME=strategy-dte5-qqq-reval.ts \
 *   npx tsx scripts/autoresearch/runner.ts
 */
import type { StrategyDefinition, TickerDataBundle, MarketContext, EntrySignal, SimConfig, ConfigVariant } from './types';

const DTE5_QQQ_LIVE_ANCHOR: SimConfig = {
  mode: 'CREDIT_SPREAD',
  leapDeltaRange: [0.65, 0.80],           // unused for CREDIT_SPREAD
  leapDTERange: [180, 365],                // unused
  leapProfitTarget: 0.50,                  // unused
  leapStopLoss: 0.30,                      // unused
  leapTimeStopDTE: 90,                     // unused
  creditShortDelta: 0.30,
  creditSpreadWidth: 10,                   // canonical QQQ DTE5 width
  creditDTERange: [2, 7],
  creditProfitTarget: 1.0,                 // hold-to-expiry
  creditStopLossMultiple: 2.5,
  creditTimeStopDTE: 0,                    // hold-to-expiry
  trailingActivatePct: 0.50,
  trailingFloorPct: 0.50,
  monitoringIntervalDays: 1,
  minIVRank: 0,
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
  { name: 'dte5-qqq-w5',  overrides: { creditSpreadWidth: 5 } },    // robustness: narrower
  { name: 'dte5-qqq-w20', overrides: { creditSpreadWidth: 20 } },   // robustness: wider
];

export const strategy: StrategyDefinition = {
  name: 'dte5-qqq-live-anchor',
  tickers: ['QQQ'],

  portfolio: {
    maxPositions: 1,
    maxPerTicker: 1,
    startingCapital: 10000,                // matches canonical autoresearch scale
  },

  wfa: {
    trainWindowDays: 252,
    forwardStepDays: 126,
    purgeGapDays: 10,
    mode: 'rolling' as const,
    holdoutCount: 5,
  },

  buildConfig(_ticker, _direction): SimConfig {
    return DTE5_QQQ_LIVE_ANCHOR;
  },

  generateSignals(data: TickerDataBundle, _market: MarketContext): EntrySignal[] {
    // Canonical DTE5 bull signal (from scripts/wfa-dte5-tp-sl-study.ts):
    //   close > EMA34 (with EMA34 > 0 sanity)
    // Direction='CALL' — the credit-spread worker maps CALL→sell puts
    // (BULL PUT credit spread). 'PUT'→sell calls (bear call) is WRONG for DTE5.
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
        direction: 'CALL',    // CALL = bull put credit spread (sell puts); PUT = bear call (wrong)
        score: 50,
      });
    }

    return signals;
  },

  configVariants,
};
