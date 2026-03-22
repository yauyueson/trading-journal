/**
 * Short-Term Credit Spread Pipeline (7-21 DTE, 4H monitoring)
 *
 * Mirrors wfa-pipeline-swing.ts architecture but uses:
 *  - Intraday 4H candles + BSM repricing (via evaluateCreditSpread4H)
 *  - Period multiplier sweep (1.5, 2.0, 2.5)
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
import { initIntradayDB, get4HCandles, aggregateToDaily, type IntradayCandle } from '../src/lib/backtest/intraday-cache';
import {
  precomputeSignals4H,
  type IVDataRow,
  type PeriodMultiplier,
  PERIOD_MULTIPLIERS,
} from '../src/lib/backtest/intraday-signals';
import {
  DEFAULT_SHORT_CREDIT_CONFIG,
  computeOptionAnalytics,
  type EntrySignal,
  type OptionTrade,
  type SimConfig,
  type SignalPresetKey,
} from '../src/lib/backtest/option-sim';
import { evaluateCreditSpread4H } from '../src/lib/backtest/intraday-monitor';
import { applyFill } from '../src/lib/backtest/slippage';
import { buildWFAWindows, computePortfolioDailyMetrics, type WFAResult, type WFAWindow } from '../src/lib/backtest/wfa-options';
import { signalMapKey } from '../src/lib/backtest/wfa-v3-orchestrator';

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
  periodMultipliers?: PeriodMultiplier[];
}

export const SHORT_DEFAULTS = {
  tickers: [
    'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA',
    'AAPL', 'JPM', 'NVDA', 'AMZN', 'MSFT',
    'META', 'NFLX', 'GOOGL', 'GS', 'COST',
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
  periodMultipliers: [1.5, 2.0, 2.5] as PeriodMultiplier[],
};

export const SHORT_SWEEP_DEFAULTS: ShortSweepDimensions = {
  profitTargets: [0.30, 0.50],
  spreadWidths: [2.5, 5, 7.5],
  ivRankMins: [20, 30],
  deltaStops: [0.65, Infinity],  // Infinity = deltaStop off
  timeStopDTEs: [1],
  periodMultipliers: [1.5, 2.0, 2.5],
};

// ── Supabase Helper ────────────────────────────────────

const SUPABASE_URL = () => process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = () => process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/${table}?${query}`, {
    headers: { apikey: SUPABASE_KEY(), Authorization: `Bearer ${SUPABASE_KEY()}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
  return res.json();
}

// ── Data Helpers ────────────────────────────────────────

interface TickerData {
  ticker: string;
  candles4h: IntradayCandle[];
  dailyCandles: IntradayCandle[];
  ivData: IVDataRow[];
  ivRanks: (number | null)[];
  dateToIdx: Map<string, number>;
}

function computeIVRank(ivSeries: (number | null)[]): (number | null)[] {
  const window = 252;
  return ivSeries.map((v, i) => {
    if (i < window || v == null) return null;
    const sample = ivSeries.slice(i - window, i + 1).filter((x): x is number => x != null);
    if (sample.length < 100) return null;
    const min = Math.min(...sample);
    const max = Math.max(...sample);
    const range = max - min;
    return range > 0 ? ((v - min) / range) * 100 : 50;
  });
}

export async function fetchTickerData(ticker: string, dataStart: string, dataEnd: string, intradayDb: any): Promise<TickerData> {
  const candles4h = get4HCandles(intradayDb, ticker, dataStart, dataEnd);
  const dailyCandles = aggregateToDaily(candles4h);

  const ivDbRows = await supabaseGet(
    'orats_iv_cache',
    `select=date,iv30d,iv60d,hv20d,hv30d,hv60d&ticker=eq.${ticker}&date=gte.${dataStart}&date=lte.${dataEnd}&order=date.asc&limit=5000`,
  );
  const ivData: IVDataRow[] = ivDbRows.map((r: any) => ({
    date: r.date,
    iv30d: r.iv30d,
    iv60d: r.iv60d,
    hv20d: r.hv20d,
    hv30d: r.hv30d,
    hv60d: r.hv60d,
  }));

  const ivByDate = new Map(ivData.map(r => [r.date, r.iv30d]));
  const ivSeries = dailyCandles.map(c => ivByDate.get(c.date) ?? null);
  const ivRanks = computeIVRank(ivSeries);
  const dateToIdx = new Map(dailyCandles.map((c, i) => [c.date, i]));

  return { ticker, candles4h, dailyCandles, ivData, ivRanks, dateToIdx };
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
  const signals = precomputeSignals4H(td.candles4h, td.ivData, periodMultiplier, techOptions);
  const entries: EntrySignal[] = [];

  for (const sig of signals) {
    const barDate = sig.date.split('T')[0].split(' ')[0];
    if (barDate < periodStart || barDate > periodEnd) continue;
    if (sig.type === 'NEUTRAL' || sig.score < 65) continue;
    if (sig.adx !== undefined && sig.adx < 8) continue;

    const idx = td.dateToIdx.get(barDate);
    entries.push({
      ticker: td.ticker,
      date: barDate,
      direction: sig.type as 'CALL' | 'PUT',
      score: sig.score,
      ivRank: idx != null ? (td.ivRanks[idx] ?? undefined) : undefined,
      hv60: sig.ivEstimate60,
      oratsIV60: sig.oratsIV60,
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
  const periodMults: PeriodMultiplier[] = dims.periodMultipliers ?? [1.5, 2.0, 2.5];

  for (const preset of presets) {
    for (const width of dims.spreadWidths) {
      for (const tp of dims.profitTargets) {
        for (const ivMin of dims.ivRankMins) {
          for (const deltaStop of dims.deltaStops) {
            for (const ts of dims.timeStopDTEs) {
              for (const dct of dirConfTiers) {
                for (const delta of shortDeltas) {
                  for (const periodMult of periodMults) {
                    candidates.push({
                      ...DEFAULT_SHORT_CREDIT_CONFIG,
                      creditDTERange: [7, 21] as [number, number],
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
      td.candles4h,
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

interface ShortWorkerInit {
  signalsByMultPreset: Record<string, EntrySignal[]>;
  tickerCandles4h: Record<string, IntradayCandle[]>;
  allTradingDates: string[];
  windowDefs: { trainStart: string; trainEnd: string; oosStart: string; oosEnd: string }[];
  endDate: string;
  fillMode: FillMode;
}

interface ShortWorkItem {
  id: number;
  params: Record<string, number | string | boolean>;
}

interface ShortWorkResult {
  type: 'result';
  id: number;
  result?: {
    trialId: number;
    params: Record<string, number | string | boolean>;
    windows: any[];
    oosTrades: OptionTrade[];
    oosSharpe: number;
    oosWinRate: number;
    oosMaxDD: number;
    oosTotalPnl: number;
    avgTrainSharpe: number;
    wfEfficiency: number;
  };
  error?: string;
}

function buildShortWorkerBundle(): string {
  const workerSrc = path.resolve(__dirname, 'wfa-v3-short-worker.ts');
  const workerBundle = path.resolve(__dirname, '.wfa-v3-short-worker.mjs');
  execSync(
    `npx esbuild ${workerSrc} --bundle --platform=node --format=esm --outfile=${workerBundle} --external:better-sqlite3 --packages=external`,
    { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' },
  );
  return workerBundle;
}

async function createWorkerPool(init: ShortWorkerInit, numWorkers: number): Promise<Worker[]> {
  const workerBundle = buildShortWorkerBundle();
  const workerCount = Math.max(1, Math.min(numWorkers, os.cpus().length));

  return Promise.all(
    Array.from({ length: workerCount }, () =>
      new Promise<Worker>((resolve, reject) => {
        const worker = new Worker(workerBundle, { workerData: init });
        worker.once('message', (msg) => {
          if (msg?.type === 'ready') resolve(worker);
          else reject(new Error('Short worker failed to initialize'));
        });
        worker.once('error', reject);
      }),
    ),
  );
}

async function terminateWorkerPool(workers: Worker[]) {
  for (const worker of workers) worker.postMessage({ type: 'exit' });
  await new Promise(resolve => setTimeout(resolve, 100));
  await Promise.all(workers.map(worker => worker.terminate()));
}

async function runParallelTrials(
  workers: Worker[],
  workItems: ShortWorkItem[],
): Promise<ShortWorkResult['result'][]> {
  const results: ShortWorkResult['result'][] = new Array(workItems.length);
  let nextIdx = 0;
  let completed = 0;

  return new Promise((resolve, reject) => {
    const handlers = new Map<Worker, (msg: ShortWorkResult) => void>();
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
      const handler = (msg: ShortWorkResult) => {
        if (!msg || msg.type !== 'result') return;
        if (msg.error || !msg.result) {
          cleanup();
          reject(new Error(msg.error ?? `Worker ${msg.id} returned no result`));
          return;
        }
        results[msg.id] = msg.result;
        completed++;
        if (completed === workItems.length || completed % 25 === 0) {
          process.stdout.write(`\r  Trials: ${completed}/${workItems.length}`);
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

// ── WFA Core (single-threaded fallback) ──────────────────

function runSingleThreadWFA(
  candidates: SimConfig[],
  signalsByMultPreset: Map<string, EntrySignal[]>,
  allTradingDates: string[],
  windowDefs: { trainStart: string; trainEnd: string; oosStart: string; oosEnd: string }[],
  evaluator: TradeEvaluator,
  config: ShortPipelineConfig,
): WFAResult {
  const t0 = Date.now();
  const allOOSTrades: OptionTrade[] = [];
  const wfaWindows: WFAWindow[] = [];

  for (let wi = 0; wi < windowDefs.length; wi++) {
    const w = windowDefs[wi];
    process.stdout.write(`\r  Window ${wi + 1}/${windowDefs.length}...`);

    let bestTrainSharpe = -Infinity;
    let bestConfig: SimConfig = candidates[0];
    let bestOOSTrades: OptionTrade[] = [];
    let bestOOSSharpe = 0;
    let bestOOSWinRate = 0;
    let bestOOSMaxDD = 0;
    let bestTrainTradeCount = 0;

    for (const candidate of candidates) {
      const presetKey = candidate.signalWeightPreset ?? 'ema';
      const periodMult = (candidate as any).indicatorPeriodMultiplier ?? 2.0;
      const signals = signalsByMultPreset.get(signalMapKey(periodMult, presetKey)) ?? [];

      // Train
      const trainSignals = signals.filter(s => s.date >= w.trainStart && s.date <= w.trainEnd);
      const trainTrades: OptionTrade[] = [];
      for (const signal of trainSignals) {
        const trade = evaluator(signal, candidate, allTradingDates, w.trainEnd);
        if (trade) trainTrades.push(trade);
      }
      const trainAnalytics = computeOptionAnalytics(trainTrades);
      const trainSharpe = trainAnalytics.dailyPortfolioSharpe ?? trainAnalytics.tradeSharpeLegacy;

      if (trainSharpe > bestTrainSharpe) {
        bestTrainSharpe = trainSharpe;
        bestConfig = candidate;
        bestTrainTradeCount = trainTrades.length;

        // OOS with portfolio constraints
        const oosSignals = signals.filter(s => s.date >= w.oosStart && s.date <= w.oosEnd);
        const oosTrades: OptionTrade[] = [];
        const openPositions: OptionTrade[] = [];

        for (const signal of oosSignals) {
          for (let j = openPositions.length - 1; j >= 0; j--) {
            if (openPositions[j].exitDate <= signal.date) openPositions.splice(j, 1);
          }
          if (openPositions.length >= config.maxPositions) continue;
          if (openPositions.filter(t => t.ticker === signal.ticker).length >= config.maxPerTicker) continue;

          const trade = evaluator(signal, candidate, allTradingDates, config.endDate);
          if (trade) {
            oosTrades.push(trade);
            openPositions.push(trade);
          }
        }

        const oosAnalytics = computeOptionAnalytics(oosTrades);
        bestOOSTrades = oosTrades;
        bestOOSSharpe = oosAnalytics.dailyPortfolioSharpe ?? oosAnalytics.tradeSharpeLegacy;
        bestOOSWinRate = oosAnalytics.winRate;
        bestOOSMaxDD = oosAnalytics.dailyMtMDrawdownPct ?? oosAnalytics.realizedExitDrawdownPct;
      }
    }

    process.stdout.write(`\r  ${wi + 1}/${windowDefs.length}: ${candidates.length} configs...\n`);

    wfaWindows.push({
      trainStart: w.trainStart,
      trainEnd: w.trainEnd,
      oosStart: w.oosStart,
      oosEnd: w.oosEnd,
      bestConfig: bestConfig as any,
      bestTrainSharpe,
      trainTradeCount: bestTrainTradeCount,
      oosTrades: bestOOSTrades,
      oosSharpe: bestOOSSharpe,
      oosWinRate: bestOOSWinRate,
      oosMaxDD: bestOOSMaxDD,
      oosTradeCount: bestOOSTrades.length,
    });

    allOOSTrades.push(...bestOOSTrades);
  }

  const oosAllAnalytics = computeOptionAnalytics(allOOSTrades);
  const allPortfolioMetrics = computePortfolioDailyMetrics(
    allOOSTrades, allTradingDates, config.startDate, config.endDate, config.startingCapital,
  );
  const avgTrainSharpe = wfaWindows.length > 0
    ? wfaWindows.reduce((s, w) => s + w.bestTrainSharpe, 0) / wfaWindows.length
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
    windows: wfaWindows,
    allOOSTrades,
    oosEquityCurve: allPortfolioMetrics.equityCurve,
    oosSharpe: allPortfolioMetrics.sharpe,
    oosWinRate: oosAllAnalytics.winRate,
    oosMaxDD: allPortfolioMetrics.maxDrawdownPct,
    oosTotalPnl: allOOSTrades.reduce((s, t) => s + t.pnl, 0),
    wfEfficiency: avgTrainSharpe >= 0.1 ? allPortfolioMetrics.sharpe / avgTrainSharpe : 0,
    elapsedMs: Date.now() - t0,
  };
}

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
  const deltaStop = config.creditDeltaStop ?? 0;
  const dsStr = deltaStop > 0 ? `ds${deltaStop}` : 'dsOff';
  const dct = config.dirConfTier ? `/dc${config.dirConfTier}` : '';
  return `${preset}/d${delta}/tp${(Number(tp) * 100).toFixed(0)}/w${width}/iv${ivMin}/${dsStr}/pm${periodMult}${dct}`;
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
      process.stdout.write(` ${ticker}(${td.candles4h.length})`);
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

    // 8. Run WFA
    let wfaResult: WFAResult;

    if (config.numWorkers > 1 && candidates.length > 1) {
      console.log(`\nInitializing ${Math.min(config.numWorkers, candidates.length)} workers (${os.cpus().length} CPU cores)...`);

      const signalsPayload = Object.fromEntries(signalsByMultPreset.entries());
      const tickerCandles4h = Object.fromEntries(
        [...tickerDataMap.entries()].map(([ticker, td]) => [ticker, td.candles4h]),
      );

      const workers = await createWorkerPool({
        signalsByMultPreset: signalsPayload,
        tickerCandles4h,
        allTradingDates,
        windowDefs: windowDefs.map(w => ({
          trainStart: w.trainStart,
          trainEnd: w.trainEnd,
          oosStart: w.oosStart,
          oosEnd: w.oosEnd,
        })),
        endDate: config.endDate,
        fillMode: config.fillMode,
      }, Math.min(config.numWorkers, candidates.length));
      console.log('Workers ready.');

      try {
        console.log(`\nRunning WFA (${candidates.length} configs × ${windowDefs.length} windows)...`);

        // Convert SimConfig[] to flat params for worker
        const workItems: ShortWorkItem[] = candidates.map((c, id) => ({
          id,
          params: c as unknown as Record<string, number | string | boolean>,
        }));

        const trialResults = await runParallelTrials(workers, workItems);

        // Find best trial by OOS Sharpe
        let bestIdx = 0;
        let bestSharpe = -Infinity;
        for (let i = 0; i < trialResults.length; i++) {
          const r = trialResults[i];
          if (r && r.oosSharpe > bestSharpe) {
            bestSharpe = r.oosSharpe;
            bestIdx = i;
          }
        }

        // Build WFAResult from best trial's per-window results
        const best = trialResults[bestIdx]!;
        const allOOSTrades = best.oosTrades;
        const allPortfolioMetrics = computePortfolioDailyMetrics(
          allOOSTrades, allTradingDates, config.startDate, config.endDate, config.startingCapital,
        );
        const oosAllAnalytics = computeOptionAnalytics(allOOSTrades);

        wfaResult = {
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
          windows: best.windows,
          allOOSTrades,
          oosEquityCurve: allPortfolioMetrics.equityCurve,
          oosSharpe: allPortfolioMetrics.sharpe,
          oosWinRate: oosAllAnalytics.winRate,
          oosMaxDD: allPortfolioMetrics.maxDrawdownPct,
          oosTotalPnl: allOOSTrades.reduce((s, t) => s + t.pnl, 0),
          wfEfficiency: best.avgTrainSharpe >= 0.1 ? allPortfolioMetrics.sharpe / best.avgTrainSharpe : 0,
          elapsedMs: Date.now() - pipelineT0,
        };
      } finally {
        await terminateWorkerPool(workers);
      }
    } else {
      // Single-threaded fallback
      console.log(`\nRunning WFA single-threaded (${candidates.length} configs × ${windowDefs.length} windows)...`);
      wfaResult = runSingleThreadWFA(
        candidates, signalsByMultPreset, allTradingDates, windowDefs, evaluator, config,
      );
    }

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
