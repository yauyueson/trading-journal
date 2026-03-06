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

function entryQualityToNorm(eq: EntryQuality): number {
  switch (eq) {
    case 'OPTIMAL': return 0.75;
    case 'ACCEPTABLE': return 0.25;
    case 'MARGINAL': return -0.10;
    case 'CHASING': return -0.40;
  }
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

export function precomputeSignalsDaily(candles: BacktestCandle[], indicatorOptions?: TechScoreOptions): PrecomputedSignal[] {
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
      adx: adxResult.adx[i],
      rvol: rvolResult.rvol[i],
      isSqueeze: squeezeSeries[i],
      coherence,
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
  timeframe: '1D' | '4H',
  indicatorOptions?: TechScoreOptions,
): { signals: PrecomputedSignal[]; simCandles: BacktestCandle[] } {
  if (timeframe === '1D') {
    return { signals: precomputeSignalsDaily(candles, indicatorOptions), simCandles: candles };
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
}

/** Convert bar delta to calendar days */
function barsToDays(bars: number, timeframe: '1D' | '4H'): number {
  if (timeframe === '1D') return bars;
  // 4H: ~2 bars per trading day (6.5 market hours, using 4H bars)
  return Math.round(bars / 2);
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

      const entryPrice = candle.open;
      let quality: EntryQuality;
      let eqNorm: number;
      if (ps.entryContext) {
        quality = ps.entryContext;
        eqNorm = entryQualityToNorm(quality);
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
      });
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

      if (exitPrice === null && holdBars >= config.timeStopBars) {
        exitPrice = candle.close; exitType = 'TIME_STOP';
      }

      if (exitPrice !== null && exitType !== null) {
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

        trades.push({
          entryDate: ot.entryDate, entryPrice: ot.entryPrice, entryBar: ot.entryBar,
          direction: ot.direction, setup: ot.setup, score: ot.score,
          confidence: ot.confidence, tier: ot.tier, entryQuality: ot.entryQuality,
          atrAtEntry: ot.atrAtEntry, tpPrice: ot.tpPrice, slPrice: ot.slPrice,
          exitDate: candle.date, exitPrice, exitType, holdDays,
          rawReturn, thetaAdjReturn,
          mfe: { ...ot.mfeByWindow }, mae: { ...ot.maeByWindow },
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

      // ── Quality gates (hard filters) ──
      if (gates && sig.adx !== undefined && !isNaN(sig.adx) && sig.adx < gates.minADX) {
        gateStats.adxFiltered++;
        continue;
      }
      if (gates && sig.rvol !== undefined && !isNaN(sig.rvol) && sig.rvol < gates.minRVOL) {
        gateStats.rvolFiltered++;
        continue;
      }

      // ── Quality gates (score adjustments) ──
      let effectiveScore = sig.score;
      if (gates && gates.useCoherence && sig.coherence !== undefined) {
        const cohMult = sig.coherence === 3 ? 1.10 : sig.coherence === 2 ? 1.00 : sig.coherence === 1 ? 0.85 : 0.70;
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
      const rawReturn = ot.direction === 'CALL'
        ? (lastCandle.close - ot.entryPrice) / ot.entryPrice
        : (ot.entryPrice - lastCandle.close) / ot.entryPrice;
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

      trades.push({
        entryDate: ot.entryDate, entryPrice: ot.entryPrice, entryBar: ot.entryBar,
        direction: ot.direction, setup: ot.setup, score: ot.score,
        confidence: ot.confidence, tier: ot.tier, entryQuality: ot.entryQuality,
        atrAtEntry: ot.atrAtEntry, tpPrice: ot.tpPrice, slPrice: ot.slPrice,
        exitDate: lastCandle.date, exitPrice: lastCandle.close, exitType: 'TIME_STOP',
        holdDays, rawReturn, thetaAdjReturn,
        mfe: { ...ot.mfeByWindow }, mae: { ...ot.maeByWindow },
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
  onProgress?: (pct: number) => void
): BacktestResult {
  const { signals, simCandles } = precomputeSignals(candles, config.timeframe, config.indicatorOptions);
  return runBacktestFull(signals, simCandles, config, onProgress);
}
