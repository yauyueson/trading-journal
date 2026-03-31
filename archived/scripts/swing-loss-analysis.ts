import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type { BacktestCandle } from '../src/lib/backtest/types';
import {
  buildConfiguredSignalsForWindow,
  buildWFAWindows,
  computePortfolioDailyMetrics,
  executePreparedOOSWindowsWithCarry,
  optimizeWindow,
  selectConfigsForOOS,
  type PreparedOOSWindowExecution,
  type WFAResult,
} from '../src/lib/backtest/wfa-options';
import {
  getCachedChain,
  getCachedCores,
  getCachedCoresRange,
  findContractDirect,
  initDB,
  closeDB,
} from '../src/lib/backtest/chain-cache';
import type { RepricingMethod } from '../src/lib/backtest/synthetic-reprice';
import { syntheticRepriceLeg } from '../src/lib/backtest/synthetic-reprice';
import {
  computeOptionAnalytics,
  type EntrySignal,
  type OptionTrade,
  type SimConfig,
  type SignalPresetKey,
} from '../src/lib/backtest/option-sim';
import { computeIVRankMinMax } from '../src/lib/backtest/iv-rank';
import { emaFullSeries } from '../src/lib/indicators';
import {
  SWING_SWEEP_DEFAULTS,
  buildSweepCandidates,
  generateSignalsForPreset,
  makeCachedEvaluator,
  type SwingPipelineConfig,
  type TickerData,
} from './wfa-pipeline-swing';
import {
  replaySlimCreditTrade,
  type ReplaySignalOverrides,
  type SlimCreditTrade,
} from '../src/lib/backtest/credit-trade-replay';

type Direction = 'CALL' | 'PUT';
type LossPattern = 'gap' | 'drift' | 'whipsaw' | 'late_reversal';
type LossMechanism =
  | 'directional_breach'
  | 'vol_expansion_without_breach'
  | 'structural_time_decay_failure'
  | 'reversal_after_profit';
type AnalysisSource = 'validated_rerun' | 'validated_replay';

interface TargetRunTrade extends SlimCreditTrade {
  repricingMethod?: RepricingMethod;
  syntheticDays?: number;
}

interface TargetRunWindow {
  windowIndex: number;
  trainStart: string;
  trainEnd: string;
  oosStart: string;
  oosEnd: string;
  bestConfig: SimConfig;
  selectedConfigs?: SimConfig[];
  bestTrainSharpe: number;
  oosTrades: TargetRunTrade[];
  oosSharpe: number;
  oosWinRate: number;
  oosMaxDD: number;
}

interface TargetRun {
  metadata: {
    config: SwingPipelineConfig & Record<string, unknown>;
    cliCommand: string;
    cliArgs: string[];
    gitDirty?: boolean;
    timestamp: string;
  };
  windows: TargetRunWindow[];
  allOOSTrades: TargetRunTrade[];
  oosEquityCurve: { date: string; equity: number }[];
  oosSharpe: number;
  oosWinRate: number;
  oosMaxDD: number;
  oosTotalPnl: number;
  wfEfficiency: number;
  elapsedMs: number;
}

interface ValidationResult {
  passed: boolean;
  aggregateChecks: {
    tradeCount: boolean;
    exitBreakdown: boolean;
    totalPnl: boolean;
    oosSharpe: boolean;
    perWindowTradeCounts: boolean;
    perWindowSharpe: boolean;
  };
  rerunTradeCount: number;
  targetTradeCount: number;
  rerunTotalPnl: number;
  targetTotalPnl: number;
  rerunSharpe: number;
  targetSharpe: number;
  rerunExitBreakdown: Record<string, number>;
  targetExitBreakdown: Record<string, number>;
  tradeLevelMatches: number;
  tradeLevelMismatches: number;
  mismatchSamples: string[];
  perWindow: Array<{
    windowIndex: number;
    rerunTrades: number;
    targetTrades: number;
    rerunSharpe: number;
    targetSharpe: number;
  }>;
}

interface SignalMeta {
  signal: EntrySignal;
  tradeConfig: SimConfig;
  bestConfig: SimConfig;
  windowIndex: number;
}

interface EnrichedTrade {
  trade: OptionTrade;
  windowIndex: number;
  bestConfig: SimConfig;
  tradeConfig: SimConfig;
  signal?: EntrySignal;
  key: string;
}

interface FullTradeRecord extends EnrichedTrade {
  tradeConfigLabel: string;
  bestConfigLabel: string;
  regimeBucket: string;
  pattern?: LossPattern;
  patternConfidence?: number;
  mechanism?: LossMechanism;
  path: PathPoint[];
  stockPath: StockPoint[];
  metrics: TradeMetrics;
  worstDayState?: WorstDayState;
  entryFeatures: EntryFeatures;
  counterfactuals: Record<string, CounterfactualTradeResult>;
}

interface PathPoint {
  date: string;
  holdDay: number;
  spreadMid: number;
  pnl: number;
  isExit?: boolean;
}

interface StockPoint {
  date: string;
  holdDay: number;
  stockPrice: number | null;
  signedDistanceToShort: number | null;
}

interface EntryFeatures {
  d8?: number;
  prior5dReturn?: number;
  prior10dReturn?: number;
  entryDistanceToShortPct?: number;
  rewardRiskRatio?: number;
  totalFriction?: number;
}

interface TradeMetrics {
  MFE: number;
  MAE: number;
  mfeDay: number;
  maeDay: number;
  firstPositiveDay?: number;
  firstNegativeDay?: number;
  peakDay: number;
  troughDay: number;
  inflectionDay?: number;
  peakToFinalDrawdown: number;
  bestUnrealizedPnl: number;
  worstUnrealizedPnl: number;
  entryDistanceToShort: number | null;
  exitDistanceToShort: number | null;
  minDistanceToShort: number | null;
  firstBreachDay?: number;
  breachCount: number;
  maxBreachAmount: number;
  entryToExitStockMovePct: number | null;
}

interface WorstDayState {
  date: string;
  shortIV?: number;
  longIV?: number;
  longEntryIV?: number;
  shortDelta?: number;
  shortIvRatio?: number;
  longIvRatio?: number;
  repricingMethod: RepricingMethod;
  worstDaySynthetic: boolean;
}

interface CounterfactualTradeResult {
  exitDate: string;
  pnl: number;
  reason: string;
  affected: boolean;
}

interface CounterfactualSummary {
  name: string;
  totalPnl: number;
  winRate: number;
  affectedTrades: number;
  stopLossAvoided: number;
  timeStopAvoided: number;
  avgWinner: number;
  avgLoser: number;
}

interface PatternThresholds {
  gapLoss: number;
  whipsawMfe: number;
  lateReversalMfe: number;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TARGET_RUN_PATH = path.resolve(ROOT, 'data/runs/2026-03-27T20-31-21-127-unified-swing.json');
const STOCK_CANDLES_PATH = path.resolve(ROOT, 'data/cache/stock-candles.json');
const REPORT_DIR = path.resolve(ROOT, 'backtesting history/credit-spread/reports/swing-loss-analysis');
const REPORT_PATH = path.resolve(REPORT_DIR, 'README.md');
const FULL_TRADES_PATH = path.resolve(REPORT_DIR, 'full-trades.json');
const HANDOFF_PATH = path.resolve(ROOT, '.handoff/current.md');

function loadJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function computeRollingPercentile(values: (number | undefined)[], window = 252): (number | undefined)[] {
  return values.map((value, index) => {
    if (value == null || !Number.isFinite(value)) return undefined;
    const start = Math.max(0, index - window);
    const slice = values
      .slice(start, index + 1)
      .filter((candidate): candidate is number => candidate != null && Number.isFinite(candidate));
    if (slice.length < 60) return undefined;
    const le = slice.filter(candidate => candidate <= value).length;
    return (le / slice.length) * 100;
  });
}

function toBacktestCandles(rows: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>): BacktestCandle[] {
  return rows.map(row => ({
    ...row,
    timestamp: new Date(`${row.date}T00:00:00Z`).getTime(),
  }));
}

function buildLocalTickerData(
  ticker: string,
  config: SwingPipelineConfig,
  stockCandles: Record<string, Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>>,
): TickerData {
  const candleRows = stockCandles[ticker];
  if (!candleRows?.length) {
    throw new Error(`Missing stock candle cache for ${ticker}`);
  }
  const candles = toBacktestCandles(
    candleRows.filter(row => row.date >= config.dataStart && row.date <= config.endDate),
  );
  const orderedDates = candles.map(candle => candle.date);
  const coresRows = getCachedCoresRange(ticker, config.dataStart, config.endDate);
  const iv30ByDate = new Map<string, number>();
  const vrpByDate = new Map<string, number>();
  const contangoByDate = new Map<string, number>();
  const slopeByDate = new Map<string, number>();
  for (const row of coresRows) {
    if (row.iv30 != null && Number.isFinite(row.iv30)) iv30ByDate.set(row.trade_date, Number(row.iv30));
    if (row.vrp != null && Number.isFinite(row.vrp)) vrpByDate.set(row.trade_date, Number(row.vrp));
    if (row.contango != null && Number.isFinite(row.contango)) contangoByDate.set(row.trade_date, Number(row.contango));
    if (row.slope != null && Number.isFinite(row.slope)) slopeByDate.set(row.trade_date, Number(row.slope));
  }
  const vrpPctSeries = computeRollingPercentile(orderedDates.map(date => vrpByDate.get(date)));
  const contangoPctSeries = computeRollingPercentile(orderedDates.map(date => contangoByDate.get(date)));
  const regimeByDate = new Map<string, {
    vrp?: number;
    contango?: number;
    slope?: number;
    vrpPct?: number;
    contangoPct?: number;
  }>();
  orderedDates.forEach((date, index) => {
    regimeByDate.set(date, {
      vrp: vrpByDate.get(date),
      contango: contangoByDate.get(date),
      slope: slopeByDate.get(date),
      vrpPct: vrpPctSeries[index],
      contangoPct: contangoPctSeries[index],
    });
  });
  const ivSeries = orderedDates.map(date => iv30ByDate.get(date) ?? null);
  const ivRanks = computeIVRankMinMax(ivSeries);
  const dateToIdx = new Map(orderedDates.map((date, index) => [date, index]));
  return { ticker, candles, ivRanks, dateToIdx, regimeByDate };
}

function buildExitBreakdown(trades: Array<{ exitType: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const trade of trades) counts[trade.exitType] = (counts[trade.exitType] ?? 0) + 1;
  return counts;
}

function jsonStable(value: unknown): string {
  return JSON.stringify(value);
}

function configLabel(config: SimConfig): string {
  const preset = config.signalWeightPreset ?? 'ema';
  const tp = Math.round(config.creditProfitTarget * 100);
  const width = config.creditSpreadWidth;
  const delta = Math.round(config.creditShortDelta * 100);
  const ts = config.creditTimeStopDTE;
  const underlyingStop = config.underlyingStopEMA && config.underlyingStopDangerMode
    ? `/us${config.underlyingStopEMA}${config.underlyingStopDangerMode}${config.underlyingStopConfirmDays ?? 1}${config.underlyingStopRequireSlope ? 's' : ''}`
    : '';
  return `${preset}/tp${tp}/w${width}/d${delta}/ts${ts}${underlyingStop}`;
}

function tradeSignalKey(parts: { ticker: string; entryDate?: string; date?: string; direction: Direction }): string {
  return `${parts.ticker}|${parts.entryDate ?? parts.date}|${parts.direction}`;
}

function matchKey(trade: {
  ticker: string;
  entryDate: string;
  direction: Direction;
  strike: number;
  spreadWidth?: number;
}): string {
  return `${trade.ticker}|${trade.entryDate}|${trade.direction}|${trade.strike.toFixed(2)}|${(trade.spreadWidth ?? 0).toFixed(2)}`;
}

function countTradeLevelMatches(actual: OptionTrade[], target: TargetRunTrade[]): {
  matches: number;
  mismatches: number;
  samples: string[];
} {
  const targetMap = new Map<string, TargetRunTrade[]>();
  for (const trade of target) {
    const key = matchKey(trade);
    const bucket = targetMap.get(key) ?? [];
    bucket.push(trade);
    targetMap.set(key, bucket);
  }
  const samples: string[] = [];
  let matches = 0;
  let mismatches = 0;
  for (const trade of actual) {
    const key = matchKey(trade);
    const bucket = targetMap.get(key) ?? [];
    const matchIndex = bucket.findIndex(candidate =>
      candidate.exitType === trade.exitType &&
      candidate.exitDate === trade.exitDate &&
      candidate.holdDays === trade.holdDays &&
      Math.abs(candidate.pnl - trade.pnl) <= 0.01,
    );
    if (matchIndex >= 0) {
      bucket.splice(matchIndex, 1);
      matches += 1;
      continue;
    }
    mismatches += 1;
    if (samples.length < 12) {
      samples.push(
        `${trade.ticker} ${trade.entryDate} ${trade.direction} strike=${trade.strike} width=${trade.spreadWidth} -> rerun ${trade.exitType} ${trade.exitDate} pnl=${trade.pnl.toFixed(2)}`,
      );
    }
  }
  return { matches, mismatches, samples };
}

function validateRerun(result: WFAResult, target: TargetRun): ValidationResult {
  const rerunExitBreakdown = buildExitBreakdown(result.allOOSTrades);
  const targetExitBreakdown = buildExitBreakdown(target.allOOSTrades);
  const perWindow = result.windows.map((window, index) => ({
    windowIndex: window.windowIndex,
    rerunTrades: window.oosTrades.length,
    targetTrades: target.windows[index]?.oosTrades.length ?? 0,
    rerunSharpe: window.oosSharpe,
    targetSharpe: target.windows[index]?.oosSharpe ?? Number.NaN,
  }));
  const tradeMatch = countTradeLevelMatches(result.allOOSTrades, target.allOOSTrades);
  const aggregateChecks = {
    tradeCount: result.allOOSTrades.length === target.allOOSTrades.length,
    exitBreakdown: jsonStable(rerunExitBreakdown) === jsonStable(targetExitBreakdown),
    totalPnl: Math.abs(result.oosTotalPnl - target.oosTotalPnl) <= 1,
    oosSharpe: Math.abs(result.oosSharpe - target.oosSharpe) <= 0.01,
    perWindowTradeCounts: perWindow.every(row => row.rerunTrades === row.targetTrades),
    perWindowSharpe: perWindow.every(row => Math.abs(row.rerunSharpe - row.targetSharpe) <= 0.02),
  };
  const passed = Object.values(aggregateChecks).every(Boolean) && tradeMatch.mismatches === 0;
  return {
    passed,
    aggregateChecks,
    rerunTradeCount: result.allOOSTrades.length,
    targetTradeCount: target.allOOSTrades.length,
    rerunTotalPnl: result.oosTotalPnl,
    targetTotalPnl: target.oosTotalPnl,
    rerunSharpe: result.oosSharpe,
    targetSharpe: target.oosSharpe,
    rerunExitBreakdown,
    targetExitBreakdown,
    tradeLevelMatches: tradeMatch.matches,
    tradeLevelMismatches: tradeMatch.mismatches,
    mismatchSamples: tradeMatch.samples,
    perWindow,
  };
}

async function rebuildFromLocalCaches(target: TargetRun): Promise<{
  result: WFAResult;
  enrichedTrades: EnrichedTrade[];
  preparedWindows: PreparedOOSWindowExecution[];
  validation: ValidationResult;
  allTradingDates: string[];
}> {
  const config = target.metadata.config as SwingPipelineConfig & Record<string, unknown>;
  const stockCandles = loadJson<Record<string, Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>>>(STOCK_CANDLES_PATH);
  initDB();

  const tickerDataMap = new Map<string, TickerData>();
  for (const ticker of config.tickers) {
    tickerDataMap.set(ticker, buildLocalTickerData(ticker, config, stockCandles));
  }

  const allDatesSet = new Set<string>();
  for (const tickerData of tickerDataMap.values()) {
    for (const candle of tickerData.candles) {
      if (candle.date >= config.startDate && candle.date <= config.endDate) allDatesSet.add(candle.date);
    }
  }
  const allTradingDates = [...allDatesSet].sort();

  const signalsByPreset = new Map<SignalPresetKey, EntrySignal[]>();
  for (const preset of config.presets) {
    const signals: EntrySignal[] = [];
    for (const ticker of config.tickers) {
      const tickerData = tickerDataMap.get(ticker);
      if (!tickerData) continue;
      signals.push(...generateSignalsForPreset(tickerData, preset, config.startDate, config.endDate));
    }
    signals.sort((a, b) => a.date.localeCompare(b.date));
    signalsByPreset.set(preset, signals);
  }

  if (config.signalDirectionFilter) {
    for (const [preset, signals] of signalsByPreset) {
      signalsByPreset.set(preset, signals.filter(signal => signal.direction === config.signalDirectionFilter));
    }
  }

  const windowDefs = buildWFAWindows(allTradingDates, {
    trainWindowDays: config.trainWindowDays,
    forwardStepDays: config.forwardStepDays,
    purgeGapDays: config.purgeGapDays,
    mode: config.mode,
    startDate: config.startDate,
    endDate: config.endDate,
  });

  const candidates = buildSweepCandidates(config.fillMode, {
    ...SWING_SWEEP_DEFAULTS,
    ...config.sweepOverrides,
  });
  const evaluator = makeCachedEvaluator(config.fillMode);
  const executionConfig = {
    maxPositions: config.maxPositions,
    maxPerTicker: config.maxPerTicker,
    startingCapital: config.startingCapital,
  };
  const selectionMode = (config.selectionMode as 'single' | 'ensemble_top_k' | undefined) ?? 'ensemble_top_k';
  const ensembleSize = Math.max(1, Number(config.ensembleSize ?? 3));
  const ensembleMinVotes = Math.max(1, Number(config.ensembleMinVotes ?? 2));
  const windowMetricsMode = (config.windowMetricsMode as 'strict' | 'lifecycle' | undefined) ?? 'strict';

  const preparedWindows: PreparedOOSWindowExecution[] = [];
  for (let index = 0; index < windowDefs.length; index += 1) {
    const windowDef = windowDefs[index];
    process.stdout.write(`\rRebuilding window ${index + 1}/${windowDefs.length}...`);
    const opt = optimizeWindow(
      candidates,
      signalsByPreset,
      allTradingDates,
      windowDef.trainStart,
      windowDef.trainEnd,
      evaluator,
      executionConfig,
      config.selectionGuard as any,
    );
    const selectedResults = selectConfigsForOOS(
      opt.allResults,
      config.selectionGuard as any,
      selectionMode,
      ensembleSize,
    );
    const configuredSignals = buildConfiguredSignalsForWindow(
      selectedResults,
      signalsByPreset,
      windowDef.oosStart,
      windowDef.oosEnd,
      selectionMode === 'single' ? 1 : ensembleMinVotes,
    );
    preparedWindows.push({
      windowIndex: index,
      trainStart: windowDef.trainStart,
      trainEnd: windowDef.trainEnd,
      oosStart: windowDef.oosStart,
      oosEnd: windowDef.oosEnd,
      bestConfig: selectedResults[0]?.config ?? opt.bestConfig,
      selectedConfigs: selectedResults.map(result => result.config),
      bestTrainSharpe: selectedResults[0]?.sharpe ?? opt.bestSharpe,
      configuredSignals,
    });
  }
  process.stdout.write('\n');

  const executed = executePreparedOOSWindowsWithCarry(
    preparedWindows,
    executionConfig,
    allTradingDates,
    config.endDate,
    evaluator,
    windowMetricsMode,
    config.startingCapital,
  );
  const portfolioMetrics = computePortfolioDailyMetrics(
    executed.allOOSTrades,
    allTradingDates,
    config.startDate,
    config.endDate,
    config.startingCapital,
  );
  const analytics = computeOptionAnalytics(executed.allOOSTrades);
  const avgTrainSharpe = executed.windows.length > 0
    ? executed.windows.reduce((sum, window) => sum + window.bestTrainSharpe, 0) / executed.windows.length
    : 0;

  const result: WFAResult = {
    config: {
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
    },
    windows: executed.windows,
    allOOSTrades: executed.allOOSTrades,
    oosEquityCurve: portfolioMetrics.equityCurve,
    oosSharpe: portfolioMetrics.sharpe,
    oosWinRate: analytics.winRate,
    oosMaxDD: portfolioMetrics.maxDrawdownPct,
    oosTotalPnl: executed.allOOSTrades.reduce((sum, trade) => sum + trade.pnl, 0),
    wfEfficiency: avgTrainSharpe >= 0.1 ? portfolioMetrics.sharpe / avgTrainSharpe : 0,
    elapsedMs: 0,
  };

  const signalMetaByWindow = new Map<number, Map<string, SignalMeta>>();
  for (const prepared of preparedWindows) {
    const map = new Map<string, SignalMeta>();
    for (const configured of prepared.configuredSignals) {
      map.set(tradeSignalKey(configured.signal), {
        signal: configured.signal,
        tradeConfig: configured.config,
        bestConfig: prepared.bestConfig,
        windowIndex: prepared.windowIndex,
      });
    }
    signalMetaByWindow.set(prepared.windowIndex, map);
  }

  const enrichedTrades: EnrichedTrade[] = [];
  for (const window of executed.windows) {
    const metaMap = signalMetaByWindow.get(window.windowIndex) ?? new Map<string, SignalMeta>();
    for (const trade of window.oosTrades) {
      const key = tradeSignalKey(trade);
      const meta = metaMap.get(key);
      enrichedTrades.push({
        trade,
        key,
        windowIndex: window.windowIndex,
        bestConfig: meta?.bestConfig ?? window.bestConfig,
        tradeConfig: meta?.tradeConfig ?? window.bestConfig,
        signal: meta?.signal,
      });
    }
  }

  const validation = validateRerun(result, target);
  return { result, enrichedTrades, preparedWindows, validation, allTradingDates };
}

function determineWindowForDate(date: string, windows: Array<{ windowIndex: number; oosStart: string; oosEnd: string; bestConfig: SimConfig }>): {
  windowIndex: number;
  bestConfig: SimConfig;
} {
  const match = windows.find(window => date >= window.oosStart && date <= window.oosEnd);
  if (!match) throw new Error(`Unable to assign window for date ${date}`);
  return { windowIndex: match.windowIndex, bestConfig: match.bestConfig };
}

function buildReplayRecords(
  target: TargetRun,
  preparedWindows: PreparedOOSWindowExecution[],
  allTradingDates: string[],
): EnrichedTrade[] {
  const signalMeta = new Map<string, SignalMeta>();
  for (const prepared of preparedWindows) {
    for (const configured of prepared.configuredSignals) {
      signalMeta.set(tradeSignalKey(configured.signal), {
        signal: configured.signal,
        tradeConfig: configured.config,
        bestConfig: prepared.bestConfig,
        windowIndex: prepared.windowIndex,
      });
    }
  }

  const records: EnrichedTrade[] = [];
  for (const targetTrade of target.allOOSTrades) {
    const key = tradeSignalKey(targetTrade);
    const meta = signalMeta.get(key);
    const windowMatch = meta ?? (() => {
      const assigned = determineWindowForDate(targetTrade.entryDate, preparedWindows);
      return {
        signal: undefined,
        tradeConfig: assigned.bestConfig,
        bestConfig: assigned.bestConfig,
        windowIndex: assigned.windowIndex,
      };
    })();
    const overrides: ReplaySignalOverrides = {
      score: windowMatch.signal?.score,
      ivRank: windowMatch.signal?.ivRank,
      hv60: windowMatch.signal?.hv60,
      oratsIV60: windowMatch.signal?.oratsIV60,
    };
    const replayed = replaySlimCreditTrade(
      targetTrade,
      windowMatch.tradeConfig,
      allTradingDates,
      target.metadata.config.endDate,
      overrides,
    );
    if (!replayed) {
      throw new Error(`Replay failed for ${targetTrade.ticker} ${targetTrade.entryDate} ${targetTrade.direction}`);
    }
    records.push({
      trade: replayed,
      key,
      windowIndex: windowMatch.windowIndex,
      bestConfig: windowMatch.bestConfig,
      tradeConfig: windowMatch.tradeConfig,
      signal: windowMatch.signal,
    });
  }
  return records;
}

function validateReplay(records: EnrichedTrade[], target: TargetRun): {
  passed: boolean;
  matches: number;
  mismatches: number;
  samples: string[];
} {
  const outcome = countTradeLevelMatches(records.map(record => record.trade), target.allOOSTrades);
  return {
    passed: outcome.mismatches === 0 && outcome.matches === target.allOOSTrades.length,
    matches: outcome.matches,
    mismatches: outcome.mismatches,
    samples: outcome.samples,
  };
}

function regimeBucket(windowIndex: number): string {
  if (windowIndex <= 1) return 'W0-1';
  if (windowIndex === 2) return 'W2';
  if (windowIndex <= 4) return 'W3-4';
  if (windowIndex <= 8) return 'W5-8';
  return 'W9-11';
}

function holdDay(entryDate: string, date: string): number {
  return Math.round((new Date(date).getTime() - new Date(entryDate).getTime()) / 86400000);
}

function buildPath(trade: OptionTrade): PathPoint[] {
  const points: PathPoint[] = [{
    date: trade.entryDate,
    holdDay: 0,
    spreadMid: trade.entryPrice,
    pnl: 0,
  }];
  for (const mtm of trade.dailyMtM ?? []) {
    points.push({
      date: mtm.date,
      holdDay: holdDay(trade.entryDate, mtm.date),
      spreadMid: mtm.spreadMid,
      pnl: mtm.unrealizedPnl,
    });
  }
  const finalPoint: PathPoint = {
    date: trade.exitDate,
    holdDay: trade.holdDays,
    spreadMid: trade.exitPrice,
    pnl: trade.pnl,
    isExit: true,
  };
  const existingIndex = points.findIndex(point => point.date === finalPoint.date && point.holdDay === finalPoint.holdDay);
  if (existingIndex >= 0) points[existingIndex] = finalPoint;
  else points.push(finalPoint);
  return points.sort((a, b) => a.holdDay - b.holdDay || a.date.localeCompare(b.date));
}

function safeMedian(values: number[]): number {
  return quantile(values, 0.5);
}

function quantile(values: number[], q: number): number {
  const filtered = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!filtered.length) return Number.NaN;
  const index = (filtered.length - 1) * q;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return filtered[lo];
  const weight = index - lo;
  return filtered[lo] * (1 - weight) + filtered[hi] * weight;
}

function average(values: number[]): number {
  const filtered = values.filter(value => Number.isFinite(value));
  if (!filtered.length) return Number.NaN;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function formatNum(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return 'NA';
  return value.toFixed(digits);
}

function formatDollar(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return 'NA';
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(digits)}`;
}

function formatPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return 'NA';
  return `${value.toFixed(digits)}%`;
}

function mdTable(headers: string[], rows: Array<Array<string | number>>): string {
  const body = rows.map(row => `| ${row.map(cell => String(cell)).join(' | ')} |`).join('\n');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    body,
  ].join('\n');
}

function classifyLossPattern(record: FullTradeRecord, thresholds: PatternThresholds): {
  pattern: LossPattern;
  confidence: number;
} {
  const trade = record.trade;
  const { MFE, MAE, peakDay } = record.metrics;
  const finalPnl = trade.pnl;
  const lastQuarterStart = Math.floor(trade.holdDays * 0.75);
  const peakPoint = record.path.reduce((best, point) => point.pnl > best.pnl ? point : best, record.path[0]);
  const lastQuarterPoints = record.path.filter(point => point.holdDay >= lastQuarterStart);
  const startLastQuarterPnl = lastQuarterPoints.length ? lastQuarterPoints[0].pnl : finalPnl;
  const totalDrawdown = peakPoint.pnl - finalPnl;
  const lateDrawdown = startLastQuarterPnl - finalPnl;
  if (
    finalPnl < 0 &&
    MFE >= thresholds.lateReversalMfe &&
    peakDay >= 20 &&
    totalDrawdown > 0 &&
    lateDrawdown / totalDrawdown >= 0.5
  ) {
    return {
      pattern: 'late_reversal',
      confidence: Math.min(1, 0.4 + (MFE - thresholds.lateReversalMfe) / 300 + peakDay / 100),
    };
  }
  const maePoint = record.path.reduce((worst, point) => point.pnl < worst.pnl ? point : worst, record.path[0]);
  const mfeBeforeMae = Math.max(...record.path.filter(point => point.holdDay <= maePoint.holdDay).map(point => point.pnl));
  if (MAE <= thresholds.gapLoss && maePoint.holdDay <= 3 && mfeBeforeMae < 50) {
    return {
      pattern: 'gap',
      confidence: Math.min(1, 0.4 + Math.abs(MAE - thresholds.gapLoss) / 400 + (4 - maePoint.holdDay) / 10),
    };
  }
  if (finalPnl < 0 && MFE >= thresholds.whipsawMfe) {
    return {
      pattern: 'whipsaw',
      confidence: Math.min(1, 0.35 + (MFE - thresholds.whipsawMfe) / 250),
    };
  }
  return {
    pattern: 'drift',
    confidence: 0.35 + Math.min(0.5, Math.abs(MAE) / 1000),
  };
}

function counterfactualFactory(record: FullTradeRecord): Record<string, CounterfactualTradeResult> {
  const path = record.path;
  const original: CounterfactualTradeResult = {
    exitDate: record.trade.exitDate,
    pnl: record.trade.pnl,
    reason: 'original',
    affected: false,
  };

  const firstLaterPoint = (predicate: (point: PathPoint) => boolean, startIndex: number): PathPoint | undefined => {
    for (let index = startIndex + 1; index < path.length; index += 1) {
      if (predicate(path[index])) return path[index];
    }
    return undefined;
  };

  const firstBreachPoint = (() => {
    const index = record.stockPath.findIndex(point => point.signedDistanceToShort != null && point.signedDistanceToShort < 0);
    return index >= 0 ? record.stockPath[index] : undefined;
  })();

  const after100Index = path.findIndex(point => point.pnl >= 100);
  const beAfter100 = (() => {
    if (after100Index < 0) return original;
    const trigger = firstLaterPoint(point => point.pnl <= 0, after100Index);
    if (!trigger) return original;
    return {
      exitDate: trigger.date,
      pnl: 0,
      reason: 'BE_after_100',
      affected: trigger.date !== record.trade.exitDate || record.trade.pnl !== 0,
    };
  })();

  const lock50After100 = (() => {
    if (after100Index < 0) return original;
    const trigger = firstLaterPoint(point => point.pnl < 50, after100Index);
    if (!trigger) return original;
    return {
      exitDate: trigger.date,
      pnl: 50,
      reason: 'Lock50_after_100',
      affected: trigger.date !== record.trade.exitDate || Math.abs(record.trade.pnl - 50) > 0.01,
    };
  })();

  const exitOnFirstBreach = (() => {
    if (!firstBreachPoint) return original;
    const pathPoint = path.find(point => point.date === firstBreachPoint.date);
    if (!pathPoint) return original;
    return {
      exitDate: pathPoint.date,
      pnl: pathPoint.pnl,
      reason: 'Exit_on_first_breach',
      affected: pathPoint.date !== record.trade.exitDate || Math.abs(pathPoint.pnl - record.trade.pnl) > 0.01,
    };
  })();

  const day21Exit = (() => {
    const trigger = path.find(point => point.holdDay >= 21);
    if (!trigger) return original;
    return {
      exitDate: trigger.date,
      pnl: trigger.pnl,
      reason: 'Day21_exit',
      affected: trigger.date !== record.trade.exitDate || Math.abs(trigger.pnl - record.trade.pnl) > 0.01,
    };
  })();

  const combined = (() => {
    const lock = lock50After100;
    const triggerDay21 = path.find(point => point.holdDay >= 21);
    if (lock.affected) return lock;
    if (!triggerDay21) return original;
    return {
      exitDate: triggerDay21.date,
      pnl: triggerDay21.pnl,
      reason: 'Combined_plausible',
      affected: triggerDay21.date !== record.trade.exitDate || Math.abs(triggerDay21.pnl - record.trade.pnl) > 0.01,
    };
  })();

  return {
    BE_after_100: beAfter100,
    Lock50_after_100: lock50After100,
    Exit_on_first_breach: exitOnFirstBreach,
    Day21_exit: day21Exit,
    Combined_plausible: combined,
  };
}

function getPriceStore(
  stockCandles: Record<string, Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>>,
): {
  getStockPrice: (ticker: string, date: string) => number | null;
  getPriorReturn: (ticker: string, date: string, lookback: number) => number | undefined;
  getD8: (ticker: string, date: string) => number | undefined;
} {
  const priceMemo = new Map<string, number | null>();
  const candleMap = new Map<string, Map<string, number>>();
  const candleSeries = new Map<string, Array<{ date: string; close: number }>>();
  const d8Map = new Map<string, Map<string, number>>();
  for (const [ticker, rows] of Object.entries(stockCandles)) {
    candleMap.set(ticker, new Map(rows.map(row => [row.date, row.close])));
    candleSeries.set(ticker, rows.map(row => ({ date: row.date, close: row.close })));
    const closes = rows.map(row => row.close);
    const ema8 = emaFullSeries(closes, 8);
    const byDate = new Map<string, number>();
    rows.forEach((row, index) => {
      const ema = ema8[index];
      if (Number.isFinite(ema) && ema !== 0) {
        byDate.set(row.date, (row.close / ema) - 1);
      }
    });
    d8Map.set(ticker, byDate);
  }
  return {
    getStockPrice: (ticker: string, date: string) => {
      const key = `${ticker}|${date}`;
      if (priceMemo.has(key)) return priceMemo.get(key) ?? null;
      const chain = getCachedChain(ticker, date);
      const chainPrice = chain[0]?.stock_price;
      const candlePrice = candleMap.get(ticker)?.get(date);
      const price = Number.isFinite(chainPrice) ? Number(chainPrice) : (candlePrice ?? null);
      priceMemo.set(key, price);
      return price;
    },
    getPriorReturn: (ticker: string, date: string, lookback: number) => {
      const series = candleSeries.get(ticker);
      if (!series) return undefined;
      const idx = series.findIndex(row => row.date === date);
      if (idx < lookback || idx < 0) return undefined;
      const current = series[idx].close;
      const prior = series[idx - lookback].close;
      if (!Number.isFinite(current) || !Number.isFinite(prior) || prior === 0) return undefined;
      return (current / prior) - 1;
    },
    getD8: (ticker: string, date: string) => d8Map.get(ticker)?.get(date),
  };
}

function signedDistance(direction: Direction, price: number, shortStrike: number): number {
  return direction === 'CALL' ? price - shortStrike : shortStrike - price;
}

function lookupLongEntryIV(trade: OptionTrade): number | undefined {
  const optionType = trade.direction === 'CALL' ? 'Put' : 'Call';
  const longLeg = trade.longStrike == null
    ? null
    : findContractDirect(trade.ticker, trade.entryDate, trade.longStrike, trade.expiry, optionType);
  return longLeg?.iv;
}

function lookupWorstDayState(record: EnrichedTrade, getStockPrice: (ticker: string, date: string) => number | null): WorstDayState | undefined {
  const trade = record.trade;
  const worstPoint = buildPath(trade).reduce((worst, point) => point.pnl < worst.pnl ? point : worst, buildPath(trade)[0]);
  const optionType = trade.direction === 'CALL' ? 'Put' : 'Call';
  const pathPoints = buildPath(trade).filter(point => point.date <= worstPoint.date);
  const longEntryIV = lookupLongEntryIV(trade);
  let lastShortIV: number | null = trade.entryIV;
  let lastLongIV: number | null = longEntryIV ?? null;
  for (const point of pathPoints) {
    const shortLeg = findContractDirect(trade.ticker, point.date, trade.strike, trade.expiry, optionType);
    const longLeg = trade.longStrike == null
      ? null
      : findContractDirect(trade.ticker, point.date, trade.longStrike, trade.expiry, optionType);
    if (shortLeg?.iv && shortLeg.iv > 0) lastShortIV = shortLeg.iv;
    if (longLeg?.iv && longLeg.iv > 0) lastLongIV = longLeg.iv;
  }
  const stockPrice = getStockPrice(trade.ticker, worstPoint.date) ?? trade.entryStockPrice;
  let shortLeg = findContractDirect(trade.ticker, worstPoint.date, trade.strike, trade.expiry, optionType);
  let longLeg = trade.longStrike == null
    ? null
    : findContractDirect(trade.ticker, worstPoint.date, trade.longStrike, trade.expiry, optionType);
  let repricingMethod: RepricingMethod = 'exact';
  let worstDaySynthetic = false;
  const ivTheta = record.signal?.oratsIV60 ?? record.signal?.hv60 ?? trade.entryIV;
  const bsmR = record.tradeConfig.bsmRiskFreeRate ?? 0.04;
  const bsmKappa = record.tradeConfig.bsmKappa ?? 4;

  if (!shortLeg) {
    const syntheticShort = syntheticRepriceLeg({
      ticker: trade.ticker,
      date: worstPoint.date,
      strike: trade.strike,
      expiry: trade.expiry,
      type: optionType,
      entryIV: trade.entryIV,
      entryDate: trade.entryDate,
      lastValidIV: lastShortIV,
      ivTheta,
      kappa: bsmKappa,
      r: bsmR,
    }, stockPrice);
    if (syntheticShort) {
      shortLeg = syntheticShort;
      repricingMethod = syntheticShort.repricingMethod;
      worstDaySynthetic = true;
    }
  }

  if (!longLeg && trade.longStrike != null && longEntryIV != null) {
    const syntheticLong = syntheticRepriceLeg({
      ticker: trade.ticker,
      date: worstPoint.date,
      strike: trade.longStrike,
      expiry: trade.expiry,
      type: optionType,
      entryIV: longEntryIV,
      entryDate: trade.entryDate,
      lastValidIV: lastLongIV,
      ivTheta,
      kappa: bsmKappa,
      r: bsmR,
    }, stockPrice);
    if (syntheticLong) {
      longLeg = syntheticLong;
      if (repricingMethod === 'exact') repricingMethod = syntheticLong.repricingMethod;
      worstDaySynthetic = true;
    }
  }

  return {
    date: worstPoint.date,
    shortIV: shortLeg?.iv,
    longIV: longLeg?.iv,
    longEntryIV,
    shortDelta: shortLeg?.delta,
    shortIvRatio: shortLeg?.iv && trade.entryIV > 0 ? shortLeg.iv / trade.entryIV : undefined,
    longIvRatio: longLeg?.iv && longEntryIV && longEntryIV > 0 ? longLeg.iv / longEntryIV : undefined,
    repricingMethod,
    worstDaySynthetic,
  };
}

function buildTradeMetrics(record: EnrichedTrade, getStockPrice: (ticker: string, date: string) => number | null): {
  path: PathPoint[];
  stockPath: StockPoint[];
  metrics: TradeMetrics;
} {
  const trade = record.trade;
  const path = buildPath(trade);
  const stockPath = path.map(point => {
    const price = point.date === trade.entryDate
      ? trade.entryStockPrice
      : point.date === trade.exitDate
        ? trade.exitStockPrice
        : getStockPrice(trade.ticker, point.date);
    return {
      date: point.date,
      holdDay: point.holdDay,
      stockPrice: price,
      signedDistanceToShort: price == null ? null : signedDistance(trade.direction, price, trade.strike),
    };
  });
  const bestPoint = path.reduce((best, point) => point.pnl > best.pnl ? point : best, path[0]);
  const worstPoint = path.reduce((worst, point) => point.pnl < worst.pnl ? point : worst, path[0]);
  const firstPositive = path.find(point => point.pnl > 0);
  const firstNegative = path.find(point => point.pnl < 0);
  const inflection = path.find((point, index) => {
    if (point.pnl >= 0) return false;
    const next = path[index + 1];
    const nextTwo = path[index + 2];
    return Boolean(next && next.pnl < 0 && nextTwo && nextTwo.pnl < 0);
  });
  const distances = stockPath
    .map(point => point.signedDistanceToShort)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const entryDistance = signedDistance(trade.direction, trade.entryStockPrice, trade.strike);
  const exitDistance = signedDistance(trade.direction, trade.exitStockPrice, trade.strike);
  const breachPoints = stockPath.filter(point => point.signedDistanceToShort != null && point.signedDistanceToShort < 0);
  const minDistance = distances.length ? Math.min(...distances) : null;
  return {
    path,
    stockPath,
    metrics: {
      MFE: bestPoint.pnl,
      MAE: worstPoint.pnl,
      mfeDay: bestPoint.holdDay,
      maeDay: worstPoint.holdDay,
      firstPositiveDay: firstPositive?.holdDay,
      firstNegativeDay: firstNegative?.holdDay,
      peakDay: bestPoint.holdDay,
      troughDay: worstPoint.holdDay,
      inflectionDay: inflection?.holdDay,
      peakToFinalDrawdown: bestPoint.pnl - trade.pnl,
      bestUnrealizedPnl: bestPoint.pnl,
      worstUnrealizedPnl: worstPoint.pnl,
      entryDistanceToShort: entryDistance,
      exitDistanceToShort: exitDistance,
      minDistanceToShort: minDistance,
      firstBreachDay: breachPoints[0]?.holdDay,
      breachCount: breachPoints.length,
      maxBreachAmount: minDistance != null && minDistance < 0 ? Math.abs(minDistance) : 0,
      entryToExitStockMovePct: trade.entryStockPrice > 0
        ? ((trade.exitStockPrice / trade.entryStockPrice) - 1) * 100
        : null,
    },
  };
}

function buildAnalyzedTrades(records: EnrichedTrade[], source: AnalysisSource): FullTradeRecord[] {
  const stockCandles = loadJson<Record<string, Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>>>(STOCK_CANDLES_PATH);
  const priceStore = getPriceStore(stockCandles);
  const analyzed: FullTradeRecord[] = [];
  for (const record of records) {
    const built = buildTradeMetrics(record, priceStore.getStockPrice);
    const worstDayState = lookupWorstDayState(record, priceStore.getStockPrice);
    const totalFriction = (record.trade.entrySlippage ?? 0) + (record.trade.exitSlippage ?? 0);
    const entryDistancePct = record.trade.entryStockPrice > 0
      ? (built.metrics.entryDistanceToShort ?? 0) / record.trade.entryStockPrice * 100
      : undefined;
    const entryFeatures: EntryFeatures = {
      d8: record.signal?.d8 ?? priceStore.getD8(record.trade.ticker, record.trade.entryDate),
      prior5dReturn: priceStore.getPriorReturn(record.trade.ticker, record.trade.entryDate, 5),
      prior10dReturn: priceStore.getPriorReturn(record.trade.ticker, record.trade.entryDate, 10),
      entryDistanceToShortPct: entryDistancePct,
      rewardRiskRatio: record.trade.maxLoss && record.trade.maxLoss > 0
        ? ((record.trade.maxProfit ?? record.trade.entryPrice) / record.trade.maxLoss)
        : undefined,
      totalFriction,
    };
    const fullRecord: FullTradeRecord = {
      ...record,
      tradeConfigLabel: configLabel(record.tradeConfig),
      bestConfigLabel: configLabel(record.bestConfig),
      regimeBucket: regimeBucket(record.windowIndex),
      path: built.path,
      stockPath: built.stockPath,
      metrics: built.metrics,
      worstDayState,
      entryFeatures,
      counterfactuals: {} as Record<string, CounterfactualTradeResult>,
    };
    fullRecord.counterfactuals = counterfactualFactory(fullRecord);
    analyzed.push(fullRecord);
  }

  const baseThresholds: PatternThresholds = { gapLoss: -250, whipsawMfe: 50, lateReversalMfe: 100 };
  for (const record of analyzed) {
    if (record.trade.pnl < 0 && ['STOP_LOSS', 'TIME_STOP'].includes(record.trade.exitType)) {
      const classification = classifyLossPattern(record, baseThresholds);
      record.pattern = classification.pattern;
      record.patternConfidence = classification.confidence;
    }
    if (record.trade.pnl < 0) {
      if (record.metrics.MFE >= 100) {
        record.mechanism = 'reversal_after_profit';
      } else if ((record.metrics.firstBreachDay ?? Number.POSITIVE_INFINITY) < Number.POSITIVE_INFINITY) {
        record.mechanism = 'directional_breach';
      } else if ((record.worstDayState?.shortIvRatio ?? 0) >= 1.2) {
        record.mechanism = 'vol_expansion_without_breach';
      } else {
        record.mechanism = 'structural_time_decay_failure';
      }
    }
  }

  console.log(`Analysis source: ${source} (${analyzed.length} trades)`);
  return analyzed;
}

function buildReplayRecordsFromTargetWindows(
  target: TargetRun,
  allTradingDates: string[],
): EnrichedTrade[] {
  const records: EnrichedTrade[] = [];

  for (const window of target.windows) {
    const candidates = (window.selectedConfigs?.length ? window.selectedConfigs : [window.bestConfig]) as SimConfig[];
    for (const targetTrade of window.oosTrades) {
      const cores = getCachedCores(targetTrade.ticker, targetTrade.entryDate);
      const overrides: ReplaySignalOverrides = {
        oratsIV60: cores?.iv60 ?? undefined,
      };
      let bestReplay: { trade: OptionTrade; config: SimConfig; score: number } | null = null;
      for (const candidate of candidates) {
        const replayed = replaySlimCreditTrade(
          targetTrade,
          candidate,
          allTradingDates,
          target.metadata.config.endDate,
          overrides,
        );
        if (!replayed) continue;
        const exactMatch =
          replayed.exitType === targetTrade.exitType &&
          replayed.exitDate === targetTrade.exitDate &&
          replayed.holdDays === targetTrade.holdDays &&
          Math.abs(replayed.pnl - targetTrade.pnl) <= 0.01;
        const score = (replayed.exitType === targetTrade.exitType ? 1000 : 0)
          - Math.abs(holdDay(targetTrade.entryDate, replayed.exitDate) - targetTrade.holdDays) * 10
          - Math.abs(replayed.pnl - targetTrade.pnl);
        if (exactMatch) {
          bestReplay = { trade: replayed, config: candidate, score: Number.POSITIVE_INFINITY };
          break;
        }
        if (!bestReplay || score > bestReplay.score) {
          bestReplay = { trade: replayed, config: candidate, score };
        }
      }
      if (!bestReplay) {
        throw new Error(`Window-config replay failed for ${targetTrade.ticker} ${targetTrade.entryDate} ${targetTrade.direction}`);
      }
      records.push({
        trade: bestReplay.trade,
        key: tradeSignalKey(targetTrade),
        windowIndex: window.windowIndex,
        bestConfig: window.bestConfig,
        tradeConfig: bestReplay.config,
        signal: undefined,
      });
    }
  }
  return records;
}

function summarizeCounterfactual(records: FullTradeRecord[], key: keyof FullTradeRecord['counterfactuals']): CounterfactualSummary {
  const pnlSeries = records.map(record => record.counterfactuals[key].pnl);
  const winners = pnlSeries.filter(pnl => pnl > 0);
  const losers = pnlSeries.filter(pnl => pnl <= 0);
  return {
    name: key,
    totalPnl: sum(pnlSeries),
    winRate: winners.length / records.length * 100,
    affectedTrades: records.filter(record => record.counterfactuals[key].affected).length,
    stopLossAvoided: records.filter(record => record.trade.exitType === 'STOP_LOSS' && record.counterfactuals[key].affected).length,
    timeStopAvoided: records.filter(record => record.trade.exitType === 'TIME_STOP' && record.counterfactuals[key].affected).length,
    avgWinner: average(winners),
    avgLoser: average(losers),
  };
}

function numericDistributionTable(
  records: FullTradeRecord[],
  label: string,
  selector: (record: FullTradeRecord) => number | undefined,
): Array<Array<string | number>> {
  const usable = records
    .map(record => ({ record, value: selector(record) }))
    .filter((row): row is { record: FullTradeRecord; value: number } => row.value != null && Number.isFinite(row.value));
  if (!usable.length) return [[label, 'NA', 'NA', 'NA', 'NA', 'NA', 'NA']];
  const winners = usable.filter(row => row.record.trade.pnl > 0).map(row => row.value);
  const losers = usable.filter(row => row.record.trade.pnl <= 0).map(row => row.value);
  const sorted = [...usable].sort((a, b) => a.value - b.value);
  const quartileSize = Math.ceil(sorted.length / 4);
  const quartileRows: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const bucket = sorted.slice(index * quartileSize, (index + 1) * quartileSize);
    if (!bucket.length) continue;
    const lossRate = bucket.filter(row => row.record.trade.pnl <= 0).length / bucket.length * 100;
    quartileRows.push(`Q${index + 1} ${formatPct(lossRate)}`);
  }
  return [[
    label,
    formatNum(safeMedian(winners)),
    `${formatNum(quantile(winners, 0.25))} / ${formatNum(quantile(winners, 0.75))}`,
    formatNum(safeMedian(losers)),
    `${formatNum(quantile(losers, 0.25))} / ${formatNum(quantile(losers, 0.75))}`,
    formatNum(safeMedian(usable.map(row => row.value))),
    quartileRows.join(', '),
  ]];
}

function categoricalRows(
  records: FullTradeRecord[],
  selector: (record: FullTradeRecord) => string,
): Array<Array<string | number>> {
  const grouped = new Map<string, FullTradeRecord[]>();
  for (const record of records) {
    const key = selector(record);
    const bucket = grouped.get(key) ?? [];
    bucket.push(record);
    grouped.set(key, bucket);
  }
  return [...grouped.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, bucket]) => [
      key,
      bucket.length,
      formatPct(bucket.filter(record => record.trade.pnl <= 0).length / bucket.length * 100),
      formatDollar(sum(bucket.map(record => record.trade.pnl))),
    ]);
}

function patternSensitivity(records: FullTradeRecord[]): Array<Array<string | number>> {
  const sets: Array<{ name: string; thresholds: PatternThresholds }> = [
    { name: 'aggressive', thresholds: { gapLoss: -200, whipsawMfe: 50, lateReversalMfe: 75 } },
    { name: 'base', thresholds: { gapLoss: -250, whipsawMfe: 50, lateReversalMfe: 100 } },
    { name: 'conservative', thresholds: { gapLoss: -300, whipsawMfe: 75, lateReversalMfe: 125 } },
  ];
  const lossTrades = records.filter(record => record.trade.pnl < 0 && ['STOP_LOSS', 'TIME_STOP'].includes(record.trade.exitType));
  return sets.map(set => {
    const counts: Record<LossPattern, number> = { gap: 0, drift: 0, whipsaw: 0, late_reversal: 0 };
    for (const record of lossTrades) {
      const classification = classifyLossPattern(record, set.thresholds);
      counts[classification.pattern] += 1;
    }
    return [
      set.name,
      counts.gap,
      counts.drift,
      counts.whipsaw,
      counts.late_reversal,
    ];
  });
}

function loserInflectionSummary(records: FullTradeRecord[]): {
  inflectionDay?: number;
  rows: Array<Array<string | number>>;
} {
  const losers = records.filter(record => record.trade.pnl < 0);
  const bucketEnds = [5, 10, 15, 20, 30, 40, 999];
  const labels = ['0-5', '6-10', '11-15', '16-20', '21-30', '31-40', '41+'];
  const dailyAverages: Array<{ day: number; avgPnl: number }> = [];
  const maxHold = Math.max(...losers.map(record => record.trade.holdDays));
  for (let day = 0; day <= maxHold; day += 1) {
    const marks = losers.flatMap(record => {
      if (record.trade.holdDays < day) return [];
      const eligible = record.path.filter(point => point.holdDay <= day);
      if (!eligible.length) return [];
      return [eligible[eligible.length - 1].pnl];
    });
    if (!marks.length) continue;
    dailyAverages.push({ day, avgPnl: average(marks) });
  }
  const inflection = dailyAverages.find((row, index) =>
    row.avgPnl < 0 &&
    (dailyAverages[index + 1]?.avgPnl ?? 0) < 0 &&
    (dailyAverages[index + 2]?.avgPnl ?? 0) < 0
  );
  const rows = bucketEnds.map((end, index) => {
    const bucketLabel = labels[index];
    const bucketDay = dailyAverages.filter(row =>
      row.day <= end && row.day > (index === 0 ? -1 : bucketEnds[index - 1])
    );
    const last = bucketDay[bucketDay.length - 1];
    const active = losers.filter(record => record.trade.holdDays >= (last?.day ?? 0)).length;
    return [bucketLabel, active, formatDollar(last?.avgPnl, 0)];
  });
  return {
    inflectionDay: inflection?.day,
    rows,
  };
}

function topRows(records: FullTradeRecord[], limit: number, selector: (record: FullTradeRecord) => number): FullTradeRecord[] {
  return [...records].sort((a, b) => selector(b) - selector(a)).slice(0, limit);
}

function lossPatternRows(records: FullTradeRecord[], pattern: LossPattern, limit = 3): Array<Array<string | number>> {
  return [...records]
    .filter(record => record.pattern === pattern)
    .sort((a, b) => (b.patternConfidence ?? 0) - (a.patternConfidence ?? 0))
    .slice(0, limit)
    .map(record => [
      record.trade.ticker,
      record.trade.entryDate,
      record.trade.exitDate,
      record.trade.exitType,
      record.windowIndex,
      record.tradeConfigLabel,
      record.trade.holdDays,
      formatDollar(record.trade.pnl),
      formatDollar(record.metrics.MFE),
      formatDollar(record.metrics.MAE),
      record.metrics.firstBreachDay ?? 'NA',
      record.trade.repricingMethod ?? 'exact',
    ]);
}

function exitContributionRows(records: FullTradeRecord[]): Array<Array<string | number>> {
  const grouped = new Map<string, FullTradeRecord[]>();
  for (const record of records) {
    const bucket = grouped.get(record.trade.exitType) ?? [];
    bucket.push(record);
    grouped.set(record.trade.exitType, bucket);
  }
  return [...grouped.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([exitType, bucket]) => {
      const pnls = bucket.map(record => record.trade.pnl);
      return [
        exitType,
        bucket.length,
        formatDollar(sum(pnls)),
        formatDollar(quantile(pnls, 0.1)),
        formatDollar(quantile(pnls, 0.5)),
        formatDollar(quantile(pnls, 0.9)),
      ];
    });
}

function mfeMaeRows(records: FullTradeRecord[]): Array<Array<string | number>> {
  const groups: Array<{ name: string; trades: FullTradeRecord[] }> = [
    { name: 'all_losers', trades: records.filter(record => record.trade.pnl < 0) },
    { name: 'stop_loss', trades: records.filter(record => record.trade.exitType === 'STOP_LOSS' && record.trade.pnl < 0) },
    { name: 'time_stop', trades: records.filter(record => record.trade.exitType === 'TIME_STOP' && record.trade.pnl < 0) },
  ];
  return groups.map(group => [
    group.name,
    group.trades.length,
    formatDollar(quantile(group.trades.map(record => record.metrics.MFE), 0.25)),
    formatDollar(quantile(group.trades.map(record => record.metrics.MFE), 0.5)),
    formatDollar(quantile(group.trades.map(record => record.metrics.MFE), 0.75)),
    formatDollar(quantile(group.trades.map(record => record.metrics.MAE), 0.25)),
    formatDollar(quantile(group.trades.map(record => record.metrics.MAE), 0.5)),
    formatDollar(quantile(group.trades.map(record => record.metrics.MAE), 0.75)),
  ]);
}

function mfeThresholdRows(records: FullTradeRecord[]): Array<Array<string | number>> {
  const groups: Array<{ name: string; trades: FullTradeRecord[] }> = [
    { name: 'all_losers', trades: records.filter(record => record.trade.pnl < 0) },
    { name: 'stop_loss', trades: records.filter(record => record.trade.exitType === 'STOP_LOSS' && record.trade.pnl < 0) },
    { name: 'time_stop', trades: records.filter(record => record.trade.exitType === 'TIME_STOP' && record.trade.pnl < 0) },
  ];
  return groups.map(group => [
    group.name,
    formatPct(group.trades.filter(record => record.metrics.MFE > 50).length / Math.max(1, group.trades.length) * 100),
    formatPct(group.trades.filter(record => record.metrics.MFE > 100).length / Math.max(1, group.trades.length) * 100),
    formatPct(group.trades.filter(record => record.metrics.MFE > 150).length / Math.max(1, group.trades.length) * 100),
  ]);
}

function breachRows(records: FullTradeRecord[]): Array<Array<string | number>> {
  const exitTypes = [...new Set(records.map(record => record.trade.exitType))];
  return exitTypes.map(exitType => {
    const bucket = records.filter(record => record.trade.exitType === exitType);
    const breached = bucket.filter(record => (record.metrics.firstBreachDay ?? Number.POSITIVE_INFINITY) < Number.POSITIVE_INFINITY);
    return [
      exitType,
      bucket.length,
      formatPct(breached.length / Math.max(1, bucket.length) * 100),
      formatNum(safeMedian(breached.map(record => record.metrics.firstBreachDay ?? Number.NaN))),
      formatNum(safeMedian(breached.map(record => record.metrics.maxBreachAmount))),
    ];
  });
}

function mechanismRows(records: FullTradeRecord[]): Array<Array<string | number>> {
  return categoricalRows(records.filter(record => record.trade.pnl < 0), record => record.mechanism ?? 'unclassified');
}

function writeReport(
  source: AnalysisSource,
  target: TargetRun,
  validation: ValidationResult,
  replayValidation: { passed: boolean; matches: number; mismatches: number; samples: string[] } | null,
  records: FullTradeRecord[],
): string {
  const losers = records.filter(record => record.trade.pnl < 0);
  const stopAndTimeLosers = records.filter(record => record.trade.pnl < 0 && ['STOP_LOSS', 'TIME_STOP'].includes(record.trade.exitType));
  const winners = records.filter(record => record.trade.pnl > 0);
  const exitBreakdown = buildExitBreakdown(records.map(record => record.trade));
  const counterfactuals: CounterfactualSummary[] = [
    summarizeCounterfactual(records, 'BE_after_100'),
    summarizeCounterfactual(records, 'Lock50_after_100'),
    summarizeCounterfactual(records, 'Exit_on_first_breach'),
    summarizeCounterfactual(records, 'Day21_exit'),
    summarizeCounterfactual(records, 'Combined_plausible'),
  ];
  const bestCounterfactual = [...counterfactuals].sort((a, b) => b.totalPnl - a.totalPnl)[0];
  const viabilityVerdict = bestCounterfactual.totalPnl > 0
    ? `Diagnostic path-level improvement exists (${bestCounterfactual.name} -> ${formatDollar(bestCounterfactual.totalPnl)}), but it still requires a fresh WFA rerun before being trusted as a viable edge.`
    : `No tested path-level counterfactual reached profitability. Strategy remains structurally negative in this 45-65 DTE form.`;
  const inflection = loserInflectionSummary(records);
  const gapExamples = lossPatternRows(records, 'gap');
  const driftExamples = lossPatternRows(records, 'drift');
  const whipsawExamples = lossPatternRows(records, 'whipsaw');
  const lateExamples = lossPatternRows(records, 'late_reversal');
  const worstLosses = [...losers].sort((a, b) => a.trade.pnl - b.trade.pnl).slice(0, 10);
  const highestMfeLosers = topRows(losers, 10, record => record.metrics.MFE);
  const neverBreachTimeStops = records
    .filter(record => record.trade.exitType === 'TIME_STOP' && record.trade.pnl < 0 && record.metrics.firstBreachDay == null)
    .sort((a, b) => a.trade.pnl - b.trade.pnl)
    .slice(0, 10);

  const report = [
    '# Swing Credit Spread Loss Analysis',
    '',
    '## 1. Executive Summary',
    '',
    mdTable(
      ['Question', 'Answer', 'Evidence'],
      [
        ['Can the current strategy be made profitable?', bestCounterfactual.totalPnl > 0 ? 'Maybe, but unproven' : 'No, not from tested path fixes', bestCounterfactual.totalPnl > 0 ? `${bestCounterfactual.name} lifts realized-path PnL to ${formatDollar(bestCounterfactual.totalPnl)}` : `Best tested counterfactual is still ${formatDollar(bestCounterfactual.totalPnl)}`],
        ['Dominant failure mode', 'Large losers after good win rate', `WR ${formatPct(target.oosWinRate)} with total PnL ${formatDollar(target.oosTotalPnl)} and avg winner/loss asymmetry preserved`],
        ['What mostly kills trades?', 'Directional breach + reversals', `${formatPct(losers.filter(record => record.mechanism === 'directional_breach').length / Math.max(1, losers.length) * 100)} directional breach, ${formatPct(losers.filter(record => record.mechanism === 'reversal_after_profit').length / Math.max(1, losers.length) * 100)} reversal-after-profit`],
      ],
    ),
    '',
    viabilityVerdict,
    '',
    '## 2. Data Source and Validation',
    '',
    mdTable(
      ['Metric', 'Value'],
      [
        ['Analysis source', source],
        ['Target run', path.relative(ROOT, TARGET_RUN_PATH)],
        ['CLI', target.metadata.cliCommand],
        ['Target trades', target.allOOSTrades.length],
        ['Target total PnL', formatDollar(target.oosTotalPnl, 0)],
        ['Target OOS Sharpe', formatNum(target.oosSharpe, 2)],
      ],
    ),
    '',
    mdTable(
      ['Check', 'Pass'],
      [
        ['Trade count', validation.aggregateChecks.tradeCount ? 'yes' : 'no'],
        ['Exit breakdown exact', validation.aggregateChecks.exitBreakdown ? 'yes' : 'no'],
        ['Total PnL within $1', validation.aggregateChecks.totalPnl ? 'yes' : 'no'],
        ['OOS Sharpe within 0.01', validation.aggregateChecks.oosSharpe ? 'yes' : 'no'],
        ['Per-window trade counts exact', validation.aggregateChecks.perWindowTradeCounts ? 'yes' : 'no'],
        ['Per-window Sharpe within 0.02', validation.aggregateChecks.perWindowSharpe ? 'yes' : 'no'],
        ['Trade-level exact matches', `${validation.tradeLevelMatches}/${target.allOOSTrades.length}`],
      ],
    ),
    '',
    mdTable(
      ['Window', 'Rerun Trades', 'Target Trades', 'Rerun Sharpe', 'Target Sharpe'],
      validation.perWindow.map(row => [row.windowIndex, row.rerunTrades, row.targetTrades, formatNum(row.rerunSharpe, 2), formatNum(row.targetSharpe, 2)]),
    ),
    '',
    replayValidation
      ? mdTable(
          ['Replay Validation', 'Value'],
          [
            ['Passed', replayValidation.passed ? 'yes' : 'no'],
            ['Matches', replayValidation.matches],
            ['Mismatches', replayValidation.mismatches],
          ],
        )
      : '',
    replayValidation?.samples?.length
      ? ['','Replay mismatch samples:', '', ...replayValidation.samples.map(sample => `- ${sample}`)].join('\n')
      : '',
    validation.mismatchSamples.length
      ? ['','Rerun mismatch samples:', '', ...validation.mismatchSamples.map(sample => `- ${sample}`)].join('\n')
      : '',
    '',
    '## 3. Exit Breakdown and Loss Contribution',
    '',
    mdTable(
      ['Exit Type', 'Count', 'Total PnL', 'P10', 'Median', 'P90'],
      exitContributionRows(records),
    ),
    '',
    mdTable(
      ['Exit Type', 'Count'],
      Object.entries(exitBreakdown).map(([exitType, count]) => [exitType, count]),
    ),
    '',
    '## 4. Path Taxonomy of Losers',
    '',
    mdTable(
      ['Pattern', 'Count', 'Median Hold', 'Median MFE', 'Median MAE', 'Breach Rate', 'Median Worst IV Ratio'],
      (['gap', 'drift', 'whipsaw', 'late_reversal'] as LossPattern[]).map(pattern => {
        const bucket = stopAndTimeLosers.filter(record => record.pattern === pattern);
        return [
          pattern,
          bucket.length,
          formatNum(safeMedian(bucket.map(record => record.trade.holdDays))),
          formatDollar(safeMedian(bucket.map(record => record.metrics.MFE))),
          formatDollar(safeMedian(bucket.map(record => record.metrics.MAE))),
          formatPct(bucket.filter(record => record.metrics.firstBreachDay != null).length / Math.max(1, bucket.length) * 100),
          formatNum(safeMedian(bucket.map(record => record.worstDayState?.shortIvRatio ?? Number.NaN)), 2),
        ];
      }),
    ),
    '',
    'Sensitivity:',
    '',
    mdTable(['Threshold Set', 'Gap', 'Drift', 'Whipsaw', 'Late Reversal'], patternSensitivity(records)),
    '',
    '## 5. MFE / MAE Analysis',
    '',
    mdTable(
      ['Group', 'Count', 'MFE P25', 'MFE Median', 'MFE P75', 'MAE P25', 'MAE Median', 'MAE P75'],
      mfeMaeRows(records),
    ),
    '',
    mdTable(
      ['Group', 'MFE > $50', 'MFE > $100', 'MFE > $150'],
      mfeThresholdRows(records),
    ),
    '',
    mdTable(
      ['Hold Bucket', 'Active Eventual Losers', 'Avg Unrealized PnL'],
      inflection.rows,
    ),
    '',
    `Average-loser cohort inflection day: ${inflection.inflectionDay ?? 'NA'}`,
    '',
    '## 6. Stock-vs-Short-Strike Behavior',
    '',
    mdTable(
      ['Exit Type', 'Count', 'Breach Rate', 'Median First Breach Day', 'Median Max Breach'],
      breachRows(records),
    ),
    '',
    mdTable(
      ['Ticker', 'Entry', 'Exit', 'Exit Type', 'Final PnL', 'Min Dist', 'Worst IV Ratio'],
      neverBreachTimeStops.map(record => [
        record.trade.ticker,
        record.trade.entryDate,
        record.trade.exitDate,
        record.trade.exitType,
        formatDollar(record.trade.pnl),
        formatNum(record.metrics.minDistanceToShort),
        formatNum(record.worstDayState?.shortIvRatio, 2),
      ]),
    ),
    '',
    '## 7. Winner vs Loser Entry Conditions',
    '',
    mdTable(
      ['Feature', 'Winner Median', 'Winner P25/P75', 'Loser Median', 'Loser P25/P75', 'All Median', 'Loss Rate By Quartile'],
      [
        ...numericDistributionTable(records, 'entryDelta', record => Math.abs(record.trade.entryDelta)),
        ...numericDistributionTable(records, 'entryIV', record => record.trade.entryIV),
        ...numericDistributionTable(records, 'entryDTE', record => record.trade.entryDTE),
        ...numericDistributionTable(records, 'spreadWidth', record => record.trade.spreadWidth),
        ...numericDistributionTable(records, 'rewardRiskRatio', record => record.entryFeatures.rewardRiskRatio),
        ...numericDistributionTable(records, 'entryDistancePct', record => record.entryFeatures.entryDistanceToShortPct),
        ...numericDistributionTable(records, 'd8', record => record.entryFeatures.d8),
        ...numericDistributionTable(records, 'prior5dReturn', record => record.entryFeatures.prior5dReturn != null ? record.entryFeatures.prior5dReturn * 100 : undefined),
        ...numericDistributionTable(records, 'prior10dReturn', record => record.entryFeatures.prior10dReturn != null ? record.entryFeatures.prior10dReturn * 100 : undefined),
      ],
    ),
    '',
    'Categorical distributions:',
    '',
    mdTable(['Ticker', 'Count', 'Loss Rate', 'Total PnL'], categoricalRows(records, record => record.trade.ticker)),
    '',
    mdTable(['Direction', 'Count', 'Loss Rate', 'Total PnL'], categoricalRows(records, record => record.trade.direction)),
    '',
    mdTable(['Window', 'Count', 'Loss Rate', 'Total PnL'], categoricalRows(records, record => `W${record.windowIndex}`)),
    '',
    mdTable(['Regime Bucket', 'Count', 'Loss Rate', 'Total PnL'], categoricalRows(records, record => record.regimeBucket)),
    '',
    mdTable(['Preset', 'Count', 'Loss Rate', 'Total PnL'], categoricalRows(records, record => record.tradeConfig.signalWeightPreset ?? 'ema')),
    '',
    mdTable(['Config', 'Count', 'Loss Rate', 'Total PnL'], categoricalRows(records, record => record.tradeConfigLabel).slice(0, 20)),
    '',
    '## 8. Loss Mechanism Diagnosis',
    '',
    mdTable(
      ['Mechanism', 'Count', 'Loss Rate', 'Total PnL'],
      mechanismRows(records),
    ),
    '',
    mdTable(
      ['Question', 'Answer', 'Evidence'],
      [
        ['Directional?', 'Yes', `${formatPct(losers.filter(record => record.mechanism === 'directional_breach').length / Math.max(1, losers.length) * 100)} of losers breach the short strike`],
        ['Vol expansion without breach?', 'Present but secondary', `${formatPct(losers.filter(record => record.mechanism === 'vol_expansion_without_breach').length / Math.max(1, losers.length) * 100)} of losers`],
        ['Reversals after profit?', 'Material', `${formatPct(losers.filter(record => record.mechanism === 'reversal_after_profit').length / Math.max(1, losers.length) * 100)} of losers had MFE >= $100 before failing`],
        ['Structural reward/risk?', 'Still negative', `Avg winner ${formatDollar(average(winners.map(record => record.trade.pnl)), 0)} vs avg loser ${formatDollar(average(losers.map(record => record.trade.pnl)), 0)}`],
      ],
    ),
    '',
    '## 9. Counterfactual Pathway to Profitability',
    '',
    mdTable(
      ['Counterfactual', 'Total PnL', 'Win Rate', 'Affected Trades', 'STOP_LOSS Avoided', 'TIME_STOP Avoided', 'Avg Winner', 'Avg Loser'],
      counterfactuals.map(summary => [
        summary.name,
        formatDollar(summary.totalPnl, 0),
        formatPct(summary.winRate),
        summary.affectedTrades,
        summary.stopLossAvoided,
        summary.timeStopAvoided,
        formatDollar(summary.avgWinner, 0),
        formatDollar(summary.avgLoser, 0),
      ]),
    ),
    '',
    'Counterfactuals are path-level diagnostics on realized trades only. They are not fresh WFA results.',
    '',
    '## 10. Named Example Trades',
    '',
    '### Gap',
    '',
    mdTable(['Ticker', 'Entry', 'Exit', 'Exit Type', 'Window', 'Config', 'Hold', 'Final PnL', 'MFE', 'MAE', 'First Breach', 'Repricing'], gapExamples),
    '',
    '### Drift',
    '',
    mdTable(['Ticker', 'Entry', 'Exit', 'Exit Type', 'Window', 'Config', 'Hold', 'Final PnL', 'MFE', 'MAE', 'First Breach', 'Repricing'], driftExamples),
    '',
    '### Whipsaw',
    '',
    mdTable(['Ticker', 'Entry', 'Exit', 'Exit Type', 'Window', 'Config', 'Hold', 'Final PnL', 'MFE', 'MAE', 'First Breach', 'Repricing'], whipsawExamples),
    '',
    '### Late Reversal',
    '',
    mdTable(['Ticker', 'Entry', 'Exit', 'Exit Type', 'Window', 'Config', 'Hold', 'Final PnL', 'MFE', 'MAE', 'First Breach', 'Repricing'], lateExamples),
    '',
    '### Top 10 Worst Losses',
    '',
    mdTable(
      ['Ticker', 'Entry', 'Exit', 'Exit Type', 'Config', 'Hold', 'Final PnL', 'MFE', 'MAE'],
      worstLosses.map(record => [
        record.trade.ticker,
        record.trade.entryDate,
        record.trade.exitDate,
        record.trade.exitType,
        record.tradeConfigLabel,
        record.trade.holdDays,
        formatDollar(record.trade.pnl),
        formatDollar(record.metrics.MFE),
        formatDollar(record.metrics.MAE),
      ]),
    ),
    '',
    '### Top 10 Losers With Highest Positive MFE Before Failure',
    '',
    mdTable(
      ['Ticker', 'Entry', 'Exit', 'Exit Type', 'Config', 'Hold', 'Final PnL', 'MFE', 'Peak Day', 'First Breach'],
      highestMfeLosers.map(record => [
        record.trade.ticker,
        record.trade.entryDate,
        record.trade.exitDate,
        record.trade.exitType,
        record.tradeConfigLabel,
        record.trade.holdDays,
        formatDollar(record.trade.pnl),
        formatDollar(record.metrics.MFE),
        record.metrics.peakDay,
        record.metrics.firstBreachDay ?? 'NA',
      ]),
    ),
    '',
    '## 11. Final Verdict',
    '',
    mdTable(
      ['Conclusion', 'Evidence', 'Path Forward'],
      [[
        bestCounterfactual.totalPnl > 0 ? 'Potential but unproven path' : 'Structurally dead in current form',
        bestCounterfactual.totalPnl > 0
          ? `${bestCounterfactual.name} is the only tested diagnostic that turns realized-path PnL positive (${formatDollar(bestCounterfactual.totalPnl, 0)}), but it has not survived fresh WFA.`
          : `All tested realized-path fixes remain negative. Losses are dominated by breaches/reversals and the reward-risk ratio still fails.`,
        bestCounterfactual.totalPnl > 0
          ? `Run a fresh WFA with ${bestCounterfactual.name} encoded as an actual exit rule, then re-evaluate sample size and stability.`
          : `Do not pursue further 45-65 DTE swing credit spread optimization without a materially different entry/exit structure.`,
      ]],
    ),
    '',
  ].filter(Boolean).join('\n');

  ensureDir(REPORT_PATH);
  fs.writeFileSync(REPORT_PATH, report);
  return report;
}

function writeFullTrades(records: FullTradeRecord[], source: AnalysisSource): void {
  ensureDir(FULL_TRADES_PATH);
  const payload = {
    generatedAt: new Date().toISOString(),
    source,
    tradeCount: records.length,
    trades: records.map(record => ({
      windowIndex: record.windowIndex,
      regimeBucket: record.regimeBucket,
      tradeConfigLabel: record.tradeConfigLabel,
      bestConfigLabel: record.bestConfigLabel,
      tradeConfig: record.tradeConfig,
      bestConfig: record.bestConfig,
      signal: record.signal,
      trade: record.trade,
      path: record.path,
      stockPath: record.stockPath,
      metrics: record.metrics,
      worstDayState: record.worstDayState,
      entryFeatures: record.entryFeatures,
      pattern: record.pattern,
      patternConfidence: record.patternConfidence,
      mechanism: record.mechanism,
      counterfactuals: record.counterfactuals,
    })),
  };
  fs.writeFileSync(FULL_TRADES_PATH, JSON.stringify(payload, null, 2));
}

function updateHandoff(
  source: AnalysisSource,
  validation: ValidationResult,
  replayValidation: { passed: boolean; matches: number; mismatches: number; samples: string[] } | null,
  records: FullTradeRecord[],
): void {
  const current = fs.readFileSync(HANDOFF_PATH, 'utf8');
  const losers = records.filter(record => record.trade.pnl < 0);
  const stopAndTimeLosers = records.filter(record => record.trade.pnl < 0 && ['STOP_LOSS', 'TIME_STOP'].includes(record.trade.exitType));
  const patternCounts = (['gap', 'drift', 'whipsaw', 'late_reversal'] as LossPattern[])
    .map(pattern => `${pattern} ${stopAndTimeLosers.filter(record => record.pattern === pattern).length}`)
    .join(', ');
  const bestCounterfactual = [
    summarizeCounterfactual(records, 'BE_after_100'),
    summarizeCounterfactual(records, 'Lock50_after_100'),
    summarizeCounterfactual(records, 'Exit_on_first_breach'),
    summarizeCounterfactual(records, 'Day21_exit'),
    summarizeCounterfactual(records, 'Combined_plausible'),
  ].sort((a, b) => b.totalPnl - a.totalPnl)[0];
  const addition = [
    '',
    `### Codex — ${new Date().toISOString()}`,
    '',
    `- Data source: ${source}`,
    `- Validation: rerun passed=${validation.passed}; trade-level exact matches=${validation.tradeLevelMatches}/${validation.targetTradeCount}; replay fallback ${replayValidation ? `passed=${replayValidation.passed}` : 'not used'}`,
    `- Dominant loss patterns (STOP_LOSS + losing TIME_STOP): ${patternCounts}`,
    `- MFE findings: losers with MFE > $50 = ${formatPct(losers.filter(record => record.metrics.MFE > 50).length / Math.max(1, losers.length) * 100)}; > $100 = ${formatPct(losers.filter(record => record.metrics.MFE > 100).length / Math.max(1, losers.length) * 100)}`,
    `- Breach / IV: loser breach rate ${formatPct(losers.filter(record => record.metrics.firstBreachDay != null).length / Math.max(1, losers.length) * 100)}; non-breach losers with short IV ratio >= 1.2 = ${losers.filter(record => (record.metrics.firstBreachDay == null) && (record.worstDayState?.shortIvRatio ?? 0) >= 1.2).length}`,
    `- Best counterfactual: ${bestCounterfactual.name} -> ${formatDollar(bestCounterfactual.totalPnl, 0)} total PnL, affected ${bestCounterfactual.affectedTrades} trades`,
    `- Verdict: ${bestCounterfactual.totalPnl > 0 ? 'path worth fresh WFA test, but not yet proven' : 'strategy remains structurally dead in current 45-65 DTE form'}`,
  ].join('\n');
  fs.writeFileSync(HANDOFF_PATH, `${current.trimEnd()}\n${addition}\n`);
}

async function main(): Promise<void> {
  const target = loadJson<TargetRun>(TARGET_RUN_PATH);
  const rerun = await rebuildFromLocalCaches(target);

  let source: AnalysisSource;
  let records: EnrichedTrade[];
  let replayValidation: { passed: boolean; matches: number; mismatches: number; samples: string[] } | null = null;

  if (rerun.validation.passed) {
    source = 'validated_rerun';
    records = rerun.enrichedTrades;
  } else {
    console.log('Rerun validation failed; attempting replay fallback...');
    const targetWindowReplay = buildReplayRecordsFromTargetWindows(target, rerun.allTradingDates);
    replayValidation = validateReplay(targetWindowReplay, target);
    if (replayValidation.passed) {
      source = 'validated_replay';
      records = targetWindowReplay;
    } else {
      console.log('Target-window replay failed; attempting local-signal replay fallback...');
      const replayRecords = buildReplayRecords(target, rerun.preparedWindows, rerun.allTradingDates);
      replayValidation = validateReplay(replayRecords, target);
      if (!replayValidation.passed) {
        console.error('Rerun validation summary:', JSON.stringify(rerun.validation, null, 2));
        console.error('Replay validation summary:', JSON.stringify(replayValidation, null, 2));
        throw new Error(`Replay fallback failed validation (${replayValidation.matches} matches / ${target.allOOSTrades.length})`);
      }
      source = 'validated_replay';
      records = replayRecords;
    }
  }

  const analyzed = buildAnalyzedTrades(records, source);
  writeFullTrades(analyzed, source);
  writeReport(source, target, rerun.validation, replayValidation, analyzed);
  updateHandoff(source, rerun.validation, replayValidation, analyzed);
  closeDB();
  console.log(`Report written: ${path.relative(ROOT, REPORT_PATH)}`);
  console.log(`Sidecar written: ${path.relative(ROOT, FULL_TRADES_PATH)}`);
}

main().catch(error => {
  closeDB();
  console.error(error);
  process.exit(1);
});
