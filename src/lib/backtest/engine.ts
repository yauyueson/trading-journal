/**
 * Signal Quality Backtester — Core Engine
 *
 * Walk-forward simulator that:
 * 1. Pre-computes tech analysis signals (expensive, done once)
 * 2. Runs cheap TP/SL simulation loops for each config
 * 3. Supports MFE/MAE tracking at multiple time windows
 *
 * Mirrors Pine Script v3.2 entry/exit logic (lines 1284-1920).
 */

import { calculateTechScore, type TechScoreResult } from '../tech-analysis';
import { calcATR, emaFullSeries } from '../indicators';
import type {
  BacktestCandle,
  BacktestConfig,
  BacktestTrade,
  BacktestResult,
  PrecomputedSignal,
  EntryQuality,
  Tier,
  ExitType,
} from './types';
import { computeAnalytics } from './analytics';

// ── Constants ───────────────────────────────────────────

/** Tech analysis needs ~300 bars of history for stable indicators */
const LOOKBACK = 320;

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

// ── Signal Pre-computation ──────────────────────────────

/**
 * Run calculateTechScore() on every bar from LOOKBACK onward.
 * This is the expensive part — O(n × indicator_cost). Do it ONCE.
 */
export function precomputeSignals(candles: BacktestCandle[]): PrecomputedSignal[] {
  const signals: PrecomputedSignal[] = [];
  const len = candles.length;

  if (len < LOOKBACK) return signals;

  // Pre-compute ATR(14) and EMA(8) for entry quality classification
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const atrSeries = calcATR(highs, lows, closes, 14);
  const ema8Series = emaFullSeries(closes, 8);

  for (let i = LOOKBACK; i < len; i++) {
    // Feed tech-analysis the full history up to bar i
    const slice = candles.slice(0, i + 1);
    const result: TechScoreResult = calculateTechScore(slice);

    const atr = atrSeries[i];
    const ema8 = ema8Series[i];
    const close = candles[i].close;
    const d8 = ema8 > 0 ? ((close - ema8) / ema8) * 100 : 0;

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
    });
  }

  return signals;
}

// ── Core Backtest Loop ──────────────────────────────────

interface OpenTrade {
  entryDate: string;
  entryPrice: number;
  entryBar: number;
  direction: 'CALL' | 'PUT';
  setup: string;
  score: number;
  confidence: number;
  tier: Tier;
  entryQuality: EntryQuality;
  atrAtEntry: number;
  tpPrice: number;
  slPrice: number;
  // MFE/MAE tracking
  mfeByWindow: Record<number, number>;
  maeByWindow: Record<number, number>;
  highSinceEntry: number;
  lowSinceEntry: number;
}

/**
 * Run backtest from pre-computed signals (cheap — just TP/SL simulation).
 * Each call is O(signals × openTrades), typically <1ms for 500 bars.
 */
export function runBacktestFromSignals(
  signals: PrecomputedSignal[],
  candles: BacktestCandle[],
  config: BacktestConfig,
  onProgress?: (pct: number) => void
): BacktestResult {
  const trades: BacktestTrade[] = [];
  const openTrades: OpenTrade[] = [];
  let lastEntryBar = -Infinity;
  let pendingSignal: PrecomputedSignal | null = null;
  let prevSignalKey = '';
  let totalSignals = 0;

  // Filter signals by date range
  const startMs = new Date(config.startDate).getTime();
  const endMs = new Date(config.endDate).getTime();

  for (let si = 0; si < signals.length; si++) {
    const sig = signals[si];
    const barDate = new Date(sig.date).getTime();

    if (barDate < startMs || barDate > endMs) continue;

    const barIdx = sig.barIndex;
    const candle = candles[barIdx];

    // ── 1. Process pending signal entry (enter on this bar's OPEN) ──
    if (pendingSignal !== null) {
      const ps = pendingSignal;
      pendingSignal = null;

      const entryPrice = candle.open;
      const { quality, eqNorm } = classifyEntryQuality(ps.d8);

      // Apply entry quality adjustment to TP/SL ATR multiples
      let effTP = config.tpAtr;
      let effSL = config.slAtr;
      if (config.useEntryQualityAdjust) {
        effTP = config.tpAtr * (1 + eqNorm * 0.25);
        effSL = config.slAtr * (1 - eqNorm * 0.30);
      }

      // Set TP/SL prices
      let tpPrice: number, slPrice: number;
      if (ps.type === 'CALL') {
        tpPrice = entryPrice + ps.atr * effTP;
        slPrice = entryPrice - ps.atr * effSL;
      } else {
        tpPrice = entryPrice - ps.atr * effTP;
        slPrice = entryPrice + ps.atr * effSL;
      }

      const trade: OpenTrade = {
        entryDate: candle.date,
        entryPrice,
        entryBar: barIdx,
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
      };

      openTrades.push(trade);
      lastEntryBar = barIdx;
    }

    // ── 2. Check exits for open trades ──
    for (let ti = openTrades.length - 1; ti >= 0; ti--) {
      const ot = openTrades[ti];
      const holdBars = barIdx - ot.entryBar;

      // Update high/low since entry
      ot.highSinceEntry = Math.max(ot.highSinceEntry, candle.high);
      ot.lowSinceEntry = Math.min(ot.lowSinceEntry, candle.low);

      // Update MFE/MAE at window milestones
      for (const w of config.mfeWindows) {
        if (holdBars === w) {
          if (ot.direction === 'CALL') {
            ot.mfeByWindow[w] = (ot.highSinceEntry - ot.entryPrice) / ot.entryPrice;
            ot.maeByWindow[w] = (ot.lowSinceEntry - ot.entryPrice) / ot.entryPrice;
          } else {
            ot.mfeByWindow[w] = (ot.entryPrice - ot.lowSinceEntry) / ot.entryPrice;
            ot.maeByWindow[w] = (ot.entryPrice - ot.highSinceEntry) / ot.entryPrice;
          }
        }
      }

      // Check exit conditions
      let exitPrice: number | null = null;
      let exitType: ExitType | null = null;

      if (ot.direction === 'CALL') {
        // Gap slippage: open gaps past SL
        if (candle.open <= ot.slPrice) {
          exitPrice = candle.open;
          exitType = 'SL';
        }
        // Both TP and SL hit same bar → conservative SL
        else if (candle.low <= ot.slPrice && candle.high >= ot.tpPrice) {
          exitPrice = ot.slPrice;
          exitType = 'SL';
        }
        // TP hit
        else if (candle.high >= ot.tpPrice) {
          exitPrice = ot.tpPrice;
          exitType = 'TP';
        }
        // SL hit
        else if (candle.low <= ot.slPrice) {
          exitPrice = ot.slPrice;
          exitType = 'SL';
        }
      } else {
        // PUT direction
        // Gap slippage: open gaps past SL
        if (candle.open >= ot.slPrice) {
          exitPrice = candle.open;
          exitType = 'SL';
        }
        // Both hit same bar → conservative SL
        else if (candle.high >= ot.slPrice && candle.low <= ot.tpPrice) {
          exitPrice = ot.slPrice;
          exitType = 'SL';
        }
        // TP hit
        else if (candle.low <= ot.tpPrice) {
          exitPrice = ot.tpPrice;
          exitType = 'TP';
        }
        // SL hit
        else if (candle.high >= ot.slPrice) {
          exitPrice = ot.slPrice;
          exitType = 'SL';
        }
      }

      // Time stop
      if (exitPrice === null && holdBars >= config.timeStopBars) {
        exitPrice = candle.close;
        exitType = 'TIME_STOP';
      }

      // Close the trade
      if (exitPrice !== null && exitType !== null) {
        const rawReturn = ot.direction === 'CALL'
          ? (exitPrice - ot.entryPrice) / ot.entryPrice
          : (ot.entryPrice - exitPrice) / ot.entryPrice;

        const holdDays = holdBars; // 1 bar = 1 trading day
        const thetaAdjReturn = rawReturn * Math.exp(-config.thetaDecayRate * holdDays);

        // Fill any remaining MFE/MAE windows that weren't reached
        for (const w of config.mfeWindows) {
          if (!(w in ot.mfeByWindow)) {
            // Trade closed before this window — use actual values at close
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
          entryDate: ot.entryDate,
          entryPrice: ot.entryPrice,
          entryBar: ot.entryBar,
          direction: ot.direction,
          setup: ot.setup,
          score: ot.score,
          confidence: ot.confidence,
          tier: ot.tier,
          entryQuality: ot.entryQuality,
          atrAtEntry: ot.atrAtEntry,
          tpPrice: ot.tpPrice,
          slPrice: ot.slPrice,
          exitDate: candle.date,
          exitPrice,
          exitType,
          holdDays,
          rawReturn,
          thetaAdjReturn,
          mfe: { ...ot.mfeByWindow },
          mae: { ...ot.maeByWindow },
        });

        openTrades.splice(ti, 1);
      }
    }

    // ── 3. Check for new signal ──
    if (sig.type === 'NEUTRAL') continue;
    if (sig.score < config.minScore) continue;
    if (sig.confidence < config.minConfidence) continue;
    if (config.directionFilter !== 'ALL' && sig.type !== config.directionFilter) continue;
    if (!config.allowedSetups.includes('All') && !config.allowedSetups.includes(sig.setup)) continue;

    // Skip EXTENDED pullback (CHASING with very high distance)
    if (Math.abs(sig.d8) > 3.0) continue;

    totalSignals++;

    // Cooldown check
    if (barIdx - lastEntryBar < config.cooldownBars) continue;

    // Signal must be new or cooldown expired
    const signalKey = `${sig.type}:${sig.setup}`;
    if (signalKey === prevSignalKey && barIdx - lastEntryBar < config.cooldownBars) continue;
    prevSignalKey = signalKey;

    // Only one open trade at a time
    if (openTrades.length > 0) continue;

    // Queue entry for next bar
    pendingSignal = sig;

    if (onProgress) {
      onProgress(Math.round((si / signals.length) * 100));
    }
  }

  // Force-close any remaining open trades at last candle
  const lastCandle = candles[candles.length - 1];
  for (const ot of openTrades) {
    const holdBars = (candles.length - 1) - ot.entryBar;
    const rawReturn = ot.direction === 'CALL'
      ? (lastCandle.close - ot.entryPrice) / ot.entryPrice
      : (ot.entryPrice - lastCandle.close) / ot.entryPrice;
    const thetaAdjReturn = rawReturn * Math.exp(-config.thetaDecayRate * holdBars);

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
      entryDate: ot.entryDate,
      entryPrice: ot.entryPrice,
      entryBar: ot.entryBar,
      direction: ot.direction,
      setup: ot.setup,
      score: ot.score,
      confidence: ot.confidence,
      tier: ot.tier,
      entryQuality: ot.entryQuality,
      atrAtEntry: ot.atrAtEntry,
      tpPrice: ot.tpPrice,
      slPrice: ot.slPrice,
      exitDate: lastCandle.date,
      exitPrice: lastCandle.close,
      exitType: 'TIME_STOP',
      holdDays: holdBars,
      rawReturn,
      thetaAdjReturn,
      mfe: { ...ot.mfeByWindow },
      mae: { ...ot.maeByWindow },
    });
  }

  const analytics = computeAnalytics(trades, config, totalSignals);

  return { config, trades, analytics };
}

/**
 * Full backtest: pre-compute signals + run simulation.
 * Use this for single runs. For sweeps, call precomputeSignals() once
 * then runBacktestFromSignals() for each config.
 */
export function runBacktest(
  candles: BacktestCandle[],
  config: BacktestConfig,
  onProgress?: (pct: number) => void
): BacktestResult {
  const signals = precomputeSignals(candles);
  return runBacktestFromSignals(signals, candles, config, onProgress);
}
