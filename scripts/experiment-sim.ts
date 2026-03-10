/**
 * Experiment Simulator — Tests 3 research dimensions on credit spreads
 *
 * 1. Position Sizing: spread width ($5/$10/$15), contracts per signal (1/2/3)
 * 2. Score-Based Exit: exit when tech score drops below threshold (60/50/40/30)
 * 3. Option Filters: bid-ask spread %, volume, OI, entry IV level
 *
 * Each experiment is crossed with 4 proven base signals to detect real vs overfit effects.
 * IS: 2018-01–2023-12 | OOS: 2024-04–2026-02
 *
 * Usage:
 *   npx tsx scripts/experiment-sim.ts
 *   npx tsx scripts/experiment-sim.ts --experiment sizing
 *   npx tsx scripts/experiment-sim.ts --experiment score-exit
 *   npx tsx scripts/experiment-sim.ts --experiment option-filter
 *   npx tsx scripts/experiment-sim.ts --experiment all
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
  DEFAULT_CREDIT_CONFIG,
  type EntrySignal, type SimConfig,
} from '../src/lib/backtest/option-sim';

// ── Config ──────────────────────────────────────────────
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
const ORATS_TOKEN = process.env.ORATS_API_TOKEN || '';

const DATA_START = '2017-01-01';
const IS_START   = '2018-01-01';
const IS_END     = '2023-12-31';
const OOS_START  = '2024-04-01';
const OOS_END    = '2026-02-28';
const DATA_END   = '2026-02-28';

const ALL_TICKERS = [
  'SPY', 'QQQ', 'AMD', 'IWM', 'TSLA',
  'AAPL', 'JPM', 'NVDA', 'AMZN', 'MSFT',
  'META', 'NFLX', 'GOOG', 'GS', 'COST',
];

const NUM_WORKERS = Math.min(os.cpus().length - 2, 20);
const STARTING_CAPITAL = 100_000;
const MAX_POSITIONS = 50;

// CLI
const args = process.argv.slice(2);
function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}
const EXPERIMENT_FILTER = getArg('--experiment') || 'all';

// ══════════════════════════════════════════════════════════
//  BASE SIGNALS (proven robust from Phase 2/3)
// ══════════════════════════════════════════════════════════

interface SignalVariant {
  key: string;
  techOptions: TechScoreOptions;
}

const BASE_SIGNALS: SignalVariant[] = [
  { key: 'mom', techOptions: { w_mb: 0, w_bxs: 0, w_bxl: 0, w_ema: 0, w_adx: 0, w_vol: 0 } },
  { key: 'ema', techOptions: { w_mb: 0, w_bxs: 0, w_bxl: 0, w_mom: 0, w_adx: 0, w_vol: 0 } },
  { key: 'MF',  techOptions: { w_bxs: 0, w_bxl: 0, w_adx: 0, w_vol: 0 } },
  { key: 'EM',  techOptions: { w_mb: 0, w_bxs: 0, w_bxl: 0, w_adx: 0, w_vol: 0 } },
];

// ══════════════════════════════════════════════════════════
//  EXPERIMENT 1: POSITION SIZING
// ══════════════════════════════════════════════════════════

interface SizingConfig {
  key: string;
  spreadWidth: number;     // $5, $10, $15
  contractsPerSignal: number; // 1, 2, 3
}

const SIZING_LEVELS: SizingConfig[] = [
  // Baseline
  { key: 'w5_c1',  spreadWidth: 5,  contractsPerSignal: 1 },
  // Wider spreads (more premium collected, more risk per trade)
  { key: 'w10_c1', spreadWidth: 10, contractsPerSignal: 1 },
  { key: 'w15_c1', spreadWidth: 15, contractsPerSignal: 1 },
  // Multiple contracts (same risk profile, scaled up)
  { key: 'w5_c2',  spreadWidth: 5,  contractsPerSignal: 2 },
  { key: 'w5_c3',  spreadWidth: 5,  contractsPerSignal: 3 },
  // Combined: wider + more contracts
  { key: 'w10_c2', spreadWidth: 10, contractsPerSignal: 2 },
];

// ══════════════════════════════════════════════════════════
//  EXPERIMENT 2: SCORE-BASED EXIT
// ══════════════════════════════════════════════════════════

// Score exit thresholds — exit if score drops below this on a monitoring day
// 0 = no score exit (baseline)
const SCORE_EXIT_LEVELS = [0, 30, 40, 50, 60];

// ══════════════════════════════════════════════════════════
//  EXPERIMENT 3: OPTION FILTERS
// ══════════════════════════════════════════════════════════

interface OptionFilter {
  key: string;
  // All thresholds: 0 = disabled (no filter)
  minShortVolume: number;     // min volume on short leg
  minShortOI: number;         // min open interest on short leg
  maxBidAskPct: number;       // max bid-ask spread as % of mid (0 = no filter)
  minEntryIV: number;         // min IV on short leg (0 = no filter)
  maxEntryIV: number;         // max IV on short leg (999 = no filter)
  minNetCreditPct: number;    // min net credit as % of spread width (0 = no filter)
}

const OPTION_FILTERS: OptionFilter[] = [
  // Baseline: no option filters
  { key: 'noFilter', minShortVolume: 0, minShortOI: 0, maxBidAskPct: 0, minEntryIV: 0, maxEntryIV: 999, minNetCreditPct: 0 },

  // Volume filters
  { key: 'vol10',    minShortVolume: 10, minShortOI: 0, maxBidAskPct: 0, minEntryIV: 0, maxEntryIV: 999, minNetCreditPct: 0 },
  { key: 'vol50',    minShortVolume: 50, minShortOI: 0, maxBidAskPct: 0, minEntryIV: 0, maxEntryIV: 999, minNetCreditPct: 0 },
  { key: 'vol100',   minShortVolume: 100, minShortOI: 0, maxBidAskPct: 0, minEntryIV: 0, maxEntryIV: 999, minNetCreditPct: 0 },

  // Open interest filters
  { key: 'oi100',    minShortVolume: 0, minShortOI: 100, maxBidAskPct: 0, minEntryIV: 0, maxEntryIV: 999, minNetCreditPct: 0 },
  { key: 'oi500',    minShortVolume: 0, minShortOI: 500, maxBidAskPct: 0, minEntryIV: 0, maxEntryIV: 999, minNetCreditPct: 0 },
  { key: 'oi1000',   minShortVolume: 0, minShortOI: 1000, maxBidAskPct: 0, minEntryIV: 0, maxEntryIV: 999, minNetCreditPct: 0 },

  // Bid-ask spread filters (tighter = more liquid)
  { key: 'ba10pct',  minShortVolume: 0, minShortOI: 0, maxBidAskPct: 0.10, minEntryIV: 0, maxEntryIV: 999, minNetCreditPct: 0 },
  { key: 'ba20pct',  minShortVolume: 0, minShortOI: 0, maxBidAskPct: 0.20, minEntryIV: 0, maxEntryIV: 999, minNetCreditPct: 0 },
  { key: 'ba30pct',  minShortVolume: 0, minShortOI: 0, maxBidAskPct: 0.30, minEntryIV: 0, maxEntryIV: 999, minNetCreditPct: 0 },

  // IV range filters (sell premium when IV is elevated)
  { key: 'iv20plus', minShortVolume: 0, minShortOI: 0, maxBidAskPct: 0, minEntryIV: 0.20, maxEntryIV: 999, minNetCreditPct: 0 },
  { key: 'iv30plus', minShortVolume: 0, minShortOI: 0, maxBidAskPct: 0, minEntryIV: 0.30, maxEntryIV: 999, minNetCreditPct: 0 },
  { key: 'ivCap80',  minShortVolume: 0, minShortOI: 0, maxBidAskPct: 0, minEntryIV: 0, maxEntryIV: 0.80, minNetCreditPct: 0 },
  { key: 'iv20_80',  minShortVolume: 0, minShortOI: 0, maxBidAskPct: 0, minEntryIV: 0.20, maxEntryIV: 0.80, minNetCreditPct: 0 },

  // Credit quality filters (min credit as % of width)
  { key: 'cr15pct',  minShortVolume: 0, minShortOI: 0, maxBidAskPct: 0, minEntryIV: 0, maxEntryIV: 999, minNetCreditPct: 0.15 },
  { key: 'cr20pct',  minShortVolume: 0, minShortOI: 0, maxBidAskPct: 0, minEntryIV: 0, maxEntryIV: 999, minNetCreditPct: 0.20 },
  { key: 'cr25pct',  minShortVolume: 0, minShortOI: 0, maxBidAskPct: 0, minEntryIV: 0, maxEntryIV: 999, minNetCreditPct: 0.25 },

  // Combo: volume + bid-ask (liquidity gate)
  { key: 'liq_gate', minShortVolume: 10, minShortOI: 100, maxBidAskPct: 0.20, minEntryIV: 0, maxEntryIV: 999, minNetCreditPct: 0 },
];

// ══════════════════════════════════════════════════════════
//  SHARED TYPES
// ══════════════════════════════════════════════════════════

interface TradeSummary {
  ticker: string;
  entryDate: string;
  exitDate: string;
  pnl: number;
  pnlPct: number;
  holdDays: number;
  maxLoss: number;
  entryPrice: number;
  exitType: string;
  score: number;
  direction: string;
  entryDelta: number;
  entryDTE: number;
}

interface TickerSignals {
  ticker: string;
  entries: EntrySignal[];
  allTradingDates: string[];
}

// Extended entry signal with pre-computed daily scores for score-exit
interface ExtendedEntrySignal extends EntrySignal {
  // Map of date → score for score-based exit checking
  // (stored per-ticker, shared across all signals for that ticker)
}

interface TickerCandleData {
  ticker: string;
  candles: BacktestCandle[];
  ivRanks: (number | null)[];
  dateToIdx: Map<string, number>;
}

// Pre-computed score series: date → score for each ticker+signal combo
type ScoreSeries = Map<string, number>; // date → score

interface TickerScoreSeries {
  ticker: string;
  signalKey: string;
  scores: ScoreSeries;
}

interface ExperimentConfig {
  label: string;
  experiment: string;    // 'sizing' | 'score-exit' | 'option-filter'
  signalKey: string;

  // Sizing params
  spreadWidth: number;
  contractsPerSignal: number;

  // Score exit
  scoreExitThreshold: number;  // 0 = disabled

  // Option filter
  optionFilter: OptionFilter;

  // Fixed params (proven optimal)
  tier: 'S';
  tp: 0.30;
  maxPerTicker: 5;
}

interface PortfolioResult {
  configLabel: string;
  experiment: string;
  signalKey: string;
  period: string;
  totalPnl: number;
  annualizedROC: number;
  sharpe: number;
  maxDrawdown: number;
  capitalUtilization: number;
  avgDeployed: number;
  totalTrades: number;
  skippedTrades: number;
  winRate: number;
  profitFactor: number;
  avgHoldDays: number;
  avgOpenPositions: number;
  maxOpenPositions: number;
}

// ── Supabase ────────────────────────────────────────────

async function supabaseGet(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status}`);
  return res.json();
}

// ── IV Rank ─────────────────────────────────────────────

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

// ── Candle Data ─────────────────────────────────────────

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

// ── Signal Generation (with daily score cache for score-exit) ──

// Cache: signalKey → ticker → ScoreSeries
const scoreSeriesCache = new Map<string, Map<string, ScoreSeries>>();

async function generateSignalsWithScores(
  ticker: string,
  periodStart: string,
  periodEnd: string,
  techOptions: TechScoreOptions,
  signalKey: string,
): Promise<{ signals: TickerSignals; scoreSeries: ScoreSeries }> {
  const td = await fetchCandleData(ticker);
  const { signals } = precomputeSignals(td.candles, '1D', techOptions);

  // Build full score series (for score-exit: need score on any date, not just signal dates)
  const scoreSeries: ScoreSeries = new Map();
  for (const sig of signals) {
    scoreSeries.set(sig.date, sig.score);
  }

  // Cache it
  if (!scoreSeriesCache.has(signalKey)) scoreSeriesCache.set(signalKey, new Map());
  scoreSeriesCache.get(signalKey)!.set(ticker, scoreSeries);

  // Filter to entry signals in period
  const entries: EntrySignal[] = [];
  for (const sig of signals) {
    if (sig.date < periodStart || sig.date > periodEnd) continue;
    if (sig.type === 'NEUTRAL' || sig.score < 90) continue; // S-tier only

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

  return { signals: { ticker, entries, allTradingDates }, scoreSeries };
}

// ── Worker Types ────────────────────────────────────────

interface TradeGenWorkItem {
  id: number;
  config: SimConfig;
  minScore: number;
  maxScore: number;
  maxPerTicker: number;
  // Experiment-specific
  contractsPerSignal: number;
  scoreExitThreshold: number;
  optionFilter: OptionFilter;
}

interface TradeGenResult {
  type: 'result';
  id: number;
  trades: TradeSummary[];
}

// ── Portfolio Allocator ─────────────────────────────────

function replayPortfolio(
  allTrades: TradeSummary[],
  maxPositions: number,
  startingCapital: number,
  allDates: string[],
  label: string,
  period: string,
  maxPerTicker: number,
  experiment: string,
  signalKey: string,
): PortfolioResult {
  const sorted = [...allTrades].sort((a, b) => {
    const dc = a.entryDate.localeCompare(b.entryDate);
    if (dc !== 0) return dc;
    return b.score - a.score;
  });

  const open = new Map<string, TradeSummary[]>();
  const accepted: TradeSummary[] = [];
  let skipped = 0;
  let cash = startingCapital;
  let tradeIdx = 0;

  let prevEquity = startingCapital;
  const dailyReturns: number[] = [];
  let peak = startingCapital;
  let maxDD = 0;
  let sumDeployed = 0;
  let sumOpen = 0;
  let maxOpen = 0;

  function totalOpenCount(): number {
    let n = 0;
    for (const [, arr] of open) n += arr.length;
    return n;
  }

  for (const date of allDates) {
    for (const [ticker, trades] of open) {
      const remaining = trades.filter(t => t.exitDate > date);
      const closing = trades.filter(t => t.exitDate <= date);
      for (const t of closing) cash += t.maxLoss + t.pnl;
      if (remaining.length > 0) open.set(ticker, remaining);
      else open.delete(ticker);
    }

    while (tradeIdx < sorted.length && sorted[tradeIdx].entryDate <= date) {
      const trade = sorted[tradeIdx];
      tradeIdx++;

      if (trade.entryDate < date) { skipped++; continue; }
      if (totalOpenCount() >= maxPositions) { skipped++; continue; }
      if ((open.get(trade.ticker)?.length ?? 0) >= maxPerTicker) { skipped++; continue; }
      if (cash < trade.maxLoss) { skipped++; continue; }

      if (!open.has(trade.ticker)) open.set(trade.ticker, []);
      open.get(trade.ticker)!.push(trade);
      accepted.push(trade);
      cash -= trade.maxLoss;
    }

    let deployed = 0;
    for (const [, trades] of open) for (const t of trades) deployed += t.maxLoss;
    const openCount = totalOpenCount();
    const equity = cash + deployed;

    if (prevEquity > 0) dailyReturns.push((equity - prevEquity) / prevEquity);
    prevEquity = equity;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - equity) / peak);
    sumDeployed += deployed;
    sumOpen += openCount;
    maxOpen = Math.max(maxOpen, openCount);
  }

  for (const [, trades] of open) {
    for (const trade of trades) cash += trade.maxLoss + trade.pnl;
  }

  const totalPnl = accepted.reduce((s, t) => s + t.pnl, 0);
  const years = allDates.length / 252;
  const annualizedROC = years > 0 ? (totalPnl / startingCapital / years) * 100 : 0;
  const avgDeployed = allDates.length > 0 ? sumDeployed / allDates.length : 0;

  const avgDR = dailyReturns.length > 0
    ? dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length : 0;
  const stdDR = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgDR) ** 2, 0) / (dailyReturns.length - 1))
    : 0;
  const sharpe = stdDR > 0 ? (avgDR / stdDR) * Math.sqrt(252) : 0;

  const avgOpen = allDates.length > 0 ? sumOpen / allDates.length : 0;
  const winners = accepted.filter(t => t.pnl > 0);
  const losers = accepted.filter(t => t.pnl <= 0);
  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));

  return {
    configLabel: label,
    experiment,
    signalKey,
    period,
    totalPnl,
    annualizedROC,
    sharpe,
    maxDrawdown: maxDD * 100,
    capitalUtilization: startingCapital > 0 ? (avgDeployed / startingCapital) * 100 : 0,
    avgDeployed,
    totalTrades: accepted.length,
    skippedTrades: skipped,
    winRate: accepted.length > 0 ? winners.length / accepted.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    avgHoldDays: accepted.length > 0
      ? accepted.reduce((s, t) => s + t.holdDays, 0) / accepted.length : 0,
    avgOpenPositions: avgOpen,
    maxOpenPositions: maxOpen,
  };
}

// ── Worker Pool ─────────────────────────────────────────

async function buildWorkerBundle(): Promise<string> {
  const workerSrc = path.resolve(__dirname, 'experiment-worker.ts');
  const workerBundle = path.resolve(__dirname, '.experiment-worker.mjs');
  const { execSync } = await import('child_process');
  // Use node_modules/.bin/esbuild directly to avoid npx hanging on Windows
  const esbuildBin = path.resolve(__dirname, '../node_modules/.bin/esbuild');
  execSync(
    `"${esbuildBin}" "${workerSrc}" --bundle --platform=node --format=esm --outfile="${workerBundle}" --external:better-sqlite3 --packages=external`,
    { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' },
  );
  return workerBundle;
}

async function createWorkerPool(
  workerBundle: string,
  allSignals: TickerSignals[],
  maxDate: string,
  numWorkers: number,
  scoreSeriesData?: { signalKey: string; data: [string, [string, number][]][] },
): Promise<Worker[]> {
  return Promise.all(
    Array.from({ length: numWorkers }, () =>
      new Promise<Worker>((resolve, reject) => {
        const w = new Worker(workerBundle, {
          workerData: {
            allSignals,
            maxDate,
            token: ORATS_TOKEN,
            scoreSeriesData,
          },
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

async function runWorkItems(
  workers: Worker[],
  workItems: TradeGenWorkItem[],
  label: string,
): Promise<TradeSummary[][]> {
  if (workItems.length === 0) return [];

  const results: TradeSummary[][] = new Array(workItems.length);
  let nextIdx = 0;
  let completed = 0;
  const startTime = Date.now();

  return new Promise((resolve) => {
    let lastLogPct = -10;

    function sendNext(worker: Worker) {
      if (nextIdx >= workItems.length) return;
      worker.postMessage(workItems[nextIdx++]);
    }

    let liveWorkers = workers.length;
    for (const worker of workers) {
      worker.on('message', (msg: TradeGenResult) => {
        if (msg.type !== 'result') return;
        results[msg.id] = msg.trades;
        completed++;

        const pct = Math.round(completed / workItems.length * 100);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        if (pct >= lastLogPct + 20 || completed === workItems.length) {
          lastLogPct = Math.floor(pct / 20) * 20;
          console.log(`    [${label}] ${completed}/${workItems.length} (${pct}%) | ${elapsed}s`);
        }

        if (completed === workItems.length) resolve(results);
        else sendNext(worker);
      });

      worker.on('error', (err) => {
        console.log(`    [${label}] Worker error: ${err.message}`);
        liveWorkers--;
        if (liveWorkers === 0) resolve(results);
      });

      worker.on('exit', (code) => {
        if (code !== 0) { liveWorkers--; if (liveWorkers === 0) resolve(results); }
      });

      sendNext(worker);
    }
  });
}

// ── Buy & Hold Benchmark ────────────────────────────────

async function computeBuyHold(startDate: string, endDate: string): Promise<{ sharpe: number; annReturn: number; maxDD: number }> {
  const dateMap = new Map<string, number[]>();
  for (const ticker of ALL_TICKERS) {
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
  const rets = dates.map(d => {
    const r = dateMap.get(d)!;
    return r.reduce((s, v) => s + v, 0) / r.length;
  });

  const avg = rets.reduce((s, v) => s + v, 0) / rets.length;
  const std = Math.sqrt(rets.reduce((s, v) => s + (v - avg) ** 2, 0) / (rets.length - 1));
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  let eq = 1, peakEq = 1, maxDD = 0;
  for (const r of rets) { eq *= (1 + r); peakEq = Math.max(peakEq, eq); maxDD = Math.max(maxDD, (peakEq - eq) / peakEq * 100); }
  const years = dates.length / 252;
  const annReturn = (Math.pow(eq, 1 / years) - 1) * 100;

  return { sharpe, annReturn, maxDD };
}

// ── Reporting ───────────────────────────────────────────

function printExperimentResults(
  experimentName: string,
  results: PortfolioResult[],
  factorName: string,
  factorExtractor: (label: string) => string,
) {
  console.log(`\n${'='.repeat(120)}`);
  console.log(`  EXPERIMENT: ${experimentName.toUpperCase()}`);
  console.log(`${'='.repeat(120)}`);

  // Factor marginal effects (avg IS Sharpe per factor level, across all signals)
  const isResults = results.filter(r => r.period === 'IS');
  const oosResults = results.filter(r => r.period === 'OOS');
  const oosMap = new Map(oosResults.map(r => [r.configLabel, r]));

  // Marginals by factor
  console.log(`\n  FACTOR MARGINAL EFFECTS (avg IS Sharpe across all 4 base signals)`);
  console.log('  ' + '-'.repeat(100));

  const levelSharpes = new Map<string, number[]>();
  for (const r of isResults) {
    const level = factorExtractor(r.configLabel);
    if (!levelSharpes.has(level)) levelSharpes.set(level, []);
    levelSharpes.get(level)!.push(r.sharpe);
  }

  const sortedLevels = [...levelSharpes.entries()]
    .map(([level, sharpes]) => ({
      level,
      avg: sharpes.reduce((s, v) => s + v, 0) / sharpes.length,
      n: sharpes.length,
    }))
    .sort((a, b) => b.avg - a.avg);

  for (const { level, avg, n } of sortedLevels) {
    console.log(`    ${level.padEnd(15)} IS Sharpe: ${avg.toFixed(3)}  (n=${n})`);
  }

  // Marginals by signal (should be consistent across signals)
  console.log(`\n  PER-SIGNAL BREAKDOWN (IS Sharpe per signal × ${factorName} level)`);
  console.log('  ' + '-'.repeat(100));

  const headerLevels = sortedLevels.map(s => s.level);
  console.log('  ' + 'Signal'.padEnd(8) + headerLevels.map(l => l.padStart(12)).join(''));
  console.log('  ' + '-'.repeat(100));

  for (const sig of BASE_SIGNALS) {
    const parts = [sig.key.padEnd(8)];
    for (const level of headerLevels) {
      const matching = isResults.filter(r => r.signalKey === sig.key && factorExtractor(r.configLabel) === level);
      const avg = matching.length > 0
        ? matching.reduce((s, r) => s + r.sharpe, 0) / matching.length : 0;
      parts.push(avg.toFixed(3).padStart(12));
    }
    console.log('  ' + parts.join(''));
  }

  // Top 15 IS → OOS validation
  console.log(`\n  TOP 15 IS -> OOS VALIDATION`);
  console.log('  ' + '-'.repeat(130));
  console.log(
    '  ' + 'Rk'.padStart(3) + ' | ' +
    'Config'.padEnd(35) + ' | ' +
    'IS Shrp'.padStart(7) + ' | ' +
    'IS ROC%'.padStart(7) + ' | ' +
    'IS DD%'.padStart(6) + ' | ' +
    'Trades'.padStart(6) + ' | ' +
    'OOS Shrp'.padStart(8) + ' | ' +
    'OOS ROC%'.padStart(8) + ' | ' +
    'OOS DD%'.padStart(7) + ' | ' +
    'WR%'.padStart(5) + ' | ' +
    'Status',
  );
  console.log('  ' + '-'.repeat(130));

  const ranked = [...isResults].sort((a, b) => b.sharpe - a.sharpe);
  for (let i = 0; i < Math.min(15, ranked.length); i++) {
    const is = ranked[i];
    const oos = oosMap.get(is.configLabel);
    const status = oos && oos.sharpe > 0 && oos.sharpe >= is.sharpe * 0.5 ? 'PASS' :
                   oos && oos.sharpe > 0 ? 'WEAK' : 'FAIL';

    console.log(
      '  ' + String(i + 1).padStart(3) + ' | ' +
      is.configLabel.padEnd(35) + ' | ' +
      is.sharpe.toFixed(2).padStart(7) + ' | ' +
      is.annualizedROC.toFixed(1).padStart(6) + '% | ' +
      is.maxDrawdown.toFixed(1).padStart(5) + '% | ' +
      String(is.totalTrades).padStart(6) + ' | ' +
      (oos ? oos.sharpe.toFixed(2).padStart(8) : '       -') + ' | ' +
      (oos ? oos.annualizedROC.toFixed(1).padStart(7) + '%' : '       -') + ' | ' +
      (oos ? oos.maxDrawdown.toFixed(1).padStart(6) + '%' : '      -') + ' | ' +
      (oos ? oos.winRate.toFixed(1).padStart(4) + '%' : '    -') + ' | ' +
      status,
    );
  }
  console.log('  ' + '-'.repeat(130));

  // Capital utilization comparison (key for sizing experiment)
  if (experimentName === 'sizing') {
    console.log(`\n  CAPITAL UTILIZATION COMPARISON (OOS)`);
    console.log('  ' + '-'.repeat(80));
    for (const level of headerLevels) {
      const oosMatching = oosResults.filter(r => factorExtractor(r.configLabel) === level);
      if (oosMatching.length === 0) continue;
      const avgUtil = oosMatching.reduce((s, r) => s + r.capitalUtilization, 0) / oosMatching.length;
      const avgROC = oosMatching.reduce((s, r) => s + r.annualizedROC, 0) / oosMatching.length;
      const avgDD = oosMatching.reduce((s, r) => s + r.maxDrawdown, 0) / oosMatching.length;
      console.log(
        `    ${level.padEnd(15)} Util: ${avgUtil.toFixed(1)}%  ROC: ${avgROC.toFixed(1)}%  DD: ${avgDD.toFixed(1)}%  Eff: ${avgDD > 0 ? (avgROC / avgDD).toFixed(2) : 'N/A'}`,
      );
    }
    console.log('  ' + '-'.repeat(80));
  }
}

// ══════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════

async function main() {
  const globalStart = Date.now();

  const runSizing = EXPERIMENT_FILTER === 'all' || EXPERIMENT_FILTER === 'sizing';
  const runScoreExit = EXPERIMENT_FILTER === 'all' || EXPERIMENT_FILTER === 'score-exit';
  const runOptionFilter = EXPERIMENT_FILTER === 'all' || EXPERIMENT_FILTER === 'option-filter';

  console.log('');
  console.log('='.repeat(120));
  console.log('  EXPERIMENT SIMULATOR — 3 Research Dimensions');
  console.log('='.repeat(120));
  console.log(`  Base signals: ${BASE_SIGNALS.map(s => s.key).join(', ')}`);
  console.log(`  Fixed: S-tier (score≥90), TP 30%, No SL, mpt5, MaxPos=${MAX_POSITIONS}`);
  console.log(`  Experiments: ${[runSizing && 'sizing', runScoreExit && 'score-exit', runOptionFilter && 'option-filter'].filter(Boolean).join(', ')}`);
  if (runSizing) console.log(`    Sizing: ${SIZING_LEVELS.length} levels × 4 signals = ${SIZING_LEVELS.length * 4} configs`);
  if (runScoreExit) console.log(`    Score-Exit: ${SCORE_EXIT_LEVELS.length} levels × 4 signals = ${SCORE_EXIT_LEVELS.length * 4} configs`);
  if (runOptionFilter) console.log(`    Option-Filter: ${OPTION_FILTERS.length} levels × 4 signals = ${OPTION_FILTERS.length * 4} configs`);
  console.log(`  IS: ${IS_START} → ${IS_END} | OOS: ${OOS_START} → ${OOS_END}`);
  console.log(`  Workers: ${NUM_WORKERS}`);
  console.log('='.repeat(120));

  // Build worker
  console.log('\n  Building worker bundle...');
  const workerBundle = await buildWorkerBundle();

  // Verify chain cache
  initDB();
  const stats = getCacheStats();
  console.log(`  Chain Cache: ${stats.totalRows.toLocaleString()} rows, ${stats.totalDates.toLocaleString()} ticker-dates`);
  closeDB();

  // Load candle data
  console.log('\n  Loading candle data...');
  for (const ticker of ALL_TICKERS) {
    await fetchCandleData(ticker);
    process.stdout.write(`    ${ticker} `);
  }
  console.log('\n');

  const allResults: PortfolioResult[] = [];

  // ═══════════════════════════════════════════════════════
  //  Generate signals per signal variant
  // ═══════════════════════════════════════════════════════

  const signalCache = new Map<string, { is: TickerSignals[]; oos: TickerSignals[] }>();

  for (const sig of BASE_SIGNALS) {
    console.log(`  Generating signals: ${sig.key}...`);
    const isSignals: TickerSignals[] = [];
    const oosSignals: TickerSignals[] = [];

    for (const ticker of ALL_TICKERS) {
      const isResult = await generateSignalsWithScores(ticker, IS_START, IS_END, sig.techOptions, sig.key);
      const oosResult = await generateSignalsWithScores(ticker, OOS_START, OOS_END, sig.techOptions, sig.key);
      isSignals.push(isResult.signals);
      oosSignals.push(oosResult.signals);
    }

    const totalIS = isSignals.reduce((s, ts) => s + ts.entries.length, 0);
    const totalOOS = oosSignals.reduce((s, ts) => s + ts.entries.length, 0);
    console.log(`    ${sig.key}: IS=${totalIS} signals, OOS=${totalOOS} signals`);

    signalCache.set(sig.key, { is: isSignals, oos: oosSignals });
  }

  // Get date arrays
  const td = await fetchCandleData('SPY');
  const isDates = td.candles.filter(c => c.date >= IS_START && c.date <= IS_END).map(c => c.date);
  const oosDates = td.candles.filter(c => c.date >= OOS_START && c.date <= OOS_END).map(c => c.date);

  // ═══════════════════════════════════════════════════════
  //  EXPERIMENT 1: POSITION SIZING
  // ═══════════════════════════════════════════════════════

  if (runSizing) {
    console.log('\n  ══ EXPERIMENT 1: POSITION SIZING ══');
    const sizingResults: PortfolioResult[] = [];

    for (const sig of BASE_SIGNALS) {
      const { is: isSignals, oos: oosSignals } = signalCache.get(sig.key)!;

      // Build work items: one per sizing level
      const workItems: TradeGenWorkItem[] = SIZING_LEVELS.map((sz, i) => ({
        id: i,
        config: {
          ...DEFAULT_CREDIT_CONFIG,
          minIVRank: 0,
          creditProfitTarget: 0.30,
          creditStopLossMultiple: 100,
          creditSpreadWidth: sz.spreadWidth,
        },
        minScore: 90,
        maxScore: 101,
        maxPerTicker: 5,
        contractsPerSignal: sz.contractsPerSignal,
        scoreExitThreshold: 0,
        optionFilter: OPTION_FILTERS[0], // no filter
      }));

      // IS
      const isWorkers = await createWorkerPool(workerBundle, isSignals, IS_END, NUM_WORKERS);
      const isResults = await runWorkItems(isWorkers, workItems, `IS-sizing-${sig.key}`);
      await terminatePool(isWorkers);

      // OOS
      const oosWorkers = await createWorkerPool(workerBundle, oosSignals, OOS_END, NUM_WORKERS);
      const oosResultsRaw = await runWorkItems(oosWorkers, workItems, `OOS-sizing-${sig.key}`);
      await terminatePool(oosWorkers);

      for (let i = 0; i < SIZING_LEVELS.length; i++) {
        const label = `${sig.key} ${SIZING_LEVELS[i].key}`;
        sizingResults.push(replayPortfolio(isResults[i] || [], MAX_POSITIONS, STARTING_CAPITAL, isDates, label, 'IS', 5, 'sizing', sig.key));
        sizingResults.push(replayPortfolio(oosResultsRaw[i] || [], MAX_POSITIONS, STARTING_CAPITAL, oosDates, label, 'OOS', 5, 'sizing', sig.key));
      }
    }

    allResults.push(...sizingResults);
    printExperimentResults('sizing', sizingResults, 'sizing',
      (label) => label.split(' ').slice(1).join(' '));
  }

  // ═══════════════════════════════════════════════════════
  //  EXPERIMENT 2: SCORE-BASED EXIT
  // ═══════════════════════════════════════════════════════

  if (runScoreExit) {
    console.log('\n  ══ EXPERIMENT 2: SCORE-BASED EXIT ══');
    const scoreExitResults: PortfolioResult[] = [];

    for (const sig of BASE_SIGNALS) {
      const { is: isSignals, oos: oosSignals } = signalCache.get(sig.key)!;

      // Serialize score series for workers
      const sigScores = scoreSeriesCache.get(sig.key);
      const scoreSeriesData = sigScores ? {
        signalKey: sig.key,
        data: [...sigScores.entries()].map(([ticker, scores]) =>
          [ticker, [...scores.entries()]] as [string, [string, number][]]
        ),
      } : undefined;

      const workItems: TradeGenWorkItem[] = SCORE_EXIT_LEVELS.map((threshold, i) => ({
        id: i,
        config: {
          ...DEFAULT_CREDIT_CONFIG,
          minIVRank: 0,
          creditProfitTarget: 0.30,
          creditStopLossMultiple: 100,
        },
        minScore: 90,
        maxScore: 101,
        maxPerTicker: 5,
        contractsPerSignal: 1,
        scoreExitThreshold: threshold,
        optionFilter: OPTION_FILTERS[0],
      }));

      // IS
      const isWorkers = await createWorkerPool(workerBundle, isSignals, IS_END, NUM_WORKERS, scoreSeriesData);
      const isResults = await runWorkItems(isWorkers, workItems, `IS-scorexit-${sig.key}`);
      await terminatePool(isWorkers);

      // OOS
      const oosWorkers = await createWorkerPool(workerBundle, oosSignals, OOS_END, NUM_WORKERS, scoreSeriesData);
      const oosResultsRaw = await runWorkItems(oosWorkers, workItems, `OOS-scorexit-${sig.key}`);
      await terminatePool(oosWorkers);

      for (let i = 0; i < SCORE_EXIT_LEVELS.length; i++) {
        const label = `${sig.key} se${SCORE_EXIT_LEVELS[i]}`;
        scoreExitResults.push(replayPortfolio(isResults[i] || [], MAX_POSITIONS, STARTING_CAPITAL, isDates, label, 'IS', 5, 'score-exit', sig.key));
        scoreExitResults.push(replayPortfolio(oosResultsRaw[i] || [], MAX_POSITIONS, STARTING_CAPITAL, oosDates, label, 'OOS', 5, 'score-exit', sig.key));
      }
    }

    allResults.push(...scoreExitResults);
    printExperimentResults('score-exit', scoreExitResults, 'score-exit',
      (label) => label.split(' ').slice(1).join(' '));
  }

  // ═══════════════════════════════════════════════════════
  //  EXPERIMENT 3: OPTION FILTERS
  // ═══════════════════════════════════════════════════════

  if (runOptionFilter) {
    console.log('\n  ══ EXPERIMENT 3: OPTION FILTERS ══');
    const filterResults: PortfolioResult[] = [];

    for (const sig of BASE_SIGNALS) {
      const { is: isSignals, oos: oosSignals } = signalCache.get(sig.key)!;

      const workItems: TradeGenWorkItem[] = OPTION_FILTERS.map((filter, i) => ({
        id: i,
        config: {
          ...DEFAULT_CREDIT_CONFIG,
          minIVRank: 0,
          creditProfitTarget: 0.30,
          creditStopLossMultiple: 100,
        },
        minScore: 90,
        maxScore: 101,
        maxPerTicker: 5,
        contractsPerSignal: 1,
        scoreExitThreshold: 0,
        optionFilter: filter,
      }));

      // IS
      const isWorkers = await createWorkerPool(workerBundle, isSignals, IS_END, NUM_WORKERS);
      const isResults = await runWorkItems(isWorkers, workItems, `IS-filter-${sig.key}`);
      await terminatePool(isWorkers);

      // OOS
      const oosWorkers = await createWorkerPool(workerBundle, oosSignals, OOS_END, NUM_WORKERS);
      const oosResultsRaw = await runWorkItems(oosWorkers, workItems, `OOS-filter-${sig.key}`);
      await terminatePool(oosWorkers);

      for (let i = 0; i < OPTION_FILTERS.length; i++) {
        const label = `${sig.key} ${OPTION_FILTERS[i].key}`;
        filterResults.push(replayPortfolio(isResults[i] || [], MAX_POSITIONS, STARTING_CAPITAL, isDates, label, 'IS', 5, 'option-filter', sig.key));
        filterResults.push(replayPortfolio(oosResultsRaw[i] || [], MAX_POSITIONS, STARTING_CAPITAL, oosDates, label, 'OOS', 5, 'option-filter', sig.key));
      }
    }

    allResults.push(...filterResults);
    printExperimentResults('option-filter', filterResults, 'option-filter',
      (label) => label.split(' ').slice(1).join(' '));
  }

  // ═══════════════════════════════════════════════════════
  //  BENCHMARK & EXPORT
  // ═══════════════════════════════════════════════════════

  console.log('\n  Computing benchmarks...');
  const bhOOS = await computeBuyHold(OOS_START, OOS_END);
  console.log(`\n  Buy & Hold OOS: Sharpe ${bhOOS.sharpe.toFixed(2)}, Ann Return ${bhOOS.annReturn.toFixed(1)}%, MaxDD ${bhOOS.maxDD.toFixed(1)}%`);

  // JSON export
  const exportData = {
    meta: {
      startingCapital: STARTING_CAPITAL,
      maxPositions: MAX_POSITIONS,
      tickers: ALL_TICKERS,
      isRange: [IS_START, IS_END],
      oosRange: [OOS_START, OOS_END],
      baseSignals: BASE_SIGNALS.map(s => s.key),
      experiments: {
        sizing: runSizing ? SIZING_LEVELS.map(s => s.key) : null,
        scoreExit: runScoreExit ? SCORE_EXIT_LEVELS : null,
        optionFilter: runOptionFilter ? OPTION_FILTERS.map(f => f.key) : null,
      },
      timestamp: new Date().toISOString(),
    },
    benchmarks: { buyHoldOOS: bhOOS },
    results: allResults.map(r => ({ ...r })),
  };

  const jsonPath = path.resolve(__dirname, '../data/experiment-sim-results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(exportData, null, 2));
  console.log(`\n  Results exported to: ${jsonPath}`);

  const elapsed = ((Date.now() - globalStart) / 60000).toFixed(1);
  console.log(`\n  Total runtime: ${elapsed} minutes`);
  console.log('='.repeat(120));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
