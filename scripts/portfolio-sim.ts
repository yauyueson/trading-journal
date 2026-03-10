/**
 * Full Factorial Portfolio Credit Spread Simulation
 *
 * Tests ALL combinations of signal x tier x IV rank x TP x SL
 * with portfolio-level capital constraints. Uses IS/OOS methodology:
 * rank configs by IS Sharpe, validate top picks on OOS.
 *
 * Current mode: 4 SIGNALS × 2 TIERS × 6 EXIT × 4 MAX_PER_TICKER
 *   4 signals × 2 tiers × 6 exits × 4 mpt = 192 configs
 *   × 3 maxPositions × 2 periods = 1,152 portfolio replays
 *
 * Usage:
 *   npx tsx scripts/portfolio-sim.ts
 *   npx tsx scripts/portfolio-sim.ts --max-pos 5,10,15
 *   npx tsx scripts/portfolio-sim.ts --capital 100000
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
  type EntrySignal, type SimConfig, type PhasedTPConfig,
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

// CLI args
const args = process.argv.slice(2);
function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const STARTING_CAPITAL = parseInt(getArg('--capital') || '100000');
const MAX_POS_LIST = (getArg('--max-pos') || '50,100,150').split(',').map(Number);

// ══════════════════════════════════════════════════════════
//  FACTORIAL DIMENSIONS
// ══════════════════════════════════════════════════════════

interface SignalVariant {
  key: string;
  techOptions: TechScoreOptions;
}

// Top configs from IS ranking — testing position scaling
const SIGNALS: SignalVariant[] = [
  { key: 'MF',  techOptions: { w_bxs: 0, w_bxl: 0, w_adx: 0, w_vol: 0 } },                     // MB+MOM+EMA (IS #1)
  { key: 'ema', techOptions: { w_mb: 0, w_bxs: 0, w_bxl: 0, w_mom: 0, w_adx: 0, w_vol: 0 } },  // IS #2
  { key: 'mom', techOptions: { w_mb: 0, w_bxs: 0, w_bxl: 0, w_ema: 0, w_adx: 0, w_vol: 0 } },  // IS #4
  { key: 'EM',  techOptions: { w_mb: 0, w_bxs: 0, w_bxl: 0, w_adx: 0, w_vol: 0 } },            // EMA+MOM (IS #6)
];

interface TierDef { key: string; minScore: number; maxScore: number; }
const TIERS: TierDef[] = [
  { key: 'ALL', minScore: 70, maxScore: 101 },
  { key: 'S',   minScore: 90, maxScore: 101 },
];

// Exit strategies: standard (full exit) + phased (half@TP1, trailing SL, half@TP2)
interface ExitStrategy {
  key: string;
  creditProfitTarget: number;   // used for standard exits (SimConfig.creditProfitTarget)
  phasedConfig?: PhasedTPConfig; // if present, use phased sim
}

const EXIT_STRATEGIES: ExitStrategy[] = [
  { key: 'std30', creditProfitTarget: 0.30 },
  { key: 'std50', creditProfitTarget: 0.50 },
  { key: 'ph30_50_be', creditProfitTarget: 0.30, phasedConfig: { tp1: 0.30, tp2: 0.50, afterTP1SL: 0 } },
  { key: 'ph30_50_25', creditProfitTarget: 0.30, phasedConfig: { tp1: 0.30, tp2: 0.50, afterTP1SL: 0.25 } },
  { key: 'ph30_75_25', creditProfitTarget: 0.30, phasedConfig: { tp1: 0.30, tp2: 0.75, afterTP1SL: 0.25 } },
  { key: 'ph50_75_25', creditProfitTarget: 0.50, phasedConfig: { tp1: 0.50, tp2: 0.75, afterTP1SL: 0.25 } },
];

// Max concurrent positions per ticker
const MAX_PER_TICKER_LIST = [1, 3, 5, 10];

// ── Config Builder ──────────────────────────────────────

interface ConfigDef {
  label: string;
  signalKey: string;
  tierKey: string;
  exitKey: string;
  maxPerTicker: number;
  techOptions: TechScoreOptions;
  minScore: number;
  maxScore: number;
  config: SimConfig;
  phasedConfig?: PhasedTPConfig;
}

function buildFactorialConfigs(): ConfigDef[] {
  const configs: ConfigDef[] = [];
  for (const sig of SIGNALS) {
    for (const tier of TIERS) {
      for (const exit of EXIT_STRATEGIES) {
        for (const mpt of MAX_PER_TICKER_LIST) {
          configs.push({
            label: `${sig.key} ${tier.key} ${exit.key} mpt${mpt}`,
            signalKey: sig.key,
            tierKey: tier.key,
            exitKey: exit.key,
            maxPerTicker: mpt,
            techOptions: sig.techOptions,
            minScore: tier.minScore,
            maxScore: tier.maxScore,
            config: {
              ...DEFAULT_CREDIT_CONFIG,
              minIVRank: 0,
              creditProfitTarget: exit.creditProfitTarget,
              creditStopLossMultiple: 100,  // effectively no SL
            },
            phasedConfig: exit.phasedConfig,
          });
        }
      }
    }
  }
  return configs;
}

const ALL_CONFIGS = buildFactorialConfigs();

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

// ── Worker Types ────────────────────────────────────────

interface TradeGenWorkItem {
  id: number;
  config: SimConfig;
  minScore: number;
  maxScore: number;
  maxPerTicker: number;
  phasedConfig?: PhasedTPConfig;
}

interface TradeSummary {
  ticker: string;
  entryDate: string;
  exitDate: string;
  pnl: number;
  pnlPct: number;
  holdDays: number;
  maxLoss: number;    // actual dollar collateral per contract
  entryPrice: number; // net credit
  exitType: string;
  score: number;
  direction: string;
  entryDelta: number;
  entryDTE: number;
}

interface TradeGenResult {
  type: 'result';
  id: number;
  trades: TradeSummary[];
}

// ── Portfolio Allocator (collateral-based) ──────────────

interface PortfolioResult {
  configLabel: string;
  maxPositions: number;
  period: string;
  startingCapital: number;

  // Performance
  totalPnl: number;
  annualizedROC: number;       // ROC on full account
  rocOnDeployed: number;       // ROC on avg deployed collateral
  sharpe: number;
  maxDrawdown: number;

  // Efficiency
  avgDeployed: number;         // avg $ deployed as collateral
  capitalUtilization: number;  // avgDeployed / startingCapital %
  avgOpenPositions: number;
  maxOpenPositions: number;

  // Trade stats
  totalTrades: number;
  skippedTrades: number;
  winRate: number;
  profitFactor: number;
  avgHoldDays: number;
}

function replayPortfolio(
  allTrades: TradeSummary[],
  maxPositions: number,
  startingCapital: number,
  allDates: string[],
  label: string,
  period: string,
  maxPerTicker: number = 1,
): PortfolioResult {
  // Sort by entry date, then highest score first for priority
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

  // Metric accumulators (no equity curve stored — saves memory)
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
    // 1. Close positions that exit on or before this date
    for (const [ticker, trades] of open) {
      const remaining = trades.filter(t => t.exitDate > date);
      const closing = trades.filter(t => t.exitDate <= date);
      for (const t of closing) cash += t.maxLoss + t.pnl;
      if (remaining.length > 0) open.set(ticker, remaining);
      else open.delete(ticker);
    }

    // 2. Open new positions from signals on this date
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
      cash -= trade.maxLoss; // reserve actual collateral
    }

    // 3. Compute equity and track metrics
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

  // Close remaining open positions
  for (const [, trades] of open) {
    for (const trade of trades) cash += trade.maxLoss + trade.pnl;
  }

  // ── Compute final metrics ──────────────────────────────
  const totalPnl = accepted.reduce((s, t) => s + t.pnl, 0);
  const years = allDates.length / 252;
  const annualizedROC = years > 0 ? (totalPnl / startingCapital / years) * 100 : 0;

  const avgDeployed = allDates.length > 0 ? sumDeployed / allDates.length : 0;
  const rocOnDeployed = avgDeployed > 0 && years > 0 ? (totalPnl / avgDeployed / years) * 100 : 0;

  // Sharpe from daily equity returns
  const avgDR = dailyReturns.length > 0
    ? dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length : 0;
  const stdDR = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgDR) ** 2, 0) / (dailyReturns.length - 1))
    : 0;
  const sharpe = stdDR > 0 ? (avgDR / stdDR) * Math.sqrt(252) : 0;

  const avgOpen = allDates.length > 0 ? sumOpen / allDates.length : 0;

  // Trade stats
  const winners = accepted.filter(t => t.pnl > 0);
  const losers = accepted.filter(t => t.pnl <= 0);
  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));

  return {
    configLabel: label,
    maxPositions,
    period,
    startingCapital,
    totalPnl,
    annualizedROC,
    rocOnDeployed,
    sharpe,
    maxDrawdown: maxDD * 100,
    avgDeployed,
    capitalUtilization: startingCapital > 0 ? (avgDeployed / startingCapital) * 100 : 0,
    avgOpenPositions: avgOpen,
    maxOpenPositions: maxOpen,
    totalTrades: accepted.length,
    skippedTrades: skipped,
    winRate: accepted.length > 0 ? winners.length / accepted.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    avgHoldDays: accepted.length > 0
      ? accepted.reduce((s, t) => s + t.holdDays, 0) / accepted.length : 0,
  };
}

// ── Worker Pool ─────────────────────────────────────────

async function buildWorkerBundle(): Promise<string> {
  const workerSrc = path.resolve(__dirname, 'portfolio-worker.ts');
  const workerBundle = path.resolve(__dirname, '.portfolio-worker.mjs');
  const { execSync } = await import('child_process');
  execSync(
    `npx esbuild ${workerSrc} --bundle --platform=node --format=esm --outfile=${workerBundle} --external:better-sqlite3 --packages=external`,
    { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' },
  );
  return workerBundle;
}

async function createTradeGenPool(
  workerBundle: string,
  allSignals: TickerSignals[],
  maxDate: string,
  numWorkers: number,
): Promise<Worker[]> {
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

async function generateAllTrades(
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
    let liveWorkers = workers.length;

    function sendNext(worker: Worker) {
      if (nextIdx >= workItems.length) return;
      worker.postMessage(workItems[nextIdx++]);
    }

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

        if (completed === workItems.length) {
          resolve(results);
        } else {
          sendNext(worker);
        }
      });

      worker.on('error', (err) => {
        console.log(`    [${label}] Worker crashed: ${err.message}`);
        liveWorkers--;
        if (liveWorkers === 0) resolve(results);
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          liveWorkers--;
          if (liveWorkers === 0) resolve(results);
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
  const portfolioReturns = dates.map(d => {
    const rets = dateMap.get(d)!;
    return rets.reduce((s, v) => s + v, 0) / rets.length;
  });

  const avg = portfolioReturns.reduce((s, v) => s + v, 0) / portfolioReturns.length;
  const std = Math.sqrt(portfolioReturns.reduce((s, v) => s + (v - avg) ** 2, 0) / (portfolioReturns.length - 1));
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  const equity = portfolioReturns.reduce((cum, r) => cum * (1 + r), 1);
  const totalReturn = (equity - 1) * 100;

  let peakEq = 1, maxDD = 0, eq = 1;
  for (const r of portfolioReturns) {
    eq *= (1 + r); peakEq = Math.max(peakEq, eq);
    maxDD = Math.max(maxDD, (peakEq - eq) / peakEq * 100);
  }

  const years = dates.length / 252;
  const annualizedReturn = (Math.pow(equity, 1 / years) - 1) * 100;

  return { period: label, totalReturn, sharpe, maxDD, annualizedReturn };
}

// ── Formatting ──────────────────────────────────────────

function fmtPnl(pnl: number): string {
  return pnl >= 0 ? `+$${(pnl / 1000).toFixed(1)}k` : `-$${(Math.abs(pnl) / 1000).toFixed(1)}k`;
}

// ══════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════

async function main() {
  const globalStart = Date.now();

  console.log('');
  console.log('='.repeat(100));
  console.log('  FULL FACTORIAL PORTFOLIO CREDIT SPREAD SIMULATION');
  console.log('='.repeat(100));
  console.log(`  Starting Capital: $${STARTING_CAPITAL.toLocaleString()}`);
  console.log(`  Max Position Slots: ${MAX_POS_LIST.join(', ')}`);
  console.log(`  IS  (train):    ${IS_START} -> ${IS_END}  (6 years)`);
  console.log(`  OOS (validate): ${OOS_START} -> ${OOS_END}  (~2 years, 3-month gap)`);
  console.log(`  Tickers: ${ALL_TICKERS.join(', ')} (${ALL_TICKERS.length})`);
  console.log(`  Factorial: ${SIGNALS.length} sig x ${TIERS.length} tier x ${EXIT_STRATEGIES.length} exit x ${MAX_PER_TICKER_LIST.length} mpt = ${ALL_CONFIGS.length} configs`);
  console.log(`  Workers: ${NUM_WORKERS} threads`);
  console.log('='.repeat(100));

  // Build worker bundle once
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

  // ═════════════════════════════════════════════════════════
  //  PHASE 1: Trade generation per signal variant
  // ═════════════════════════════════════════════════════════

  // Group configs by signal variant (they share the same techOptions → same signals)
  const configsBySignal = new Map<string, ConfigDef[]>();
  for (const cfg of ALL_CONFIGS) {
    if (!configsBySignal.has(cfg.signalKey)) configsBySignal.set(cfg.signalKey, []);
    configsBySignal.get(cfg.signalKey)!.push(cfg);
  }

  interface TradeSet {
    configLabel: string;
    signalKey: string;
    isTrades: TradeSummary[];
    oosTrades: TradeSummary[];
  }

  const allTradeSets: TradeSet[] = [];
  let signalIdx = 0;
  const totalSignals = configsBySignal.size;

  for (const [signalKey, configs] of configsBySignal) {
    signalIdx++;
    const techOptions = configs[0].techOptions;

    console.log(`  [${signalIdx}/${totalSignals}] Signal: ${signalKey} (${configs.length} configs)...`);

    // Generate IS + OOS signals
    const isSignals: TickerSignals[] = [];
    const oosSignals: TickerSignals[] = [];
    for (const ticker of ALL_TICKERS) {
      isSignals.push(await generateSignals(ticker, IS_START, IS_END, techOptions));
      oosSignals.push(await generateSignals(ticker, OOS_START, OOS_END, techOptions));
    }
    const totalIS = isSignals.reduce((s, ts) => s + ts.entries.length, 0);
    const totalOOS = oosSignals.reduce((s, ts) => s + ts.entries.length, 0);
    console.log(`    Signals — IS: ${totalIS}, OOS: ${totalOOS}`);

    if (totalIS === 0) {
      console.log(`    Skipping ${signalKey} — no qualifying signals`);
      for (const cfg of configs) {
        allTradeSets.push({ configLabel: cfg.label, signalKey, isTrades: [], oosTrades: [] });
      }
      continue;
    }

    // Build work items — one per config (tier × exit × maxPerTicker)
    const workItems: TradeGenWorkItem[] = configs.map((cfg, i) => ({
      id: i,
      config: cfg.config,
      minScore: cfg.minScore,
      maxScore: cfg.maxScore,
      maxPerTicker: cfg.maxPerTicker,
      phasedConfig: cfg.phasedConfig,
    }));

    // IS trade generation
    const isWorkers = await createTradeGenPool(workerBundle, isSignals, IS_END, NUM_WORKERS);
    const isResults = await generateAllTrades(isWorkers, workItems, `IS-${signalKey}`);
    await terminatePool(isWorkers);

    // OOS trade generation
    const oosWorkers = await createTradeGenPool(workerBundle, oosSignals, OOS_END, NUM_WORKERS);
    const oosResults = await generateAllTrades(oosWorkers, workItems, `OOS-${signalKey}`);
    await terminatePool(oosWorkers);

    for (let i = 0; i < configs.length; i++) {
      allTradeSets.push({
        configLabel: configs[i].label,
        signalKey,
        isTrades: isResults[i] || [],
        oosTrades: oosResults[i] || [],
      });
    }
  }

  // ═════════════════════════════════════════════════════════
  //  PHASE 2: Portfolio replay with different position limits
  // ═════════════════════════════════════════════════════════

  const td = await fetchCandleData('SPY');
  const isDates = td.candles.filter(c => c.date >= IS_START && c.date <= IS_END).map(c => c.date);
  const oosDates = td.candles.filter(c => c.date >= OOS_START && c.date <= OOS_END).map(c => c.date);

  console.log('\n  Portfolio Replay...');

  const allResults: PortfolioResult[] = [];

  // Extract maxPerTicker from config label to pass to replay
  const configMaxPerTicker = new Map<string, number>();
  for (const cfg of ALL_CONFIGS) configMaxPerTicker.set(cfg.label, cfg.maxPerTicker);

  for (const ts of allTradeSets) {
    const mpt = configMaxPerTicker.get(ts.configLabel) ?? 1;
    for (const maxPos of MAX_POS_LIST) {
      allResults.push(replayPortfolio(ts.isTrades, maxPos, STARTING_CAPITAL, isDates, ts.configLabel, 'IS', mpt));
      allResults.push(replayPortfolio(ts.oosTrades, maxPos, STARTING_CAPITAL, oosDates, ts.configLabel, 'OOS', mpt));
    }
  }

  console.log(`    ${allResults.length} portfolio runs completed`);

  // ═════════════════════════════════════════════════════════
  //  PHASE 3: Analysis & Report
  // ═════════════════════════════════════════════════════════

  console.log('\n  Computing benchmarks...');
  const bhIS = await computeBuyHold(IS_START, IS_END, 'IS');
  const bhOOS = await computeBuyHold(OOS_START, OOS_END, 'OOS');

  console.log('\n');
  console.log('='.repeat(100));
  console.log('  FULL FACTORIAL RESULTS');
  console.log('='.repeat(100));
  console.log(`  ${ALL_CONFIGS.length} configs | ${allResults.length} portfolio replays`);

  // ─── SIGNAL VARIANT SUMMARY ──────────────────────────
  const refMaxPos = MAX_POS_LIST.includes(10) ? 10 : MAX_POS_LIST[0];

  console.log(`\n  SIGNAL VARIANT SUMMARY (MaxPos=${refMaxPos}, IS)`);
  console.log('  ' + '-'.repeat(95));
  console.log(
    '  ' + 'Signal'.padEnd(6) + ' | ' +
    'AvgTrades'.padStart(9) + ' | ' +
    'Med Shrp'.padStart(8) + ' | ' +
    'Best IS Shrp'.padStart(12) + ' | ' +
    'Best OOS Shrp'.padStart(13) + ' | ' +
    'Best Config'.padEnd(30),
  );
  console.log('  ' + '-'.repeat(95));

  for (const sig of SIGNALS) {
    const sigIS = allResults.filter(r =>
      r.configLabel.startsWith(sig.key + ' ') && r.maxPositions === refMaxPos && r.period === 'IS'
    );
    if (sigIS.length === 0) continue;

    const avgTrades = sigIS.reduce((s, r) => s + r.totalTrades, 0) / sigIS.length;
    const sharpes = sigIS.map(r => r.sharpe).sort((a, b) => a - b);
    const medSharpe = sharpes[Math.floor(sharpes.length / 2)];
    const bestIS = sigIS.reduce((a, b) => a.sharpe > b.sharpe ? a : b);
    const bestOOS = allResults.find(r =>
      r.configLabel === bestIS.configLabel && r.maxPositions === refMaxPos && r.period === 'OOS'
    );

    console.log(
      '  ' + sig.key.padEnd(6) + ' | ' +
      avgTrades.toFixed(0).padStart(9) + ' | ' +
      medSharpe.toFixed(2).padStart(8) + ' | ' +
      bestIS.sharpe.toFixed(2).padStart(12) + ' | ' +
      (bestOOS ? bestOOS.sharpe.toFixed(2).padStart(13) : '            -') + ' | ' +
      bestIS.configLabel.padEnd(30),
    );
  }
  console.log('  ' + '-'.repeat(95));

  // ─── FACTOR MARGINAL EFFECTS ─────────────────────────
  console.log(`\n  FACTOR MARGINAL EFFECTS (MaxPos=${refMaxPos}, avg IS Sharpe across all other factors)`);
  console.log('  ' + '-'.repeat(80));

  const ref10IS = allResults.filter(r => r.maxPositions === refMaxPos && r.period === 'IS');
  const resultMap = new Map<string, PortfolioResult>();
  for (const r of ref10IS) resultMap.set(r.configLabel, r);

  const factorDefs = [
    { name: 'Signal', getter: (c: ConfigDef) => c.signalKey },
    { name: 'Tier',   getter: (c: ConfigDef) => c.tierKey },
    { name: 'Exit',   getter: (c: ConfigDef) => c.exitKey },
    { name: 'MPT',    getter: (c: ConfigDef) => `mpt${c.maxPerTicker}` },
  ];

  const bestPerFactor = new Map<string, string>(); // factorName → best level key

  for (const factor of factorDefs) {
    const levelSharpes = new Map<string, number[]>();
    for (const cfg of ALL_CONFIGS) {
      const r = resultMap.get(cfg.label);
      if (!r) continue;
      const level = factor.getter(cfg);
      if (!levelSharpes.has(level)) levelSharpes.set(level, []);
      levelSharpes.get(level)!.push(r.sharpe);
    }

    let bestLevel = '';
    let bestAvg = -Infinity;
    const parts: string[] = [];
    for (const [level, sharpes] of levelSharpes) {
      const avg = sharpes.reduce((s, v) => s + v, 0) / sharpes.length;
      parts.push(`${level}=${avg.toFixed(3)}`);
      if (avg > bestAvg) { bestAvg = avg; bestLevel = level; }
    }
    bestPerFactor.set(factor.name, bestLevel);
    console.log(`    ${factor.name.padEnd(7)}: ${parts.join('  ')}`);
  }
  console.log('  ' + '-'.repeat(80));

  // ─── TOP 20 IS → OOS VALIDATION ─────────────────────
  for (const maxPos of MAX_POS_LIST) {
    const isResults = allResults.filter(r => r.maxPositions === maxPos && r.period === 'IS');
    const oosResultsAll = allResults.filter(r => r.maxPositions === maxPos && r.period === 'OOS');
    const oosMap = new Map<string, PortfolioResult>();
    for (const r of oosResultsAll) oosMap.set(r.configLabel, r);

    // Sort by IS Sharpe descending
    const ranked = [...isResults].sort((a, b) => b.sharpe - a.sharpe);

    console.log(`\n  TOP 20 IS -> OOS VALIDATION (MaxPos=${maxPos})`);
    console.log('  ' + '-'.repeat(130));
    console.log(
      '  ' + 'Rk'.padStart(3) + ' | ' +
      'Config'.padEnd(28) + ' | ' +
      'IS Shrp'.padStart(7) + ' | ' +
      'IS ROC%'.padStart(7) + ' | ' +
      'IS DD%'.padStart(6) + ' | ' +
      'Trades'.padStart(6) + ' | ' +
      'OOS Shrp'.padStart(8) + ' | ' +
      'OOS ROC%'.padStart(8) + ' | ' +
      'OOS DD%'.padStart(7) + ' | ' +
      'WR%'.padStart(5) + ' | ' +
      'PF'.padStart(5) + ' | ' +
      'Status'.padEnd(6),
    );
    console.log('  ' + '-'.repeat(130));

    for (let i = 0; i < Math.min(20, ranked.length); i++) {
      const is = ranked[i];
      const oos = oosMap.get(is.configLabel);

      // Status: PASS if OOS Sharpe > 0 and >= 50% of IS, WEAK if > 0 but < 50%, FAIL if <= 0
      const status = oos && oos.sharpe > 0 && oos.sharpe >= is.sharpe * 0.5 ? 'PASS' :
                     oos && oos.sharpe > 0 ? 'WEAK' : 'FAIL';

      console.log(
        '  ' + String(i + 1).padStart(3) + ' | ' +
        is.configLabel.padEnd(28) + ' | ' +
        is.sharpe.toFixed(2).padStart(7) + ' | ' +
        is.annualizedROC.toFixed(1).padStart(6) + '% | ' +
        is.maxDrawdown.toFixed(1).padStart(5) + '% | ' +
        String(is.totalTrades).padStart(6) + ' | ' +
        (oos ? oos.sharpe.toFixed(2).padStart(8) : '       -') + ' | ' +
        (oos ? oos.annualizedROC.toFixed(1).padStart(7) + '%' : '       -') + ' | ' +
        (oos ? oos.maxDrawdown.toFixed(1).padStart(6) + '%' : '      -') + ' | ' +
        (oos ? oos.winRate.toFixed(1).padStart(4) + '%' : '    -') + ' | ' +
        (oos ? oos.profitFactor.toFixed(2).padStart(5) : '    -') + ' | ' +
        status.padEnd(6),
      );
    }
    console.log('  ' + '-'.repeat(130));
  }

  // ─── CONTROL VARIABLE PREDICTION vs FACTORIAL BEST ───
  console.log('\n  CONTROL VARIABLE PREDICTION vs FACTORIAL BEST');
  console.log('  ' + '-'.repeat(95));

  const cvLabel = `${bestPerFactor.get('Signal')} ${bestPerFactor.get('Tier')} ${bestPerFactor.get('Exit')} ${bestPerFactor.get('MPT')}`;
  console.log(`    Control-var prediction (best per factor on IS): ${cvLabel}`);

  for (const maxPos of MAX_POS_LIST) {
    const isResults = allResults.filter(r => r.maxPositions === maxPos && r.period === 'IS');
    const ranked = [...isResults].sort((a, b) => b.sharpe - a.sharpe);

    const factBest = ranked[0];
    const cvResult = isResults.find(r => r.configLabel === cvLabel);
    const cvRank = cvResult ? ranked.findIndex(r => r.configLabel === cvLabel) + 1 : -1;

    const factOOS = allResults.find(r => r.configLabel === factBest.configLabel && r.maxPositions === maxPos && r.period === 'OOS');
    const cvOOS = cvResult ? allResults.find(r => r.configLabel === cvLabel && r.maxPositions === maxPos && r.period === 'OOS') : null;

    console.log(`\n    MaxPos=${maxPos}:`);
    console.log(`      Factorial #1:  ${factBest.configLabel}  (IS Shrp ${factBest.sharpe.toFixed(2)}, OOS Shrp ${factOOS?.sharpe.toFixed(2) ?? '-'})`);
    console.log(`      Control-var:   ${cvLabel}  (IS rank #${cvRank}, IS Shrp ${cvResult?.sharpe.toFixed(2) ?? '-'}, OOS Shrp ${cvOOS?.sharpe.toFixed(2) ?? '-'})`);
    console.log(`      Match: ${factBest.configLabel === cvLabel ? 'YES — no significant interaction effects' : 'NO — interaction effect detected'}`);
  }
  console.log('\n  ' + '-'.repeat(95));

  // ─── BUY & HOLD COMPARISON ───────────────────────────
  console.log('\n  BUY & HOLD BENCHMARK');
  console.log('  ' + '-'.repeat(80));
  console.log(`    IS:  Sharpe ${bhIS.sharpe.toFixed(2)}, Ann Return ${bhIS.annualizedReturn.toFixed(1)}%, MaxDD ${bhIS.maxDD.toFixed(1)}%, Eff ${(bhIS.annualizedReturn / bhIS.maxDD).toFixed(2)}`);
  console.log(`    OOS: Sharpe ${bhOOS.sharpe.toFixed(2)}, Ann Return ${bhOOS.annualizedReturn.toFixed(1)}%, MaxDD ${bhOOS.maxDD.toFixed(1)}%, Eff ${(bhOOS.annualizedReturn / bhOOS.maxDD).toFixed(2)}`);
  console.log('  ' + '-'.repeat(80));

  // ─── BEST CONFIG vs B&H (selected on IS, validated OOS) ──
  console.log('\n  BEST CONFIG vs BUY & HOLD (selected on IS Sharpe, validated OOS)');
  console.log('  ' + '-'.repeat(100));
  const bhEff = bhOOS.maxDD > 0 ? bhOOS.annualizedReturn / bhOOS.maxDD : 0;
  console.log(`    Buy & Hold OOS:  ROC ${bhOOS.annualizedReturn.toFixed(1)}%, DD ${bhOOS.maxDD.toFixed(1)}%, Sharpe ${bhOOS.sharpe.toFixed(2)}, Eff ${bhEff.toFixed(2)}`);

  for (const maxPos of MAX_POS_LIST) {
    const isResults = allResults.filter(r => r.maxPositions === maxPos && r.period === 'IS');
    const ranked = [...isResults].sort((a, b) => b.sharpe - a.sharpe);
    const bestIS = ranked[0];
    const oos = allResults.find(r => r.configLabel === bestIS.configLabel && r.maxPositions === maxPos && r.period === 'OOS');
    if (!oos) continue;
    const eff = oos.maxDrawdown > 0 ? oos.annualizedROC / oos.maxDrawdown : 0;
    console.log(
      `    Credit ${maxPos}-pos OOS:  ${bestIS.configLabel}  ` +
      `ROC ${oos.annualizedROC.toFixed(1)}%, DD ${oos.maxDrawdown.toFixed(1)}%, ` +
      `Sharpe ${oos.sharpe.toFixed(2)}, Eff ${eff.toFixed(2)}, ` +
      `ROC/Deployed ${oos.rocOnDeployed.toFixed(0)}%, Util ${oos.capitalUtilization.toFixed(1)}%`,
    );
  }
  console.log('  ' + '-'.repeat(100));

  // ═════════════════════════════════════════════════════════
  //  JSON Export (all results, no equity curves)
  // ═════════════════════════════════════════════════════════

  const exportData = {
    meta: {
      startingCapital: STARTING_CAPITAL,
      maxPosList: MAX_POS_LIST,
      tickers: ALL_TICKERS,
      isRange: [IS_START, IS_END],
      oosRange: [OOS_START, OOS_END],
      signals: SIGNALS.map(s => s.key),
      tiers: TIERS.map(t => t.key),
      exitStrategies: EXIT_STRATEGIES.map(e => e.key),
      maxPerTicker: MAX_PER_TICKER_LIST,
      totalConfigs: ALL_CONFIGS.length,
      timestamp: new Date().toISOString(),
    },
    benchmarks: { buyHoldIS: bhIS, buyHoldOOS: bhOOS },
    results: allResults.map(r => ({
      configLabel: r.configLabel,
      maxPositions: r.maxPositions,
      period: r.period,
      annualizedROC: r.annualizedROC,
      rocOnDeployed: r.rocOnDeployed,
      sharpe: r.sharpe,
      maxDrawdown: r.maxDrawdown,
      avgDeployed: r.avgDeployed,
      capitalUtilization: r.capitalUtilization,
      avgOpenPositions: r.avgOpenPositions,
      maxOpenPositions: r.maxOpenPositions,
      totalTrades: r.totalTrades,
      skippedTrades: r.skippedTrades,
      winRate: r.winRate,
      profitFactor: r.profitFactor,
      totalPnl: r.totalPnl,
      avgHoldDays: r.avgHoldDays,
    })),
  };

  const jsonPath = path.resolve(__dirname, '../data/portfolio-sim-results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(exportData, null, 2));
  console.log(`\n  Results exported to: ${jsonPath}`);

  const elapsed = ((Date.now() - globalStart) / 60000).toFixed(1);
  console.log(`\n  Total runtime: ${elapsed} minutes`);
  console.log('='.repeat(100));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
