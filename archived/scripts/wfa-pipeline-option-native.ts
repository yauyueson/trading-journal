import {
  buildWFAWindows,
  buildConfiguredSignalsForWindow,
  computePortfolioDailyMetrics,
  optimizeWindow,
  selectConfigsForOOS,
  type PortfolioExecutionConfig,
  type SelectionGuardConfig,
  type WFAWindow,
} from '../src/lib/backtest/wfa-options';
import {
  DEFAULT_DYNAMIC_SLIPPAGE,
  type FillMode,
  type SignalPresetKey,
} from '../src/lib/backtest/types';
import {
  DEFAULT_SWING_LONG_OPTION_CONFIG,
  computeOptionAnalytics,
  type EntrySignal,
  type OptionTrade,
  type SimConfig,
} from '../src/lib/backtest/option-sim';
import { closeDB, getCachedChain, initDB } from '../src/lib/backtest/chain-cache';
import { fetchTickerData, generateSignalsForPreset, type TickerData } from '../src/lib/backtest/signal-data';
import { buildUnderlyingHistory, indexUnderlyingHistories, type IndexedUnderlyingHistory } from '../src/lib/backtest/underlying-stop';
import {
  buildShadowUnderlyingTrade,
  computeSwingLongContracts,
  formatSwingLongBand,
  resolveSwingLongMinExitDTE,
  simulateSwingLongOption,
  type ShadowUnderlyingTrade,
  type SwingLongEvaluation,
  type SwingLongSkipReason,
} from '../src/lib/backtest/swing-long-option';

export interface OptionNativePipelineConfig {
  stage: 'stage0' | 'stage1';
  tickers: string[];
  dataStart: string;
  startDate: string;
  endDate: string;
  trainWindowDays: number;
  forwardStepDays: number;
  purgeGapDays: number;
  mode: 'rolling' | 'anchored';
  maxPerTicker: number;
  startingCapital: number;
  fillMode: FillMode;
  presets: SignalPresetKey[];
  selectionGuard?: SelectionGuardConfig;
  directionalDebitBaselineSharpe?: number;
  directionalDebitBaselinePnl?: number;
  sweepOverrides?: Partial<OptionNativeSweepDimensions>;
}

export interface OptionNativeSweepDimensions {
  presets?: SignalPresetKey[];
  dteRanges?: Array<[number, number]>;
  deltaRanges?: Array<[number, number]>;
  profitTargets?: number[];
  maxHoldDays?: number[];
  exitEMAs?: number[];
  exitConfirmDays?: number[];
  exitRequireSlope?: boolean[];
  maxIVRanks?: number[];
  maxRecentGapPcts?: number[];
  maxFrontBackIVAnomalies?: number[];
  maxSpreadPcts?: number[];
  minOIs?: number[];
  riskBudgetPcts?: number[];
  maxPortfolioPremiumPcts?: number[];
  maxPositions?: number[];
}

export interface OptionNativeExecutionDiagnostics {
  totalConfiguredSignals: number;
  acceptedTrades: number;
  portfolioCapacitySkips: number;
  portfolioPremiumCapSkips: number;
  skippedByReason: Record<string, number>;
  entrySpreadPcts: number[];
  entryOIs: number[];
  totalDailyMarks: number;
  syntheticMarks: number;
  fillRate: number;
  medianEntrySpreadPct: number;
  p75EntrySpreadPct: number;
  syntheticMarkPct: number;
}

export interface OptionNativeShadowSummary {
  totalPnl: number;
  sharpe: number;
  maxDD: number;
  avgCostDragPerTrade: number;
  costDrag: number;
  costDragPctOfShadow: number | null;
  byTicker: Record<string, { optionPnl: number; shadowPnl: number; costDrag: number }>;
  byDteBand: Record<string, { optionPnl: number; shadowPnl: number; costDrag: number }>;
}

export interface OptionNativeGateResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; actual: number | string; target: string }>;
}

export interface OptionNativeResult {
  config: OptionNativePipelineConfig;
  candidates: SimConfig[];
  allTradingDates: string[];
  windows: Array<WFAWindow & { oosTotalPnl: number; shadowTotalPnl: number }>;
  allOOSTrades: OptionTrade[];
  shadowTrades: ShadowUnderlyingTrade[];
  diagnostics: OptionNativeExecutionDiagnostics;
  shadowSummary: OptionNativeShadowSummary;
  gate: OptionNativeGateResult;
  oosEquityCurve: { date: string; equity: number }[];
  shadowEquityCurve: { date: string; equity: number }[];
  oosSharpe: number;
  oosWinRate: number;
  oosMaxDD: number;
  oosTotalPnl: number;
  wfEfficiency: number;
  elapsedMs: number;
}

const MAX_CHAIN_MEMO = 400;
const chainMemo = new Map<string, ReturnType<typeof getCachedChain>>();

function getCachedChainMemo(ticker: string, date: string): ReturnType<typeof getCachedChain> {
  const key = `${ticker}|${date}`;
  const cached = chainMemo.get(key);
  if (cached !== undefined) {
    chainMemo.delete(key);
    chainMemo.set(key, cached);
    return cached;
  }
  const rows = getCachedChain(ticker, date);
  if (chainMemo.size >= MAX_CHAIN_MEMO) {
    const oldestKey = chainMemo.keys().next().value;
    if (oldestKey) chainMemo.delete(oldestKey);
  }
  chainMemo.set(key, rows);
  return rows;
}

export const OPTION_NATIVE_DEFAULTS: OptionNativePipelineConfig = {
  stage: 'stage0',
  tickers: ['SPY', 'QQQ', 'AMD', 'IWM', 'TSLA', 'AAPL', 'JPM', 'NVDA', 'AMZN', 'MSFT', 'META', 'NFLX', 'GOOG', 'GS'],
  dataStart: '2017-01-01',
  startDate: '2018-01-01',
  endDate: '2026-02-28',
  trainWindowDays: 504,
  forwardStepDays: 126,
  purgeGapDays: 65,
  mode: 'rolling',
  maxPerTicker: 1,
  startingCapital: 100_000,
  fillMode: 'bidask',
  presets: ['pb8', 'pb21'],
  directionalDebitBaselineSharpe: -0.27,
  directionalDebitBaselinePnl: -35_100,
};

export const OPTION_NATIVE_STAGE0_DEFAULTS: OptionNativeSweepDimensions = {
  presets: ['pb8', 'pb21'],
  dteRanges: [[35, 50], [50, 70]],
  deltaRanges: [[0.70, 0.80]],
  profitTargets: [0.25, 0.40],
  maxHoldDays: [10, 15],
  exitEMAs: [21],
  exitConfirmDays: [2],
  exitRequireSlope: [true],
  maxIVRanks: [55],
  maxRecentGapPcts: [5],
  maxFrontBackIVAnomalies: [1.25],
  maxSpreadPcts: [0.06],
  minOIs: [100],
  riskBudgetPcts: [0.005],
  maxPortfolioPremiumPcts: [0.02],
  maxPositions: [3, 5],
};

export const OPTION_NATIVE_STAGE1_DEFAULTS: OptionNativeSweepDimensions = {
  presets: ['pb8', 'pb21'],
  dteRanges: [[35, 50], [50, 70]],
  deltaRanges: [[0.65, 0.75], [0.75, 0.85]],
  profitTargets: [0.25, 0.40],
  maxHoldDays: [10, 15],
  exitEMAs: [21, 34],
  exitConfirmDays: [2],
  exitRequireSlope: [true],
  maxIVRanks: [45, 55],
  maxRecentGapPcts: [5],
  maxFrontBackIVAnomalies: [1.25],
  maxSpreadPcts: [0.04, 0.06],
  minOIs: [100],
  riskBudgetPcts: [0.005],
  maxPortfolioPremiumPcts: [0.02],
  maxPositions: [3, 5],
};

export function scoreOptionNativeSignalQuality(signal: EntrySignal): number {
  const score = signal.score ?? 0;
  const dirConfidence = signal.dirConfidence ?? 0;
  const absD8 = Math.abs(signal.d8 ?? 0);
  const gapPenalty = Math.min(20, (signal.recentMaxGapPct10 ?? signal.recentMaxGapPct ?? 0) * 4);
  const anomalyPenalty = (signal.frontBackIVAnomaly ?? 0) > 1.10 ? 25 : 0;
  return score * 10 + dirConfidence - (2 * absD8) - gapPenalty - anomalyPenalty;
}

export function compareOptionNativeSignals(a: EntrySignal, b: EntrySignal): number {
  return a.date.localeCompare(b.date) ||
    ((b.rankingScore ?? Number.NEGATIVE_INFINITY) - (a.rankingScore ?? Number.NEGATIVE_INFINITY)) ||
    (b.score ?? 0) - (a.score ?? 0) ||
    (b.dirConfidence ?? 0) - (a.dirConfidence ?? 0) ||
    Math.abs(a.d8 ?? 0) - Math.abs(b.d8 ?? 0) ||
    a.ticker.localeCompare(b.ticker) ||
    a.direction.localeCompare(b.direction);
}

export function buildSwingLongCandidates(
  fillMode: FillMode,
  startingCapital: number,
  maxPerTicker: number,
  dims: OptionNativeSweepDimensions,
): SimConfig[] {
  const candidates: SimConfig[] = [];
  for (const preset of dims.presets ?? ['pb8']) {
    for (const dteRange of dims.dteRanges ?? [[35, 50]]) {
      for (const deltaRange of dims.deltaRanges ?? [[0.70, 0.80]]) {
        for (const profitTarget of dims.profitTargets ?? [0.25]) {
          for (const maxHoldDays of dims.maxHoldDays ?? [10]) {
            for (const exitEMA of dims.exitEMAs ?? [21]) {
              for (const confirmDays of dims.exitConfirmDays ?? [2]) {
                for (const requireSlope of dims.exitRequireSlope ?? [true]) {
                  for (const maxIVRank of dims.maxIVRanks ?? [55]) {
                    for (const maxRecentGapPct of dims.maxRecentGapPcts ?? [5]) {
                      for (const maxFrontBackIVAnomaly of dims.maxFrontBackIVAnomalies ?? [1.25]) {
                        for (const maxSpreadPct of dims.maxSpreadPcts ?? [0.06]) {
                          for (const minOI of dims.minOIs ?? [100]) {
                            for (const riskBudgetPct of dims.riskBudgetPcts ?? [0.005]) {
                              for (const maxPortfolioPremiumPct of dims.maxPortfolioPremiumPcts ?? [0.02]) {
                                for (const maxPositions of dims.maxPositions ?? [3]) {
                                  candidates.push({
                                    ...DEFAULT_SWING_LONG_OPTION_CONFIG,
                                    mode: 'SWING_LONG_OPTION',
                                    fillMode,
                                    slippage: fillMode === 'bidask'
                                      ? { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: true }
                                      : { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: false },
                                    signalWeightPreset: preset,
                                    swingLongDeltaRange: deltaRange,
                                    swingLongDTERange: dteRange,
                                    swingLongProfitTargetPct: profitTarget,
                                    swingLongMaxHoldDays: maxHoldDays,
                                    swingLongMinExitDTE: resolveSwingLongMinExitDTE(dteRange),
                                    swingLongMaxIVRank: maxIVRank,
                                    swingLongMaxRecentGapPct: maxRecentGapPct,
                                    swingLongMaxFrontBackIVAnomaly: maxFrontBackIVAnomaly,
                                    swingLongMaxBidAskSpreadPct: maxSpreadPct,
                                    swingLongMinOI: minOI,
                                    swingLongRiskBudgetPct: riskBudgetPct,
                                    swingLongMaxPortfolioPremiumPct: maxPortfolioPremiumPct,
                                    underlyingExitEMA: exitEMA,
                                    underlyingExitConfirmDays: confirmDays,
                                    underlyingExitRequireSlope: requireSlope,
                                    maxPositions,
                                    maxPerTicker,
                                    maxOpenRiskCapital: startingCapital * maxPortfolioPremiumPct,
                                  });
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return candidates;
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[idx];
}

function buildIndexedHistories(
  tickerDataMap: Map<string, TickerData>,
  periods: number[],
): Record<string, IndexedUnderlyingHistory> {
  return indexUnderlyingHistories(
    Object.fromEntries(
      [...tickerDataMap.entries()].map(([ticker, tickerData]) => [
        ticker,
        buildUnderlyingHistory(tickerData.candles, periods),
      ]),
    ),
  );
}

function buildSignalsByPreset(
  tickerDataMap: Map<string, TickerData>,
  config: OptionNativePipelineConfig,
): Map<SignalPresetKey, EntrySignal[]> {
  const signalsByPreset = new Map<SignalPresetKey, EntrySignal[]>();
  for (const preset of config.presets) {
    const signals: EntrySignal[] = [];
    for (const tickerData of tickerDataMap.values()) {
      signals.push(...generateSignalsForPreset(tickerData, preset, config.startDate, config.endDate));
    }
    for (const signal of signals) {
      signal.rankingScore = scoreOptionNativeSignalQuality(signal);
    }
    signals.sort(compareOptionNativeSignals);
    signalsByPreset.set(preset, signals);
  }
  return signalsByPreset;
}

function computeShadowPortfolioMetrics(
  trades: ShadowUnderlyingTrade[],
  allTradingDates: string[],
  startDate: string,
  endDate: string,
  startingCapital: number,
): { sharpe: number; maxDrawdownPct: number; equityCurve: { date: string; equity: number }[]; dailyReturns: number[] } {
  const dates = allTradingDates.filter(date => date >= startDate && date <= endDate);
  if (dates.length === 0) return { sharpe: 0, maxDrawdownPct: 0, equityCurve: [], dailyReturns: [] };
  const dateIdx = new Map(dates.map((date, index) => [date, index]));
  const dailyPnl = new Array<number>(dates.length).fill(0);

  for (const trade of trades) {
    let contributed = 0;
    let prevUnrealized = 0;
    for (const mark of trade.dailyMtM) {
      const idx = dateIdx.get(mark.date);
      const change = mark.unrealizedPnl - prevUnrealized;
      if (idx !== undefined) {
        dailyPnl[idx] += change;
        contributed += change;
      }
      prevUnrealized = mark.unrealizedPnl;
    }
    const residual = trade.pnl - contributed;
    const exitIdx = dateIdx.get(trade.exitDate);
    if (exitIdx !== undefined) dailyPnl[exitIdx] += residual;
  }

  const dailyReturns: number[] = [];
  const equityCurve: { date: string; equity: number }[] = [];
  let equity = startingCapital;
  let peak = startingCapital;
  let maxDD = 0;

  for (let index = 0; index < dates.length; index += 1) {
    const prevEquity = equity;
    equity += dailyPnl[index];
    const ret = prevEquity > 0 ? dailyPnl[index] / prevEquity : 0;
    dailyReturns.push(ret);
    peak = Math.max(peak, equity);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - equity) / peak);
    equityCurve.push({ date: dates[index], equity });
  }

  const avgReturn = dailyReturns.length > 0
    ? dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length
    : 0;
  const variance = dailyReturns.length > 1
    ? dailyReturns.reduce((sum, value) => sum + ((value - avgReturn) ** 2), 0) / (dailyReturns.length - 1)
    : 0;
  const std = Math.sqrt(variance);
  const sharpe = std > 1e-10 ? (avgReturn / std) * Math.sqrt(252) : 0;

  return {
    sharpe,
    maxDrawdownPct: maxDD * 100,
    equityCurve,
    dailyReturns,
  };
}

function compareConfiguredSignalItems(a: { signal: EntrySignal }, b: { signal: EntrySignal }): number {
  return compareOptionNativeSignals(a.signal, b.signal);
}

interface OpenOptionPosition {
  trade: OptionTrade;
  riskCapital: number;
}

interface OptionConstraintState {
  openPositions: OpenOptionPosition[];
  openCountByTicker: Map<string, number>;
  openRiskCapital: number;
}

function createConstraintState(): OptionConstraintState {
  return {
    openPositions: [],
    openCountByTicker: new Map(),
    openRiskCapital: 0,
  };
}

function retireClosedPositions(state: OptionConstraintState, signalDate: string): void {
  for (let index = state.openPositions.length - 1; index >= 0; index -= 1) {
    const open = state.openPositions[index];
    if (open.trade.exitDate <= signalDate) {
      state.openPositions.splice(index, 1);
      state.openRiskCapital = Math.max(0, state.openRiskCapital - open.riskCapital);
      const prev = state.openCountByTicker.get(open.trade.ticker) ?? 0;
      if (prev <= 1) state.openCountByTicker.delete(open.trade.ticker);
      else state.openCountByTicker.set(open.trade.ticker, prev - 1);
    }
  }
}

function addSkip(stats: OptionNativeExecutionDiagnostics, reason: string): void {
  stats.skippedByReason[reason] = (stats.skippedByReason[reason] ?? 0) + 1;
}

function createDiagnostics(): OptionNativeExecutionDiagnostics {
  return {
    totalConfiguredSignals: 0,
    acceptedTrades: 0,
    portfolioCapacitySkips: 0,
    portfolioPremiumCapSkips: 0,
    skippedByReason: {},
    entrySpreadPcts: [],
    entryOIs: [],
    totalDailyMarks: 0,
    syntheticMarks: 0,
    fillRate: 0,
    medianEntrySpreadPct: 0,
    p75EntrySpreadPct: 0,
    syntheticMarkPct: 0,
  };
}

function finalizeDiagnostics(stats: OptionNativeExecutionDiagnostics): OptionNativeExecutionDiagnostics {
  const accepted = stats.acceptedTrades;
  const liquidityRejects =
    (stats.skippedByReason.CHAIN_MISSING ?? 0) +
    (stats.skippedByReason.NO_CONTRACT ?? 0) +
    (stats.skippedByReason.LOW_PREMIUM ?? 0) +
    (stats.skippedByReason.LOW_OI ?? 0) +
    (stats.skippedByReason.WIDE_SPREAD ?? 0) +
    (stats.skippedByReason.NO_BUDGET ?? 0);
  const fillBase = accepted + liquidityRejects;
  return {
    ...stats,
    fillRate: fillBase > 0 ? accepted / fillBase : 0,
    medianEntrySpreadPct: percentile(stats.entrySpreadPcts, 50),
    p75EntrySpreadPct: percentile(stats.entrySpreadPcts, 75),
    syntheticMarkPct: stats.totalDailyMarks > 0 ? stats.syntheticMarks / stats.totalDailyMarks : 0,
  };
}

function executeConfiguredSignalsWithDiagnostics(
  configuredSignals: Array<{ signal: EntrySignal; config: SimConfig }>,
  baseExecutionConfig: PortfolioExecutionConfig,
  allTradingDates: string[],
  maxDate: string,
  indexedHistories: Record<string, IndexedUnderlyingHistory>,
  startingCapital: number,
  initialState: OptionConstraintState,
): { trades: OptionTrade[]; state: OptionConstraintState; diagnostics: OptionNativeExecutionDiagnostics } {
  const state: OptionConstraintState = {
    openPositions: [...initialState.openPositions],
    openCountByTicker: new Map(initialState.openCountByTicker),
    openRiskCapital: initialState.openRiskCapital,
  };
  const diagnostics = createDiagnostics();
  const trades: OptionTrade[] = [];

  for (const item of [...configuredSignals].sort(compareConfiguredSignalItems)) {
    diagnostics.totalConfiguredSignals += 1;
    retireClosedPositions(state, item.signal.date);
    const maxPositions = item.config.maxPositions ?? baseExecutionConfig.maxPositions;
    const maxPerTicker = item.config.maxPerTicker ?? baseExecutionConfig.maxPerTicker;
    if (state.openPositions.length >= maxPositions) {
      diagnostics.portfolioCapacitySkips += 1;
      continue;
    }
    const tickerOpenCount = state.openCountByTicker.get(item.signal.ticker) ?? 0;
    if (tickerOpenCount >= maxPerTicker) {
      diagnostics.portfolioCapacitySkips += 1;
      continue;
    }

    const evaluation: SwingLongEvaluation = simulateSwingLongOption(
      item.signal,
      item.config,
      allTradingDates,
      maxDate,
      getCachedChainMemo,
      indexedHistories,
      startingCapital,
    );
    if (!evaluation.trade) {
      if (evaluation.skipReason) addSkip(diagnostics, evaluation.skipReason);
      continue;
    }

    const riskCapital = evaluation.trade.entryPrice * 100 * Math.max(1, evaluation.trade.contracts ?? evaluation.trade.positionSize ?? 1);
    const maxOpenRiskCapital = item.config.maxOpenRiskCapital ?? baseExecutionConfig.maxOpenRiskCapital ?? baseExecutionConfig.startingCapital;
    if (state.openRiskCapital + riskCapital > maxOpenRiskCapital) {
      diagnostics.portfolioPremiumCapSkips += 1;
      continue;
    }

    diagnostics.acceptedTrades += 1;
    if (evaluation.entrySpreadPct != null) diagnostics.entrySpreadPcts.push(evaluation.entrySpreadPct);
    if (evaluation.entryOI != null) diagnostics.entryOIs.push(evaluation.entryOI);
    diagnostics.totalDailyMarks += evaluation.dailyMarks ?? 0;
    diagnostics.syntheticMarks += evaluation.syntheticDays ?? 0;

    trades.push(evaluation.trade);
    state.openPositions.push({ trade: evaluation.trade, riskCapital });
    state.openRiskCapital += riskCapital;
    state.openCountByTicker.set(item.signal.ticker, tickerOpenCount + 1);
  }

  return { trades, state, diagnostics: finalizeDiagnostics(diagnostics) };
}

function combineDiagnostics(chunks: OptionNativeExecutionDiagnostics[]): OptionNativeExecutionDiagnostics {
  const combined = createDiagnostics();
  for (const chunk of chunks) {
    combined.totalConfiguredSignals += chunk.totalConfiguredSignals;
    combined.acceptedTrades += chunk.acceptedTrades;
    combined.portfolioCapacitySkips += chunk.portfolioCapacitySkips;
    combined.portfolioPremiumCapSkips += chunk.portfolioPremiumCapSkips;
    combined.entrySpreadPcts.push(...chunk.entrySpreadPcts);
    combined.entryOIs.push(...chunk.entryOIs);
    combined.totalDailyMarks += chunk.totalDailyMarks;
    combined.syntheticMarks += chunk.syntheticMarks;
    for (const [reason, count] of Object.entries(chunk.skippedByReason)) {
      combined.skippedByReason[reason] = (combined.skippedByReason[reason] ?? 0) + count;
    }
  }
  return finalizeDiagnostics(combined);
}

function evaluateStage0Gate(
  result: OptionNativeResult,
): OptionNativeGateResult {
  const shadowPnl = result.shadowSummary.totalPnl;
  const dragRatio = shadowPnl > 0
    ? result.shadowSummary.costDrag / shadowPnl
    : null;
  const checks = [
    { name: 'Fill Rate', passed: result.diagnostics.fillRate >= 0.85, actual: result.diagnostics.fillRate, target: '>= 85%' },
    { name: 'Median Entry Spread', passed: result.diagnostics.medianEntrySpreadPct <= 0.05, actual: result.diagnostics.medianEntrySpreadPct, target: '<= 5%' },
    { name: 'P75 Entry Spread', passed: result.diagnostics.p75EntrySpreadPct <= 0.08, actual: result.diagnostics.p75EntrySpreadPct, target: '<= 8%' },
    { name: 'Synthetic Mark Rate', passed: result.diagnostics.syntheticMarkPct <= 0.05, actual: result.diagnostics.syntheticMarkPct, target: '<= 5%' },
    { name: 'OOS Total PnL', passed: result.oosTotalPnl > 0, actual: result.oosTotalPnl, target: '> 0' },
    { name: 'OOS Max DD', passed: result.oosMaxDD < 20, actual: result.oosMaxDD, target: '< 20%' },
    {
      name: 'Wrapper Cost Drag',
      passed: dragRatio == null ? result.shadowSummary.costDrag >= shadowPnl : dragRatio >= -0.25,
      actual: dragRatio == null ? result.shadowSummary.costDrag : dragRatio,
      target: '>= -25% of shadow PnL',
    },
  ];
  return { passed: checks.every(check => check.passed), checks };
}

function evaluateStage1Gate(
  result: OptionNativeResult,
): OptionNativeGateResult {
  const positiveWindows = result.windows.filter(window => window.oosTotalPnl > 0).length;
  const bucketNames = ['covid', 'bear', 'bull', 'mid'] as const;
  const bucketSharpes = bucketNames.map(bucket => {
    const bucketWindows = result.windows.filter(window => {
      if (bucket === 'covid') return [0, 1].includes(window.windowIndex);
      if (bucket === 'bear') return [3, 4].includes(window.windowIndex);
      if (bucket === 'bull') return [9, 10, 11].includes(window.windowIndex);
      return ![0, 1, 3, 4, 9, 10, 11].includes(window.windowIndex);
    });
    if (bucketWindows.length === 0) return 0;
    return bucketWindows.reduce((sum, window) => sum + window.oosSharpe, 0) / bucketWindows.length;
  });
  const tickerPnl = new Map<string, number>();
  for (const trade of result.allOOSTrades) {
    tickerPnl.set(trade.ticker, (tickerPnl.get(trade.ticker) ?? 0) + trade.pnl);
  }
  const totalAbsTickerPnl = [...tickerPnl.values()].reduce((sum, value) => sum + Math.abs(value), 0);
  const maxTickerContribution = totalAbsTickerPnl > 0
    ? Math.max(...[...tickerPnl.values()].map(value => Math.abs(value) / totalAbsTickerPnl))
    : 0;
  const checks = [
    { name: 'OOS Sharpe', passed: result.oosSharpe > 0.40, actual: result.oosSharpe, target: '> 0.40' },
    { name: 'OOS Total PnL', passed: result.oosTotalPnl > 0, actual: result.oosTotalPnl, target: '> 0' },
    { name: 'Positive Windows', passed: positiveWindows >= 7, actual: positiveWindows, target: '>= 7/12' },
    { name: 'Max Drawdown', passed: result.oosMaxDD < 20, actual: result.oosMaxDD, target: '< 20%' },
    { name: 'Regime Sharpe Floor', passed: Math.min(...bucketSharpes) > -0.75, actual: Math.min(...bucketSharpes), target: '> -0.75' },
    { name: 'Ticker Concentration', passed: maxTickerContribution <= 0.30, actual: maxTickerContribution, target: '<= 30%' },
    {
      name: 'Wrapper Sharpe Drag',
      passed: result.oosSharpe >= (result.shadowSummary.sharpe - 0.15),
      actual: result.oosSharpe - result.shadowSummary.sharpe,
      target: '>= -0.15 vs shadow',
    },
  ];
  return { passed: checks.every(check => check.passed), checks };
}

export function formatSwingLongConfigLabel(config: SimConfig): string {
  return [
    config.signalWeightPreset ?? 'pb8',
    `dte${formatSwingLongBand(config.swingLongDTERange)}`,
    `delta${Math.round((config.swingLongDeltaRange?.[0] ?? 0) * 100)}_${Math.round((config.swingLongDeltaRange?.[1] ?? 0) * 100)}`,
    `tp${Math.round((config.swingLongProfitTargetPct ?? 0) * 100)}`,
    `ema${config.underlyingExitEMA}`,
    `c${config.underlyingExitConfirmDays}`,
    `h${config.swingLongMaxHoldDays}`,
    `iv<=${config.swingLongMaxIVRank}`,
    `spr<=${Math.round((config.swingLongMaxBidAskSpreadPct ?? 0) * 100)}`,
    `mp${config.maxPositions}`,
  ].join('/');
}

export async function runOptionNativePipeline(
  config: OptionNativePipelineConfig,
): Promise<OptionNativeResult> {
  const startedAt = Date.now();
  initDB();
  chainMemo.clear();

  const tickerDataMap = new Map<string, TickerData>();
  for (const ticker of config.tickers) {
    tickerDataMap.set(ticker, await fetchTickerData(ticker, config.dataStart, config.endDate));
  }

  const allDates = new Set<string>();
  for (const tickerData of tickerDataMap.values()) {
    for (const candle of tickerData.candles) {
      if (candle.date >= config.startDate && candle.date <= config.endDate) {
        allDates.add(candle.date);
      }
    }
  }
  const allTradingDates = [...allDates].sort();
  const signalsByPreset = buildSignalsByPreset(tickerDataMap, config);

  const dims: OptionNativeSweepDimensions = {
    ...(config.stage === 'stage1' ? OPTION_NATIVE_STAGE1_DEFAULTS : OPTION_NATIVE_STAGE0_DEFAULTS),
    ...config.sweepOverrides,
  };
  const candidates = buildSwingLongCandidates(
    config.fillMode,
    config.startingCapital,
    config.maxPerTicker,
    dims,
  );

  const exitPeriods = [...new Set(candidates.map(candidate => candidate.underlyingExitEMA).filter((value): value is number => Number.isFinite(value) && value > 0))];
  const indexedHistories = buildIndexedHistories(tickerDataMap, exitPeriods);
  const windows = buildWFAWindows(allTradingDates, {
    trainWindowDays: config.trainWindowDays,
    forwardStepDays: config.forwardStepDays,
    purgeGapDays: config.purgeGapDays,
    mode: config.mode,
    startDate: config.startDate,
    endDate: config.endDate,
  });

  const maxPortfolioPremiumPct = Math.max(...(dims.maxPortfolioPremiumPcts ?? [0.02]));
  const maxPositions = Math.max(...(dims.maxPositions ?? [3]));
  const baseExecutionConfig: PortfolioExecutionConfig = {
    maxPositions,
    maxPerTicker: config.maxPerTicker,
    startingCapital: config.startingCapital,
    maxOpenRiskCapital: config.startingCapital * maxPortfolioPremiumPct,
  };

  const evaluator = (signal: EntrySignal, candidate: SimConfig, _allTradingDates: string[], maxDate: string): OptionTrade | null =>
    simulateSwingLongOption(signal, candidate, allTradingDates, maxDate, getCachedChainMemo, indexedHistories, config.startingCapital).trade;

  const state = createConstraintState();
  const windowResults: Array<WFAWindow & { oosTotalPnl: number; shadowTotalPnl: number }> = [];
  const allOOSTrades: OptionTrade[] = [];
  const diagnosticsChunks: OptionNativeExecutionDiagnostics[] = [];

  for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
    const window = windows[windowIndex];
    const optResult = optimizeWindow(
      candidates,
      signalsByPreset,
      allTradingDates,
      window.trainStart,
      window.trainEnd,
      evaluator,
      baseExecutionConfig,
      config.selectionGuard,
    );
    const selectedResults = selectConfigsForOOS(
      optResult.allResults,
      config.selectionGuard,
      'single',
      1,
    );
    const configuredSignals = buildConfiguredSignalsForWindow(
      selectedResults,
      signalsByPreset,
      window.oosStart,
      window.oosEnd,
      1,
    );
    const execution = executeConfiguredSignalsWithDiagnostics(
      configuredSignals,
      baseExecutionConfig,
      allTradingDates,
      config.endDate,
      indexedHistories,
      config.startingCapital,
      state,
    );

    state.openPositions = execution.state.openPositions;
    state.openCountByTicker = execution.state.openCountByTicker;
    state.openRiskCapital = execution.state.openRiskCapital;

    execution.trades.forEach(trade => { trade.windowIndex = windowIndex; });
    allOOSTrades.push(...execution.trades);
    diagnosticsChunks.push(execution.diagnostics);

    const windowShadowTrades = execution.trades.map(buildShadowUnderlyingTrade);
    const windowMetrics = computePortfolioDailyMetrics(
      allOOSTrades,
      allTradingDates,
      window.oosStart,
      window.oosEnd,
      config.startingCapital,
    );
    const windowAnalytics = computeOptionAnalytics(execution.trades);
    windowResults.push({
      windowIndex,
      trainStart: window.trainStart,
      trainEnd: window.trainEnd,
      oosStart: window.oosStart,
      oosEnd: window.oosEnd,
      bestConfig: selectedResults[0]?.config ?? optResult.bestConfig,
      selectedConfigs: selectedResults.map(result => result.config),
      bestTrainSharpe: selectedResults[0]?.sharpe ?? optResult.bestSharpe,
      oosTrades: execution.trades,
      oosSharpe: windowMetrics.sharpe,
      oosWinRate: windowAnalytics.winRate,
      oosMaxDD: windowMetrics.maxDrawdownPct,
      oosTotalPnl: execution.trades.reduce((sum, trade) => sum + trade.pnl, 0),
      shadowTotalPnl: windowShadowTrades.reduce((sum, trade) => sum + trade.pnl, 0),
    });
  }

  const oosMetrics = computePortfolioDailyMetrics(
    allOOSTrades,
    allTradingDates,
    config.startDate,
    config.endDate,
    config.startingCapital,
  );
  const oosAnalytics = computeOptionAnalytics(allOOSTrades);
  const shadowTrades = allOOSTrades.map(buildShadowUnderlyingTrade);
  const shadowMetrics = computeShadowPortfolioMetrics(
    shadowTrades,
    allTradingDates,
    config.startDate,
    config.endDate,
    config.startingCapital,
  );
  const shadowPnl = shadowTrades.reduce((sum, trade) => sum + trade.pnl, 0);
  const shadowByTicker: OptionNativeShadowSummary['byTicker'] = {};
  const shadowByDteBand: OptionNativeShadowSummary['byDteBand'] = {};
  for (let index = 0; index < allOOSTrades.length; index += 1) {
    const optionTrade = allOOSTrades[index];
    const shadowTrade = shadowTrades[index];
    shadowByTicker[optionTrade.ticker] ??= { optionPnl: 0, shadowPnl: 0, costDrag: 0 };
    shadowByTicker[optionTrade.ticker].optionPnl += optionTrade.pnl;
    shadowByTicker[optionTrade.ticker].shadowPnl += shadowTrade.pnl;
    shadowByTicker[optionTrade.ticker].costDrag += optionTrade.pnl - shadowTrade.pnl;

    const band = formatSwingLongBand(optionTrade.entryDTE <= 50 ? [35, 50] : [50, 70]);
    shadowByDteBand[band] ??= { optionPnl: 0, shadowPnl: 0, costDrag: 0 };
    shadowByDteBand[band].optionPnl += optionTrade.pnl;
    shadowByDteBand[band].shadowPnl += shadowTrade.pnl;
    shadowByDteBand[band].costDrag += optionTrade.pnl - shadowTrade.pnl;
  }

  const diagnostics = combineDiagnostics(diagnosticsChunks);
  const shadowSummary: OptionNativeShadowSummary = {
    totalPnl: shadowPnl,
    sharpe: shadowMetrics.sharpe,
    maxDD: shadowMetrics.maxDrawdownPct,
    avgCostDragPerTrade: allOOSTrades.length > 0 ? (oosAnalytics.totalPnl - shadowPnl) / allOOSTrades.length : 0,
    costDrag: oosAnalytics.totalPnl - shadowPnl,
    costDragPctOfShadow: shadowPnl !== 0 ? (oosAnalytics.totalPnl - shadowPnl) / shadowPnl : null,
    byTicker: shadowByTicker,
    byDteBand: shadowByDteBand,
  };

  const avgTrainSharpe = windowResults.length > 0
    ? windowResults.reduce((sum, window) => sum + window.bestTrainSharpe, 0) / windowResults.length
    : 0;

  const result: OptionNativeResult = {
    config,
    candidates,
    allTradingDates,
    windows: windowResults,
    allOOSTrades,
    shadowTrades,
    diagnostics,
    shadowSummary,
    gate: { passed: false, checks: [] },
    oosEquityCurve: oosMetrics.equityCurve,
    shadowEquityCurve: shadowMetrics.equityCurve,
    oosSharpe: oosMetrics.sharpe,
    oosWinRate: oosAnalytics.winRate,
    oosMaxDD: oosMetrics.maxDrawdownPct,
    oosTotalPnl: oosAnalytics.totalPnl,
    wfEfficiency: avgTrainSharpe >= 0.1 ? oosMetrics.sharpe / avgTrainSharpe : 0,
    elapsedMs: Date.now() - startedAt,
  };
  result.gate = config.stage === 'stage1'
    ? evaluateStage1Gate(result)
    : evaluateStage0Gate(result);
  return result;
}

export function closeOptionNativePipelineDB(): void {
  closeDB();
}
