/**
 * Signal Quality Backtester — Core Engine
 *
 * Walk-forward simulator that:
 * 1. Pre-computes tech analysis signals (expensive, done once)
 * 2. Runs cheap TP/SL simulation loops for each config
 * 3. Supports MFE/MAE tracking at multiple time windows
 * 4. Supports both Daily (v3) and 4H (v4) timeframes
 *
 * Daily: signals from calculateTechScore(), TP/SL on daily bars
 * 4H:    signals from calculateTechScoreV4() on aggregated daily bars,
 *        TP/SL on 4H bars for granular exit detection
 */

import { calculateTechScore, calculateTechScoreV4, aggregateToWeekly, type TechScoreResult, type TechScoreV4Result, type TechScoreOptions } from '../tech-analysis';
import { calcATR, calcADX, calcRVOL, detectSqueeze, emaFullSeries } from '../indicators';
import { bsmPrice, bsmDelta, computeRollingHV, ouIVEvolution } from './bsm-pricing';
import type {
  BacktestCandle,
  BacktestConfig,
  BacktestTrade,
  BacktestResult,
  PrecomputedSignal,
  EntryQuality,
  Tier,
  ExitType,
  GateStats,
} from './types';
import { computeAnalytics } from './analytics';

// ── Constants ───────────────────────────────────────────

/**
 * Compute lookback based on the longest indicator period.
 * EMA(N) with emaFullSeries needs ~2×N bars to stabilize within 1%.
 * RSI adds 15 bars on top. Floor at 150 for safety.
 */
function computeLookback(indicatorOptions?: TechScoreOptions): number {
  const mbLen = indicatorOptions?.sc_mb_len ?? 100;
  // 2× longest EMA period + RSI(15) buffer + safety margin
  return Math.max(150, mbLen * 2 + 30);
}

/** Legacy constant for 4H mode which doesn't take indicatorOptions */
const LOOKBACK_DAILY = 230;

// ── Entry Quality (ported from Pine v3.2 lines 1510-1517) ──

export function classifyEntryQuality(d8: number): { quality: EntryQuality; eqNorm: number } {
  const absD8 = Math.abs(d8);
  if (absD8 < 0.3)  return { quality: 'OPTIMAL',    eqNorm: 0.75 };
  if (absD8 < 0.8)  return { quality: 'ACCEPTABLE', eqNorm: 0.25 };
  if (absD8 < 1.5)  return { quality: 'MARGINAL',   eqNorm: -0.10 };
  return                     { quality: 'CHASING',    eqNorm: -0.40 };
}


function scoreTier(score: number): Tier {
  if (score >= 90) return 'S';
  if (score >= 80) return 'A';
  return 'B';
}

// ── 4H → Daily Aggregation ──────────────────────────────

/** Group 4H candles into daily candles by date string */
export function aggregate4HToDaily(candles4h: BacktestCandle[]): BacktestCandle[] {
  const byDate = new Map<string, BacktestCandle[]>();
  for (const c of candles4h) {
    const day = c.date.split('T')[0]; // YYYY-MM-DD from YYYY-MM-DDTHH:mm or YYYY-MM-DD
    const arr = byDate.get(day);
    if (arr) arr.push(c);
    else byDate.set(day, [c]);
  }

  const daily: BacktestCandle[] = [];
  for (const [day, bars] of byDate) {
    daily.push({
      date: day,
      timestamp: bars[0].timestamp,
      open: bars[0].open,
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    });
  }

  return daily;
}

/** Build a map: daily date → index of last 4H bar in that day */
function buildDailyTo4HMap(candles4h: BacktestCandle[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < candles4h.length; i++) {
    const day = candles4h[i].date.split('T')[0];
    map.set(day, i); // last one wins = last bar of the day
  }
  return map;
}

// ── Signal Pre-computation (Daily / v3) ─────────────────

/** ORATS IV data row (from api/backtest-iv.js) */
export interface IVDataRow {
  date: string;
  iv30d: number | null;
  iv60d: number | null;
}

export function precomputeSignalsDaily(candles: BacktestCandle[], indicatorOptions?: TechScoreOptions, ivData?: IVDataRow[]): PrecomputedSignal[] {
  const signals: PrecomputedSignal[] = [];
  const len = candles.length;
  const lookback = computeLookback(indicatorOptions);

  if (len < lookback) return signals;

  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const atrSeries = calcATR(highs, lows, closes, 14);
  const ema8Series = emaFullSeries(closes, 8);

  // Rolling HV for BSM repricing (cheap O(n), always computed)
  const hv20Series = computeRollingHV(closes, 20);
  const hv30Series = computeRollingHV(closes, 30);
  const hv60Series = computeRollingHV(closes, 60);

  // Build ORATS IV lookup by date (if provided)
  const ivLookup = new Map<string, { iv30d: number | null; iv60d: number | null }>();
  if (ivData) {
    for (const row of ivData) {
      ivLookup.set(row.date, { iv30d: row.iv30d, iv60d: row.iv60d });
    }
  }

  // Pre-compute V4 quality gate series (O(n), negligible cost)
  const adxResult = calcADX(highs, lows, closes, 14);
  const rvolResult = calcRVOL(volumes, 20);
  const squeezeSeries = detectSqueeze(closes, highs, lows);

  for (let i = lookback; i < len; i++) {
    const slice = candles.slice(0, i + 1);
    const result: TechScoreResult = calculateTechScore(slice, indicatorOptions);

    const atr = atrSeries[i];
    const ema8 = ema8Series[i];
    const close = candles[i].close;
    const d8 = ema8 > 0 ? ((close - ema8) / ema8) * 100 : 0;

    // Compute coherence: count of MB/BXS/BXL directional agreement
    const direction = result.type; // 'CALL' or 'PUT' or 'NEUTRAL'
    let coherence = 0;
    if (direction !== 'NEUTRAL' && result.components) {
      const isCall = direction === 'CALL';
      // MB component: positive score = bullish
      if ((isCall && result.components.sc_mb > 0) || (!isCall && result.components.sc_mb < 0)) coherence++;
      // BXS component: positive = bullish
      if ((isCall && result.components.sc_bxs > 0) || (!isCall && result.components.sc_bxs < 0)) coherence++;
      // BXL component: positive = bullish
      if ((isCall && result.components.sc_bxl > 0) || (!isCall && result.components.sc_bxl < 0)) coherence++;
    }

    const adxVal = adxResult.adx[i];
    const regime: 'trending' | 'ranging' | 'neutral' =
      adxVal > 25 ? 'trending' : adxVal < 20 ? 'ranging' : 'neutral';

    signals.push({
      barIndex: i,
      date: candles[i].date,
      score: result.techScore,
      type: result.type,
      setup: result.setup,
      confidence: result.confidence,
      d8,
      atr: isNaN(atr) ? 0 : atr,
      close,
      adx: adxVal,
      rvol: rvolResult.rvol[i],
      isSqueeze: squeezeSeries[i],
      coherence,
      ivEstimate: hv20Series[i],
      ivEstimate30: hv30Series[i],
      ivEstimate60: hv60Series[i],
      oratsIV30: ivLookup.get(candles[i].date)?.iv30d ?? undefined,
      oratsIV60: ivLookup.get(candles[i].date)?.iv60d ?? undefined,
      regime,
      subScores: result.components ? {
        sc_mb: result.components.sc_mb,
        sc_bxs: result.components.sc_bxs,
        sc_bxl: result.components.sc_bxl,
        sc_ema: result.components.sc_ema,
        sc_mom: result.components.sc_mom,
      } : undefined,
      dirConfidence: result.dirConfidence,
    });
  }

  return signals;
}

// ── Signal Pre-computation (4H / v4) ────────────────────

/**
 * Pre-compute signals using V4 scoring on daily candles aggregated from 4H.
 * Signals fire at end of each trading day. barIndex maps to the 4H array
 * (last 4H bar of the signal day) for TP/SL simulation on 4H bars.
 */
export function precomputeSignals4H(
  candles4h: BacktestCandle[],
  dailyCandles: BacktestCandle[],
): PrecomputedSignal[] {
  const signals: PrecomputedSignal[] = [];
  const len = dailyCandles.length;

  if (len < LOOKBACK_DAILY) return signals;

  // Map daily date → last 4H bar index (for TP/SL entry point)
  const dailyTo4H = buildDailyTo4HMap(candles4h);

  // Pre-compute daily ATR for TP/SL levels
  const highs = dailyCandles.map(c => c.high);
  const lows = dailyCandles.map(c => c.low);
  const closes = dailyCandles.map(c => c.close);
  const atrSeries = calcATR(highs, lows, closes, 14);

  for (let i = LOOKBACK_DAILY; i < len; i++) {
    const slice = dailyCandles.slice(0, i + 1);
    const weekly = aggregateToWeekly(slice);
    const result: TechScoreV4Result = calculateTechScoreV4(slice, weekly);

    const atr = atrSeries[i];
    const day = dailyCandles[i].date;
    const barIdx4H = dailyTo4H.get(day);
    if (barIdx4H === undefined) continue;

    signals.push({
      barIndex: barIdx4H, // Points into 4H array for TP/SL
      date: day,
      score: result.techScore,
      type: result.type,
      setup: result.setup,
      confidence: result.confidence,
      d8: result.debug.d1_ema8,
      atr: isNaN(atr) ? 0 : atr,
      close: result.debug.close,
      // V4-specific: store entry context for TP/SL adjustment
      entryContext: result.entryContext,
      dynamicTP: result.dynamicTPSL.tpMult,
      dynamicSL: result.dynamicTPSL.slMult,
    });
  }

  return signals;
}

// ── Unified precomputeSignals ───────────────────────────

export function precomputeSignals(
  candles: BacktestCandle[],
  timeframe: '1D' | '4H' | '130M',
  indicatorOptions?: TechScoreOptions,
  ivData?: IVDataRow[],
): { signals: PrecomputedSignal[]; simCandles: BacktestCandle[] } {
  if (timeframe === '1D') {
    return { signals: precomputeSignalsDaily(candles, indicatorOptions, ivData), simCandles: candles };
  }
  // 4H: aggregate to daily for signals, simulate on 4H bars
  // Note: V4 scoring doesn't use TechScoreOptions (it has its own internal params)
  const daily = aggregate4HToDaily(candles);
  const signals = precomputeSignals4H(candles, daily);
  return { signals, simCandles: candles };
}

// ── Core Backtest Loop ──────────────────────────────────

interface OpenTrade {
  entryDate: string;
  entryPrice: number;
  entryBar: number;
  entryTimestamp: number;
  direction: 'CALL' | 'PUT';
  setup: string;
  score: number;
  confidence: number;
  tier: Tier;
  entryQuality: EntryQuality;
  atrAtEntry: number;
  tpPrice: number;
  slPrice: number;
  // MFE/MAE tracking (in calendar days)
  mfeByWindow: Record<number, number>;
  maeByWindow: Record<number, number>;
  highSinceEntry: number;
  lowSinceEntry: number;
  // BSM repricing (populated when optionsPricing enabled)
  bsmStrike?: number;
  bsmEntryPrice?: number;
  bsmIV?: number;
  bsmEntryDTE?: number;
  bsmIsCall?: boolean;
  bsmEntryDelta?: number;
  bsmIVTheta?: number;           // HV60 for O-U theta estimation
  // Vertical spread
  bsmShortStrike?: number;
  bsmShortEntryPrice?: number;
  bsmShortEntryDelta?: number;
  // Sub-scores (for GA correlation penalty)
  subScores?: { sc_mb: number; sc_bxs: number; sc_bxl: number; sc_ema: number; sc_mom: number };
}

/** Convert bar delta to calendar days */
function barsToDays(bars: number, timeframe: '1D' | '4H' | '130M'): number {
  if (timeframe === '1D') return bars;
  if (timeframe === '130M') return Math.round(bars / 3); // 3 bars per trading day
  return Math.round(bars / 2); // 4H: ~2 bars per trading day
}

/**
 * Run the full backtest loop: signals trigger entries,
 * TP/SL checked on every bar.
 */
export function runBacktestFull(
  signals: PrecomputedSignal[],
  simCandles: BacktestCandle[],
  config: BacktestConfig,
  onProgress?: (pct: number) => void
): BacktestResult {
  const trades: BacktestTrade[] = [];
  const openTrades: OpenTrade[] = [];
  let lastEntryBar = -Infinity;
  let pendingSignal: PrecomputedSignal | null = null;
  let totalSignals = 0;
  let nextSignalIdx = 0;

  // Build bar→score map for score-based stop loss
  const scoreByBar = new Map<number, number>();
  if (config.scoreStopThreshold > 0) {
    for (const sig of signals) {
      scoreByBar.set(sig.barIndex, sig.score);
    }
  }

  // Quality gate stats
  const gates = config.qualityGates;
  const gateStats: GateStats = { adxFiltered: 0, rvolFiltered: 0, coherenceAdjusted: 0, squeezeAdjusted: 0 };

  const startMs = new Date(config.startDate).getTime();
  const endMs = new Date(config.endDate + 'T23:59:59').getTime();

  for (let barIdx = 0; barIdx < simCandles.length; barIdx++) {
    const candle = simCandles[barIdx];

    // ── 1. Process pending signal entry ──
    if (pendingSignal !== null && barIdx > pendingSignal.barIndex) {
      const ps = pendingSignal;
      pendingSignal = null;

      let entryPrice = candle.open;
      if (config.slippage?.enabled) {
        const slip = config.slippage.entryBps / 10000;
        entryPrice *= ps.type === 'CALL' ? (1 + slip) : (1 - slip);
      }
      let quality: EntryQuality;
      let eqNorm: number;
      if (ps.entryContext) {
        quality = ps.entryContext;
        const eqMap: Record<EntryQuality, number> = { OPTIMAL: 0.75, ACCEPTABLE: 0.25, MARGINAL: -0.10, CHASING: -0.40 };
        eqNorm = eqMap[quality];
      } else {
        ({ quality, eqNorm } = classifyEntryQuality(ps.d8));
      }

      let effTP = ps.dynamicTP ?? config.tpAtr;
      let effSL = ps.dynamicSL ?? config.slAtr;
      if (config.useEntryQualityAdjust && !ps.dynamicTP) {
        effTP = config.tpAtr * (1 + eqNorm * 0.25);
        effSL = config.slAtr * (1 - eqNorm * 0.30);
      }

      let tpPrice: number, slPrice: number;
      if (ps.type === 'CALL') {
        tpPrice = entryPrice + ps.atr * effTP;
        slPrice = entryPrice - ps.atr * effSL;
      } else {
        tpPrice = entryPrice - ps.atr * effTP;
        slPrice = entryPrice + ps.atr * effSL;
      }

      openTrades.push({
        entryDate: candle.date,
        entryPrice,
        entryBar: barIdx,
        entryTimestamp: candle.timestamp,
        direction: ps.type as 'CALL' | 'PUT',
        setup: ps.setup,
        score: ps.score,
        confidence: ps.confidence,
        tier: scoreTier(ps.score),
        entryQuality: quality,
        atrAtEntry: ps.atr,
        tpPrice,
        slPrice,
        mfeByWindow: {},
        maeByWindow: {},
        highSinceEntry: candle.high,
        lowSinceEntry: candle.low,
        subScores: ps.subScores,
      });

      // BSM entry pricing (when options repricing enabled)
      if (config.optionsPricing?.enabled) {
        const opc = config.optionsPricing;
        const iv = opc.ivSource === 'fixed'
          ? (opc.fixedIV ?? 0.25)
          : opc.ivSource === 'orats'
            ? (ps.oratsIV30 ?? ps.ivEstimate ?? NaN)
            : opc.ivSource === 'hv30'
              ? (ps.ivEstimate30 ?? ps.ivEstimate ?? NaN)
              : (ps.ivEstimate ?? NaN);

        if (!isNaN(iv) && iv > 0.01 && iv < 5.0) {
          const isCall = ps.type === 'CALL';
          const K = entryPrice; // ATM (Phase 1)
          const T = opc.entryDTE / 365;
          const r = opc.riskFreeRate;

          const optPrice = bsmPrice(entryPrice, K, T, iv, r, isCall);
          const delta = bsmDelta(entryPrice, K, T, iv, r, isCall);

          if (optPrice > 0) {
            const ot = openTrades[openTrades.length - 1];
            ot.bsmStrike = K;
            ot.bsmIV = iv;
            ot.bsmEntryDTE = opc.entryDTE;
            ot.bsmIsCall = isCall;
            ot.bsmEntryDelta = delta;
            ot.bsmIVTheta = opc.ivSource === 'orats'
              ? (ps.oratsIV60 ?? ps.ivEstimate60)
              : ps.ivEstimate60;

            // Vertical spread: buy ATM + sell OTM
            if (opc.spreadType === 'vertical') {
              const width = opc.spreadWidthMode === 'atr'
                ? (opc.spreadWidthATR ?? 1.0) * ps.atr
                : (opc.spreadWidthFixed ?? 1);
              const shortK = isCall ? K + width : K - width;
              const shortPrice = bsmPrice(entryPrice, shortK, T, iv, r, isCall);
              ot.bsmShortStrike = shortK;
              ot.bsmShortEntryPrice = shortPrice;
              ot.bsmShortEntryDelta = bsmDelta(entryPrice, shortK, T, iv, r, isCall);
              ot.bsmEntryPrice = Math.max(0.01, optPrice - shortPrice); // net debit
            } else {
              ot.bsmEntryPrice = optPrice;
            }
          }
        }
      }

      lastEntryBar = barIdx;
    }

    // ── 2. Check exits ──
    for (let ti = openTrades.length - 1; ti >= 0; ti--) {
      const ot = openTrades[ti];
      const holdBars = barIdx - ot.entryBar;
      const holdDays = barsToDays(holdBars, config.timeframe);

      ot.highSinceEntry = Math.max(ot.highSinceEntry, candle.high);
      ot.lowSinceEntry = Math.min(ot.lowSinceEntry, candle.low);

      for (const w of config.mfeWindows) {
        if (holdDays === w && !(w in ot.mfeByWindow)) {
          if (ot.direction === 'CALL') {
            ot.mfeByWindow[w] = (ot.highSinceEntry - ot.entryPrice) / ot.entryPrice;
            ot.maeByWindow[w] = (ot.lowSinceEntry - ot.entryPrice) / ot.entryPrice;
          } else {
            ot.mfeByWindow[w] = (ot.entryPrice - ot.lowSinceEntry) / ot.entryPrice;
            ot.maeByWindow[w] = (ot.entryPrice - ot.highSinceEntry) / ot.entryPrice;
          }
        }
      }

      let exitPrice: number | null = null;
      let exitType: ExitType | null = null;

      // Option Mode: premium-based TP/SL (skip ATR exits)
      // Stock Mode: ATR-based TP/SL
      const usesPremiumExits = ot.bsmEntryPrice != null && ot.bsmEntryPrice > 0 && config.optionsPricing?.premiumTP != null;

      if (usesPremiumExits) {
        const opc = config.optionsPricing!;
        const T_now = Math.max(1 / 365, (ot.bsmEntryDTE! - holdDays) / 365);

        let sigma_now = ot.bsmIV!;
        const ivDyn = opc.ivDynamics;
        if (ivDyn?.enabled) {
          const theta = ivDyn.useHV60ForTheta && ot.bsmIVTheta != null && ot.bsmIVTheta > 0.01
            ? ot.bsmIVTheta : ot.bsmIV!;
          sigma_now = ouIVEvolution(ot.bsmIV!, theta, ivDyn.kappa, holdDays);
          sigma_now = Math.max(0.05, Math.min(3.0, sigma_now));
        }

        const currOptPrice = bsmPrice(candle.close, ot.bsmStrike!, T_now, sigma_now, opc.riskFreeRate, ot.bsmIsCall!);
        const premiumReturn = (currOptPrice - ot.bsmEntryPrice!) / ot.bsmEntryPrice!;

        if (premiumReturn >= (opc.premiumTP ?? 0.50)) {
          exitPrice = candle.close; exitType = 'TP';
        } else if (premiumReturn <= -(opc.premiumSL ?? 0.50)) {
          exitPrice = candle.close; exitType = 'SL';
        }
      } else {
        // Stock Mode: ATR price-level exits
        if (ot.direction === 'CALL') {
          if (candle.open <= ot.slPrice) { exitPrice = candle.open; exitType = 'SL'; }
          else if (candle.low <= ot.slPrice && candle.high >= ot.tpPrice) { exitPrice = ot.slPrice; exitType = 'SL'; }
          else if (candle.high >= ot.tpPrice) { exitPrice = ot.tpPrice; exitType = 'TP'; }
          else if (candle.low <= ot.slPrice) { exitPrice = ot.slPrice; exitType = 'SL'; }
        } else {
          if (candle.open >= ot.slPrice) { exitPrice = candle.open; exitType = 'SL'; }
          else if (candle.high >= ot.slPrice && candle.low <= ot.tpPrice) { exitPrice = ot.slPrice; exitType = 'SL'; }
          else if (candle.low <= ot.tpPrice) { exitPrice = ot.tpPrice; exitType = 'TP'; }
          else if (candle.high >= ot.slPrice) { exitPrice = ot.slPrice; exitType = 'SL'; }
        }
      }

      // Score-based stop loss: exit if current bar's composite score drops below threshold
      if (exitPrice === null && config.scoreStopThreshold > 0) {
        const currentScore = scoreByBar.get(barIdx);
        if (currentScore !== undefined && currentScore < config.scoreStopThreshold) {
          exitPrice = candle.close; exitType = 'SCORE_STOP';
        }
      }

      if (exitPrice === null && holdBars >= config.timeStopBars) {
        exitPrice = candle.close; exitType = 'TIME_STOP';
      }

      if (exitPrice !== null && exitType !== null) {
        // Apply exit slippage (adverse fill)
        if (config.slippage?.enabled) {
          const slip = config.slippage.exitBps / 10000;
          exitPrice *= ot.direction === 'CALL' ? (1 - slip) : (1 + slip);
        }

        const rawReturn = ot.direction === 'CALL'
          ? (exitPrice - ot.entryPrice) / ot.entryPrice
          : (ot.entryPrice - exitPrice) / ot.entryPrice;
        const thetaAdjReturn = rawReturn * Math.exp(-config.thetaDecayRate * holdDays);

        for (const w of config.mfeWindows) {
          if (!(w in ot.mfeByWindow)) {
            if (ot.direction === 'CALL') {
              ot.mfeByWindow[w] = (ot.highSinceEntry - ot.entryPrice) / ot.entryPrice;
              ot.maeByWindow[w] = (ot.lowSinceEntry - ot.entryPrice) / ot.entryPrice;
            } else {
              ot.mfeByWindow[w] = (ot.entryPrice - ot.lowSinceEntry) / ot.entryPrice;
              ot.maeByWindow[w] = (ot.entryPrice - ot.highSinceEntry) / ot.entryPrice;
            }
          }
        }

        // BSM exit repricing
        let optionReturn: number | undefined;
        let optionPriceExit: number | undefined;
        let exitDelta: number | undefined;
        let shortOptExitPrice: number | undefined;

        let ivUsedAtExit: number | undefined;
        if (ot.bsmEntryPrice != null && ot.bsmEntryPrice > 0) {
          const opc = config.optionsPricing!;
          const T_exit = Math.max(1 / 365, (ot.bsmEntryDTE! - holdDays) / 365);

          // IV evolution: O-U mean reversion or constant
          let sigma_exit = ot.bsmIV!;
          const ivDyn = opc.ivDynamics;
          if (ivDyn?.enabled) {
            const theta = ivDyn.useHV60ForTheta && ot.bsmIVTheta != null && ot.bsmIVTheta > 0.01
              ? ot.bsmIVTheta : ot.bsmIV!;
            sigma_exit = ouIVEvolution(ot.bsmIV!, theta, ivDyn.kappa, holdDays);
            sigma_exit = Math.max(0.05, Math.min(3.0, sigma_exit));
          }
          ivUsedAtExit = sigma_exit;

          const longExitPrice = bsmPrice(exitPrice, ot.bsmStrike!, T_exit, sigma_exit, opc.riskFreeRate, ot.bsmIsCall!);
          exitDelta = bsmDelta(exitPrice, ot.bsmStrike!, T_exit, sigma_exit, opc.riskFreeRate, ot.bsmIsCall!);

          if (ot.bsmShortStrike != null) {
            // Vertical spread: reprice both legs
            shortOptExitPrice = bsmPrice(exitPrice, ot.bsmShortStrike, T_exit, sigma_exit, opc.riskFreeRate, ot.bsmIsCall!);
            optionPriceExit = Math.max(0, longExitPrice - shortOptExitPrice);
            const sw = Math.abs(ot.bsmShortStrike - ot.bsmStrike!);
            const maxLossRatio = Math.min(sw / ot.bsmEntryPrice, (sw - ot.bsmEntryPrice) / ot.bsmEntryPrice);
            optionReturn = Math.max(-maxLossRatio, (optionPriceExit - ot.bsmEntryPrice) / ot.bsmEntryPrice);
          } else {
            optionPriceExit = longExitPrice;
            optionReturn = Math.max(-1.0, (optionPriceExit - ot.bsmEntryPrice) / ot.bsmEntryPrice);
          }
        }

        // Spread fields for trade record
        const spreadWidth = ot.bsmShortStrike != null ? Math.abs(ot.bsmShortStrike - ot.bsmStrike!) : undefined;
        const maxSpreadLoss = spreadWidth != null && ot.bsmEntryPrice != null
          ? spreadWidth - ot.bsmEntryPrice : undefined;

        trades.push({
          entryDate: ot.entryDate, entryPrice: ot.entryPrice, entryBar: ot.entryBar,
          direction: ot.direction, setup: ot.setup, score: ot.score,
          confidence: ot.confidence, tier: ot.tier, entryQuality: ot.entryQuality,
          atrAtEntry: ot.atrAtEntry, tpPrice: ot.tpPrice, slPrice: ot.slPrice,
          exitDate: candle.date, exitPrice, exitType, holdDays,
          rawReturn, thetaAdjReturn,
          mfe: { ...ot.mfeByWindow }, mae: { ...ot.maeByWindow },
          optionReturn,
          optionPriceEntry: ot.bsmEntryPrice,
          optionPriceExit,
          strikeUsed: ot.bsmStrike,
          ivAtEntry: ot.bsmIV,
          ivAtExit: ivUsedAtExit,
          entryDelta: ot.bsmEntryDelta,
          exitDelta,
          subScores: ot.subScores,
          shortStrikeUsed: ot.bsmShortStrike,
          shortOptionPriceEntry: ot.bsmShortEntryPrice,
          shortOptionPriceExit: shortOptExitPrice,
          spreadWidth,
          maxSpreadLoss,
        });
        openTrades.splice(ti, 1);
      }
    }

    // ── 3. Check for new signal at this bar ──
    while (nextSignalIdx < signals.length && signals[nextSignalIdx].barIndex <= barIdx) {
      const sig = signals[nextSignalIdx];
      nextSignalIdx++;

      if (sig.barIndex !== barIdx) continue;

      const sigDate = new Date(sig.date).getTime();
      if (sigDate < startMs || sigDate > endMs) continue;
      if (sig.type === 'NEUTRAL') continue;
      if (sig.score < config.minScore) continue;
      if (config.directionFilter !== 'ALL' && sig.type !== config.directionFilter) continue;
      if (!config.allowedSetups.includes('All') && !config.allowedSetups.includes(sig.setup)) continue;

      // ── Quality gates (hard filters, optionally regime-adaptive) ──
      const rg = config.regimeGates;
      let effectiveMinADX = gates?.minADX ?? 15;
      let effectiveMinRVOL = gates?.minRVOL ?? 0.5;
      let cohMultipliers = [1.10, 1.00, 0.85, 0.70]; // default [3/3, 2/3, 1/3, 0/3]

      if (rg?.enabled && sig.regime) {
        if (sig.regime === 'trending') {
          effectiveMinADX = rg.trendingADX;
          effectiveMinRVOL = rg.trendingRVOL;
          cohMultipliers = [...rg.trendingCoherence];
        } else if (sig.regime === 'ranging') {
          effectiveMinADX = rg.rangingADX;
          effectiveMinRVOL = rg.rangingRVOL;
          cohMultipliers = [...rg.rangingCoherence];
        }
      }

      if (gates && sig.adx !== undefined && !isNaN(sig.adx) && sig.adx < effectiveMinADX) {
        gateStats.adxFiltered++;
        continue;
      }
      if (gates && sig.rvol !== undefined && !isNaN(sig.rvol) && sig.rvol < effectiveMinRVOL) {
        gateStats.rvolFiltered++;
        continue;
      }

      // ── Quality gates (score adjustments) ──
      let effectiveScore = sig.score;
      if (gates && gates.useCoherence && sig.coherence !== undefined) {
        const cohMult = cohMultipliers[3 - sig.coherence] ?? 1.00;
        if (cohMult !== 1.00) {
          effectiveScore *= cohMult;
          gateStats.coherenceAdjusted++;
        }
      }
      if (gates && gates.useSqueeze && sig.isSqueeze) {
        effectiveScore *= 1.05;
        gateStats.squeezeAdjusted++;
      }

      // Re-check after adjustments
      if (effectiveScore < config.minScore) continue;

      totalSignals++;

      if (barIdx - lastEntryBar < config.cooldownBars) continue;

      pendingSignal = sig;
    }

    if (onProgress && barIdx % 200 === 0) {
      onProgress(Math.round((barIdx / simCandles.length) * 100));
    }
  }

  // Force-close remaining
  if (simCandles.length > 0 && openTrades.length > 0) {
    const lastCandle = simCandles[simCandles.length - 1];
    for (const ot of openTrades) {
      const holdBars = (simCandles.length - 1) - ot.entryBar;
      const holdDays = barsToDays(holdBars, config.timeframe);
      let forceExitPrice = lastCandle.close;
      if (config.slippage?.enabled) {
        const slip = config.slippage.exitBps / 10000;
        forceExitPrice *= ot.direction === 'CALL' ? (1 - slip) : (1 + slip);
      }
      const rawReturn = ot.direction === 'CALL'
        ? (forceExitPrice - ot.entryPrice) / ot.entryPrice
        : (ot.entryPrice - forceExitPrice) / ot.entryPrice;
      const thetaAdjReturn = rawReturn * Math.exp(-config.thetaDecayRate * holdDays);

      for (const w of config.mfeWindows) {
        if (!(w in ot.mfeByWindow)) {
          if (ot.direction === 'CALL') {
            ot.mfeByWindow[w] = (ot.highSinceEntry - ot.entryPrice) / ot.entryPrice;
            ot.maeByWindow[w] = (ot.lowSinceEntry - ot.entryPrice) / ot.entryPrice;
          } else {
            ot.mfeByWindow[w] = (ot.entryPrice - ot.lowSinceEntry) / ot.entryPrice;
            ot.maeByWindow[w] = (ot.entryPrice - ot.highSinceEntry) / ot.entryPrice;
          }
        }
      }

      // BSM exit repricing (force-close)
      let optionReturn: number | undefined;
      let optionPriceExit: number | undefined;
      let exitDelta: number | undefined;
      let shortOptExitPrice: number | undefined;

      let ivUsedAtExit: number | undefined;
      if (ot.bsmEntryPrice != null && ot.bsmEntryPrice > 0) {
        const opc = config.optionsPricing!;
        const T_exit = Math.max(1 / 365, (ot.bsmEntryDTE! - holdDays) / 365);

        let sigma_exit = ot.bsmIV!;
        const ivDyn = opc.ivDynamics;
        if (ivDyn?.enabled) {
          const theta = ivDyn.useHV60ForTheta && ot.bsmIVTheta != null && ot.bsmIVTheta > 0.01
            ? ot.bsmIVTheta : ot.bsmIV!;
          sigma_exit = ouIVEvolution(ot.bsmIV!, theta, ivDyn.kappa, holdDays);
          sigma_exit = Math.max(0.05, Math.min(3.0, sigma_exit));
        }
        ivUsedAtExit = sigma_exit;

        const longExitPrice = bsmPrice(forceExitPrice, ot.bsmStrike!, T_exit, sigma_exit, opc.riskFreeRate, ot.bsmIsCall!);
        exitDelta = bsmDelta(forceExitPrice, ot.bsmStrike!, T_exit, sigma_exit, opc.riskFreeRate, ot.bsmIsCall!);

        if (ot.bsmShortStrike != null) {
          shortOptExitPrice = bsmPrice(forceExitPrice, ot.bsmShortStrike, T_exit, sigma_exit, opc.riskFreeRate, ot.bsmIsCall!);
          optionPriceExit = Math.max(0, longExitPrice - shortOptExitPrice);
          const sw = Math.abs(ot.bsmShortStrike - ot.bsmStrike!);
          const maxLossRatio = Math.min(sw / ot.bsmEntryPrice, (sw - ot.bsmEntryPrice) / ot.bsmEntryPrice);
          optionReturn = Math.max(-maxLossRatio, (optionPriceExit - ot.bsmEntryPrice) / ot.bsmEntryPrice);
        } else {
          optionPriceExit = longExitPrice;
          optionReturn = Math.max(-1.0, (optionPriceExit - ot.bsmEntryPrice) / ot.bsmEntryPrice);
        }
      }

      // Spread fields for trade record
      const spreadWidth = ot.bsmShortStrike != null ? Math.abs(ot.bsmShortStrike - ot.bsmStrike!) : undefined;
      const maxSpreadLoss = spreadWidth != null && ot.bsmEntryPrice != null
        ? spreadWidth - ot.bsmEntryPrice : undefined;

      trades.push({
        entryDate: ot.entryDate, entryPrice: ot.entryPrice, entryBar: ot.entryBar,
        direction: ot.direction, setup: ot.setup, score: ot.score,
        confidence: ot.confidence, tier: ot.tier, entryQuality: ot.entryQuality,
        atrAtEntry: ot.atrAtEntry, tpPrice: ot.tpPrice, slPrice: ot.slPrice,
        exitDate: lastCandle.date, exitPrice: forceExitPrice, exitType: 'TIME_STOP',
        holdDays, rawReturn, thetaAdjReturn,
        mfe: { ...ot.mfeByWindow }, mae: { ...ot.maeByWindow },
        optionReturn,
        optionPriceEntry: ot.bsmEntryPrice,
        optionPriceExit,
        strikeUsed: ot.bsmStrike,
        ivAtEntry: ot.bsmIV,
        ivAtExit: ivUsedAtExit,
        entryDelta: ot.bsmEntryDelta,
        exitDelta,
        subScores: ot.subScores,
        shortStrikeUsed: ot.bsmShortStrike,
        shortOptionPriceEntry: ot.bsmShortEntryPrice,
        shortOptionPriceExit: shortOptExitPrice,
        spreadWidth,
        maxSpreadLoss,
      });
    }
  }

  const analytics = computeAnalytics(trades, config, totalSignals, gateStats);
  return { config, trades, analytics };
}

/**
 * Full backtest: pre-compute signals + run simulation.
 */
export function runBacktest(
  candles: BacktestCandle[],
  config: BacktestConfig,
  onProgress?: (pct: number) => void,
  ivData?: IVDataRow[],
): BacktestResult {
  const { signals, simCandles } = precomputeSignals(candles, config.timeframe, config.indicatorOptions, ivData);
  return runBacktestFull(signals, simCandles, config, onProgress);
}
