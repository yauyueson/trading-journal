/**
 * Walk-Forward Analysis Engine for Options
 *
 * Rolling/anchored WFA with:
 * - Real bid/ask fills (via slippage module)
 * - Position carry across OOS boundaries
 * - Purge gap to prevent look-ahead bias
 */

import type { WalkForwardMode, CorrelationStressResult } from './types';
import type { OptionTrade, SimConfig, EntrySignal, SignalPresetKey } from './option-sim';
import { computeOptionAnalytics } from './option-sim';
import { computeCorrelationStress } from './portfolio-stress';

// ── Window Building ─────────────────────────────────────

export interface WindowDef {
  trainStart: string;
  trainEnd: string;
  oosStart: string;
  oosEnd: string;
}

export interface BuildWindowsParams {
  trainWindowDays: number;
  forwardStepDays: number;
  purgeGapDays: number;
  mode: WalkForwardMode;
  startDate: string;
  endDate: string;
}

/**
 * Build WFA window boundaries from a sorted array of trading dates.
 *
 * Rolling: fixed-width train window slides forward by forwardStepDays.
 * Anchored: train window starts at startDate and expands each step.
 */
export function buildWFAWindows(
  allDates: string[],
  params: BuildWindowsParams,
): WindowDef[] {
  const { trainWindowDays, forwardStepDays, purgeGapDays, mode, startDate, endDate } = params;

  // Filter to date range
  const dates = allDates.filter(d => d >= startDate && d <= endDate);
  if (dates.length === 0) return [];

  const windows: WindowDef[] = [];
  const anchorStart = 0;

  let trainStartIdx = 0;
  let trainEndIdx = trainStartIdx + trainWindowDays - 1;

  while (trainEndIdx < dates.length) {
    const oosStartIdx = trainEndIdx + 1 + purgeGapDays;
    const oosEndIdx = Math.min(oosStartIdx + forwardStepDays - 1, dates.length - 1);

    if (oosStartIdx >= dates.length) break;

    windows.push({
      trainStart: dates[mode === 'anchored' ? anchorStart : trainStartIdx],
      trainEnd: dates[trainEndIdx],
      oosStart: dates[oosStartIdx],
      oosEnd: dates[oosEndIdx],
    });

    // Advance
    if (mode === 'rolling') {
      trainStartIdx += forwardStepDays;
    }
    trainEndIdx += forwardStepDays;
  }

  return windows;
}

// ── Per-Window Optimizer ────────────────────────────────

export interface WindowOptResult {
  bestConfig: SimConfig;
  bestSharpe: number;
  allResults: { config: SimConfig; sharpe: number; trades: number }[];
}

/**
 * Evaluate a single config on training signals. Returns analytics.
 * Uses the provided evaluator function (injected for testability and
 * to support both sync cache-only and async API-backed modes).
 */
export type TradeEvaluator = (
  signal: EntrySignal,
  config: SimConfig,
  allTradingDates: string[],
  maxDate: string,
) => OptionTrade | null;

/**
 * Optimize a single WFA window: run all candidate configs on training signals,
 * return best by Sharpe.
 */
export function optimizeWindow(
  candidates: SimConfig[],
  signalsByPreset: Map<SignalPresetKey, EntrySignal[]>,
  allTradingDates: string[],
  trainStart: string,
  trainEnd: string,
  evaluator: TradeEvaluator,
): WindowOptResult {
  const results: { config: SimConfig; sharpe: number; trades: number }[] = [];

  for (const config of candidates) {
    const presetKey = config.signalWeightPreset ?? 'ema';
    const allSignals = signalsByPreset.get(presetKey) ?? [];
    const trainSignals = allSignals.filter(s => s.date >= trainStart && s.date <= trainEnd);

    // Guard: verify no signal leaks past trainEnd
    const leak = trainSignals.find(s => s.date > trainEnd);
    if (leak) throw new Error(`Data isolation violation: signal ${leak.date} > trainEnd ${trainEnd}`);

    const trades: OptionTrade[] = [];
    for (const signal of trainSignals) {
      const trade = evaluator(signal, config, allTradingDates, trainEnd);
      if (trade) trades.push(trade);
    }
    const analytics = computeOptionAnalytics(trades);
    results.push({ config, sharpe: analytics.sharpe, trades: trades.length });
  }

  results.sort((a, b) => b.sharpe - a.sharpe);
  return {
    bestConfig: results[0]?.config ?? candidates[0],
    bestSharpe: results[0]?.sharpe ?? 0,
    allResults: results,
  };
}

// ── WFA Config & Result Types ───────────────────────────

export interface WFAOptionsConfig {
  tickers: string[];
  startDate: string;
  endDate: string;
  /** Training window in trading days (default 504 = ~2 years) */
  trainWindowDays: number;
  /** Forward step in trading days (default 126 = ~6 months) */
  forwardStepDays: number;
  /** Purge gap between train end and OOS start in trading days (default 65) */
  purgeGapDays: number;
  mode: WalkForwardMode;
  /** Max concurrent positions across all tickers */
  maxPositions: number;
  /** Max positions per ticker */
  maxPerTicker: number;
  /** Starting capital for portfolio sizing */
  startingCapital: number;
}

export interface WFAWindow {
  windowIndex: number;
  trainStart: string;
  trainEnd: string;
  oosStart: string;
  oosEnd: string;
  bestConfig: SimConfig;
  bestTrainSharpe: number;
  oosTrades: OptionTrade[];
  oosSharpe: number;
  oosWinRate: number;
  oosMaxDD: number;
}

export interface WFAResult {
  config: WFAOptionsConfig;
  windows: WFAWindow[];
  allOOSTrades: OptionTrade[];
  oosEquityCurve: { date: string; equity: number }[];
  oosSharpe: number;
  oosWinRate: number;
  oosMaxDD: number;
  oosTotalPnl: number;
  wfEfficiency: number;
  stressMetrics?: CorrelationStressResult;
  elapsedMs: number;
}

// ── WFA Main Loop ───────────────────────────────────────

/**
 * Run full Walk-Forward Analysis for options.
 *
 * Key design decisions:
 * 1. Signals are precomputed per preset for the full date range.
 * 2. SimConfig (entry/exit params + signal preset) optimized per training window.
 * 3. Open positions carry across OOS boundaries (maxDate = config.endDate).
 * 4. Equity curve is continuous across all OOS windows.
 */
export function runWFAOptions(
  config: WFAOptionsConfig,
  signalsByPreset: Map<SignalPresetKey, EntrySignal[]>,
  allTradingDates: string[],
  sweepCandidates: SimConfig[],
  evaluator: TradeEvaluator,
  onProgress?: (windowIdx: number, totalWindows: number) => void,
): WFAResult {
  const t0 = Date.now();

  const windows = buildWFAWindows(allTradingDates, {
    trainWindowDays: config.trainWindowDays,
    forwardStepDays: config.forwardStepDays,
    purgeGapDays: config.purgeGapDays,
    mode: config.mode,
    startDate: config.startDate,
    endDate: config.endDate,
  });

  const allOOSTrades: OptionTrade[] = [];
  const wfaWindows: WFAWindow[] = [];

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    onProgress?.(i, windows.length);

    // 1. Optimize on training data
    const optResult = optimizeWindow(
      sweepCandidates, signalsByPreset, allTradingDates, w.trainStart, w.trainEnd, evaluator,
    );

    // 2. Run OOS with best config
    const bestPreset = optResult.bestConfig.signalWeightPreset ?? 'ema';
    const presetSignals = signalsByPreset.get(bestPreset) ?? [];
    const oosSignals = presetSignals.filter(s => s.date >= w.oosStart && s.date <= w.oosEnd);
    const oosTrades: OptionTrade[] = [];

    for (const signal of oosSignals) {
      // maxDate is config.endDate, NOT w.oosEnd — allows positions to close after OOS window
      const trade = evaluator(signal, optResult.bestConfig, allTradingDates, config.endDate);
      if (trade) oosTrades.push(trade);
    }

    const oosAnalytics = computeOptionAnalytics(oosTrades);

    wfaWindows.push({
      windowIndex: i,
      trainStart: w.trainStart,
      trainEnd: w.trainEnd,
      oosStart: w.oosStart,
      oosEnd: w.oosEnd,
      bestConfig: optResult.bestConfig,
      bestTrainSharpe: optResult.bestSharpe,
      oosTrades,
      oosSharpe: oosAnalytics.sharpe,
      oosWinRate: oosAnalytics.winRate,
      oosMaxDD: oosAnalytics.maxDrawdown,
    });

    allOOSTrades.push(...oosTrades);
  }

  // 3. Build continuous equity curve from all OOS trades
  const sortedTrades = [...allOOSTrades].sort(
    (a, b) => a.exitDate.localeCompare(b.exitDate)
  );
  let equity = config.startingCapital;
  let peak = equity;
  let maxDD = 0;
  const equityCurve: { date: string; equity: number }[] = [];

  for (const t of sortedTrades) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - equity) / peak);
    equityCurve.push({ date: t.exitDate, equity });
  }

  const oosAllAnalytics = computeOptionAnalytics(allOOSTrades);
  const avgTrainSharpe = wfaWindows.length > 0
    ? wfaWindows.reduce((s, w) => s + w.bestTrainSharpe, 0) / wfaWindows.length
    : 0;

  // 4. Correlation stress testing
  const stressMetrics = allOOSTrades.length > 0
    ? computeCorrelationStress(allOOSTrades, config.startDate, config.endDate, config.startingCapital)
    : undefined;

  return {
    config,
    windows: wfaWindows,
    allOOSTrades,
    oosEquityCurve: equityCurve,
    oosSharpe: oosAllAnalytics.sharpe,
    oosWinRate: oosAllAnalytics.winRate,
    oosMaxDD: maxDD * 100,
    oosTotalPnl: allOOSTrades.reduce((s, t) => s + t.pnl, 0),
    wfEfficiency: avgTrainSharpe > 0 ? oosAllAnalytics.sharpe / avgTrainSharpe : 0,
    stressMetrics,
    elapsedMs: Date.now() - t0,
  };
}
