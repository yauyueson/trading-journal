/**
 * Unified Comprehensive Strategy Evaluation
 *
 * One script to rule them all — tests both Credit Spread and LEAP strategies
 * across all parameter permutations with proper IS/OOS methodology.
 *
 * Dimensions:
 *   Credit Spread: 2 signals × 3 tiers × 3 IV × 2 TP × 3 SL = 108 configs
 *   LEAP:          2 signals × 3 tiers × 3 IV × 3 TP × 3 SL = 162 configs
 *   Total: 270 configs swept on IS, top 30+30 validated on OOS
 *
 * Output:
 *   9-section console report + JSON export to data/unified-eval-results.json
 *
 * Usage:
 *   npx tsx scripts/unified-eval.ts
 *   npx tsx scripts/unified-eval.ts --top 20        # top N per mode (default 30)
 *   npx tsx scripts/unified-eval.ts --ticker SPY    # single ticker
 *   npx tsx scripts/unified-eval.ts --skip-leaps    # credit spreads only
 *   npx tsx scripts/unified-eval.ts --skip-credits  # LEAPs only
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { Worker } from 'node:worker_threads';

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

import type { BacktestCandle } from '../src/lib/backtest/types';
import type { TechScoreOptions } from '../src/lib/tech-analysis';
import { precomputeSignals } from '../src/lib/backtest/engine';
import { initDB, closeDB, getCacheStats } from '../src/lib/backtest/chain-cache';
import {
  DEFAULT_CREDIT_CONFIG, DEFAULT_LEAP_CONFIG,
  type EntrySignal, type SimConfig, type OptionSimAnalytics, type OptionTrade,
} from '../src/lib/backtest/option-sim';

// ── Config ──────────────────────────────────────────────

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
const ORATS_TOKEN = process.env.ORATS_API_TOKEN || '';

// Date ranges
const DATA_START = '2017-01-01';   // candle warmup
const IS_START   = '2018-01-01';   // IS begins (1yr warmup for IV rank)
const IS_END     = '2023-12-31';   // IS ends (6 years)
const OOS_START  = '2024-04-01';   // OOS begins (3-month gap)
const OOS_END    = '2026-02-28';   // OOS ends
const DATA_END   = '2026-02-28';

const ALL_TICKERS = [
  'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA',
  'AAPL', 'JPM', 'NVDA', 'AMZN', 'MSFT',
  'META', 'NFLX', 'GOOG', 'GS', 'COST',
];

const NUM_WORKERS = Math.min(os.cpus().length - 2, 20);
const MIN_TRADES = 10;

// CLI args
const args = process.argv.slice(2);
function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}
const SINGLE_TICKER = getArg('--ticker');
const TOP_N = parseInt(getArg('--top') || '30');
const SKIP_LEAPS = args.includes('--skip-leaps');
const SKIP_CREDITS = args.includes('--skip-credits');
const tickers = SINGLE_TICKER ? [SINGLE_TICKER.toUpperCase()] : ALL_TICKERS;

// ── Signal Variants ─────────────────────────────────────

interface SignalVariant {
  label: string;
  options: TechScoreOptions;
}

const SIGNAL_VARIANTS: SignalVariant[] = [
  { label: 'BASELINE', options: {} },
  { label: 'CORE_ONLY', options: { w_ema: 0, w_mom: 0, w_adx: 0, w_vol: 0 } },
];

// ── Tier Definitions ────────────────────────────────────

interface TierDef { label: string; minScore: number; maxScore: number; }

const TIERS: TierDef[] = [
  { label: 'ALL', minScore: 70, maxScore: 101 },
  { label: '  S', minScore: 90, maxScore: 101 },
  { label: '  A', minScore: 80, maxScore: 90 },
];

// ── Sweep Dimensions ────────────────────────────────────

const IV_RANKS = [0, 30, 50];
const CREDIT_TPS = [0.30, 0.50];
const CREDIT_SLS = [100, 5.0, 2.0];         // 100 = no SL
const LEAP_TPS = [0.30, 0.50, 0.75];
const LEAP_SLS = [0.20, 0.30, 1.0];         // fraction (1.0 = no SL)

// ── Supabase ────────────────────────────────────────────

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
  return res.json();
}

// ── IV Rank Computation ─────────────────────────────────

function computeIVRank(ivSeries: (number | null)[]): (number | null)[] {
  const WINDOW = 252;
  return ivSeries.map((v, i) => {
    if (i < WINDOW || v == null) return null;
    const w = ivSeries.slice(i - WINDOW, i + 1).filter(x => x != null) as number[];
    if (w.length < 100) return null;
    const min = Math.min(...w), max = Math.max(...w), range = max - min;
    return range > 0 ? ((v - min) / range) * 100 : 50;
  });
}

// ── Candle Data Cache ───────────────────────────────────

interface TickerCandleData {
  ticker: string;
  candles: BacktestCandle[];
  ivRanks: (number | null)[];
  dateToIdx: Map<string, number>;
}

interface TickerSignals {
  ticker: string;
  entries: EntrySignal[];
  allTradingDates: string[];
}

const candleCache = new Map<string, TickerCandleData>();

async function fetchCandleData(ticker: string): Promise<TickerCandleData> {
  if (candleCache.has(ticker)) return candleCache.get(ticker)!;

  const candles: BacktestCandle[] = (await supabaseGet('stock_candles',
    `select=date,open,high,low,close,volume&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=5000`
  )).map(r => ({
    date: r.date, timestamp: new Date(r.date + 'T00:00:00Z').getTime(),
    open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume,
  }));

  const ivData = await supabaseGet('orats_iv_cache',
    `select=date,iv30d&ticker=eq.${ticker}&date=gte.${DATA_START}&date=lte.${DATA_END}&order=date.asc&limit=5000`);

  const ivByDate = new Map(ivData.map((r: any) => [r.date, r.iv30d]));
  const ivSeries = candles.map(c => ivByDate.get(c.date) ?? null);
  const ivRanks = computeIVRank(ivSeries);
  const dateToIdx = new Map(candles.map((c, i) => [c.date, i]));

  const data = { ticker, candles, ivRanks, dateToIdx };
  candleCache.set(ticker, data);
  return data;
}

async function generateSignals(
  ticker: string,
  periodStart: string,
  periodEnd: string,
  techOptions: TechScoreOptions = {},
): Promise<TickerSignals> {
  const td = await fetchCandleData(ticker);
  const { signals } = precomputeSignals(td.candles, '1D', techOptions);
  const entries: EntrySignal[] = [];

  for (const sig of signals) {
    if (sig.date < periodStart || sig.date > periodEnd) continue;
    if (sig.type === 'NEUTRAL' || sig.score < 70) continue;

    const idx = td.dateToIdx.get(sig.date);
    entries.push({
      ticker,
      date: sig.date,
      direction: sig.type as 'CALL' | 'PUT',
      score: sig.score,
      ivRank: idx != null ? (td.ivRanks[idx] ?? undefined) : undefined,
    });
  }

  const allTradingDates = td.candles
    .filter(c => c.date >= periodStart && c.date <= periodEnd)
    .map(c => c.date);

  return { ticker, entries, allTradingDates };
}

// ── Work Items ──────────────────────────────────────────

interface EvalWorkItem {
  id: number;
  config: SimConfig;
  minScore: number;
  maxScore: number;
  tierLabel: string;
  ivLabel: string;
  tpLabel: string;
  slLabel: string;
}

interface EvalWorkResult {
  type: 'result';
  id: number;
  analytics: OptionSimAnalytics;
  trades: OptionTrade[];
  tierLabel: string;
  ivLabel: string;
  tpLabel: string;
  slLabel: string;
}

function buildCreditWorkItems(): EvalWorkItem[] {
  const items: EvalWorkItem[] = [];
  let id = 0;
  for (const tier of TIERS) {
    for (const ivMin of IV_RANKS) {
      for (const tp of CREDIT_TPS) {
        for (const sl of CREDIT_SLS) {
          items.push({
            id: id++,
            config: {
              ...DEFAULT_CREDIT_CONFIG,
              minIVRank: ivMin,
              creditProfitTarget: tp,
              creditStopLossMultiple: sl,
            },
            minScore: tier.minScore,
            maxScore: tier.maxScore,
            tierLabel: tier.label,
            ivLabel: ivMin === 0 ? '>=0' : `>=${ivMin}`,
            tpLabel: `${(tp * 100).toFixed(0)}%`,
            slLabel: sl >= 100 ? 'None' : `${sl.toFixed(1)}x`,
          });
        }
      }
    }
  }
  return items;
}

function buildLeapWorkItems(): EvalWorkItem[] {
  const items: EvalWorkItem[] = [];
  let id = 0;
  for (const tier of TIERS) {
    for (const ivMin of IV_RANKS) {
      for (const tp of LEAP_TPS) {
        for (const sl of LEAP_SLS) {
          items.push({
            id: id++,
            config: {
              ...DEFAULT_LEAP_CONFIG,
              minIVRank: ivMin,
              leapProfitTarget: tp,
              leapStopLoss: sl,
            },
            minScore: tier.minScore,
            maxScore: tier.maxScore,
            tierLabel: tier.label,
            ivLabel: ivMin === 0 ? '>=0' : `>=${ivMin}`,
            tpLabel: `${(tp * 100).toFixed(0)}%`,
            slLabel: sl >= 1.0 ? 'None' : `${(sl * 100).toFixed(0)}%`,
          });
        }
      }
    }
  }
  return items;
}

// ── Worker Pool ─────────────────────────────────────────

async function createWorkerPool(
  allSignals: TickerSignals[],
  maxDate: string,
  numWorkers: number,
): Promise<Worker[]> {
  const workerSrc = path.resolve(__dirname, 'eval-worker.ts');
  const workerBundle = path.resolve(__dirname, '.eval-worker.mjs');
  const { execSync } = await import('child_process');
  execSync(
    `npx esbuild ${workerSrc} --bundle --platform=node --format=esm --outfile=${workerBundle} --external:better-sqlite3 --packages=external`,
    { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' },
  );

  return Promise.all(
    Array.from({ length: numWorkers }, () =>
      new Promise<Worker>((resolve, reject) => {
        const w = new Worker(workerBundle, {
          workerData: { allSignals, maxDate, token: ORATS_TOKEN },
        });
        w.once('message', (msg) => { if (msg.type === 'ready') resolve(w); });
        w.once('error', reject);
      }),
    ),
  );
}

async function terminatePool(workers: Worker[]) {
  for (const w of workers) w.postMessage({ type: 'exit' });
  await new Promise(r => setTimeout(r, 200));
  for (const w of workers) w.terminate();
}

async function runParallelSweep(
  workers: Worker[],
  workItems: EvalWorkItem[],
  label: string,
): Promise<EvalWorkResult[]> {
  if (workItems.length === 0) return [];

  const results: EvalWorkResult[] = new Array(workItems.length);
  let nextIdx = 0;
  let completed = 0;
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    let lastLogPct = -10; // log every 10%
    let liveWorkers = workers.length;

    function sendNext(worker: Worker) {
      if (nextIdx >= workItems.length) return;
      worker.postMessage(workItems[nextIdx++]);
    }

    function checkDone() {
      if (completed === workItems.length) {
        resolve(results);
      } else if (liveWorkers === 0) {
        console.log(`    [${label}] WARNING: all workers dead, ${completed}/${workItems.length} completed`);
        resolve(results);
      }
    }

    for (const worker of workers) {
      worker.on('message', (msg: EvalWorkResult) => {
        if (msg.type !== 'result') return;
        results[msg.id] = msg;
        completed++;

        if ((msg as any).error) {
          console.log(`    [${label}] Worker error on item ${msg.id}: ${(msg as any).error}`);
        }

        const pct = Math.round(completed / workItems.length * 100);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

        // Log at every 10% milestone or on completion
        if (pct >= lastLogPct + 10 || completed === workItems.length) {
          lastLogPct = Math.floor(pct / 10) * 10;
          console.log(`    [${label}] ${completed}/${workItems.length} (${pct}%) | ${elapsed}s`);
        }

        if (completed === workItems.length) {
          resolve(results);
        } else {
          sendNext(worker);
        }
      });

      worker.on('error', (err) => {
        console.log(`    [${label}] Worker crashed: ${err.message}`);
        liveWorkers--;
        checkDone();
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          console.log(`    [${label}] Worker exited with code ${code}`);
          liveWorkers--;
          checkDone();
        }
      });

      sendNext(worker);
    }
  });
}

// ── Buy & Hold Benchmark ────────────────────────────────

interface BenchmarkResult {
  period: string;
  totalReturn: number;
  sharpe: number;
  maxDD: number;
  annualizedReturn: number;
}

async function computeBuyHold(startDate: string, endDate: string, label: string): Promise<BenchmarkResult> {
  const allTickerReturns: Map<string, number[]> = new Map();
  const dateMap = new Map<string, number[]>();

  for (const ticker of tickers) {
    const rows = await supabaseGet('stock_candles',
      `select=date,close&ticker=eq.${ticker}&timeframe=eq.1D&date=gte.${startDate}&date=lte.${endDate}&order=date.asc&limit=5000`);

    if (rows.length < 50) continue;

    for (let i = 1; i < rows.length; i++) {
      const date = rows[i].date;
      const ret = (Number(rows[i].close) - Number(rows[i - 1].close)) / Number(rows[i - 1].close);
      if (!dateMap.has(date)) dateMap.set(date, []);
      dateMap.get(date)!.push(ret);
    }
  }

  const dates = Array.from(dateMap.keys()).sort();
  const portfolioReturns = dates.map(d => {
    const rets = dateMap.get(d)!;
    return rets.reduce((s, v) => s + v, 0) / rets.length;
  });

  const avg = portfolioReturns.reduce((s, v) => s + v, 0) / portfolioReturns.length;
  const std = Math.sqrt(portfolioReturns.reduce((s, v) => s + (v - avg) ** 2, 0) / (portfolioReturns.length - 1));
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  const equity = portfolioReturns.reduce((cum, r) => cum * (1 + r), 1);
  const totalReturn = (equity - 1) * 100;

  let peak = 1, maxDD = 0, eq = 1;
  for (const r of portfolioReturns) {
    eq *= (1 + r); peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, (peak - eq) / peak * 100);
  }

  const years = dates.length / 252;
  const annualizedReturn = (Math.pow(equity, 1 / years) - 1) * 100;

  return { period: label, totalReturn, sharpe, maxDD, annualizedReturn };
}

// ── Table Formatting ────────────────────────────────────

function fmtPnl(pnl: number): string {
  return pnl >= 0 ? `+$${(pnl / 1000).toFixed(1)}k` : `-$${(Math.abs(pnl) / 1000).toFixed(1)}k`;
}

function fmtSharpe(s: number): string { return s.toFixed(2); }
function fmtPct(p: number): string { return `${p.toFixed(1)}%`; }

// ── Report: Section Printer ─────────────────────────────

interface RankedResult {
  rank: number;
  mode: string;
  signal: string;
  tierLabel: string;
  ivLabel: string;
  tpLabel: string;
  slLabel: string;
  isAnalytics: OptionSimAnalytics;
  oosAnalytics: OptionSimAnalytics | null;
  isTrades: never[]; // trades stay in workers, not serialized
  oosTrades: never[];
  decayPct: number | null;
}

function printSweepTable(results: EvalWorkResult[], title: string) {
  console.log(`\n  ${title}`);
  console.log('  ' + '-'.repeat(100));
  console.log(
    '  ' + 'Rk'.padStart(3) + ' | ' +
    'Tier'.padEnd(4) + ' | ' +
    'IV Rnk'.padEnd(6) + ' | ' +
    'TP'.padEnd(4) + ' | ' +
    'SL'.padEnd(5) + ' | ' +
    'Trades'.padStart(6) + ' | ' +
    'WR%'.padStart(5) + ' | ' +
    'Sharpe'.padStart(6) + ' | ' +
    'PF'.padStart(6) + ' | ' +
    'Avg%'.padStart(6) + ' | ' +
    'Total P&L'.padStart(10) + ' | ' +
    'ROC%'.padStart(6) + ' | ' +
    'MaxDD%'.padStart(6),
  );
  console.log('  ' + '-'.repeat(100));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const a = r.analytics;
    console.log(
      '  ' + `#${i + 1}`.padStart(3) + ' | ' +
      r.tierLabel.padEnd(4) + ' | ' +
      r.ivLabel.padEnd(6) + ' | ' +
      r.tpLabel.padEnd(4) + ' | ' +
      r.slLabel.padEnd(5) + ' | ' +
      String(a.totalTrades).padStart(6) + ' | ' +
      fmtPct(a.winRate).padStart(5) + ' | ' +
      fmtSharpe(a.sharpe).padStart(6) + ' | ' +
      a.profitFactor.toFixed(2).padStart(6) + ' | ' +
      fmtPct(a.avgPnlPct).padStart(6) + ' | ' +
      fmtPnl(a.totalPnl).padStart(10) + ' | ' +
      fmtPct(a.returnOnCapital).padStart(6) + ' | ' +
      fmtPct(a.maxDrawdown).padStart(6),
    );
  }
  console.log('  ' + '-'.repeat(100));
}

function printISvsOOS(
  topIS: EvalWorkResult[],
  oosResults: EvalWorkResult[],
  title: string,
) {
  console.log(`\n  ${title}`);
  console.log('  ' + '-'.repeat(140));
  console.log(
    '  ' + 'Rk'.padStart(3) + ' | ' +
    'Tier'.padEnd(4) + ' | ' +
    'IV'.padEnd(4) + ' | ' +
    'TP'.padEnd(4) + ' | ' +
    'SL'.padEnd(5) + ' || ' +
    'IS Shrp'.padStart(7) + ' | ' +
    'IS WR'.padStart(5) + ' | ' +
    'IS P&L'.padStart(10) + ' | ' +
    'IS Tr'.padStart(5) + ' || ' +
    'OOS Shrp'.padStart(8) + ' | ' +
    'OOS WR'.padStart(6) + ' | ' +
    'OOS P&L'.padStart(10) + ' | ' +
    'OOS Tr'.padStart(6) + ' || ' +
    'Decay'.padStart(6),
  );
  console.log('  ' + '-'.repeat(140));

  for (let i = 0; i < topIS.length; i++) {
    const isR = topIS[i];
    const oosR = oosResults[i];
    const isA = isR.analytics;
    const oosA = oosR.analytics;
    const decay = isA.sharpe > 0
      ? ((1 - oosA.sharpe / isA.sharpe) * 100)
      : 0;

    console.log(
      '  ' + `#${i + 1}`.padStart(3) + ' | ' +
      isR.tierLabel.padEnd(4) + ' | ' +
      isR.ivLabel.padEnd(4) + ' | ' +
      isR.tpLabel.padEnd(4) + ' | ' +
      isR.slLabel.padEnd(5) + ' || ' +
      fmtSharpe(isA.sharpe).padStart(7) + ' | ' +
      fmtPct(isA.winRate).padStart(5) + ' | ' +
      fmtPnl(isA.totalPnl).padStart(10) + ' | ' +
      String(isA.totalTrades).padStart(5) + ' || ' +
      fmtSharpe(oosA.sharpe).padStart(8) + ' | ' +
      fmtPct(oosA.winRate).padStart(6) + ' | ' +
      fmtPnl(oosA.totalPnl).padStart(10) + ' | ' +
      String(oosA.totalTrades).padStart(6) + ' || ' +
      `${decay.toFixed(0)}%`.padStart(6),
    );
  }
  console.log('  ' + '-'.repeat(140));
}

// ── Main ────────────────────────────────────────────────

interface VariantSweepResult {
  signalLabel: string;
  mode: string;
  isResults: EvalWorkResult[];
  oosResults: EvalWorkResult[];
  topN: EvalWorkResult[];
  allWorkItems: EvalWorkItem[];
}

async function main() {
  const globalStart = Date.now();

  // ═══════════════════════════════════════════════════════
  //  HEADER
  // ═══════════════════════════════════════════════════════
  console.log('');
  console.log('='.repeat(90));
  console.log('  UNIFIED COMPREHENSIVE STRATEGY EVALUATION');
  console.log('='.repeat(90));
  console.log(`  IS  (train):    ${IS_START} -> ${IS_END}  (6 years)`);
  console.log(`  OOS (validate): ${OOS_START} -> ${OOS_END}  (~2 years, 3-month gap)`);
  console.log(`  Tickers: ${tickers.join(', ')} (${tickers.length})`);
  console.log(`  Workers: ${NUM_WORKERS} threads (${os.cpus().length} CPU cores)`);
  console.log(`  Signal variants: BASELINE (all features) vs CORE_ONLY (MB+BXS+BXL)`);
  console.log(`  Credit: ${CREDIT_TPS.length} TP x ${CREDIT_SLS.length} SL x ${IV_RANKS.length} IV x ${TIERS.length} tier = ${buildCreditWorkItems().length} configs`);
  console.log(`  LEAP:   ${LEAP_TPS.length} TP x ${LEAP_SLS.length} SL x ${IV_RANKS.length} IV x ${TIERS.length} tier = ${buildLeapWorkItems().length} configs`);
  console.log('='.repeat(90));

  // Verify chain cache
  initDB();
  const stats = getCacheStats();
  console.log(`\n  Chain Cache: ${stats.totalRows.toLocaleString()} rows, ${stats.totalDates.toLocaleString()} ticker-dates`);
  console.log(`  Cached tickers: ${stats.tickers.join(', ')}`);
  closeDB();

  // ═══════════════════════════════════════════════════════
  //  DATA LOADING
  // ═══════════════════════════════════════════════════════
  console.log('\n  Loading candle data...');
  for (const ticker of tickers) {
    await fetchCandleData(ticker);
    process.stdout.write(`    ${ticker} `);
  }
  console.log('\n');

  // ═══════════════════════════════════════════════════════
  //  SWEEPS
  // ═══════════════════════════════════════════════════════
  const allVariantResults: VariantSweepResult[] = [];

  for (const variant of SIGNAL_VARIANTS) {
    // Generate IS signals
    console.log(`\n  === Signal: ${variant.label} ===`);
    console.log(`  Generating IS signals (${IS_START} -> ${IS_END})...`);
    const isSignals: TickerSignals[] = [];
    for (const ticker of tickers) {
      isSignals.push(await generateSignals(ticker, IS_START, IS_END, variant.options));
    }
    const totalIS = isSignals.reduce((s, ts) => s + ts.entries.length, 0);
    console.log(`    Total IS signals: ${totalIS}`);

    // Generate OOS signals
    console.log(`  Generating OOS signals (${OOS_START} -> ${OOS_END})...`);
    const oosSignals: TickerSignals[] = [];
    for (const ticker of tickers) {
      oosSignals.push(await generateSignals(ticker, OOS_START, OOS_END, variant.options));
    }
    const totalOOS = oosSignals.reduce((s, ts) => s + ts.entries.length, 0);
    console.log(`    Total OOS signals: ${totalOOS}`);

    // ─── Credit Spread Sweep ────────────────────────────
    if (!SKIP_CREDITS) {
      const creditItems = buildCreditWorkItems();
      console.log(`\n  IS Credit Sweep (${variant.label}): ${creditItems.length} configs...`);
      const isWorkers = await createWorkerPool(isSignals, IS_END, NUM_WORKERS);
      const isCreditResults = await runParallelSweep(isWorkers, creditItems, `IS-CREDIT-${variant.label}`);
      await terminatePool(isWorkers);

      // Top N by Sharpe
      const qualified = isCreditResults
        .filter(r => r.analytics.totalTrades >= MIN_TRADES)
        .sort((a, b) => b.analytics.sharpe - a.analytics.sharpe);
      const topN = qualified.slice(0, TOP_N);

      // OOS validation
      const oosWorkItems = topN.map((r, i) => ({ ...creditItems[r.id], id: i }));
      console.log(`  OOS Credit Validation (${variant.label}): ${oosWorkItems.length} configs...`);
      const oosWorkers = await createWorkerPool(oosSignals, OOS_END, NUM_WORKERS);
      const oosCreditResults = await runParallelSweep(oosWorkers, oosWorkItems, `OOS-CREDIT-${variant.label}`);
      await terminatePool(oosWorkers);

      allVariantResults.push({
        signalLabel: variant.label,
        mode: 'CREDIT_SPREAD',
        isResults: isCreditResults,
        oosResults: oosCreditResults,
        topN,
        allWorkItems: creditItems,
      });
    }

    // ─── LEAP Sweep ─────────────────────────────────────
    if (!SKIP_LEAPS) {
      const leapItems = buildLeapWorkItems();
      console.log(`\n  IS LEAP Sweep (${variant.label}): ${leapItems.length} configs...`);
      const isWorkers = await createWorkerPool(isSignals, IS_END, NUM_WORKERS);
      const isLeapResults = await runParallelSweep(isWorkers, leapItems, `IS-LEAP-${variant.label}`);
      await terminatePool(isWorkers);

      const qualified = isLeapResults
        .filter(r => r.analytics.totalTrades >= MIN_TRADES)
        .sort((a, b) => b.analytics.sharpe - a.analytics.sharpe);
      const topN = qualified.slice(0, TOP_N);

      const oosWorkItems = topN.map((r, i) => ({ ...leapItems[r.id], id: i }));
      console.log(`  OOS LEAP Validation (${variant.label}): ${oosWorkItems.length} configs...`);
      const oosWorkers = await createWorkerPool(oosSignals, OOS_END, NUM_WORKERS);
      const oosLeapResults = await runParallelSweep(oosWorkers, oosWorkItems, `OOS-LEAP-${variant.label}`);
      await terminatePool(oosWorkers);

      allVariantResults.push({
        signalLabel: variant.label,
        mode: 'LEAP',
        isResults: isLeapResults,
        oosResults: oosLeapResults,
        topN,
        allWorkItems: leapItems,
      });
    }
  }

  // ═══════════════════════════════════════════════════════
  //  REPORT
  // ═══════════════════════════════════════════════════════

  console.log('\n');
  console.log('='.repeat(90));
  console.log('  RESULTS');
  console.log('='.repeat(90));

  // ─── Section 1 & 2: IS Sweep Rankings ─────────────────
  for (const vr of allVariantResults) {
    const sorted = [...vr.isResults]
      .filter(r => r.analytics.totalTrades >= MIN_TRADES)
      .sort((a, b) => b.analytics.sharpe - a.analytics.sharpe)
      .slice(0, 20);

    printSweepTable(sorted,
      `SECTION 1/2: ${vr.mode} IS SWEEP — ${vr.signalLabel} (top 20 of ${vr.isResults.length})`);
  }

  // ─── Section 3 & 4: IS vs OOS ─────────────────────────
  for (const vr of allVariantResults) {
    printISvsOOS(vr.topN, vr.oosResults,
      `SECTION 3/4: ${vr.mode} — ${vr.signalLabel} — IS vs OOS (top ${vr.topN.length})`);
  }

  // ─── Section 5: Benchmark Comparison ──────────────────
  console.log('\n  SECTION 5: BENCHMARK COMPARISON');
  console.log('  ' + '-'.repeat(80));

  const bhIS = await computeBuyHold(IS_START, IS_END, 'IS');
  const bhOOS = await computeBuyHold(OOS_START, OOS_END, 'OOS');

  console.log(`    Buy & Hold IS  (${IS_START}->${IS_END}):  Sharpe ${fmtSharpe(bhIS.sharpe)}, Return ${fmtPct(bhIS.totalReturn)}, MaxDD ${fmtPct(bhIS.maxDD)}, Ann ${fmtPct(bhIS.annualizedReturn)}`);
  console.log(`    Buy & Hold OOS (${OOS_START}->${OOS_END}): Sharpe ${fmtSharpe(bhOOS.sharpe)}, Return ${fmtPct(bhOOS.totalReturn)}, MaxDD ${fmtPct(bhOOS.maxDD)}, Ann ${fmtPct(bhOOS.annualizedReturn)}`);

  for (const vr of allVariantResults) {
    if (vr.oosResults.length === 0) continue;
    const bestOOS = vr.oosResults.reduce((a, b) =>
      a.analytics.sharpe > b.analytics.sharpe ? a : b);
    const bestIdx = vr.oosResults.indexOf(bestOOS);
    const bestIS = vr.topN[bestIdx];
    console.log(`    Best ${vr.mode} ${vr.signalLabel} OOS: Sharpe ${fmtSharpe(bestOOS.analytics.sharpe)}, ` +
      `WR ${fmtPct(bestOOS.analytics.winRate)}, P&L ${fmtPnl(bestOOS.analytics.totalPnl)} ` +
      `(${bestIS.tierLabel.trim()} IV${bestIS.ivLabel} TP${bestIS.tpLabel} SL${bestIS.slLabel})`);
  }
  console.log('  ' + '-'.repeat(80));

  // ─── Section 6: Signal Variant Summary ────────────────
  console.log('\n  SECTION 6: SIGNAL VARIANT SUMMARY');
  console.log('  ' + '-'.repeat(80));

  const modeGroups = new Map<string, VariantSweepResult[]>();
  for (const vr of allVariantResults) {
    if (!modeGroups.has(vr.mode)) modeGroups.set(vr.mode, []);
    modeGroups.get(vr.mode)!.push(vr);
  }

  for (const [mode, variants] of modeGroups) {
    if (variants.length < 2) continue;
    const baseline = variants.find(v => v.signalLabel === 'BASELINE');
    const coreOnly = variants.find(v => v.signalLabel === 'CORE_ONLY');
    if (!baseline || !coreOnly) continue;

    // Compare best OOS Sharpe
    const bestBL = baseline.oosResults.length > 0
      ? baseline.oosResults.reduce((a, b) => a.analytics.sharpe > b.analytics.sharpe ? a : b)
      : null;
    const bestCO = coreOnly.oosResults.length > 0
      ? coreOnly.oosResults.reduce((a, b) => a.analytics.sharpe > b.analytics.sharpe ? a : b)
      : null;

    console.log(`    ${mode}:`);
    if (bestBL) console.log(`      BASELINE  best OOS Sharpe: ${fmtSharpe(bestBL.analytics.sharpe)}`);
    if (bestCO) console.log(`      CORE_ONLY best OOS Sharpe: ${fmtSharpe(bestCO.analytics.sharpe)}`);

    // Count wins across comparable configs
    const blSurvived = baseline.oosResults.filter(r => r.analytics.sharpe > 0).length;
    const coSurvived = coreOnly.oosResults.filter(r => r.analytics.sharpe > 0).length;
    console.log(`      BASELINE  survived OOS: ${blSurvived}/${baseline.oosResults.length}`);
    console.log(`      CORE_ONLY survived OOS: ${coSurvived}/${coreOnly.oosResults.length}`);

    if (bestBL && bestCO) {
      const winner = bestCO.analytics.sharpe > bestBL.analytics.sharpe ? 'CORE_ONLY' : 'BASELINE';
      console.log(`      Winner: ${winner}`);
    }
  }
  console.log('  ' + '-'.repeat(80));

  // ─── Section 7: IV Filter Analysis ────────────────────
  console.log('\n  SECTION 7: IV FILTER ANALYSIS');
  console.log('  ' + '-'.repeat(80));

  for (const vr of allVariantResults) {
    if (vr.oosResults.length === 0) continue;
    console.log(`    ${vr.mode} — ${vr.signalLabel}:`);

    // Group IS results by IV filter
    for (const ivLabel of ['>=0', '>=30', '>=50']) {
      const ivResults = vr.isResults
        .filter(r => r.ivLabel === ivLabel && r.analytics.totalTrades >= MIN_TRADES);
      if (ivResults.length === 0) continue;

      const avgSharpe = ivResults.reduce((s, r) => s + r.analytics.sharpe, 0) / ivResults.length;
      const avgWR = ivResults.reduce((s, r) => s + r.analytics.winRate, 0) / ivResults.length;
      const avgTrades = ivResults.reduce((s, r) => s + r.analytics.totalTrades, 0) / ivResults.length;

      console.log(`      IV ${ivLabel.padEnd(4)}: avg Sharpe ${fmtSharpe(avgSharpe)}, avg WR ${fmtPct(avgWR)}, avg trades ${avgTrades.toFixed(0)} (${ivResults.length} configs)`);
    }
  }
  console.log('  ' + '-'.repeat(80));

  // ─── Section 8: Survival Statistics ───────────────────
  console.log('\n  SECTION 8: SURVIVAL STATISTICS');
  console.log('  ' + '-'.repeat(80));

  for (const vr of allVariantResults) {
    if (vr.oosResults.length === 0) continue;
    const n = vr.oosResults.length;
    const oosPositive = vr.oosResults.filter(r => r.analytics.sharpe > 0).length;
    const oosAbove05 = vr.oosResults.filter(r => r.analytics.sharpe > 0.5).length;
    const retained50 = vr.topN.filter((is, i) =>
      vr.oosResults[i].analytics.sharpe >= is.analytics.sharpe * 0.5).length;
    const oosProfit = vr.oosResults.filter(r => r.analytics.totalPnl > 0).length;

    console.log(`    ${vr.mode} — ${vr.signalLabel} (${n} configs):`);
    console.log(`      Positive OOS Sharpe:     ${oosPositive}/${n} (${Math.round(oosPositive / n * 100)}%)`);
    console.log(`      OOS Sharpe > 0.5:        ${oosAbove05}/${n} (${Math.round(oosAbove05 / n * 100)}%)`);
    console.log(`      Retained >=50% IS Sharpe: ${retained50}/${n} (${Math.round(retained50 / n * 100)}%)`);
    console.log(`      Profitable in OOS:       ${oosProfit}/${n} (${Math.round(oosProfit / n * 100)}%)`);
  }
  console.log('  ' + '-'.repeat(80));

  // ─── Section 9: Final Rankings ────────────────────────
  console.log('\n  SECTION 9: FINAL RANKINGS — Top 10 Overall by OOS Sharpe');
  console.log('  ' + '-'.repeat(120));

  const allRanked: RankedResult[] = [];
  for (const vr of allVariantResults) {
    for (let i = 0; i < vr.topN.length; i++) {
      const isR = vr.topN[i];
      const oosR = vr.oosResults[i];
      const decay = isR.analytics.sharpe > 0
        ? (1 - oosR.analytics.sharpe / isR.analytics.sharpe) * 100
        : 0;
      allRanked.push({
        rank: 0,
        mode: vr.mode,
        signal: vr.signalLabel,
        tierLabel: isR.tierLabel.trim(),
        ivLabel: isR.ivLabel,
        tpLabel: isR.tpLabel,
        slLabel: isR.slLabel,
        isAnalytics: isR.analytics,
        oosAnalytics: oosR.analytics,
        isTrades: isR.trades || [],
        oosTrades: oosR.trades || [],
        decayPct: decay,
      });
    }
  }

  allRanked.sort((a, b) => (b.oosAnalytics?.sharpe ?? 0) - (a.oosAnalytics?.sharpe ?? 0));
  allRanked.forEach((r, i) => r.rank = i + 1);

  console.log(
    '  ' + 'Rk'.padStart(3) + ' | ' +
    'Mode'.padEnd(13) + ' | ' +
    'Signal'.padEnd(9) + ' | ' +
    'Tier'.padEnd(4) + ' | ' +
    'IV'.padEnd(4) + ' | ' +
    'TP'.padEnd(4) + ' | ' +
    'SL'.padEnd(5) + ' | ' +
    'IS Shrp'.padStart(7) + ' | ' +
    'OOS Shrp'.padStart(8) + ' | ' +
    'OOS WR'.padStart(6) + ' | ' +
    'OOS P&L'.padStart(10) + ' | ' +
    'OOS Tr'.padStart(6) + ' | ' +
    'Decay'.padStart(6),
  );
  console.log('  ' + '-'.repeat(120));

  for (const r of allRanked.slice(0, 10)) {
    const oos = r.oosAnalytics!;
    console.log(
      '  ' + `#${r.rank}`.padStart(3) + ' | ' +
      r.mode.padEnd(13) + ' | ' +
      r.signal.padEnd(9) + ' | ' +
      r.tierLabel.padEnd(4) + ' | ' +
      r.ivLabel.padEnd(4) + ' | ' +
      r.tpLabel.padEnd(4) + ' | ' +
      r.slLabel.padEnd(5) + ' | ' +
      fmtSharpe(r.isAnalytics.sharpe).padStart(7) + ' | ' +
      fmtSharpe(oos.sharpe).padStart(8) + ' | ' +
      fmtPct(oos.winRate).padStart(6) + ' | ' +
      fmtPnl(oos.totalPnl).padStart(10) + ' | ' +
      String(oos.totalTrades).padStart(6) + ' | ' +
      `${(r.decayPct ?? 0).toFixed(0)}%`.padStart(6),
    );
  }
  console.log('  ' + '-'.repeat(120));

  // ═══════════════════════════════════════════════════════
  //  JSON Export
  // ═══════════════════════════════════════════════════════
  const dataDir = path.resolve(__dirname, '../data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const exportData = {
    meta: {
      date: new Date().toISOString(),
      tickers,
      isRange: { start: IS_START, end: IS_END },
      oosRange: { start: OOS_START, end: OOS_END },
      signalVariants: SIGNAL_VARIANTS.map(v => v.label),
    },
    benchmarks: { buyHoldIS: bhIS, buyHoldOOS: bhOOS },
    rankings: allRanked.slice(0, 30).map(r => ({
      rank: r.rank,
      mode: r.mode,
      signal: r.signal,
      tier: r.tierLabel,
      iv: r.ivLabel,
      tp: r.tpLabel,
      sl: r.slLabel,
      is: {
        sharpe: r.isAnalytics.sharpe,
        winRate: r.isAnalytics.winRate,
        totalPnl: r.isAnalytics.totalPnl,
        totalTrades: r.isAnalytics.totalTrades,
        profitFactor: r.isAnalytics.profitFactor,
        maxDrawdown: r.isAnalytics.maxDrawdown,
        avgPnlPct: r.isAnalytics.avgPnlPct,
        returnOnCapital: r.isAnalytics.returnOnCapital,
      },
      oos: r.oosAnalytics ? {
        sharpe: r.oosAnalytics.sharpe,
        winRate: r.oosAnalytics.winRate,
        totalPnl: r.oosAnalytics.totalPnl,
        totalTrades: r.oosAnalytics.totalTrades,
        profitFactor: r.oosAnalytics.profitFactor,
        maxDrawdown: r.oosAnalytics.maxDrawdown,
        avgPnlPct: r.oosAnalytics.avgPnlPct,
        returnOnCapital: r.oosAnalytics.returnOnCapital,
      } : null,
      decayPct: r.decayPct,
    })),
    sweepDetails: allVariantResults.map(vr => ({
      signal: vr.signalLabel,
      mode: vr.mode,
      totalConfigs: vr.isResults.length,
      qualifiedConfigs: vr.isResults.filter(r => r.analytics.totalTrades >= MIN_TRADES).length,
      topN: vr.topN.length,
      isResults: vr.isResults.map(r => ({
        id: r.id,
        tier: r.tierLabel.trim(),
        iv: r.ivLabel,
        tp: r.tpLabel,
        sl: r.slLabel,
        sharpe: r.analytics.sharpe,
        winRate: r.analytics.winRate,
        totalTrades: r.analytics.totalTrades,
        totalPnl: r.analytics.totalPnl,
        profitFactor: r.analytics.profitFactor,
      })),
      oosResults: vr.oosResults.map(r => ({
        id: r.id,
        sharpe: r.analytics.sharpe,
        winRate: r.analytics.winRate,
        totalTrades: r.analytics.totalTrades,
        totalPnl: r.analytics.totalPnl,
        profitFactor: r.analytics.profitFactor,
      })),
    })),
  };

  const jsonPath = path.resolve(dataDir, 'unified-eval-results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(exportData, null, 2));
  console.log(`\n  Results exported to: ${jsonPath}`);

  // ═══════════════════════════════════════════════════════
  //  SUMMARY
  // ═══════════════════════════════════════════════════════
  const elapsed = ((Date.now() - globalStart) / 1000 / 60).toFixed(1);
  console.log(`\n  Total runtime: ${elapsed} minutes`);
  console.log('='.repeat(90));
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
