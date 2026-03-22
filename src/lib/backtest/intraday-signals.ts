/**
 * 4H Signal Generator for WFA v3
 *
 * Generates PrecomputedSignal[] from 4H candles by calling the existing
 * calculateTechScore() with period-scaled TechScoreOptions.
 *
 * Period scaling: daily EMA(8) → 4H EMA(round(8 × mult)) where mult ∈ [1.5, 2.0, 2.5, 3.0].
 * Signal fires at close of every 4H bar (up to 2 entries/day vs 1 for daily).
 */

import type { IntradayCandle } from './intraday-cache';
import type { BacktestCandle, PrecomputedSignal, TechScoreOptions } from './types';
import { calculateTechScore, type TechScoreResult } from '../tech-analysis';
import { calcATR, calcADX, calcRVOL, detectSqueeze, emaFullSeries } from '../indicators';
import { computeRollingHV } from './bsm-pricing';

// ── Period Scaling ───────────────────────────────────────

/** Valid indicator period multipliers for 4H signals */
export const PERIOD_MULTIPLIERS = [1.5, 2.0, 2.5, 3.0] as const;
export type PeriodMultiplier = (typeof PERIOD_MULTIPLIERS)[number];

/**
 * Scale all indicator periods by a multiplier.
 * Daily periods become 4H periods: e.g. EMA(8) → EMA(round(8 × 2.0)) = EMA(16).
 */
export function scaleIndicatorPeriods(
  mult: number,
  base?: TechScoreOptions,
): TechScoreOptions {
  const b = base ?? {};
  return {
    ...b,
    sc_mb_len: Math.round((b.sc_mb_len ?? 100) * mult),
    sc_osc_len: Math.round((b.sc_osc_len ?? 14) * mult),
    sc_bx_s1: Math.round((b.sc_bx_s1 ?? 8) * mult),
    sc_bx_s2: Math.round((b.sc_bx_s2 ?? 21) * mult),
    sc_bx_l1: Math.round((b.sc_bx_l1 ?? 50) * mult),
    sc_bx_l2: Math.round((b.sc_bx_l2 ?? 100) * mult),
  };
}

// ── Conversion ───────────────────────────────────────────

/** Convert IntradayCandle to BacktestCandle for engine compatibility */
function toBacktestCandle(c: IntradayCandle): BacktestCandle {
  return {
    date: c.datetime,          // Use full datetime for 4H uniqueness
    timestamp: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  };
}

// ── IV Rank Computation ──────────────────────────────────

export interface IVDataRow {
  date: string;
  iv30d: number | null;
  iv60d?: number | null;
  hv20d?: number | null;
  hv30d?: number | null;
  hv60d?: number | null;
}

// ── Signal Precomputation ────────────────────────────────

/**
 * Precompute signals from 4H candles with scaled indicator periods.
 *
 * Runs calculateTechScore with full weights once, then derives preset-specific
 * signals by re-weighting sub-scores (same optimization as v2 runner).
 */
export function precomputeSignals4H(
  candles: IntradayCandle[],
  ivData: IVDataRow[],
  periodMultiplier: number,
  opts?: TechScoreOptions,
): PrecomputedSignal[] {
  if (candles.length < 50) return [];

  const btCandles = candles.map(toBacktestCandle);
  const scaledOpts = scaleIndicatorPeriods(periodMultiplier, opts);

  // Compute lookback based on scaled periods
  const mbLen = scaledOpts.sc_mb_len ?? Math.round(100 * periodMultiplier);
  const lookback = Math.max(150, mbLen * 2 + 30);

  if (btCandles.length < lookback) return [];

  const highs = btCandles.map(c => c.high);
  const lows = btCandles.map(c => c.low);
  const closes = btCandles.map(c => c.close);
  const volumes = btCandles.map(c => c.volume);
  const atrSeries = calcATR(highs, lows, closes, Math.round(14 * periodMultiplier));
  const ema8Series = emaFullSeries(closes, Math.round(8 * periodMultiplier));

  // Rolling HV for BSM repricing
  const hvWindow = Math.round(20 * periodMultiplier);
  const hv20Series = computeRollingHV(closes, hvWindow);
  const hv30Series = computeRollingHV(closes, Math.round(30 * periodMultiplier));
  const hv60Series = computeRollingHV(closes, Math.round(60 * periodMultiplier));

  // Quality gate series — destructure to get the arrays
  const { adx: adxSeries } = calcADX(highs, lows, closes, Math.round(14 * periodMultiplier));
  const { rvol: rvolSeries } = calcRVOL(volumes, Math.round(20 * periodMultiplier));
  const squeezeSeries = detectSqueeze(closes, highs, lows);

  // Build ORATS IV lookup by date (daily IV applies to all 4H bars that day)
  const ivLookup = new Map<string, { iv30d: number | null; iv60d: number | null }>();
  for (const row of ivData) {
    ivLookup.set(row.date, { iv30d: row.iv30d, iv60d: row.iv60d ?? null });
  }

  const signals: PrecomputedSignal[] = [];

  for (let i = lookback; i < btCandles.length; i++) {
    const slice = btCandles.slice(0, i + 1);
    const result: TechScoreResult = calculateTechScore(slice, scaledOpts);

    const atr = atrSeries[i];
    const ema8 = ema8Series[i];
    const close = btCandles[i].close;
    const d8 = ema8 > 0 ? ((close - ema8) / ema8) * 100 : 0;

    // Map 4H bar to its trading date for IV lookup
    const barDate = candles[i].date; // 'YYYY-MM-DD'
    const ivRow = ivLookup.get(barDate);

    // Quality gate data
    const adx = adxSeries[i];
    const rvol = rvolSeries[i];
    const isSqueeze = squeezeSeries[i];

    signals.push({
      barIndex: i,
      date: btCandles[i].date,    // Full datetime
      score: result.techScore,
      type: result.type,
      setup: result.setup,
      confidence: result.confidence,
      d8,
      atr: atr ?? 0,
      close,
      adx: adx ?? 0,
      rvol: rvol ?? 0,
      isSqueeze,
      ivEstimate: hv20Series[i],
      ivEstimate30: hv30Series[i],
      ivEstimate60: hv60Series[i],
      oratsIV30: ivRow?.iv30d ?? undefined,
      oratsIV60: ivRow?.iv60d ?? undefined,
      subScores: result.components ? {
        sc_mb: result.components.sc_mb,
        sc_bxs: result.components.sc_bxs,
        sc_bxl: result.components.sc_bxl,
        sc_ema: result.components.sc_ema,
        sc_mom: result.components.sc_mom,
      } : undefined,
    });
  }

  return signals;
}

// (derivePresetSignals removed to fix WFA subScores bug — compute directly per preset instead)
