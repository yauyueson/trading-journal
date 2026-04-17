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
import { computeDSR } from './wfa-v2-stats';

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
  allResults: { config: SimConfig; sharpe: number; trades: number; dsr: number; robustScore: number }[];
}

export interface PortfolioExecutionConfig {
  maxPositions: number;
  maxPerTicker: number;
  startingCapital: number;
}

export interface PortfolioDailyMetrics {
  sharpe: number;
  maxDrawdownPct: number;
  equityCurve: { date: string; equity: number }[];
  dailyReturns: number[];
}

export interface SelectionGuardConfig {
  enabled?: boolean;
  minTrainTrades?: number;
  minDSR?: number;
  fallbackTopK?: number;
}

export type SelectionMode = 'single' | 'ensemble_top_k';

export interface ConfiguredSignal {
  signal: EntrySignal;
  config: SimConfig;
  robustScore?: number;
  votes?: number;
}

interface OpenPositionState {
  trade: OptionTrade;
  riskCapital: number;
}

export interface PortfolioConstraintState {
  openPositions: OpenPositionState[];
  openCountByTicker: Map<string, number>;
  openRiskCapital: number;
}

export interface PreparedOOSWindowExecution {
  windowIndex: number;
  trainStart: string;
  trainEnd: string;
  oosStart: string;
  oosEnd: string;
  bestConfig: SimConfig;
  selectedConfigs?: SimConfig[];
  bestTrainSharpe: number;
  // Each OOS signal is bound to the config selected when that trade would be entered.
  // Later windows may choose different configs for new entries, but carried trades keep
  // their originating config because the evaluator resolves exits at entry time.
  configuredSignals: ConfiguredSignal[];
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

const DEFAULT_EXECUTION_CONFIG: PortfolioExecutionConfig = {
  maxPositions: Number.POSITIVE_INFINITY,
  maxPerTicker: Number.POSITIVE_INFINITY,
  startingCapital: 100_000,
};

const DEFAULT_SELECTION_GUARD: Required<SelectionGuardConfig> = {
  enabled: true,
  minTrainTrades: 30,
  minDSR: 0.55,
  fallbackTopK: 5,
};

const DEFAULT_SELECTION_MODE: SelectionMode = 'ensemble_top_k';
const DEFAULT_ENSEMBLE_SIZE = 3;
const DEFAULT_ENSEMBLE_MIN_VOTES = 2;

function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function capitalAtRisk(trade: OptionTrade): number {
  if (trade.mode === 'CREDIT_SPREAD') {
    return Math.max(0, (trade.maxLoss ?? trade.entryPrice) * 100);
  }
  return Math.max(0, trade.entryPrice * 100);
}

function stableParity(text: string): number {
  let parity = 0;
  for (let index = 0; index < text.length; index++) {
    parity = (parity + text.charCodeAt(index)) & 1;
  }
  return parity;
}

function directionSortValue(signal: EntrySignal): number {
  // Avoid a permanent bullish/bearish ordering bias under portfolio constraints.
  // We alternate the preferred direction by (date,ticker) bucket so tie-breaks
  // stay deterministic without always giving CALLs first slot access.
  const preferCallFirst = stableParity(`${signal.date}|${signal.ticker}`) === 0;
  return signal.direction === (preferCallFirst ? 'CALL' : 'PUT') ? 0 : 1;
}

function compareSignalExecutionOrder(a: EntrySignal, b: EntrySignal): number {
  return a.date.localeCompare(b.date) ||
    (b.score ?? 0) - (a.score ?? 0) ||  // higher score wins within same date
    a.ticker.localeCompare(b.ticker) ||
    directionSortValue(a) - directionSortValue(b) ||
    a.direction.localeCompare(b.direction);
}

function compareConfiguredSignalExecutionOrder(a: ConfiguredSignal, b: ConfiguredSignal): number {
  return compareSignalExecutionOrder(a.signal, b.signal);
}

export function createConstraintState(): PortfolioConstraintState {
  return {
    openPositions: [],
    openCountByTicker: new Map(),
    openRiskCapital: 0,
  };
}

function cloneConstraintState(state: PortfolioConstraintState): PortfolioConstraintState {
  return {
    openPositions: [...state.openPositions],
    openCountByTicker: new Map(state.openCountByTicker),
    openRiskCapital: state.openRiskCapital,
  };
}

function retireClosedPositions(state: PortfolioConstraintState, signalDate: string): void {
  for (let i = state.openPositions.length - 1; i >= 0; i--) {
    const open = state.openPositions[i];
    if (open.trade.exitDate <= signalDate) {
      state.openPositions.splice(i, 1);
      state.openRiskCapital = Math.max(0, state.openRiskCapital - open.riskCapital);
      const prev = state.openCountByTicker.get(open.trade.ticker) ?? 0;
      if (prev <= 1) state.openCountByTicker.delete(open.trade.ticker);
      else state.openCountByTicker.set(open.trade.ticker, prev - 1);
    }
  }
}

/**
 * Evaluate signals with portfolio constraints:
 * - max concurrent positions
 * - max positions per ticker
 * - capital-at-risk budget (1 contract per accepted signal)
 */
export function evaluateSignalsWithConstraints(
  signals: EntrySignal[],
  simConfig: SimConfig,
  executionConfig: PortfolioExecutionConfig,
  allTradingDates: string[],
  maxDate: string,
  evaluator: TradeEvaluator,
): OptionTrade[] {
  const configuredSignals = signals.map(signal => ({ signal, config: simConfig }));
  return evaluateConfiguredSignalsWithState(
    configuredSignals,
    executionConfig,
    allTradingDates,
    maxDate,
    evaluator,
  ).trades;
}

export function evaluateConfiguredSignalsWithConstraints(
  configuredSignals: ConfiguredSignal[],
  executionConfig: PortfolioExecutionConfig,
  allTradingDates: string[],
  maxDate: string,
  evaluator: TradeEvaluator,
): OptionTrade[] {
  return evaluateConfiguredSignalsWithState(
    configuredSignals,
    executionConfig,
    allTradingDates,
    maxDate,
    evaluator,
  ).trades;
}

export function evaluateConfiguredSignalsWithState(
  configuredSignals: ConfiguredSignal[],
  executionConfig: PortfolioExecutionConfig,
  allTradingDates: string[],
  maxDate: string,
  evaluator: TradeEvaluator,
  initialState?: PortfolioConstraintState,
): { trades: OptionTrade[]; state: PortfolioConstraintState } {
  const sortedSignals = [...configuredSignals].sort(compareConfiguredSignalExecutionOrder);
  const trades: OptionTrade[] = [];
  const state = initialState ? cloneConstraintState(initialState) : createConstraintState();

  for (const item of sortedSignals) {
    retireClosedPositions(state, item.signal.date);

    if (state.openPositions.length >= executionConfig.maxPositions) continue;
    const tickerOpenCount = state.openCountByTicker.get(item.signal.ticker) ?? 0;
    if (tickerOpenCount >= executionConfig.maxPerTicker) continue;

    const trade = evaluator(item.signal, item.config, allTradingDates, maxDate);
    if (!trade) continue;

    const riskCapital = capitalAtRisk(trade);
    if (state.openRiskCapital + riskCapital > executionConfig.startingCapital) continue;

    trades.push(trade);
    state.openPositions.push({ trade, riskCapital });
    state.openRiskCapital += riskCapital;
    state.openCountByTicker.set(item.signal.ticker, tickerOpenCount + 1);
  }

  return { trades, state };
}

export function computePortfolioDailyMetrics(
  trades: OptionTrade[],
  allTradingDates: string[],
  startDate: string,
  endDate: string,
  startingCapital: number,
  // Seed equity and peak when measuring a window that follows prior P&L
  // (e.g. holdout when carried selection positions straddle the boundary).
  // Defaults to startingCapital for single-window / selection use.
  initialEquity?: number,
  // Peak equity at the window boundary. Separate from initialEquity because
  // selection can end below an earlier peak — if we seeded peak = equity,
  // any continuing drawdown in the window would be measured from the
  // depressed boundary equity, not the true carried peak.
  initialPeak?: number,
): PortfolioDailyMetrics {
  const dates = allTradingDates.filter(d => d >= startDate && d <= endDate);
  if (dates.length === 0) {
    return { sharpe: 0, maxDrawdownPct: 0, equityCurve: [], dailyReturns: [] };
  }

  const dateIdx = new Map<string, number>(dates.map((d, i) => [d, i]));
  const dailyPnl = new Array<number>(dates.length).fill(0);

  const windowStart = dates[0];

  for (const trade of trades) {
    let contributed = 0;
    // For a trade carried into the window (entry < windowStart), only the
    // in-window P&L change should count. preWindowUnrealized captures the
    // trade's unrealized P&L at the moment just before the window starts, so
    // the exit-day residual subtracts it and doesn't re-book selection-period
    // gains/losses as window-local P&L.
    let preWindowUnrealized = 0;

    if (trade.dailyMtM && trade.dailyMtM.length > 0) {
      for (const mtm of trade.dailyMtM) {
        if (mtm.date < windowStart) preWindowUnrealized = mtm.unrealizedPnl;
        else break;
      }

      let prevUnrealized = 0;
      for (const mtm of trade.dailyMtM) {
        const day = mtm.date.slice(0, 10);
        const idx = dateIdx.get(day);
        const change = mtm.unrealizedPnl - prevUnrealized;
        if (idx !== undefined) {
          dailyPnl[idx] += change;
          contributed += change;
        }
        prevUnrealized = mtm.unrealizedPnl;
      }
    }

    const residual = trade.pnl - preWindowUnrealized - contributed;
    if (Math.abs(residual) > 1e-9) {
      const exitIdx = dateIdx.get(trade.exitDate.slice(0, 10));
      if (exitIdx !== undefined) dailyPnl[exitIdx] += residual;
    }
  }

  const dailyReturns: number[] = [];
  const equityCurve: { date: string; equity: number }[] = [];
  const baseEquity = initialEquity ?? startingCapital;
  const basePeak = initialPeak ?? baseEquity;
  let equity = baseEquity;
  let peak = basePeak;
  let maxDD = peak > 0 ? Math.max(0, (peak - equity) / peak) : 0;

  for (let i = 0; i < dates.length; i++) {
    const prevEquity = equity;
    equity += dailyPnl[i];
    const ret = prevEquity > 0 ? dailyPnl[i] / prevEquity : 0;
    dailyReturns.push(ret);

    peak = Math.max(peak, equity);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - equity) / peak);
    equityCurve.push({ date: dates[i], equity });
  }

  const avgRet = dailyReturns.length > 0
    ? dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length
    : 0;
  const stdRet = std(dailyReturns);
  const sharpe = stdRet > 1e-10 ? (avgRet / stdRet) * Math.sqrt(252) : 0;

  return {
    sharpe,
    maxDrawdownPct: maxDD * 100,
    equityCurve,
    dailyReturns,
  };
}

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
  executionConfig: PortfolioExecutionConfig = DEFAULT_EXECUTION_CONFIG,
  selectionGuard: SelectionGuardConfig = DEFAULT_SELECTION_GUARD,
): WindowOptResult {
  const results: { config: SimConfig; sharpe: number; trades: number; dsr: number; robustScore: number }[] = [];
  const guardCfg: Required<SelectionGuardConfig> = {
    ...DEFAULT_SELECTION_GUARD,
    ...selectionGuard,
  };
  const nTrials = Math.max(1, candidates.length);

  for (const config of candidates) {
    const presetKey = config.signalWeightPreset ?? 'ema';
    const allSignals = signalsByPreset.get(presetKey) ?? [];
    const trainSignals = allSignals.filter(s => s.date >= trainStart && s.date <= trainEnd);

    // Guard: verify no signal leaks past trainEnd
    const leak = trainSignals.find(s => s.date > trainEnd);
    if (leak) throw new Error(`Data isolation violation: signal ${leak.date} > trainEnd ${trainEnd}`);

    const trades = evaluateSignalsWithConstraints(
      trainSignals,
      config,
      executionConfig,
      allTradingDates,
      trainEnd,
      evaluator,
    );
    const portfolioMetrics = computePortfolioDailyMetrics(
      trades,
      allTradingDates,
      trainStart,
      trainEnd,
      executionConfig.startingCapital,
    );
    const dsr = computeDSR(portfolioMetrics.sharpe, nTrials, portfolioMetrics.dailyReturns).dsr;
    const tradeWeight = 1 + Math.log1p(Math.max(0, trades.length)) / 4;
    const robustScore = portfolioMetrics.sharpe * (0.5 + dsr) * tradeWeight;
    results.push({ config, sharpe: portfolioMetrics.sharpe, trades: trades.length, dsr, robustScore });
  }

  results.sort((a, b) => b.sharpe - a.sharpe);

  let best = results[0];
  if (guardCfg.enabled && results.length > 0) {
    const eligible = results.filter(
      r => r.trades >= guardCfg.minTrainTrades && r.dsr >= guardCfg.minDSR,
    );
    const fallbackTopK = Math.max(1, Math.min(guardCfg.fallbackTopK, results.length));
    const selectionPool = eligible.length > 0 ? eligible : results.slice(0, fallbackTopK);
    best = [...selectionPool].sort((a, b) =>
      b.robustScore - a.robustScore ||
      b.dsr - a.dsr ||
      b.sharpe - a.sharpe ||
      b.trades - a.trades
    )[0];
  }

  return {
    bestConfig: best?.config ?? candidates[0],
    bestSharpe: best?.sharpe ?? 0,
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
  /**
   * How per-window OOS metrics are measured:
   * - 'lifecycle': include full trade lifecycle through global endDate
   * - 'strict': truncate per-window metrics at each window's oosEnd
   */
  windowMetricsMode?: 'lifecycle' | 'strict';
  /**
   * Guard against winner's-curse config selection:
   * min-trades + DSR filtering before final train-window config pick.
   */
  selectionGuard?: SelectionGuardConfig;
  selectionMode?: SelectionMode;
  ensembleSize?: number;
  ensembleMinVotes?: number;
}

export interface WFAWindow {
  windowIndex: number;
  trainStart: string;
  trainEnd: string;
  oosStart: string;
  oosEnd: string;
  bestConfig: SimConfig;
  selectedConfigs?: SimConfig[];
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

export function executePreparedOOSWindowsWithCarry(
  preparedWindows: PreparedOOSWindowExecution[],
  executionConfig: PortfolioExecutionConfig,
  allTradingDates: string[],
  maxDate: string,
  evaluator: TradeEvaluator,
  windowMetricsMode: 'lifecycle' | 'strict',
  startingCapital: number,
): { windows: WFAWindow[]; allOOSTrades: OptionTrade[] } {
  const state = createConstraintState();
  const allOOSTrades: OptionTrade[] = [];
  const wfaWindows: WFAWindow[] = [];

  for (const prepared of preparedWindows) {
    const execution = evaluateConfiguredSignalsWithState(
      prepared.configuredSignals,
      executionConfig,
      allTradingDates,
      maxDate,
      evaluator,
      state,
    );
    const windowTrades = execution.trades;
    state.openPositions = execution.state.openPositions;
    state.openCountByTicker = execution.state.openCountByTicker;
    state.openRiskCapital = execution.state.openRiskCapital;

    allOOSTrades.push(...windowTrades);

    const oosAnalytics = computeOptionAnalytics(windowTrades);
    const windowMetricsEnd = windowMetricsMode === 'strict' ? prepared.oosEnd : maxDate;
    const windowMetrics = computePortfolioDailyMetrics(
      allOOSTrades,
      allTradingDates,
      prepared.oosStart,
      windowMetricsEnd,
      startingCapital,
    );

    wfaWindows.push({
      windowIndex: prepared.windowIndex,
      trainStart: prepared.trainStart,
      trainEnd: prepared.trainEnd,
      oosStart: prepared.oosStart,
      oosEnd: prepared.oosEnd,
      bestConfig: prepared.bestConfig,
      selectedConfigs: prepared.selectedConfigs,
      bestTrainSharpe: prepared.bestTrainSharpe,
      oosTrades: windowTrades,
      oosSharpe: windowMetrics.sharpe,
      oosWinRate: oosAnalytics.winRate,
      oosMaxDD: windowMetrics.maxDrawdownPct,
    });
  }

  return { windows: wfaWindows, allOOSTrades };
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
  const windowMetricsMode = config.windowMetricsMode ?? 'strict';
  const selectionMode = config.selectionMode ?? DEFAULT_SELECTION_MODE;
  const ensembleSize = Math.max(1, config.ensembleSize ?? DEFAULT_ENSEMBLE_SIZE);
  const ensembleMinVotes = Math.max(1, config.ensembleMinVotes ?? DEFAULT_ENSEMBLE_MIN_VOTES);

  const windows = buildWFAWindows(allTradingDates, {
    trainWindowDays: config.trainWindowDays,
    forwardStepDays: config.forwardStepDays,
    purgeGapDays: config.purgeGapDays,
    mode: config.mode,
    startDate: config.startDate,
    endDate: config.endDate,
  });

  const preparedWindows: PreparedOOSWindowExecution[] = [];

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    onProgress?.(i, windows.length);

    // 1. Optimize on training data
    const optResult = optimizeWindow(
      sweepCandidates,
      signalsByPreset,
      allTradingDates,
      w.trainStart,
      w.trainEnd,
      evaluator,
      {
        maxPositions: config.maxPositions,
        maxPerTicker: config.maxPerTicker,
        startingCapital: config.startingCapital,
      },
      config.selectionGuard,
    );

    // 2. Run OOS with best config
    const selectedResults = selectConfigsForOOS(
      optResult.allResults,
      config.selectionGuard,
      selectionMode,
      ensembleSize,
    );
    const configuredSignals = buildConfiguredSignalsForWindow(
      selectedResults,
      signalsByPreset,
      w.oosStart,
      w.oosEnd,
      selectionMode === 'single' ? 1 : ensembleMinVotes,
    );
    preparedWindows.push({
      windowIndex: i,
      trainStart: w.trainStart,
      trainEnd: w.trainEnd,
      oosStart: w.oosStart,
      oosEnd: w.oosEnd,
      bestConfig: selectedResults[0]?.config ?? optResult.bestConfig,
      selectedConfigs: selectedResults.map(r => r.config),
      bestTrainSharpe: selectedResults[0]?.sharpe ?? optResult.bestSharpe,
      configuredSignals,
    });
  }

  const executionConfig: PortfolioExecutionConfig = {
    maxPositions: config.maxPositions,
    maxPerTicker: config.maxPerTicker,
    startingCapital: config.startingCapital,
  };
  const { windows: wfaWindows, allOOSTrades } = executePreparedOOSWindowsWithCarry(
    preparedWindows,
    executionConfig,
    allTradingDates,
    config.endDate,
    evaluator,
    windowMetricsMode,
    config.startingCapital,
  );

  // 3. Build continuous daily equity curve from all OOS trades
  const allPortfolioMetrics = computePortfolioDailyMetrics(
    allOOSTrades,
    allTradingDates,
    config.startDate,
    config.endDate,
    config.startingCapital,
  );
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
    oosEquityCurve: allPortfolioMetrics.equityCurve,
    oosSharpe: allPortfolioMetrics.sharpe,
    oosWinRate: oosAllAnalytics.winRate,
    oosMaxDD: allPortfolioMetrics.maxDrawdownPct,
    oosTotalPnl: allOOSTrades.reduce((s, t) => s + t.pnl, 0),
    wfEfficiency: avgTrainSharpe >= 0.1 ? allPortfolioMetrics.sharpe / avgTrainSharpe : 0,
    stressMetrics,
    elapsedMs: Date.now() - t0,
  };
}

type RankedWindowResult = WindowOptResult['allResults'][number];

function getEligibleWindowResults(
  results: RankedWindowResult[],
  selectionGuard: SelectionGuardConfig = DEFAULT_SELECTION_GUARD,
): RankedWindowResult[] {
  const guardCfg: Required<SelectionGuardConfig> = {
    ...DEFAULT_SELECTION_GUARD,
    ...selectionGuard,
  };
  if (!guardCfg.enabled) return [...results];

  const eligible = results.filter(
    r => r.trades >= guardCfg.minTrainTrades && r.dsr >= guardCfg.minDSR,
  );
  if (eligible.length > 0) {
    return [...eligible].sort((a, b) =>
      b.robustScore - a.robustScore ||
      b.dsr - a.dsr ||
      b.sharpe - a.sharpe ||
      b.trades - a.trades
    );
  }

  const fallbackTopK = Math.max(1, Math.min(guardCfg.fallbackTopK, results.length));
  return [...results.slice(0, fallbackTopK)].sort((a, b) =>
    b.robustScore - a.robustScore ||
    b.dsr - a.dsr ||
    b.sharpe - a.sharpe ||
    b.trades - a.trades
  );
}

export function selectConfigsForOOS(
  results: RankedWindowResult[],
  selectionGuard: SelectionGuardConfig = DEFAULT_SELECTION_GUARD,
  selectionMode: SelectionMode = DEFAULT_SELECTION_MODE,
  ensembleSize: number = DEFAULT_ENSEMBLE_SIZE,
): RankedWindowResult[] {
  const ranked = getEligibleWindowResults(results, selectionGuard);
  if (ranked.length === 0) return [];
  if (selectionMode === 'single') return [ranked[0]];
  return ranked.slice(0, Math.max(1, ensembleSize));
}

export function buildConfiguredSignalsForWindow(
  selectedResults: RankedWindowResult[],
  signalsByPreset: Map<SignalPresetKey, EntrySignal[]>,
  oosStart: string,
  oosEnd: string,
  minVotes: number,
): ConfiguredSignal[] {
  const effectiveMinVotes = Math.max(1, Math.min(minVotes, selectedResults.length || 1));
  const voted = new Map<string, ConfiguredSignal>();

  for (const result of selectedResults) {
    const presetKey = result.config.signalWeightPreset ?? 'ema';
    const presetSignals = signalsByPreset.get(presetKey) ?? [];
    const oosSignals = presetSignals.filter(s => s.date >= oosStart && s.date <= oosEnd);

    for (const signal of oosSignals) {
      const key = `${signal.ticker}|${signal.date}|${signal.direction}`;
      const existing = voted.get(key);
      if (!existing) {
        voted.set(key, {
          signal,
          config: result.config,
          robustScore: result.robustScore,
          votes: 1,
        });
        continue;
      }

      existing.votes = (existing.votes ?? 0) + 1;
      if ((result.robustScore ?? 0) > (existing.robustScore ?? Number.NEGATIVE_INFINITY)) {
        existing.config = result.config;
        existing.robustScore = result.robustScore;
      }
    }
  }

  return [...voted.values()]
    .filter(v => (v.votes ?? 0) >= effectiveMinVotes)
    .sort((a, b) =>
      a.signal.date.localeCompare(b.signal.date) ||
      a.signal.ticker.localeCompare(b.signal.ticker) ||
      a.signal.direction.localeCompare(b.signal.direction)
    );
}
