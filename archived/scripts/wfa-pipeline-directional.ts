import path from 'path';
import { fileURLToPath } from 'url';

import {
  findContractDirect,
  findDebitSpreadStrikes,
  getCachedChain,
  initDB,
  closeDB,
  type DebitSpreadMatch,
  type StrikeMatch,
} from '../src/lib/backtest/chain-cache';
import {
  DEFAULT_DEBIT_CONFIG,
  computeOptionAnalytics,
  type EntrySignal,
  type OptionExitType,
  type OptionTrade,
  type SignalPresetKey,
  type SimConfig,
} from '../src/lib/backtest/option-sim';
import {
  applyDebitSpreadFill,
  buildDebitSpreadTrade,
  clampDebitSpreadValue,
  computeDebitSpreadThresholds,
  computeIntrinsicDebitSpreadValue,
  resolveTriggeredDebitExitValue,
} from '../src/lib/backtest/debit-spread-exit';
import {
  createMissingChainState,
  resolveCreditSpreadCommissions,
  shouldExitNoChain,
  updateMissingChainState,
} from '../src/lib/backtest/credit-spread-exit';
import type { FillMode } from '../src/lib/backtest/types';
import { DEFAULT_DYNAMIC_SLIPPAGE } from '../src/lib/backtest/types';
import { syntheticRepriceLeg } from '../src/lib/backtest/synthetic-reprice';
import type { RepricingMethod } from '../src/lib/backtest/synthetic-reprice';
import {
  buildUnderlyingHistory,
  indexUnderlyingHistories,
  shouldExitUnderlyingTrend,
  type SerializedUnderlyingHistory,
} from '../src/lib/backtest/underlying-stop';
import {
  computeUnderlyingAnalytics,
  computeUnderlyingPortfolioDailyMetrics,
  simulateUnderlyingTrade,
  type UnderlyingSimConfig,
  type UnderlyingTrade,
} from '../src/lib/backtest/underlying-sim';
import { fetchTickerData, generateSignalsForPreset, type TickerData } from '../src/lib/backtest/signal-data';
import {
  buildWFAWindows,
  computePortfolioDailyMetrics,
  runWFAOptions,
  type PortfolioExecutionConfig,
  type TradeEvaluator,
  type WFAOptionsConfig,
  type WFAResult,
} from '../src/lib/backtest/wfa-options';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface DirectionalPipelineConfig {
  strategy: 'underlying' | 'debit';
  tickers: string[];
  startDate: string;
  endDate: string;
  dataStart: string;
  trainWindowDays: number;
  forwardStepDays: number;
  purgeGapDays: number;
  mode: 'rolling' | 'anchored';
  maxPositions: number;
  maxPerTicker: number;
  startingCapital: number;
  fixedNotional: number;
  fillMode: FillMode;
  presets: SignalPresetKey[];
  sweepOverrides?: Partial<DirectionalSweepDimensions>;
  swingCreditBaselineMaxDDPct?: number;
}

export interface DirectionalSweepDimensions {
  presets?: SignalPresetKey[];
  underlyingSignalBundles?: SignalPresetKey[][];
  underlyingPb21RouterModes?: string[];
  underlyingExitEMAs?: number[];
  underlyingExitConfirmDays?: number[];
  underlyingExitRequireSlope?: boolean[];
  underlyingMaxHoldDays?: number[];
  underlyingMinDirConfidences?: number[];
  underlyingMaxEntryD8s?: number[];
  underlyingMaxRecentGapPcts?: number[];
  underlyingMinEntryVrpPcts?: number[];
  underlyingMaxEntryContangoPcts?: number[];
  underlyingPb21RankingBonuses?: number[];
  underlyingMaxPositions?: Array<number | undefined>;
  underlyingProfitTargetPcts?: Array<number | undefined>;
  debitDTERanges?: Array<[number, number]>;
  debitLongDeltas?: number[];
  debitShortDeltas?: number[];
  debitProfitTargets?: number[];
  debitExitEMAs?: number[];
  debitExitConfirmDays?: number[];
  debitExitRequireSlope?: boolean[];
  debitMaxHoldDays?: number[];
  debitMinExitDTEs?: number[];
  debitMaxIVRanks?: Array<number | undefined>;
}

export interface DirectionalGateResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; actual: number | string; target: string }>;
}

export interface UnderlyingWFAWindow {
  windowIndex: number;
  trainStart: string;
  trainEnd: string;
  oosStart: string;
  oosEnd: string;
  bestConfig: UnderlyingSimConfig;
  bestTrainSharpe: number;
  oosTrades: UnderlyingTrade[];
  oosSharpe: number;
  oosWinRate: number;
  oosMaxDD: number;
  oosTotalPnl: number;
}

export interface UnderlyingWFAResult {
  config: DirectionalPipelineConfig;
  windows: UnderlyingWFAWindow[];
  allOOSTrades: UnderlyingTrade[];
  oosEquityCurve: { date: string; equity: number }[];
  oosSharpe: number;
  oosWinRate: number;
  oosMaxDD: number;
  oosTotalPnl: number;
  wfEfficiency: number;
  elapsedMs: number;
}

export interface DirectionalPipelineSection<TTrade, TResult> {
  candidates: Array<UnderlyingSimConfig | SimConfig>;
  gate: DirectionalGateResult;
  wfa: TResult;
}

export interface DirectionalPipelineResult {
  config: DirectionalPipelineConfig;
  allTradingDates: string[];
  underlying?: DirectionalPipelineSection<UnderlyingTrade, UnderlyingWFAResult>;
  debit?: DirectionalPipelineSection<OptionTrade, WFAResult>;
}

export const DIRECTIONAL_DEFAULTS: DirectionalPipelineConfig = {
  strategy: 'underlying',
  tickers: ['SPY', 'QQQ', 'IWM'],
  dataStart: '2017-01-01',
  startDate: '2018-01-01',
  endDate: '2026-02-28',
  trainWindowDays: 504,
  forwardStepDays: 126,
  purgeGapDays: 65,
  mode: 'rolling',
  maxPositions: 3,
  maxPerTicker: 1,
  startingCapital: 100_000,
  fixedNotional: 10_000,
  fillMode: 'bidask',
  presets: ['pb'],
  swingCreditBaselineMaxDDPct: 26,
};

export const DIRECTIONAL_SWEEP_DEFAULTS: DirectionalSweepDimensions = {
  presets: ['pb'],
  underlyingSignalBundles: undefined,
  underlyingPb21RouterModes: ['off'],
  underlyingExitEMAs: [21, 34],
  underlyingExitConfirmDays: [1, 2],
  underlyingExitRequireSlope: [true],
  underlyingMaxHoldDays: [15, 20, 25],
  underlyingMinDirConfidences: [0],
  underlyingMaxEntryD8s: [Infinity],
  underlyingMaxRecentGapPcts: [Infinity],
  underlyingMinEntryVrpPcts: [0],
  underlyingMaxEntryContangoPcts: [Infinity],
  underlyingPb21RankingBonuses: [0],
  underlyingMaxPositions: [undefined],
  underlyingProfitTargetPcts: [undefined],
  debitDTERanges: [[30, 45], [60, 75]],
  debitLongDeltas: [0.5, 0.6],
  debitShortDeltas: [0.2, 0.3],
  debitProfitTargets: [0.5, 0.75],
  debitExitEMAs: [21, 34],
  debitExitConfirmDays: [1, 2],
  debitExitRequireSlope: [true],
  debitMaxHoldDays: [15, 20],
  debitMinExitDTEs: [14],
  debitMaxIVRanks: [undefined],
};

const MAX_CACHE = 200;
const chainMemo = new Map<string, ReturnType<typeof getCachedChain>>();
let dateIndex: Map<string, number> | null = null;

function getCachedChainMemo(ticker: string, date: string): ReturnType<typeof getCachedChain> {
  const key = `${ticker}|${date}`;
  const cached = chainMemo.get(key);
  if (cached !== undefined) {
    chainMemo.delete(key);
    chainMemo.set(key, cached);
    return cached;
  }

  const rows = getCachedChain(ticker, date);
  if (chainMemo.size >= MAX_CACHE) {
    const oldest = chainMemo.keys().next().value;
    if (oldest) chainMemo.delete(oldest);
  }
  chainMemo.set(key, rows);
  return rows;
}

function buildDateIndex(allDates: string[]): void {
  dateIndex = new Map(allDates.map((date, index) => [date, index]));
}

function advanceTradingDays(allDates: string[], fromDate: string, n: number): string | null {
  const idx = dateIndex?.get(fromDate) ?? -1;
  if (idx < 0) {
    const nextIdx = allDates.findIndex(date => date > fromDate);
    if (nextIdx < 0) return null;
    return allDates[Math.min(nextIdx + n - 1, allDates.length - 1)] ?? null;
  }
  const targetIdx = idx + n;
  return targetIdx < allDates.length ? allDates[targetIdx] : null;
}

function getMonitoringDates(
  allDates: string[],
  entryDate: string,
  intervalDays: number,
  maxDate: string,
): string[] {
  const dates: string[] = [];
  let current = entryDate;
  while (true) {
    const next = advanceTradingDays(allDates, current, intervalDays);
    if (!next || next > maxDate) break;
    dates.push(next);
    current = next;
  }
  return dates;
}

function resolveUnderlyingSignalPresets(config: UnderlyingSimConfig): SignalPresetKey[] {
  if (config.signalSourcePresets && config.signalSourcePresets.length > 0) {
    return config.signalSourcePresets;
  }
  return [config.signalWeightPreset ?? 'pb'];
}

export function resolveUnderlyingSignalSourceLabel(config: UnderlyingSimConfig): string {
  if (config.signalSourceLabel) return config.signalSourceLabel;
  return resolveUnderlyingSignalPresets(config).join('+');
}

function isRoutedPb8Pb21Bundle(
  config: Pick<UnderlyingSimConfig, 'signalSourcePresets' | 'signalWeightPreset'>,
): boolean {
  const presets = config.signalSourcePresets && config.signalSourcePresets.length > 0
    ? config.signalSourcePresets
    : [config.signalWeightPreset ?? 'pb'];
  return presets.length === 2 && presets.includes('pb8') && presets.includes('pb21');
}

function evaluatePb21RouterMode(mode: string | undefined, signal: EntrySignal | undefined): boolean {
  if (!mode || mode === 'off' || !signal) return false;
  if (mode === 'contangoPct_lte_50') return (signal.contangoPct ?? Number.POSITIVE_INFINITY) <= 50;
  if (mode === 'contangoPct_lte_60') return (signal.contangoPct ?? Number.POSITIVE_INFINITY) <= 60;
  if (mode === 'vrpPct_gte_50') return (signal.vrpPct ?? Number.NEGATIVE_INFINITY) >= 50;
  if (mode === 'vrpPct_gte_60') return (signal.vrpPct ?? Number.NEGATIVE_INFINITY) >= 60;
  return false;
}

export function scoreDirectionalSignalQuality(signal: EntrySignal, config?: Pick<UnderlyingSimConfig, 'pb21RankingBonus'>): number {
  const score = signal.score ?? 0;
  const dirConfidence = signal.dirConfidence ?? 0;
  const d8Penalty = signal.d8 != null ? Math.min(20, Math.abs(signal.d8) * 2) : 5;
  const presetBonus = signal.sourcePreset === 'pb21' ? (config?.pb21RankingBonus ?? 0) : 0;
  return score * 10 + dirConfidence - d8Penalty + presetBonus;
}

export function compareDirectionalSignals(
  a: EntrySignal,
  b: EntrySignal,
  config?: Pick<UnderlyingSimConfig, 'pb21RankingBonus'>,
): number {
  const qualityDelta = scoreDirectionalSignalQuality(b, config) - scoreDirectionalSignalQuality(a, config);
  return a.date.localeCompare(b.date) ||
    qualityDelta ||
    (b.score ?? 0) - (a.score ?? 0) ||
    (b.dirConfidence ?? 0) - (a.dirConfidence ?? 0) ||
    Math.abs(a.d8 ?? 0) - Math.abs(b.d8 ?? 0) ||
    a.ticker.localeCompare(b.ticker) ||
    a.direction.localeCompare(b.direction);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function buildUnderlyingCandidates(dims: DirectionalSweepDimensions): UnderlyingSimConfig[] {
  const candidates: UnderlyingSimConfig[] = [];
  const bundles = dims.underlyingSignalBundles && dims.underlyingSignalBundles.length > 0
    ? dims.underlyingSignalBundles
    : (dims.presets ?? ['pb']).map(preset => [preset]);
  for (const bundle of bundles) {
    const signalSourceLabel = bundle.join('+');
    const signalWeightPreset = bundle[0] ?? 'pb';
    const routerModes = isRoutedPb8Pb21Bundle({ signalSourcePresets: bundle })
      ? (dims.underlyingPb21RouterModes ?? ['off'])
      : ['off'];
    for (const ema of dims.underlyingExitEMAs ?? [21]) {
      for (const confirmDays of dims.underlyingExitConfirmDays ?? [2]) {
        for (const requireSlope of dims.underlyingExitRequireSlope ?? [true]) {
          for (const maxHoldDays of dims.underlyingMaxHoldDays ?? [20]) {
            for (const minDirConfidence of dims.underlyingMinDirConfidences ?? [0]) {
              for (const maxEntryD8 of dims.underlyingMaxEntryD8s ?? [Infinity]) {
                for (const maxRecentGapPct of dims.underlyingMaxRecentGapPcts ?? [Infinity]) {
                  for (const minEntryVrpPct of dims.underlyingMinEntryVrpPcts ?? [0]) {
                    for (const maxEntryContangoPct of dims.underlyingMaxEntryContangoPcts ?? [Infinity]) {
                      for (const routerMode of routerModes) {
                        const rankingBonuses = routerMode === 'off'
                          ? (dims.underlyingPb21RankingBonuses ?? [0])
                          : [0];
                        for (const pb21RankingBonus of rankingBonuses) {
                          for (const maxPositions of dims.underlyingMaxPositions ?? [undefined]) {
                            for (const profitTargetPct of dims.underlyingProfitTargetPcts ?? [undefined]) {
                              candidates.push({
                                signalWeightPreset,
                                signalSourcePresets: bundle,
                                signalSourceLabel,
                                pb21RouterMode: routerMode,
                                underlyingExitEMA: ema,
                                underlyingExitConfirmDays: confirmDays,
                                underlyingExitRequireSlope: requireSlope,
                                maxHoldDays,
                                minDirConfidence,
                                maxEntryD8,
                                maxRecentGapPct,
                                minEntryVrpPct,
                                maxEntryContangoPct,
                                pb21RankingBonus,
                                ...(Number.isFinite(maxPositions) ? { maxPositions } : {}),
                                ...(profitTargetPct != null && Number.isFinite(profitTargetPct) ? { profitTargetPct } : {}),
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
  return candidates;
}

export function buildDebitCandidates(fillMode: FillMode, dims: DirectionalSweepDimensions): SimConfig[] {
  const candidates: SimConfig[] = [];
  const presets = dims.presets ?? ['pb'];
  for (const preset of presets) {
    for (const dteRange of dims.debitDTERanges ?? [[30, 45]]) {
      for (const longDelta of dims.debitLongDeltas ?? [0.5]) {
        for (const shortDelta of dims.debitShortDeltas ?? [0.2]) {
          for (const profitTarget of dims.debitProfitTargets ?? [0.5]) {
            for (const exitEMA of dims.debitExitEMAs ?? [21]) {
              for (const confirmDays of dims.debitExitConfirmDays ?? [2]) {
                for (const requireSlope of dims.debitExitRequireSlope ?? [true]) {
                  for (const maxHoldDays of dims.debitMaxHoldDays ?? [20]) {
                    for (const minExitDTE of dims.debitMinExitDTEs ?? [14]) {
                      for (const maxIVRank of dims.debitMaxIVRanks ?? [undefined]) {
                        candidates.push({
                          ...DEFAULT_DEBIT_CONFIG,
                          mode: 'DEBIT_SPREAD',
                          fillMode,
                          slippage: fillMode === 'bidask'
                            ? { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: true }
                            : { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: false },
                          signalWeightPreset: preset,
                          debitDTERange: dteRange,
                          debitLongDelta: longDelta,
                          debitShortDelta: shortDelta,
                          debitProfitTargetPct: profitTarget,
                          debitMaxHoldDays: maxHoldDays,
                          debitMinExitDTE: minExitDTE,
                          underlyingExitEMA: exitEMA,
                          underlyingExitConfirmDays: confirmDays,
                          underlyingExitRequireSlope: requireSlope,
                          ...(maxIVRank != null ? { maxIVRank } : {}),
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
  return candidates;
}

interface UnderlyingOpenPosition {
  trade: UnderlyingTrade;
  notional: number;
}

interface UnderlyingConstraintState {
  openPositions: UnderlyingOpenPosition[];
  openCountByTicker: Map<string, number>;
  openNotional: number;
}

function createUnderlyingConstraintState(): UnderlyingConstraintState {
  return {
    openPositions: [],
    openCountByTicker: new Map(),
    openNotional: 0,
  };
}

function cloneUnderlyingConstraintState(state: UnderlyingConstraintState): UnderlyingConstraintState {
  return {
    openPositions: [...state.openPositions],
    openCountByTicker: new Map(state.openCountByTicker),
    openNotional: state.openNotional,
  };
}

function retireClosedUnderlyingPositions(state: UnderlyingConstraintState, signalDate: string): void {
  for (let index = state.openPositions.length - 1; index >= 0; index -= 1) {
    const open = state.openPositions[index];
    if (open.trade.exitDate <= signalDate) {
      state.openPositions.splice(index, 1);
      state.openNotional = Math.max(0, state.openNotional - open.notional);
      const prev = state.openCountByTicker.get(open.trade.ticker) ?? 0;
      if (prev <= 1) state.openCountByTicker.delete(open.trade.ticker);
      else state.openCountByTicker.set(open.trade.ticker, prev - 1);
    }
  }
}

function evaluateUnderlyingSignalsWithState(
  signals: EntrySignal[],
  simConfig: UnderlyingSimConfig,
  executionConfig: { maxPositions: number; maxPerTicker: number; startingCapital: number; fixedNotional: number },
  tickerDataMap: Map<string, TickerData>,
  indexedHistories: Record<string, ReturnType<typeof indexUnderlyingHistories>[string]>,
  maxDate: string,
  initialState?: UnderlyingConstraintState,
): { trades: UnderlyingTrade[]; state: UnderlyingConstraintState } {
  const sortedSignals = [...signals].sort((a, b) => compareDirectionalSignals(a, b, simConfig));
  const state = initialState ? cloneUnderlyingConstraintState(initialState) : createUnderlyingConstraintState();
  const trades: UnderlyingTrade[] = [];
  const maxPositions = simConfig.maxPositions ?? executionConfig.maxPositions;

  for (const signal of sortedSignals) {
    retireClosedUnderlyingPositions(state, signal.date);
    if (state.openPositions.length >= maxPositions) continue;
    const tickerOpenCount = state.openCountByTicker.get(signal.ticker) ?? 0;
    if (tickerOpenCount >= executionConfig.maxPerTicker) continue;
    if (state.openNotional + executionConfig.fixedNotional > executionConfig.startingCapital) continue;
    if ((simConfig.minDirConfidence ?? 0) > 0 && (signal.dirConfidence ?? 0) < (simConfig.minDirConfidence ?? 0)) continue;
    if (
      simConfig.maxEntryD8 != null &&
      Number.isFinite(simConfig.maxEntryD8) &&
      signal.d8 != null &&
      Math.abs(signal.d8) > simConfig.maxEntryD8
    ) continue;
    if (
      simConfig.maxRecentGapPct != null &&
      Number.isFinite(simConfig.maxRecentGapPct) &&
      signal.recentMaxGapPct != null &&
      signal.recentMaxGapPct > simConfig.maxRecentGapPct
    ) continue;
    if (
      (simConfig.minEntryVrpPct ?? 0) > 0 &&
      (signal.vrpPct == null || signal.vrpPct < (simConfig.minEntryVrpPct ?? 0))
    ) continue;
    if (
      simConfig.maxEntryContangoPct != null &&
      Number.isFinite(simConfig.maxEntryContangoPct) &&
      signal.contangoPct != null &&
      signal.contangoPct > simConfig.maxEntryContangoPct
    ) continue;

    const tickerData = tickerDataMap.get(signal.ticker);
    const history = indexedHistories[signal.ticker];
    if (!tickerData || !history) continue;
    const trade = simulateUnderlyingTrade(
      signal,
      tickerData.candles,
      history,
      simConfig,
      maxDate,
      executionConfig.fixedNotional,
    );
    if (!trade) continue;
    trade.signalWeightPreset = simConfig.signalWeightPreset;
    trades.push(trade);
    state.openPositions.push({ trade, notional: executionConfig.fixedNotional });
    state.openNotional += executionConfig.fixedNotional;
    state.openCountByTicker.set(signal.ticker, tickerOpenCount + 1);
  }

  return { trades, state };
}

function optimizeUnderlyingWindow(
  candidates: UnderlyingSimConfig[],
  signalsByPreset: Map<SignalPresetKey, EntrySignal[]>,
  tickerDataMap: Map<string, TickerData>,
  indexedHistories: Record<string, ReturnType<typeof indexUnderlyingHistories>[string]>,
  executionConfig: { maxPositions: number; maxPerTicker: number; startingCapital: number; fixedNotional: number },
  allTradingDates: string[],
  trainStart: string,
  trainEnd: string,
): { bestConfig: UnderlyingSimConfig; bestSharpe: number; allResults: Array<{ config: UnderlyingSimConfig; sharpe: number; trades: number }> } {
  const results: Array<{ config: UnderlyingSimConfig; sharpe: number; trades: number }> = [];

  for (const candidate of candidates) {
    const presetSignals = collectUnderlyingSignalsForConfig(candidate, signalsByPreset);
    const trainSignals = presetSignals.filter(signal => signal.date >= trainStart && signal.date <= trainEnd);
    const trades = evaluateUnderlyingSignalsWithState(
      trainSignals,
      candidate,
      executionConfig,
      tickerDataMap,
      indexedHistories,
      trainEnd,
    ).trades;
    const metrics = computeUnderlyingPortfolioDailyMetrics(
      trades,
      allTradingDates,
      trainStart,
      trainEnd,
      executionConfig.startingCapital,
    );
    results.push({ config: candidate, sharpe: metrics.sharpe, trades: trades.length });
  }

  results.sort((a, b) => b.sharpe - a.sharpe || b.trades - a.trades);
  return {
    bestConfig: results[0]?.config ?? candidates[0],
    bestSharpe: results[0]?.sharpe ?? 0,
    allResults: results,
  };
}

function collectUnderlyingSignalsForConfig(
  config: UnderlyingSimConfig,
  signalsByPreset: Map<SignalPresetKey, EntrySignal[]>,
): EntrySignal[] {
  const presets = resolveUnderlyingSignalPresets(config);
  if (isRoutedPb8Pb21Bundle(config) && (config.pb21RouterMode ?? 'off') !== 'off') {
    const pb8Signals = signalsByPreset.get('pb8') ?? [];
    const pb21Signals = signalsByPreset.get('pb21') ?? [];
    const grouped = new Map<string, { pb8?: EntrySignal; pb21?: EntrySignal }>();

    for (const signal of pb8Signals) {
      const key = `${signal.ticker}|${signal.date}|${signal.direction}`;
      const current = grouped.get(key) ?? {};
      current.pb8 = signal;
      grouped.set(key, current);
    }
    for (const signal of pb21Signals) {
      const key = `${signal.ticker}|${signal.date}|${signal.direction}`;
      const current = grouped.get(key) ?? {};
      current.pb21 = signal;
      grouped.set(key, current);
    }

    const selected: EntrySignal[] = [];
    for (const pair of grouped.values()) {
      const routerAnchor = pair.pb21 ?? pair.pb8;
      const preferPb21 = evaluatePb21RouterMode(config.pb21RouterMode, routerAnchor);
      const preferred = preferPb21 ? pair.pb21 ?? pair.pb8 : pair.pb8 ?? pair.pb21;
      if (preferred) selected.push(preferred);
    }
    return selected.sort((a, b) => compareDirectionalSignals(a, b, config));
  }

  const deduped = new Map<string, EntrySignal>();

  for (const preset of presets) {
    const signals = signalsByPreset.get(preset) ?? [];
    for (const signal of signals) {
      const key = `${signal.ticker}|${signal.date}|${signal.direction}`;
      const current = deduped.get(key);
      if (!current || compareDirectionalSignals(signal, current, config) < 0) {
        deduped.set(key, signal);
      }
    }
  }

  return [...deduped.values()].sort((a, b) => compareDirectionalSignals(a, b, config));
}

function runUnderlyingWFA(
  config: DirectionalPipelineConfig,
  tickerDataMap: Map<string, TickerData>,
  signalsByPreset: Map<SignalPresetKey, EntrySignal[]>,
  allTradingDates: string[],
  candidates: UnderlyingSimConfig[],
): UnderlyingWFAResult {
  const startedAt = Date.now();
  const windows = buildWFAWindows(allTradingDates, {
    trainWindowDays: config.trainWindowDays,
    forwardStepDays: config.forwardStepDays,
    purgeGapDays: config.purgeGapDays,
    mode: config.mode,
    startDate: config.startDate,
    endDate: config.endDate,
  });
  const stopPeriods = [...new Set(candidates.map(candidate => candidate.underlyingExitEMA))];
  const indexedHistories = indexUnderlyingHistories(
    Object.fromEntries(
      [...tickerDataMap.entries()].map(([ticker, tickerData]) => [
        ticker,
        buildUnderlyingHistory(tickerData.candles, stopPeriods),
      ]),
    ),
  );
  const executionConfig = {
    maxPositions: config.maxPositions,
    maxPerTicker: config.maxPerTicker,
    startingCapital: config.startingCapital,
    fixedNotional: config.fixedNotional,
  };

  const allOOSTrades: UnderlyingTrade[] = [];
  const wfaWindows: UnderlyingWFAWindow[] = [];
  const state = createUnderlyingConstraintState();

  for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
    const window = windows[windowIndex];
    const optResult = optimizeUnderlyingWindow(
      candidates,
      signalsByPreset,
      tickerDataMap,
      indexedHistories,
      executionConfig,
      allTradingDates,
      window.trainStart,
      window.trainEnd,
    );
    const oosSignals = collectUnderlyingSignalsForConfig(optResult.bestConfig, signalsByPreset)
      .filter(signal => signal.date >= window.oosStart && signal.date <= window.oosEnd);
    const execution = evaluateUnderlyingSignalsWithState(
      oosSignals,
      optResult.bestConfig,
      executionConfig,
      tickerDataMap,
      indexedHistories,
      config.endDate,
      state,
    );
    state.openPositions = execution.state.openPositions;
    state.openCountByTicker = execution.state.openCountByTicker;
    state.openNotional = execution.state.openNotional;

    execution.trades.forEach(trade => { trade.windowIndex = windowIndex; });
    allOOSTrades.push(...execution.trades);
    const analytics = computeUnderlyingAnalytics(execution.trades);
    const metrics = computeUnderlyingPortfolioDailyMetrics(
      allOOSTrades,
      allTradingDates,
      window.oosStart,
      window.oosEnd,
      config.startingCapital,
    );

    wfaWindows.push({
      windowIndex,
      trainStart: window.trainStart,
      trainEnd: window.trainEnd,
      oosStart: window.oosStart,
      oosEnd: window.oosEnd,
      bestConfig: optResult.bestConfig,
      bestTrainSharpe: optResult.bestSharpe,
      oosTrades: execution.trades,
      oosSharpe: metrics.sharpe,
      oosWinRate: analytics.winRate,
      oosMaxDD: metrics.maxDrawdownPct,
      oosTotalPnl: analytics.totalPnl,
    });
  }

  const allMetrics = computeUnderlyingPortfolioDailyMetrics(
    allOOSTrades,
    allTradingDates,
    config.startDate,
    config.endDate,
    config.startingCapital,
  );
  const allAnalytics = computeUnderlyingAnalytics(allOOSTrades);
  const avgTrainSharpe = wfaWindows.length > 0
    ? wfaWindows.reduce((sum, window) => sum + window.bestTrainSharpe, 0) / wfaWindows.length
    : 0;

  return {
    config,
    windows: wfaWindows,
    allOOSTrades,
    oosEquityCurve: allMetrics.equityCurve,
    oosSharpe: allMetrics.sharpe,
    oosWinRate: allAnalytics.winRate,
    oosMaxDD: allMetrics.maxDrawdownPct,
    oosTotalPnl: allAnalytics.totalPnl,
    wfEfficiency: avgTrainSharpe >= 0.1 ? allMetrics.sharpe / avgTrainSharpe : 0,
    elapsedMs: Date.now() - startedAt,
  };
}

function makeCachedDebitEvaluator(
  fillMode: FillMode,
  underlyingHistoryData: Record<string, SerializedUnderlyingHistory>,
): TradeEvaluator {
  const indexedHistories = indexUnderlyingHistories(underlyingHistoryData);
  return (signal, config, allTradingDates, maxDate) => {
    if (config.minIVRank > 0 && (signal.ivRank == null || signal.ivRank < config.minIVRank)) {
      return null;
    }
    if (config.maxIVRank != null && signal.ivRank != null && signal.ivRank > config.maxIVRank) {
      return null;
    }

    const entryChain = getCachedChainMemo(signal.ticker, signal.date);
    if (entryChain.length === 0) return null;

    const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Call' : 'Put';
    const spread = findDebitSpreadStrikes(
      entryChain,
      config.debitLongDelta,
      config.debitShortDelta,
      optionType,
      config.debitDTERange,
    );
    if (!spread || spread.netDebit <= 0) return null;

    let entryDebit: number;
    let entrySlippage = 0;
    const grossEntryDebit = spread.netDebit;
    const { entryCommission, exitCommission } = resolveCreditSpreadCommissions(config);

    if (fillMode === 'bidask' && config.slippage.enabled) {
      const fill = applyDebitSpreadFill(
        'bidask',
        { ...spread.long, dte: spread.long.row.dte },
        { ...spread.short, dte: spread.short.row.dte },
        'open',
        config.slippage,
      );
      entryDebit = fill.fillPrice;
      entrySlippage = fill.slippage;
    } else {
      entryDebit = spread.netDebit;
    }

    const thresholds = computeDebitSpreadThresholds(config, spread, entryDebit);
    const monitorEnd = spread.long.row.expir_date < maxDate ? spread.long.row.expir_date : maxDate;
    const monitorDates = getMonitoringDates(allTradingDates, signal.date, config.monitoringIntervalDays, monitorEnd);
    const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];

    let missingChainState = createMissingChainState();
    let lastValidSpreadValue: number | null = null;
    let lastKnownStockPrice = spread.long.row.stock_price;
    let lastLongIV: number | null = spread.long.iv > 0 ? spread.long.iv : null;
    let lastShortIV: number | null = spread.short.iv > 0 ? spread.short.iv : null;
    let syntheticDayCount = 0;
    let lastRepricingMethod: RepricingMethod = 'exact';
    const bsmR = config.bsmRiskFreeRate ?? 0.04;
    const bsmKappa = config.bsmKappa ?? 4.0;
    const ivTheta = signal.oratsIV60 ?? signal.hv60 ?? spread.long.iv;

    for (let index = 0; index < monitorDates.length; index += 1) {
      const checkDate = monitorDates[index];
      let longLeg = findContractDirect(signal.ticker, checkDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
      let shortLeg = findContractDirect(signal.ticker, checkDate, spread.short.row.strike, spread.long.row.expir_date, optionType);
      const fallbackChain = (!longLeg || !shortLeg) ? getCachedChainMemo(signal.ticker, checkDate) : [];
      const monitoringStockPrice = longLeg?.row.stock_price ?? shortLeg?.row.stock_price ?? fallbackChain[0]?.stock_price;
      if (monitoringStockPrice != null && Number.isFinite(monitoringStockPrice)) {
        lastKnownStockPrice = monitoringStockPrice;
      }

      let dayUsedSynthetic = false;
      if (!longLeg) {
        const synthLong = syntheticRepriceLeg({
          ticker: signal.ticker,
          date: checkDate,
          strike: spread.long.row.strike,
          expiry: spread.long.row.expir_date,
          type: optionType,
          entryIV: spread.long.iv,
          entryDate: signal.date,
          lastValidIV: lastLongIV,
          ivTheta,
          kappa: bsmKappa,
          r: bsmR,
        }, monitoringStockPrice ?? lastKnownStockPrice);
        if (synthLong) {
          longLeg = synthLong;
          lastRepricingMethod = synthLong.repricingMethod;
          dayUsedSynthetic = true;
        }
      }
      if (!shortLeg) {
        const synthShort = syntheticRepriceLeg({
          ticker: signal.ticker,
          date: checkDate,
          strike: spread.short.row.strike,
          expiry: spread.long.row.expir_date,
          type: optionType,
          entryIV: spread.short.iv,
          entryDate: signal.date,
          lastValidIV: lastShortIV,
          ivTheta,
          kappa: bsmKappa,
          r: bsmR,
        }, monitoringStockPrice ?? lastKnownStockPrice);
        if (synthShort) {
          shortLeg = synthShort;
          lastRepricingMethod = synthShort.repricingMethod;
          dayUsedSynthetic = true;
        }
      }

      const hasValidLegs = Boolean(longLeg && shortLeg);
      missingChainState = updateMissingChainState(missingChainState, hasValidLegs);
      if (!hasValidLegs) {
        if (shouldExitNoChain(config, missingChainState)) {
          const intrinsicValue = monitoringStockPrice != null
            ? computeIntrinsicDebitSpreadValue(
                optionType,
                spread.long.row.strike,
                spread.short.row.strike,
                monitoringStockPrice,
                thresholds.actualWidth,
              )
            : null;
          const grossExitValue = Math.max(lastValidSpreadValue ?? 0, intrinsicValue ?? 0);
          return buildDebitSpreadTrade({
            signal,
            spread,
            entryDebit,
            grossEntryDebit,
            exitDate: checkDate,
            exitSpreadValue: grossExitValue,
            grossExitSpreadValue: grossExitValue,
            exitDTE: longLeg?.row.dte ?? shortLeg?.row.dte ?? fallbackChain[0]?.dte ?? 0,
            exitStockPrice: monitoringStockPrice ?? lastKnownStockPrice,
            exitType: 'NO_CHAIN',
            dailyMtM,
            entrySlippage,
            entryCommission,
            exitCommission,
            fillMode,
            repricingMethod: syntheticDayCount > 0 ? lastRepricingMethod : undefined,
            syntheticDays: syntheticDayCount > 0 ? syntheticDayCount : undefined,
          });
        }
        continue;
      }
      if (dayUsedSynthetic) syntheticDayCount++;

      const grossCurrentSpreadValue = clampDebitSpreadValue(longLeg!.mid - shortLeg!.mid, thresholds.actualWidth);
      let currentSpreadValue: number;
      let exitSlippageAmount = 0;
      if (fillMode === 'bidask' && config.slippage.enabled) {
        const fill = applyDebitSpreadFill(
          'bidask',
          { ...longLeg!, dte: longLeg!.row.dte },
          { ...shortLeg!, dte: shortLeg!.row.dte },
          'close',
          config.slippage,
        );
        currentSpreadValue = clampDebitSpreadValue(fill.fillPrice, thresholds.actualWidth);
        exitSlippageAmount = fill.slippage;
      } else {
        currentSpreadValue = grossCurrentSpreadValue;
      }
      const currentDTE = longLeg!.row.dte;
      lastValidSpreadValue = currentSpreadValue;
      if (longLeg!.iv > 0) lastLongIV = longLeg!.iv;
      if (shortLeg!.iv > 0) lastShortIV = shortLeg!.iv;

      dailyMtM.push({
        date: checkDate,
        spreadMid: currentSpreadValue,
        unrealizedPnl: (currentSpreadValue - entryDebit) * 100,
      });

      const heldTradingDays = index + 1;
      let exitType: OptionExitType | null = null;
      if (grossCurrentSpreadValue >= thresholds.tpValue) {
        exitType = 'PROFIT_TARGET';
      } else if (shouldExitUnderlyingTrend(
        signal.ticker,
        checkDate,
        signal.direction,
        {
          underlyingExitEMA: config.underlyingExitEMA,
          underlyingExitConfirmDays: config.underlyingExitConfirmDays,
          underlyingExitRequireSlope: config.underlyingExitRequireSlope,
        },
        indexedHistories,
      )) {
        exitType = 'UNDERLYING_EXIT';
      } else if (heldTradingDays >= config.debitMaxHoldDays || currentDTE <= config.debitMinExitDTE) {
        exitType = 'TIME_STOP';
      }

      if (exitType) {
        const grossExitValue = resolveTriggeredDebitExitValue(exitType, grossCurrentSpreadValue, thresholds);
        const exitSpreadValue = clampDebitSpreadValue(grossExitValue - exitSlippageAmount, thresholds.actualWidth);
        return buildDebitSpreadTrade({
          signal,
          spread,
          entryDebit,
          grossEntryDebit,
          exitDate: checkDate,
          exitSpreadValue,
          grossExitSpreadValue: grossExitValue,
          exitDTE: currentDTE,
          exitStockPrice: longLeg!.row.stock_price,
          exitType,
          dailyMtM,
          entrySlippage,
          exitSlippage: exitSlippageAmount,
          entryCommission,
          exitCommission,
          fillMode,
          repricingMethod: syntheticDayCount > 0 ? lastRepricingMethod : undefined,
          syntheticDays: syntheticDayCount > 0 ? syntheticDayCount : undefined,
        });
      }
    }

    const lastDate = monitorDates[monitorDates.length - 1] ?? monitorEnd;
    if (!lastDate) return null;

    let longLeg = findContractDirect(signal.ticker, lastDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
    let shortLeg = findContractDirect(signal.ticker, lastDate, spread.short.row.strike, spread.long.row.expir_date, optionType);
    const fallbackChain = (!longLeg || !shortLeg) ? getCachedChainMemo(signal.ticker, lastDate) : [];
    const fallbackStockPrice = longLeg?.row.stock_price ?? shortLeg?.row.stock_price ?? fallbackChain[0]?.stock_price ?? lastKnownStockPrice;

    if (!longLeg) {
      const synthLong = syntheticRepriceLeg({
        ticker: signal.ticker,
        date: lastDate,
        strike: spread.long.row.strike,
        expiry: spread.long.row.expir_date,
        type: optionType,
        entryIV: spread.long.iv,
        entryDate: signal.date,
        lastValidIV: lastLongIV,
        ivTheta,
        kappa: bsmKappa,
        r: bsmR,
      }, fallbackStockPrice);
      if (synthLong) {
        longLeg = synthLong;
        syntheticDayCount++;
        lastRepricingMethod = synthLong.repricingMethod;
      }
    }
    if (!shortLeg) {
      const synthShort = syntheticRepriceLeg({
        ticker: signal.ticker,
        date: lastDate,
        strike: spread.short.row.strike,
        expiry: spread.long.row.expir_date,
        type: optionType,
        entryIV: spread.short.iv,
        entryDate: signal.date,
        lastValidIV: lastShortIV,
        ivTheta,
        kappa: bsmKappa,
        r: bsmR,
      }, fallbackStockPrice);
      if (synthShort) {
        shortLeg = synthShort;
        syntheticDayCount++;
        lastRepricingMethod = synthShort.repricingMethod;
      }
    }

    let grossCurrentSpreadValue: number;
    let currentSpreadValue: number;
    let exitSlippageAmount = 0;
    if (longLeg && shortLeg) {
      grossCurrentSpreadValue = clampDebitSpreadValue(longLeg.mid - shortLeg.mid, thresholds.actualWidth);
      if (fillMode === 'bidask' && config.slippage.enabled) {
        const fill = applyDebitSpreadFill(
          'bidask',
          { ...longLeg, dte: longLeg.row.dte },
          { ...shortLeg, dte: shortLeg.row.dte },
          'close',
          config.slippage,
        );
        currentSpreadValue = clampDebitSpreadValue(fill.fillPrice, thresholds.actualWidth);
        exitSlippageAmount = fill.slippage;
      } else {
        currentSpreadValue = grossCurrentSpreadValue;
      }
    } else {
      grossCurrentSpreadValue = computeIntrinsicDebitSpreadValue(
        optionType,
        spread.long.row.strike,
        spread.short.row.strike,
        fallbackStockPrice,
        thresholds.actualWidth,
      );
      currentSpreadValue = grossCurrentSpreadValue;
    }

    return buildDebitSpreadTrade({
      signal,
      spread,
      entryDebit,
      grossEntryDebit,
      exitDate: lastDate,
      exitSpreadValue: currentSpreadValue,
      grossExitSpreadValue: grossCurrentSpreadValue,
      exitDTE: longLeg?.row.dte ?? shortLeg?.row.dte ?? fallbackChain[0]?.dte ?? 0,
      exitStockPrice: fallbackStockPrice,
      exitType: 'EXPIRATION',
      dailyMtM,
      entrySlippage,
      exitSlippage: exitSlippageAmount,
      entryCommission,
      exitCommission,
      fillMode,
      repricingMethod: syntheticDayCount > 0 ? lastRepricingMethod : undefined,
      syntheticDays: syntheticDayCount > 0 ? syntheticDayCount : undefined,
    });
  };
}

function evaluateUnderlyingGate(result: UnderlyingWFAResult): DirectionalGateResult {
  const positiveWindows = result.windows.filter(window => window.oosTotalPnl > 0).length;
  const bucketLosses = {
    covid: result.windows.filter(window => [0, 1].includes(window.windowIndex)).reduce((sum, window) => sum + Math.min(0, window.oosTotalPnl), 0),
    bear: result.windows.filter(window => [3, 4].includes(window.windowIndex)).reduce((sum, window) => sum + Math.min(0, window.oosTotalPnl), 0),
    bull: result.windows.filter(window => [9, 10, 11].includes(window.windowIndex)).reduce((sum, window) => sum + Math.min(0, window.oosTotalPnl), 0),
    mid: result.windows.filter(window => ![0, 1, 3, 4, 9, 10, 11].includes(window.windowIndex)).reduce((sum, window) => sum + Math.min(0, window.oosTotalPnl), 0),
  };
  const bucketDrawdowns = [
    result.windows.filter(window => [0, 1].includes(window.windowIndex)),
    result.windows.filter(window => [3, 4].includes(window.windowIndex)),
    result.windows.filter(window => [9, 10, 11].includes(window.windowIndex)),
    result.windows.filter(window => ![0, 1, 3, 4, 9, 10, 11].includes(window.windowIndex)),
  ]
    .filter(bucket => bucket.length > 0)
    .map(bucket => Math.max(...bucket.map(window => window.oosMaxDD)));
  const totalLossAbs = Math.abs(Object.values(bucketLosses).reduce((sum, loss) => sum + loss, 0));
  const maxBucketLossShare = totalLossAbs > 0
    ? Math.max(...Object.values(bucketLosses).map(loss => Math.abs(loss) / totalLossAbs))
    : 0;

  const checks = [
    { name: 'OOS Sharpe', passed: result.oosSharpe > 0.4, actual: result.oosSharpe, target: '> 0.40' },
    { name: 'OOS Total PnL', passed: result.oosTotalPnl > 0, actual: result.oosTotalPnl, target: '> 0' },
    { name: 'Positive Windows', passed: positiveWindows >= 7, actual: positiveWindows, target: '>= 7/12' },
    {
      name: 'Regime Sharpe Floor',
      passed: Math.min(
        ...['covid', 'bear', 'bull', 'mid'].map(bucketName => {
          const bucketWindows = result.windows.filter(window => {
            if (bucketName === 'covid') return [0, 1].includes(window.windowIndex);
            if (bucketName === 'bear') return [3, 4].includes(window.windowIndex);
            if (bucketName === 'bull') return [9, 10, 11].includes(window.windowIndex);
            return ![0, 1, 3, 4, 9, 10, 11].includes(window.windowIndex);
          });
          if (bucketWindows.length === 0) return 0;
          return bucketWindows.reduce((sum, window) => sum + window.oosSharpe, 0) / bucketWindows.length;
        }),
      ) > -1,
      actual: Math.min(
        ...['covid', 'bear', 'bull', 'mid'].map(bucketName => {
          const bucketWindows = result.windows.filter(window => {
            if (bucketName === 'covid') return [0, 1].includes(window.windowIndex);
            if (bucketName === 'bear') return [3, 4].includes(window.windowIndex);
            if (bucketName === 'bull') return [9, 10, 11].includes(window.windowIndex);
            return ![0, 1, 3, 4, 9, 10, 11].includes(window.windowIndex);
          });
          if (bucketWindows.length === 0) return 0;
          return bucketWindows.reduce((sum, window) => sum + window.oosSharpe, 0) / bucketWindows.length;
        }),
      ),
      target: '> -1.0',
    },
    { name: 'Loss Concentration', passed: maxBucketLossShare <= 0.5, actual: maxBucketLossShare, target: '<= 50%' },
    {
      name: 'Drawdown Concentration',
      passed: bucketDrawdowns.length === 0 || Math.max(...bucketDrawdowns) <= median(bucketDrawdowns) * 1.5,
      actual: bucketDrawdowns.length === 0 ? 0 : Math.max(...bucketDrawdowns),
      target: '<= 1.5x median regime DD',
    },
  ];
  return { passed: checks.every(check => check.passed), checks };
}

function evaluateDebitGate(result: WFAResult, baselineMaxDDPct: number | undefined): DirectionalGateResult {
  const positiveWindows = result.windows.filter(window => window.oosTrades.reduce((sum, trade) => sum + trade.pnl, 0) > 0).length;
  const winners = result.allOOSTrades.filter(trade => trade.pnl > 0);
  const losers = result.allOOSTrades.filter(trade => trade.pnl <= 0);
  const avgWinner = winners.length > 0 ? winners.reduce((sum, trade) => sum + trade.pnl, 0) / winners.length : 0;
  const avgLoser = losers.length > 0 ? losers.reduce((sum, trade) => sum + trade.pnl, 0) / losers.length : 0;
  const bucketSharpeFloor = Math.min(
    ...['covid', 'bear', 'bull', 'mid'].map(bucketName => {
      const bucketWindows = result.windows.filter(window => {
        if (bucketName === 'covid') return [0, 1].includes(window.windowIndex);
        if (bucketName === 'bear') return [3, 4].includes(window.windowIndex);
        if (bucketName === 'bull') return [9, 10, 11].includes(window.windowIndex);
        return ![0, 1, 3, 4, 9, 10, 11].includes(window.windowIndex);
      });
      if (bucketWindows.length === 0) return 0;
      return bucketWindows.reduce((sum, window) => sum + window.oosSharpe, 0) / bucketWindows.length;
    }),
  );

  const checks = [
    { name: 'OOS Sharpe', passed: result.oosSharpe > 0, actual: result.oosSharpe, target: '> 0' },
    { name: 'OOS Total PnL', passed: result.oosTotalPnl > 0, actual: result.oosTotalPnl, target: '> 0' },
    { name: 'Positive Windows', passed: positiveWindows >= 7, actual: positiveWindows, target: '>= 7/12' },
    {
      name: 'Avg Winner vs Avg Loser',
      passed: avgWinner >= Math.abs(avgLoser),
      actual: `${avgWinner.toFixed(2)} / ${avgLoser.toFixed(2)}`,
      target: 'winner >= |loser|',
    },
    { name: 'Regime Sharpe Floor', passed: bucketSharpeFloor > -1, actual: bucketSharpeFloor, target: '> -1.0' },
  ];
  if (baselineMaxDDPct != null && Number.isFinite(baselineMaxDDPct)) {
    checks.push({
      name: 'Drawdown vs Swing Baseline',
      passed: result.oosMaxDD < baselineMaxDDPct * 0.9,
      actual: result.oosMaxDD,
      target: `< ${(baselineMaxDDPct * 0.9).toFixed(2)}`,
    });
  }
  return { passed: checks.every(check => check.passed), checks };
}

export function formatUnderlyingConfigLabel(config: UnderlyingSimConfig): string {
  const sourceLabel = resolveUnderlyingSignalSourceLabel(config);
  const dirConf = (config.minDirConfidence ?? 0) > 0 ? `/dc>=${config.minDirConfidence}` : '';
  const d8 = config.maxEntryD8 != null && Number.isFinite(config.maxEntryD8) ? `/|d8|<=${config.maxEntryD8}` : '';
  const gap = config.maxRecentGapPct != null && Number.isFinite(config.maxRecentGapPct) ? `/gap<=${config.maxRecentGapPct}` : '';
  const vrp = (config.minEntryVrpPct ?? 0) > 0 ? `/vrp>=${config.minEntryVrpPct}` : '';
  const contango = config.maxEntryContangoPct != null && Number.isFinite(config.maxEntryContangoPct) ? `/contango<=${config.maxEntryContangoPct}` : '';
  const bonus = (config.pb21RankingBonus ?? 0) > 0 ? `/pb21+${config.pb21RankingBonus}` : '';
  const router = config.pb21RouterMode && config.pb21RouterMode !== 'off' ? `/r=${config.pb21RouterMode}` : '';
  const maxPositions = config.maxPositions != null ? `/mp${config.maxPositions}` : '';
  const pt = config.profitTargetPct != null ? `/pt${(config.profitTargetPct * 100).toFixed(0)}` : '';
  return `${sourceLabel}/ema${config.underlyingExitEMA}/c${config.underlyingExitConfirmDays}/h${config.maxHoldDays}${router}${bonus}${maxPositions}${pt}${dirConf}${d8}${gap}${vrp}${contango}`;
}

export function formatDebitConfigLabel(config: SimConfig): string {
  const range = `${config.debitDTERange[0]}_${config.debitDTERange[1]}`;
  const ivCap = config.maxIVRank != null ? `/iv<=${config.maxIVRank}` : '';
  return `${config.signalWeightPreset ?? 'pb'}/dte${range}/ld${(config.debitLongDelta * 100).toFixed(0)}/sd${(config.debitShortDelta * 100).toFixed(0)}/tp${(config.debitProfitTargetPct * 100).toFixed(0)}/ema${config.underlyingExitEMA}/c${config.underlyingExitConfirmDays}/h${config.debitMaxHoldDays}/dte<=${config.debitMinExitDTE}${ivCap}`;
}

export async function runDirectionalPipeline(
  config: DirectionalPipelineConfig,
): Promise<DirectionalPipelineResult> {
  console.log('WFA Directional — Underlying Benchmark + Debit Spread Pipeline');
  console.log('─'.repeat(60));

  initDB();
  closeDB();
  chainMemo.clear();

  console.log(`\nFetching candle data for ${config.tickers.length} tickers...`);
  const tickerDataMap = new Map<string, TickerData>();
  for (const ticker of config.tickers) {
    const tickerData = await fetchTickerData(ticker, config.dataStart, config.endDate);
    tickerDataMap.set(ticker, tickerData);
    process.stdout.write(` ${ticker}(${tickerData.candles.length})`);
  }
  console.log(' done.');

  const allDatesSet = new Set<string>();
  for (const tickerData of tickerDataMap.values()) {
    for (const candle of tickerData.candles) {
      if (candle.date >= config.startDate && candle.date <= config.endDate) {
        allDatesSet.add(candle.date);
      }
    }
  }
  const allTradingDates = [...allDatesSet].sort();
  buildDateIndex(allTradingDates);
  console.log(`Trading dates: ${allTradingDates.length} (${allTradingDates[0]} -> ${allTradingDates.at(-1)})`);

  console.log('\nGenerating signals per preset...');
  const signalsByPreset = new Map<SignalPresetKey, EntrySignal[]>();
  for (const preset of config.presets) {
    const signals: EntrySignal[] = [];
    for (const tickerData of tickerDataMap.values()) {
      signals.push(...generateSignalsForPreset(tickerData, preset, config.startDate, config.endDate));
    }
    signals.sort(compareDirectionalSignals);
    signalsByPreset.set(preset, signals);
    console.log(`  ${preset}: ${signals.length} signals`);
  }

  const windows = buildWFAWindows(allTradingDates, {
    trainWindowDays: config.trainWindowDays,
    forwardStepDays: config.forwardStepDays,
    purgeGapDays: config.purgeGapDays,
    mode: config.mode,
    startDate: config.startDate,
    endDate: config.endDate,
  });
  console.log(`\nWFA windows: ${windows.length} (${config.mode})`);
  for (const window of windows) {
    console.log(`  Train ${window.trainStart}->${window.trainEnd} | OOS ${window.oosStart}->${window.oosEnd}`);
  }

  const dims: DirectionalSweepDimensions = {
    ...DIRECTIONAL_SWEEP_DEFAULTS,
    ...config.sweepOverrides,
  };
  const result: DirectionalPipelineResult = {
    config,
    allTradingDates,
  };

  if (config.strategy === 'underlying') {
    const candidates = buildUnderlyingCandidates(dims);
    console.log(`\nUnderlying candidates: ${candidates.length}`);
    const wfa = runUnderlyingWFA(config, tickerDataMap, signalsByPreset, allTradingDates, candidates);
    result.underlying = {
      candidates,
      gate: evaluateUnderlyingGate(wfa),
      wfa,
    };
  } else {
    const candidates = buildDebitCandidates(config.fillMode, dims);
    console.log(`\nDebit spread candidates: ${candidates.length}`);
    const stopPeriods = [...new Set(
      candidates
        .map(candidate => candidate.underlyingExitEMA)
        .filter((period): period is number => Number.isFinite(period) && period > 0),
    )];
    const underlyingHistoryData: Record<string, SerializedUnderlyingHistory> = {};
    for (const [ticker, tickerData] of tickerDataMap) {
      underlyingHistoryData[ticker] = buildUnderlyingHistory(tickerData.candles, stopPeriods);
    }

    const evaluator = makeCachedDebitEvaluator(config.fillMode, underlyingHistoryData);
    const wfaConfig: WFAOptionsConfig = {
      tickers: config.tickers,
      startDate: config.startDate,
      endDate: config.endDate,
      trainWindowDays: config.trainWindowDays,
      forwardStepDays: config.forwardStepDays,
      purgeGapDays: config.purgeGapDays,
      mode: config.mode,
      maxPositions: config.maxPositions,
      maxPerTicker: config.maxPerTicker,
      startingCapital: config.startingCapital,
    };
    const wfa = runWFAOptions(
      wfaConfig,
      signalsByPreset,
      allTradingDates,
      candidates,
      evaluator,
      (windowIndex, totalWindows) => {
        process.stdout.write(`\r  Window ${windowIndex + 1}/${totalWindows}...`);
      },
    );
    process.stdout.write('\n');
    result.debit = {
      candidates,
      gate: evaluateDebitGate(wfa, config.swingCreditBaselineMaxDDPct),
      wfa,
    };
  }

  return result;
}

export function closeDirectionalPipelineDB(): void {
  closeDB();
}
