/**
 * Direction Analysis — Compare bull put spread vs bear call spread performance
 *
 * Runs a single config (mom S iv30 d40 dte45_65) and splits results by direction.
 * Exports trade-level data for analysis.
 *
 * Usage: npx tsx scripts/direction-analysis.ts
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
  'META', 'NFLX', 'GOOGL', 'GS', 'COST',
];

const NUM_WORKERS = Math.min(os.cpus().length - 2, 20);
const STARTING_CAPITAL = 100_000;
const MAX_POSITIONS = 50;
const MAX_PER_TICKER = 5;

// ── Types ───────────────────────────────────────────────

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

const candleCache = new Map<string, any>();

async function fetchCandleData(ticker: string) {
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

interface StrategyDef {
  key: string;
  type: 'signal';
  techOptions?: TechScoreOptions;
  minScore: number;
}

const STRATEGIES: StrategyDef[] = [
  { key: 'mom', type: 'signal', techOptions: { w_mb: 0, w_bxs: 0, w_bxl: 0, w_ema: 0, w_adx: 0, w_vol: 0 }, minScore: 90 },
  { key: 'ema', type: 'signal', techOptions: { w_mb: 0, w_bxs: 0, w_bxl: 0, w_mom: 0, w_adx: 0, w_vol: 0 }, minScore: 90 },
  { key: 'BL',  type: 'signal', techOptions: {}, minScore: 70 },
];

async function generateSignalEntries(
  ticker: string,
  periodStart: string,
  periodEnd: string,
  strategy: StrategyDef,
): Promise<TickerSignals> {
  const td = await fetchCandleData(ticker);
  const allTradingDates = td.candles
    .filter((c: BacktestCandle) => c.date >= periodStart && c.date <= periodEnd)
    .map((c: BacktestCandle) => c.date);

  const entries: EntrySignal[] = [];
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
    function sendNext(worker: Worker) {
      if (nextIdx >= workItems.length) return;
      worker.postMessage(workItems[nextIdx++]);
    }

    for (const worker of workers) {
      worker.on('message', (msg: TradeGenResult) => {
        if (msg.type !== 'result') return;
        results[msg.id] = msg.trades;
        completed++;
        if (completed % 3 === 0 || completed === workItems.length) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          console.log(`    [${label}] ${completed}/${workItems.length} | ${elapsed}s`);
        }
        if (completed === workItems.length) resolve(results);
        else sendNext(worker);
      });
      worker.on('error', (err) => console.log(`    Worker error: ${err.message}`));
      sendNext(worker);
    }
  });
}

// ── Portfolio Replay (returns accepted trades) ──────────

interface ReplayResult {
  trades: TradeSummary[];
  sharpe: number;
  annualizedROC: number;
  maxDrawdown: number;
  winRate: number;
  profitFactor: number;
  totalPnl: number;
}

function replayPortfolio(allTrades: TradeSummary[], allDates: string[]): ReplayResult {
  const sorted = [...allTrades].sort((a, b) => {
    const dc = a.entryDate.localeCompare(b.entryDate);
    return dc !== 0 ? dc : b.score - a.score;
  });

  const open = new Map<string, TradeSummary[]>();
  const accepted: TradeSummary[] = [];
  let cash = STARTING_CAPITAL;
  let tradeIdx = 0;
  let prevEquity = STARTING_CAPITAL;
  const dailyReturns: number[] = [];
  let peak = STARTING_CAPITAL;
  let maxDD = 0;

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
      const trade = sorted[tradeIdx++];
      if (trade.entryDate < date) continue;
      if (totalOpenCount() >= MAX_POSITIONS) continue;
      if ((open.get(trade.ticker)?.length ?? 0) >= MAX_PER_TICKER) continue;
      if (cash < trade.maxLoss) continue;

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
  }

  for (const [, trades] of open) for (const t of trades) cash += t.maxLoss + t.pnl;

  const totalPnl = accepted.reduce((s, t) => s + t.pnl, 0);
  const years = allDates.length / 252;
  const annualizedROC = years > 0 ? (totalPnl / STARTING_CAPITAL / years) * 100 : 0;

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
    trades: accepted,
    sharpe,
    annualizedROC,
    maxDrawdown: maxDD * 100,
    winRate: accepted.length > 0 ? winners.length / accepted.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    totalPnl,
  };
}

// ── Direction Analysis ──────────────────────────────────

function analyzeDirection(trades: TradeSummary[], label: string) {
  const calls = trades.filter(t => t.direction === 'CALL');  // bull put spreads
  const puts = trades.filter(t => t.direction === 'PUT');    // bear call spreads

  function stats(arr: TradeSummary[]) {
    if (arr.length === 0) return { count: 0, winRate: 0, avgPnl: 0, totalPnl: 0, profitFactor: 0, avgHold: 0 };
    const winners = arr.filter(t => t.pnl > 0);
    const losers = arr.filter(t => t.pnl <= 0);
    const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));
    return {
      count: arr.length,
      winRate: (winners.length / arr.length * 100),
      avgPnl: arr.reduce((s, t) => s + t.pnl, 0) / arr.length,
      totalPnl: arr.reduce((s, t) => s + t.pnl, 0),
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      avgHold: arr.reduce((s, t) => s + t.holdDays, 0) / arr.length,
    };
  }

  const callStats = stats(calls);
  const putStats = stats(puts);
  const allStats = stats(trades);

  console.log(`\n  ── ${label} ──`);
  console.log(`  ${''.padEnd(22)} ${'Count'.padStart(8)} ${'WinRate'.padStart(10)} ${'AvgPnl'.padStart(10)} ${'TotalPnl'.padStart(12)} ${'PF'.padStart(8)} ${'AvgHold'.padStart(10)}`);
  console.log(`  ${'─'.repeat(82)}`);
  console.log(`  ${'CALL (bull put spread)'.padEnd(22)} ${String(callStats.count).padStart(8)} ${callStats.winRate.toFixed(1).padStart(9)}% ${('$' + callStats.avgPnl.toFixed(0)).padStart(10)} ${('$' + callStats.totalPnl.toFixed(0)).padStart(12)} ${callStats.profitFactor.toFixed(2).padStart(8)} ${callStats.avgHold.toFixed(1).padStart(9)}d`);
  console.log(`  ${'PUT (bear call spread)'.padEnd(22)} ${String(putStats.count).padStart(8)} ${putStats.winRate.toFixed(1).padStart(9)}% ${('$' + putStats.avgPnl.toFixed(0)).padStart(10)} ${('$' + putStats.totalPnl.toFixed(0)).padStart(12)} ${putStats.profitFactor.toFixed(2).padStart(8)} ${putStats.avgHold.toFixed(1).padStart(9)}d`);
  console.log(`  ${'ALL'.padEnd(22)} ${String(allStats.count).padStart(8)} ${allStats.winRate.toFixed(1).padStart(9)}% ${('$' + allStats.avgPnl.toFixed(0)).padStart(10)} ${('$' + allStats.totalPnl.toFixed(0)).padStart(12)} ${allStats.profitFactor.toFixed(2).padStart(8)} ${allStats.avgHold.toFixed(1).padStart(9)}d`);

  // Per-ticker breakdown
  const tickers = [...new Set(trades.map(t => t.ticker))].sort();
  console.log(`\n  Per-Ticker Direction Split:`);
  console.log(`  ${'Ticker'.padEnd(8)} ${'CALL#'.padStart(7)} ${'CALL WR'.padStart(9)} ${'CALL PnL'.padStart(10)} ${'PUT#'.padStart(7)} ${'PUT WR'.padStart(9)} ${'PUT PnL'.padStart(10)} ${'Better'.padStart(8)}`);
  console.log(`  ${'─'.repeat(70)}`);
  for (const ticker of tickers) {
    const tc = calls.filter(t => t.ticker === ticker);
    const tp = puts.filter(t => t.ticker === ticker);
    const tcPnl = tc.reduce((s, t) => s + t.pnl, 0);
    const tpPnl = tp.reduce((s, t) => s + t.pnl, 0);
    const tcWR = tc.length > 0 ? (tc.filter(t => t.pnl > 0).length / tc.length * 100) : 0;
    const tpWR = tp.length > 0 ? (tp.filter(t => t.pnl > 0).length / tp.length * 100) : 0;
    const better = tcPnl > tpPnl ? 'CALL' : tpPnl > tcPnl ? 'PUT' : 'TIE';
    console.log(`  ${ticker.padEnd(8)} ${String(tc.length).padStart(7)} ${tcWR.toFixed(1).padStart(8)}% ${('$' + tcPnl.toFixed(0)).padStart(10)} ${String(tp.length).padStart(7)} ${tpWR.toFixed(1).padStart(8)}% ${('$' + tpPnl.toFixed(0)).padStart(10)} ${better.padStart(8)}`);
  }

  // Exit type breakdown by direction
  console.log(`\n  Exit Type Breakdown:`);
  const exitTypes = [...new Set(trades.map(t => t.exitType))].sort();
  console.log(`  ${'ExitType'.padEnd(18)} ${'CALL#'.padStart(8)} ${'CALL%'.padStart(8)} ${'PUT#'.padStart(8)} ${'PUT%'.padStart(8)}`);
  console.log(`  ${'─'.repeat(52)}`);
  for (const et of exitTypes) {
    const cc = calls.filter(t => t.exitType === et).length;
    const pc = puts.filter(t => t.exitType === et).length;
    console.log(`  ${et.padEnd(18)} ${String(cc).padStart(8)} ${(calls.length > 0 ? (cc / calls.length * 100).toFixed(1) : '0').padStart(7)}% ${String(pc).padStart(8)} ${(puts.length > 0 ? (pc / puts.length * 100).toFixed(1) : '0').padStart(7)}%`);
  }

  return { callStats, putStats };
}

// ── Configs to test ─────────────────────────────────────

interface ConfigToTest {
  label: string;
  strategy: StrategyDef;
  delta: number;
  dteRange: [number, number];
  ivFilter: number;
}

const CONFIGS: ConfigToTest[] = [
  // Our recommended setup
  { label: 'mom S iv30 d40 dte45_65', strategy: STRATEGIES[0], delta: 0.40, dteRange: [45, 65], ivFilter: 0.30 },
  { label: 'mom S iv0 d40 dte45_65',  strategy: STRATEGIES[0], delta: 0.40, dteRange: [45, 65], ivFilter: 0 },
  // EMA for comparison
  { label: 'ema S iv30 d40 dte45_65', strategy: STRATEGIES[1], delta: 0.40, dteRange: [45, 65], ivFilter: 0.30 },
  // BL (all weights) for breadth
  { label: 'BL ALL iv30 d40 dte45_65', strategy: STRATEGIES[2], delta: 0.40, dteRange: [45, 65], ivFilter: 0.30 },
  // Previous default for comparison
  { label: 'mom S iv0 d27 dte30_50',  strategy: STRATEGIES[0], delta: 0.27, dteRange: [30, 50], ivFilter: 0 },
];

// ══════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════

async function main() {
  const globalStart = Date.now();

  console.log('');
  console.log('='.repeat(100));
  console.log('  DIRECTION ANALYSIS — Bull Put Spread vs Bear Call Spread');
  console.log('='.repeat(100));
  console.log(`  Configs: ${CONFIGS.length}`);
  console.log(`  IS: ${IS_START} → ${IS_END} | OOS: ${OOS_START} → ${OOS_END}`);
  console.log(`  Workers: ${NUM_WORKERS}`);
  console.log('='.repeat(100));

  console.log('\n  Building worker bundle...');
  const workerBundle = await buildWorkerBundle();

  initDB();
  const stats = getCacheStats();
  console.log(`  Chain Cache: ${stats.totalRows.toLocaleString()} rows`);
  closeDB();

  console.log('\n  Loading candle data...');
  for (const ticker of ALL_TICKERS) {
    await fetchCandleData(ticker);
    process.stdout.write(`    ${ticker} `);
  }
  console.log('\n');

  const td = await fetchCandleData('SPY');
  const isDates = td.candles.filter((c: BacktestCandle) => c.date >= IS_START && c.date <= IS_END).map((c: BacktestCandle) => c.date);
  const oosDates = td.candles.filter((c: BacktestCandle) => c.date >= OOS_START && c.date <= OOS_END).map((c: BacktestCandle) => c.date);

  const noFilter = { key: 'noFilter', minShortVolume: 0, minShortOI: 0, maxBidAskPct: 0, minEntryIV: 0, maxEntryIV: 999, minNetCreditPct: 0 };

  const allExportData: any[] = [];

  for (const cfg of CONFIGS) {
    console.log(`\n  ══ Config: ${cfg.label} ══`);

    // Generate signals for IS and OOS
    const isSignals: TickerSignals[] = [];
    const oosSignals: TickerSignals[] = [];
    for (const ticker of ALL_TICKERS) {
      isSignals.push(await generateSignalEntries(ticker, IS_START, IS_END, cfg.strategy));
      oosSignals.push(await generateSignalEntries(ticker, OOS_START, OOS_END, cfg.strategy));
    }

    const totalIS = isSignals.reduce((s, ts) => s + ts.entries.length, 0);
    const totalOOS = oosSignals.reduce((s, ts) => s + ts.entries.length, 0);

    // Count direction in signals
    const isCallSignals = isSignals.reduce((s, ts) => s + ts.entries.filter(e => e.direction === 'CALL').length, 0);
    const isPutSignals = isSignals.reduce((s, ts) => s + ts.entries.filter(e => e.direction === 'PUT').length, 0);
    console.log(`    Signals — IS: ${totalIS} (CALL: ${isCallSignals}, PUT: ${isPutSignals}), OOS: ${totalOOS}`);

    const workItem: TradeGenWorkItem = {
      id: 0,
      config: {
        ...DEFAULT_CREDIT_CONFIG,
        minIVRank: 0,
        creditProfitTarget: 0.30,
        creditStopLossMultiple: 100,
        creditShortDelta: cfg.delta,
        creditDTERange: cfg.dteRange,
      },
      minScore: cfg.strategy.minScore,
      maxScore: 101,
      maxPerTicker: MAX_PER_TICKER,
      contractsPerSignal: 1,
      scoreExitThreshold: 0,
      optionFilter: { ...noFilter, minEntryIV: cfg.ivFilter },
    };

    // IS
    const isWorkers = await createWorkerPool(workerBundle, isSignals, IS_END, NUM_WORKERS);
    const isTradesRaw = await runWorkItems(isWorkers, [workItem], `IS-${cfg.label}`);
    await terminatePool(isWorkers);

    const isReplay = replayPortfolio(isTradesRaw[0] || [], isDates);
    console.log(`    IS: Sharpe ${isReplay.sharpe.toFixed(2)}, ROC ${isReplay.annualizedROC.toFixed(1)}%, DD ${isReplay.maxDrawdown.toFixed(1)}%, WR ${isReplay.winRate.toFixed(1)}%, Trades ${isReplay.trades.length}`);
    analyzeDirection(isReplay.trades, `IS — ${cfg.label}`);

    // OOS
    const oosWorkers = await createWorkerPool(workerBundle, oosSignals, OOS_END, NUM_WORKERS);
    const oosTradesRaw = await runWorkItems(oosWorkers, [workItem], `OOS-${cfg.label}`);
    await terminatePool(oosWorkers);

    const oosReplay = replayPortfolio(oosTradesRaw[0] || [], oosDates);
    console.log(`    OOS: Sharpe ${oosReplay.sharpe.toFixed(2)}, ROC ${oosReplay.annualizedROC.toFixed(1)}%, DD ${oosReplay.maxDrawdown.toFixed(1)}%, WR ${oosReplay.winRate.toFixed(1)}%, Trades ${oosReplay.trades.length}`);
    analyzeDirection(oosReplay.trades, `OOS — ${cfg.label}`);

    allExportData.push({
      config: cfg.label,
      is: { ...isReplay, trades: isReplay.trades },
      oos: { ...oosReplay, trades: oosReplay.trades },
    });
  }

  // Export
  const outPath = path.resolve(__dirname, '../backtesting history/credit-spread/results/direction-analysis.json');
  fs.writeFileSync(outPath, JSON.stringify(allExportData, null, 2));
  console.log(`\n  Results exported to: ${outPath}`);

  const elapsed = ((Date.now() - globalStart) / 60000).toFixed(1);
  console.log(`\n  Total runtime: ${elapsed} minutes`);
  console.log('='.repeat(100));
}

main().catch(err => { console.error(err); process.exit(1); });
