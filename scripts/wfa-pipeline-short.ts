/**
 * Short-Term Credit Spread Pipeline (7-21 DTE, 130M monitoring)
 *
 * Mirrors wfa-pipeline-swing.ts architecture but uses:
 *  - Intraday 130M candles + BSM repricing (via evaluateCreditSpread4H)
 *  - Period multiplier sweep (2.25, 3.0, 3.75)
 *  - Signal keying by multiplier|preset
 *
 * Called from wfa-run-unified.ts --profile short.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { Worker } from 'node:worker_threads';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { SIGNAL_PRESETS, DIR_CONF_THRESHOLDS } from '../src/lib/backtest/types';
import type { FillMode, DirConfTier } from '../src/lib/backtest/types';
import {
  initDB,
  closeDB,
  getCachedChain,
  findSpreadStrikes,
  findContractDirect,
} from '../src/lib/backtest/chain-cache';
import { initIntradayDB, get130MCandles, aggregateToDaily, type IntradayCandle } from '../src/lib/backtest/intraday-cache';
import {
  precomputeSignals4H,
  type IVDataRow,
  type PeriodMultiplier,
  PERIOD_MULTIPLIERS_130M,
} from '../src/lib/backtest/intraday-signals';
import {
  DEFAULT_SHORT_CREDIT_CONFIG,
  computeOptionAnalytics,
  type EntrySignal,
  type OptionTrade,
  type SimConfig,
  type SignalPresetKey,
} from '../src/lib/backtest/option-sim';
import { computeIVRankMinMax } from '../src/lib/backtest/iv-rank';
import { evaluateCreditSpread4H } from '../src/lib/backtest/intraday-monitor';
import { applyFill } from '../src/lib/backtest/slippage';
import {
  buildWFAWindows,
  computePortfolioDailyMetrics,
  evaluateSignalsWithConstraints,
  executePreparedOOSWindowsWithCarry,
  type PortfolioExecutionConfig,
  type PreparedOOSWindowExecution,
  type WFAResult,
  type WFAWindow,
} from '../src/lib/backtest/wfa-options';
import { signalMapKey } from '../src/lib/backtest/wfa-v3-orchestrator';
import { loadIVDataFromOptionChainCache } from './wfa-local-cache';

// ── Config Types ────────────────────────────────────────

export interface ShortPipelineConfig {
  tickers: string[];
  dataStart: string;
  startDate: string;
  endDate: string;
  trainWindowDays: number;
  forwardStepDays: number;
  purgeGapDays: number;
  mode: 'rolling' | 'anchored';
  maxPositions: number;
  maxPerTicker: number;
  startingCapital: number;
  fillMode: FillMode;
  numWorkers: number;
  presets: SignalPresetKey[];
  periodMultipliers?: PeriodMultiplier[];
  /** Override sweep grid dimensions */
  sweepOverrides?: Partial<ShortSweepDimensions>;
}

export interface ShortSweepDimensions {
  presets?: SignalPresetKey[];
  profitTargets: number[];
  spreadWidths: number[];
  ivRankMins: number[];
  deltaStops: number[];
  timeStopDTEs: number[];
  dirConfTiers?: DirConfTier[];
  creditShortDeltas?: number[];
  creditDTERanges?: [number, number][];
  vrpFilters?: number[];
  contangoFilters?: number[];
  vrpPctFilters?: number[];
  contangoPctFilters?: number[];
  periodMultipliers?: PeriodMultiplier[];
}

export const SHORT_DEFAULTS = {
  tickers: [
    'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA',
    'AAPL', 'JPM', 'NVDA', 'AMZN', 'MSFT',
    'META', 'NFLX', 'GOOG', 'GS', 'COST',
  ],
  dataStart: '2023-01-01',
  startDate: '2024-03-01',
  endDate: '2026-02-28',
  trainWindowDays: 189,
  forwardStepDays: 42,
  purgeGapDays: 14,
  mode: 'rolling' as const,
  maxPositions: 10,
  maxPerTicker: 5,
  startingCapital: 100_000,
  fillMode: 'mid' as FillMode,
  presets: ['ema', 'mom', 'em', 'vol'] as SignalPresetKey[],
  periodMultipliers: [2.25, 3.0, 3.75] as PeriodMultiplier[],
};

export const SHORT_SWEEP_DEFAULTS: ShortSweepDimensions = {
  profitTargets: [0.30, 0.50],
  spreadWidths: [2.5, 5, 10],
  ivRankMins: [20, 30],
  deltaStops: [0.65, Infinity],  // Infinity = deltaStop off
  timeStopDTEs: [1],
  periodMultipliers: [2.25, 3.0, 3.75],
};

interface VolRegime {
  vrp?: number;
  contango?: number;
  vrpPct?: number;
  contangoPct?: number;
}

function percentileRank(values: number[], value: number): number | undefined {
  if (values.length === 0 || !Number.isFinite(value)) return undefined;
  const countLTE = values.filter(v => v <= value).length;
  return (countLTE / values.length) * 100;
}

function buildVolRegimeByDate(ivData: IVDataRow[], lookback = 252): Map<string, VolRegime> {
  const regimes = new Map<string, VolRegime>();
  const vrpHistory: number[] = [];
  const contangoHistory: number[] = [];

  for (const row of ivData) {
    const iv30 = row.iv30d;
    const iv60 = row.iv60d;
    const hv20 = row.hv20d;
    const vrp = iv30 != null && hv20 != null ? (iv30 * iv30) - (hv20 * hv20) : undefined;
    const contango = iv30 != null && iv60 != null && iv30 > 0 ? (iv60 / iv30) - 1 : undefined;

    regimes.set(row.date, {
      vrp,
      contango,
      vrpPct: vrp != null ? percentileRank(vrpHistory.slice(-lookback), vrp) : undefined,
      contangoPct: contango != null ? percentileRank(contangoHistory.slice(-lookback), contango) : undefined,
    });

    if (vrp != null && Number.isFinite(vrp)) vrpHistory.push(vrp);
    if (contango != null && Number.isFinite(contango)) contangoHistory.push(contango);
  }

  return regimes;
}

// ── Data Helpers ────────────────────────────────────────

interface TickerData {
  ticker: string;
  candles130m: IntradayCandle[];
  dailyCandles: IntradayCandle[];
  ivData: IVDataRow[];
  ivRanks: (number | null)[];
  dateToIdx: Map<string, number>;
}

export async function fetchTickerData(ticker: string, dataStart: string, dataEnd: string, intradayDb: any): Promise<TickerData> {
  const candles130m = get130MCandles(intradayDb, ticker, dataStart, dataEnd);
  const dailyCandles = aggregateToDaily(candles130m);

  const ivData: IVDataRow[] = loadIVDataFromOptionChainCache({
    ticker,
    startDate: dataStart,
    endDate: dataEnd,
    chainDbPath: process.env.WFA_CHAIN_DB_PATH,
    dailyCandles,
  });

  const ivByDate = new Map(ivData.map(r => [r.date, r.iv30d]));
  const ivSeries = dailyCandles.map(c => ivByDate.get(c.date) ?? null);
  const ivRanks = computeIVRankMinMax(ivSeries);
  const dateToIdx = new Map(dailyCandles.map((c, i) => [c.date, i]));

  return { ticker, candles130m, dailyCandles, ivData, ivRanks, dateToIdx };
}

// ── Signal Generation ────────────────────────────────────

function generateSignalsForPreset(
  td: TickerData,
  presetKey: SignalPresetKey,
  periodMultiplier: PeriodMultiplier,
  periodStart: string,
  periodEnd: string,
): EntrySignal[] {
  const techOptions = SIGNAL_PRESETS[presetKey];
  const signals = precomputeSignals4H(td.candles130m, td.ivData, periodMultiplier, techOptions);
  const entries: EntrySignal[] = [];
  const volRegimeByDate = buildVolRegimeByDate(td.ivData);

  for (const sig of signals) {
    const barDate = sig.date.split('T')[0].split(' ')[0];
    if (barDate < periodStart || barDate > periodEnd) continue;
    if (sig.type === 'NEUTRAL' || sig.score < 65) continue;
    if (sig.adx !== undefined && sig.adx < 8) continue;

    const idx = td.dateToIdx.get(barDate);
    const volRegime = volRegimeByDate.get(barDate);
    entries.push({
      ticker: td.ticker,
      date: barDate,
      direction: sig.type as 'CALL' | 'PUT',
      score: sig.score,
      ivRank: idx != null ? (td.ivRanks[idx] ?? undefined) : undefined,
      hv60: sig.ivEstimate60,
      oratsIV60: sig.oratsIV60,
      vrp: volRegime?.vrp,
      contango: volRegime?.contango,
      vrpPct: volRegime?.vrpPct,
      contangoPct: volRegime?.contangoPct,
      indicatorPeriodMultiplier: periodMultiplier,
      dirConfidence: sig.subScores
        ? Math.round(Object.values(sig.subScores).filter(v => v > 50).length / Object.values(sig.subScores).length * 100)
        : undefined,
    });
  }

  // Deduplicate: keep highest-score signal per ticker|date|direction
  const deduped = new Map<string, EntrySignal>();
  for (const entry of entries) {
    const key = `${entry.ticker}|${entry.date}|${entry.direction}`;
    if (!deduped.has(key) || entry.score > deduped.get(key)!.score) {
      deduped.set(key, entry);
    }
  }
  return [...deduped.values()];
}

// ── Sweep Grid ──────────────────────────────────────────

export function buildSweepCandidates(
  fillMode: FillMode,
  dims: ShortSweepDimensions,
  maxPositions: number = 10,
  maxPerTicker: number = 5,
): SimConfig[] {
  const candidates: SimConfig[] = [];
  const presets = dims.presets ?? ['ema', 'mom', 'em', 'vol'];
  const dirConfTiers: (DirConfTier | undefined)[] = dims.dirConfTiers ?? [undefined];
  const shortDeltas: (number | undefined)[] = dims.creditShortDeltas ?? [undefined];
  const periodMults: PeriodMultiplier[] = dims.periodMultipliers ?? [2.25, 3.0, 3.75];
  const dteRanges = dims.creditDTERanges ?? [[7, 21] as [number, number]];
  const vrpFilters = dims.vrpFilters ?? [undefined];
  const contangoFilters = dims.contangoFilters ?? [undefined];
  const vrpPctFilters = dims.vrpPctFilters ?? [undefined];
  const contangoPctFilters = dims.contangoPctFilters ?? [undefined];

  for (const preset of presets) {
    for (const width of dims.spreadWidths) {
      for (const tp of dims.profitTargets) {
        for (const ivMin of dims.ivRankMins) {
          for (const deltaStop of dims.deltaStops) {
            for (const ts of dims.timeStopDTEs) {
              for (const dct of dirConfTiers) {
                for (const delta of shortDeltas) {
                  for (const dteRange of dteRanges) {
                    for (const vrpFilter of vrpFilters) {
                      for (const contangoFilter of contangoFilters) {
                        for (const vrpPctFilter of vrpPctFilters) {
                          for (const contangoPctFilter of contangoPctFilters) {
                            for (const periodMult of periodMults) {
                              candidates.push({
                                ...DEFAULT_SHORT_CREDIT_CONFIG,
                                creditDTERange: dteRange,
                                creditSpreadWidth: width,
                                creditProfitTarget: tp,
                                creditStopLossMultiple: 100,
                                creditTimeStopDTE: ts,
                                creditDeltaStop: deltaStop === Infinity ? 0 : deltaStop,
                                minIVRank: ivMin,
                                signalWeightPreset: preset,
                                dirConfTier: dct,
                                fillMode,
                                maxPerTicker,
                                maxPositions,
                                indicatorPeriodMultiplier: periodMult,
                                bsmKappa: 4.0,
                                bsmRiskFreeRate: 0.04,
                                dailyCalibration: true,
                                ivThetaSource: 'hv60',
                                ...(delta != null ? { creditShortDelta: delta } : {}),
                                ...(vrpFilter != null ? { vrpFilter } : {}),
                                ...(contangoFilter != null ? { contangoFilter } : {}),
                                ...(vrpPctFilter != null ? { vrpPctFilter } : {}),
                                ...(contangoPctFilter != null ? { contangoPctFilter } : {}),
                              } as SimConfig);
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

// ── 4H Evaluator ────────────────────────────────────────

type TradeEvaluator = (signal: EntrySignal, config: SimConfig, allTradingDates: string[], maxDate: string) => OptionTrade | null;

function makeEvaluator(
  tickerDataMap: Map<string, TickerData>,
  fillMode: FillMode,
): TradeEvaluator {
  return (signal, config, tradingDates, maxDate) => {
    const td = tickerDataMap.get(signal.ticker);
    if (!td) return null;

    // dirConfTier gate (mirrors swing pipeline)
    if (config.dirConfTier && config.dirConfTier !== 'any' && signal.dirConfidence != null) {
      if (signal.dirConfidence < DIR_CONF_THRESHOLDS[config.dirConfTier]) return null;
    }

    return evaluateCreditSpread4H(
      signal,
      config,
      td.candles130m,
      tradingDates,
      maxDate,
      {
        getChain: (ticker, date) => getCachedChain(ticker, date),
        findSpread: (chain, shortDelta, width, type, dteRange) =>
          findSpreadStrikes(chain, shortDelta, width, type as 'Call' | 'Put', dteRange),
        findContract: (ticker, date, strike, expiry, type) =>
          findContractDirect(ticker, date, strike, expiry, type as 'Call' | 'Put'),
        applyFillFn: (mid, bid, ask, side, cfg, oi, dte) =>
          applyFill(fillMode, mid, bid, ask, side, cfg, oi, dte),
      },
    );
  };
}

// ── Worker Pool ─────────────────────────────────────────

interface ShortTrainWorkerInit {
  signalsByMultPreset: Record<string, EntrySignal[]>;
  tickerCandles130m: Record<string, IntradayCandle[]>;
  allTradingDates: string[];
  fillMode: FillMode;
  executionConfig: PortfolioExecutionConfig;
}

interface ShortTrainWorkItem {
  id: number;
  configIdx: number;
  config: SimConfig;
  trainStart: string;
  trainEnd: string;
}

interface ShortTrainWorkResult {
  type: 'result';
  id: number;
  configIdx: number;
  sharpe: number;
  trades: number;
  error?: string;
}

type ShortTrainWorkRunner = (
  workers: Worker[],
  workItems: ShortTrainWorkItem[],
  label: string,
) => Promise<ShortTrainWorkResult[]>;

function buildShortTrainWorkerBundle(): string {
  const workerSrc = path.resolve(__dirname, 'wfa-short-train-worker.ts');
  const workerBundle = path.resolve(__dirname, '.wfa-short-train-worker.mjs');
  execSync(
    `npx esbuild ${workerSrc} --bundle --platform=node --format=esm --outfile=${workerBundle} --external:better-sqlite3 --packages=external`,
    { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' },
  );
  return workerBundle;
}

async function createTrainWorkerPool(init: ShortTrainWorkerInit, numWorkers: number): Promise<Worker[]> {
  const workerBundle = buildShortTrainWorkerBundle();
  const workerCount = Math.max(1, Math.min(numWorkers, os.cpus().length));

  return Promise.all(
    Array.from({ length: workerCount }, () =>
      new Promise<Worker>((resolve, reject) => {
        const worker = new Worker(workerBundle, { workerData: init });
        worker.once('message', (msg) => {
          if (msg?.type === 'ready') resolve(worker);
          else reject(new Error('Short train worker failed to initialize'));
        });
        worker.once('error', reject);
      }),
    ),
  );
}

async function terminateTrainWorkerPool(workers: Worker[]) {
  for (const worker of workers) worker.postMessage({ type: 'exit' });
  await new Promise(resolve => setTimeout(resolve, 100));
  await Promise.all(workers.map(worker => worker.terminate()));
}

async function runParallelTrainWork(
  workers: Worker[],
  workItems: ShortTrainWorkItem[],
  label: string,
): Promise<ShortTrainWorkResult[]> {
  const results: ShortTrainWorkResult[] = new Array(workItems.length);
  let nextIdx = 0;
  let completed = 0;

  return new Promise((resolve, reject) => {
    const handlers = new Map<Worker, (msg: ShortTrainWorkResult) => void>();
    const errorHandlers = new Map<Worker, (err: Error) => void>();

    const cleanup = () => {
      for (const worker of workers) {
        const handler = handlers.get(worker);
        const errorHandler = errorHandlers.get(worker);
        if (handler) worker.off('message', handler);
        if (errorHandler) worker.off('error', errorHandler);
      }
    };

    const assignNext = (worker: Worker) => {
      const next = workItems[nextIdx++];
      if (next) worker.postMessage(next);
    };

    for (const worker of workers) {
      const handler = (msg: ShortTrainWorkResult) => {
        if (!msg || msg.type !== 'result') return;
        if (msg.error || !Number.isFinite(msg.sharpe)) {
          cleanup();
          reject(new Error(msg.error ?? `Worker ${msg.id} returned no train result`));
          return;
        }
        results[msg.id] = msg;
        completed++;
        if (completed === workItems.length || completed % 25 === 0) {
          process.stdout.write(`\r  Train ${label}: ${completed}/${workItems.length}`);
        }
        if (completed === workItems.length) {
          process.stdout.write('\n');
          cleanup();
          resolve(results);
          return;
        }
        assignNext(worker);
      };
      const errorHandler = (err: Error) => {
        cleanup();
        reject(err);
      };
      handlers.set(worker, handler);
      errorHandlers.set(worker, errorHandler);
      worker.on('message', handler);
      worker.on('error', errorHandler);
    }

    for (const worker of workers) {
      assignNext(worker);
    }
  });
}

function resolveShortSignalKey(config: SimConfig): string {
  const presetKey = config.signalWeightPreset ?? 'ema';
  const periodMult = (config as any).indicatorPeriodMultiplier ?? 2.25;
  return signalMapKey(periodMult, presetKey);
}

function buildShortConfiguredSignals(
  signalsByMultPreset: Map<string, EntrySignal[]>,
  config: SimConfig,
  oosStart: string,
  oosEnd: string,
) {
  const signals = signalsByMultPreset.get(resolveShortSignalKey(config)) ?? [];
  return signals
    .filter(signal => signal.date >= oosStart && signal.date <= oosEnd)
    .map(signal => ({ signal, config }));
}

function buildShortExecutionConfig(config: ShortPipelineConfig): PortfolioExecutionConfig {
  return {
    maxPositions: config.maxPositions,
    maxPerTicker: config.maxPerTicker,
    startingCapital: config.startingCapital,
  };
}

function finalizeShortWFAResult(
  preparedWindows: PreparedOOSWindowExecution[],
  allTradingDates: string[],
  evaluator: TradeEvaluator,
  config: ShortPipelineConfig,
  elapsedMs: number,
): WFAResult {
  const executionConfig = buildShortExecutionConfig(config);
  const { windows, allOOSTrades } = executePreparedOOSWindowsWithCarry(
    preparedWindows,
    executionConfig,
    allTradingDates,
    config.endDate,
    evaluator,
    'strict',
    config.startingCapital,
  );
  const oosAllAnalytics = computeOptionAnalytics(allOOSTrades);
  const allPortfolioMetrics = computePortfolioDailyMetrics(
    allOOSTrades, allTradingDates, config.startDate, config.endDate, config.startingCapital,
  );
  const avgTrainSharpe = windows.length > 0
    ? windows.reduce((sum, window) => sum + window.bestTrainSharpe, 0) / windows.length
    : 0;

  return {
    config: {
      trainWindowDays: config.trainWindowDays,
      forwardStepDays: config.forwardStepDays,
      purgeGapDays: config.purgeGapDays,
      mode: config.mode,
      startDate: config.startDate,
      endDate: config.endDate,
      tickers: config.tickers,
      startingCapital: config.startingCapital,
    } as any,
    windows,
    allOOSTrades,
    oosEquityCurve: allPortfolioMetrics.equityCurve,
    oosSharpe: allPortfolioMetrics.sharpe,
    oosWinRate: oosAllAnalytics.winRate,
    oosMaxDD: allPortfolioMetrics.maxDrawdownPct,
    oosTotalPnl: allOOSTrades.reduce((sum, trade) => sum + trade.pnl, 0),
    wfEfficiency: avgTrainSharpe >= 0.1 ? allPortfolioMetrics.sharpe / avgTrainSharpe : 0,
    elapsedMs,
  };
}

// The short pipeline currently ranks candidates by exact train-window Sharpe only.
// This is intentional for Phase B parity with the pre-existing short methodology;
// unlike the swing path, it does not yet apply DSR / robustness guards.
function prepareShortWindowsSingleThread(
  candidates: SimConfig[],
  signalsByMultPreset: Map<string, EntrySignal[]>,
  allTradingDates: string[],
  windowDefs: { trainStart: string; trainEnd: string; oosStart: string; oosEnd: string }[],
  evaluator: TradeEvaluator,
  config: ShortPipelineConfig,
): PreparedOOSWindowExecution[] {
  const executionConfig = buildShortExecutionConfig(config);
  const preparedWindows: PreparedOOSWindowExecution[] = [];

  for (let wi = 0; wi < windowDefs.length; wi++) {
    const w = windowDefs[wi];
    process.stdout.write(`\r  Window ${wi + 1}/${windowDefs.length}...`);

    let bestTrainSharpe = -Infinity;
    let bestIdx = 0;
    let bestConfig: SimConfig = candidates[0];

    for (let ci = 0; ci < candidates.length; ci++) {
      const candidate = candidates[ci];
      const signals = signalsByMultPreset.get(resolveShortSignalKey(candidate)) ?? [];

      const trainSignals = signals.filter(s => s.date >= w.trainStart && s.date <= w.trainEnd);
      const trainTrades = evaluateSignalsWithConstraints(
        trainSignals,
        candidate,
        executionConfig,
        allTradingDates,
        w.trainEnd,
        evaluator,
      );
      const trainSharpe = computePortfolioDailyMetrics(
        trainTrades,
        allTradingDates,
        w.trainStart,
        w.trainEnd,
        config.startingCapital,
      ).sharpe;

      if (trainSharpe > bestTrainSharpe || (trainSharpe === bestTrainSharpe && ci < bestIdx)) {
        bestTrainSharpe = trainSharpe;
        bestIdx = ci;
        bestConfig = candidate;
      }
    }

    process.stdout.write(`\r  ${wi + 1}/${windowDefs.length}: ${candidates.length} configs...\n`);

    preparedWindows.push({
      windowIndex: wi,
      trainStart: w.trainStart,
      trainEnd: w.trainEnd,
      oosStart: w.oosStart,
      oosEnd: w.oosEnd,
      bestConfig: bestConfig as any,
      selectedConfigs: [bestConfig],
      bestTrainSharpe,
      configuredSignals: buildShortConfiguredSignals(signalsByMultPreset, bestConfig, w.oosStart, w.oosEnd),
    });
  }

  return preparedWindows;
}

async function prepareShortWindowsParallel(
  workers: Worker[],
  candidates: SimConfig[],
  signalsByMultPreset: Map<string, EntrySignal[]>,
  windowDefs: { trainStart: string; trainEnd: string; oosStart: string; oosEnd: string }[],
  runTrainWork: ShortTrainWorkRunner = runParallelTrainWork,
): Promise<PreparedOOSWindowExecution[]> {
  const preparedWindows: PreparedOOSWindowExecution[] = [];

  for (let wi = 0; wi < windowDefs.length; wi++) {
    const w = windowDefs[wi];
    const trainItems: ShortTrainWorkItem[] = candidates.map((config, idx) => ({
      id: idx,
      configIdx: idx,
      config,
      trainStart: w.trainStart,
      trainEnd: w.trainEnd,
    }));
    const trainResults = await runTrainWork(
      workers,
      trainItems,
      `${wi + 1}/${windowDefs.length}`,
    );
    const ranked = [...trainResults].sort((a, b) =>
      b.sharpe - a.sharpe ||
      a.configIdx - b.configIdx
    );
    const best = ranked[0];
    const bestConfig = candidates[best?.configIdx ?? 0] ?? candidates[0];

    preparedWindows.push({
      windowIndex: wi,
      trainStart: w.trainStart,
      trainEnd: w.trainEnd,
      oosStart: w.oosStart,
      oosEnd: w.oosEnd,
      bestConfig,
      selectedConfigs: [bestConfig],
      bestTrainSharpe: best?.sharpe ?? 0,
      configuredSignals: buildShortConfiguredSignals(signalsByMultPreset, bestConfig, w.oosStart, w.oosEnd),
    });
  }

  return preparedWindows;
}

export const __testHooks = {
  buildShortExecutionConfig,
  prepareShortWindowsSingleThread,
  prepareShortWindowsParallel,
  resolveShortSignalKey,
};

// ── Reporting ────────────────────────────────────────────

function formatPct(v: number, decimals = 1): string {
  return v.toFixed(decimals) + '%';
}

function configSummary(config: any): string {
  const preset = config.signalWeightPreset ?? config.preset ?? 'ema';
  const delta = config.creditShortDelta ?? config.delta ?? 0.35;
  const tp = config.creditProfitTarget ?? config.tp ?? 0.30;
  const width = config.creditSpreadWidth ?? config.width ?? 5;
  const ivMin = config.minIVRank ?? config.ivMin ?? 0;
  const periodMult = config.indicatorPeriodMultiplier ?? 2.0;
  const dteRange = config.creditDTERange ? `/dte${config.creditDTERange[0]}-${config.creditDTERange[1]}` : '';
  const deltaStop = config.creditDeltaStop ?? 0;
  const dsStr = deltaStop > 0 ? `ds${deltaStop}` : 'dsOff';
  const dct = config.dirConfTier ? `/dc${config.dirConfTier}` : '';
  const vrpPct = config.vrpPctFilter != null ? `/vrpPct${config.vrpPctFilter}` : '';
  const contangoPct = config.contangoPctFilter != null ? `/contPct${config.contangoPctFilter}` : '';
  return `${preset}/d${delta}/tp${(Number(tp) * 100).toFixed(0)}/w${width}/iv${ivMin}/${dsStr}/pm${periodMult}${dteRange}${dct}${vrpPct}${contangoPct}`;
}

function printShortReport(result: WFAResult, config: ShortPipelineConfig) {
  console.log('\n' + '═'.repeat(80));
  console.log('  WALK-FORWARD ANALYSIS RESULTS (SHORT-TERM 4H)');
  console.log('═'.repeat(80));

  console.log(`\n  Mode: ${config.mode.toUpperCase()}`);
  console.log(`  Period: ${config.startDate} → ${config.endDate}`);
  console.log(`  Train: ${config.trainWindowDays}d | Step: ${config.forwardStepDays}d | Purge: ${config.purgeGapDays}d`);
  console.log(`  Tickers: ${config.tickers.join(', ')}`);
  console.log(`  Capital: $${config.startingCapital.toLocaleString()}`);
  console.log(`  Fill mode: ${config.fillMode}`);
  console.log(`  Elapsed: ${(result.elapsedMs / 1000).toFixed(1)}s`);

  console.log('\n' + '─'.repeat(80));
  console.log('  AGGREGATE OOS METRICS');
  console.log('─'.repeat(80));
  console.log(`  Sharpe:       ${result.oosSharpe.toFixed(2)}`);
  console.log(`  Win Rate:     ${formatPct(result.oosWinRate)}`);
  console.log(`  Max DD:       ${formatPct(result.oosMaxDD)}`);
  console.log(`  Total P&L:    $${result.oosTotalPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`  ROC:          ${formatPct((result.oosTotalPnl / config.startingCapital) * 100)}`);
  console.log(`  WF Efficiency: ${result.wfEfficiency.toFixed(2)}`);
  console.log(`  OOS Trades:   ${result.allOOSTrades.length}`);

  console.log('\n' + '─'.repeat(80));
  console.log('  PER-WINDOW BREAKDOWN');
  console.log('─'.repeat(80));
  console.log('  #  Train Period          OOS Period            Train    OOS     OOS    OOS   Best Config');
  console.log('     Start    → End        Start    → End        Sharpe   Sharpe  WR%    Trd   (preset/d/tp/w/iv/ds/pm)');
  console.log('  ' + '·'.repeat(94));

  for (let i = 0; i < result.windows.length; i++) {
    const w = result.windows[i];
    console.log(
      `  ${String(i).padStart(2)}  ${w.trainStart} → ${w.trainEnd}  ${w.oosStart} → ${w.oosEnd}` +
      `  ${w.bestTrainSharpe.toFixed(2).padStart(6)}  ${w.oosSharpe.toFixed(2).padStart(6)}  ${formatPct(w.oosWinRate).padStart(5)}  ${String(w.oosTrades.length).padStart(4)}   ${configSummary(w.bestConfig)}`,
    );
  }

  // Exit type breakdown
  if (result.allOOSTrades.length > 0) {
    const byExit: Record<string, number> = {};
    for (const trade of result.allOOSTrades) {
      byExit[trade.exitType] = (byExit[trade.exitType] ?? 0) + 1;
    }
    console.log('\n' + '─'.repeat(80));
    console.log('  EXIT TYPE BREAKDOWN');
    console.log('─'.repeat(80));
    for (const [type, count] of Object.entries(byExit).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${type.padEnd(20)} ${count} (${formatPct((count / result.allOOSTrades.length) * 100)})`);
    }
  }

  // Trade frequency
  const windows = result.windows;
  if (windows.length > 0) {
    const avgTradesPerWeek = windows.reduce((sum, w) => {
      const ms = new Date(w.oosEnd).getTime() - new Date(w.oosStart).getTime();
      const weeks = Math.max(1, ms / (7 * 86400000));
      return sum + w.oosTrades.length / weeks;
    }, 0) / windows.length;
    console.log('\n' + '─'.repeat(80));
    console.log('  TRADE FREQUENCY');
    console.log('─'.repeat(80));
    console.log(`  Avg trades/week (OOS): ${avgTradesPerWeek.toFixed(1)}`);
  }

  // Equity curve endpoints
  if (result.oosEquityCurve.length > 0) {
    const first = result.oosEquityCurve[0];
    const last = result.oosEquityCurve[result.oosEquityCurve.length - 1];
    console.log('\n' + '─'.repeat(80));
    console.log('  EQUITY CURVE');
    console.log('─'.repeat(80));
    console.log(`  Start: $${config.startingCapital.toLocaleString()} (${first.date})`);
    console.log(`  End:   $${last.equity.toLocaleString(undefined, { maximumFractionDigits: 0 })} (${last.date})`);
  }
  console.log('\n' + '═'.repeat(80) + '\n');
}

// ── Main Pipeline ────────────────────────────────────────

export interface ShortPipelineResult {
  wfa: WFAResult;
  chainCacheStats: { hits: number; misses: number };
  evaluator: TradeEvaluator;
  allTradingDates: string[];
}

let intradayDb: any = null;

export async function runShortPipeline(config: ShortPipelineConfig): Promise<ShortPipelineResult> {
  const pipelineT0 = Date.now();
  console.log('WFA Unified — Short-Term Credit Spread Pipeline (4H)');
  console.log('─'.repeat(60));

  // 1. Init chain + intraday DBs
  initDB();
  closeDB();
  intradayDb = initIntradayDB();

  try {
    // 2. Fetch ticker data
    console.log(`\nFetching intraday data for ${config.tickers.length} tickers...`);
    const tickerDataMap = new Map<string, TickerData>();
    for (const ticker of config.tickers) {
      const td = await fetchTickerData(ticker, config.dataStart, config.endDate, intradayDb);
      tickerDataMap.set(ticker, td);
      process.stdout.write(` ${ticker}(${td.candles130m.length})`);
    }
    console.log(' done.');

    // 3. Build trading dates
    const allDatesSet = new Set<string>();
    for (const td of tickerDataMap.values()) {
      for (const candle of td.dailyCandles) {
        if (candle.date >= config.startDate && candle.date <= config.endDate) allDatesSet.add(candle.date);
      }
    }
    const allTradingDates = [...allDatesSet].sort();
    console.log(`Trading dates: ${allTradingDates.length} (${allTradingDates[0]} → ${allTradingDates[allTradingDates.length - 1]})`);

    // 4. Generate signals per multiplier|preset
    const periodMultipliers = config.periodMultipliers ?? SHORT_DEFAULTS.periodMultipliers;
    const presets = config.presets;
    console.log('\nGenerating 4H signals per preset and period multiplier...');
    const signalsByMultPreset = new Map<string, EntrySignal[]>();
    for (const periodMultiplier of periodMultipliers) {
      for (const preset of presets) {
        const allSignals: EntrySignal[] = [];
        for (const td of tickerDataMap.values()) {
          allSignals.push(...generateSignalsForPreset(td, preset, periodMultiplier, config.startDate, config.endDate));
        }
        allSignals.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));
        signalsByMultPreset.set(signalMapKey(periodMultiplier, preset), allSignals);
        console.log(`  ${signalMapKey(periodMultiplier, preset)}: ${allSignals.length} signals`);
      }
    }

    // 5. Build WFA windows
    const windowDefs = buildWFAWindows(allTradingDates, {
      trainWindowDays: config.trainWindowDays,
      forwardStepDays: config.forwardStepDays,
      purgeGapDays: config.purgeGapDays,
      mode: config.mode,
      startDate: config.startDate,
      endDate: config.endDate,
    });
    console.log(`\nWFA windows: ${windowDefs.length} (${config.mode})`);
    for (const w of windowDefs) {
      console.log(`  Train ${w.trainStart}→${w.trainEnd} | OOS ${w.oosStart}→${w.oosEnd}`);
    }

    // 6. Build sweep candidates
    const sweepDims: ShortSweepDimensions = {
      ...SHORT_SWEEP_DEFAULTS,
      ...config.sweepOverrides,
    };
    const candidates = buildSweepCandidates(config.fillMode, sweepDims, config.maxPositions, config.maxPerTicker);
    console.log(`\nSweep candidates: ${candidates.length} configs`);

    // 7. Create evaluator
    const evaluator = makeEvaluator(tickerDataMap, config.fillMode);
    const executionConfig = buildShortExecutionConfig(config);

    // 8. Run WFA
    let preparedWindows: PreparedOOSWindowExecution[];

    if (config.numWorkers > 1 && candidates.length > 1) {
      console.log(`\nInitializing ${Math.min(config.numWorkers, candidates.length)} workers (${os.cpus().length} CPU cores)...`);

      const signalsPayload = Object.fromEntries(signalsByMultPreset.entries());
      const tickerCandles130m = Object.fromEntries(
        [...tickerDataMap.entries()].map(([ticker, td]) => [ticker, td.candles130m]),
      );

      const workers = await createTrainWorkerPool({
        signalsByMultPreset: signalsPayload,
        tickerCandles130m,
        allTradingDates,
        fillMode: config.fillMode,
        executionConfig,
      }, Math.min(config.numWorkers, candidates.length));
      console.log('Workers ready.');

      try {
        console.log(`\nRunning WFA (${candidates.length} configs × ${windowDefs.length} windows)...`);
        preparedWindows = await prepareShortWindowsParallel(
          workers,
          candidates,
          signalsByMultPreset,
          windowDefs,
        );
      } finally {
        await terminateTrainWorkerPool(workers);
      }
    } else {
      // Single-threaded fallback
      console.log(`\nRunning WFA single-threaded (${candidates.length} configs × ${windowDefs.length} windows)...`);
      preparedWindows = prepareShortWindowsSingleThread(
        candidates, signalsByMultPreset, allTradingDates, windowDefs, evaluator, config,
      );
    }
    const wfaResult = finalizeShortWFAResult(
      preparedWindows,
      allTradingDates,
      evaluator,
      config,
      Date.now() - pipelineT0,
    );

    // 9. Print report
    printShortReport(wfaResult, config);

    return {
      wfa: wfaResult,
      chainCacheStats: { hits: 0, misses: 0 },
      evaluator,
      allTradingDates,
    };
  } finally {
    if (intradayDb) { intradayDb.close(); intradayDb = null; }
  }
}

export function closeShortPipelineDB() {
  closeDB();
  if (intradayDb) { intradayDb.close(); intradayDb = null; }
}
