/**
 * Robustness Simulator — Tests IV filter, delta, and DTE across diverse entry strategies
 *
 * Anti-overfitting design:
 *   5 entry strategies (including random & periodic) × 3 IV × 5 delta × 4 DTE
 *   = 300 configs × 2 periods = 600 portfolio replays
 *
 * If IV ≥ 30% helps random entries, it's structural (premium adequacy).
 * If it only helps signal-based entries, it's overfit.
 *
 * Usage:
 *   npx tsx scripts/robustness-sim.ts
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
const MAX_PER_TICKER = 5;

// ══════════════════════════════════════════════════════════
//  FACTORIAL DIMENSIONS
// ══════════════════════════════════════════════════════════

// Entry strategies
interface StrategyDef {
  key: string;
  type: 'signal' | 'periodic' | 'random';
  techOptions?: TechScoreOptions;
  minScore: number;  // for signal strategies
}

const STRATEGIES: StrategyDef[] = [
  // Proven signals
  { key: 'mom', type: 'signal', techOptions: { w_mb: 0, w_bxs: 0, w_bxl: 0, w_ema: 0, w_adx: 0, w_vol: 0 }, minScore: 90 },
  // Multi-component baseline (all weights, lower bar)
  { key: 'BL',  type: 'signal', techOptions: {}, minScore: 70 },
  // Known IS overfitter
  { key: 'adx', type: 'signal', techOptions: { w_mb: 0, w_bxs: 0, w_bxl: 0, w_ema: 0, w_mom: 0, w_vol: 0 }, minScore: 70 },
  // Non-signal entries
  { key: 'periodic', type: 'periodic', minScore: 0 },
  { key: 'random',   type: 'random',   minScore: 0 },
];

// IV filter levels
const IV_LEVELS = [0, 0.20, 0.30];  // 0 = no filter

// Short leg delta (absolute)
const DELTA_LEVELS = [0.15, 0.20, 0.27, 0.35, 0.40];

// DTE ranges
interface DTERange { key: string; range: [number, number]; }
const DTE_LEVELS: DTERange[] = [
  { key: 'dte15_30', range: [15, 30] },
  { key: 'dte30_50', range: [30, 50] },
  { key: 'dte45_65', range: [45, 65] },
  { key: 'dte60_90', range: [60, 90] },
];

// ══════════════════════════════════════════════════════════
//  TYPES
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

interface TickerCandleData {
  ticker: string;
  candles: BacktestCandle[];
  ivRanks: (number | null)[];
  dateToIdx: Map<string, number>;
}

interface ConfigDef {
  label: string;
  strategyKey: string;
  ivFilter: number;
  delta: number;
  dteKey: string;
  dteRange: [number, number];
}

interface PortfolioResult {
  configLabel: string;
  strategyKey: string;
  ivFilter: number;
  delta: number;
  dteKey: string;
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
}

interface TradeGenWorkItem {
  id: number;
  config: SimConfig;
  minScore: number;
  maxScore: number;
  maxPerTicker: number;
  contractsPerSignal: number;
  scoreExitThreshold: number;
  optionFilter: {
    key: string;
    minShortVolume: number;
    minShortOI: number;
    maxBidAskPct: number;
    minEntryIV: number;
    maxEntryIV: number;
    minNetCreditPct: number;
  };
}

interface TradeGenResult {
  type: 'result';
  id: number;
  trades: TradeSummary[];
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

// ── Signal Generation ───────────────────────────────────

async function generateSignalEntries(
  ticker: string,
  periodStart: string,
  periodEnd: string,
  strategy: StrategyDef,
): Promise<TickerSignals> {
  const td = await fetchCandleData(ticker);

  const allTradingDates = td.candles
    .filter(c => c.date >= periodStart && c.date <= periodEnd)
    .map(c => c.date);

  let entries: EntrySignal[] = [];

  if (strategy.type === 'signal') {
    const { signals } = precomputeSignals(td.candles, '1D', strategy.techOptions);
    for (const sig of signals) {
      if (sig.date < periodStart || sig.date > periodEnd) continue;
      if (sig.type === 'NEUTRAL' || sig.score < strategy.minScore) continue;

      const idx = td.dateToIdx.get(sig.date);
      entries.push({
        ticker,
        date: sig.date,
        direction: sig.type as 'CALL' | 'PUT',
        score: sig.score,
        ivRank: idx != null ? (td.ivRanks[idx] ?? undefined) : undefined,
      });
    }
  } else if (strategy.type === 'periodic') {
    // Enter every 5 trading days
    // Direction: CALL if close > EMA20, PUT if close < EMA20
    const closes = td.candles.map(c => c.close);
    // Simple EMA20
    const ema20: number[] = new Array(closes.length).fill(0);
    ema20[0] = closes[0];
    const k = 2 / 21;
    for (let i = 1; i < closes.length; i++) ema20[i] = closes[i] * k + ema20[i - 1] * (1 - k);

    for (let i = 0; i < allTradingDates.length; i += 5) {
      const date = allTradingDates[i];
      const idx = td.dateToIdx.get(date);
      if (idx == null || idx < 20) continue;

      entries.push({
        ticker,
        date,
        direction: closes[idx] > ema20[idx] ? 'CALL' : 'PUT',
        score: 80, // dummy score
        ivRank: td.ivRanks[idx] ?? undefined,
      });
    }
  } else if (strategy.type === 'random') {
    // Seeded PRNG for reproducibility (seed = ticker hash)
    let seed = 0;
    for (let i = 0; i < ticker.length; i++) seed = seed * 31 + ticker.charCodeAt(i);
    function nextRand(): number {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }

    for (const date of allTradingDates) {
      if (nextRand() > 0.20) continue; // ~20% of days
      const idx = td.dateToIdx.get(date);
      if (idx == null) continue;

      entries.push({
        ticker,
        date,
        direction: nextRand() > 0.5 ? 'CALL' : 'PUT',
        score: 80,
        ivRank: idx != null ? (td.ivRanks[idx] ?? undefined) : undefined,
      });
    }
  }

  return { ticker, entries, allTradingDates };
}

// ── Worker Pool ─────────────────────────────────────────

async function buildWorkerBundle(): Promise<string> {
  const workerSrc = path.resolve(__dirname, 'experiment-worker.ts');
  const workerBundle = path.resolve(__dirname, '.experiment-worker.mjs');
  const { execSync } = await import('child_process');
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
        if (pct >= lastLogPct + 10 || completed === workItems.length) {
          lastLogPct = Math.floor(pct / 10) * 10;
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

// ── Portfolio Allocator ─────────────────────────────────

function replayPortfolio(
  allTrades: TradeSummary[],
  allDates: string[],
  label: string,
  period: string,
  cfg: ConfigDef,
): PortfolioResult {
  const sorted = [...allTrades].sort((a, b) => {
    const dc = a.entryDate.localeCompare(b.entryDate);
    if (dc !== 0) return dc;
    return b.score - a.score;
  });

  const open = new Map<string, TradeSummary[]>();
  const accepted: TradeSummary[] = [];
  let skipped = 0;
  let cash = STARTING_CAPITAL;
  let tradeIdx = 0;

  let prevEquity = STARTING_CAPITAL;
  const dailyReturns: number[] = [];
  let peak = STARTING_CAPITAL;
  let maxDD = 0;
  let sumDeployed = 0;

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
      if (totalOpenCount() >= MAX_POSITIONS) { skipped++; continue; }
      if ((open.get(trade.ticker)?.length ?? 0) >= MAX_PER_TICKER) { skipped++; continue; }
      if (cash < trade.maxLoss) { skipped++; continue; }

      if (!open.has(trade.ticker)) open.set(trade.ticker, []);
      open.get(trade.ticker)!.push(trade);
      accepted.push(trade);
      cash -= trade.maxLoss;
    }

    let deployed = 0;
    for (const [, trades] of open) for (const t of trades) deployed += t.maxLoss;
    const equity = cash + deployed;

    if (prevEquity > 0) dailyReturns.push((equity - prevEquity) / prevEquity);
    prevEquity = equity;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - equity) / peak);
    sumDeployed += deployed;
  }

  for (const [, trades] of open) {
    for (const trade of trades) cash += trade.maxLoss + trade.pnl;
  }

  const totalPnl = accepted.reduce((s, t) => s + t.pnl, 0);
  const years = allDates.length / 252;
  const annualizedROC = years > 0 ? (totalPnl / STARTING_CAPITAL / years) * 100 : 0;
  const avgDeployed = allDates.length > 0 ? sumDeployed / allDates.length : 0;

  const avgDR = dailyReturns.length > 0
    ? dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length : 0;
  const stdDR = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgDR) ** 2, 0) / (dailyReturns.length - 1))
    : 0;
  const sharpe = stdDR > 0 ? (avgDR / stdDR) * Math.sqrt(252) : 0;

  const winners = accepted.filter(t => t.pnl > 0);
  const losers = accepted.filter(t => t.pnl <= 0);
  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));

  return {
    configLabel: label,
    strategyKey: cfg.strategyKey,
    ivFilter: cfg.ivFilter,
    delta: cfg.delta,
    dteKey: cfg.dteKey,
    period,
    totalPnl,
    annualizedROC,
    sharpe,
    maxDrawdown: maxDD * 100,
    capitalUtilization: STARTING_CAPITAL > 0 ? (avgDeployed / STARTING_CAPITAL) * 100 : 0,
    avgDeployed,
    totalTrades: accepted.length,
    skippedTrades: skipped,
    winRate: accepted.length > 0 ? winners.length / accepted.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    avgHoldDays: accepted.length > 0
      ? accepted.reduce((s, t) => s + t.holdDays, 0) / accepted.length : 0,
  };
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

// ══════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════

async function main() {
  const globalStart = Date.now();

  // Build all config combinations
  const allConfigs: ConfigDef[] = [];
  for (const strat of STRATEGIES) {
    for (const iv of IV_LEVELS) {
      for (const delta of DELTA_LEVELS) {
        for (const dte of DTE_LEVELS) {
          allConfigs.push({
            label: `${strat.key} iv${iv === 0 ? '0' : (iv * 100).toFixed(0)} d${(delta * 100).toFixed(0)} ${dte.key}`,
            strategyKey: strat.key,
            ivFilter: iv,
            delta,
            dteKey: dte.key,
            dteRange: dte.range,
          });
        }
      }
    }
  }

  console.log('');
  console.log('='.repeat(120));
  console.log('  ROBUSTNESS SIMULATOR — IV Filter × Delta × DTE across Diverse Entry Strategies');
  console.log('='.repeat(120));
  console.log(`  Strategies: ${STRATEGIES.map(s => s.key).join(', ')}`);
  console.log(`  IV Levels: ${IV_LEVELS.map(v => v === 0 ? 'none' : `≥${(v * 100).toFixed(0)}%`).join(', ')}`);
  console.log(`  Delta: ${DELTA_LEVELS.join(', ')}`);
  console.log(`  DTE: ${DTE_LEVELS.map(d => d.key).join(', ')}`);
  console.log(`  Total: ${allConfigs.length} configs × 2 periods = ${allConfigs.length * 2} replays`);
  console.log(`  Fixed: TP 30%, No SL, mpt5, MaxPos=${MAX_POSITIONS}, $5 width`);
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

  // Get date arrays
  const td = await fetchCandleData('SPY');
  const isDates = td.candles.filter(c => c.date >= IS_START && c.date <= IS_END).map(c => c.date);
  const oosDates = td.candles.filter(c => c.date >= OOS_START && c.date <= OOS_END).map(c => c.date);

  const allResults: PortfolioResult[] = [];

  // Process per strategy (signals differ, but delta/IV/DTE are config-level)
  for (const strat of STRATEGIES) {
    console.log(`\n  ══ Strategy: ${strat.key} (${strat.type}) ══`);

    // Generate signals
    const isSignals: TickerSignals[] = [];
    const oosSignals: TickerSignals[] = [];
    for (const ticker of ALL_TICKERS) {
      isSignals.push(await generateSignalEntries(ticker, IS_START, IS_END, strat));
      oosSignals.push(await generateSignalEntries(ticker, OOS_START, OOS_END, strat));
    }
    const totalIS = isSignals.reduce((s, ts) => s + ts.entries.length, 0);
    const totalOOS = oosSignals.reduce((s, ts) => s + ts.entries.length, 0);
    console.log(`    Signals — IS: ${totalIS}, OOS: ${totalOOS}`);

    // Build work items for this strategy's configs
    const stratConfigs = allConfigs.filter(c => c.strategyKey === strat.key);
    const noFilter = { key: 'noFilter', minShortVolume: 0, minShortOI: 0, maxBidAskPct: 0, minEntryIV: 0, maxEntryIV: 999, minNetCreditPct: 0 };

    const workItems: TradeGenWorkItem[] = stratConfigs.map((cfg, i) => ({
      id: i,
      config: {
        ...DEFAULT_CREDIT_CONFIG,
        minIVRank: 0,
        creditProfitTarget: 0.30,
        creditStopLossMultiple: 100,
        creditShortDelta: cfg.delta,
        creditDTERange: cfg.dteRange,
      },
      minScore: strat.minScore,
      maxScore: 101,
      maxPerTicker: MAX_PER_TICKER,
      contractsPerSignal: 1,
      scoreExitThreshold: 0,
      optionFilter: {
        ...noFilter,
        minEntryIV: cfg.ivFilter,
      },
    }));

    // IS trade generation
    const isWorkers = await createWorkerPool(workerBundle, isSignals, IS_END, NUM_WORKERS);
    const isResults = await runWorkItems(isWorkers, workItems, `IS-${strat.key}`);
    await terminatePool(isWorkers);

    // OOS trade generation
    const oosWorkers = await createWorkerPool(workerBundle, oosSignals, OOS_END, NUM_WORKERS);
    const oosResultsRaw = await runWorkItems(oosWorkers, workItems, `OOS-${strat.key}`);
    await terminatePool(oosWorkers);

    // Portfolio replay
    for (let i = 0; i < stratConfigs.length; i++) {
      const cfg = stratConfigs[i];
      allResults.push(replayPortfolio(isResults[i] || [], isDates, cfg.label, 'IS', cfg));
      allResults.push(replayPortfolio(oosResultsRaw[i] || [], oosDates, cfg.label, 'OOS', cfg));
    }
  }

  // ═══════════════════════════════════════════════════════
  //  ANALYSIS
  // ═══════════════════════════════════════════════════════

  const isResults = allResults.filter(r => r.period === 'IS');
  const oosResults = allResults.filter(r => r.period === 'OOS');
  const oosMap = new Map(oosResults.map(r => [r.configLabel, r]));

  console.log('\n' + '='.repeat(120));
  console.log('  RESULTS');
  console.log('='.repeat(120));

  // ─── FACTOR MARGINALS (across ALL strategies) ──────────
  console.log('\n  FACTOR MARGINAL EFFECTS (avg IS Sharpe across ALL strategies)');
  console.log('  ' + '-'.repeat(100));

  const factors = [
    { name: 'IV Filter', getter: (r: PortfolioResult) => `iv${r.ivFilter === 0 ? '0' : (r.ivFilter * 100).toFixed(0)}` },
    { name: 'Delta',     getter: (r: PortfolioResult) => `d${(r.delta * 100).toFixed(0)}` },
    { name: 'DTE',       getter: (r: PortfolioResult) => r.dteKey },
    { name: 'Strategy',  getter: (r: PortfolioResult) => r.strategyKey },
  ];

  for (const factor of factors) {
    const levelSharpes = new Map<string, number[]>();
    for (const r of isResults) {
      const level = factor.getter(r);
      if (!levelSharpes.has(level)) levelSharpes.set(level, []);
      levelSharpes.get(level)!.push(r.sharpe);
    }

    const sorted = [...levelSharpes.entries()]
      .map(([level, sharpes]) => ({ level, avg: sharpes.reduce((s, v) => s + v, 0) / sharpes.length }))
      .sort((a, b) => b.avg - a.avg);

    console.log(`    ${factor.name.padEnd(12)}: ${sorted.map(s => `${s.level}=${s.avg.toFixed(3)}`).join('  ')}`);
  }

  // ─── IV FILTER BREAKDOWN PER STRATEGY ─────────────────
  console.log('\n  IV FILTER EFFECT PER STRATEGY (avg IS Sharpe)');
  console.log('  ' + '-'.repeat(100));
  const ivLabels = IV_LEVELS.map(v => `iv${v === 0 ? '0' : (v * 100).toFixed(0)}`);
  console.log('  ' + 'Strategy'.padEnd(12) + ivLabels.map(l => l.padStart(12)).join('') + '  Δ(iv30 vs iv0)');
  console.log('  ' + '-'.repeat(100));

  for (const strat of STRATEGIES) {
    const parts = [strat.key.padEnd(12)];
    const sharpeByIV: number[] = [];
    for (const iv of IV_LEVELS) {
      const matching = isResults.filter(r => r.strategyKey === strat.key && r.ivFilter === iv);
      const avg = matching.length > 0 ? matching.reduce((s, r) => s + r.sharpe, 0) / matching.length : 0;
      parts.push(avg.toFixed(3).padStart(12));
      sharpeByIV.push(avg);
    }
    const delta = sharpeByIV.length >= 3 ? sharpeByIV[2] - sharpeByIV[0] : 0;
    parts.push(`  ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}`);
    console.log('  ' + parts.join(''));
  }
  console.log('  ' + '-'.repeat(100));

  // ─── DELTA BREAKDOWN PER STRATEGY ─────────────────────
  console.log('\n  DELTA EFFECT PER STRATEGY (avg IS Sharpe)');
  console.log('  ' + '-'.repeat(100));
  const deltaLabels = DELTA_LEVELS.map(d => `d${(d * 100).toFixed(0)}`);
  console.log('  ' + 'Strategy'.padEnd(12) + deltaLabels.map(l => l.padStart(10)).join(''));
  console.log('  ' + '-'.repeat(100));

  for (const strat of STRATEGIES) {
    const parts = [strat.key.padEnd(12)];
    for (const delta of DELTA_LEVELS) {
      const matching = isResults.filter(r => r.strategyKey === strat.key && r.delta === delta);
      const avg = matching.length > 0 ? matching.reduce((s, r) => s + r.sharpe, 0) / matching.length : 0;
      parts.push(avg.toFixed(3).padStart(10));
    }
    console.log('  ' + parts.join(''));
  }
  console.log('  ' + '-'.repeat(100));

  // ─── DTE BREAKDOWN PER STRATEGY ───────────────────────
  console.log('\n  DTE EFFECT PER STRATEGY (avg IS Sharpe)');
  console.log('  ' + '-'.repeat(100));
  const dteLabels = DTE_LEVELS.map(d => d.key);
  console.log('  ' + 'Strategy'.padEnd(12) + dteLabels.map(l => l.padStart(12)).join(''));
  console.log('  ' + '-'.repeat(100));

  for (const strat of STRATEGIES) {
    const parts = [strat.key.padEnd(12)];
    for (const dte of DTE_LEVELS) {
      const matching = isResults.filter(r => r.strategyKey === strat.key && r.dteKey === dte.key);
      const avg = matching.length > 0 ? matching.reduce((s, r) => s + r.sharpe, 0) / matching.length : 0;
      parts.push(avg.toFixed(3).padStart(12));
    }
    console.log('  ' + parts.join(''));
  }
  console.log('  ' + '-'.repeat(100));

  // ─── INTERACTION: IV × DELTA (avg IS Sharpe across all strategies + DTE) ──
  console.log('\n  INTERACTION HEATMAP: IV × DELTA (avg IS Sharpe across all strategies & DTE)');
  console.log('  ' + '-'.repeat(80));
  console.log('  ' + ''.padEnd(10) + deltaLabels.map(l => l.padStart(10)).join(''));
  console.log('  ' + '-'.repeat(80));

  for (const iv of IV_LEVELS) {
    const ivLabel = `iv${iv === 0 ? '0' : (iv * 100).toFixed(0)}`;
    const parts = [ivLabel.padEnd(10)];
    for (const delta of DELTA_LEVELS) {
      const matching = isResults.filter(r => r.ivFilter === iv && r.delta === delta);
      const avg = matching.length > 0 ? matching.reduce((s, r) => s + r.sharpe, 0) / matching.length : 0;
      parts.push(avg.toFixed(3).padStart(10));
    }
    console.log('  ' + parts.join(''));
  }
  console.log('  ' + '-'.repeat(80));

  // ─── INTERACTION: IV × DTE ────────────────────────────
  console.log('\n  INTERACTION HEATMAP: IV × DTE (avg IS Sharpe across all strategies & delta)');
  console.log('  ' + '-'.repeat(80));
  console.log('  ' + ''.padEnd(10) + dteLabels.map(l => l.padStart(12)).join(''));
  console.log('  ' + '-'.repeat(80));

  for (const iv of IV_LEVELS) {
    const ivLabel = `iv${iv === 0 ? '0' : (iv * 100).toFixed(0)}`;
    const parts = [ivLabel.padEnd(10)];
    for (const dte of DTE_LEVELS) {
      const matching = isResults.filter(r => r.ivFilter === iv && r.dteKey === dte.key);
      const avg = matching.length > 0 ? matching.reduce((s, r) => s + r.sharpe, 0) / matching.length : 0;
      parts.push(avg.toFixed(3).padStart(12));
    }
    console.log('  ' + parts.join(''));
  }
  console.log('  ' + '-'.repeat(80));

  // ─── INTERACTION: DELTA × DTE ─────────────────────────
  console.log('\n  INTERACTION HEATMAP: DELTA × DTE (avg IS Sharpe across all strategies & IV)');
  console.log('  ' + '-'.repeat(80));
  console.log('  ' + ''.padEnd(10) + dteLabels.map(l => l.padStart(12)).join(''));
  console.log('  ' + '-'.repeat(80));

  for (const delta of DELTA_LEVELS) {
    const dLabel = `d${(delta * 100).toFixed(0)}`;
    const parts = [dLabel.padEnd(10)];
    for (const dte of DTE_LEVELS) {
      const matching = isResults.filter(r => r.delta === delta && r.dteKey === dte.key);
      const avg = matching.length > 0 ? matching.reduce((s, r) => s + r.sharpe, 0) / matching.length : 0;
      parts.push(avg.toFixed(3).padStart(12));
    }
    console.log('  ' + parts.join(''));
  }
  console.log('  ' + '-'.repeat(80));

  // ─── TOP 25 IS → OOS VALIDATION ──────────────────────
  console.log('\n  TOP 25 IS -> OOS VALIDATION');
  console.log('  ' + '-'.repeat(140));
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
    'PF'.padStart(5) + ' | ' +
    'Status',
  );
  console.log('  ' + '-'.repeat(140));

  const ranked = [...isResults].sort((a, b) => b.sharpe - a.sharpe);
  for (let i = 0; i < Math.min(25, ranked.length); i++) {
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
      (oos ? oos.profitFactor.toFixed(2).padStart(5) : '    -') + ' | ' +
      status,
    );
  }
  console.log('  ' + '-'.repeat(140));

  // ─── ROBUSTNESS CHECK: IV filter positive in how many strategies? ──
  console.log('\n  ROBUSTNESS CHECK: IV ≥ 30% improvement over no-filter');
  console.log('  ' + '-'.repeat(80));
  let passCount = 0;
  for (const strat of STRATEGIES) {
    const noIV = isResults.filter(r => r.strategyKey === strat.key && r.ivFilter === 0);
    const iv30 = isResults.filter(r => r.strategyKey === strat.key && r.ivFilter === 0.30);
    const avgNo = noIV.length > 0 ? noIV.reduce((s, r) => s + r.sharpe, 0) / noIV.length : 0;
    const avg30 = iv30.length > 0 ? iv30.reduce((s, r) => s + r.sharpe, 0) / iv30.length : 0;
    const improved = avg30 > avgNo;
    if (improved) passCount++;
    console.log(`    ${strat.key.padEnd(12)} iv0=${avgNo.toFixed(3)}  iv30=${avg30.toFixed(3)}  ${improved ? '✓ IMPROVED' : '✗ WORSE'} (${((avg30 - avgNo) / Math.abs(avgNo) * 100).toFixed(0)}%)`);
  }
  console.log(`\n    Verdict: IV ≥ 30% improves ${passCount}/${STRATEGIES.length} strategies`);
  console.log(`    ${passCount >= 4 ? '→ STRUCTURAL EFFECT CONFIRMED (≥4/5)' : passCount >= 3 ? '→ LIKELY REAL (3/5)' : '→ NOT ROBUST (<3/5)'}`);
  console.log('  ' + '-'.repeat(80));

  // ─── BENCHMARK ────────────────────────────────────────
  console.log('\n  Computing benchmarks...');
  const bhOOS = await computeBuyHold(OOS_START, OOS_END);
  console.log(`  Buy & Hold OOS: Sharpe ${bhOOS.sharpe.toFixed(2)}, Ann Return ${bhOOS.annReturn.toFixed(1)}%, MaxDD ${bhOOS.maxDD.toFixed(1)}%`);

  // ─── JSON EXPORT ──────────────────────────────────────
  const exportData = {
    meta: {
      startingCapital: STARTING_CAPITAL,
      maxPositions: MAX_POSITIONS,
      maxPerTicker: MAX_PER_TICKER,
      tickers: ALL_TICKERS,
      isRange: [IS_START, IS_END],
      oosRange: [OOS_START, OOS_END],
      strategies: STRATEGIES.map(s => ({ key: s.key, type: s.type })),
      ivLevels: IV_LEVELS,
      deltaLevels: DELTA_LEVELS,
      dteLevels: DTE_LEVELS.map(d => ({ key: d.key, range: d.range })),
      totalConfigs: allConfigs.length,
      timestamp: new Date().toISOString(),
    },
    benchmarks: { buyHoldOOS: bhOOS },
    results: allResults.map(r => ({ ...r })),
  };

  const jsonPath = path.resolve(__dirname, '../data/robustness-sim-results.json');
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
