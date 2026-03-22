/**
 * Walk-Forward Analysis Runner — Short-Term Credit Spreads (7-21 DTE sweep)
 *
 * @deprecated Use `scripts/wfa-run-unified.ts --profile short` instead.
 *
 * Compatibility wrapper over the WFA v3 4H pipeline.
 * Preserves the current CLI/report shape where practical while routing
 * execution through intraday signals + 4H monitoring.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { Worker } from 'node:worker_threads';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load env ────────────────────────────────────────────

const envPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const parts = line.split('=');
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const value = parts.slice(1).join('=').trim().replace(/^["']|["']$/g, '');
      if (key && !key.startsWith('#')) process.env[key] = value;
    }
  });
}

import { SIGNAL_PRESETS, type FillMode } from '../src/lib/backtest/types';
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
import { buildWFAWindows } from '../src/lib/backtest/wfa-options';
import {
  finalize,
  runWFAv3,
  signalMapKey,
  type TrialAggResult,
} from '../src/lib/backtest/wfa-v3-orchestrator';
import {
  DEFAULT_WFA_V3_CONFIG,
  type WFAv3Config,
  type WFAv3Result,
} from '../src/lib/backtest/wfa-v3-types';

// ── Config ──────────────────────────────────────────────

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const DATA_START = '2021-01-01';
const WFA_START = '2022-01-01';
const WFA_END = '2026-02-28';
const DATA_END = '2026-02-28';

export const DEFAULT_SHORT_TICKERS = [...DEFAULT_WFA_V3_CONFIG.tickers];
export const DEFAULT_SHORT_HOLDOUT_DAYS = DEFAULT_WFA_V3_CONFIG.holdoutDays;

const args = process.argv.slice(2);
function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

function parseTickersArg(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map(t => t.trim().toUpperCase())
    .filter(Boolean);
}

const SINGLE_TICKER = getArg('--ticker');
const TICKER_LIST = parseTickersArg(getArg('--tickers'));
const WFA_MODE = (getArg('--mode') || 'rolling') as 'rolling' | 'anchored';
const TRAIN_DAYS = parseInt(getArg('--train') || '189');
const STEP_DAYS = parseInt(getArg('--step') || '42');
const PURGE_DAYS = parseInt(getArg('--purge') || '14');
const HOLDOUT_DAYS = Math.max(0, parseInt(getArg('--holdout') || String(DEFAULT_SHORT_HOLDOUT_DAYS)));
const STARTING_CAPITAL = parseInt(getArg('--capital') || '100000');
const FILL_MODE = (getArg('--fill') || 'mid') as FillMode;
const MAX_CANDIDATES = parseInt(getArg('--max-candidates') || '0');
const SMOKE_MODE = args.includes('--smoke');
const NUM_WORKERS = Math.max(1, Math.min(
  parseInt(getArg('--workers') || String(Math.max(1, os.cpus().length - 2))),
  Math.max(1, os.cpus().length),
));

const tickers = TICKER_LIST.length > 0
  ? TICKER_LIST
  : SINGLE_TICKER
    ? [SINGLE_TICKER.toUpperCase()]
    : DEFAULT_SHORT_TICKERS;
const PERIOD_MULTIPLIER_SWEEP: PeriodMultiplier[] = [1.5, 2.0, 2.5];
const DEFAULT_PERIOD_MULTIPLIER: PeriodMultiplier = 2.0;
const PRESET_KEYS: SignalPresetKey[] = ['ema', 'mom', 'em', 'vol'];

export const SHORT_DTE_ENTRY_RANGE: [number, number] = [7, 21];
export const SHORT_IV_RANK_MINS = [20, 30] as const;
export type CandidateParams = Record<string, number | string | boolean>;

interface TickerData {
  ticker: string;
  candles4h: IntradayCandle[];
  dailyCandles: IntradayCandle[];
  ivData: IVDataRow[];
  ivRanks: (number | null)[];
  dateToIdx: Map<string, number>;
}

interface CompatWindowResult {
  windowIndex: number;
  trainStart: string;
  trainEnd: string;
  oosStart: string;
  oosEnd: string;
  bestConfig: CandidateParams;
  bestTrainSharpe: number;
  trainTradesCount: number;
  oosTrades: OptionTrade[];
  oosSharpe: number;
  oosWinRate: number;
  oosMaxDD: number;
  oosTotalPnl: number;
  wfePerWindow: number;
  oosTradesPerWeek: number;
  overfitWarning: boolean;
}

// ── Supabase ────────────────────────────────────────────

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
  return res.json();
}

// ── Data Helpers ────────────────────────────────────────

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

async function fetchTickerData(ticker: string, intradayDb: any): Promise<TickerData> {
  const candles4h = get4HCandles(intradayDb, ticker, DATA_START, DATA_END);
  const dailyCandles = aggregateToDaily(candles4h);

  const ivDbRows = await supabaseGet(
    'orats_iv_cache',
    `select=date,iv30d,iv60d,hv20d,hv30d,hv60d&ticker=eq.${ticker}&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=5000`,
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
    });
  }

  const deduped = new Map<string, EntrySignal>();
  for (const entry of entries) {
    const key = `${entry.ticker}|${entry.date}|${entry.direction}`;
    if (!deduped.has(key) || entry.score > deduped.get(key)!.score) {
      deduped.set(key, entry);
    }
  }
  return [...deduped.values()];
}

export function buildV3SweepCandidates(fillMode: FillMode = FILL_MODE): CandidateParams[] {
  const candidates: CandidateParams[] = [];

  const spreadWidths = [2.5, 5, 7.5];
  const shortDeltas = [0.25, 0.35, 0.45];
  const profitTargets = [0.30, 0.50];
  const ivRankMins = [...SHORT_IV_RANK_MINS];
  const deltaStops = [0.65, 'off'] as const;

  for (const preset of PRESET_KEYS) {
    for (const width of spreadWidths) {
      for (const delta of shortDeltas) {
        for (const tp of profitTargets) {
          for (const ivMin of ivRankMins) {
            for (const deltaStop of deltaStops) {
              for (const indicatorPeriodMultiplier of PERIOD_MULTIPLIER_SWEEP) {
                candidates.push({
                  creditShortDelta: delta,
                  creditSpreadWidth: width,
                  creditProfitTarget: tp,
                  creditStopLossMultiple: 100,
                  creditTimeStopDTE: 1,
                  creditDeltaStop: deltaStop === 'off' ? 0 : deltaStop,
                  minIVRank: ivMin,
                  vrpFilter: 0,
                  contangoFilter: 0,
                  slopeFilter: 0,
                  maxIVSkew: 1,
                  signalWeightPreset: preset,
                  useSmvVol: false,
                  dirConfTier: 'any',
                  fillMode,
                  indicatorPeriodMultiplier,
                  maxPerTicker: 5,
                  maxPositions: 10,
                  bsmKappa: 4.0,
                  bsmRiskFreeRate: 0.04,
                  dailyCalibration: true,
                  ivThetaSource: 'hv60',
                });
              }
            }
          }
        }
      }
    }
  }

  return candidates;
}

function buildCompatWindows(result: WFAv3Result): CompatWindowResult[] {
  return result.oos.windows.map(window => {
    const oosTotalPnl = window.oosTrades.reduce((sum, trade) => sum + trade.pnl, 0);
    const oosMs = new Date(window.oosEnd).getTime() - new Date(window.oosStart).getTime();
    const oosWeeks = Math.max(1, oosMs / (7 * 86400000));
    const oosTradesPerWeek = window.oosTrades.length / oosWeeks;
    const wfePerWindow = window.bestTrainSharpe > 0 ? window.oosSharpe / window.bestTrainSharpe : 0;
    const overfitWarning = wfePerWindow < 0.4 || window.trainTradeCount < 20;

    return {
      windowIndex: window.windowIndex,
      trainStart: window.trainStart,
      trainEnd: window.trainEnd,
      oosStart: window.oosStart,
      oosEnd: window.oosEnd,
      bestConfig: window.bestConfig as CandidateParams,
      bestTrainSharpe: window.bestTrainSharpe,
      trainTradesCount: window.trainTradeCount,
      oosTrades: window.oosTrades,
      oosSharpe: window.oosSharpe,
      oosWinRate: window.oosWinRate,
      oosMaxDD: window.oosMaxDD,
      oosTotalPnl,
      wfePerWindow,
      oosTradesPerWeek,
      overfitWarning,
    };
  });
}

function formatPct(v: number, decimals = 1): string {
  return v.toFixed(decimals) + '%';
}

function configSummary(config: CandidateParams): string {
  const preset = String(config.signalWeightPreset ?? 'ema');
  const delta = Number(config.creditShortDelta ?? DEFAULT_SHORT_CREDIT_CONFIG.creditShortDelta);
  const tp = Number(config.creditProfitTarget ?? DEFAULT_SHORT_CREDIT_CONFIG.creditProfitTarget);
  const width = Number(config.creditSpreadWidth ?? DEFAULT_SHORT_CREDIT_CONFIG.creditSpreadWidth);
  const ivMin = Number(config.minIVRank ?? DEFAULT_SHORT_CREDIT_CONFIG.minIVRank);
  const periodMultiplier = Number(config.indicatorPeriodMultiplier ?? DEFAULT_PERIOD_MULTIPLIER);
  const deltaStop = Number(config.creditDeltaStop ?? 0);
  const dsStr = deltaStop > 0 ? `ds${deltaStop}` : 'dsOff';
  return `${preset}/d${delta}/tp${(tp * 100).toFixed(0)}/w${width}/iv${ivMin}/${dsStr}/pm${periodMultiplier}`;
}

type V3Engine = {
  evaluateTrial: (params: CandidateParams) => unknown;
  finalizeResults: () => WFAv3Result;
};

interface ShortV3WindowDef {
  trainStart: string;
  trainEnd: string;
  oosStart: string;
  oosEnd: string;
}

interface ShortV3WorkerInit {
  signalsByMultPreset: Record<string, EntrySignal[]>;
  tickerCandles4h: Record<string, IntradayCandle[]>;
  allTradingDates: string[];
  windowDefs: ShortV3WindowDef[];
  endDate: string;
  fillMode: FillMode;
}

interface ShortV3WorkItem {
  id: number;
  params: CandidateParams;
}

interface ShortV3WorkResult {
  type: 'result';
  id: number;
  result?: TrialAggResult;
  error?: string;
}

function makeV3Evaluator(
  tickerDataMap: Map<string, TickerData>,
  fillMode: FillMode,
) {
  return (signal: EntrySignal, config: SimConfig, tradingDates: string[], maxDate: string) => {
    const td = tickerDataMap.get(signal.ticker);
    if (!td) return null;
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

function buildShortV3WorkerBundle(): string {
  const workerSrc = path.resolve(__dirname, 'wfa-v3-short-worker.ts');
  const workerBundle = path.resolve(__dirname, '.wfa-v3-short-worker.mjs');
  execSync(
    `npx esbuild ${workerSrc} --bundle --platform=node --format=esm --outfile=${workerBundle} --external:better-sqlite3 --packages=external`,
    { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' },
  );
  return workerBundle;
}

async function createShortV3WorkerPool(init: ShortV3WorkerInit, numWorkers: number): Promise<Worker[]> {
  const workerBundle = buildShortV3WorkerBundle();
  const workerCount = Math.max(1, Math.min(numWorkers, os.cpus().length));

  return Promise.all(
    Array.from({ length: workerCount }, () =>
      new Promise<Worker>((resolve, reject) => {
        const worker = new Worker(workerBundle, { workerData: init });
        worker.once('message', (msg) => {
          if (msg?.type === 'ready') resolve(worker);
          else reject(new Error('Short v3 worker failed to initialize'));
        });
        worker.once('error', reject);
      }),
    ),
  );
}

async function terminateShortV3WorkerPool(workers: Worker[]) {
  for (const worker of workers) worker.postMessage({ type: 'exit' });
  await new Promise(resolve => setTimeout(resolve, 100));
  await Promise.all(workers.map(worker => worker.terminate()));
}

async function runParallelShortV3Trials(
  workers: Worker[],
  workItems: ShortV3WorkItem[],
): Promise<TrialAggResult[]> {
  const results: TrialAggResult[] = new Array(workItems.length);
  let nextIdx = 0;
  let completed = 0;

  return new Promise((resolve, reject) => {
    const handlers = new Map<Worker, (msg: ShortV3WorkResult) => void>();
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
      const handler = (msg: ShortV3WorkResult) => {
        if (!msg || msg.type !== 'result') return;
        if (msg.error || !msg.result) {
          cleanup();
          reject(new Error(msg.error ?? `Short v3 worker ${msg.id} returned no result`));
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

// ── Main ────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  let intradayDb: any = null;

  console.log('WFA Engine — Short-DTE Credit Spread Validation (v3 4H Wrapper)');
  console.log(`Requested workers: ${NUM_WORKERS} (${os.cpus().length} CPU cores available)`);
  console.log('-'.repeat(60));

  try {
    initDB();
    intradayDb = initIntradayDB();

    console.log(`\nFetching intraday data for ${tickers.length} tickers...`);
    const tickerDataMap = new Map<string, TickerData>();
    for (const ticker of tickers) {
      const td = await fetchTickerData(ticker, intradayDb);
      tickerDataMap.set(ticker, td);
      process.stdout.write(` ${ticker}(${td.candles4h.length})`);
    }
    console.log(' done.');

    const allDatesSet = new Set<string>();
    for (const td of tickerDataMap.values()) {
      for (const candle of td.dailyCandles) {
        if (candle.date >= WFA_START && candle.date <= WFA_END) allDatesSet.add(candle.date);
      }
    }
    const allTradingDates = [...allDatesSet].sort();
    console.log(`Trading dates: ${allTradingDates.length} (${allTradingDates[0]} -> ${allTradingDates[allTradingDates.length - 1]})`);

    console.log('\nGenerating 4H signals by preset and period multiplier...');
    const signalsByMultPreset = new Map<string, EntrySignal[]>();
    for (const periodMultiplier of PERIOD_MULTIPLIER_SWEEP) {
      for (const preset of PRESET_KEYS) {
        const allSignals: EntrySignal[] = [];
        for (const td of tickerDataMap.values()) {
          allSignals.push(...generateSignalsForPreset(td, preset, periodMultiplier, WFA_START, WFA_END));
        }
        allSignals.sort((a, b) =>
          a.date.localeCompare(b.date) ||
          a.ticker.localeCompare(b.ticker) ||
          a.direction.localeCompare(b.direction),
        );
        signalsByMultPreset.set(signalMapKey(periodMultiplier, preset), allSignals);
        console.log(`  ${signalMapKey(periodMultiplier, preset)}: ${allSignals.length} signals`);
      }
    }

    const fullCandidates = buildV3SweepCandidates(FILL_MODE);
    const candidateLimit = SMOKE_MODE ? 12 : MAX_CANDIDATES > 0 ? MAX_CANDIDATES : fullCandidates.length;
    const candidates = fullCandidates.slice(0, candidateLimit);
    console.log(`\nSweep candidates: ${candidates.length} v3 configs${candidateLimit < fullCandidates.length ? ` (capped from ${fullCandidates.length})` : ''}`);

    const v3Config: WFAv3Config = {
      ...DEFAULT_WFA_V3_CONFIG,
      trainWindowDays: TRAIN_DAYS,
      forwardStepDays: STEP_DAYS,
      purgeGapDays: PURGE_DAYS,
      mode: WFA_MODE,
      startDate: WFA_START,
      endDate: WFA_END,
      holdoutDays: HOLDOUT_DAYS,
      tickers,
      startingCapital: STARTING_CAPITAL,
      maxWorkers: NUM_WORKERS,
      bsmKappa: 4.0,
      bsmRiskFreeRate: 0.04,
      ivThetaSource: 'hv60',
      dailyCalibration: true,
    };

    const evaluator = makeV3Evaluator(tickerDataMap, FILL_MODE);
    const progressLogger = (phase: string, detail: string) => {
      if (phase !== 'optimize') {
        console.log(`  [${phase}] ${detail}`);
      }
    };

    let result: WFAv3Result;
    const useParallelTrials = NUM_WORKERS > 1 && candidates.length > 1;

    if (useParallelTrials) {
      console.log(`\nEvaluating candidates through v3 4H orchestrator (${Math.min(NUM_WORKERS, candidates.length)} workers)...`);

      const allDates = allTradingDates.filter(d => d >= v3Config.startDate && d <= v3Config.endDate);
      const holdoutBoundaryIdx = Math.max(0, allDates.length - v3Config.holdoutDays);
      const holdoutStart = allDates[holdoutBoundaryIdx] ?? v3Config.endDate;
      const wfaEndDate = allDates[holdoutBoundaryIdx - 1] ?? v3Config.endDate;
      const windowDefs = buildWFAWindows(allDates, {
        trainWindowDays: v3Config.trainWindowDays,
        forwardStepDays: v3Config.forwardStepDays,
        purgeGapDays: v3Config.purgeGapDays,
        mode: v3Config.mode,
        startDate: v3Config.startDate,
        endDate: wfaEndDate,
      });
      progressLogger('setup', `Built ${windowDefs.length} windows, holdout starts ${holdoutStart}`);

      const signalsPayload = Object.fromEntries(signalsByMultPreset.entries());
      const tickerCandles4h = Object.fromEntries(
        [...tickerDataMap.entries()].map(([ticker, td]) => [ticker, td.candles4h]),
      );
      const workers = await createShortV3WorkerPool({
        signalsByMultPreset: signalsPayload,
        tickerCandles4h,
        allTradingDates,
        windowDefs: windowDefs.map(w => ({
          trainStart: w.trainStart,
          trainEnd: w.trainEnd,
          oosStart: w.oosStart,
          oosEnd: w.oosEnd,
        })),
        endDate: v3Config.endDate,
        fillMode: FILL_MODE,
      }, Math.min(NUM_WORKERS, candidates.length));

      try {
        const trialResults = await runParallelShortV3Trials(
          workers,
          candidates.map((params, id) => ({ id, params })),
        );
        result = finalize(v3Config, {
          signalsByMultPreset,
          allTradingDates,
          vixData: [],
          evaluator,
          onProgress: progressLogger,
        }, trialResults, holdoutStart);
      } finally {
        await terminateShortV3WorkerPool(workers);
      }
    } else {
      const engine = runWFAv3(v3Config, {
        signalsByMultPreset,
        allTradingDates,
        vixData: [],
        evaluator,
        onProgress: progressLogger,
      }) as unknown as V3Engine;

      console.log('\nEvaluating candidates through v3 4H orchestrator...');
      for (let i = 0; i < candidates.length; i++) {
        engine.evaluateTrial(candidates[i]);
        if ((i + 1) % 25 === 0 || i === candidates.length - 1) {
          process.stdout.write(`\r  Trials: ${i + 1}/${candidates.length}`);
        }
      }
      console.log('');

      result = engine.finalizeResults();
    }

    result.v3Meta.intraday4HBars = [...tickerDataMap.values()].reduce((sum, td) => sum + td.candles4h.length, 0);
    result.v3Meta.signalSetsPrecomputed = signalsByMultPreset.size;

    const wfaResults = buildCompatWindows(result);
    const allOOSTrades = result.oos.allTrades;
    const aggAnalytics = computeOptionAnalytics(allOOSTrades);
    const aggregateSharpe = result.oos.sharpe;
    const aggregateMaxDD = result.oos.maxDD;
    const oosTotalPnl = result.oos.totalPnl;
    const totalElapsed = Date.now() - t0;

    console.log('\n' + '='.repeat(80));
    console.log('  SHORT-DTE WALK-FORWARD ANALYSIS RESULTS');
    console.log('='.repeat(80));

    console.log(`\n  Mode: ${WFA_MODE.toUpperCase()}`);
    console.log(`  Period: ${WFA_START} -> ${WFA_END}`);
    console.log(`  Train: ${TRAIN_DAYS}d | Step: ${STEP_DAYS}d | Purge: ${PURGE_DAYS}d | Holdout: ${HOLDOUT_DAYS}d`);
    console.log(`  Tickers: ${tickers.join(', ')}`);
    console.log(`  Capital: $${STARTING_CAPITAL.toLocaleString()}`);
    console.log(`  Fill mode: ${FILL_MODE}`);
    console.log(`  Smoke mode: ${SMOKE_MODE ? 'ON' : 'OFF'}`);
    console.log(`  Engine: v3 4H compatibility wrapper`);
    console.log(`  Elapsed: ${(totalElapsed / 1000).toFixed(1)}s`);

    console.log('\n' + '-'.repeat(80));
    console.log('  AGGREGATE OOS METRICS');
    console.log('-'.repeat(80));
    const oosStartMs = new Date(wfaResults[0]?.oosStart ?? WFA_START).getTime();
    const oosEndMs = new Date(wfaResults[wfaResults.length - 1]?.oosEnd ?? WFA_END).getTime();
    const oosDays = Math.max(1, (oosEndMs - oosStartMs) / 86400000);
    const annualizedROC = (oosTotalPnl / STARTING_CAPITAL) * (365 / oosDays) * 100;
    const wfeWarning = result.oos.wfEfficiency < 0.4
      ? ' (DANGER: Extreme Overfit)'
      : result.oos.wfEfficiency < 0.6
        ? ' (Warning: High Degradation)'
        : ' (Healthy)';

    console.log(`  Sharpe:       ${aggregateSharpe.toFixed(2)}`);
    console.log(`  Win Rate:     ${formatPct(aggAnalytics.winRate)}`);
    console.log(`  Max DD:       ${formatPct(aggregateMaxDD)}`);
    console.log(`  Total P&L:    $${oosTotalPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    console.log(`  ROC (Raw):    ${formatPct((oosTotalPnl / STARTING_CAPITAL) * 100)}`);
    console.log(`  ROC (Annual): ${formatPct(annualizedROC)}`);
    console.log(`  WFE (Overfit):${result.oos.wfEfficiency.toFixed(2)}${wfeWarning}`);
    console.log(`  OOS Trades:   ${allOOSTrades.length}`);
    console.log(`  4H Bars:      ${result.v3Meta.intraday4HBars}`);
    console.log(`  Signal Sets:  ${result.v3Meta.signalSetsPrecomputed}`);

    if (allOOSTrades.length > 0) {
      const avgHold = allOOSTrades.reduce((sum, trade) => sum + trade.holdDays, 0) / allOOSTrades.length;
      const avgDTE = allOOSTrades.reduce((sum, trade) => sum + trade.entryDTE, 0) / allOOSTrades.length;
      console.log(`  Avg Hold Days: ${avgHold.toFixed(1)}`);
      console.log(`  Avg Entry DTE: ${avgDTE.toFixed(1)}`);
    }

    const avgTradesPerWeek = wfaResults.length > 0
      ? wfaResults.reduce((sum, window) => sum + window.oosTradesPerWeek, 0) / wfaResults.length
      : 0;
    const lowFreqWindows = wfaResults.filter(window => window.oosTradesPerWeek < 1);
    const highFreqWindows = wfaResults.filter(window => window.oosTradesPerWeek > 4);
    const targetWindows = wfaResults.filter(window => window.oosTradesPerWeek >= 2 && window.oosTradesPerWeek <= 4);

    console.log('\n' + '-'.repeat(80));
    console.log('  TRADE FREQUENCY');
    console.log('-'.repeat(80));
    console.log(`  Avg trades/week (OOS):  ${avgTradesPerWeek.toFixed(1)}`);
    console.log(`  Windows < 1 trade/week: ${lowFreqWindows.length} of ${wfaResults.length}`);
    console.log(`  Windows > 4 trades/week: ${highFreqWindows.length} of ${wfaResults.length}`);
    console.log(`  Target range (2-4/wk):  ${targetWindows.length} of ${wfaResults.length} (${wfaResults.length > 0 ? (targetWindows.length / wfaResults.length * 100).toFixed(0) : 0}%)`);

    console.log('\n' + '-'.repeat(80));
    console.log('  DECISION GATE');
    console.log('-'.repeat(80));
    if (aggregateSharpe < 0.5) {
      console.log('  ** FAIL: OOS Sharpe < 0.5 — short-DTE strategy does NOT clear the bar under 4H monitoring **');
    } else if (aggregateSharpe < 1.0) {
      console.log(`  MARGINAL: OOS Sharpe = ${aggregateSharpe.toFixed(2)} — promising but needs tuning`);
    } else {
      console.log(`  PASS: OOS Sharpe = ${aggregateSharpe.toFixed(2)} — proceed to Phase 1`);
    }
    if (result.oos.wfEfficiency < 0.3) {
      console.log('  ** FAIL: WFE < 0.3 — extreme overfit, IS performance does not generalize **');
    }
    if (allOOSTrades.length < 100) {
      console.log(`  WARNING: Only ${allOOSTrades.length} OOS trades — insufficient sample for statistical significance`);
    }
    if (avgTradesPerWeek < 1) {
      console.log(`  WARNING: Avg ${avgTradesPerWeek.toFixed(1)} trades/week — below minimum frequency target`);
    }

    console.log('\n' + '-'.repeat(80));
    console.log('  HOLDOUT VALIDATION');
    console.log('-'.repeat(80));
    console.log(`  Holdout Days: ${HOLDOUT_DAYS}`);
    console.log(`  Sharpe:       ${result.holdout.sharpe.toFixed(2)}`);
    console.log(`  Win Rate:     ${formatPct(result.holdout.winRate)}`);
    console.log(`  Max DD:       ${formatPct(result.holdout.maxDD)}`);
    console.log(`  Total P&L:    $${result.holdout.totalPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    console.log(`  Trades:       ${result.holdout.tradeCount}`);
    console.log(`  Degradation:  ${result.holdout.degradation.toFixed(2)}`);
    if (HOLDOUT_DAYS <= 0) {
      console.log('  WARNING: Holdout disabled — this is not a true final validation layer');
    } else if (result.holdout.tradeCount < 30) {
      console.log(`  WARNING: Only ${result.holdout.tradeCount} holdout trades — treat holdout inference cautiously`);
    }

    console.log('\n' + '-'.repeat(80));
    console.log('  PER-WINDOW BREAKDOWN');
    console.log('-'.repeat(80));
    console.log('  #  Train Period          OOS Period            Train    OOS    WFE   Trd/Wk  OOS    OOS   Best Config');
    console.log('     Start    -> End       Start    -> End        Sharpe   Sharpe             WR%    Trd   (preset/d/tp/w/iv/ds/pm)');
    console.log('  ' + '.'.repeat(118));

    for (let i = 0; i < wfaResults.length; i++) {
      const wr = wfaResults[i];
      const wfeStr = wr.wfePerWindow.toFixed(2) + (wr.overfitWarning ? '!' : ' ');
      console.log(
        `  ${String(i + 1).padStart(2)}  ${wr.trainStart} -> ${wr.trainEnd}  ${wr.oosStart} -> ${wr.oosEnd}` +
        `  ${wr.bestTrainSharpe.toFixed(2).padStart(6)}  ${wr.oosSharpe.toFixed(2).padStart(6)}  ${wfeStr.padStart(5)}  ${wr.oosTradesPerWeek.toFixed(1).padStart(5)}` +
        `  ${formatPct(wr.oosWinRate).padStart(5)}  ${String(wr.oosTrades.length).padStart(4)}   ${configSummary(wr.bestConfig)}`,
      );
    }

    const wfeValues = wfaResults.map(w => w.wfePerWindow).sort((a, b) => a - b);
    const wfeMin = wfeValues[0] ?? 0;
    const wfeMed = wfeValues[Math.floor(wfeValues.length / 2)] ?? 0;
    const wfeMax = wfeValues[wfeValues.length - 1] ?? 0;
    const overfitWindows = wfaResults.filter(w => w.overfitWarning);
    const uniqueConfigs = new Set(wfaResults.map(w => configSummary(w.bestConfig)));

    console.log('\n' + '-'.repeat(80));
    console.log('  OVERFIT ANALYSIS');
    console.log('-'.repeat(80));
    console.log(`  Per-window WFE:   min=${wfeMin.toFixed(2)} med=${wfeMed.toFixed(2)} max=${wfeMax.toFixed(2)}`);
    console.log(`  Aggregate WFE:    ${result.oos.wfEfficiency.toFixed(2)}${wfeWarning}`);
    console.log(`  Overfit windows:  ${overfitWindows.length} of ${wfaResults.length}`);
    console.log(`  Config diversity: ${uniqueConfigs.size} unique configs across ${wfaResults.length} windows`);

    if (allOOSTrades.length > 0) {
      const byExit: Record<string, number> = {};
      for (const trade of allOOSTrades) {
        byExit[trade.exitType] = (byExit[trade.exitType] ?? 0) + 1;
      }
      console.log('\n' + '-'.repeat(80));
      console.log('  EXIT TYPE BREAKDOWN');
      console.log('-'.repeat(80));
      for (const [type, count] of Object.entries(byExit).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${type.padEnd(20)} ${count} (${formatPct((count / allOOSTrades.length) * 100)})`);
      }
    }

    const outDir = path.resolve(__dirname, '../data');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const exportResult = {
      _meta: {
        strategy: 'SHORT_DTE_CREDIT_SPREAD',
        engine: 'wfa_v3_4h_wrapper',
        dteRange: SHORT_DTE_ENTRY_RANGE,
        presets: PRESET_KEYS,
        spreadWidths: [2.5, 5, 7.5],
        shortDeltas: [0.25, 0.35, 0.45],
        profitTargets: [0.30, 0.50],
        ivRankMins: [...SHORT_IV_RANK_MINS],
        deltaStops: [0.65, 'off'],
        indicatorPeriodMultipliers: PERIOD_MULTIPLIER_SWEEP,
        selectedIndicatorPeriodMultiplier: result.v3Meta.indicatorPeriodMultiplier,
        bsmKappa: result.v3Meta.bsmKappa,
        bsmRiskFreeRate: result.v3Meta.bsmRiskFreeRate,
        ivThetaSource: result.v3Meta.ivThetaSource,
        dailyCalibration: result.v3Meta.dailyCalibration,
        stopLoss: 'none',
        timeStopDTE: 1,
        scoreThreshold: 65,
        adxMin: 8,
        totalConfigs: candidates.length,
        trainDays: TRAIN_DAYS,
        stepDays: STEP_DAYS,
        purgeDays: PURGE_DAYS,
        holdoutDays: HOLDOUT_DAYS,
        fillMode: FILL_MODE,
        smokeMode: SMOKE_MODE,
        candidateLimit,
        elapsed: totalElapsed,
        requestedWorkers: NUM_WORKERS,
        intraday4HBars: result.v3Meta.intraday4HBars,
        signalSetsPrecomputed: result.v3Meta.signalSetsPrecomputed,
      },
      oosSharpe: aggregateSharpe,
      oosWinRate: aggAnalytics.winRate,
      oosMaxDD: aggregateMaxDD,
      oosTotalPnl,
      wfEfficiency: result.oos.wfEfficiency,
      totalOOSTrades: allOOSTrades.length,
      avgTradesPerWeek,
      configDiversity: uniqueConfigs.size,
      holdout: {
        holdoutDays: HOLDOUT_DAYS,
        sharpe: result.holdout.sharpe,
        winRate: result.holdout.winRate,
        maxDD: result.holdout.maxDD,
        totalPnl: result.holdout.totalPnl,
        tradeCount: result.holdout.tradeCount,
        degradation: result.holdout.degradation,
        trades: result.holdout.trades,
      },
      windows: wfaResults.map(wr => ({
        trainStart: wr.trainStart,
        trainEnd: wr.trainEnd,
        oosStart: wr.oosStart,
        oosEnd: wr.oosEnd,
        bestTrainSharpe: wr.bestTrainSharpe,
        trainTradesCount: wr.trainTradesCount,
        bestConfig: {
          preset: wr.bestConfig.signalWeightPreset,
          delta: wr.bestConfig.creditShortDelta,
          tp: wr.bestConfig.creditProfitTarget,
          width: wr.bestConfig.creditSpreadWidth,
          ivMin: wr.bestConfig.minIVRank,
          deltaStop: Number(wr.bestConfig.creditDeltaStop ?? 0) > 0 ? wr.bestConfig.creditDeltaStop : 'off',
          indicatorPeriodMultiplier: wr.bestConfig.indicatorPeriodMultiplier,
          bsmKappa: wr.bestConfig.bsmKappa,
          bsmRiskFreeRate: wr.bestConfig.bsmRiskFreeRate,
          ivThetaSource: wr.bestConfig.ivThetaSource,
          dailyCalibration: wr.bestConfig.dailyCalibration,
        },
        oosSharpe: wr.oosSharpe,
        oosWinRate: wr.oosWinRate,
        oosMaxDD: wr.oosMaxDD,
        wfePerWindow: wr.wfePerWindow,
        oosTradesPerWeek: wr.oosTradesPerWeek,
        overfitWarning: wr.overfitWarning,
        oosTrades: wr.oosTrades,
      })),
      allOOSTrades,
    };

    const outPath = path.resolve(outDir, 'wfa-results-short.json');
    fs.writeFileSync(outPath, JSON.stringify(exportResult, null, 2));
    console.log(`\nResults saved to ${outPath}`);
    console.log('\n' + '='.repeat(80) + '\n');
  } finally {
    if (intradayDb) intradayDb.close();
    closeDB();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
